import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MachineIdentityFileError } from "../../src/machine-identity.js";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import {
  BackendPublicationJournalError,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationObserver,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { MigrationActivationEvidenceRefusalError } from "../../src/migration/activation-evidence-store.js";
import { migrationCutoverSetRollbackDirectory, readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { rollbackCutoverSet, type CutoverSetRollbackDependencies, type CutoverSetRollbackResult } from "../../src/migration/cutover-set-rollback.js";
import { MigrationProtocolError } from "../../src/migration/protocol.js";
import { MACHINE, cleanupRoots, expectActivated } from "./cutover-set-activate-fixture.js";
import { driftedCensus, expectAllPostgreSql, expectRolledBack, rollbackFixture, sqliteDatabase, writeConfig, type RollbackFixture } from "./cutover-set-rollback-fixture.js";

/**
 * Refusals before any durable rollback state (nothing moves, every lease
 * released), blocked members after the commitment (the hold, the
 * checkpoint, every source, candidate and record kept; a retry finishes),
 * and interruptions that preserve evidence without republishing (#1550
 * D2, D4, D5, D8).
 */

vi.setConfig({ testTimeout: 120_000 });
afterEach(cleanupRoots);

function expectNoEffects(f: RollbackFixture): void {
  for (const member of f.members) {
    const manifest = f.activation.manifestStore.read(member.generationId);
    expect(manifest.phase).toBe("active");
    expect(manifest.pendingEffect).toBeNull();
  }
  expectAllPostgreSql(f);
  expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })).toEqual({ state: "authoritatively-absent" });
  expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
  for (const row of f.activation.guard.rows.values()) expect(row.releasedAt).not.toBeNull();
}

function expectHeldAndPreserved(f: RollbackFixture): void {
  expect(readBackendMaintenanceJournal(f.homeDir)).toMatchObject({ phase: "maintenance-held", generationId: f.setId, sourceBackend: "postgresql" });
  expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })).toMatchObject({ state: "resolved", selection: null });
  expectAllPostgreSql(f);
}

async function crashAt(f: RollbackFixture, point: string, overrides: Partial<CutoverSetRollbackDependencies> = {}): Promise<void> {
  await expect(f.run({ ...overrides, crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}

const refusal = (outcome: CutoverSetRollbackResult, step: string, reason: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "refused", step, reason, effectBegun: false, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });
const blockedAt = (outcome: CutoverSetRollbackResult, step: string, member: string, reason: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "blocked", step, member, reason, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });
const interruption = (outcome: CutoverSetRollbackResult, step: string, cause: string, detail?: string) =>
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "interrupted", step, cause, ...(detail === undefined ? {} : { detail: expect.stringContaining(detail) }) });

