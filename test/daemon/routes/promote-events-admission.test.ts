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
function fixture(epoch: boolean, pattern = false) {
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
  events.insertEvent("session", { type: pattern ? "file_read" : "decision", category: pattern ? "file" : "decision",
    data: "Use explicit current publication authority for durable queue acknowledgement", priority: pattern ? 3 : 1 }, "PostToolUse");
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
});
