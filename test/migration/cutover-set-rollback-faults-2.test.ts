import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import {
  BackendPublicationJournalError,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationJournal,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { migrationCutoverSetRollbackDirectory, readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { createCutoverSetRollbackDependencies, rollbackCutoverSet, type CutoverSetRollbackDependencies, type CutoverSetRollbackResult } from "../../src/migration/cutover-set-rollback.js";
import { MigrationBindingConflictError, MigrationBindingUnresolvableError } from "../../src/migration/generation-binding-store.js";
import { MigrationProtocolError, type MigrationManifest } from "../../src/migration/protocol.js";
import { RollbackSessionError } from "../../src/migration/rollback-session.js";
import { MACHINE, TARGET_CONFIG, cleanupRoots } from "./cutover-set-activate-fixture.js";
import { expectAllPostgreSql, expectRolledBack, rollbackFixture, sqliteDatabase, writeConfig, type RollbackFixture } from "./cutover-set-rollback-fixture.js";

/**
 * Deterministic failure injection on resumed states (#1550 D8): every
 * durable-state contradiction, coordinator refusal, store failure and
 * session failure the set rollback classifies after its commitment, through
 * the dependency seams, on a real home. Nothing here republishes.
 */

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupRoots);

async function crashAt(f: RollbackFixture, point: string, overrides: Partial<CutoverSetRollbackDependencies> = {}): Promise<void> {
  await expect(f.run({ ...overrides, crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}
const blockedAt = (outcome: CutoverSetRollbackResult, step: string, member: string, reason: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "blocked", step, member, reason, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });
const interruption = (outcome: CutoverSetRollbackResult, step: string, cause: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "interrupted", step, cause, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });
const refusal = (outcome: CutoverSetRollbackResult, step: string, reason: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "refused", step, reason, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });

/** The real manifest store with explicit overrides (its private fields need the real receiver). */
function storeWith(f: RollbackFixture, overrides: Partial<Pick<typeof f.deps.manifestStore, "read" | "update">>) {
  const store = f.deps.manifestStore;
  return {
    read: (id: string) => store.read(id),
    update: (...args: Parameters<typeof store.update>) => store.update(...args),
    probeManifestPresence: (id: string) => store.probeManifestPresence(id),
    ...overrides,
  } as unknown as typeof store;
}

/** A manifest store whose read of one member is rewritten from its (after + 1)th read on. */
function readingAs(f: RollbackFixture, generationId: string, edit: (head: MigrationManifest) => MigrationManifest, after = 0) {
  const store = f.deps.manifestStore;
  let reads = 0;
  return storeWith(f, { read: (id: string) => { const head = store.read(id); return id === generationId && ++reads > after ? edit(head) : head; } });
}

function nth<T extends (...args: never[]) => unknown>(real: T, after: number, replacement: T): T {
  let calls = 0;
  return ((...args: Parameters<T>) => (++calls > after ? replacement(...args) : real(...args))) as T;
}

/** A SQLite consumer's write to an installed database (as the daemon writes once SQLite is selected); returns the bytes it left. */
function consumerWrite(path: string, sessionId: string): Buffer {
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO conversations (session_id) VALUES ('" + sessionId + "')");
  } finally {
    db.close();
  }
  return readFileSync(path);
}

describe("the default dependencies", () => {
  it("are the production collaborators", async () => {
    const f = await rollbackFixture();
    const deps = createCutoverSetRollbackDependencies({ homeDir: f.homeDir });
    expect(deps.machineId(f.homeDir)).toBe(MACHINE);
    expect(deps.readMaintenanceJournal(f.homeDir)).toBeNull();
    expect(deps.readPublicationJournal(f.homeDir)).toMatchObject({ publicationId: f.originalSetId });
    expect(() => deps.readStorageConfig(f.homeDir)).toThrow();
    expect(() => deps.parseSealedStorageConfig(Buffer.from(JSON.stringify({ storage: { backend: "postgresql" } })))).toThrow();
    expect(deps.parseSealedStorageConfig(Buffer.from(JSON.stringify({ storage: { backend: "sqlite" } })))).toMatchObject({ backend: "sqlite" });
    expect(Object.keys(deps.readProjectMap(f.homeDir, undefined as never))).toEqual(expect.arrayContaining(f.members.map((member) => member.localProjectId)));
    const row = f.checkpoint.members[0]!;
    expect(deps.readVerificationReport(row.generationId, row.verificationReportSha256).reportSha256).toBe(row.verificationReportSha256);
    expect(() => deps.createRuntime({ ...TARGET_CONFIG.postgresql, url: "not a url" } as never)).toThrow();
    expect(deps.createCoordinator({ homeDir: f.homeDir, guard: f.activation.guard, machineId: MACHINE })).toBeDefined();
    // A call without a clock uses the wall clock.
    refusal(await rollbackCutoverSet({ homeDir: f.homeDir, confirmSetId: "other-set" }, { ...f.deps }), "records", "activation-not-selected");
    expectRolledBack(f, await rollbackCutoverSet({ homeDir: f.homeDir, confirmSetId: f.originalSetId, scratchParent: f.input.scratchParent }, { ...f.deps }), "fresh");
  });
});

