import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { parsePromotedTags, PromotedStore } from "../../src/db/promoted.js";
import type { DatabaseSync } from "node:sqlite";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-promoted-store-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("PromotedStore", () => {
  it("stores and retrieves a memory", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    const id = store.insert({
      content: "We decided to use React for the frontend",
      tags: ["decision", "frontend"],
      projectId: "proj-1",
      sessionId: "sess-1",
      depth: 1,
      confidence: 0.8,
    });

    expect(id).toBeTruthy();
    const row = store.getById(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe("We decided to use React for the frontend");
    expect(JSON.parse(row!.tags)).toContain("decision");
  });

  it("searches via FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "React is the chosen framework", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database uses PostgreSQL", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Unrelated cooking recipe", tags: ["other"], projectId: "p1" });

    const results = store.search("React framework", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("React");
  });

  it("filters by tags", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "React decision", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "React note", tags: ["note"], projectId: "p1" });

    const results = store.search("React", 10, ["decision"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("React decision");
  });

  it("uses a guarded dual-JSON predicate before the native FTS limit", () => {
    const db = makeDb();
    const preparedSql: string[] = [];
    const wrappedDb = {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        preparedSql.push(sql);
        const statement = db.prepare(sql);
        if (!sql.includes("promoted_fts MATCH")) return statement;
        return {
          all: (...args: Parameters<typeof statement.all>) => statement.all(...args),
          iterate: () => { throw new Error("tagged FTS must use SQL LIMIT path"); },
        };
      },
    } as unknown as DatabaseSync;
    const store = new PromotedStore(wrappedDb);
    const malformed = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.99 });
    db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run("[", malformed);
    const mixed = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.98 });
    db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run('["need", 1]', mixed);
    const object = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.97 });
    db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run('{"tag":"need"}', object);
    const blob = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.96 });
    db.prepare("UPDATE promoted SET tags = CAST(? AS BLOB) WHERE id = ?").run('["need"]', blob);
    const firstEligible = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.8 });
    const secondEligible = store.insert({ content: "needle", tags: ["need"], projectId: "p1", confidence: 0.7 });

    expect(store.search("needle", 1, ["need"], "p1").map(({ id }) => id)).toEqual([firstEligible]);
    expect(store.search("needle", 2, ["need"], "p1").map(({ id }) => id))
      .toEqual([firstEligible, secondEligible]);
    const searchSql = preparedSql.find((sql) => sql.includes("promoted_fts MATCH"));
    expect(searchSql).toContain("CASE WHEN typeof(p.tags) = 'text'");
    expect(searchSql).toContain("json_valid(p.tags)");
    expect(searchSql).toContain("json_type(p.tags)");
    expect(searchSql).toContain("json_each(p.tags)");
    expect(searchSql).toContain("json_each(?)");
    expect(searchSql).toContain("LIMIT ?");
    expect((searchSql?.match(/\?/g) ?? [])).toHaveLength(4);

    const collision = store.insert({ content: "collision", tags: ['{"a":1}'], projectId: "p1" });
    const collisionEligible = store.insert({ content: "collision", tags: ["required"], projectId: "p1" });
    expect(store.search("collision", 1, [{ a: 1 }] as never, "p1")).toEqual([]);
    expect(store.search("collision", 1, ["required"], "p1")).toMatchObject([{ id: collisionEligible }]);
    expect(collision).not.toBe(collisionEligible);
  });

  it("keeps Unicode, NUL, and lone-surrogate tags exact on the SQL path", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const values = ["café", "pair😀", "nul\u0000tag", "lone\ud800", "replacement�"];
    const ids = values.map((tag) => store.insert({ content: "unicode needle", tags: [tag], projectId: "p1" }));

    for (const [index, tag] of values.entries()) {
      expect(store.search("unicode", 10, [tag], "p1").map(({ id }) => id)).toEqual([ids[index]]);
    }
    expect(store.search("unicode", 10, ["lone\ud800"], "p1").map(({ id }) => id)).toEqual([ids[3]]);
    expect(store.search("unicode", 10, ["replacement�"], "p1").map(({ id }) => id)).toEqual([ids[4]]);
  });

  it("applies required tags before the FTS result limit", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const ineligible = store.insert({
      content: "needle",
      tags: ["other"],
      projectId: "p1",
      confidence: 0.9,
    });
    const firstEligible = store.insert({
      content: "needle",
      tags: ["required"],
      projectId: "p1",
      confidence: 0.8,
    });
    const secondEligible = store.insert({
      content: "needle",
      tags: ["required"],
      projectId: "p1",
      confidence: 0.7,
    });

    const unfiltered = store.search("needle", -1, undefined, "p1");
    expect(unfiltered.map(({ id }) => id)).toEqual([ineligible, firstEligible, secondEligible]);
    expect(store.search("needle", 1, ["required"], "p1").map(({ id }) => id))
      .toEqual([firstEligible]);
    expect(store.search("needle", 2, ["required"], "p1").map(({ id }) => id))
      .toEqual([firstEligible, secondEligible]);
  });

  it("keeps exact all-tag and malformed-tag eligibility semantics", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const exact = store.insert({
      content: "tagged needle",
      tags: ["scope:project", "source:passive-capture"],
      projectId: "p1",
    });
    const punctuationMismatch = store.insert({
      content: "tagged needle",
      tags: ["scope:project", "source:passive_capture"],
      projectId: "p1",
    });
    const malformed = store.insert({ content: "tagged needle", tags: ["other"], projectId: "p1" });
    db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run("{\"tag\":\"scope:project\"}", malformed);
    const mixed = store.insert({ content: "tagged needle", tags: ["scope:project"], projectId: "p1" });
    db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run('["scope:project", 1]', mixed);

    expect(store.search("tagged", 10, ["scope:project", "source:passive-capture"], "p1"))
      .toMatchObject([{ id: exact }]);
    expect(store.search("tagged", 10, ["scope:project", "source:passive_capture"], "p1"))
      .toMatchObject([{ id: punctuationMismatch }]);
    expect(store.search("tagged", 10, ["scope:project", "source:passive-capture"], "p1"))
      .not.toEqual(expect.arrayContaining([{ id: malformed }, { id: mixed }]));
    expect(store.search("tagged", 10, [], "p1")).toHaveLength(4);
    expect(store.search("tagged", 10, undefined, "p1")).toHaveLength(4);
  });

  it("honors project, archive, and store-level limits for tagged FTS search", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const active = store.insert({ content: "needle", tags: ["required"], projectId: "p1" });
    const archived = store.insert({ content: "needle", tags: ["required"], projectId: "p1" });
    const otherProject = store.insert({ content: "needle", tags: ["required"], projectId: "p2" });
    store.archive(archived);

    expect(store.search("needle", 10, ["required"], "p1").map(({ id }) => id)).toEqual([active]);
    expect(store.search("needle", 10, ["required"], "p2").map(({ id }) => id)).toEqual([otherProject]);
    expect(store.search("needle", 0, ["required"], "p1")).toEqual([]);
    expect(store.search("needle", -1, ["required"], "p1").map(({ id }) => id)).toEqual([active]);
  });

  it("uses an iterator when available and stops after enough eligible rows", () => {
    let iterateReads = 0;
    let allCalls = 0;
    const rows = [
      { id: "ineligible", content: "needle", tags: '["other"]', project_id: "p", session_id: null, confidence: 1, created_at: "2020", rank: -3 },
      { id: "eligible", content: "needle", tags: '["required"]', project_id: "p", session_id: null, confidence: 1, created_at: "2020", rank: -2 },
      { id: "late", content: "needle", get tags(): string { throw new Error("late row decoded"); }, project_id: "p", session_id: null, confidence: 1, created_at: "2020", rank: -1 },
    ];
    const db = {
      prepare: () => ({
        iterate: function* (): Iterable<(typeof rows)[number]> {
          for (const row of rows) {
            iterateReads += 1;
            yield row;
          }
        },
        all: () => {
          allCalls += 1;
          return rows;
        },
      }),
    } as unknown as DatabaseSync;

    expect(new PromotedStore(db).search("needle", 0, ["required"], "p")).toEqual([]);
    expect(iterateReads).toBe(0);
    const results = new PromotedStore(db).search("needle", 1, ["required"], "p");
    expect(results.map(({ id }) => id)).toEqual(["eligible"]);
    expect(iterateReads).toBe(2);
    expect(allCalls).toBe(0);
  });

  it("falls back to all() when the statement has no iterator", () => {
    let allCalls = 0;
    const rows = [
      { id: "ineligible", content: "needle", tags: '["other"]', project_id: "p", session_id: null, confidence: 1, created_at: "2020", rank: -2 },
      { id: "eligible", content: "needle", tags: '["required"]', project_id: "p", session_id: null, confidence: 1, created_at: "2020", rank: -1 },
    ];
    const db = {
      prepare: () => ({
        all: () => {
          allCalls += 1;
          return rows;
        },
      }),
    } as unknown as DatabaseSync;

    expect(new PromotedStore(db).search("needle", 1, ["required"], "p")).toMatchObject([{ id: "eligible" }]);
    expect(new PromotedStore(db).search("needle", -1, ["required"], "p")).toMatchObject([{ id: "eligible" }]);
    expect(allCalls).toBe(2);
  });

  it("caches false and throwing JSON capability probes", () => {
    for (const mode of ["false", "throw", "malformed"] as const) {
      let probeCalls = 0;
      let iteratorCalls = 0;
      const row = {
        id: "eligible",
        content: "needle",
        tags: '["required"]',
        project_id: "p",
        session_id: null,
        confidence: 1,
        created_at: "2020",
        rank: -1,
      };
      const db = {
        prepare: (sql: string) => {
          if (sql.includes("json_valid")) {
            return {
              get: () => {
                probeCalls += 1;
                if (mode === "throw") throw new Error("JSON unavailable");
                return mode === "false"
                  ? { bad_valid: 1, json_kind: "array", each_type: "text" }
                  : { bad_valid: 0, json_kind: "object", each_type: "text" };
              },
            };
          }
          return {
            iterate: function* (): Iterable<typeof row> {
              iteratorCalls += 1;
              yield row;
            },
          };
        },
      } as unknown as DatabaseSync;
      const store = new PromotedStore(db);

      expect(store.search("needle", 1, ["required"], "p")).toMatchObject([{ id: "eligible" }]);
      expect(store.search("needle", 1, ["required"], "p")).toMatchObject([{ id: "eligible" }]);
      expect(probeCalls).toBe(1);
      expect(iteratorCalls).toBe(2);
    }
  });

  it("returns empty array for no matches", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    const results = store.search("nonexistent", 10);
    expect(results).toEqual([]);
  });

  it("archive() soft-deletes entry and removes from FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "React is the framework", tags: ["decision"], projectId: "p1" });

    store.archive(id);

    const row = store.getById(id);
    expect(row!.archived_at).toBeTruthy();

    // Should not appear in search results
    const results = store.search("React framework", 10);
    expect(results.find((r) => r.id === id)).toBeUndefined();
  });

  it("deleteById() removes entry and FTS5 row", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Delete me", tags: [], projectId: "p1" });

    store.deleteById(id);
    expect(store.getById(id)).toBeNull();
  });

  it("update() changes content and re-syncs FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Old content about React", tags: ["decision"], projectId: "p1", confidence: 0.9 });

    store.update(id, { content: "New content about Vue", confidence: 0.7 });

    const row = store.getById(id);
    expect(row!.content).toBe("New content about Vue");
    expect(row!.confidence).toBe(0.7);

    // FTS5 should find new content
    const results = store.search("Vue", 10);
    expect(results.length).toBe(1);

    // FTS5 should NOT find old content
    const oldResults = store.search("React", 10);
    expect(oldResults.length).toBe(0);
  });

  it("search() excludes archived entries", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    store.insert({ content: "Active React decision", tags: ["decision"], projectId: "p1" });
    const archivedId = store.insert({ content: "Archived React memory", tags: ["decision"], projectId: "p1" });
    store.archive(archivedId);

    const results = store.search("React", 10);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("Active");
  });

  it("defensively parses malformed tags and rejects invalid inserts", () => {
    expect(parsePromotedTags("not json")).toEqual([]);
    expect(parsePromotedTags('{"tag":"value"}')).toEqual([]);
    expect(parsePromotedTags('["valid", 1]')).toEqual([]);
    expect(parsePromotedTags('["valid"]')).toEqual(["valid"]);

    const store = new PromotedStore(makeDb());
    expect(() => store.insert({ content: "bad", projectId: "p", tags: { bad: true } } as never))
      .toThrow("tags must be an array of strings");
    expect(() => store.insert({ content: "bad", projectId: "p", tags: ["valid", 1] } as never))
      .toThrow("tags must be an array of strings");
  });
});
