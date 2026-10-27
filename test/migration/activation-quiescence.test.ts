import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendPublicationCoordinator,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  rebindBackendMaintenanceCutoff,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
  type BackendPublicationLockToken,
  type BackendMaintenanceRosterEntry,
} from "../../src/storage/backend-publication.js";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  machineIdentityPath,
} from "../../src/machine-identity.js";
import {
  checkActivationWriterQuiescence,
  checkCutoverSetActivationWriterQuiescence,
  normalizeHomeDirForPayload,
  type ActivationQuiescenceResult,
} from "../../src/migration/activation-quiescence.js";
import { canonicalSha256 } from "../../src/storage/portable-record.js";
import { cutoverSetMaintenanceEntry } from "../../src/migration/cutover-set.js";
import { SET_MACHINE_ID, setManifest } from "../fixtures/cutover-set.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-quiescence-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: unexpected,
    publishConfig: unexpected,
    restoreConfig: unexpected,
    restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const MACHINE_A = "018f0b5d-1234-7abc-8def-1234567890ab";
const MACHINE_B = "018f0b5d-5678-7abc-8def-1234567890ab";

async function enterMaintenanceWithRoster(
  homeDir: string,
  roster: readonly BackendMaintenanceRosterEntry[],
): Promise<void> {
  await coordinator(homeDir).enterMaintenance({
    publicationId: "migration-generation-1",
    generationId: "generation-1",
    sourceSelectionSha256: HASH_A,
    queueEvidenceSha256: HASH_B,
    roster,
    now: new Date("2026-09-19T00:00:00.000Z"),
  });
}

function registerMachine(homeDir: string, machineId: string): void {
  const pending = ensurePendingMachineIdentity("Test Machine", homeDir).identity;
  finalizeMachineIdentity(pending, machineId, "Test Machine", homeDir);
}

/** Drive a freshly entered (maintenance-held) journal to a later phase. */
async function advanceMaintenance(
  homeDir: string,
  phase: "maintenance-aborted" | "selection-prepared" | "selection-completed",
): Promise<void> {
  const subject = coordinator(homeDir);
  const held = subject.inspectMaintenance()!;
  if (phase === "maintenance-aborted") {
    await subject.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: HASH_A,
      abortEvidenceSha256: HASH_B,
    });
    return;
  }
  const prepared = await subject.prepareMaintenanceSelection({
    expectedChecksumSha256: held.checksumSha256,
    generationId: "generation-1",
    targetBackend: "postgresql",
    terminalEvidenceSha256: HASH_B,
  });
  if (phase === "selection-prepared") return;
  await subject.completeMaintenanceSelection({
    expectedChecksumSha256: prepared.checksumSha256,
    generationId: "generation-1",
    terminalEvidenceSha256: HASH_B,
  });
}

/**
 * checkActivationWriterQuiescence requires an already-active append-barrier
 * lockToken (see the module's precondition). Every test acquires that
 * barrier for real via withBackendPublicationAppendBarrierAsync, exactly as
 * a real activation orchestrator would, then hands the active token in.
 */
function checkUnderBarrier(
  homeDir: string,
  overrides: { now?: () => Date } = {},
): Promise<ActivationQuiescenceResult> {
  return withBackendPublicationAppendBarrierAsync(homeDir, (token: BackendPublicationLockToken) =>
    checkActivationWriterQuiescence({ homeDir, lockToken: token }, overrides));
}

