import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { parsePromotedTags, PromotedStore, readPromotedContent } from "../../src/db/promoted.js";
import { RecallStore } from "../../src/db/recall.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(fts5Available = true): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "lcm-promoted-nul-"));
  tempDirs.push(dir);
  const db = new DatabaseSync(join(dir, "db.sqlite"));
  runLcmMigrations(db, { fts5Available });
  return db;
}

function seedLegacyNul(db: DatabaseSync, id = "legacy-nul"): string {
  db.prepare(
    `INSERT INTO promoted
       (id, content, tags, metadata, project_id, depth, confidence, created_at, archived_at)
       VALUES (?, CAST(X'6C65676163790063616E617279' AS TEXT), ?, '{}', 'project', 0, 1, '2020-01-01 00:00:00', NULL)`,
  ).run(id, JSON.stringify(["legacy"]));
  return id;
}

describe("SQLite promoted content NUL contract", () => {
  it("rejects embedded NUL on insert before changing the table", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    for (const content of ["leading\u0000", "trailing\u0000", "a\u0000b\u0000c"]) {
      expect(() => store.insert({ content, projectId: "project" })).toThrow(TypeError);
      expect(() => store.insert({ content, projectId: "project" })).toThrow(
        "promoted content contains an unsupported string",
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM promoted").get()).toEqual({ count: 0 });

    const valid = store.insert({ content: "café 😀", projectId: "project" });
    const empty = store.insert({ content: "", projectId: "project" });
    expect(store.getById(valid)?.content).toBe("café 😀");
    expect(Object.keys(store.getById(valid)!)).not.toEqual(expect.arrayContaining(["content_type", "content_nul_marker"]));
    expect(store.getById(empty)?.content).toBe("");
  });

  it.each([true, false])("rejects embedded NUL on update without mutating the %s-FTS store", (fts5Available) => {
    const db = makeDb(fts5Available);
    const store = new PromotedStore(db, fts5Available);
    const id = store.insert({ content: "original", tags: ["old"], projectId: "project", confidence: 0.4 });

    expect(() => store.update(id, { content: "replacement\u0000canary", tags: ["new"], confidence: 0.9 }))
      .toThrow("promoted content contains an unsupported string");
    expect(store.getById(id)).toMatchObject({ content: "original", tags: '["old"]', confidence: 0.4 });
    expect(store.search("original", 10)).toMatchObject([{ id }]);
    expect(store.search("replacement", 10)).toEqual([]);
  });

  it.each([true, false])("refuses selected legacy content on reads and preserves public row shape (%s-FTS)", (fts5Available) => {
    const db = makeDb(fts5Available);
    const store = new PromotedStore(db, fts5Available);
    const id = seedLegacyNul(db);

    expect(() => store.getById(id)).toThrow("stored promoted content is unsupported");
    expect(() => store.getAll()).toThrow("stored promoted content is unsupported");
    expect(() => store.listContentPrefixes(10)).toThrow("stored promoted content is unsupported");
    expect(() => store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 2 })).toThrow(
      "stored promoted content is unsupported",
    );

    if (fts5Available) {
      db.prepare("INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, 'legacy', tags FROM promoted WHERE id = ?").run(id);
    }
    expect(() => store.search("legacy", 10)).toThrow("stored promoted content is unsupported");
    const row = db.prepare("SELECT content, hex(content) AS bytes FROM promoted WHERE id = ?").get(id) as {
      content: string;
      bytes: string;
    };
    expect(row.content).toBe("legacy");
    expect(row.bytes).toBe("6C65676163790063616E617279");
  });

  it("guards malformed or inconsistent marker rows with a static error", () => {
    const invalidRows: Array<{ content: unknown; content_type: unknown; content_nul_marker: unknown }> = [
      { content: 1, content_type: "text", content_nul_marker: 0 },
      { content: "ok", content_type: "blob", content_nul_marker: 0 },
      { content: "ok", content_type: "text", content_nul_marker: undefined },
      { content: "ok", content_type: "text", content_nul_marker: null },
      { content: "ok", content_type: "text", content_nul_marker: Number.NaN },
      { content: "ok", content_type: "text", content_nul_marker: Number.POSITIVE_INFINITY },
      { content: "ok", content_type: "text", content_nul_marker: 0.5 },
      { content: "ok", content_type: "text", content_nul_marker: -1 },
      { content: "ok", content_type: "text", content_nul_marker: 1 },
      { content: "o\u0000k", content_type: "text", content_nul_marker: 0 },
    ];
    for (const row of invalidRows) {
      expect(() => readPromotedContent(row)).toThrow(TypeError);
      expect(() => readPromotedContent(row)).toThrow("stored promoted content is unsupported");
    }
    expect(readPromotedContent({ content: "ok", content_type: "text", content_nul_marker: 0 })).toBe("ok");
  });

  it.each([true, false])("allows an explicit clean replacement to repair legacy content (%s-FTS)", (fts5Available) => {
    const db = makeDb(fts5Available);
    const store = new PromotedStore(db, fts5Available);
    const id = seedLegacyNul(db, "repairable");

    expect(() => store.update(id, { content: "clean replacement", tags: ["repaired"] })).not.toThrow();
    expect(store.getById(id)).toMatchObject({ content: "clean replacement", tags: '["repaired"]' });
    if (fts5Available) expect(store.search("clean replacement", 10).map((result) => result.id)).toEqual([id]);
  });

  it("guards old content only when a tags update or revive will replay it into FTS", () => {
    const db = makeDb(true);
    const store = new PromotedStore(db, true);
    const id = seedLegacyNul(db, "metadata-only");
    const before = db.prepare("SELECT tags, confidence, metadata, archived_at FROM promoted WHERE id = ?").get(id) as {
      tags: string;
      confidence: number;
      metadata: string;
      archived_at: string | null;
    };

    expect(() => store.update(id, { confidence: 0.2 })).not.toThrow();
    expect(() => store.update(id, { metadata: { source: "repair" } })).not.toThrow();
    expect(() => store.update(id, { tags: ["new"] })).toThrow("stored promoted content is unsupported");
    expect(() => store.revive(id)).toThrow("stored promoted content is unsupported");
    expect(db.prepare("SELECT tags, confidence, metadata, archived_at FROM promoted WHERE id = ?").get(id))
      .toMatchObject({ tags: before.tags, confidence: 0.2, metadata: '{"source":"repair"}', archived_at: null });
  });

  it("fails selected legacy content in RecallStore.topRecalled without echoing it", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = seedLegacyNul(db, "recalled-legacy");
    store.insert({ content: "usage signal", tags: ["signal:memory_used", `memory_id:${id}`], projectId: "project" });

    expect(() => new RecallStore(db).getStats()).toThrow("stored promoted content is unsupported");
    try {
      new RecallStore(db).getStats();
    } catch (error) {
      expect(String(error)).not.toContain("410042");
      expect(String(error)).not.toContain(id);
    }
  });

  it("keeps escaped NUL tags searchable on native and fallback paths", () => {
    for (const fts5Available of [true, false]) {
      const db = makeDb(fts5Available);
      const store = new PromotedStore(db, fts5Available);
      const id = store.insert({ content: "unicode needle", tags: ["nul\u0000tag"], projectId: "project" });
      expect(store.search("needle", 10, ["nul\u0000tag"]).map((result) => result.id)).toEqual([id]);
      expect(parsePromotedTags(store.getById(id)!.tags)).toEqual(["nul\u0000tag"]);
    }
  });

  it.each([true, false])("does not inspect an excluded legacy row before tag eligibility (%s-FTS)", (fts5Available) => {
    const db = makeDb(fts5Available);
    const store = new PromotedStore(db, fts5Available);
    const eligible = store.insert({ content: "needle", tags: ["required"], projectId: "project" });
    const excluded = seedLegacyNul(db, "excluded");
    db.prepare("UPDATE promoted SET content = CAST(X'6E6565646C650063616E617279' AS TEXT), tags = ? WHERE id = ?")
      .run(JSON.stringify(["other"]), excluded);
    if (fts5Available) {
      db.prepare("INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, 'needle', tags FROM promoted WHERE id = ?")
        .run(excluded);
    }

    expect(store.search("needle", 10, ["required"]).map(({ id }) => id)).toEqual([eligible]);
    expect(store.getAll({ tags: ["required"] }).map(({ id }) => id)).toEqual([eligible]);
  });
});
