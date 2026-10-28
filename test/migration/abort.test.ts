import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMigrationAbortGate,
  classifyMigrationAbortRefusal,
  completePendingMigrationAbort,
  performMigrationAbort,
} from "../../src/migration/abort.js";
import { MigrationManifestStore, migrationManifestGenerationDirectory } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  MigrationProtocolError,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  BackendPublicationCoordinator,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const CREATED_AT = "2026-08-12T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-abort-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function coordinatorFor(home: string): BackendPublicationCoordinator {
  const unexpected: BackendPublicationDriver["observeLocalState"] = async () => {
    throw new Error("v2 driver must not run for maintenance");
  };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected,
    publishProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
    publishConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreConfig: async () => { throw new Error("v2 driver must not run for maintenance"); },
    restoreProjectMap: async () => { throw new Error("v2 driver must not run for maintenance"); },
  };
  return new BackendPublicationCoordinator({ homeDir: home, driver });
}

async function heldJournal(home: string, generationId = "generation-1"): Promise<BackendMaintenanceJournal> {
  return coordinatorFor(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId,
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: MACHINE_ID, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

function manifest(generationId = "generation-1"): MigrationManifest {
  return createMigrationManifest({
    generationId,
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: CREATED_AT },
    destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: CREATED_AT },
    parentGenerationId: null,
    preservedSourceGenerationId: generationId,
    createdAt: CREATED_AT,
  });
}

describe("classifyMigrationAbortGate (section 4.6)", () => {
  it("is ready when the journal is not terminal, regardless of manifest state", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    expect(classifyMigrationAbortGate({ journalTerminal: false, generationId: "generation-1", manifestStore: store }))
      .toEqual({ status: "ready" });
  });

  it("is ready when the journal is terminal and the manifest is authoritatively absent (genesis never ran)", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    expect(classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store }))
      .toEqual({ status: "ready" });
  });

  it("refuses as an incomplete pair when the journal is terminal but the manifest is present and not settled (red: this is the exact disagreement section 4.6 exists to catch)", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    expect(result).toEqual({ status: "incomplete-pair", evidence: "manifest-ready" });
  });

  it("is ready when the journal is terminal and the manifest has independently reached a settled phase", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = manifest();
    store.create(planned);
    const begun = beginMigrationEffect(planned, { effectId: "e".repeat(64), kind: "abort", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", planned.checksumSha256, () => begun);
    const settled = completeMigrationEffect(begun, {
      effectId: "e".repeat(64),
      completedAt: CREATED_AT,
      report: { kind: "abort", reportId: "report-1", reportSha256: "9".repeat(64), createdAt: CREATED_AT },
    });
    store.update("generation-1", begun.checksumSha256, () => settled);
    expect(settled.phase).toBe("aborted");
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    expect(result).toEqual({ status: "ready" });
  });

  it("is unresolvable, never ready, when the manifest presence probe itself cannot be established", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    const migrations = join(home, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let result;
    try {
      result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: store });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-internal-error" });
  });
});

