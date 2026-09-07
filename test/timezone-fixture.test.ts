import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createDaemon } from "../src/daemon/server.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { createRestoreHandler } from "../src/daemon/routes/restore.js";
import type { StorageBackendFactory } from "../src/storage/index.js";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { PromotedStore } from "../src/db/promoted.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { projectDbPath } from "../src/daemon/project.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROUTE_NOW = Date.parse("2026-09-07T08:20:00Z");

function createRouteFixture(prefix: string): { dir: string; db: DatabaseSync; store: PromotedStore } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync("git", ["init", "--quiet", dir]);
  const dbPath = projectDbPath(dir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  return { dir, db, store: new PromotedStore(db, getLcmDbFeatures(db).fts5Available) };
}

async function routePost(daemon: Awaited<ReturnType<typeof createDaemon>>, path: string, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${daemon.address().port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function restoreRoutePost(config: ReturnType<typeof loadDaemonConfig>, factory: StorageBackendFactory, dir: string, body: Record<string, unknown>) {
  let payload = "";
  let statusCode = 200;
  const response = {
    writeHead: (status: number) => { statusCode = status; },
    end: (value?: string) => { payload = value ?? ""; },
  };
  await createRestoreHandler(config, factory)({} as never, response as never, JSON.stringify({ cwd: dir, ...body }));
  return { response: { status: statusCode }, body: JSON.parse(payload || "{}") as Record<string, unknown> };
}

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "lcm-timezone-fixture-"));
  tempDirs.push(dir);
  const db = getLcmConnection(join(dir, "test.db"));
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("spawned timezone fixtures", () => {
  it("proves the host zone is effective before checking conversation timestamps", async () => {
    const local = new Date("2024-03-10 02:30:00").getTime();
    const utc = new Date("2024-03-10T02:30:00Z").getTime();
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC") {
      expect(local).toBe(utc);
    } else {
      expect(local).not.toBe(utc);
    }

    const db = makeDb();
    const store = new ConversationStore(db, { fts5Available: false });
    const before = Date.now();
    const created = await store.createConversation({ sessionId: "timezone" });
    const after = Date.now();
    expect(created.bootstrappedAt).toBeNull();
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(created.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.updatedAt.getTime()).toBeLessThanOrEqual(after + 1000);
    db.prepare(
      "UPDATE conversations SET created_at = ?, updated_at = ?, bootstrapped_at = ? WHERE conversation_id = ?",
    ).run("2024-03-10 02:30:00", "2024-03-10T02:30:00+02:00", "2024-03-10 02:30:00", created.conversationId);

    const record = await store.getConversation(created.conversationId);
    expect(record?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(record?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(record?.bootstrappedAt?.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    const listed = (await store.listConversations())[0];
    expect(listed?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(listed?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(listed?.bootstrappedAt?.toISOString()).toBe("2024-03-10T02:30:00.000Z");

    db.prepare("UPDATE conversations SET bootstrapped_at = '' WHERE conversation_id = ?")
      .run(created.conversationId);
    const emptyBootstrap = await store.getConversation(created.conversationId);
    expect(emptyBootstrap?.bootstrappedAt).toBeNull();
    const listedEmpty = (await store.listConversations())[0];
    expect(listedEmpty?.createdAt.toISOString()).toBe("2024-03-10T02:30:00.000Z");
    expect(listedEmpty?.updatedAt.toISOString()).toBe("2024-03-10T00:30:00.000Z");
    expect(listedEmpty?.bootstrappedAt).toBeNull();
  });

  it("computes promoted age from SQLite UTC text", () => {
    const now = new Date("2026-09-07T08:20:00.000Z");
    vi.setSystemTime(now);
    const db = makeDb();
    const store = new PromotedStore(db, false);
    const fixtures = [
      { createdAt: "2026-09-06 07:20:00", expected: 1 },
      { createdAt: "2026-09-05 08:20:00.000", expected: 2 },
      { createdAt: "2026-09-05 08:19:59.999", expected: 2 },
      { createdAt: "2026-09-05 08:20:00.001", expected: 1 },
      { createdAt: "2026-09-05T08:20:00Z", expected: 2 },
      { createdAt: "2026-09-05T10:20:00+02:00", expected: 2 },
    ];
    const ids = fixtures.map(({ createdAt }) => {
      const id = store.insert({ content: createdAt, projectId: "project", tags: [] });
      db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(createdAt, id);
      return id;
    });
    const rows = store.findStale({ staleAfterDays: 1, staleSurfacingWithoutUseLimit: 5 });
    expect(ids.map((id) => rows.find((row) => row.id === id)?.daysSinceCreated))
      .toEqual(fixtures.map(({ expected }) => expected));
  });

  it("derives and preserves summary bounds across migration reruns", () => {
    const db = makeDb();
    db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run("migration");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, 1, 'user', 'hello', 1, ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (1, 2, 'assistant', 'offset', 1, ?)",
    ).run("2024-03-10T04:30:00+02:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('leaf', 1, 'leaf', 'summary', 1, '[]', ?)",
    ).run("2024-03-09 00:00:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('orphan', 1, 'condensed', 'orphan', 1, '[]', ?)",
    ).run("2024-03-10 02:30:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('offset-leaf', 1, 'leaf', 'offset', 1, '[]', ?)",
    ).run("2024-03-10T04:30:00+02:00");
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids, created_at) VALUES ('parent', 1, 'condensed', 'parent', 1, '[]', ?)",
    ).run("2024-03-11 00:00:00");
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf', 1, 0)").run();
    db.prepare("INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('offset-leaf', 2, 0)").run();
    db.prepare("INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ('parent', 'leaf', 0)").run();

    runLcmMigrations(db, { fts5Available: false });
    const first = db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'leaf'").get() as {
      earliest_at: string;
      latest_at: string;
    };
    expect(first).toEqual({
      earliest_at: "2024-03-10T02:30:00.000Z",
      latest_at: "2024-03-10T02:30:00.000Z",
    });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'orphan'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'offset-leaf'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'parent'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });

    runLcmMigrations(db, { fts5Available: false });
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'leaf'").get())
      .toEqual(first);
    expect(db.prepare("SELECT earliest_at, latest_at FROM summaries WHERE summary_id = 'parent'").get())
      .toEqual({
        earliest_at: "2024-03-10T02:30:00.000Z",
        latest_at: "2024-03-10T02:30:00.000Z",
      });
  });

  it("keeps prompt-search recency and stale selection anchored to UTC", async () => {
    vi.spyOn(Date, "now").mockReturnValue(ROUTE_NOW);
    const { dir, db, store } = createRouteFixture("lcm-route-prompt-timezone-");
    const recencyId = store.insert({
      content: "recencyorbit candidate",
      projectId: dir,
      sessionId: "route-session",
    });
    const staleId = store.insert({
      content: "staleorbit candidate",
      projectId: dir,
      sessionId: "route-session",
    });
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("2026-09-06 08:20:00", recencyId);
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("2026-09-06 08:20:00", staleId);
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(staleId, "old-session");
    db.close();

    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{}\n");
    const config = loadDaemonConfig(configPath, { daemon: { port: 0 } });
    config.restoration.unusedSurfacingPenalty = 0;
    config.restoration.promptSearchMinScore = -1;
    config.restoration.surfacingCooldownWindow = 0;
    config.restoration.staleAfterDays = 1;
    config.restoration.staleSurfacingWithoutUseLimit = 1;
    config.restoration.stalePenalty = 0.75;
    config.restoration.allowStaleOnStrongMatch = true;
    const daemon = await createDaemon(config);
    try {
      const recency = await routePost(daemon, "/prompt-search", {
        query: "recencyorbit",
        cwd: dir,
        session_id: "route-session",
        logSurfacing: false,
        debug: true,
      });
      expect(recency.response.status).toBe(200);
      const recencyDebug = (recency.body.debug as { candidates: Array<{ id: string; rank: number; baseScore: number }> }).candidates
        .find((candidate) => candidate.id === recencyId);
      expect(recencyDebug).toBeDefined();
      expect(recencyDebug!.baseScore).toBeCloseTo(Math.abs(recencyDebug!.rank) * 0.5, 10);
      expect((recency.body.ids as string[])).toContain(recencyId);

      const stale = await routePost(daemon, "/prompt-search", {
        query: "staleorbit",
        cwd: dir,
        session_id: "route-session",
        logSurfacing: false,
        debug: true,
      });
      expect(stale.response.status).toBe(200);
      const staleDebug = (stale.body.debug as { candidates: Array<{ id: string; stalePenalty: number; surfaced: boolean }> }).candidates
        .find((candidate) => candidate.id === staleId);
      expect(staleDebug).toMatchObject({ id: staleId, stalePenalty: 0.75, surfaced: true });
      expect((stale.body.ids as string[])).toContain(staleId);
    } finally {
      await daemon.stop();
    }
  });

  it("applies UTC cutoffs independently to promoted restore and passive insights", async () => {
    vi.spyOn(Date, "now").mockReturnValue(ROUTE_NOW);
    const { dir, db, store } = createRouteFixture("lcm-route-restore-timezone-");
    const promotedRecent = store.insert({ content: "project context recent UTC memory", projectId: dir });
    const promotedBoundary = store.insert({ content: "project context boundary UTC memory", projectId: dir });
    const promotedOld = store.insert({ content: "project context old UTC memory", projectId: dir });
    const passiveRecent = store.insert({
      content: "source passive capture recent insight",
      tags: ["source:passive-capture"],
      projectId: dir,
      confidence: 0.9,
    });
    const passiveBoundary = store.insert({
      content: "source passive capture boundary insight",
      tags: ["source:passive-capture"],
      projectId: dir,
      confidence: 0.9,
    });
    const passiveOld = store.insert({
      content: "source passive capture old insight",
      tags: ["source:passive-capture"],
      projectId: dir,
      confidence: 0.9,
    });
    const timestamps = new Map<string, string>([
      [promotedRecent, "2026-09-06 09:20:00"],
      [promotedBoundary, "2026-09-06T08:20:00Z"],
      [promotedOld, "2026-09-06 08:19:59"],
      [passiveRecent, "2026-09-05 09:20:00"],
      [passiveBoundary, "2026-09-05T10:20:00+02:00"],
      [passiveOld, "2026-09-05 08:19:59"],
    ]);
    for (const [id, createdAt] of timestamps) {
      db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(createdAt, id);
    }
    db.close();

    const config = loadDaemonConfig("/does-not-exist", { daemon: { port: 0 } });
    config.restoration.restoreMaxPromotedAgeDays = 1;
    config.compaction.promotionThresholds.insightsMaxAgeDays = 2;
    const factory = {
      backend: "sqlite",
      projectExists: async () => true,
      openExistingProject: async () => null,
      openProject: async () => {
        const routeDb = new DatabaseSync(projectDbPath(dir));
        const routeStore = new PromotedStore(routeDb, getLcmDbFeatures(routeDb).fts5Available);
        return {
          summaries: { listRecentSummariesForSession: async () => [] },
          lexicalSearch: {
            searchPromoted: async (query: string, limit: number, tags?: string[]) => routeStore.search(query, limit, tags),
          },
          coordination: {
            getSessionInstructions: async () => null,
            upsertSessionInstructions: async () => undefined,
            deleteSessionInstructions: async () => undefined,
          },
          close: async () => { routeDb.close(); },
        };
      },
      close: async () => undefined,
    } as unknown as StorageBackendFactory;
    try {
      const result = await restoreRoutePost(config, factory, dir, {
        session_id: "route-restore",
        source: "startup",
      });
      expect(result.response.status).toBe(200);
      const context = String(result.body.context);
      expect(context).toContain("project context recent UTC memory");
      expect(context).toContain("project context boundary UTC memory");
      expect(context).not.toContain("project context old UTC memory");
      const insights = result.body.insights as Array<{ content: string }>;
      expect(insights.map((insight) => insight.content)).toEqual(expect.arrayContaining([
        "source passive capture recent insight",
        "source passive capture boundary insight",
      ]));
      expect(insights).toHaveLength(2);
      expect(insights.map((insight) => insight.content)).not.toContain("source passive capture old insight");
    } finally {
      await factory.close();
    }
  });
});
