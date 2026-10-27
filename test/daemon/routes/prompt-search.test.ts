import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";
import { buildPreToolRecallQuery, handlePreToolUse } from "../../../src/hooks/pre-tool.js";
import { configPath, lcmHomeDir } from "../../../src/runtime-paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /prompt-search", () => {
  it("treats promptSearchMaxResults zero as an absolute disable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-disabled-"));
    tempDirs.push(tempDir);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      new PromotedStore(db).insert({ content: "Always use SQLite", projectId: "p1" });
    } finally {
      closeLcmConnection(dbPath);
    }

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMaxResults = 0;
    config.restoration.maxInjectedMemoryItems = 10;
    const daemon = await createDaemon(config);
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/prompt-search`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "SQLite", cwd: tempDir }),
      });
      expect(await res.json()).toEqual({ hints: [], ids: [] });
    } finally { await daemon.stop(); }
  });
  it("returns hints for matching promoted entries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-"));
    tempDirs.push(tempDir);

    // Pre-populate promoted table
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database is PostgreSQL running on port 5432", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React frontend decided", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[]; ids: string[] };
      expect(res.status).toBe(200);
      expect(Array.isArray(data.hints)).toBe(true);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0]).toContain("React");
      // ids should be present and parallel to hints
      expect(Array.isArray(data.ids)).toBe(true);
      expect(data.ids.length).toBe(data.hints.length);
      expect(typeof data.ids[0]).toBe("string");
    } finally {
      await daemon.stop();
    }
  });

  it("logs surfacing events to recall_surfacing table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-recall-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const insertedId = store.insert({ content: "Use TypeScript everywhere", tags: [], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript", cwd: tempDir, session_id: "sess-recall" }),
      });

      // Verify surfacing was logged
      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT memory_id, session_id FROM recall_surfacing WHERE memory_id = ?"
      ).get(insertedId) as { memory_id: string; session_id: string } | undefined;
      verifyDb.close();

      expect(row).toBeDefined();
      expect(row?.memory_id).toBe(insertedId);
      expect(row?.session_id).toBe("sess-recall");
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when no entries match", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-nomatch-"));
    tempDirs.push(tempDir);

    // Pre-populate with unrelated content
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    // High minScore to filter out weak matches
    config.restoration.promptSearchMinScore = 999;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when no db exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-nodb-"));
    tempDirs.push(tempDir);

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "something", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when query or cwd is missing", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      // Missing query
      const res1 = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/some/dir" }),
      });
      const data1 = await res1.json() as { hints: string[] };
      expect(res1.status).toBe(200);
      expect(data1.hints).toEqual([]);

      // Missing cwd
      const res2 = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "something" }),
      });
      const data2 = await res2.json() as { hints: string[] };
      expect(res2.status).toBe(200);
      expect(data2.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns hints for same-session entries and filters via minScore when session_id provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-session-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    // Same-session entry — should pass score filter
    store.insert({ content: "We agreed to use TypeScript for all modules", tags: [], projectId: "p1", sessionId: "sess-current" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript modules agreed", cwd: tempDir, session_id: "sess-current" }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0]).toContain("TypeScript");
    } finally {
      await daemon.stop();
    }
  });

  it("truncates long content to snippetLength", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-truncate-"));
    tempDirs.push(tempDir);

    const longContent = "React " + "x".repeat(300);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: longContent, tags: [], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSnippetLength = 50;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0].length).toBeLessThanOrEqual(53); // 50 + "..."
      expect(data.hints[0].endsWith("...")).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("reranks acted-upon memories above otherwise similar unused memories", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-usage-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const unusedId = store.insert({ content: "Use SQLite for project storage in background jobs", tags: ["decision"], projectId: "p1" });
    const usedId = store.insert({ content: "Use SQLite for project storage in the main service", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Acted on stored memory", tags: ["signal:memory_used", `memory_id:${usedId}`], projectId: "p1" });
    store.insert({ content: "Acted on stored memory again", tags: ["signal:memory_used", `memory_id:${usedId}`], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.recallUsageBoost = 1.5;
    config.restoration.recallUsageSmoothing = 1;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "SQLite project storage", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; usageCount: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(usedId);
      expect(data.ids).toContain(unusedId);
      expect(data.debug.candidates[0].id).toBe(usedId);
      expect(data.debug.candidates[0].usageCount).toBe(2);
      expect(data.debug.candidates[0].finalScore).toBeGreaterThan(data.debug.candidates[1].finalScore);
    } finally {
      await daemon.stop();
    }
  });

  it("suppresses recently surfaced memories unless they clear the resurface margin", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-cooldown-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const cooledId = store.insert({ content: "TypeScript build convention", tags: ["decision"], projectId: "p1" });
    const freshId = store.insert({ content: "TypeScript build convention", tags: ["decision"], projectId: "p1" });
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(cooledId, "sess-a");
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 10;
    config.restoration.unusedSurfacingPenalty = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript build convention", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; cooledDown: boolean }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([freshId]);
      expect(data.ids).not.toContain(cooledId);
      expect(data.debug.candidates.find((candidate) => candidate.id === cooledId)).toMatchObject({
        id: cooledId,
        cooledDown: true,
      });
      expect(data.debug.candidates.find((candidate) => candidate.id === freshId)).toMatchObject({
        id: freshId,
        cooledDown: false,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to the best cooled candidate when every eligible result is in cooldown", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-all-cooled-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({ content: "TypeScript build convention", tags: ["workflow"], projectId: "p1" });
    const secondId = store.insert({ content: "TypeScript build convention", tags: ["workflow"], projectId: "p1" });
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(firstId, "sess-a");
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(secondId, "sess-b");
    store.insert({ content: "Acted on first cooled memory", tags: ["signal:memory_used", `memory_id:${firstId}`], projectId: "p1" });
    store.insert({ content: "Acted on second cooled memory", tags: ["signal:memory_used", `memory_id:${secondId}`], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 10;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript build convention", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; cooledDown: boolean; surfaced: boolean }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([firstId]);
      expect(data.hints).toHaveLength(1);
      expect(data.debug.candidates).toHaveLength(2);
      expect(data.debug.candidates.every((candidate) => candidate.cooledDown)).toBe(true);
      expect(data.debug.candidates.filter((candidate) => candidate.surfaced)).toEqual([
        expect.objectContaining({ id: firstId, surfaced: true }),
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it("penalizes repeatedly surfaced memories that were never acted upon", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-unused-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const staleId = store.insert({ content: "Bun test runner", tags: ["workflow"], projectId: "p1" });
    const freshId = store.insert({ content: "Bun test runner", tags: ["workflow"], projectId: "p1" });
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(staleId, `sess-${i}`);
    }
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.surfacingCooldownWindow = 0;
    config.restoration.unusedSurfacingPenalty = 1;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Bun test runner", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; surfacingCount: number; usageCount: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(freshId);
      expect(data.debug.candidates[0].id).toBe(freshId);
      expect(data.debug.candidates[0].usageCount).toBe(0);
      expect(data.debug.candidates[1]).toMatchObject({
        id: staleId,
        surfacingCount: 3,
        usageCount: 0,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to baseline ordering when no recall feedback exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-fallback-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({
      content: "Node worker pool for queue jobs",
      tags: ["workflow"],
      projectId: "p1",
      confidence: 0.9,
    });
    const secondId = store.insert({
      content: "Node worker pool for background tasks",
      tags: ["workflow"],
      projectId: "p1",
      confidence: 0.8,
    });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Node worker pool", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; usageCount: number; surfacingCount: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(firstId);
      expect(data.ids[1]).toBe(secondId);
      expect(data.debug.candidates[0]).toMatchObject({
        id: firstId,
        usageCount: 0,
        surfacingCount: 0,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("treats invalid created_at values as neutral recency instead of dropping results", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-invalid-created-at-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use deno fmt before commit", tags: ["workflow"], projectId: "p1" });
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("not-a-date", memoryId);
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "deno fmt", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; baseScore: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([memoryId]);
      expect(data.debug.candidates[0]).toMatchObject({ id: memoryId });
      expect(Number.isFinite(data.debug.candidates[0].baseScore)).toBe(true);
      expect(Number.isFinite(data.debug.candidates[0].finalScore)).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("dedupes near-identical emitted hints before surfacing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-dedupe-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    // Identical timestamps plus descending confidence make confidence the deterministic tie-breaker, so firstId always outranks secondId.
    const firstId = store.insert({ content: "Use Bun scripts for local automation and CI wrappers", tags: ["workflow"], projectId: "p1", confidence: 0.9 });
    const secondId = store.insert({ content: "Use Bun scripts for local automation and CI wrappers with small wrappers", tags: ["workflow"], projectId: "p1", confidence: 0.8 });
    const thirdId = store.insert({ content: "Bun scripts wrap local automation and CI tasks", tags: ["workflow"], projectId: "p1", confidence: 0.7 });
    const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    db.prepare("UPDATE promoted SET created_at = ? WHERE id IN (?, ?, ?)").run(createdAt, firstId, secondId, thirdId);
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.maxInjectedMemoryItems = 3;
    config.restoration.dedupMinPrefix = 24;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "Use Bun scripts",
          cwd: tempDir,
          learningInstructionBytes: 900,
          debug: true,
        }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { budget: { dedupedCount: number; emittedCount: number } };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toContain(firstId);
      expect(data.ids).not.toContain(secondId);
      expect(data.ids).toContain(thirdId);
      expect(data.debug.budget).toMatchObject({ dedupedCount: 1, emittedCount: 2 });
    } finally {
      await daemon.stop();
    }
  });

  it("drops lower-ranked hints when the final memory-context budget is exhausted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-budget-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    // Equal FTS inputs and timestamps isolate confidence as the deterministic ordering signal.
    const firstId = store.insert({ content: `Memory candidate A ${"detail ".repeat(30)}`, tags: ["workflow"], projectId: "p1", confidence: 0.9 });
    const secondId = store.insert({ content: `Memory candidate B ${"detail ".repeat(30)}`, tags: ["workflow"], projectId: "p1", confidence: 0.8 });
    const thirdId = store.insert({ content: `Memory candidate C ${"detail ".repeat(30)}`, tags: ["workflow"], projectId: "p1", confidence: 0.7 });
    const createdAt = new Date().toISOString();
    db.prepare("UPDATE promoted SET created_at = ? WHERE id IN (?, ?, ?)").run(createdAt, firstId, secondId, thirdId);
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSnippetLength = 120;
    config.restoration.maxInjectedMemoryBytes = 1200;
    config.restoration.reservedForLearningInstruction = 900;
    config.restoration.maxInjectedMemoryItems = 3;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "memory",
          cwd: tempDir,
          learningInstructionBytes: 900,
          debug: true,
        }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { budget: { emittedCount: number; droppedForBudget: number; availableHintBytes: number; usedHintBytes: number } };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toHaveLength(data.hints.length);
      expect(data.ids).toHaveLength(data.debug.budget.emittedCount);
      expect(data.ids[0]).toBe(firstId);
      expect(data.ids).not.toContain(thirdId);
      expect(data.debug.budget.emittedCount).toBeGreaterThan(0);
      expect(data.debug.budget.emittedCount).toBeLessThan(3);
      expect(data.debug.budget.droppedForBudget).toBeGreaterThan(0);
      expect(data.debug.budget.usedHintBytes).toBeLessThanOrEqual(data.debug.budget.availableHintBytes);
      expect(data.ids.every((id) => [firstId, secondId, thirdId].includes(id))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("skips surfacing logs when the caller defers tracking to final emission", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-deferred-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use pnpm in CI", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "pnpm CI",
          cwd: tempDir,
          learningInstructionBytes: 900,
          logSurfacing: false,
        }),
      });

      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT COUNT(*) as count FROM recall_surfacing WHERE memory_id = ?"
      ).get(memoryId) as { count: number };
      verifyDb.close();

      expect(row.count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("logs surfacing events when logSurfacing is enabled (default)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-log-enabled-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use pnpm in CI", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "pnpm CI",
          cwd: tempDir,
          learningInstructionBytes: 900,
          // logSurfacing omitted, defaults to true
        }),
      });

      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT COUNT(*) as count FROM recall_surfacing WHERE memory_id = ?"
      ).get(memoryId) as { count: number };
      verifyDb.close();

      expect(row.count).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });
});

describe("stale memory demotion", () => {
  it("applies stalePenalty to old memories surfaced without use", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-stale-prompt-"));
    tempDirs.push(tempDir);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);

    // Insert an old memory and backdate it
    const oldId = store.insert({
      content: "stale database indexing strategy old",
      tags: ["test"],
      projectId: "test-stale",
      confidence: 0.8,
    });
    const pastDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(pastDate, oldId);

    // Simulate surfacing without use (5 times)
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(oldId, `s-${i}`);
    }

    // Insert a fresh memory
    const freshId = store.insert({
      content: "fresh database indexing strategy new",
      tags: ["test"],
      projectId: "test-stale",
      confidence: 0.8,
    });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.staleAfterDays = 90;
    config.restoration.staleSurfacingWithoutUseLimit = 5;
    config.restoration.stalePenalty = 0.5;
    config.restoration.allowStaleOnStrongMatch = true;

    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "database indexing strategy", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; stalePenalty: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);

      const oldCandidate = data.debug.candidates.find((c) => c.id === oldId);
      const freshCandidate = data.debug.candidates.find((c) => c.id === freshId);

      expect(oldCandidate).toBeDefined();
      expect(freshCandidate).toBeDefined();
      // Stale candidate should have a penalty applied
      expect(oldCandidate!.stalePenalty).toBeGreaterThan(0);
      // Fresh candidate should have no stale penalty
      expect(freshCandidate!.stalePenalty).toBe(0);
      // Fresh should rank higher than stale
      expect(freshCandidate!.finalScore).toBeGreaterThan(oldCandidate!.finalScore);
    } finally {
      await daemon.stop();
    }
  });
});


describe("POST /prompt-search recallMode pre-tool", () => {
  type Hit = { hints: string[]; ids: string[]; debug?: { candidates: Array<{ id: string; cooledDown: boolean; surfacingCount: number; matchedTermCount: number; queryTermCount: number; finalScore: number }> } };

  function seed(
    tempDir: string,
    memories: Array<{
      content: string;
      sessionId?: string;
      surfaced?: boolean;
      tags?: string[];
      surfacings?: number;
      ageDays?: number;
    }>,
  ): string[] {
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      runLcmMigrations(db);
      const store = new PromotedStore(db);
      return memories.map((memory) => {
        const id = store.insert({
          content: memory.content,
          tags: memory.tags ?? ["decision"],
          projectId: "p1",
          ...(memory.sessionId === undefined ? {} : { sessionId: memory.sessionId }),
        });
        if (memory.ageDays !== undefined) {
          db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?")
            .run(new Date(Date.now() - memory.ageDays * 86_400_000).toISOString(), id);
        }
        for (let count = 0; count < (memory.surfacings ?? 0); count += 1) {
          db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(id, "sess-earlier");
        }
        if (memory.surfaced) {
          db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(id, "sess-earlier");
        }
        return id;
      });
    } finally {
      db.close();
    }
  }

  async function post(port: number, body: Record<string, unknown>): Promise<Hit> {
    const res = await fetch("http://127.0.0.1:" + port + "/prompt-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return await res.json() as Hit;
  }

  function surfacingRows(tempDir: string): Array<{ memory_id: string; session_id: string }> {
    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      return db.prepare("SELECT memory_id, session_id FROM recall_surfacing ORDER BY id").all() as Array<{ memory_id: string; session_id: string }>;
    } finally {
      db.close();
    }
  }

  function tempProject(label: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-prompt-search-" + label + "-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it("applies the strict pre-tool policy only for the exact recallMode value", async () => {
    const tempDir = tempProject("pretool-mode");
    const [firstId] = seed(tempDir, [
      { content: "TypeScript build convention", surfaced: true },
      { content: "TypeScript build convention", surfaced: true },
    ]);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 10;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const base = { query: "TypeScript build convention", cwd: tempDir, logSurfacing: false };
      // Prompt recall falls back to the best cooled candidate.
      for (const recallMode of [undefined, "prompt", "Pre-Tool", "pre-tool ", 1, null, true]) {
        const prompt = await post(port, { ...base, recallMode });
        expect(prompt.ids, String(recallMode)).toEqual([firstId]);
      }
      const preTool = await post(port, { ...base, recallMode: "pre-tool" });
      expect(preTool.ids).toEqual([]);
      expect(preTool.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("excludes a cooled-down memory even when it ties a fresh one and the margin is zero", async () => {
    const tempDir = tempProject("pretool-tie");
    const [cooledId, freshId] = seed(tempDir, [
      { content: "TypeScript build convention alpha", surfaced: true },
      { content: "TypeScript build convention bravo" },
    ]);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 0;
    config.restoration.unusedSurfacingPenalty = 0;
    config.restoration.recencyHalfLifeHours = 1e9;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const base = { query: "TypeScript build convention", cwd: tempDir, logSurfacing: false };
      expect((await post(port, base)).ids.sort()).toEqual([cooledId, freshId].sort());
      expect((await post(port, { ...base, recallMode: "pre-tool" })).ids).toEqual([freshId]);
    } finally {
      await daemon.stop();
    }
  });

  it("caps pre-tool results and emitted items at two without changing prompt recall", async () => {
    const tempDir = tempProject("pretool-cap");
    seed(tempDir, [
      { content: "Alpha release checklist pnpm postgresql" },
      { content: "Bravo migration notes pnpm postgresql" },
      { content: "Charlie rollback runbook pnpm postgresql" },
    ]);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSearchMaxResults = 5;
    config.restoration.maxInjectedMemoryItems = 5;
    config.restoration.maxInjectedMemoryBytes = 8192;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const base = { query: "pnpm postgresql", cwd: tempDir, session_id: "sess-cap" };
      expect((await post(port, { ...base, logSurfacing: false })).ids).toHaveLength(3);
      const preTool = await post(port, { ...base, recallMode: "pre-tool" });
      expect(preTool.ids).toHaveLength(2);
      expect(preTool.hints).toHaveLength(2);
      // Surfacing stays shared with prompt recall.
      expect(surfacingRows(tempDir)).toEqual(preTool.ids.map((memory_id) => ({ memory_id, session_id: "sess-cap" })));
    } finally {
      await daemon.stop();
    }
  });

  it("honors a smaller configured result limit in pre-tool mode", async () => {
    const tempDir = tempProject("pretool-small");
    seed(tempDir, [
      { content: "Alpha release checklist pnpm postgresql" },
      { content: "Bravo migration notes pnpm postgresql" },
    ]);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSearchMaxResults = 1;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const preTool = await post(port, { query: "pnpm postgresql", cwd: tempDir, recallMode: "pre-tool" });
      expect(preTool.ids).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("relaxes the minimum score by 0.5 in pre-tool mode only and never below zero", async () => {
    const tempDir = tempProject("pretool-minscore");
    const [memoryId] = seed(tempDir, [{ content: "Run pnpm postgresql tests through the rootless podman socket" }]);
    const base = { query: "pnpm postgresql", cwd: tempDir, logSurfacing: false };
    const probe = async (minScore: number): Promise<{ prompt: string[]; preTool: string[] }> => {
      const config = loadDaemonConfig("/nonexistent");
      config.daemon.port = 0;
      config.restoration.promptSearchMinScore = minScore;
      const daemon = await createDaemon(config);
      try {
        const port = daemon.address().port;
        return {
          prompt: (await post(port, base)).ids,
          preTool: (await post(port, { ...base, recallMode: "pre-tool" })).ids,
        };
      } finally {
        await daemon.stop();
      }
    };

    // A full two-term match scores just under 2.
    expect(await probe(2)).toEqual({ prompt: [], preTool: [memoryId] });
    expect(await probe(4)).toEqual({ prompt: [], preTool: [] });
    expect(await probe(0.25)).toEqual({ prompt: [memoryId], preTool: [memoryId] });
  });

  it("grants the pre-tool relief only to complete query matches", async () => {
    const tempDir = tempProject("pretool-partial");
    const sessionId = "same";
    const [memoryId] = seed(tempDir, [{ content: "git rebasing adventures with quokkas", sessionId }]);
    // Four recorded uses lift a one-of-two-term match to about 1.6 (1.5 < score < 2).
    const used = Array.from({ length: 4 }, (_unused, index) => ({
      content: "Acted on memory number " + index,
      tags: ["signal:memory_used", "memory_id:" + memoryId],
    }));
    seed(tempDir, used);
    const query = buildPreToolRecallQuery("Bash", { command: "git status" });
    expect(query).toBe("git status");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const base = { query: query!, cwd: tempDir, session_id: sessionId, debug: true, logSurfacing: false };
      const preTool = await post(port, { ...base, recallMode: "pre-tool" });
      const candidate = preTool.debug!.candidates
        .find((entry) => entry.id === memoryId)!;
      expect(candidate.matchedTermCount).toBe(1);
      expect(candidate.queryTermCount).toBe(2);
      expect(candidate.finalScore).toBeGreaterThan(1.5);
      expect(candidate.finalScore).toBeLessThan(2);
      expect(preTool.ids).toEqual([]);
      expect((await post(port, base)).ids).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("does not let the relief admit a stale full match clamped to a zero score", async () => {
    const tempDir = tempProject("pretool-stale");
    const [memoryId] = seed(tempDir, [{
      content: "Run pnpm postgresql tests through the rootless podman socket",
      ageDays: 200,
      surfacings: 5,
    }]);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0.5;
    config.restoration.allowStaleOnStrongMatch = false;
    config.restoration.surfacingCooldownWindow = 0;
    config.restoration.unusedSurfacingPenalty = 0;
    config.restoration.stalePenalty = 0;
    config.restoration.recencyHalfLifeHours = 1e9;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const base = { query: "pnpm postgresql", cwd: tempDir, debug: true, logSurfacing: false };
      for (const recallMode of [undefined, "pre-tool"]) {
        const result = await post(port, { ...base, recallMode });
        const candidate = result.debug!.candidates
          .find((entry) => entry.id === memoryId)!;
        expect(candidate.matchedTermCount).toBe(2);
        expect(candidate.finalScore).toBe(0);
        expect(result.ids, String(recallMode)).toEqual([]);
      }
    } finally {
      await daemon.stop();
    }
  });

  describe("end to end through the real hook handler", () => {
    const sessionId = "root-thread";
    const unrelated = "run test src index main docs build dist file";

    afterEach(() => {
      rmSync(configPath(), { force: true });
    });

    async function withDaemon(
      tempDir: string,
      adjust: (config: ReturnType<typeof loadDaemonConfig>) => void,
      body: (run: (toolName: string, toolInput: unknown) => Promise<string>, port: number) => Promise<void>,
    ): Promise<void> {
      const config = loadDaemonConfig("/nonexistent");
      config.daemon.port = 0;
      adjust(config);
      const daemon = await createDaemon(config);
      const port = daemon.address().port;
      mkdirSync(lcmHomeDir(), { recursive: true, mode: 0o700 });
      writeFileSync(configPath(), JSON.stringify({ daemon: { port }, hooks: { preToolRecall: true } }), { mode: 0o600 });
      try {
        await body(async (toolName, toolInput) => {
          const result = await handlePreToolUse(JSON.stringify({
            session_id: sessionId,
            cwd: tempDir,
            hook_event_name: "PreToolUse",
            tool_name: toolName,
            tool_input: toolInput,
          }));
          expect(result.exitCode).toBe(0);
          return result.stdout;
        }, port);
      } finally {
        await daemon.stop();
      }
    }

    const contextOf = (stdout: string): string => (
      JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext;

    it("surfaces action-specific memories once and suppresses repeats, without generic distractors", async () => {
      const tempDir = tempProject("pretool-e2e");
      const [podmanId, fileId, prId, distractorId] = seed(tempDir, [
        { content: "Run pnpm postgresql tests through the rootless podman socket, not Docker", sessionId },
        { content: "codex-hooks.ts in src/connectors must keep the PostToolUse registration stable" },
        { content: "GitHub create pull request titles follow conventional commits" },
        { content: unrelated, sessionId },
      ]);

      await withDaemon(tempDir, () => undefined, async (run, port) => {
        expect(buildPreToolRecallQuery("Bash", { command: "pnpm run test:postgresql" })).toBe("pnpm postgresql");
        const bash = await run("Bash", { command: "pnpm run test:postgresql" });
        expect(contextOf(bash)).toContain("shell command");
        expect(contextOf(bash)).toContain("rootless podman socket");
        expect(contextOf(bash)).toContain("surfaced-memory-ids: " + podmanId);
        expect(contextOf(bash)).not.toContain(unrelated);

        const patch = await run("apply_patch", {
          command: "*** Begin Patch\n*** Update File: src/connectors/codex-hooks.ts\n@@\n-old\n+SECRETBODY\n*** End Patch",
        });
        expect(contextOf(patch)).toContain("file edit");
        expect(contextOf(patch)).toContain("PostToolUse registration");
        expect(contextOf(patch)).toContain(fileId);
        expect(contextOf(patch)).not.toContain(unrelated);

        const mcp = await run("mcp__github__create_pull_request", { title: "SECRETTITLE" });
        expect(contextOf(mcp)).toContain("MCP tool");
        expect(contextOf(mcp)).toContain("conventional commits");
        expect(contextOf(mcp)).toContain(prId);

        // Sequential repetition is suppressed by the shared cooldown.
        expect(await run("Bash", { command: "pnpm run test:postgresql" })).toBe("");
        expect(await run("apply_patch", {
          command: "*** Update File: src/connectors/codex-hooks.ts",
        })).toBe("");
        expect(await run("mcp__github__create_pull_request", {})).toBe("");
        expect(surfacingRows(tempDir).map((row) => row.memory_id)).toEqual([podmanId, fileId, prId]);
        expect(surfacingRows(tempDir).map((row) => row.memory_id)).not.toContain(distractorId);

        // Prompt recall afterwards sees the cooldown and unused-surfacing effect.
        const later = await post(port, {
          query: "pnpm postgresql podman socket",
          cwd: tempDir,
          session_id: sessionId,
          debug: true,
          logSurfacing: false,
        });
        expect(later.debug!.candidates.find((candidate) => candidate.id === podmanId)).toMatchObject({
          cooledDown: true,
          surfacingCount: 1,
        });
      });
    });

    it.each([
      ["the default budget", (_config: ReturnType<typeof loadDaemonConfig>) => undefined, 2048],
      ["no configured learning reserve", (config: ReturnType<typeof loadDaemonConfig>) => {
        config.restoration.reservedForLearningInstruction = 0;
      }, 2048],
      ["a tiny budget", (config: ReturnType<typeof loadDaemonConfig>) => {
        config.restoration.maxInjectedMemoryBytes = 560;
        config.restoration.reservedForLearningInstruction = 0;
      }, 560],
    ])("keeps the injected context within the total budget with %s", async (_label, adjust, budget) => {
      const tempDir = tempProject("pretool-bytes");
      seed(tempDir, [
        { content: "Run pnpm postgresql tests through the rootless podman socket " + "détail ☕ 日本語 ".repeat(40), sessionId },
        { content: "Second pnpm postgresql note for the shared runner " + "détail ☕ 日本語 ".repeat(40), sessionId },
      ]);

      await withDaemon(tempDir, adjust, async (run) => {
        const stdout = await run("Bash", { command: "pnpm run test:postgresql" });
        const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
        const context = parsed.hookSpecificOutput.additionalContext;
        expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(budget);
        expect(context).toContain("pnpm postgresql");
        expect(context).toContain("</memory-context>");
      });
    });
  });
});
