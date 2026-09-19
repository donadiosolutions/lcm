import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendPublicationCoordinator,
  backendPublicationJournalPath,
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
  normalizeHomeDirForPayload,
  type ActivationQuiescenceResult,
} from "../../src/migration/activation-quiescence.js";
import { canonicalSha256 } from "../../src/storage/portable-record.js";

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