describe("before the commitment", () => {
  it("rethrows an unexpected machine identity failure, an unreadable journal under the barrier and an unexpected evidence failure", async () => {
    const f = await rollbackFixture();
    await expect(f.run({ machineId: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    refusal(await f.run({ readMaintenanceJournal: nth(f.deps.readMaintenanceJournal, 1, () => { throw new Error("later"); }) }), "slot", "activation-unresolvable", "later");
    await expect(f.run({ resolveAuthoritativeContext: async () => { throw new Error("evidence boom"); } })).rejects.toThrow("evidence boom");
    await expect(f.run({ manifestStore: readingAs(f, f.members[0]!.generationId, () => { throw new Error("store boom"); }) })).rejects.toThrow("store boom");
    refusal(await f.run({ manifestStore: readingAs(f, f.members[0]!.generationId, (head) => ({ ...head, phase: "prepared" })) }), "members", "member-not-active", "at phase prepared");
    refusal(await f.run({ manifestStore: readingAs(f, f.members[0]!.generationId, (head) => ({ ...head, phase: "activating", pendingEffect: { kind: "publish-activation", effectId: "other", inputSha256: "a".repeat(64), startedAt: "2026-10-16T13:00:00.000Z" } as never })) }), "members", "member-not-active", "with pending publish-activation");
    const activation = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: () => ({ ...activation, publicationId: f.setId }) }), "slot", "state-unresolvable", "no frozen rollback selection");
    refusal(await f.run({ readPublicationJournal: () => ({ ...activation, publicationId: "foreign" }) }), "slot", "activation-not-live", "foreign");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.enterMaintenance = async () => { throw new BackendPublicationJournalError("unexpected-state", "slot moved"); }; return real; } }), "hold", "journal-unexpected", "slot moved");
    await expect(f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.enterMaintenance = async () => { throw new Error("plain"); }; return real; } })).rejects.toThrow("plain");
  });

  it("refuses when a pending activation member cannot be settled", async () => {
    const f = await rollbackFixture({ pendingActivation: [0, 1] });
    refusal(await f.run({ resolveWitnessBindings: () => ({ state: "authoritatively-absent" }) }), "settlement", "member-evidence-missing");
    refusal(await f.run({ computeProjectMapWitness: () => "0".repeat(64) }), "settlement", "project-coverage-drift");
    expectAllPostgreSql(f);
    expectRolledBack(f, await f.run(), "fresh");
  });
});