describe("performMigrationAbort (section 4.6, completes whichever write is missing, idempotent)", () => {
  it("completes a held journal with no manifest ever created (genesis never ran)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64),
    });
    expect(result).toEqual({ status: "completed", mutated: true });
  });

  it("completes both writes when the journal is held and the manifest is present but not settled", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);

    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(result).toEqual({ status: "completed", mutated: true });
    const settledManifest = store.read("generation-1");
    expect(settledManifest.phase).toBe("aborted");
    const settledJournal = readBackendMaintenanceJournal(home)!;
    expect(settledJournal.phase).toBe("maintenance-aborted");
  });

  it("proceeds on a settled head whose immediate successor is an unpublished empty directory (#1772)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    mkdirSync(join(migrationManifestGenerationDirectory("generation-1", home), "revisions", "0000000000000001"), { mode: 0o700 });

    const result = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
    });
    expect(result).toEqual({ status: "completed", mutated: true });
    expect(store.read("generation-1").phase).toBe("aborted");
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });

  it("still refuses before any journal write when the immediate successor already holds a manifest (#1772)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const initial = manifest();
    new MigrationManifestStore({ homeDir: home }).create(initial);
    const candidate = beginMigrationEffect(initial, {
      effectId: "e".repeat(64), kind: "verify-dry-run", inputSha256: "f".repeat(64), startedAt: CREATED_AT,
    });
    const crashing = new MigrationManifestStore({
      homeDir: home,
      observer: (event) => {
        if (event === "after-revision-publication") throw new Error("crash:orphan-successor");
      },
    });
    expect(() => crashing.update("generation-1", initial.checksumSha256, () => candidate)).toThrow("crash:orphan-successor");
    const journalBefore = readFileSync(backendPublicationJournalPath(home));

    const result = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: "c".repeat(64),
      manifestStore: new MigrationManifestStore({ homeDir: home }),
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-recovery-required", mutated: false });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
  });

  it("is idempotent under repetition once re-invoked with the already-terminal journal read fresh from disk (red: proven by a real second and third call, not asserted)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);

    const first = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(first).toEqual({ status: "completed", mutated: true });

    const aborted = readBackendMaintenanceJournal(home)!;
    expect(aborted.phase).toBe("maintenance-aborted");

    const second = await performMigrationAbort({ homeDir: home, coordinator, journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(second).toEqual({ status: "completed", mutated: false });
    const third = await performMigrationAbort({ homeDir: home, coordinator, journal: aborted, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(third).toEqual({ status: "completed", mutated: false });

    // Confirm repetition never re-touched either durable write: same journal
    // checksum, same manifest revision and checksum as after the first call.
    const stillAborted = readBackendMaintenanceJournal(home)!;
    expect(stillAborted.checksumSha256).toBe(aborted.checksumSha256);
    const stillSettled = store.read("generation-1");
    expect(stillSettled.revision).toBe(2);
  });

  it("dryRun reads and classifies everything but writes nothing: the journal and manifest stay byte-identical, and the same call without dryRun then completes", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read("generation-1").checksumSha256;

    const dry = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store, dryRun: true });
    expect(dry).toEqual({ status: "dry-run" });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read("generation-1").checksumSha256).toBe(manifestBefore);

    const real = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(real).toEqual({ status: "completed", mutated: true });
  });

  it("refuses rather than silently succeeding when the caller's in-hand journal is stale (a genuinely different on-disk state, not the idempotent case above)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    // held is now stale: the coordinator will refuse a second abortMaintenance
    // call built from it, because the real on-disk journal has moved on.
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });
    expect(result).toEqual({ status: "refuse", evidence: "journal-unexpected-state", mutated: false });
  });

  it("refuses a selection-completed journal (a successful cutover is not an abort target)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const prepared = await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: held.generationId,
      targetBackend: "postgresql", terminalEvidenceSha256: "c".repeat(64),
    });
    const completed = await coordinator.completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256, generationId: prepared.generationId,
      terminalEvidenceSha256: prepared.terminalEvidenceSha256!,
    });
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: completed, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-selection-completed", mutated: false });
  });

  it("refuses a selection-prepared journal (neither held/entering nor an abort target)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const prepared = await coordinator.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256, generationId: held.generationId,
      targetBackend: "postgresql", terminalEvidenceSha256: "c".repeat(64),
    });
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: prepared, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-selection-prepared", mutated: false });
  });

  it("refuses when abortMaintenance itself fails (stale expectedChecksumSha256)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const stale: BackendMaintenanceJournal = { ...held, checksumSha256: "f".repeat(64) };
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: stale, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-unexpected-state", mutated: false });
  });

  it("refuses when the manifest has a pending mid-flight effect rather than attempting to override resume's territory (copy-batch is authoritative-readback-required, classified as readback)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = manifest();
    store.create(planned);
    const dryRun = beginMigrationEffect(planned, { effectId: "e".repeat(64), kind: "verify-dry-run", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", planned.checksumSha256, () => dryRun);
    const dryRunDone = completeMigrationEffect(dryRun, {
      effectId: "e".repeat(64),
      completedAt: CREATED_AT,
      report: { kind: "dry-run", reportId: "report-1", reportSha256: "9".repeat(64), createdAt: CREATED_AT },
    });
    store.update("generation-1", dryRun.checksumSha256, () => dryRunDone);
    const copying = beginMigrationEffect(dryRunDone, { effectId: "d".repeat(64), kind: "copy-batch", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
    store.update("generation-1", dryRunDone.checksumSha256, () => copying);
    expect(copying.pendingEffect).not.toBeNull();

    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read("generation-1");

    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store });

    // A-1 (red first): the refusal must not have terminalized the journal.
    // Before the fix abortMaintenance ran first, leaving a terminal journal
    // paired with a manifest whose pending effect nothing could settle.
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read("generation-1").checksumSha256).toBe(manifestBefore.checksumSha256);
    // A-2: no durable write preceded this refusal, so none is claimed.
    expect(result).toEqual({ status: "refuse", evidence: "manifest-readback", mutated: false });
  });

  it("refuses when the manifest presence probe cannot be established", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const migrations = join(home, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    const coordinator = coordinatorFor(home);
    let result;
    try {
      result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64) });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: false });
  });
});

