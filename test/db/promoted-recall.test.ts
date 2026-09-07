import { DatabaseSync } from "node:sqlite";
import { collectPromotedRecallEvidence } from "../../src/db/promoted-recall-evidence.js";
import { describe, expect, it, vi } from "vitest";
import { PromotedStore } from "../../src/db/promoted.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { createTemporaryDatabase } from "../fixtures/runtime.js";

function fixture(fts = true) {
  const db = createTemporaryDatabase();
  runLcmMigrations(db);
  return { db, store: new PromotedStore(db, fts) };
}

describe("native promoted recall evidence", () => {
  it("keeps selected order and separates full Porter matches from weak partials", () => {
    const { store } = fixture();
    const full = store.insert({ content: "run swim jump walk", projectId: "p" });
    const partial = store.insert({ content: "run unrelated", projectId: "p" });
    const query = "running swimming jumping walking";
    const selected = store.search(query, 15);
    const { candidates } = store.searchForRecall(query, 15);
    expect(candidates.map(({ result }) => result)).toEqual(selected);
    expect(candidates.find(({ result }) => result.id === full)?.evidence).toEqual({ queryTermCount: 4, matchedTermCount: 4 });
    expect(candidates.find(({ result }) => result.id === partial)?.evidence).toEqual({ queryTermCount: 4, matchedTermCount: 1 });
  });

  it("deduplicates native stem aliases and requires the complete underscore phrase", () => {
    const { store } = fixture();
    const full = store.insert({ content: "running foo bar quince", projectId: "p" });
    const scattered = store.insert({ content: "run bar zzz foo quince", projectId: "p" });
    const { candidates } = store.searchForRecall("run running RUNS foo_bar quince", 15);
    expect(candidates.find(({ result }) => result.id === full)?.evidence).toEqual({ queryTermCount: 3, matchedTermCount: 3 });
    expect(candidates.find(({ result }) => result.id === scattered)?.evidence).toEqual({ queryTermCount: 3, matchedTermCount: 2 });
  });
});