describe("checkActivationWriterQuiescence", () => {
  it("is unsatisfied when no maintenance journal exists", async () => {
    const homeDir = home();
    const result = await checkUnderBarrier(homeDir);
    expect(result).toMatchObject({
      status: "unsatisfied",
      reason: "maintenance-journal-absent",
      quiescenceFence: null,
    });
  });

  it("is unresolvable when the maintenance journal cannot be read (genuine EACCES fixture, barrier already held)", async () => {
    const homeDir = home();
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const journalPath = backendPublicationJournalPath(homeDir);
    // Acquire the barrier first (journal still readable), THEN make the
    // journal unreadable. This proves the barrier this module reuses does
    // not itself re-validate maintenance readiness on every call -- only
    // this module's own attributed read observes the failure.
    const result = await withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
      chmodSync(journalPath, 0o000);
      try {
        return await checkActivationWriterQuiescence({ homeDir, lockToken: token });
      } finally {
        chmodSync(journalPath, 0o600);
      }
    });
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("maintenance-journal-unresolvable");
    expect(result.quiescenceFence).toBeNull();
  });

  it("is unsatisfied and refuses outright when the roster spans more than one machine", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
      { machineId: MACHINE_B, queueCutoff: "0000000000000000013", evidenceSha256: HASH_B },
    ]);
    const result = await checkUnderBarrier(homeDir);
    expect(result).toMatchObject({
      status: "unsatisfied",
      reason: "roster-not-single-machine",
      quiescenceFence: null,
    });
  });

  it.each(["maintenance-aborted", "selection-prepared", "selection-completed"] as const)(
    "is unsatisfied with maintenance-not-held when the journal is in phase %s, even for a matching one-machine roster",
    async (phase) => {
      const homeDir = home();
      registerMachine(homeDir, MACHINE_A);
      await enterMaintenanceWithRoster(homeDir, [
        { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
      ]);
      await advanceMaintenance(homeDir, phase);
      expect(coordinator(homeDir).inspectMaintenance()?.phase).toBe(phase);
      const result = await checkUnderBarrier(homeDir);
      expect(result).toMatchObject({
        status: "unsatisfied",
        reason: "maintenance-not-held",
        quiescenceFence: null,
      });
      expect(result.detail).toContain(phase);
    },
  );

  it("checks the maintenance phase before the roster test", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
      { machineId: MACHINE_B, queueCutoff: "0000000000000000013", evidenceSha256: HASH_B },
    ]);
    await advanceMaintenance(homeDir, "maintenance-aborted");
    const result = await checkUnderBarrier(homeDir);
    expect(result.reason).toBe("maintenance-not-held");
  });

  it("is unresolvable when this machine has no registered identity", async () => {
    const homeDir = home();
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const result = await checkUnderBarrier(homeDir);
    expect(result).toMatchObject({
      status: "unresolvable",
      reason: "machine-identity-unavailable",
      quiescenceFence: null,
    });
  });

  it("is unresolvable when this machine's identity registration is pending", async () => {
    const homeDir = home();
    ensurePendingMachineIdentity("Test Machine", homeDir);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const result = await checkUnderBarrier(homeDir);
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("machine-identity-unavailable");
    expect(result.detail).toMatch(/pending/);
  });

  it("is unresolvable when the machine identity file cannot be read (genuine EACCES fixture)", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const identityPath = machineIdentityPath(homeDir);
    chmodSync(identityPath, 0o000);
    try {
      const result = await checkUnderBarrier(homeDir);
      expect(result.status).toBe("unresolvable");
      expect(result.reason).toBe("machine-identity-unavailable");
      expect(result.detail).toMatch(/permission/);
    } finally {
      chmodSync(identityPath, 0o600);
    }
  });

  it("is unsatisfied when the single-machine roster does not cover this machine", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_B, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const result = await checkUnderBarrier(homeDir);
    expect(result).toMatchObject({
      status: "unsatisfied",
      reason: "roster-row-absent",
      quiescenceFence: null,
    });
  });

  it("is satisfied and seals a replayable quiescenceFence when the roster covers exactly this machine", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const result = await checkUnderBarrier(homeDir, { now: () => new Date("2026-09-19T05:00:00.000Z") });
    expect(result.status).toBe("satisfied");
    expect(result.reason).toBe("quiescence-observed");
    const fence = result.quiescenceFence;
    if (fence === null) throw new Error("expected a quiescenceFence");
    expect(fence.version).toBe(1);
    expect(fence.kind).toBe("lcm-activation-writer-quiescence-v1");
    expect(fence.evidenceSha256).toBe(canonicalSha256({
      version: fence.version,
      kind: fence.kind,
      payload: fence.payload,
    }));
    const payload = JSON.parse(fence.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 1,
      homeDir,
      machineId: MACHINE_A,
      observedAt: "2026-09-19T05:00:00.000Z",
      generationId: "generation-1",
      rosterRow: { queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    });
    const reach = payload.reach as Record<string, unknown>;
    expect(reach.pointCheck).toBe(true);
    expect(reach.scope).toBe("local-sqlite-writers-through-shared-append-barrier");
    expect(reach.excludes).toEqual(expect.arrayContaining([
      expect.stringContaining("another machine"),
      expect.stringContaining("psql"),
    ]));
  });

  it("defaults observedAt to the real clock when now is not overridden", async () => {
    const homeDir = home();
    registerMachine(homeDir, MACHINE_A);
    await enterMaintenanceWithRoster(homeDir, [
      { machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A },
    ]);
    const before = Date.now();
    const result = await checkUnderBarrier(homeDir);
    const after = Date.now();
    expect(result.status).toBe("satisfied");
    const payload = JSON.parse((result.quiescenceFence as { payload: string }).payload) as { observedAt: string };
    const observedAtMs = Date.parse(payload.observedAt);
    expect(observedAtMs).toBeGreaterThanOrEqual(before);
    expect(observedAtMs).toBeLessThanOrEqual(after);
  });

  it("propagates an unrecognized maintenance-journal read failure unchanged (injected: the real" +
    " reader always normalizes non-ENOENT failures into BackendPublicationJournalError, so no" +
    " genuine fixture can drive readBackendMaintenanceJournal to throw any other error type;" +
    " this exercises this module's own defensive classifier branch instead)", async () => {
    const homeDir = home();
    const boom = new Error("unexpected journal reader failure");
    await expect(withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
      checkActivationWriterQuiescence(
        { homeDir, lockToken: token },
        { readMaintenanceJournal: () => { throw boom; } },
      ))).rejects.toThrow(boom);
  });
});