describe("abort.ts's non-protocol-error fallback branches (deterministic injection, per the sqlite-snapshot precedent: every real throw from these seams is provably a typed protocol error)", () => {
  it("classifyMigrationAbortGate: reports unresolvable when the manifest store's read throws an unrecognised error shape", () => {
    const home = makeHome();
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: fakeStore });
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-internal-error" });
  });

  it("performMigrationAbort: refuses with journal-internal-error when abortMaintenance throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const fakeCoordinator = {
      abortMaintenance: async () => { throw new Error("unrecognised failure"); },
    } as unknown as BackendPublicationCoordinator;
    const result = await performMigrationAbort({ homeDir: home, coordinator: fakeCoordinator, journal: held, abortEvidenceSha256: "c".repeat(64) });
    expect(result).toEqual({ status: "refuse", evidence: "journal-internal-error", mutated: false });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the manifest read throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: false });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when beginEffect throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { beginEffect: () => { throw new Error("unrecognised failure"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: true });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the first (begin) store.update throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new Error("unrecognised failure"); },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: true });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when completeEffect throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new Error("unrecognised failure"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: true });
  });

  it("performMigrationAbort: refuses with manifest-internal-error when the second (complete) store.update throws an unrecognised error shape", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    let updateCalls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: (id: string, checksum: string, reduce: (m: MigrationManifest) => MigrationManifest) => {
        updateCalls += 1;
        if (updateCalls === 2) throw new Error("unrecognised failure");
        return real.update(id, checksum, reduce);
      },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: true });
    expect(updateCalls).toBe(2);
  });
});

describe("abort.ts's protocol-error-instance branch, for the same fallback ternaries (the TRUE side of the same instanceof check)", () => {
  it("classifyMigrationAbortGate: preserves the MigrationProtocolError reason when the manifest store's read throws one", () => {
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new MigrationProtocolError("recovery-required", "test"); },
    } as unknown as MigrationManifestStore;
    const result = classifyMigrationAbortGate({ journalTerminal: true, generationId: "generation-1", manifestStore: fakeStore });
    expect(result).toEqual({ status: "unresolvable", evidence: "manifest-recovery-required" });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the manifest read throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const fakeStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new MigrationProtocolError("recovery-required", "test"); },
    } as unknown as MigrationManifestStore;
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-recovery-required", mutated: false });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when beginEffect throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { beginEffect: () => { throw new MigrationProtocolError("unexpected-state", "test"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state", mutated: true });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the first (begin) store.update throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new MigrationProtocolError("unexpected-state", "test"); },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state", mutated: true });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when completeEffect throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({
      homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: store,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "test"); } },
    });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state", mutated: true });
  });

  it("performMigrationAbort: preserves the MigrationProtocolError reason when the second (complete) store.update throws one", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest());
    let updateCalls = 0;
    const fakeStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: (id: string, checksum: string, reduce: (m: MigrationManifest) => MigrationManifest) => {
        updateCalls += 1;
        if (updateCalls === 2) throw new MigrationProtocolError("unexpected-state", "test");
        return real.update(id, checksum, reduce);
      },
    } as unknown as MigrationManifestStore;
    const coordinator = coordinatorFor(home);
    const result = await performMigrationAbort({ homeDir: home, coordinator, journal: held, abortEvidenceSha256: "c".repeat(64), manifestStore: fakeStore });
    expect(result).toEqual({ status: "refuse", evidence: "manifest-unexpected-state", mutated: true });
  });
});


