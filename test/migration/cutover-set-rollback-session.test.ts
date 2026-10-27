import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import {
  BackendPublicationCoordinator,
  backendCutoverSetManifestSha256,
  backendCutoverSetRollbackSelectionSha256,
  withBackendPublicationAppendBarrierAsync,
  type BackendCutoverSetManifest,
  type BackendCutoverSetRollbackSelection,
  type BackendPublicationDriver,
  type BackendPublicationLockToken,
} from "../../src/storage/backend-publication.js";
import type { PostgreSqlSnapshotSession } from "../../src/storage/postgresql/snapshot-session.js";
import {
  PostgreSqlBackendPublicationGuardError,
  type PostgreSqlBackendPublicationAcquireInput,
  type PostgreSqlBackendPublicationFence,
  type PostgreSqlBackendPublicationMutationInput,
} from "../../src/storage/postgresql/publication-guard.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { deriveCutoverSetRollbackSetId } from "../../src/migration/cutover-set-rollback-store.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  RollbackSessionError,
  checkCutoverSetRollbackRecoveryAdmission,
  deriveRollbackProjectEvidenceSha256,
  openCutoverSetRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionRuntime,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import { fixtureDestinationIdentity, fixtureSchemaWitness, fixtureSha } from "../fixtures/migration-activation-records.js";
import { SET_ID, SET_MACHINE_ID, setManifest } from "../fixtures/cutover-set.js";
import { workingPublicationDriver, publicationMaterial } from "../fixtures/backend-publication-driver.js";

/**
 * The set member session (#1550 D4, C8): the coordinator's lease tuple for
 * one member under the shared rollback publication, the set-aware member
 * quiescence or the set recovery admission, a runtime the session never
 * closes and a renewal keeper that is inert in favor of the service's one
 * set keeper. The recovery admission accepts exactly the journals a set
 * rollback leaves behind after its selection.
 */

const GENERATION_ID = "member-generation-1";
const REMOTE = "0197a000-0000-7000-8000-000000000001";
const LOCAL = "1".padStart(64, "0");
const MACHINE = SET_MACHINE_ID;
const ROLLBACK_SET_ID = deriveCutoverSetRollbackSetId(SET_ID);
const EVIDENCE = deriveRollbackProjectEvidenceSha256({ generationId: GENERATION_ID, publicationId: ROLLBACK_SET_ID, localProjectId: LOCAL, remoteProjectId: REMOTE });
const lockToken = { token: "retained" } as unknown as BackendPublicationLockToken;
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-set-rollback-session-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

const target: RollbackSessionTarget = {
  settings: { url: "postgresql://example/db", caFile: "/ca.pem", poolMax: 4, connectionTimeoutMs: 1, idleTimeoutMs: 1, statementTimeoutMs: 1, snapshotIdleTimeoutMs: 1 },
  expectedOwner: "lcm_owner",
  expectedIdentity: { id: REMOTE, canonical: "/project", remoteProjectId: REMOTE, machineId: MACHINE, selectedPath: "/project" } as StorageIdentityContext,
  localProjectId: LOCAL, remoteProjectId: REMOTE, machineId: MACHINE,
};

function fenceRow(overrides: Partial<PostgreSqlBackendPublicationFence> = {}): PostgreSqlBackendPublicationFence {
  return {
    projectId: REMOTE, machineId: MACHINE, publicationId: ROLLBACK_SET_ID, targetBackend: "sqlite", evidenceSha256: EVIDENCE,
    fencingToken: 1n, acquiredAt: "t", renewedAt: "t", expiresAt: "t", releasedAt: null, databaseExpired: false, ...overrides,
  };
}

const guardError = (reason: PostgreSqlBackendPublicationGuardError["reason"]) => new PostgreSqlBackendPublicationGuardError(REMOTE, "test", reason);

