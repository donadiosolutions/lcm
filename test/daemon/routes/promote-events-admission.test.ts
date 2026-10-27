import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import { createPromoteAllEventsHandler, promoteEventsForCwd, drainEventsForCwd, parkUnavailableCwdEvents } from "../../../src/daemon/routes/promote-events.js";
import { ensureProjectDir, projectDbPath, projectId } from "../../../src/daemon/project.js";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { eventsDbPath, eventsDir, existingEventsDbPath, SidecarIdentityConflictError } from "../../../src/db/events-path.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { closeLcmConnection, getPoolStats } from "../../../src/db/connection.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { recoverMachineIdentity } from "../../../src/machine-identity.js";
import { adoptMigrationReceiptEpoch, readMigrationReceiptEvidence } from "../../../src/migration/receipts.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectIdentityPath,
  projectMapPath,
  removeProjectAlias,
  renewRetiredProjectIdentity,
  resolveProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../../../src/project-map.js";
import { serializeWorktreeReconciliationFence } from "../../../src/worktree-reconciliation-fence.js";

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

function retiredSidecarFixture(eventCount = 1) {
  const home = mkdtempSync(join(tmpdir(), "lcm-promotion-retired-"));
  roots.push(home);
  vi.stubEnv("HOME", home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const oldId = resolveProjectIdentity(cwd).id;
  const sidecar = eventsDbPath(cwd);
  const events = new EventsDb(sidecar);
  for (let index = 0; index < eventCount; index++) {
    events.insertEvent(`session-${index}`, {
      type: "decision", category: "decision", data: `retired identity event ${index}`, priority: 1,
    }, "PostToolUse");
  }
  events.close();
  const projects = join(home, ".lcm", "projects");
  mkdirSync(projects, { mode: 0o700 });
  writeFileSync(join(projects, oldId), serializeWorktreeReconciliationFence(oldId, "project"), { mode: 0o600 });
  const newId = retiredProjectIdentitySuccessor(oldId, normalizeProjectIdentityPath(cwd));
  return { home, cwd, sidecar, oldId, newId };
}

describe("canonical promotion publication admission", () => {
  it("refuses a legal retired-ID renewal between selection and destination admission", async () => {
    const f = retiredSidecarFixture();
    const before = sidecarState(f.sidecar);
    let admissions = 0;
    const context = {
      withPublicationAdmission: <T>(operation: (token: object) => Promise<T> | T) => {
        admissions++;
        if (admissions === 3) {
          expect(renewRetiredProjectIdentity(f.cwd)).toMatchObject({ changed: true, newId: f.newId });
        }
        return withBackendPublicationConsumerLockAsync(f.home, operation);
      },
    };

    await expect(promoteEventsForCwd(makeConfig(), f.cwd, f.sidecar, undefined, undefined, context))
      .rejects.toBeInstanceOf(SidecarIdentityConflictError);
    expect(admissions).toBeGreaterThanOrEqual(4);
    expect(sidecarState(f.sidecar)).toEqual(before);
    expect(existsSync(join(f.home, ".lcm", "projects", f.newId, "db.sqlite"))).toBe(false);
    expectReleased(f.home);
  });

  it("rechecks an alias removal before the second drain batch", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-promotion-alias-transition-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const canonical = join(home, "canonical");
    const alias = join(home, "alias");
    mkdirSync(canonical);
    mkdirSync(alias);
    const oldId = resolveProjectIdentity(canonical).id;
    addProjectAlias(alias, { canonical });
    const sidecar = eventsDbPath(alias);
    const events = new EventsDb(sidecar);
    for (let index = 0; index < 501; index++) {
      events.insertEvent(`session-${index}`, {
        type: "decision", category: "decision", data: `alias event ${index}`, priority: 1,
      }, "PostToolUse");
    }
    events.close();
    let admissions = 0;
    const context = {
      withPublicationAdmission: <T>(operation: (token: object) => Promise<T> | T) => {
        admissions++;
        if (admissions === 6) {
          expect(removeProjectAlias(alias, { canonical })).toMatchObject({ removed: true });
        }
        return withBackendPublicationConsumerLockAsync(home, operation);
      },
    };

    await expect(drainEventsForCwd(makeConfig(), alias, sidecar, undefined, undefined, context))
      .rejects.toBeInstanceOf(SidecarIdentityConflictError);
    expect(admissions).toBeGreaterThanOrEqual(7);
    const state = sidecarState(sidecar);
    expect(state.events.filter(event => event.processed_at !== null)).toHaveLength(500);
    expect(state.events.filter(event => event.processed_at === null)).toHaveLength(1);
    const newId = hashProjectPath(normalizeProjectIdentityPath(alias));
    expect(newId).not.toBe(oldId);
    expect(existsSync(join(home, ".lcm", "projects", newId, "db.sqlite"))).toBe(false);
    expectReleased(home);
  }, 30_000);

  it("keeps recovered-cwd parking unchanged when its binding changes before retained admission", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-promotion-recovered-transition-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const canonical = join(home, "canonical");
    const alias = join(home, "alias");
    mkdirSync(canonical);
    mkdirSync(alias);
    resolveProjectIdentity(canonical);
    addProjectAlias(alias, { canonical });
    const sidecar = eventsDbPath(alias);
    const events = new EventsDb(sidecar);
    events.insertEvent("session", {
      type: "decision", category: "decision", data: "parked alias decision", priority: 1,
    }, "PostToolUse");
    events.observeMissingCwd(0, 0, 3);
    events.close();
    const before = sidecarState(sidecar);

    await expect(parkUnavailableCwdEvents(alias, sidecar, {
      _beforeRecoveredAdmissionForTesting: () => {
        expect(removeProjectAlias(alias, { canonical })).toMatchObject({ removed: true });
      },
    })).rejects.toBeInstanceOf(SidecarIdentityConflictError);
    expect(sidecarState(sidecar)).toEqual(before);

    addProjectAlias(alias, { canonical });
    await expect(parkUnavailableCwdEvents(alias, sidecar)).resolves.toMatchObject({
      message: "cwd recovered; cleared durable parking state",
    });
    expect(sidecarState(sidecar).missingCwd).toEqual([]);
    expect(sidecarState(sidecar).events).toEqual(before.events);
    expectReleased(home);
  });

  it("does not clear a parked sidecar when an existing cwd has an unauthenticated map owner", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-promotion-unauthenticated-map-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const sidecar = eventsDbPath(cwd);
    const events = new EventsDb(sidecar);
    events.insertEvent("session", {
      type: "decision", category: "decision", data: "preserve parked decision", priority: 1,
    }, "PostToolUse");
    events.observeMissingCwd(0, 0, 3);
    events.close();
    const before = sidecarState(sidecar);
    const bytes = readFileSync(sidecar);
    const unauthorizedId = "f".repeat(64);
    expect(unauthorizedId).not.toBe(hashProjectPath(cwd));
    writeFileSync(projectMapPath(), JSON.stringify({
      [unauthorizedId]: { canonical: cwd, aliases: [] },
    }), { mode: 0o600 });
    clearProjectMapCache();

    expect(existingEventsDbPath(cwd)).toBe(sidecar);
    await expect(parkUnavailableCwdEvents(cwd, sidecar))
      .rejects.toBeInstanceOf(SidecarIdentityConflictError);
    expect(sidecarState(sidecar)).toEqual(before);
    expect(readFileSync(sidecar)).toEqual(bytes);
    expectReleased(home);
  });

  it("preserves a deleted worktree's old sidecar when its cwd is reused, then recovers it", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-promotion-reused-cwd-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const primary = join(home, "primary");
    const linked = join(home, "linked");
    const admin = join(primary, ".git", "worktrees", "linked");
    mkdirSync(join(primary, ".git", "objects"), { recursive: true });
    mkdirSync(admin, { recursive: true });
    mkdirSync(linked);
    writeFileSync(join(primary, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(primary, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, "gitdir"), `${join(linked, ".git")}\n`);

    const oldSidecar = eventsDbPath(linked);
    const oldEvents = new EventsDb(oldSidecar);
    oldEvents.insertEvent("old", { type: "decision", category: "decision", data: "old worktree decision", priority: 1 }, "PostToolUse");
    oldEvents.close();
    const evidencePath = join(eventsDir(), `${hashProjectPath(linked)}.identity.json`);
    const evidenceBefore = readFileSync(evidencePath);
    rmSync(linked, { recursive: true, force: true });
    mkdirSync(linked);
    const newId = hashProjectPath(normalizeProjectIdentityPath(linked));
    const newSidecar = join(eventsDir(), `${newId}.db`);
    const newEvents = new EventsDb(newSidecar);
    newEvents.insertEvent("new", { type: "decision", category: "decision", data: "new project decision", priority: 1 }, "PostToolUse");
    newEvents.close();
    const oldBefore = sidecarState(oldSidecar);
    const newBefore = sidecarState(newSidecar);

    await expect(promoteEventsForCwd(makeConfig(), linked)).rejects.toBeInstanceOf(SidecarIdentityConflictError);
    await expect(drainEventsForCwd(makeConfig(), linked, oldSidecar)).rejects.toBeInstanceOf(SidecarIdentityConflictError);
    await expect(parkUnavailableCwdEvents(linked, oldSidecar)).rejects.toBeInstanceOf(SidecarIdentityConflictError);
    expect(sidecarState(oldSidecar)).toEqual(oldBefore);
    expect(sidecarState(newSidecar)).toEqual(newBefore);
    expect(readFileSync(evidencePath)).toEqual(evidenceBefore);
    expect(existsSync(projectMapPath())).toBe(false);
    expect(existsSync(join(home, ".lcm", "projects", newId, "db.sqlite"))).toBe(false);

    rmSync(linked, { recursive: true, force: true });
    await expect(parkUnavailableCwdEvents(linked, oldSidecar)).resolves.toMatchObject({
      deferred: { reason: "unavailable-cwd" },
    });
    mkdirSync(linked);
    writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
    await expect(parkUnavailableCwdEvents(linked, oldSidecar)).resolves.toMatchObject({
      message: "cwd recovered; cleared durable parking state",
    });
    expect(sidecarState(oldSidecar).missingCwd).toEqual([]);
    expect(sidecarState(oldSidecar).events).toEqual(oldBefore.events);
  });

  it("scans a stale old-schema worktree sidecar without repairing it before global refusal", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-promotion-all-stale-schema-"));
    roots.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const primary = join(home, "primary");
    const linked = join(home, "linked");
    const admin = join(primary, ".git", "worktrees", "linked");
    mkdirSync(join(primary, ".git", "objects"), { recursive: true });
    mkdirSync(admin, { recursive: true });
    mkdirSync(linked);
    writeFileSync(join(primary, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(primary, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, "gitdir"), `${join(linked, ".git")}\n`);
    const oldId = hashProjectPath(normalizeProjectIdentityPath(primary));
    const oldSidecar = eventsDbPath(linked);
    const oldEvents = new EventsDb(oldSidecar);
    oldEvents.insertEvent("old", {
      type: "decision", category: "decision", data: "old worktree decision", priority: 1,
    }, "PostToolUse");
    oldEvents.close();

    rmSync(linked, { recursive: true, force: true });
    mkdirSync(linked);
    expect(resolveProjectIdentity(linked).id).not.toBe(oldId);
    const oldProject = join(home, ".lcm", "projects", oldId);
    mkdirSync(oldProject, { recursive: true, mode: 0o700 });
    writeFileSync(join(oldProject, "meta.json"), JSON.stringify({ cwd: linked }), { mode: 0o600 });
    const legacy = new DatabaseSync(oldSidecar);
    legacy.exec("DROP TABLE missing_cwd_state");
    legacy.prepare("UPDATE schema_version SET version = 4").run();
    legacy.close();
    const bytesBefore = readFileSync(oldSidecar);

    let responseBody = "";
    const response = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn((body: string) => { responseBody = body; }),
    } as unknown as ServerResponse;
    await createPromoteAllEventsHandler(makeConfig())({} as IncomingMessage, response, "");
    const result = JSON.parse(responseBody) as {
      failedProjects: number;
      projects: Array<{ message?: string }>;
    };
    expect(result.failedProjects).toBe(1);
    expect(result.projects[0]?.message).toBe("sidecar identity does not match the current project");
    expect(readFileSync(oldSidecar)).toEqual(bytesBefore);
    const retained = new DatabaseSync(oldSidecar, { readOnly: true });
    expect(retained.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 4 });
    expect(retained.prepare("SELECT name FROM sqlite_master WHERE name = 'missing_cwd_state'").get())
      .toBeUndefined();
    expect(retained.prepare("SELECT COUNT(*) AS pending FROM events WHERE processed_at IS NULL").get())
      .toEqual({ pending: 1 });
    retained.close();
    expectReleased(home);
  });

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

    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
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