describe("recall evidence boundaries", () => {
  it.each([255, 256, 257, 512, 513])("retains all %i native terms across batches", (size) => {
    const { store, db } = fixture();
    const words = Array.from({ length: size }, (_, i) => `quinceterm${i}`);
    store.insert({ content: words.join(" "), projectId: "p" });
    const prepare = vi.spyOn(db, "prepare");
    const result = store.searchForRecall(words.join(" "), 15);
    expect(result.candidates[0].evidence).toEqual({ queryTermCount: size, matchedTermCount: size });
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("WITH terms(term)"))).toHaveLength(Math.ceil(size / 256));
  });

  it("preserves every selected ID across the full Cartesian batch partition", () => {
    const { store, db } = fixture();
    for (let index = 0; index < 257; index++) store.insert({ content: `quince candidate ${index}`, projectId: "p" });
    const query = ["quince", ...Array.from({ length: 256 }, (_, i) => `otherterm${i}`)].join(" ");
    const selected = store.search(query, 257);
    const prepare = vi.spyOn(db, "prepare");
    const { candidates } = store.searchForRecall(query, 257);
    expect(candidates.map(({ result }) => result)).toEqual(selected);
    expect(candidates.every(({ evidence }) => evidence.queryTermCount === 257 && evidence.matchedTermCount === 1)).toBe(true);
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("WITH terms(term)"))).toHaveLength(4);
  });

  it("deduplicates stem aliases across source batches and preserves phrase ordering and repetition", () => {
    const { store } = fixture();
    store.insert({ content: "running run foo bar", projectId: "p" });
    const query = ["run", ...Array.from({ length: 256 }, (_, i) => `otherterm${i}`), "running", "RUNS", "foo_bar", "bar_foo", "run_run"].join(" ");
    expect(store.searchForRecall(query, 15).candidates[0].evidence).toEqual({ queryTermCount: 260, matchedTermCount: 3 });
  });

  it("counts numeric, accent-folded, content and tag matches once", () => {
    const { store } = fixture();
    store.insert({ content: "café version42 123", tags: ["cafe", "running"], projectId: "p" });
    expect(store.searchForRecall("CAFE 123 version42 run", 15).candidates[0].evidence).toEqual({ queryTermCount: 4, matchedTermCount: 4 });
  });

  it("retains source, tag, archive, limit and native ordering decisions", () => {
    const { store } = fixture();
    store.insert({ content: "quince foreign", projectId: "foreign", tags: ["required"] });
    store.insert({ content: "quince wrongtag", projectId: "p" });
    const archived = store.insert({ content: "quince archived", projectId: "p", tags: ["required"] });
    store.archive(archived);
    store.insert({ content: "quince eligible", projectId: "p", tags: ["required"] });
    store.insert({ content: "quince second", projectId: "p", tags: ["required"] });
    for (const limit of [0, 1, 2, -1]) {
      expect(store.searchForRecall("quince", limit, ["required"], "p").candidates.map(({ result }) => result))
        .toEqual(store.search("quince", limit, ["required"], "p"));
    }
  });

  it("uses existing no-FTS whole-word predicates without stemming or changing public ranks", () => {
    const { store } = fixture(false);
    store.insert({ content: "run foo_bar orchard", tags: ["tagged"], projectId: "p" });
    store.insert({ content: "running foo bar orchards", projectId: "p" });
    const query = "run RUN foo_bar orchard tagged";
    const selected = store.search(query, 15);
    const result = store.searchForRecall(query, 15);
    expect(result.candidates.map(({ result }) => result)).toEqual(selected);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence).toEqual({ queryTermCount: 4, matchedTermCount: 4 });
  });

  it("does no evidence work for an empty selection and keeps zero-term envelopes complete", () => {
    const { db, store } = fixture();
    store.insert({ content: "quince", projectId: "p" });
    const selected = store.search("quince", 1);
    const prepare = vi.spyOn(db, "prepare");
    expect(store.searchForRecall("absent", 15)).toEqual({ candidates: [] });
    for (const fts of [true, false]) {
      expect(collectPromotedRecallEvidence(db, selected, "!!!", fts)).toEqual({ candidates: [{ result: selected[0], evidence: { queryTermCount: 0, matchedTermCount: 0 } }] });
    }
    expect(collectPromotedRecallEvidence(db, selected, "___", true).candidates[0].evidence).toEqual({ queryTermCount: 0, matchedTermCount: 0 });
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("WITH terms(term)"))).toHaveLength(0);
  });

  it("holds content and FTS evidence in the selection snapshot while another connection updates", () => {
    const { db, store } = fixture();
    const id = store.insert({ content: "quince orchard", projectId: "p" });
    const file = db.prepare("PRAGMA database_list").get()!.file as string;
    const writer = new DatabaseSync(file);
    const original = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("WITH terms(term)")) new PromotedStore(writer).update(id, { content: "unrelated" });
      return original(sql);
    });
    try {
      const result = store.searchForRecall("quince orchard", 15);
      expect(result.candidates[0].result.content).toBe("quince orchard");
      expect(result.candidates[0].evidence.matchedTermCount).toBe(2);
      expect(store.getById(id)?.content).toBe("unrelated");
    } finally { writer.close(); }
  });

  it("composes with an existing transaction and rolls back a late failed batch without partial evidence", () => {
    const { db, store } = fixture();
    const terms = Array.from({ length: 257 }, (_, index) => `term${index}`);
    store.insert({ content: terms.join(" "), projectId: "p" });
    const prepare = db.prepare.bind(db);
    let batch = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("WITH terms(term)") && ++batch === 2) throw new Error("late evidence failure");
      return prepare(sql);
    });
    db.exec("BEGIN");
    expect(() => store.searchForRecall(terms.join(" "), 15)).toThrow("late evidence failure");
    expect(db.prepare("SELECT count(*) AS n FROM promoted").get()!.n).toBe(1);
    db.exec("ROLLBACK");
  });

  it.each([[], [{ id: "wrong", ordinal: 0, matched_terms: 1 }], [{ ordinal: 1, matched_terms: 1 }], [{ matched_terms: null }], [{ matched_terms: 0.5 }], [{ matched_terms: -1 }], [{ matched_terms: Infinity }], [{ matched_terms: Number.MAX_SAFE_INTEGER + 1 }], [{ matched_terms: 2 }]].map((rows) => ({ rows })))("rejects incomplete or invalid evidence rows %#", ({ rows }) => {
    const { db, store } = fixture();
    const id = store.insert({ content: "quince", projectId: "p" });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("WITH terms(term)")) return { all: () => rows.map((row) => ({ id, ordinal: 0, ...row })) } as never;
      return prepare(sql);
    });
    expect(() => store.searchForRecall("quince", 15)).toThrow("invalid promoted recall evidence");
  });

  it("rejects a missing native mapping instead of inventing zero-term evidence", () => {
    const { db, store } = fixture();
    store.insert({ content: "quince", projectId: "p" });
    const selected = store.search("quince", 1);
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql.startsWith("SELECT term, doc")) return { all: () => [] } as never;
      return prepare.call(this, sql);
    });
    expect(() => collectPromotedRecallEvidence(db, selected, "quince", true)).toThrow("invalid promoted recall evidence");
  });

  it.each([{ doc: null }, { doc: 0 }, { doc: 2 }, { doc: 1.5 }, { offset: null }, { offset: 0.5 }, { offset: 1 }, { term: null }, { term: "" }])("closes the query tokenizer after invalid native mapping %#", (patch) => {
    const { db, store } = fixture();
    store.insert({ content: "quince", projectId: "p" });
    const selected = store.search("quince", 1);
    const prepare = DatabaseSync.prototype.prepare;
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql.startsWith("SELECT term, doc")) return { all: () => [{ doc: 1, offset: 0, term: "quince", ...patch }] } as never;
      return prepare.call(this, sql);
    });
    expect(() => collectPromotedRecallEvidence(db, selected, "quince", true)).toThrow("invalid promoted recall evidence");
    expect(close).toHaveBeenCalledOnce();
  });
});
