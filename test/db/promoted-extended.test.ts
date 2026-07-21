/**
 * Extended PromotedStore tests covering untested methods and edge cases:
 *   - getById returning null for unknown id
 *   - getAll with no options, projectId filter, since filter, tags filter
 *   - listContentPrefixes
 *   - update tags-only path (no content change)
 *   - update confidence-only path
 *   - search filtered by projectId
 *   - search with empty/punctuation-only query
 *   - transaction commit and rollback
 *   - update on non-existent id is a no-op
 *   - deleteById on non-existent id is safe
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import type { DatabaseSync } from "node:sqlite";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(fts5Available = true) {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-promoted-ext-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db, { fts5Available });
  return db;
}

describe("PromotedStore extended", () => {
  it("handles persistence rows disappearing between promoted operations", () => {
    const calls: string[] = [];
    const db = {
      exec: (sql: string) => calls.push(sql),
      prepare: (sql: string) => ({
        get: () => undefined,
        run: (...args: unknown[]) => calls.push(`${sql}:${JSON.stringify(args)}`),
      }),
    } as unknown as DatabaseSync;
    const store = new PromotedStore(db);

    expect(store.insert({ content: "orphan", projectId: "project" })).toBeTypeOf("string");
    store.archive("missing");
    store.revive("missing");

    expect(calls.some((call) => call.startsWith("UPDATE promoted SET archived_at"))).toBe(true);
    expect(calls.every((call) => !call.startsWith("DELETE FROM promoted_fts"))).toBe(true);
    expect(calls).not.toContain("BEGIN");
  });

  it("updates content with replacement tags and an explicit confidence", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "before", tags: ["old"], projectId: "project" });

    store.update(id, { content: "after", tags: ["new"], confidence: 0.25 });

    const row = store.getById(id);
    expect(row?.content).toBe("after");
    expect(row?.confidence).toBe(0.25);
    expect(JSON.parse(row?.tags ?? "[]")).toEqual(["new"]);

    store.update(id, { content: "after again" });
    expect(store.getById(id)?.confidence).toBe(0.25);
  });

  it("ignores usage signals for other stale candidates", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const staleId = store.insert({ content: "stale", projectId: "project" });
    store.insert({
      content: "unrelated usage",
      tags: ["signal:memory_used", "memory_id:someone-else"],
      projectId: "project",
    });
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("2020-01-01 00:00:00", staleId);

    expect(store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 2 })).toEqual([
      expect.objectContaining({ id: staleId, usageCount: 0 }),
    ]);
  });

  it("counts repeated usage signals for a stale candidate", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const staleId = store.insert({ content: "used stale", projectId: "project" });
    for (const content of ["first usage", "second usage"]) {
      store.insert({
        content,
        tags: ["signal:memory_used", `memory_id:${staleId}`],
        projectId: "project",
      });
    }
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("2020-01-01 00:00:00", staleId);

    expect(store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 2 }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: staleId })]));
  });

  it("handles empty and surfaced-without-use stale candidate sets", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    expect(store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 2 })).toEqual([]);

    const staleId = store.insert({ content: "surfaced stale", projectId: "project" });
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("2020-01-01 00:00:00", staleId);
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(staleId, "s1");
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(staleId, "s2");
    expect(store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 2 }))
      .toMatchObject([{ id: staleId, surfacingCount: 2, usageCount: 0 }]);
  });

  it("supports every mutation and search filter without native FTS", () => {
    const db = makeDb(false);
    const store = new PromotedStore(db, false);
    const first = store.insert({ content: "Fallback needle", tags: ["keep"], projectId: "p1" });
    const second = store.insert({ content: "Other needle", projectId: "p2" });

    expect(store.search("needle", 10)).toHaveLength(2);
    expect(store.search("needle", 10, ["keep"], "p1")).toMatchObject([{ id: first, rank: 0 }]);
    expect(store.search("_%", 10)).toEqual([]);

    store.update(first, { content: "Changed fallback" });
    store.update(first, { content: "Changed again", tags: ["new"], confidence: 0.7 });
    store.update(first, { confidence: 0.8 });
    store.update(first, { tags: ["final"] });
    expect(store.getById(first)).toMatchObject({ content: "Changed again", confidence: 0.8 });

    store.archive(first);
    expect(store.search("changed", 10)).toEqual([]);
    store.revive(first);
    expect(store.search("changed", 10, ["final"])).toHaveLength(1);
    store.deleteById(first);
    store.deleteById(second);
    expect(store.getAll()).toEqual([]);
  });

  it("rolls back revive when the promoted row update fails", () => {
    const execCalls: string[] = [];
    const db = {
      exec: (sql: string) => execCalls.push(sql),
      prepare: (sql: string) => ({
        get: () => ({ rowid: 1, content: "content", tags: "[]" }),
        run: () => {
          if (sql.startsWith("UPDATE promoted")) throw new Error("update failed");
        },
      }),
    } as unknown as DatabaseSync;
    expect(() => new PromotedStore(db).revive("id")).toThrow("update failed");
    expect(execCalls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("leaves rollback to the owning transaction when revive fails in a transaction", () => {
    const execCalls: string[] = [];
    const db = {
      isTransaction: true,
      exec: (sql: string) => execCalls.push(sql),
      prepare: (sql: string) => ({
        get: () => ({ rowid: 1, content: "content", tags: "[]" }),
        run: () => {
          if (sql.startsWith("UPDATE promoted")) throw new Error("update failed");
        },
      }),
    } as unknown as DatabaseSync;
    expect(() => new PromotedStore(db).revive("id")).toThrow("update failed");
    expect(execCalls).toEqual([]);
  });

  // ── getById ──────────────────────────────────────────────────────────────

  it("getById returns null for a non-existent id", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    expect(store.getById("non-existent-uuid")).toBeNull();
  });

  // ── getAll ───────────────────────────────────────────────────────────────

  it("getAll returns all non-archived rows when called without options", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "Alpha memory", tags: ["t1"], projectId: "proj-a" });
    store.insert({ content: "Beta memory", tags: ["t2"], projectId: "proj-b" });
    const archivedId = store.insert({ content: "Archived memory", tags: [], projectId: "proj-a" });
    store.archive(archivedId);

    const rows = store.getAll();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.content)).toContain("Alpha memory");
    expect(rows.map((r) => r.content)).toContain("Beta memory");
    // Archived row must not appear
    expect(rows.map((r) => r.content)).not.toContain("Archived memory");
  });

  it("getAll with projectId filter returns only that project's rows", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "Project A memory", tags: [], projectId: "proj-a" });
    store.insert({ content: "Project B memory", tags: [], projectId: "proj-b" });

    const rows = store.getAll({ projectId: "proj-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Project A memory");
  });

  it("getAll with since filter returns only rows created after the threshold", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert a row with an explicit early timestamp by using raw SQL
    db.prepare(
      "INSERT INTO promoted (id, content, tags, project_id, confidence, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("old-id", "Old memory", "[]", "proj-x", 1.0, 0, "2024-01-01T00:00:00.000Z");

    store.insert({ content: "New memory", tags: [], projectId: "proj-x" });

    const rows = store.getAll({ since: "2025-01-01T00:00:00.000Z" });
    expect(rows.map((r) => r.content)).not.toContain("Old memory");
    expect(rows.map((r) => r.content)).toContain("New memory");
  });

  it("getAll with tags filter returns only rows matching all specified tags", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "Has both tags", tags: ["alpha", "beta"], projectId: "p1" });
    store.insert({ content: "Only alpha", tags: ["alpha"], projectId: "p1" });
    store.insert({ content: "Only beta", tags: ["beta"], projectId: "p1" });

    const rows = store.getAll({ tags: ["alpha", "beta"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Has both tags");
  });

  // ── listContentPrefixes ──────────────────────────────────────────────────

  it("listContentPrefixes returns content strings up to the specified limit", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "First insight", tags: [], projectId: "p1" });
    store.insert({ content: "Second insight", tags: [], projectId: "p1" });
    store.insert({ content: "Third insight", tags: [], projectId: "p1" });

    const prefixes = store.listContentPrefixes(2);
    expect(prefixes).toHaveLength(2);
    // All returned values must be from the inserted contents
    for (const prefix of prefixes) {
      expect(["First insight", "Second insight", "Third insight"]).toContain(prefix);
    }
  });

  it("listContentPrefixes returns empty array when table is empty", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    expect(store.listContentPrefixes(10)).toEqual([]);
  });

  it("listContentPrefixes excludes archived rows", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    const id = store.insert({ content: "Will be archived", tags: [], projectId: "p1" });
    store.archive(id);

    const prefixes = store.listContentPrefixes(10);
    expect(prefixes).not.toContain("Will be archived");
  });

  // ── update ───────────────────────────────────────────────────────────────

  it("update tags-only: changes tags without altering content", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Tag test content", tags: ["old-tag"], projectId: "p1" });

    store.update(id, { tags: ["new-tag-a", "new-tag-b"] });

    const row = store.getById(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe("Tag test content");
    const tags = JSON.parse(row!.tags) as string[];
    expect(tags).toContain("new-tag-a");
    expect(tags).toContain("new-tag-b");
    expect(tags).not.toContain("old-tag");
  });

  it("update confidence-only: changes confidence without altering content or tags", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Confidence test", tags: ["keep"], projectId: "p1", confidence: 0.5 });

    store.update(id, { confidence: 0.95 });

    const row = store.getById(id);
    expect(row).not.toBeNull();
    expect(row!.confidence).toBe(0.95);
    expect(row!.content).toBe("Confidence test");
    expect(JSON.parse(row!.tags)).toContain("keep");
  });

  it("update on non-existent id is a no-op and does not throw", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    expect(() => store.update("ghost-id", { content: "x", confidence: 1.0 })).not.toThrow();
  });

  // ── search with projectId ────────────────────────────────────────────────

  it("search with projectId only returns results from that project", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "React is great for project A", tags: [], projectId: "proj-a" });
    store.insert({ content: "React is used in project B", tags: [], projectId: "proj-b" });

    const results = store.search("React", 10, undefined, "proj-a");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("project A");
    expect(results[0].projectId).toBe("proj-a");
  });

  it("search returns empty array when query consists only of punctuation/symbols", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "Some content here", tags: [], projectId: "p1" });

    // All non-word characters get stripped — sanitized becomes empty
    const results = store.search("!!! ---", 10);
    expect(results).toEqual([]);
  });

  // ── transaction ──────────────────────────────────────────────────────────

  it("transaction commits all operations when the callback succeeds", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    let id1: string;
    let id2: string;

    store.transaction(() => {
      id1 = store.insert({ content: "Tx memory 1", tags: [], projectId: "p1" });
      id2 = store.insert({ content: "Tx memory 2", tags: [], projectId: "p1" });
    });

    expect(store.getById(id1!)).not.toBeNull();
    expect(store.getById(id2!)).not.toBeNull();
  });

  it("transaction rolls back all operations when the callback throws", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    expect(() => {
      store.transaction(() => {
        store.insert({ content: "Should be rolled back", tags: [], projectId: "p1" });
        throw new Error("deliberate failure");
      });
    }).toThrow("deliberate failure");

    const rows = store.getAll();
    expect(rows.map((r) => r.content)).not.toContain("Should be rolled back");
  });

  it("rolls back promoted content when FTS synchronization fails", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "original content", tags: ["old"], projectId: "p1" });
    db.exec("DROP TABLE promoted_fts");

    expect(() => store.update(id, { content: "partial update", tags: ["new"] })).toThrow();
    expect(store.getById(id)).toMatchObject({ content: "original content", tags: '["old"]' });
  });

  // ── deleteById ───────────────────────────────────────────────────────────

  it("deleteById on a non-existent id does not throw", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    expect(() => store.deleteById("does-not-exist")).not.toThrow();
  });
});
