import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventsDb } from "../../../src/hooks/events-db.js";
import {
  createPromoteAllEventsHandler,
  createPromoteEventsHandler,
  drainEventsForCwd,
  parkUnavailableCwdEvents,
  promoteEventsForCwd,
} from "../../../src/daemon/routes/promote-events.js";
import { ensureProjectDir, projectDbPath, projectId } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../../src/storage/factory.js";
import { recoverMachineIdentity } from "../../../src/machine-identity.js";
import {
  clearProjectMapCache,
  resolveProjectIdentity,
  setRemoteProjectBinding,
} from "../../../src/project-map.js";

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const PROMOTION_DRAIN_TIMEOUT_MS = 15_000;
const FORCED_WRAPPER_TIMEOUT_MS = 1;

const eventPathMocks = vi.hoisted(() => ({
  eventsDir: vi.fn(),
}));

// Mock eventsDbPath to point at our temp dir
vi.mock("../../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn(),
  eventsDir: eventPathMocks.eventsDir,
}));

// Mock deduplicateAndInsert to track calls without needing real FTS5
vi.mock("../../../src/promotion/dedup.js", () => ({
  deduplicateAndInsert: vi.fn().mockResolvedValue("mock-id"),
}));

// Import the mocked modules
import { eventsDbPath } from "../../../src/db/events-path.js";
import { deduplicateAndInsert } from "../../../src/promotion/dedup.js";

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    storage: { backend: "sqlite" },
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
      promotionThresholds: {
        minDepth: 1,
        compressionRatio: 0.1,
        keywords: { decision: ["decided"] },
        architecturePatterns: [],
        dedupBm25Threshold: 15,
        dedupCandidateLimit: 100,
        eventConfidence: {
          decision: 0.5,
          plan: 0.7,
          errorFix: 0.4,
          batch: 0.3,
          pattern: 0.2,
        },
        reinforcementBoost: 0.3,
        maxConfidence: 1,
        insightsMaxAgeDays: 90,
      },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: { provider: "disabled", model: "", apiKey: "", baseURL: "" },
    summarizer: { mock: true },
    security: { sensitivePatterns: [] },
    hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
  } as DaemonConfig;
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as unknown as ServerResponse;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

const request = {} as IncomingMessage;

