import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import { promoteEventsForCwd, drainEventsForCwd } from "../../../src/daemon/routes/promote-events.js";
import { ensureProjectDir, projectDbPath, projectId } from "../../../src/daemon/project.js";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { eventsDbPath } from "../../../src/db/events-path.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { closeLcmConnection, getPoolStats } from "../../../src/db/connection.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { recoverMachineIdentity } from "../../../src/machine-identity.js";
import { adoptMigrationReceiptEpoch, readMigrationReceiptEvidence } from "../../../src/migration/receipts.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import { clearProjectMapCache } from "../../../src/project-map.js";

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


const roots: string[] = [];
const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
afterEach(() => {
  closeLcmConnection(); clearProjectMapCache(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(epoch: boolean, pattern = false, seedEvent = true) {
  const home = mkdtempSync(join(tmpdir(), "lcm-promotion-admission-"));
  roots.push(home);
  vi.stubEnv("HOME", home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const cwd = join(home, "project"); mkdirSync(cwd, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", cwd]);
  ensureProjectDir(cwd);
  const path = projectDbPath(cwd);
  const db = new DatabaseSync(path); runLcmMigrations(db);
  if (epoch) {
    recoverMachineIdentity({ version: 1, identityKey: `machine:${"d".repeat(64)}`,
      machineId, displayName: "Fixture" }, { homeDir: home });
    adoptMigrationReceiptEpoch(db, { projectId: projectId(cwd), machineId,
      epochId: "418f22c4-6d2a-4f10-8a4c-6b8d3e5f9012",
      firstMachineSequence: "0000000000000000000", establishedAt: "2026-09-07T03:04:05.123456Z" });
  }
  db.close();
  const sidecar = eventsDbPath(cwd);
  const events = new EventsDb(sidecar);
  if (seedEvent) {
    events.insertEvent("session", { type: pattern ? "file_read" : "decision", category: pattern ? "file" : "decision",
      data: "Use explicit current publication authority for durable queue acknowledgement", priority: pattern ? 3 : 1 }, "PostToolUse");
  }
  events.close();
  return { home, cwd, path, sidecar };
}
function snapshot(f: ReturnType<typeof fixture>, epoch: boolean) {
  const db = new DatabaseSync(f.path, { readOnly: true });
  const effects = new PromotedStore(db).getAll();
  const receipts = epoch ? readMigrationReceiptEvidence(db, projectId(f.cwd), machineId).receipts : [];
  db.close();
  const events = new EventsDb(f.sidecar);
  const pending = events.getUnprocessed(); events.close();
  return { effects, receipts, pending };
}
function sidecarState(sidecar: string) {
  const db = new DatabaseSync(sidecar, { readOnly: true });
  try {
    return {
      events: db.prepare(`
        SELECT event_id, data, prev_event_id, processed_at, delivery_state
        FROM events
        ORDER BY event_id
      `).all(),
      missingCwd: db.prepare(`
        SELECT observations, last_observed_at, parked_at
        FROM missing_cwd_state
      `).all(),
    };
  } finally {
    db.close();
  }
}
function expectReleased(home: string): void {
  expect(getPoolStats().connections.filter(connection => connection.path.startsWith(home)))
    .toEqual([]);
}

describe("canonical promotion publication admission", () => {
  it.each([
    { name: "promotion", promote: promoteEventsForCwd, epoch: false },
    { name: "promotion", promote: promoteEventsForCwd, epoch: true },
    { name: "drain", promote: drainEventsForCwd, epoch: false },
    { name: "drain", promote: drainEventsForCwd, epoch: true },
  ])("acknowledges $name under ordinary operation admission (epoch=$epoch)", async ({ promote, epoch }) => {
    const f = fixture(epoch);
    const context = { withPublicationAdmission: <T>(operation: (token: object) => Promise<T>) =>
      withBackendPublicationConsumerLockAsync(f.home, operation) };
    const first = await promote(makeConfig(), f.cwd, f.sidecar, undefined, undefined, context);
    expect(first).toMatchObject({ promoted: 1, errors: 0 });
    expectReleased(f.home);
    const before = snapshot(f, epoch);
    expect(before.effects).toHaveLength(1);
    expect(before.pending).toEqual([]);
    if (epoch) expect(before.receipts).toMatchObject([{ outcome: "applied",
      effectWitness: { promotedMemoryId: before.effects[0].id } }]);
    const again = await promote(makeConfig(), f.cwd, f.sidecar, undefined, undefined, context);
    expect(again).toMatchObject({ promoted: 0, errors: 0 });
    expect(snapshot(f, epoch)).toEqual(before);
    expectReleased(f.home);
  });

  it("prepares reinforcement under retained authority and records a no-effect receipt", async () => {
    const f = fixture(true, true);
    const result = await withBackendPublicationConsumerLockAsync(f.home,
      token => promoteEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, undefined, { publicationLockToken: token }));
    expect(result).toMatchObject({ promoted: 0, skipped: 1, errors: 0 });
    expectReleased(f.home);
    const state = snapshot(f, true);
    expect(state.pending).toEqual([]); expect(state.effects).toEqual([]);
    expect(state.receipts).toMatchObject([{ outcome: "no-effect", effectWitness: { reason: "unreinforced-pattern" } }]);
  });

  it.each([false, true])("retains explicit consumer authority through preparation and close (epoch=%s)", async epoch => {
    const f = fixture(epoch);
    const first = await withBackendPublicationConsumerLockAsync(f.home,
      token => promoteEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, token));
    expect(first).toMatchObject({ promoted: 1, errors: 0 });
    expectReleased(f.home);
    const before = snapshot(f, epoch);
    expect(before.effects).toHaveLength(1); expect(before.pending).toEqual([]);
    if (epoch) expect(before.receipts).toMatchObject([{ outcome: "applied" }]);
    const repeated = await withBackendPublicationConsumerLockAsync(f.home,
      token => drainEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, undefined, { publicationLockToken: token }));
    expect(repeated).toMatchObject({ promoted: 0, errors: 0 });
    expect(snapshot(f, epoch)).toEqual(before);
    expectReleased(f.home);
  });

  it("parks after three retained-token observations without changing queued events", async () => {
    const f = fixture(false);
    const before = sidecarState(f.sidecar).events;
    rmSync(f.cwd, { recursive: true, force: true });
    let observedAt = Date.UTC(2026, 0, 1);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => observedAt);

    try {
      const observe = () => withBackendPublicationConsumerLockAsync(
        f.home,
        token => drainEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, token),
      );
      await expect(observe()).resolves.toMatchObject({
        deferred: { observations: 1, retryAfterMs: 5 * 60 * 1000 },
      });
      observedAt += 5 * 60 * 1000;
      await expect(observe()).resolves.toMatchObject({
        deferred: { observations: 2, retryAfterMs: 5 * 60 * 1000 },
      });
      observedAt += 5 * 60 * 1000;
      await expect(observe()).resolves.toMatchObject({
        terminal: { kind: "parked", reason: "unavailable-cwd" },
      });
    } finally {
      clock.mockRestore();
    }

    expect(sidecarState(f.sidecar)).toEqual({
      events: before,
      missingCwd: [{
        observations: 3,
        last_observed_at: Date.UTC(2026, 0, 1) + 10 * 60 * 1000,
        parked_at: expect.any(String),
      }],
    });
    expectReleased(f.home);
    await expect(withBackendPublicationConsumerLockAsync(f.home, async () => "released"))
      .resolves.toBe("released");
  }, 20_000);

  it("keeps context-only missing-CWD parking outside retained admission", async () => {
    const f = fixture(false);
    rmSync(f.cwd, { recursive: true, force: true });
    const withPublicationAdmission = vi.fn(<T>(operation: (token: object) => Promise<T>) =>
      withBackendPublicationConsumerLockAsync(f.home, operation));

    await expect(drainEventsForCwd(
      makeConfig(),
      f.cwd,
      undefined,
      undefined,
      undefined,
      { withPublicationAdmission },
    )).resolves.toMatchObject({ deferred: { observations: 1 } });

    expect(withPublicationAdmission).toHaveBeenCalledOnce();
    expect(sidecarState(f.sidecar).missingCwd).toMatchObject([{ observations: 1 }]);
    expectReleased(f.home);
  });

  it("closes retained-token parking when no sidecar exists", async () => {
    const f = fixture(false);
    rmSync(f.cwd, { recursive: true, force: true });
    const absentSidecar = join(f.home, ".lcm", "events", "absent.db");

    await expect(withBackendPublicationConsumerLockAsync(
      f.home,
      token => drainEventsForCwd(makeConfig(), f.cwd, absentSidecar, undefined, token),
    )).resolves.toMatchObject({
      terminal: { kind: "parked", reason: "unavailable-cwd" },
      message: "no sidecar events to park for unavailable cwd",
    });
    expectReleased(f.home);
  });

  it("preserves a missing-CWD observation failure after retained-token cleanup", async () => {
    const f = fixture(false);
    rmSync(f.cwd, { recursive: true, force: true });
    const failure = new Error("missing-CWD observation failed");
    const observe = vi.spyOn(EventsDb.prototype, "observeMissingCwd")
      .mockImplementationOnce(() => { throw failure; });

    try {
      await expect(withBackendPublicationConsumerLockAsync(
        f.home,
        token => drainEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, token),
      )).rejects.toBe(failure);
    } finally {
      observe.mockRestore();
    }
    expectReleased(f.home);
    await expect(withBackendPublicationConsumerLockAsync(f.home, async () => "released"))
      .resolves.toBe("released");
  }, 15_000);

  it("correlates and acknowledges a pair under operation-scoped admission", async () => {
    const f = fixture(false, false, false);
    const events = new EventsDb(f.sidecar);
    const errorId = events.insertEvent(
      "correlated",
      { type: "error_tool", category: "error", data: "Bash error: npm install", priority: 1 },
      "PostToolUse",
    );
    const fixId = events.insertEvent(
      "correlated",
      { type: "env_install", category: "env", data: "npm install --legacy-peer-deps", priority: 2 },
      "PostToolUse",
    );
    events.close();
    const withPublicationAdmission = <T>(operation: (token: object) => Promise<T>) =>
      withBackendPublicationConsumerLockAsync(f.home, token => operation(token));
    const context = { withPublicationAdmission };

    const first = await promoteEventsForCwd(
      makeConfig(),
      f.cwd,
      f.sidecar,
      undefined,
      undefined,
      context,
    );
    expect(first).toMatchObject({ promoted: 2, correlated: 1, errors: 0 });
    expectReleased(f.home);
    const beforeRetry = {
      promoted: snapshot(f, false).effects,
      sidecar: sidecarState(f.sidecar),
    };
    expect(beforeRetry.promoted).toHaveLength(2);
    expect(beforeRetry.sidecar.events).toEqual([
      expect.objectContaining({ event_id: errorId, prev_event_id: null, processed_at: expect.any(String) }),
      expect.objectContaining({ event_id: fixId, prev_event_id: errorId, processed_at: expect.any(String) }),
    ]);
    expect(snapshot(f, false).pending).toEqual([]);

    await expect(promoteEventsForCwd(
      makeConfig(),
      f.cwd,
      f.sidecar,
      undefined,
      undefined,
      context,
    )).resolves.toMatchObject({ promoted: 0, correlated: 0, errors: 0 });
    expect({ promoted: snapshot(f, false).effects, sidecar: sidecarState(f.sidecar) })
      .toEqual(beforeRetry);
    expectReleased(f.home);
  });
});