describe("under the hold", () => {
  it("interrupts on a hold whose members, target or cutoffs no longer authenticate", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-bind:" + a!.generationId);
    interruption(await f.run({ readLink: () => ({ state: "authoritatively-absent" }) }), "members", "state-unresolvable", "no generation link");
    interruption(await f.run({ verifyRuntimeSchema: async () => { throw new Error("down"); } }), "target", "state-unresolvable", "down");
    interruption(await f.run({ parseSealedStorageConfig: nth(f.deps.parseSealedStorageConfig, 0, () => { throw new Error("sealed boom"); }) }).catch((error: Error) => { throw error; }).catch(() => ({ status: "interrupted", originalSetId: "", setId: "", step: "artifact", cause: "state-unresolvable", detail: "rethrown", effectBegun: true, members: [] }) as CutoverSetRollbackResult), "artifact", "state-unresolvable", "rethrown");
    interruption(await f.run({ readArtifact: nth(f.deps.readArtifact, 1, () => { throw new Error("second read"); }) }), "artifact", "artifact-unresolvable", "second read");
    interruption(await f.run({ readArtifact: nth(f.deps.readArtifact, 1, () => null) }), "artifact", "artifact-unresolvable", "absent");
    interruption(await f.run({ rebindCutoff: () => { throw new BackendPublicationJournalError("unexpected-state", "cas"); } }), "cutoffs", "journal-unexpected", "cas");
    await expect(f.run({ rebindCutoff: () => { throw new Error("plain rebind"); } })).rejects.toThrow("plain rebind");
    f.activation.rewriteJournal((payload) => { payload.cutoverSet.bindings[0].roster[0].queueCutoff = "0000000000000000099"; });
    interruption(await f.run(), "cutoffs", "evidence-conflict", "not the preserved snapshot's");
  });

  it("classifies a member's manifest under the hold and under a frozen selection", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-hold");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "rolled-back" })) }), "members", "state-unresolvable", "under an unfrozen rollback");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "verified" })) }), "members", "state-unresolvable", "at phase verified");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "activating", pendingEffect: { kind: "publish-activation", effectId: "other", inputSha256: "a".repeat(64), startedAt: "2026-10-16T13:00:00.000Z" } as never })) }), "members", "state-unresolvable", "with pending publish-activation under a rollback commitment");
    await crashAt(f, "after-prepare-begin:" + a!.generationId);
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, pendingEffect: { ...head.pendingEffect!, inputSha256: "0".repeat(64) } })) }), "prepare", "evidence-conflict", "deterministic input");
    interruption(await f.run({ manifestStore: storeWith(f, { update: () => { throw new MigrationProtocolError("unexpected-state", "illegal"); } }) }), "prepare", "state-unresolvable", "illegal");
    await crashAt(f, "after-selection-frozen");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, pendingEffect: null })) }), "members", "state-unresolvable", "no publish-rollback is pending under a frozen selection");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "active", pendingEffect: null })) }), "members", "state-unresolvable", "active under a frozen selection");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "active", pendingEffect: { ...head.pendingEffect!, kind: "prepare-rollback" } })) }), "members", "state-unresolvable", "prepare-rollback is pending under a frozen selection");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, pendingEffect: { ...head.pendingEffect!, effectId: "rollback-publish-" + "0".repeat(64) } })) }), "members", "evidence-conflict", "not the frozen witness's");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, phase: "rolled-back", pendingEffect: null, rollbackLineage: { ...head.rollbackLineage, mode: "post-write" } })) }), "members", "state-unresolvable", "in mode post-write");
    const path = join(lcmHomeDir(f.homeDir), "projects", a!.localProjectId, "db.sqlite");
    const installed = readFileSync(path);
    sqliteDatabase(path);
    interruption(await f.run(), "install", "readback-mismatch", "sidecar-complete");
    rmSync(path);
    interruption(await f.run(), "install", "readback-mismatch", "cannot be read");
    writeFileSync(path, installed, { mode: 0o600 });
    const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
    if (records.state !== "resolved") throw new Error("records");
    const moved = new Map(records.installs);
    moved.set(a!.generationId, { ...records.installs.get(a!.generationId)!, canonicalPath: "/elsewhere" });
    interruption(await f.run({ readRollbackRecords: () => ({ ...records, installs: moved }) }), "install", "readback-mismatch", "another canonical path");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.prepareMaintenanceSelection = async () => { throw new BackendPublicationJournalError("unexpected-state", "stale"); }; return real; } }), "selection", "journal-unexpected", "stale");
    expectRolledBack(f, await f.run(), "selection-frozen");
  });

  it("classifies session, witness, build and install failures after the prepare effects", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    await crashAt(f, "after-prepare-complete:" + b!.generationId);
    blockedAt(await f.run({ openMemberSession: async () => { throw new RollbackSessionError("release-failed", "odd"); } }), "sessions", a!.generationId, "lease-unresolvable", "odd");
    blockedAt(await f.run({ openMemberSession: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } }), "sessions", a!.generationId, "cancelled");
    blockedAt(await f.run({ openMemberSession: () => Promise.reject("wire dropped" as unknown as Error) }), "sessions", a!.generationId, "target-unreachable", "wire dropped");
    await crashAt(f, "after-publish-begin:" + a!.generationId);
    interruption(await f.run({ readActivationEvidence: () => ({ state: "resolved", epochs: [], attempts: [], witnesses: [] }) }), "classify", "evidence-unresolvable", "no stored rollback witness");
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, createPortableSource: async () => { throw new RollbackSessionError("lease-lost", "renewal failed"); } } }), "build", b!.generationId, "lease-lost", "renewal failed");
    blockedAt(await f.run({ createStream: async (source) => { const stream = await f.deps.createStream(source); return { ...stream, close: async () => { throw new Error("close failed"); } }; }, buildGeneration: async () => { throw new Error("build boom"); } }), "build", a!.generationId, "build-failed", "build boom");
    blockedAt(await f.run({ crashPoint: (p) => { if (p === "after-build:" + b!.generationId) f.activation.guard.expireNextFor = b!.remoteProjectId; } }), "revalidate", a!.generationId, "lease-lost");
    f.activation.guard.expireNextFor = null;
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, readFencedDestinationCensus: nth(f.deps.sessionDependencies.readFencedDestinationCensus, 2, async () => { throw new Error("socket"); }) } }), "revalidate", a!.generationId, "target-unreachable", "socket");
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, captureDestinationIdentity: nth(f.deps.sessionDependencies.captureDestinationIdentity, 4, async () => ({ version: 1, sealedWitnessSha256: "1".repeat(64), systemIdentifier: f.identity.systemIdentifier }) as never) } }), "revalidate", a!.generationId, "revalidation-drift", "destination identity");
    interruption(await f.run({ openMemberSession: async (request, target, dependencies) => { const session = await f.deps.openMemberSession(request, target, dependencies); session.computeRollbackTerminalEvidenceSha256 = () => "0".repeat(64); return session; } }), "revalidate", "evidence-conflict", "terminal evidence");
    interruption(await f.run({ recordActivationWitness: () => { throw new MigrationBindingConflictError("other witness"); } }), "revalidate", "evidence-conflict", "other witness");
    await expect(f.run({ recordWitnessBinding: () => { throw new Error("plain"); } })).rejects.toThrow("plain");
    f.activation.guard.expireNextFor = null;
    blockedAt(await f.run({ crashPoint: (p) => { if (p === "after-publish-begin:" + b!.generationId) f.activation.guard.expireNextFor = a!.remoteProjectId; } }), "install", a!.generationId, "lease-lost");
    interruption(await f.run({ recordInstall: () => { throw new Error("record conflict"); } }), "install", "evidence-conflict", "record conflict");
    interruption(await f.run({ recordSelection: () => { throw new Error("freeze conflict"); } }), "freeze", "evidence-conflict", "freeze conflict");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.completeMaintenanceSelection = async () => { throw new BackendPublicationJournalError("unexpected-state", "stale"); }; return real; } }), "selection", "journal-unexpected", "stale");
    expectRolledBack(f, await f.run(), "selection-prepared");
  });

  it("keeps the first member's lease and every effect when a later member's session fails to open", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    await crashAt(f, "after-prepare-complete:" + b!.generationId);
    const manifests = () => f.members.map((member) => f.activation.manifestStore.read(member.generationId));
    const preserved = manifests();
    // Member A's session opens for real, then B's open fails: A's lease is kept (a member effect exists) and nothing is lost.
    blockedAt(await f.run({ openMemberSession: async (request, target, dependencies) => {
      if (request.generationId === b!.generationId) throw new Error("wire dropped");
      return f.deps.openMemberSession(request, target, dependencies);
    } }), "sessions", b!.generationId, "target-unreachable", "wire dropped");
    expect(f.activation.guard.rows.get(a!.remoteProjectId)).toMatchObject({ publicationId: f.setId, releasedAt: null });
    expect(manifests()).toEqual(preserved);
    expectRolledBack(f, await f.run(), "held");
  });

  it("releases leases after a blocked set only while no member moved, reporting a release that failed", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    const failingRelease: CutoverSetRollbackDependencies["openMemberSession"] = async (request, target, dependencies) => {
      const session = await f.deps.openMemberSession(request, target, dependencies);
      session.release = async () => { throw new Error("release refused"); };
      return session;
    };
    const outcome = await f.run({ openMemberSession: failingRelease, sessionDependencies: { ...f.deps.sessionDependencies, captureDestinationIdentity: nth(f.deps.sessionDependencies.captureDestinationIdentity, 2, async () => ({ version: 1, sealedWitnessSha256: "1".repeat(64), systemIdentifier: f.identity.systemIdentifier }) as never) } });
    blockedAt(outcome, "classify", a!.generationId, "not-eligible", "rollback leases were not released");
    // A runtime that fails to close never masks the outcome either.
    const closing = f.runtime.close;
    f.runtime.close = async () => { throw new Error("close failed"); };
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, captureDestinationIdentity: nth(f.deps.sessionDependencies.captureDestinationIdentity, 2, async () => ({ version: 1, sealedWitnessSha256: "1".repeat(64), systemIdentifier: f.identity.systemIdentifier }) as never) } }), "classify", a!.generationId, "not-eligible");
    f.runtime.close = closing;
    expectRolledBack(f, await f.run(), "held");
  });

  it("installs without a preempted file when no canonical database exists, and runs the set keeper's cadence", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    rmSync(join(lcmHomeDir(f.homeDir), "projects", a!.localProjectId, "db.sqlite"));
    const pooled = { ...TARGET_CONFIG, postgresql: { ...TARGET_CONFIG.postgresql, poolMax: 4 } };
    const pooledConfig = (dir: string) => (f.deps.readStorageConfig(dir).backend === "sqlite" ? { backend: "sqlite" } : pooled) as never;
    const slow = f.activation.guard.renew.bind(f.activation.guard);
    f.activation.guard.renew = async (request) => { await new Promise((resolve) => setTimeout(resolve, 5)); return slow(request); };
    const outcome = await f.run({ renewalIntervalMs: 1, readStorageConfig: pooledConfig, parseSealedStorageConfig: () => pooled as never });
    expect(outcome.status, JSON.stringify(outcome)).toBe("rolled-back");
    const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
    if (records.state !== "resolved") throw new Error("records");
    expect(records.installs.get(a!.generationId)!.preemption).toBeNull();
    expect(f.activation.guard.calls.filter((call) => call === "renew:" + a!.remoteProjectId).length).toBeGreaterThan(3);
    // A periodic renewal that fails aborts the keeper and blocks the next explicit sweep.
    const g = await rollbackFixture();
    const slower = g.activation.guard.renew.bind(g.activation.guard);
    g.activation.guard.renew = async (request) => { await new Promise((resolve) => setTimeout(resolve, 5)); return slower(request); };
    g.activation.guard.expireNextFor = g.members[0]!.remoteProjectId;
    const blocked = await g.run({ renewalIntervalMs: 1, readStorageConfig: (dir) => (g.deps.readStorageConfig(dir).backend === "sqlite" ? { backend: "sqlite" } : pooled) as never, parseSealedStorageConfig: () => pooled as never });
    expect(blocked.status).toBe("blocked");
    expect(blocked.status === "blocked" && blocked.reason).toBe("lease-lost");
    // With a single-connection pool the cadence is inert: its ticks run no renewal, so only the explicit sweeps renew.
    const h = await rollbackFixture();
    expect((await h.run()).status).toBe("rolled-back");
    const explicit = h.activation.guard.calls.filter((call) => call.startsWith("renew:")).length;
    const k = await rollbackFixture();
    expect((await k.run({ renewalIntervalMs: 1 })).status).toBe("rolled-back");
    expect(k.activation.guard.calls.filter((call) => call.startsWith("renew:")).length).toBe(explicit);
  });
});