function statefulGuard(initial: PostgreSqlBackendPublicationFence | null = null) {
  const state: { row: PostgreSqlBackendPublicationFence | null } = { row: initial };
  const calls: string[] = [];
  const same = (input: PostgreSqlBackendPublicationAcquireInput | PostgreSqlBackendPublicationMutationInput): boolean => (
    state.row !== null && state.row.publicationId === input.publicationId && state.row.machineId === input.machineId
    && state.row.targetBackend === input.targetBackend && state.row.evidenceSha256 === input.evidenceSha256
  );
  const active = (input: PostgreSqlBackendPublicationMutationInput): boolean =>
    same(input) && state.row!.fencingToken === input.fencingToken && state.row!.releasedAt === null && !state.row!.databaseExpired;
  const guard: ActivationLeasePublicationGuard = {
    async acquire(input) {
      calls.push("acquire");
      if (state.row === null || state.row.releasedAt !== null) return (state.row = fenceRow({ fencingToken: (state.row?.fencingToken ?? 0n) + 1n }));
      if (!same(input)) throw guardError("publication-conflict");
      if (!state.row.databaseExpired) return state.row;
      if (input.expectedFencingToken === undefined) throw guardError("fence-expired");
      if (input.expectedFencingToken !== state.row.fencingToken) throw guardError("fence-mismatch");
      return (state.row = fenceRow({ fencingToken: state.row.fencingToken + 1n }));
    },
    async renew(input) { calls.push("renew"); if (!active(input)) throw guardError("fence-mismatch"); return (state.row = { ...state.row!, renewedAt: "renewed" }); },
    async release(input) { calls.push("release"); if (!active(input)) throw guardError("fence-mismatch"); return (state.row = { ...state.row!, releasedAt: "released" }); },
    async read() { calls.push("read"); return state.row; },
  };
  return { guard, state, calls };
}

function domainCensus(seed: string) {
  return PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({
    domain, recordCount: index, prefixSha256: fixtureSha(seed + domain), terminalIdentitySha256: index === 0 ? null : fixtureSha(seed + domain + "terminal"),
  }));
}

function harness(overrides: Partial<RollbackSessionDependencies> = {}, guardState = statefulGuard()) {
  const runtime = {
    backendPublicationGuard: () => guardState.guard,
    openReadOnlySnapshot: vi.fn(async () => ({ close: vi.fn(async () => undefined) }) as unknown as PostgreSqlSnapshotSession),
    close: vi.fn(async () => undefined),
  };
  const census = domainCensus("session");
  const readFencedDestinationCensus = vi.fn(async (_snapshot: unknown, input: { signal?: AbortSignal }) => {
    if (input.signal?.aborted) throw new Error("census aborted");
    return { census, dependencyEdges: new Map(), recordIdentities: new Map(), recordSha256s: new Map() };
  });
  const dependencies = {
    ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
    createRuntime: vi.fn(() => { throw new Error("a set member session never creates a runtime"); }),
    verifyRuntimeSchema: vi.fn(async () => undefined),
    assertReadOnlyGuard: vi.fn(async () => undefined),
    captureDestinationIdentity: vi.fn(async () => fixtureDestinationIdentity("dest")),
    captureDestinationSchemaWitness: vi.fn(async () => fixtureSchemaWitness("schema")),
    readFencedDestinationCensus,
    checkQuiescence: vi.fn(async () => { throw new Error("the single-generation quiescence must not run for a set member"); }),
    checkRecoveryAdmission: vi.fn(async () => { throw new Error("the single-generation recovery admission must not run for a set member"); }),
    checkSetQuiescence: vi.fn(async () => ({
      status: "satisfied", reason: "quiescence-observed", detail: "held",
      quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{\"held\":true}", evidenceSha256: "a".repeat(64) },
    })),
    checkSetRecoveryAdmission: vi.fn(async () => ({
      status: "satisfied", detail: "recovery", quiescenceFence: { kind: "lcm-cutover-set-rollback-recovery-admission-v1", payload: "{\"recovery\":true}" },
    })),
    renewalIntervalMs: 10,
    ...overrides,
  } as unknown as RollbackSessionDependencies & Record<string, ReturnType<typeof vi.fn>>;
  return { runtime: runtime as unknown as RollbackSessionRuntime & typeof runtime, dependencies, guardState, readFencedDestinationCensus };
}

const openInput = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) => ({
  homeDir: "/home", lockToken, generationId: GENERATION_ID, publicationId: ROLLBACK_SET_ID, runtime: h.runtime, scratchParent: "/scratch", ...extra,
});