describe("classifyMigrationAbortRefusal (classified by actual reason, never by throw-or-not)", () => {
  it("classifies journal-selection-prepared as abort-wrong-phase/precondition", () => {
    expect(classifyMigrationAbortRefusal("journal-selection-prepared")).toEqual({ reason: "abort-wrong-phase", class: "precondition" });
  });

  it("classifies journal-selection-completed as abort-wrong-phase/precondition", () => {
    expect(classifyMigrationAbortRefusal("journal-selection-completed")).toEqual({ reason: "abort-wrong-phase", class: "precondition" });
  });

  it("classifies journal-unexpected-state as abort-journal-moved/precondition (abortMaintenance's own CAS mismatch, the one reason it itself asserts as a precondition failure)", () => {
    expect(classifyMigrationAbortRefusal("journal-unexpected-state")).toEqual({ reason: "abort-journal-moved", class: "precondition" });
  });

  it("classifies journal-invalid-input as abort-invalid-input/unresumable (an internal defect, not an operator-fixable precondition)", () => {
    expect(classifyMigrationAbortRefusal("journal-invalid-input")).toEqual({ reason: "abort-invalid-input", class: "unresumable" });
  });

  it("classifies manifest-resume as abort-manifest-needs-resume/unresumable", () => {
    expect(classifyMigrationAbortRefusal("manifest-resume")).toEqual({ reason: "abort-manifest-needs-resume", class: "unresumable" });
  });

  it("classifies manifest-readback as abort-manifest-needs-resume/unresumable too (both are classifyMigrationRecovery's pending-effect answers, distinguished from each other only by whether resume can safely retry, which is irrelevant to a candidate that does not implement resume)", () => {
    expect(classifyMigrationAbortRefusal("manifest-readback")).toEqual({ reason: "abort-manifest-needs-resume", class: "unresumable" });
  });

  it.each([
    "journal-publication-evidence-missing",
    "journal-unsafe-storage",
    "journal-malformed-journal",
    "journal-checksum-mismatch",
    "journal-unresolved-publication",
    "journal-permit-mismatch",
    "journal-backend-mismatch",
    "journal-internal-error",
    "manifest-invalid-input",
    "manifest-malformed-manifest",
    "manifest-checksum-mismatch",
    "manifest-recovery-required",
    "manifest-unexpected-state",
    "manifest-internal-error",
    "manifest-not-a-real-manifest-reason",
  ])(
    "classifies every other evidence string (%s) as abort-unresolvable/evidence rather than guessing a precondition or contention (red: this is the safety default -- an unclassifiable failure must not be asserted as a conclusion)",
    (evidence) => {
      expect(classifyMigrationAbortRefusal(evidence)).toEqual({ reason: "abort-unresolvable", class: "evidence" });
    },
  );

  it("is a total function over any string, including one that shares no structure with a real evidence value", () => {
    expect(classifyMigrationAbortRefusal("")).toEqual({ reason: "abort-unresolvable", class: "evidence" });
    expect(classifyMigrationAbortRefusal("garbage")).toEqual({ reason: "abort-unresolvable", class: "evidence" });
  });
});