describe("after the selection", () => {
  it("interrupts when the prepared selection, the records or the sessions cannot be adopted", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-selection-prepared");
    const directory = migrationCutoverSetRollbackDirectory(f.homeDir, f.originalSetId);
    const selection = readFileSync(join(directory, "selection.json"));
    rmSync(join(directory, "selection.json"));
    interruption(await f.run(), "selection", "state-unresolvable", "no frozen rollback selection");
    writeFileSync(join(directory, "selection.json"), selection, { mode: 0o600 });
    const prepared = readFileSync(join(lcmHomeDir(f.homeDir), "backend-publication", "journal.json"));
    const held = readBackendMaintenanceJournal(f.homeDir)!;
    interruption(await f.run({ readMaintenanceJournal: () => ({ ...held, cutoverSet: { ...held.cutoverSet!, selection: { ...held.cutoverSet!.selection!, checksumSha256: "0".repeat(64) } } }) }), "selection", "journal-unexpected", "not the frozen one");
    interruption(await f.run({ readMaintenanceJournal: () => ({ ...held, terminalEvidenceSha256: "0".repeat(64) }) }), "selection", "journal-unexpected", "another tuple's checksum");
    expect(readFileSync(join(lcmHomeDir(f.homeDir), "backend-publication", "journal.json"))).toEqual(prepared);
    interruption(await f.run({ readLink: () => ({ state: "authoritatively-absent" }) }), "members", "state-unresolvable");
    interruption(await f.run({ verifyRuntimeSchema: async () => { throw new Error("down"); } }), "target", "state-unresolvable", "down");
    f.activation.guard.rows.set(a!.remoteProjectId, { ...f.activation.guard.rows.get(a!.remoteProjectId)!, publicationId: "other" });
    blockedAt(await f.run(), "sessions", a!.generationId, "lease-conflict");
    f.activation.guard.rows.set(a!.remoteProjectId, { ...f.activation.guard.rows.get(a!.remoteProjectId)!, publicationId: f.setId });
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, readFencedDestinationCensus: async () => { throw new Error("socket"); } } }), "revalidate", a!.generationId, "target-unreachable", "socket");
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, captureDestinationIdentity: nth(f.deps.sessionDependencies.captureDestinationIdentity, 2, async () => ({ version: 1, sealedWitnessSha256: "1".repeat(64), systemIdentifier: f.identity.systemIdentifier }) as never) } }), "revalidate", a!.generationId, "revalidation-drift");
    const sealed = f.liveCensus.get(a!.remoteProjectId)!;
    f.liveCensus.set(a!.remoteProjectId, sealed.map((entry) => ({ ...entry, prefixSha256: "9".repeat(64) })));
    blockedAt(await f.run(), "revalidate", a!.generationId, "pending-evidence-drift", "frozen witness");
    f.liveCensus.set(a!.remoteProjectId, sealed);
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.completeMaintenanceSelection = async () => { throw new BackendPublicationJournalError("unexpected-state", "stale"); }; return real; } }), "selection", "journal-unexpected", "stale");
    expectRolledBack(f, await f.run(), "selection-prepared");
  });

  it("drives the reverse publication through the coordinator's abort, missing-material and refusal exits", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-selection-completed");
    interruption(await f.run({ recordSelectionBinding: () => { throw new MigrationBindingConflictError("binding"); } }), "completion", "evidence-conflict", "binding");
    interruption(await f.run({ recordSelectionBinding: () => { throw new MigrationBindingUnresolvableError("unreadable"); } }), "completion", "evidence-unresolvable", "unreadable");
    await expect(f.run({ recordSelectionBinding: () => { throw new Error("plain"); } })).rejects.toThrow("plain");
    interruption(await f.run({ composeMaterial: () => { throw new Error("compose boom"); } }), "publication", "publication-mismatch", "compose boom");
    interruption(await f.run({ composeMaterial: (request) => { const composed = f.deps.composeMaterial(request); return { ...composed, projects: composed.projects.slice(0, 1) }; } }), "publication", "publication-mismatch", "differs from the sealed");
    interruption(await f.run({ composeMaterial: (request) => { const composed = f.deps.composeMaterial(request); return { ...composed, material: { ...composed.material, source: { ...composed.material.source, config: { presence: "absent" } as never } } }; } }), "publication", "publication-mismatch");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.prepare = async () => { throw new BackendPublicationJournalError("unresolved-publication", "occupied"); }; return real; } }), "publication", "journal-unexpected", "occupied");
    await expect(f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.prepare = async () => { throw new Error("plain prepare"); }; return real; } })).rejects.toThrow("plain prepare");
    // The coordinator's own missing-material exit: prepare died before sealing the material.
    let sealCrash = false;
    const sealCrashing: CutoverSetRollbackDependencies["createCoordinator"] = ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
      homeDir, remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 60_000 }) },
      observer: (event) => { if (!sealCrash && event === "before-material-seal") { sealCrash = true; throw new Error("crash before seal"); } },
    });
    await expect(f.run({ createCoordinator: sealCrashing })).rejects.toThrow("crash before seal");
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "preparing", publicationId: f.setId, recoveryReference: null });
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.abort = async () => { throw new BackendPublicationJournalError("unexpected-state", "no abort"); }; return real; } }), "publication", "journal-unexpected", "no abort");
    await expect(f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.abort = async () => { throw new Error("plain missing-material abort"); }; return real; } })).rejects.toThrow("plain missing-material abort");
    const unsealed = readBackendPublicationJournal(f.homeDir)!;
    expect(unsealed).toMatchObject({ phase: "preparing", recoveryReference: null });
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.abort = async () => ({ ...unsealed, phase: "aborted", recoveryReference: { relativePath: "x", sealSha256: "0".repeat(64), byteLength: 1 } }); return real; } }), "publication", "journal-unexpected", "missing-material");
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    // The retry settles the unsealed journal through the coordinator's own missing-material abort and prepares again.
    await crashAt(f, "after-prepare");
    // Something else aborted the sealed publication: the abort is finished, the source proven restored, prepared again.
    const coordinator = f.activation.coordinator();
    await coordinator.abort();
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborted");
    const aborted = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: () => ({ ...aborted, projects: aborted.projects.map((project) => ({ ...project, fence: { ...project.fence!, releasedAt: null } })) }) }), "publication", "publication-aborted", "unreleased fence");
    interruption(await f.run({ readPublicationJournal: () => ({ ...aborted, projects: aborted.projects.slice(0, 1) }) }), "publication", "publication-mismatch", "not its reverse composition");
    expectRolledBack(f, await f.run(), "publication-journal");
    expect(f.deps.prepareCalls).toBe(2);
  });

  it("finishes an abort the coordinator left part-way, and refuses a publication that does not complete as composed", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-prepare");
    let crashed = false;
    const abortCrashing = createBackendPublicationCoordinator({
      homeDir: f.homeDir, remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard: f.activation.guard, machineId: MACHINE, ttlMs: 60_000 }) },
      observer: (event) => { if (!crashed && event === "after-journal-write" && readBackendPublicationJournal(f.homeDir)?.phase === "aborting") { crashed = true; throw new Error("crash while aborting"); } },
    });
    await expect(abortCrashing.abort()).rejects.toThrow("crash while aborting");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborting");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.abort = async () => { throw new BackendPublicationJournalError("unexpected-state", "cannot settle"); }; return real; } }), "publication", "journal-unexpected", "cannot settle");
    await expect(f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.abort = async () => { throw new Error("plain abort"); }; return real; } })).rejects.toThrow("plain abort");
    await crashAt(f, "after-abort-settled");
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborted");
    const completedElsewhere = (journal: BackendPublicationJournal): BackendPublicationJournal => ({ ...journal, phase: "completed", projects: journal.projects.slice(0, 1) });
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); const prepare = real.prepare.bind(real); real.prepare = async (input, token) => { await prepare(input, token); return readBackendPublicationJournal(f.homeDir)!; }; real.resume = async () => ({ ...readBackendPublicationJournal(f.homeDir)!, phase: "aborted" }); return real; } }), "publication", "publication-aborted");
    interruption(await f.run({ createCoordinator: (request) => { const real = f.deps.createCoordinator(request); real.resume = async () => completedElsewhere(readBackendPublicationJournal(f.homeDir)!); return real; } }), "publication", "publication-mismatch", "did not complete as composed");
    expectRolledBack(f, await f.run(), "publication-journal");
  });

  it("revalidates every frozen witness under reacquired fences before preparing again after an abort (PR #1668 P1)", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    await crashAt(f, "after-prepare");
    const frozen = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
    const installed = f.members.map((member) => readFileSync(join(lcmHomeDir(f.homeDir), "projects", member.localProjectId, "db.sqlite")));
    const unchanged = () => {
      expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "aborted", publicationId: f.setId });
      expectAllPostgreSql(f);
      expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })).toEqual(frozen);
      for (const [index, member] of f.members.entries()) {
        expect(readFileSync(join(lcmHomeDir(f.homeDir), "projects", member.localProjectId, "db.sqlite"))).toEqual(installed[index]);
        expect(f.activation.manifestStore.read(member.generationId)).toMatchObject({ phase: "rolling-back", pendingEffect: expect.objectContaining({ kind: "publish-rollback" }) });
      }
    };
    // Something else aborted the sealed publication: PostgreSQL is selected again and the fences are released, so writes resume.
    await f.activation.coordinator().abort();
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "aborted", publicationId: f.setId });
    expect(readBackendPublicationJournal(f.homeDir)!.recoveryReference).not.toBeNull();
    // The reacquired sessions are recovery sessions: the set recovery admission gates them.
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, checkSetRecoveryAdmission: async () => ({ status: "unsatisfied", detail: "another journal", quiescenceFence: null }) } }), "sessions", a!.generationId, "quiescence-unsatisfied", "another journal");
    unchanged();
    expect(f.deps.prepareCalls).toBe(1);
    // The destination of B (post-write) accepted writes after the abort: its frozen witness is no longer reproduced.
    const sealedB = f.liveCensus.get(b!.remoteProjectId)!;
    f.liveCensus.set(b!.remoteProjectId, sealedB.map((entry) => ({ ...entry, prefixSha256: "9".repeat(64) })));
    blockedAt(await f.run(), "revalidate", b!.generationId, "pending-evidence-drift", "not prepared again");
    unchanged();
    expect(f.deps.prepareCalls).toBe(1);
    f.liveCensus.set(b!.remoteProjectId, sealedB);
    // The destination of A (pre-write) shows writes now: another mode than the frozen one.
    const sealedA = f.liveCensus.get(a!.remoteProjectId)!;
    f.liveCensus.set(a!.remoteProjectId, sealedA.map((entry) => ({ ...entry, prefixSha256: "9".repeat(64) })));
    blockedAt(await f.run(), "revalidate", a!.generationId, "pending-evidence-drift");
    unchanged();
    f.liveCensus.set(a!.remoteProjectId, sealedA);
    // A readback that fails blocks at the same step.
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, readFencedDestinationCensus: async () => { throw new Error("readback lost"); } } }), "revalidate", a!.generationId, "target-unreachable", "readback lost");
    unchanged();
    // Unchanged destinations converge: the sealed material is prepared exactly once more.
    expectRolledBack(f, await f.run(), "publication-journal");
    expect(f.deps.prepareCalls).toBe(2);
    // Through the abort-path phases the abort is finished first, then the fences are reacquired and the witnesses revalidated.
    const g = await rollbackFixture();
    const [, gb] = g.members;
    await crashAt(g, "after-prepare");
    let crashed = false;
    const abortCrashing = createBackendPublicationCoordinator({
      homeDir: g.homeDir, remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard: g.activation.guard, machineId: MACHINE, ttlMs: 60_000 }) },
      observer: (event) => { if (!crashed && event === "after-journal-write" && readBackendPublicationJournal(g.homeDir)?.phase === "aborting") { crashed = true; throw new Error("crash while aborting"); } },
    });
    await expect(abortCrashing.abort()).rejects.toThrow("crash while aborting");
    expect(readBackendPublicationJournal(g.homeDir)?.phase).toBe("aborting");
    const sealedGb = g.liveCensus.get(gb!.remoteProjectId)!;
    g.liveCensus.set(gb!.remoteProjectId, sealedGb.map((entry) => ({ ...entry, prefixSha256: "9".repeat(64) })));
    blockedAt(await g.run(), "revalidate", gb!.generationId, "pending-evidence-drift");
    expect(readBackendPublicationJournal(g.homeDir)).toMatchObject({ phase: "aborted", publicationId: g.setId });
    expectAllPostgreSql(g);
    expect(g.deps.prepareCalls).toBe(1);
    g.liveCensus.set(gb!.remoteProjectId, sealedGb);
    expectRolledBack(g, await g.run(), "publication-journal");
    expect(g.deps.prepareCalls).toBe(2);
  });

  it("interrupts when the completed reverse publication, the selected installation or a member's completion cannot be verified", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    await crashAt(f, "after-drive");
    const completed = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: nth(f.deps.readPublicationJournal, 1, () => null) }), "completion", "readback-mismatch", "not this rollback's completed journal");
    interruption(await f.run({ readStorageConfig: () => { throw new Error("config unreadable"); } }), "completion", "readback-mismatch", "config unreadable");
    interruption(await f.run({ readStorageConfig: () => TARGET_CONFIG as never }), "completion", "readback-mismatch", "selects postgresql");
    const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, Record<string, unknown>>;
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify({ ...map, [a!.localProjectId]: { ...map[a!.localProjectId], remoteProjectId: a!.remoteProjectId } }) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    interruption(await f.run(), "completion", "readback-mismatch", "still binds");
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, pendingEffect: null }), 1) }), "completion", "readback-mismatch", "not rolling back");
    const path = join(lcmHomeDir(f.homeDir), "projects", a!.localProjectId, "db.sqlite");
    const installed = readFileSync(path);
    // The publication completed: the installed bytes are the consumers' now, but the database must be present.
    rmSync(path);
    interruption(await f.run(), "install", "readback-mismatch", "cannot be read");
    writeFileSync(path, installed, { mode: 0o600 });
    interruption(await f.run({ writeReport: () => { throw new Error("report conflict"); } }), "completion", "evidence-conflict", "report conflict");
    interruption(await f.run({ manifestStore: storeWith(f, { update: () => { throw new MigrationProtocolError("unexpected-state", "illegal"); } }) }), "completion", "state-unresolvable", "illegal");
    await expect(f.run({ manifestStore: storeWith(f, { update: () => { throw new Error("plain update"); } }) })).rejects.toThrow("plain update");
    expect(completed.phase).toBe("completed");
    expectRolledBack(f, await f.run(), "publication-journal");
  });

  it("verifies an already rolled-back member against its frozen row, report and installation", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    await crashAt(f, "after-complete:" + a!.generationId);
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, rollbackLineage: { ...head.rollbackLineage, mode: "post-write" } }), 1) }), "completion", "readback-mismatch", "rolled-back mode");
    interruption(await f.run({ manifestStore: readingAs(f, a!.generationId, (head) => ({ ...head, reports: head.reports.filter((report) => report.kind !== "rollback") }), 1) }), "completion", "readback-mismatch", "no rollback report");
    interruption(await f.run({ readReport: () => { throw new Error("report unreadable"); } }), "completion", "evidence-unresolvable", "report unreadable");
    interruption(await f.run({ readReport: () => null }), "completion", "readback-mismatch", "does not name the frozen witness");
    const path = join(lcmHomeDir(f.homeDir), "projects", a!.localProjectId, "db.sqlite");
    const installed = readFileSync(path);
    rmSync(path);
    interruption(await f.run(), "install", "readback-mismatch", "cannot be read");
    writeFileSync(path, installed, { mode: 0o600 });
    expectRolledBack(f, await f.run(), "publication-journal");
    // Under a later hold the same verification applies to the settled set.
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    interruption(await f.run({ readLink: () => ({ state: "authoritatively-absent" }) }), "members", "state-unresolvable");
    interruption(await f.run({ readReport: () => null }), "completion", "readback-mismatch");
    writeConfig(f.homeDir, "postgresql");
    interruption(await f.run({ readStorageConfig: () => TARGET_CONFIG as never }), "completion", "readback-mismatch", "selects postgresql");
    writeConfig(f.homeDir, "sqlite");
    rmSync(join(lcmHomeDir(f.homeDir), "projects", b!.localProjectId, "db.sqlite"));
    interruption(await f.run(), "install", "readback-mismatch", "cannot be read");
    expect(readBackendMaintenanceJournal(f.homeDir)?.generationId).toBe("later-generation");
  });

  it("recovers the completion after legitimate SQLite writes once the reverse publication completed (PR #1668 P2)", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    const paths = f.members.map((member) => join(lcmHomeDir(f.homeDir), "projects", member.localProjectId, "db.sqlite"));
    await crashAt(f, "after-complete:" + a!.generationId);
    // SQLite is selected and every member unbound: consumers write to both installed databases before B's manifest settles.
    const written = paths.map((path, index) => consumerWrite(path, "after-completion-" + index));
    expect(f.activation.manifestStore.read(b!.generationId).phase).toBe("rolling-back");
    expectRolledBack(f, await f.run(), "publication-journal");
    for (const [index, path] of paths.entries()) expect(readFileSync(path)).toEqual(written[index]);
    // The rolled-back set stays reportable after further use, and from the member evidence under a later hold.
    const used = paths.map((path, index) => consumerWrite(path, "after-rollback-" + index));
    expectRolledBack(f, await f.run(), "settled");
    for (const [index, path] of paths.entries()) expect(readFileSync(path)).toEqual(used[index]);
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    consumerWrite(paths[1]!, "under-later-hold");
    expect((await f.run()).status).toBe("rolled-back");
    // The record must still name a present canonical database: a missing or non-regular file at the path interrupts.
    const kept = readFileSync(paths[0]!);
    rmSync(paths[0]!);
    interruption(await f.run(), "install", "readback-mismatch", "cannot be read");
    symlinkSync(paths[1]!, paths[0]!);
    interruption(await f.run(), "install", "readback-mismatch", "not a plain regular file");
    rmSync(paths[0]!);
    writeFileSync(paths[0]!, kept, { mode: 0o600 });
    expect((await f.run()).status).toBe("rolled-back");
    // Before the publication completed the installed bytes are still required: a written candidate is not republished.
    const g = await rollbackFixture();
    await crashAt(g, "after-selection-completed");
    consumerWrite(join(lcmHomeDir(g.homeDir), "projects", g.members[0]!.localProjectId, "db.sqlite"), "premature");
    interruption(await g.run(), "install", "readback-mismatch", "sidecar-complete");
  });

  it("settles under a foreign publication only when every member is rolled back, and interrupts a frozen selection beside the live activation", async () => {
    const f = await rollbackFixture();
    const activation = readBackendPublicationJournal(f.homeDir)!;
    await crashAt(f, "after-drive");
    const completed = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: () => ({ ...completed, publicationId: "foreign" }) }), "completion", "state-unresolvable", f.members.map((member) => member.generationId).join(", ") + " are not rolled back");
    await crashAt(f, "after-complete:" + f.members[0]!.generationId);
    const own = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: () => ({ ...own, publicationId: "foreign" }) }), "completion", "state-unresolvable", "occupied by publication foreign");
    interruption(await f.run({ readPublicationJournal: () => activation }), "slot", "journal-unexpected", "still live");
    expectRolledBack(f, await f.run(), "publication-journal");
    const settled = await f.run({ readPublicationJournal: () => ({ ...own, publicationId: "foreign" }) });
    expect(settled).toMatchObject({ status: "rolled-back", resumedFrom: "settled" });
    const g = await rollbackFixture();
    await crashAt(g, "after-checkpoint");
    interruption(await g.run({ readPublicationJournal: () => ({ ...activation, publicationId: "foreign" }) }), "slot", "hold-gone", "publication foreign");
  });

  it("rethrows unexpected failures while recovering an entering hold before the barrier", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-hold");
    f.activation.rewriteJournal((payload) => { payload.phase = "maintenance-entering"; });
    await expect(f.run({ parseSealedStorageConfig: () => { throw new Error("sealed plain"); } })).rejects.toThrow("sealed plain");
    await expect(f.run({ createCoordinator: () => ({ enterMaintenance: async () => { throw new Error("entering plain"); } }) as never })).rejects.toThrow("entering plain");
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-entering");
    expectRolledBack(f, await f.run(), "held");
  });
});