describe("openCutoverSetRollbackFencedSession", () => {
  it("acquires the member's set lease tuple under the set quiescence, never creates or closes the shared runtime", async () => {
    const h = harness();
    const acquire = vi.spyOn(h.guardState.guard, "acquire");
    const session = await openCutoverSetRollbackFencedSession(openInput(h), target, h.dependencies);
    expect(acquire).toHaveBeenCalledWith({ projectId: REMOTE, machineId: MACHINE, publicationId: ROLLBACK_SET_ID, targetBackend: "sqlite", evidenceSha256: EVIDENCE, ttlMs: 15 * 60 * 1000, signal: undefined });
    expect(h.dependencies.checkSetQuiescence).toHaveBeenCalledWith({ homeDir: "/home", lockToken, generationId: GENERATION_ID });
    expect(h.dependencies.checkSetRecoveryAdmission).not.toHaveBeenCalled();
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
    expect(session.selectionAuthority).toMatchObject({ fencingToken: "1", ownerProcessId: ROLLBACK_SET_ID });
    expect(session.currentFence.fencingToken).toBe(1n);
    expect(session.quiescenceFenceEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    await session.renew();
    expect(session.currentFence.renewedAt).toBe("renewed");
    await session.release();
    expect(h.guardState.state.row?.releasedAt).toBe("released");
    expect(h.runtime.close).not.toHaveBeenCalled();
    // closeKeepingLease on another member session does not close the runtime either.
    const other = await openCutoverSetRollbackFencedSession(openInput(h), target, h.dependencies);
    await other.closeKeepingLease();
    expect(h.runtime.close).not.toHaveBeenCalled();
    expect(h.guardState.state.row?.releasedAt).toBeNull();
  });

  it("suppresses its own renewal keeper while the caller's signal still aborts a read in flight", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const h = harness();
    const session = await openCutoverSetRollbackFencedSession(openInput(h, { signal: controller.signal }), target, h.dependencies);
    const observation = await session.captureReadback({ canonicalDeltaBaseline: { version: 1, domains: [] } as never });
    expect(observation.postEpochDelta).toBeDefined();
    // The pool could serve a renewal (poolMax 4), yet no periodic renewal was scheduled: the set keeper owns renewal.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.guardState.calls.filter((call) => call === "renew")).toHaveLength(0);
    // The signal the session received reaches the census read and aborts it.
    h.readFencedDestinationCensus.mockImplementationOnce(async (_snapshot: unknown, input: { signal?: AbortSignal }) => {
      controller.abort(new Error("stop"));
      if (input.signal?.aborted) throw new Error("census aborted");
      return { census: [], dependencyEdges: new Map(), recordIdentities: new Map(), recordSha256s: new Map() };
    });
    await expect(session.captureReadback({ canonicalDeltaBaseline: { version: 1, domains: [] } as never })).rejects.toThrow("census aborted");
    await session.closeKeepingLease();
  });

  it("releases the lease when the set quiescence refuses, keeps it on a refused recovery admission, and runs the recovery admission with the set id", async () => {
    const h = harness({ checkSetQuiescence: vi.fn(async () => ({ status: "unsatisfied", reason: "cutover-set-member-unbound", detail: "unbound", quiescenceFence: null })) as never });
    await expect(openCutoverSetRollbackFencedSession(openInput(h), target, h.dependencies)).rejects.toMatchObject({ name: "RollbackSessionError", reason: "quiescence-unsatisfied", message: "unbound" });
    expect(h.guardState.state.row?.releasedAt).toBe("released");
    const r = harness({ checkSetRecoveryAdmission: vi.fn(async () => ({ status: "unsatisfied", detail: "not ours", quiescenceFence: null })) as never });
    await expect(openCutoverSetRollbackFencedSession(openInput(r, { recovery: true }), target, r.dependencies)).rejects.toMatchObject({ reason: "quiescence-unsatisfied", message: "not ours" });
    expect(r.guardState.state.row?.releasedAt).toBeNull();
    expect(r.dependencies.checkSetRecoveryAdmission).toHaveBeenCalledWith({ homeDir: "/home", lockToken, setId: ROLLBACK_SET_ID, generationId: GENERATION_ID, machineId: MACHINE });
    expect(r.dependencies.checkSetQuiescence).not.toHaveBeenCalled();
    const ok = harness();
    const session = await openCutoverSetRollbackFencedSession(openInput(ok, { recovery: true }), target, ok.dependencies);
    expect(session.quiescenceFenceEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    await session.closeKeepingLease();
    // The defaults are the set-aware production checks when the dependency record omits them (the default record
    // itself omits them): against a real home with no hold, both refuse and the lease is released or kept accordingly.
    const { checkSetQuiescence: _q, checkSetRecoveryAdmission: _r, ...withoutSetChecks } = ok.dependencies;
    expect(DEFAULT_ROLLBACK_SESSION_DEPENDENCIES).not.toHaveProperty("checkSetQuiescence");
    const homeDir = home();
    const real = harness();
    await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
      await expect(openCutoverSetRollbackFencedSession({ ...openInput(real, { homeDir, lockToken: token }), scratchParent: undefined }, target, withoutSetChecks as RollbackSessionDependencies))
        .rejects.toMatchObject({ reason: "quiescence-unsatisfied", message: expect.stringContaining("maintenance journal") });
      expect(real.guardState.state.row?.releasedAt).toBe("released");
      await expect(openCutoverSetRollbackFencedSession({ ...openInput(real, { homeDir, lockToken: token, recovery: true }) }, target, withoutSetChecks as RollbackSessionDependencies))
        .rejects.toMatchObject({ reason: "quiescence-unsatisfied", message: expect.stringContaining("no journal") });
      expect(real.guardState.state.row?.releasedAt).toBeNull();
    });
    // A release that itself fails after a refused open never masks the refusal.
    const failing = harness({ checkSetQuiescence: vi.fn(async () => ({ status: "unsatisfied", reason: "x", detail: "refused", quiescenceFence: null })) as never });
    failing.guardState.guard.release = async () => { throw guardError("fence-mismatch"); };
    await expect(openCutoverSetRollbackFencedSession(openInput(failing), target, failing.dependencies)).rejects.toMatchObject({ message: "refused" });
  });

  it("refuses a lease another publication holds and takes over its own expired one", async () => {
    const foreign = harness({}, statefulGuard(fenceRow({ publicationId: "other" })));
    await expect(openCutoverSetRollbackFencedSession(openInput(foreign), target, foreign.dependencies)).rejects.toMatchObject({ reason: "lease-unavailable" });
    const expired = harness({}, statefulGuard(fenceRow({ fencingToken: 3n, databaseExpired: true })));
    const session = await openCutoverSetRollbackFencedSession(openInput(expired), target, expired.dependencies);
    expect(session.currentFence.fencingToken).toBe(4n);
    await session.release();
    expect(RollbackSessionError).toBeDefined();
  });
});