describe("completePendingMigrationAbort (owner ruling R10: completes the begun abort effect, never re-aborts the journal)", () => {
  const AT = new Date(CREATED_AT);
  const EVIDENCE = "c".repeat(64);

  /** A crash after the abort effect began: the journal is terminal and the manifest carries the real pending abort. */
  async function crashedAfterBegin(): Promise<{ home: string; store: MigrationManifestStore; aborted: BackendMaintenanceJournal }> {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest());
    const crashed = await performMigrationAbort({
      homeDir: home, coordinator: coordinatorFor(home), journal: held, abortEvidenceSha256: EVIDENCE, manifestStore: store, now: AT,
      _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "crash before completion"); } },
    });
    expect(crashed).toEqual({ status: "refuse", evidence: "manifest-unexpected-state", mutated: true });
    const aborted = readBackendMaintenanceJournal(home)!;
    expect(aborted.phase).toBe("maintenance-aborted");
    expect(store.read("generation-1").pendingEffect?.kind).toBe("abort");
    return { home, store, aborted };
  }

  it("completes the carried effect with exactly the completion an uninterrupted abort writes, and leaves the journal alone", async () => {
    const { home, store, aborted } = await crashedAfterBegin();
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const result = completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: store });
    expect(result).toEqual({ status: "completed", mutated: true });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);

    // The same abort, uninterrupted, in a twin home.
    const twinHome = makeHome();
    const twinHeld = await heldJournal(twinHome);
    const twinStore = new MigrationManifestStore({ homeDir: twinHome });
    twinStore.create(manifest());
    await performMigrationAbort({
      homeDir: twinHome, coordinator: coordinatorFor(twinHome), journal: twinHeld, abortEvidenceSha256: EVIDENCE, manifestStore: twinStore, now: AT,
    });
    const completed = store.read("generation-1");
    const uninterrupted = twinStore.read("generation-1");
    expect(completed.phase).toBe("aborted");
    expect(completed.pendingEffect).toBeNull();
    // The report reference is a function of the generation, the abort evidence and the effect's own timestamps only.
    expect(completed.reports).toEqual(uninterrupted.reports);
    expect(completed.updatedAt).toBe(uninterrupted.updatedAt);
  });

  it("dryRun makes every check and stops before the completing write, leaving the manifest byte-identical", async () => {
    const { home, store, aborted } = await crashedAfterBegin();
    const before = store.read("generation-1").checksumSha256;
    expect(completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: store, dryRun: true })).toEqual({ status: "dry-run" });
    expect(store.read("generation-1").checksumSha256).toBe(before);
    const other = { ...aborted, checksumSha256: "d".repeat(64) } as BackendMaintenanceJournal;
    expect(completePendingMigrationAbort({ homeDir: home, journal: other, manifestStore: store, dryRun: true }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
  });

  it("is a refusal, not a repeat, once nothing is pending: it writes nothing", async () => {
    const { home, store, aborted } = await crashedAfterBegin();
    completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: store });
    const before = store.read("generation-1").checksumSha256;
    expect(completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: store }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
    expect(store.read("generation-1").checksumSha256).toBe(before);
  });

  it("refuses a carried effect whose id is not the one an abort of this generation begins, writing nothing", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    const created = store.create(manifest());
    const aborted = await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: EVIDENCE,
    });
    store.update("generation-1", created.checksumSha256, (current) => beginMigrationEffect(current, {
      effectId: "some-other-effect", kind: "abort", inputSha256: aborted.checksumSha256, startedAt: CREATED_AT,
    }));
    const before = store.read("generation-1").checksumSha256;
    expect(completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: store }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
    expect(store.read("generation-1").checksumSha256).toBe(before);
  });

  it("refuses a carried effect begun over a different journal state (input digest mismatch), writing nothing", async () => {
    const { home, store, aborted } = await crashedAfterBegin();
    const before = store.read("generation-1").checksumSha256;
    const other = { ...aborted, checksumSha256: "d".repeat(64) } as BackendMaintenanceJournal;
    expect(completePendingMigrationAbort({ homeDir: home, journal: other, manifestStore: store }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
    expect(store.read("generation-1").checksumSha256).toBe(before);
  });

  it("refuses a journal that is not an aborted one with its own evidence", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    expect(completePendingMigrationAbort({ homeDir: home, journal: held }))
      .toEqual({ status: "refuse", evidence: "carried-effect-mismatch", mutated: false });
  });

  it("refuses with the manifest's protocol reason when the manifest cannot be read", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const aborted = await coordinatorFor(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: EVIDENCE,
    });
    const result = completePendingMigrationAbort({ homeDir: home, journal: aborted });
    expect(result.status).toBe("refuse");
    expect(result).toMatchObject({ mutated: false, evidence: expect.stringMatching(/^manifest-/u) });
  });

  it("reports a failure of the completing write with the manifest's reason, nothing applied", async () => {
    const { home, store, aborted } = await crashedAfterBegin();
    const failing = {
      read: (id: string) => store.read(id),
      update: () => { throw new Error("disk"); },
    } as unknown as MigrationManifestStore;
    expect(completePendingMigrationAbort({ homeDir: home, journal: aborted, manifestStore: failing }))
      .toEqual({ status: "refuse", evidence: "manifest-internal-error", mutated: false });
  });

  it("classifies its carried-effect refusal as evidence", () => {
    expect(classifyMigrationAbortRefusal("carried-effect-mismatch")).toEqual({ reason: "abort-carried-effect-mismatch", class: "evidence" });
  });
});