describe("rollbackCutoverSet refusals before any durable rollback state", () => {
  it("refuses malformed input before any read", async () => {
    await expect(rollbackCutoverSet({ homeDir: "", confirmSetId: "x" })).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(rollbackCutoverSet({ homeDir: "/home", confirmSetId: "bad id!" })).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(rollbackCutoverSet(null as never)).rejects.toMatchObject({ reason: "invalid-input" });
  });

  it("refuses a set that was never selected, held but not activated, or whose activation publication is not completed", async () => {
    const unheld = await rollbackFixture({ held: false }).catch(() => null);
    expect(unheld).toBeNull();
    // Held and prepared, the activation frozen but not published: refused before any read of a member.
    const { fixture } = await import("./cutover-set-activate-fixture.js");
    const a = await fixture();
    await expect(a.run({ crashPoint: (p) => { if (p === "after-selection-frozen") throw new Error("stop"); } })).rejects.toThrow("stop");
    const held = await rollbackCutoverSet({ homeDir: a.homeDir, confirmSetId: a.setId }, { machineId: () => MACHINE });
    refusal(held, "slot", "activation-not-completed", "maintenance-held");
    // No records at all.
    const none = await fixture();
    refusal(await rollbackCutoverSet({ homeDir: none.homeDir, confirmSetId: none.setId }, { machineId: () => MACHINE }), "records", "activation-not-selected");
    // The activation publication in flight (map published, config not).
    const b = await fixture();
    let crashed = false;
    await expect(b.run({ createCoordinator: ({ homeDir, guard, machineId }) => createBackendPublicationCoordinator({
      homeDir, remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 60_000 }) },
      observer: ((event) => { if (!crashed && event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === "map-published") { crashed = true; throw new Error("stop"); } }) as BackendPublicationObserver,
    }) })).rejects.toThrow("stop");
    refusal(await rollbackCutoverSet({ homeDir: b.homeDir, confirmSetId: b.setId }, { machineId: () => MACHINE }), "slot", "activation-not-completed", "map-published");
    expectActivated(b, await b.run(), "publication-journal");
  });

  it("refuses an empty or foreign slot, an unregistered machine and unresolvable records", async () => {
    const f = await rollbackFixture();
    const path = backendPublicationJournalPath(f.homeDir);
    const journal = readFileSync(path);
    rmSync(path);
    refusal(await f.run(), "slot", "activation-not-live", "no publication journal");
    writeFileSync(path, journal, { mode: 0o600 });
    await f.activation.coordinator().enterMaintenance({
      publicationId: "later-generation", generationId: "later-generation", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: new Date("2026-10-22T00:00:00.000Z"),
    });
    refusal(await f.run(), "slot", "maintenance-held-by-other", "later-generation");
    refusal(await f.run({ machineId: () => { throw new MachineIdentityFileError("unregistered"); } }), "records", "machine-identity-unregistered");
    refusal(await f.run({ readActivationRecords: () => ({ state: "unresolvable", reason: "corrupt" }) }), "records", "activation-unresolvable", "corrupt");
    refusal(await f.run({ readMaintenanceJournal: () => { throw new Error("unreadable"); } }), "slot", "activation-unresolvable", "unreadable");
    interruption(await f.run({ readRollbackRecords: () => ({ state: "unresolvable", reason: "corrupt" }) }), "records", "state-unresolvable", "corrupt");
    refusal(await f.run({ rollbackJournalCapacity: () => ({ worstCaseBytes: 2, limitBytes: 1 }) }), "records", "cutover-set-too-large");
    expect(readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId })).toEqual({ state: "authoritatively-absent" });
  });

  it("refuses every member that is not an authenticated active member of the activation, releasing nothing", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    const store = f.deps.manifestStore;
    const absent = { ...store, read: (id: string) => { if (id === a!.generationId) throw new MigrationProtocolError("unexpected-state", "migration manifest head is absent"); return store.read(id); } } as typeof store;
    refusal(await f.run({ manifestStore: Object.assign(Object.create(store) as typeof store, absent) }), "members", "member-not-active", "no migration manifest");
    const unreadable = Object.assign(Object.create(store) as typeof store, { read: (id: string) => { if (id === a!.generationId) throw new MigrationProtocolError("checksum-mismatch", "corrupt"); return store.read(id); } });
    refusal(await f.run({ manifestStore: unreadable }), "members", "member-not-active", "cannot be read");
    refusal(await f.run({ readLink: () => ({ state: "authoritatively-absent" }) }), "members", "member-link-mismatch", "no generation link");
    refusal(await f.run({ readLink: () => ({ state: "unresolvable", reason: "root-unauthenticated", detail: "nope" }) as never }), "members", "member-link-mismatch", "unresolvable");
    refusal(await f.run({ readLink: (request) => ({ ...f.deps.readLink(request), link: { ...(f.deps.readLink(request) as { link: object }).link, publicationId: "other" } }) as never }), "members", "member-link-mismatch", "does not name");
    refusal(await f.run({ resolveAuthoritativeContext: async () => null }), "members", "member-evidence-missing", "not stored");
    refusal(await f.run({ resolveAuthoritativeContext: async () => { throw new MigrationActivationEvidenceRefusalError("evidence-unresolvable", "corrupt"); } }), "members", "member-evidence-missing", "corrupt");
    refusal(await f.run({ inspectSnapshot: async () => { throw new Error("tampered"); } }), "members", "member-snapshot-mismatch", "tampered");
    f.snapshotOverride.set(a!.generationId, { maintenanceChecksumSha256: "0".repeat(64) });
    refusal(await f.run(), "members", "member-snapshot-mismatch", "forward held binding");
    f.snapshotOverride.clear();
    refusal(await f.run({ readArtifact: () => { throw new Error("artifact unreadable"); } }), "members", "activation-unresolvable", "artifact unreadable");
    refusal(await f.run({ readArtifact: () => null }), "members", "activation-unresolvable", "absent");
    expectNoEffects(f);
  });

  it("refuses project coverage drift, a non-postgresql configuration, an unreachable or drifted target and an absent operability fact", async () => {
    const f = await rollbackFixture();
    const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, Record<string, unknown>>;
    const unbound = { ...map, [f.members[0]!.localProjectId]: { ...map[f.members[0]!.localProjectId], remoteProjectId: undefined } };
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(unbound) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    refusal(await f.run(), "members", "project-coverage-drift", "not exactly");
    const rebound = { ...map, [f.members[0]!.localProjectId]: { ...map[f.members[0]!.localProjectId], remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9009" } };
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(rebound) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    refusal(await f.run(), "members", "project-coverage-drift", "another destination");
    writeFileSync(projectMapPath(f.homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
    clearProjectMapCache();
    refusal(await f.run({ readStorageConfig: () => ({ backend: "sqlite" }) as never }), "target", "activation-not-completed", "selects sqlite");
    refusal(await f.run({ verifyRuntimeSchema: async () => { throw new Error("connection refused"); } }), "target", "target-unreachable", "connection refused");
    f.identity.sealedWitnessSha256 = "1".repeat(64);
    refusal(await f.run(), "target", "target-identity-drift");
    f.identity.sealedWitnessSha256 = "d".repeat(64);
    refusal(await f.run({ readOperabilityFact: async () => ({ state: "authoritatively-absent" }) }), "slot", "activation-not-completed", "authoritatively-absent");
    refusal(await f.run({ readOperabilityFact: async () => ({ state: "unresolvable", reason: "locked" }) }), "slot", "activation-not-completed", "locked");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    refusal(await rollbackCutoverSet({ ...f.input, signal: controller.signal }, f.deps), "artifact", "cancelled");
    refusal(await f.run({ readArtifact: (request) => (request.identityDigest === f.checkpoint.identityDigest ? f.deps.readArtifact(request) : (() => { throw new Error("digest unreadable"); })()) }), "artifact", "activation-unresolvable", "digest unreadable");
    refusal(await f.run({ recordCheckpoint: () => { throw new Error("disk full"); } }), "checkpoint", "activation-unresolvable", "disk full");
    expectNoEffects(f);
    expect(f.runtime.closes).toBeGreaterThan(0);
  });

  it("refuses an orphan reverse artifact sealed under another publication and a completed activation that does not cover the artifact", async () => {
    const f = await rollbackFixture();
    refusal(await f.run({ readArtifact: (request) => (request.identityDigest === f.checkpoint.identityDigest ? f.deps.readArtifact(request) : { ...f.deps.readArtifact({ homeDir: f.homeDir, identityDigest: f.checkpoint.identityDigest })!, publicationId: "other" }) }), "artifact", "activation-unresolvable", "another publication");
    const completed = readBackendPublicationJournal(f.homeDir)!;
    refusal(await f.run({ readPublicationJournal: () => ({ ...completed, projects: completed.projects.slice(0, 1) }) }), "slot", "activation-not-completed", "does not cover");
    expectNoEffects(f);
  });
});

describe("rollbackCutoverSet blocked members keep the hold and every piece of evidence", () => {
  it("blocks on a lease another publication holds, releases what it acquired, and finishes once the row is released", async () => {
    const f = await rollbackFixture();
    const b = f.members[1]!;
    f.activation.guard.seed({ projectId: b.remoteProjectId, publicationId: "other-publication", targetBackend: "sqlite", evidenceSha256: "0".repeat(64) });
    blockedAt(await f.run(), "sessions", b.generationId, "lease-conflict");
    expectHeldAndPreserved(f);
    // A's lease was released (no member effect exists); B's foreign row is untouched.
    expect(f.activation.guard.rows.get(f.members[0]!.remoteProjectId)?.releasedAt).not.toBeNull();
    expect(f.activation.guard.rows.get(b.remoteProjectId)).toMatchObject({ publicationId: "other-publication", releasedAt: null });
    f.activation.guard.rows.set(b.remoteProjectId, { ...f.activation.guard.rows.get(b.remoteProjectId)!, releasedAt: "2026-10-21T00:00:00.000Z" });
    expectRolledBack(f, await f.run(), "held");
  });

  it("blocks on refused set quiescence, a cancelled call, a lost lease and an unreachable readback", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, checkSetQuiescence: async () => ({ status: "unsatisfied", reason: "quiescence-not-observed", detail: "a writer is active", quiescenceFence: null }) as never } }), "sessions", a!.generationId, "quiescence-unsatisfied", "writer is active");
    expectHeldAndPreserved(f);
    const controller = new AbortController();
    blockedAt(await rollbackCutoverSet({ ...f.input, signal: controller.signal }, { ...f.deps, crashPoint: (p) => { if (p === "after-classify") controller.abort(new Error("stop")); } }), "build", a!.generationId, "cancelled");
    const early = new AbortController();
    early.abort(new Error("stop"));
    blockedAt(await rollbackCutoverSet({ ...f.input, signal: early.signal }, f.deps), "sessions", a!.generationId, "cancelled");
    expect(b).toBeDefined();
    f.activation.guard.expireNextFor = a!.remoteProjectId;
    blockedAt(await f.run(), "classify", a!.generationId, "lease-lost");
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, readFencedDestinationCensus: async () => { throw new Error("socket closed"); } } }), "classify", a!.generationId, "target-unreachable", "socket closed");
    expectHeldAndPreserved(f);
    expectRolledBack(f, await f.run(), "held");
  });

  it("blocks a member whose readback is not eligible, and one whose pending publish-rollback no longer classifies the same", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    let calls = 0;
    const drifting = { ...f.deps.sessionDependencies, captureDestinationIdentity: async () => ({ version: 1, sealedWitnessSha256: ++calls > f.members.length ? "1".repeat(64) : f.identity.sealedWitnessSha256, systemIdentifier: f.identity.systemIdentifier }) as never };
    blockedAt(await f.run({ sessionDependencies: drifting }), "classify", a!.generationId, "not-eligible", "destination identity");
    expectHeldAndPreserved(f);
    await crashAt(f, "after-publish-begin:" + a!.generationId);
    expect(f.activation.manifestStore.read(a!.generationId).pendingEffect?.kind).toBe("publish-rollback");
    // A was sealed pre-write; its destination now shows writes.
    f.liveCensus.set(a!.remoteProjectId, driftedCensus(a!));
    blockedAt(await f.run(), "classify", a!.generationId, "pending-evidence-drift", "sealed as pre-write");
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-held");
    // The stored witness is required: with the evidence store unreadable the pending effect cannot be classified.
    interruption(await f.run({ readActivationEvidence: () => ({ state: "unresolvable", reason: "corrupt" }) }), "classify", "evidence-unresolvable");
  });

  it("blocks on a quarantined or failed build, a preserved source that is not the verified source, and export drift", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    blockedAt(await f.run({ buildGeneration: async (request) => ({ state: "quarantined", generationId: request.generationId, databasePath: "/q", reason: "transfer:boom", witness: {} as never }) }), "build", a!.generationId, "build-quarantined", "transfer:boom");
    expectHeldAndPreserved(f);
    blockedAt(await f.run({ buildGeneration: async () => { throw new Error("disk full"); } }), "build", a!.generationId, "build-failed", "disk full");
    blockedAt(await f.run({ derivePreservedSource: (snapshot, identity, homeDir) => { const derived = f.deps.derivePreservedSource(snapshot, identity, homeDir); return { ...derived, sourceWitness: { ...derived.sourceWitness, contentSha256: "0".repeat(64) } }; } }), "build", a!.generationId, "preserved-source-mismatch");
    blockedAt(await f.run({ derivePreservedSource: () => { throw new Error("snapshot unreadable"); } }), "build", a!.generationId, "build-failed", "snapshot unreadable");
    blockedAt(await f.run({ sessionDependencies: { ...f.deps.sessionDependencies, createPortableSource: async () => { throw new Error("export refused"); } } }), "build", b!.generationId, "build-failed", "export refused");
    // The export's census differs from the fresh readback's: refused before anything is installed.
    f.exportCensus.set(b!.remoteProjectId, driftedCensus(a!));
    blockedAt(await f.run(), "revalidate", b!.generationId, "revalidation-drift", "census differs");
    f.exportCensus.clear();
    expectHeldAndPreserved(f);
    for (const member of f.members) expect(f.activation.manifestStore.read(member.generationId).phase).toBe("rolling-back");
    expectRolledBack(f, await f.run(), "held");
  });

  it("blocks when revalidation observes another mode or a changed delta, and when the pending witness is not reproduced", async () => {
    const f = await rollbackFixture();
    const [a, b] = f.members;
    let reads = 0;
    let deltaDrift = false;
    const flipping = (after: number, remote: string) => ({
      ...f.deps.sessionDependencies,
      readFencedDestinationCensus: async (_snapshot: unknown, request: { expectedIdentity: { remoteProjectId?: string } }) => {
        const id = request.expectedIdentity.remoteProjectId!;
        const member = f.members.find((candidate) => candidate.remoteProjectId === id)!;
        reads += id === remote ? 1 : 0;
        const census = id === remote && reads > after
          ? f.liveCensus.get(id)!.map((entry) => ({ ...entry, prefixSha256: "7".repeat(64), terminalIdentitySha256: deltaDrift ? "8".repeat(64) : entry.terminalIdentitySha256 }))
          : f.liveCensus.get(id)!;
        void member;
        return { census, dependencyEdges: new Map(), recordIdentities: new Map(), recordSha256s: new Map() };
      },
    });
    // A (pre-write) shows writes at revalidation: another mode.
    blockedAt(await f.run({ sessionDependencies: flipping(1, a!.remoteProjectId) as never }), "revalidate", a!.generationId, "revalidation-drift", "observed mode post-write");
    expectHeldAndPreserved(f);
    // B (post-write) changed between its export and its revalidation: the census, then the canonical delta, differs.
    reads = 0;
    blockedAt(await f.run({ sessionDependencies: flipping(1, b!.remoteProjectId) as never }), "revalidate", b!.generationId, "revalidation-drift", "census differs");
    reads = 0;
    deltaDrift = true;
    blockedAt(await f.run({ sessionDependencies: flipping(1, b!.remoteProjectId) as never }), "revalidate", b!.generationId, "revalidation-drift", "canonical delta differs");
    deltaDrift = false;
    // B's pending publish-rollback exists; a destination that moved (consistently) since no longer reproduces its witness.
    await crashAt(f, "after-install-record:" + a!.generationId);
    const sealed = f.liveCensus.get(b!.remoteProjectId)!;
    f.liveCensus.set(b!.remoteProjectId, sealed.map((entry) => ({ ...entry, prefixSha256: "9".repeat(64) })));
    blockedAt(await f.run(), "revalidate", b!.generationId, "pending-evidence-drift");
    f.liveCensus.set(b!.remoteProjectId, sealed);
    expectRolledBack(f, await f.run(), "held");
  });

  it("blocks on a failed install or sidecars, and on an installed database that no longer matches its record", async () => {
    const f = await rollbackFixture();
    const [a] = f.members;
    blockedAt(await f.run({ installGeneration: () => { throw new Error("rename failed"); } }), "install", a!.generationId, "install-failed", "rename failed");
    expectHeldAndPreserved(f);
    blockedAt(await f.run({ materializeSidecars: () => { throw new Error("archive mismatch"); } }), "install", a!.generationId, "install-failed", "archive mismatch");
    await crashAt(f, "after-install-record:" + a!.generationId);
    const path = join(lcmHomeDir(f.homeDir), "projects", a!.localProjectId, "db.sqlite");
    const installed = readFileSync(path);
    sqliteDatabase(path);
    blockedAt(await f.run(), "build", a!.generationId, "install-mismatch", "sidecar-complete");
    writeFileSync(path, installed, { mode: 0o600 });
    expectRolledBack(f, await f.run(), "held");
  });
});

