import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";

const tempDirs: string[] = [];
afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-dedup-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

function dedupDeps(db: ReturnType<typeof makeDb>, store: PromotedStore) {
  const promotedMemory = {
    insert: async (input: Omit<Parameters<PromotedStore["insert"]>[0], "projectId">) =>
      store.insert({ ...input, projectId: "p1" }),
    update: async (id: string, fields: Parameters<PromotedStore["update"]>[1]) => store.update(id, fields),
    archive: async (id: string) => store.archive(id),
  };
  const lexicalSearch = {
    searchPromoted: async (query: string, limit: number, tags?: string[]) =>
      store.search(query, limit, tags, "p1"),
  };
  return {
    transaction: async <T>(callback: (repositories: {
      promotedMemory: typeof promotedMemory;
      lexicalSearch: typeof lexicalSearch;
    }) => Promise<T>): Promise<T> => {
      db.exec("BEGIN");
      try {
        const result = await callback({ promotedMemory, lexicalSearch });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("deduplicateAndInsert", () => {
  it("converges exact unranked fallback matches without merging partial lexical matches", async () => {
    const db = makeDb();
    const store = new PromotedStore(db, false);
    const shared = {
      ...dedupDeps(db, store),
      tags: ["decision"],
      depth: 2,
      confidence: 0.7,
      thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 10 },
    };

    const first = await deduplicateAndInsert({
      ...shared,
      content: "Use PostgreSQL for durable storage",
    });
    const repeated = await deduplicateAndInsert({
      ...shared,
      content: "Use PostgreSQL for durable storage",
    });
    const partial = await deduplicateAndInsert({
      ...shared,
      content: "Use PostgreSQL for analytics storage",
    });

    expect(repeated).toBe(first);
    expect(partial).not.toBe(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM promoted").get()).toEqual({ count: 2 });
  });

  it("supports the structural legacy bridge for deferred SQLite callers", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const weaker = store.insert({
      content: "PostgreSQL database architecture",
      tags: ["old"],
      projectId: "p1",
      confidence: 0.5,
    });
    const stronger = store.insert({
      content: "PostgreSQL database architecture decision",
      tags: ["strong"],
      projectId: "p1",
      confidence: 0.8,
    });
    await deduplicateAndInsert({
      store,
      content: "PostgreSQL database architecture confirmed",
      tags: ["incoming"],
      projectId: "p1",
      depth: 2,
      confidence: 0.7,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });
    expect([store.getById(weaker), store.getById(stronger)].filter((row) => row?.archived_at)).toHaveLength(1);

    const inserted = await deduplicateAndInsert({
      store,
      content: "Entirely unrelated local memory",
      tags: ["new"],
      projectId: "p2",
      depth: 0,
      confidence: 0.4,
      thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 3 },
    });
    expect(store.getById(inserted)).not.toBeNull();
  });

  it("inserts new entry when no duplicates exist", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "Decided to use PostgreSQL for the database",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.2,
      newEntryConfidence: 0.8,
      thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.8);
  });

  it("does not apply new-entry boost when deduping against an existing canonical", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.25,
    });

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.2,
      newEntryConfidence: 0.6,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.25);
  });

  it("refreshes canonical and archives incoming when duplicate found above threshold", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert an existing entry (canonical)
    const canonical = store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.8,
      // Use a near-zero threshold so our small test corpus triggers a match
      // (FTS5 BM25 ranks in a 1-doc corpus are around -0.000003, not -0.1)
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    // Only 1 result: the canonical (incoming is archived)
    expect(results.length).toBe(1);
    // Content should be the original canonical content (not merged)
    expect(results[0].content).toContain("database layer");
    // Confidence should be max(0.9, 0.8) = 0.9
    expect(results[0].confidence).toBe(0.9);
    // Returned ID should match canonical
    expect(results[0].id).toBe(canonical);
  });

  it("archives weaker duplicates when multiple exist above threshold", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert two existing entries with different confidences
    const weakEntry = store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.7,
    });

    const strongEntry = store.insert({
      content: "PostgreSQL is the database choice for this project",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "Confirmed PostgreSQL as the database choice",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.6,
      // Use a near-zero threshold to match both existing entries
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    // Only 1 result: the strongest canonical (weaker ones are archived)
    expect(results.length).toBe(1);
    // strongEntry (confidence=0.9) is canonical; weakEntry (confidence=0.7) is archived
    expect(results[0].id).toBe(strongEntry);
    expect(store.getById(weakEntry)?.archived_at).not.toBeNull();
    // Confidence should be max(canonical.confidence=0.9, incoming.confidence=0.6) = 0.9
    expect(results[0].confidence).toBe(0.9);
  });

  it("does not persist repeated incoming duplicates", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert an existing entry (canonical)
    store.insert({
      content: "Decided to use PostgreSQL for the database",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.8,
    });

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "PostgreSQL confirmed after review process",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.7,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    // Only canonical is searchable
    const results = store.search("PostgreSQL", 10);
    expect(results.length).toBe(1);

    // Only the canonical row exists; repeated promotion cannot grow archived rows.
    const rows = db
      .prepare("SELECT archived_at FROM promoted WHERE project_id = ? ORDER BY rowid ASC")
      .all("p1") as Array<{ archived_at: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows.filter((r) => r.archived_at !== null)).toHaveLength(0);
  });

  it("upgrades confidence when incoming is higher than canonical", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.6,
    });

    await deduplicateAndInsert({
      ...dedupDeps(db, store),
      content: "Confirmed PostgreSQL as the database choice after extensive benchmarks",
      tags: ["decision"],
      sessionId: "s1",
      depth: 2,
      confidence: 0.95,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    // Confidence should upgrade to incoming's higher value: max(0.6, 0.95) = 0.95
    expect(results[0].confidence).toBe(0.95);
  });
});