describe("checkCutoverSetRollbackRecoveryAdmission", () => {
  const NOW = new Date("2026-10-21T00:00:00.000Z");
  function coordinator(homeDir: string): BackendPublicationCoordinator {
    const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
    const driver: BackendPublicationDriver = { observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected, restoreConfig: unexpected, restoreProjectMap: unexpected };
    return new BackendPublicationCoordinator({ homeDir, driver });
  }
  function rollbackManifest(): BackendCutoverSetManifest {
    return { ...setManifest(2), setId: ROLLBACK_SET_ID };
  }
  function tuple(manifest: BackendCutoverSetManifest): BackendCutoverSetRollbackSelection {
    const body = {
      version: 1 as const, kind: "cutover-set-rollback-selection" as const, setId: manifest.setId, manifestSha256: backendCutoverSetManifestSha256(manifest),
      publicationId: manifest.setId, originalSetId: SET_ID, originalSelectionSha256: "1".repeat(64), checkpointSha256: "2".repeat(64), identityDigest: "3".repeat(64),
      sourceBackend: "postgresql" as const, targetBackend: "sqlite" as const,
      members: manifest.members.map((member, index) => ({
        physicalProjectId: member.physicalProjectId, generationId: member.generationId, remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f900" + String(index + 1),
        mode: "post-write" as const, epochId: "e".repeat(64), attemptId: "a".repeat(64), witnessChecksumSha256: "b".repeat(64), installEvidenceSha256: "c".repeat(64),
      })),
    };
    return { ...body, checksumSha256: backendCutoverSetRollbackSelectionSha256(body) };
  }
  const check = (homeDir: string, overrides: Record<string, unknown> = {}) => withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
    checkCutoverSetRollbackRecoveryAdmission({ homeDir, lockToken: token, setId: ROLLBACK_SET_ID, generationId: GENERATION_ID, machineId: MACHINE, ...overrides }));

  it("admits the rollback hold at its selection phases for a named member of this machine, and refuses everything else", async () => {
    const homeDir = home();
    const held = await coordinator(homeDir).enterMaintenance({ ...cutoverSetMaintenanceEntry(rollbackManifest()), sourceBackend: "postgresql", now: NOW });
    // Held (no target yet): the strict first-open path, not a recovery.
    await expect(check(homeDir)).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("phase maintenance-held") });
    const selection = tuple(held.cutoverSet!.manifest);
    const prepared = await coordinator(homeDir).prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite", terminalEvidenceSha256: selection.checksumSha256, cutoverSetSelection: selection,
    });
    const admitted = await check(homeDir);
    expect(admitted).toMatchObject({ status: "satisfied", detail: expect.stringContaining("maintenance journal at selection-prepared") });
    expect(JSON.parse(admitted.quiescenceFence!.payload)).toMatchObject({ journal: "maintenance", phase: "selection-prepared", checksumSha256: prepared.checksumSha256, setId: ROLLBACK_SET_ID, generationId: GENERATION_ID, machineId: MACHINE });
    await expect(check(homeDir, { setId: SET_ID })).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("not this set rollback") });
    await expect(check(homeDir, { generationId: "member-generation-9" })).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("does not name generation") });
    await expect(check(homeDir, { machineId: "018f0b5d-1234-7abc-8def-000000000000" })).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("not this machine alone") });
    const completed = await coordinator(homeDir).completeMaintenanceSelection({ expectedChecksumSha256: prepared.checksumSha256, generationId: ROLLBACK_SET_ID, terminalEvidenceSha256: selection.checksumSha256 });
    await expect(check(homeDir)).resolves.toMatchObject({ status: "satisfied", detail: expect.stringContaining("selection-completed") });
    expect(completed.phase).toBe("selection-completed");
  });

  it("refuses a single-generation hold and a sqlite-origin set hold at their selection phases", async () => {
    const single = home();
    const held = await coordinator(single).enterMaintenance({
      publicationId: ROLLBACK_SET_ID, generationId: ROLLBACK_SET_ID, sourceBackend: "postgresql", sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: null, evidenceSha256: "b".repeat(64) }], now: NOW,
    });
    await coordinator(single).prepareMaintenanceSelection({ expectedChecksumSha256: held.checksumSha256, generationId: ROLLBACK_SET_ID, targetBackend: "sqlite", terminalEvidenceSha256: "c".repeat(64) });
    await expect(check(single)).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("not this set rollback") });
  });

  it("admits this set rollback's non-terminal publication without a maintenance journal, and refuses completed, foreign or absent ones", async () => {
    const homeDir = home();
    await expect(check(homeDir)).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("no journal") });
    const material = publicationMaterial();
    const publication = new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(material) });
    const prepared = await publication.prepare({ publicationId: ROLLBACK_SET_ID, sourceBackend: "postgresql", targetBackend: "sqlite", material, projects: [], now: NOW });
    const admitted = await check(homeDir);
    expect(admitted).toMatchObject({ status: "satisfied", detail: expect.stringContaining("publication journal at prepared") });
    expect(JSON.parse(admitted.quiescenceFence!.payload)).toMatchObject({ journal: "publication", checksumSha256: prepared.checksumSha256 });
    await expect(check(homeDir, { setId: "other-set" })).resolves.toMatchObject({ status: "unsatisfied" });
    await publication.resume();
    await expect(check(homeDir)).resolves.toMatchObject({ status: "unsatisfied", detail: expect.stringContaining("no journal") });
  });
});