describe("normalizeHomeDirForPayload", () => {
  it("falls back to null for an omitted homeDir -- tested directly rather than through the full" +
    " check, because exercising this branch there would require operating against the real" +
    " ambient home directory, which these tests must never touch", () => {
    expect(normalizeHomeDirForPayload(undefined)).toBeNull();
  });

  it("passes an explicit homeDir through unchanged", () => {
    expect(normalizeHomeDirForPayload("/tmp/example-home")).toBe("/tmp/example-home");
  });
});


// ---------------------------------------------------------------------------
// #1549: the set-aware entry point, one member at a time.
// ---------------------------------------------------------------------------

describe("checkCutoverSetActivationWriterQuiescence", () => {
  const MEMBER_1 = "member-generation-1";
  const MEMBER_2 = "member-generation-2";

  async function enterSet(homeDir: string, machineId = SET_MACHINE_ID) {
    const manifest = { ...setManifest(2), machineId };
    const held = await coordinator(homeDir).enterMaintenance({ ...cutoverSetMaintenanceEntry(manifest), now: new Date("2026-09-19T00:00:00.000Z") });
    return held;
  }

  /** Capture one member: rebind its sentinel to a real cutoff under the barrier. */
  function bindMember(homeDir: string, generationId: string, machineId = SET_MACHINE_ID) {
    return withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
      const journal = readBackendMaintenanceJournal(homeDir)!;
      const view = resolveBackendMaintenanceGenerationBinding(journal, generationId)!;
      return rebindBackendMaintenanceCutoff({
        homeDir, expectedChecksumSha256: view.checksumSha256, generationId, sourceSelectionSha256: view.sourceSelectionSha256,
        queueEvidenceSha256: HASH_B, roster: [{ machineId, queueCutoff: "0000000000000000007", evidenceSha256: HASH_B }],
      }, token);
    });
  }

  function checkMember(homeDir: string, generationId: string, overrides: { now?: () => Date } = {}): Promise<ActivationQuiescenceResult> {
    return withBackendPublicationAppendBarrierAsync(homeDir, (token: BackendPublicationLockToken) =>
      checkCutoverSetActivationWriterQuiescence({ homeDir, lockToken: token, generationId }, overrides));
  }

  it("seals one envelope per captured member from that member's own view, never the sentinel roster", async () => {
    const homeDir = home();
    registerMachine(homeDir, SET_MACHINE_ID);
    await enterSet(homeDir);
    await bindMember(homeDir, MEMBER_1);
    const bound = await bindMember(homeDir, MEMBER_2);
    const now = () => new Date("2026-09-19T00:00:05.000Z");
    const first = await checkMember(homeDir, MEMBER_1, { now });
    const second = await checkMember(homeDir, MEMBER_2, { now });
    for (const [result, generationId] of [[first, MEMBER_1], [second, MEMBER_2]] as const) {
      expect(result).toMatchObject({ status: "satisfied", reason: "quiescence-observed" });
      expect(result.detail).toContain(generationId);
      const view = resolveBackendMaintenanceGenerationBinding(bound, generationId)!;
      const payload = JSON.parse(result.quiescenceFence!.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        version: 1, homeDir, machineId: SET_MACHINE_ID, observedAt: "2026-09-19T00:00:05.000Z", generationId,
        maintenanceChecksumSha256: view.checksumSha256,
        rosterRow: { queueCutoff: "0000000000000000007", evidenceSha256: HASH_B },
      });
      expect(payload.maintenanceChecksumSha256).not.toBe(bound.checksumSha256);
      expect(payload.generationId).not.toBe(bound.generationId);
      expect(result.quiescenceFence!.evidenceSha256).toBe(canonicalSha256({ version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: result.quiescenceFence!.payload }));
    }
    expect(first.quiescenceFence!.evidenceSha256).not.toBe(second.quiescenceFence!.evidenceSha256);
    // The single-generation check still refuses the set outright.
    expect(await checkUnderBarrier(homeDir)).toMatchObject({ status: "unsatisfied", reason: "cutover-set-unsupported", quiescenceFence: null });
  });

  it("refuses a member that was not captured (sentinel cutoff), a non-member and the set id itself", async () => {
    const homeDir = home();
    registerMachine(homeDir, SET_MACHINE_ID);
    const held = await enterSet(homeDir);
    await bindMember(homeDir, MEMBER_1);
    expect(await checkMember(homeDir, MEMBER_2)).toMatchObject({ status: "unsatisfied", reason: "cutover-set-member-unbound", detail: expect.stringContaining("entry sentinel"), quiescenceFence: null });
    expect(await checkMember(homeDir, "generation-9")).toMatchObject({ status: "unsatisfied", reason: "cutover-set-member-unbound", detail: expect.stringContaining("not a member"), quiescenceFence: null });
    expect(await checkMember(homeDir, held.generationId)).toMatchObject({ status: "unsatisfied", reason: "cutover-set-member-unbound", quiescenceFence: null });
    expect(await checkMember(homeDir, MEMBER_1)).toMatchObject({ status: "satisfied" });
  });

  it("shares the journal, phase and machine attribution with the single-generation check", async () => {
    const absent = home();
    expect(await checkMember(absent, MEMBER_1)).toMatchObject({ status: "unsatisfied", reason: "maintenance-journal-absent" });
    const single = home();
    registerMachine(single, MACHINE_A);
    await enterMaintenanceWithRoster(single, [{ machineId: MACHINE_A, queueCutoff: "0000000000000000012", evidenceSha256: HASH_A }]);
    expect(await checkMember(single, "generation-1")).toMatchObject({ status: "unsatisfied", reason: "cutover-set-absent", quiescenceFence: null });
    const aborted = home();
    registerMachine(aborted, SET_MACHINE_ID);
    const held = await enterSet(aborted);
    await coordinator(aborted).abortMaintenance({ expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: HASH_B });
    expect(await checkMember(aborted, MEMBER_1)).toMatchObject({ status: "unsatisfied", reason: "maintenance-not-held" });
    const unregistered = home();
    await enterSet(unregistered);
    await bindMember(unregistered, MEMBER_1);
    expect(await checkMember(unregistered, MEMBER_1)).toMatchObject({ status: "unresolvable", reason: "machine-identity-unavailable" });
    const other = home();
    registerMachine(other, MACHINE_B);
    await enterSet(other);
    await bindMember(other, MEMBER_1);
    expect(await checkMember(other, MEMBER_1)).toMatchObject({ status: "unsatisfied", reason: "roster-row-absent", detail: expect.stringContaining(MACHINE_B) });
    const unreadable = home();
    registerMachine(unreadable, SET_MACHINE_ID);
    await enterSet(unreadable);
    const journalPath = backendPublicationJournalPath(unreadable);
    const result = await withBackendPublicationAppendBarrierAsync(unreadable, async (token) => {
      chmodSync(journalPath, 0o000);
      try {
        return await checkCutoverSetActivationWriterQuiescence({ homeDir: unreadable, lockToken: token, generationId: MEMBER_1 });
      } finally {
        chmodSync(journalPath, 0o600);
      }
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "maintenance-journal-unresolvable" });
  });
});