function setupProjectDb(cwd: string): DatabaseSync {
  const dbPath = projectDbPath(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  return db;
}

function attemptCleanup(errors: unknown[], cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function throwCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

describe("promote-events route", () => {
  let dir: string;
  let homeDir: string;
  let sidecarPath: string;
  let extraDirs: string[];
  let originalHome: string | undefined;
  let startedPromotionOperations: Promise<unknown>[];

  function registerPromotionOperation<T>(operation: Promise<T>): Promise<T> {
    startedPromotionOperations.push(operation);
    return operation;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promote-events-test-"));
    homeDir = mkdtempSync(join(tmpdir(), "promote-events-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    sidecarPath = join(dir, "events.db");
    extraDirs = [];
    startedPromotionOperations = [];
    eventPathMocks.eventsDir.mockReturnValue(dir);
    vi.mocked(eventsDbPath).mockReturnValue(sidecarPath);
    vi.mocked(deduplicateAndInsert).mockClear();
    clearProjectMapCache();
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    const settled = await Promise.allSettled(startedPromotionOperations);
    for (const result of settled) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    startedPromotionOperations = [];

    attemptCleanup(cleanupErrors, () => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    });
    attemptCleanup(cleanupErrors, () => vi.clearAllMocks());
    attemptCleanup(cleanupErrors, () => clearProjectMapCache());
    attemptCleanup(cleanupErrors, () => rmSync(dir, { recursive: true, force: true }));
    attemptCleanup(cleanupErrors, () => rmSync(homeDir, { recursive: true, force: true }));
    for (const extraDir of extraDirs) {
      attemptCleanup(cleanupErrors, () => rmSync(extraDir, { recursive: true, force: true }));
    }

    throwCleanupErrors(cleanupErrors, "promote-events test cleanup failed");
  }, Number.POSITIVE_INFINITY);

  it("promotes priority 1 events via deduplicateAndInsert", async () => {
    let transactionRepositories: unknown;
    vi.mocked(deduplicateAndInsert).mockImplementationOnce(async (input) => {
      if (!("transaction" in input)) throw new Error("expected repository transaction");
      return input.transaction(async (repositories) => {
        transactionRepositories = repositories;
        return "mock-id";
      });
    });

    // Seed sidecar with a decision event
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "use SQLite", priority: 1 }, "PostToolUse");
    edb.close();

    // Set up project DB so PromotedStore can be constructed
    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(1);
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(1);

    // Verify it was called with decision confidence
    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call).not.toHaveProperty("promotedMemory");
    expect(call).not.toHaveProperty("lexicalSearch");
    expect(call.transaction).toEqual(expect.any(Function));
    expect(transactionRepositories).toMatchObject({
      promotedMemory: expect.any(Object),
      lexicalSearch: expect.any(Object),
    });
    expect(call.confidence).toBe(0.5);
    expect(call.tags).toContain("type:preference");
    expect(call.tags).toContain("source:passive-capture");
  });

  it("scrubs legacy sidecar secrets before promotion", async () => {
    const secret = `sk-${"a".repeat(24)}`;
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: `always use ${secret}`, priority: 1 }, "UserPromptSubmit");
    edb.close();
    setupProjectDb(dir).close();
    const handler = createPromoteEventsHandler(makeConfig());
    const { res } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));
    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call.content).toContain("[REDACTED]");
    expect(call.content).not.toContain(secret);
  });

  it("correlates error→fix pairs within session", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "error_tool", category: "error", data: "Bash error: npm install", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "env_install", category: "env", data: "npm install --legacy-peer-deps", priority: 2 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    // Both events should be promoted
    expect(result.promoted).toBeGreaterThanOrEqual(2);
    expect(result.correlated).toBeGreaterThanOrEqual(1);
  });

  it("marks all events as processed after promotion", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    // Re-open events DB and check that nothing is unprocessed
    const edb2 = new EventsDb(sidecarPath);
    const remaining = edb2.getUnprocessed();
    edb2.close();
    expect(remaining).toHaveLength(0);
  });

  it("parks events for a deleted cwd without deleting their historical or delivery rows", async () => {
    const deletedCwd = join(dir, "deleted-project");
    mkdirSync(deletedCwd);
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "retain this event", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "git", category: "git", data: "retain this delivery", priority: 2 }, "PostToolUse");
    edb.close();
    rmSync(deletedCwd, { recursive: true, force: true });

    const result = await promoteEventsForCwd(makeConfig(), deletedCwd);

    expect(result).toMatchObject({
      promoted: 0,
      skipped: 2,
      correlated: 0,
      errors: 0,
      terminal: { kind: "parked", reason: "unavailable-cwd" },
      message: "parked 2 events because cwd is unavailable",
    });
    expect(vi.mocked(deduplicateAndInsert)).not.toHaveBeenCalled();

    const reopened = new EventsDb(sidecarPath);
    expect(reopened.getUnprocessed()).toHaveLength(0);
    expect(reopened.getHealthStats()).toMatchObject({
      totalEvents: 2,
      errors: 0,
      deliveryPending: 2,
    });
    reopened.close();
  });

  it("parks deleted-cwd events through a full drain without entering retry state", async () => {
    const deletedCwd = join(dir, "deleted-drain-project");
    mkdirSync(deletedCwd);
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "drain and retain", priority: 1 }, "PostToolUse");
    edb.close();
    rmSync(deletedCwd, { recursive: true, force: true });

    const result = await drainEventsForCwd(makeConfig(), deletedCwd, sidecarPath);

    expect(result).toMatchObject({
      batches: 0,
      promoted: 0,
      skipped: 1,
      errors: 0,
      terminal: { kind: "parked", reason: "unavailable-cwd" },
      message: "parked 1 events because cwd is unavailable",
    });
    const reopened = new EventsDb(sidecarPath);
    expect(reopened.getUnprocessed()).toHaveLength(0);
    expect(reopened.getHealthStats().totalEvents).toBe(1);
    reopened.close();
  });

  it("does not create a sidecar when there is nothing durable to park", async () => {
    const deletedCwd = join(dir, "deleted-without-sidecar");
    const missingSidecar = join(dir, "not-created.db");

    await expect(parkUnavailableCwdEvents(deletedCwd, missingSidecar)).resolves.toMatchObject({
      promoted: 0,
      skipped: 0,
      errors: 0,
      message: "no sidecar events to park for unavailable cwd",
    });
    expect(existsSync(missingSidecar)).toBe(false);
  });

  it("reports an already-empty sidecar without changing its terminal state", async () => {
    const deletedCwd = join(dir, "deleted-empty-sidecar");
    const emptySidecar = join(dir, "empty.db");
    new EventsDb(emptySidecar).close();

    await expect(parkUnavailableCwdEvents(deletedCwd, emptySidecar)).resolves.toMatchObject({
      promoted: 0,
      skipped: 0,
      errors: 0,
      message: "no unprocessed events",
    });
  });

  it("does not park a cwd that still exists but is not a directory", async () => {
    const fileCwd = join(dir, "project-file");
    writeFileSync(fileCwd, "not a directory");

    await expect(promoteEventsForCwd(makeConfig(), fileCwd, sidecarPath))
      .rejects.toThrow("cwd must be a directory");
    await expect(drainEventsForCwd(makeConfig(), fileCwd, sidecarPath))
      .rejects.toThrow("cwd must be a directory");
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("serializes concurrent promotion attempts for the same sidecar", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "serialize this event", priority: 1 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    await Promise.all([
      promoteEventsForCwd(makeConfig(), dir),
      promoteEventsForCwd(makeConfig(), dir),
    ]);

    expect(deduplicateAndInsert).toHaveBeenCalledTimes(1);
    const remainingDb = new EventsDb(sidecarPath);
    const remaining = remainingDb.getUnprocessed();
    remainingDb.close();
    expect(remaining).toHaveLength(0);
  });

  it("bootstraps repeated priority 3 file patterns without a seeded memory", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s2", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s2", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const reinforcementSpy = vi.spyOn(EventsDb.prototype, "getPatternReinforcement");
    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(3);
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(3);
    expect(reinforcementSpy).toHaveBeenCalledTimes(1);

    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call.confidence).toBe(0.2);
    expect(call.newEntryConfidence).toBe(0.5);
    expect(call.tags).toContain("signal:reinforced");
    expect(call.tags).toContain("type:pattern");
  });

  it("does not bootstrap repeated priority 3 patterns from a single session burst", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(3);
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  it("is idempotent — skips already-processed events", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "test", priority: 1 }, "PostToolUse");
    const events = edb.getUnprocessed();
    edb.markProcessed([events[0].event_id]);
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.message).toBe("no unprocessed events");
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when cwd is missing", async () => {
    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, JSON.stringify({}));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody().error).toBe("cwd is required");
    const emptyBody = mockRes();
    await handler(request, emptyBody.res, "");
    expect(emptyBody.getBody().error).toBe("cwd is required");
  });

  it("returns generic errors for invalid cwd and sidecar failures", async () => {
    const handler = createPromoteEventsHandler(makeConfig());
    const invalid = mockRes();
    await handler(request, invalid.res, JSON.stringify({ cwd: join(dir, "missing") }));
    expect(invalid.getBody()).toEqual({ error: "cwd is invalid" });

    writeFileSync(sidecarPath, "not sqlite");
    const failed = mockRes();
    await handler(request, failed.res, JSON.stringify({ cwd: dir }));
    expect(failed.res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(failed.getBody()).toEqual({ error: "failed to promote events" });
  });

  it("stops a drain when all remaining promotions fail", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "retry me", priority: 1 }, "PostToolUse");
    edb.close();
    setupProjectDb(dir).close();
    vi.mocked(deduplicateAndInsert).mockRejectedValueOnce(new Error("transient"));

    const result = await drainEventsForCwd(makeConfig(), dir);
    expect(result).toMatchObject({ batches: 1, incomplete: true, errors: 1, message: "stopped because remaining events failed to promote" });
  });

  it("covers confidence defaults, tier variants, correlation guards, and existing pattern matches", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "error", category: "error", data: "error without separator", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "error", category: "error", data: "command: fixme broken", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "plan", category: "plan", data: "plan fixme now", priority: 1 }, "PostToolUse");
    edb.insertEvent("s2", { type: "git", category: "git", data: "batch workflow", priority: 2 }, "PostToolUse");
    edb.insertEvent("s3", { type: "custom", category: "custom", data: "custom pattern", priority: 3 }, "PostToolUse");
    edb.insertEvent("s4", { type: "file_read", category: "file", data: "known pattern", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    new PromotedStore(db).insert({ content: "known pattern", tags: [], projectId: projectId(dir) });
    db.close();

    const config = makeConfig();
    config.compaction.promotionThresholds.eventConfidence = undefined;
    config.compaction.promotionThresholds.dedupBm25Threshold = undefined;
    config.compaction.promotionThresholds.dedupCandidateLimit = undefined;
    config.compaction.promotionThresholds.insightsMaxAgeDays = undefined;
    config.compaction.promotionThresholds.maxConfidence = undefined;
    config.compaction.promotionThresholds.reinforcementBoost = undefined;
    const result = await promoteEventsForCwd(config, dir);
    expect(result.promoted).toBeGreaterThanOrEqual(5);
    expect(vi.mocked(deduplicateAndInsert).mock.calls.some(([input]) => input.thresholds.dedupBm25Threshold === 15)).toBe(true);
  });

  it("reports a global project whose drain throws", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "promote-all-throw-"));
    extraDirs.push(projectCwd);
    const path = join(dir, `${projectId(projectCwd)}.db`);
    ensureProjectDir(projectCwd);
    const edb = new EventsDb(path);
    edb.insertEvent("s", { type: "decision", category: "decision", data: "throw", priority: 1 }, "PostToolUse");
    edb.close();
    setupProjectDb(projectCwd).close();
    const getUnprocessed = vi.spyOn(EventsDb.prototype, "getUnprocessed").mockImplementationOnce(() => {
      throw new Error("sidecar read failed");
    });
    try {
      const output = mockRes();
      await createPromoteAllEventsHandler(makeConfig())(request, output.res, "");
      expect(output.getBody()).toMatchObject({ failedProjects: 1, errors: 1 });
    } finally {
      getUnprocessed.mockRestore();
    }
  });

  it("returns the exact staged response for a discovered PostgreSQL project", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "promote-all-staged-"));
    extraDirs.push(projectCwd);
    const projectSidecarPath = join(dir, `${projectId(projectCwd)}.db`);
    ensureProjectDir(projectCwd);
    const edb = new EventsDb(projectSidecarPath);
    edb.insertEvent(
      "s1",
      { type: "decision", category: "decision", data: "retain locally", priority: 1 },
      "UserPromptSubmit",
    );
    edb.close();
    const local = resolveProjectIdentity(projectCwd);
    setRemoteProjectBinding(PROJECT_ID, { hash: local.id });
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    }, { homeDir });
    const config = makeConfig();
    config.storage = {
      backend: "postgresql",
      url: "postgresql://example.invalid/lcm",
      poolMax: 1,
      connectionTimeoutMs: 100,
      idleTimeoutMs: 100,
      statementTimeoutMs: 100,
    };

    const output = mockRes();
    await createPromoteAllEventsHandler(
      config,
      new UnavailablePostgreSqlStorageBackendFactory(),
    )(request, output.res, "");

    expect(output.res.writeHead).toHaveBeenCalledWith(
      503,
      { "Content-Type": "application/json" },
    );
    expect(output.getBody()).toEqual({
      code: "STORAGE_BACKEND_STAGED",
      error: "promote-events-all is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    });
  });

  it("returns the exact staged response before scanning an empty sidecar directory", async () => {
    const output = mockRes();
    await createPromoteAllEventsHandler(
      makeConfig(),
      new UnavailablePostgreSqlStorageBackendFactory(),
    )(request, output.res, "");

    expect(output.res.writeHead).toHaveBeenCalledWith(
      503,
      { "Content-Type": "application/json" },
    );
    expect(output.getBody()).toEqual({
      code: "STORAGE_BACKEND_STAGED",
      error: "promote-events-all is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    });
  });

  it("promotes metadata-backed sidecars across all projects", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "promote-all-project-"));
    extraDirs.push(projectCwd);
    const projectSidecarPath = join(dir, `${projectId(projectCwd)}.db`);
    ensureProjectDir(projectCwd);
    vi.mocked(eventsDbPath).mockImplementation((cwd: string) =>
      cwd === projectCwd ? projectSidecarPath : sidecarPath
    );

    const edb = new EventsDb(projectSidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "promote globally", priority: 1 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(projectCwd);
    db.close();

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, "");

    const result = getBody();
    expect(result.scanned).toBe(1);
    expect(result.sidecarsWithUnprocessed).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.processedProjects).toBe(1);
    expect(result.orphanedProjects).toBe(0);
    expect(result.projects[0].cwd).toBe(projectCwd);
  });

  it("drains the sidecar path found during the scan", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "promote-all-scanned-sidecar-"));
    extraDirs.push(projectCwd);
    const scannedSidecarPath = join(dir, `${projectId(projectCwd)}.db`);
    const recomputedSidecarPath = join(dir, "recomputed.db");
    ensureProjectDir(projectCwd);
    vi.mocked(eventsDbPath).mockImplementation((cwd: string) =>
      cwd === projectCwd ? recomputedSidecarPath : sidecarPath
    );

    const edb = new EventsDb(scannedSidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "use scanned sidecar", priority: 1 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(projectCwd);
    db.close();

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, "");

    const result = getBody();
    expect(result.promoted).toBe(1);
    const remainingDb = new EventsDb(scannedSidecarPath);
    const remaining = remainingDb.getUnprocessed();
    remainingDb.close();
    expect(remaining).toHaveLength(0);
    expect(existsSync(recomputedSidecarPath)).toBe(false);
  });

  it("reports sidecars skipped by the global scan budget", async () => {
    const firstSidecarPath = join(dir, "a-project.db");
    const secondSidecarPath = join(dir, "b-project.db");

    const firstDb = new EventsDb(firstSidecarPath);
    firstDb.close();
    const secondDb = new EventsDb(secondSidecarPath);
    secondDb.close();

    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(30_001);

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    try {
      await handler(request, res, "");
    } finally {
      now.mockRestore();
    }

    const result = getBody();
    expect(result.scanned).toBe(2);
    expect(result.failedProjects).toBe(1);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectId).toBe("b-project");
    expect(result.projects[0].incomplete).toBe(true);
    expect(result.projects[0].message).toContain("sidecar scan skipped");
  });

  it("drains every batch from metadata-backed sidecars during global promotion", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "promote-all-large-project-"));
    extraDirs.push(projectCwd);
    const projectSidecarPath = join(dir, `${projectId(projectCwd)}.db`);
    ensureProjectDir(projectCwd);
    vi.mocked(eventsDbPath).mockImplementation((cwd: string) =>
      cwd === projectCwd ? projectSidecarPath : sidecarPath
    );

    const edb = new EventsDb(projectSidecarPath);
    // 501 events exceeds the default 500-event sidecar fetch batch.
    for (let i = 0; i < 501; i++) {
      edb.insertEvent("s1", { type: "decision", category: "decision", data: `global backlog ${i}`, priority: 1 }, "PostToolUse");
    }
    edb.close();

    const db = setupProjectDb(projectCwd);
    db.close();

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    const operation = registerPromotionOperation(handler(request, res, ""));
    await operation;

    const result = getBody();
    expect(result.promoted).toBe(501);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].batches).toBe(2);
    expect(result.projects[0].message).toBe("drained all unprocessed events");
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(501);

    const remainingDb = new EventsDb(projectSidecarPath);
    const remaining = remainingDb.getUnprocessed();
    remainingDb.close();
    expect(remaining).toHaveLength(0);
  }, PROMOTION_DRAIN_TIMEOUT_MS);

  it("settles route work after a forced wrapper timeout", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent(
      "s1",
      { type: "decision", category: "decision", data: "forced wrapper timeout", priority: 1 },
      "PostToolUse",
    );
    edb.close();
    setupProjectDb(dir).close();

    const deduplicateMock = vi.mocked(deduplicateAndInsert);
    const originalImplementation = deduplicateMock.getMockImplementation();
    let markDeduplicateStarted!: () => void;
    const deduplicateStarted = new Promise<void>((resolve) => {
      markDeduplicateStarted = resolve;
    });
    let releaseDeduplicate!: () => void;
    const deduplicateReleased = new Promise<void>((resolve) => {
      releaseDeduplicate = resolve;
    });
    let operation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let primaryError: unknown;

    try {
      deduplicateMock.mockImplementation(async () => {
        markDeduplicateStarted();
        await deduplicateReleased;
        return "mock-id";
      });
      const handler = createPromoteEventsHandler(makeConfig());
      const { res } = mockRes();
      operation = registerPromotionOperation(
        handler(request, res, JSON.stringify({ cwd: dir, drain: true })),
      );
      await Promise.race([
        deduplicateStarted,
        operation.then(() => {
          throw new Error("promotion route settled before deferred deduplication started");
        }),
      ]);

      const forcedTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("forced wrapper timeout")), FORCED_WRAPPER_TIMEOUT_MS);
      });
      await expect(Promise.race([operation, forcedTimeout])).rejects.toThrow("forced wrapper timeout");
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupErrors: unknown[] = primaryError === undefined ? [] : [primaryError];
      if (timer !== undefined) attemptCleanup(cleanupErrors, () => clearTimeout(timer));
      attemptCleanup(cleanupErrors, () => releaseDeduplicate());
      if (operation !== undefined) {
        try {
          await operation;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      attemptCleanup(cleanupErrors, () => {
        if (originalImplementation === undefined) {
          deduplicateMock.mockReset();
        } else {
          deduplicateMock.mockImplementation(originalImplementation);
        }
      });
      throwCleanupErrors(cleanupErrors, "forced promotion timeout cleanup failed");
    }

    expect(deduplicateMock).toHaveBeenCalledTimes(1);
  });

  it("drains every batch from the current project when requested", async () => {
    const edb = new EventsDb(sidecarPath);
    // 501 events exceeds the default 500-event sidecar fetch batch.
    for (let i = 0; i < 501; i++) {
      edb.insertEvent("s1", { type: "decision", category: "decision", data: `current backlog ${i}`, priority: 1 }, "PostToolUse");
    }
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    const operation = registerPromotionOperation(
      handler(request, res, JSON.stringify({ cwd: dir, drain: true })),
    );
    await operation;

    const result = getBody();
    expect(result.promoted).toBe(501);
    expect(result.batches).toBe(2);
    expect(result.message).toBe("drained all unprocessed events");
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(501);

    const remainingDb = new EventsDb(sidecarPath);
    const remaining = remainingDb.getUnprocessed();
    remainingDb.close();
    expect(remaining).toHaveLength(0);
  }, PROMOTION_DRAIN_TIMEOUT_MS);

  it("reports orphan sidecars during global promotion", async () => {
    const orphanPath = join(dir, "orphan.db");
    const edb = new EventsDb(orphanPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "orphan", priority: 1 }, "PostToolUse");
    edb.close();

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, "");

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.orphanedProjects).toBe(1);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].metadataMissing).toBe(true);
    expect(result.projects[0].message).toBe("missing project metadata");
  });

  it("reports unreadable sidecars during global promotion", async () => {
    writeFileSync(join(dir, "corrupt.db"), "not a sqlite database");

    const handler = createPromoteAllEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler(request, res, "");

    const result = getBody();
    expect(result.scanned).toBe(1);
    expect(result.failedProjects).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].message).toBe("failed to scan sidecar");
  });
});