describe("rollbackCutoverSet interruptions preserve evidence and republish nothing", () => {
  it("interrupts on an aborted or vanished rollback hold, a hold without its checkpoint and a hold of another shape", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-hold");
    const held = readBackendMaintenanceJournal(f.homeDir)!;
    await f.activation.coordinator().abortMaintenance({ expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "e".repeat(64) });
    interruption(await f.run(), "slot", "hold-aborted");
    expectAllPostgreSql(f);
    const g = await rollbackFixture();
    await crashAt(g, "after-hold");
    g.activation.rewriteJournal((payload) => { payload.sourceBackend = "sqlite"; });
    interruption(await g.run(), "slot", "journal-unexpected", "postgresql-origin");
    const directory = migrationCutoverSetRollbackDirectory(g.homeDir, g.originalSetId);
    g.activation.rewriteJournal((payload) => { payload.sourceBackend = "postgresql"; });
    chmodSync(directory, 0o700);
    const checkpoint = readFileSync(join(directory, "checkpoint.json"));
    rmSync(directory, { recursive: true, force: true });
    interruption(await g.run(), "slot", "state-unresolvable", "no rollback checkpoint");
    expect(checkpoint.length).toBeGreaterThan(0);
    const h = await rollbackFixture();
    await crashAt(h, "after-checkpoint");
    const journalPath = backendPublicationJournalPath(h.homeDir);
    const journal = readFileSync(journalPath);
    rmSync(journalPath);
    interruption(await h.run(), "slot", "hold-gone", "nothing");
    writeFileSync(journalPath, journal, { mode: 0o600 });
    expectRolledBack(h, await h.run(), "before-hold");
  });

  it("interrupts when the checkpointed evidence no longer matches: records, snapshot, head, artifact and live activation", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-checkpoint");
    const records = f.deps.readActivationRecords({ homeDir: f.homeDir, setId: f.originalSetId });
    if (records.state !== "resolved" || records.selection === null) throw new Error("records");
    interruption(await f.run({ readActivationRecords: () => ({ ...records, selection: { ...records.selection!, checksumSha256: "0".repeat(64) } }) }), "records", "evidence-conflict", "does not descend");
    f.snapshotOverride.set(f.members[0]!.generationId, { sourceByteWitnessSha256: "0".repeat(64) });
    interruption(await f.run(), "members", "evidence-conflict", "preserved snapshot differs");
    f.snapshotOverride.clear();
    const live = readBackendPublicationJournal(f.homeDir)!;
    interruption(await f.run({ readPublicationJournal: () => ({ ...live, checksumSha256: "0".repeat(64) }) }), "slot", "evidence-conflict", "not the one the rollback checkpoint recorded");
    interruption(await f.run({ readArtifact: () => null }), "artifact", "artifact-unresolvable", "absent");
    interruption(await f.run({ readArtifact: () => { throw new Error("unreadable"); } }), "artifact", "artifact-unresolvable", "unreadable");
    const checkpoint = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
    if (checkpoint.state !== "resolved") throw new Error("checkpoint");
    const sealed = f.deps.readArtifact({ homeDir: f.homeDir, identityDigest: checkpoint.checkpoint.identityDigest })!;
    interruption(await f.run({ readArtifact: () => ({ ...sealed, projects: sealed.projects.slice(0, 1) }) }), "artifact", "artifact-mismatch");
    interruption(await f.run({ readArtifact: () => ({ ...sealed, source: { ...sealed.source, config: { presence: "absent" } as never } }) }), "artifact", "artifact-unresolvable", "sealed no source");
    interruption(await f.run({ parseSealedStorageConfig: () => ({ backend: "sqlite" }) as never }), "artifact", "artifact-unresolvable", "does not select postgresql");
    // The settled head of a member moved after the checkpoint.
    const a = f.members[0]!;
    const store = f.deps.manifestStore;
    const moved = Object.assign(Object.create(store) as typeof store, { read: (id: string) => { const head = store.read(id); return id === a.generationId ? { ...head, revision: head.revision + 1 } : head; } });
    interruption(await f.run({ manifestStore: moved }), "settlement", "evidence-conflict", "settled active head");
    // Under the hold, the same moved head contradicts the checkpointed prepare input.
    await crashAt(f, "after-hold");
    interruption(await f.run({ manifestStore: moved }), "prepare", "evidence-conflict", "not the checkpointed one");
  });

  it("recovers an entering rollback hold before the barrier, and refuses or interrupts an entering hold it cannot own", async () => {
    const f = await rollbackFixture();
    await crashAt(f, "after-hold");
    f.activation.rewriteJournal((payload) => { payload.phase = "maintenance-entering"; });
    expect(readBackendMaintenanceJournal(f.homeDir)?.phase).toBe("maintenance-entering");
    expectRolledBack(f, await f.run(), "held");
    const g = await rollbackFixture();
    await crashAt(g, "after-hold");
    g.activation.rewriteJournal((payload) => { payload.phase = "maintenance-entering"; });
    interruption(await g.run({ readRollbackRecords: () => ({ state: "unresolvable", reason: "corrupt" }) }), "hold", "state-unresolvable", "unresolvable");
    const other = readCutoverSetRollbackRecords({ homeDir: g.homeDir, originalSetId: g.originalSetId });
    if (other.state !== "resolved") throw new Error("records");
    interruption(await g.run({ readRollbackRecords: () => ({ ...other, checkpoint: { ...other.checkpoint, manifest: { ...other.checkpoint.manifest, members: [...other.checkpoint.manifest.members].reverse() } } }) }), "hold", "journal-unexpected", "checkpointed manifest");
    const entering = readFileSync(backendPublicationJournalPath(g.homeDir));
    g.activation.rewriteJournal((payload) => { delete payload.cutoverSet; payload.generationId = "someone-else"; payload.publicationId = "someone-else"; });
    refusal(await g.run(), "slot", "maintenance-held-by-other", "someone-else");
    refusal(await g.run({ readMaintenanceJournal: () => { throw new Error("unreadable"); } }), "slot", "activation-unresolvable", "unreadable");
    writeFileSync(backendPublicationJournalPath(g.homeDir), entering, { mode: 0o600 });
    interruption(await g.run({ readArtifact: () => { throw new Error("unreadable artifact"); } }), "hold", "artifact-unresolvable", "unreadable artifact");
    interruption(await g.run({ createCoordinator: () => ({ enterMaintenance: async () => { throw new BackendPublicationJournalError("unexpected-state", "cas moved"); } }) as never }), "hold", "journal-unexpected", "cas moved");
  });
});

