import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { performMigrationAbort } from "../../src/migration/abort.js";
import { renderMigrationAbortEnvelope } from "../../src/migration/cli-render.js";
import {
  createFixtureManifest,
  fixtureVerificationReport,
  heldFixtureJournal,
  maintenanceCoordinator,
  makeFixtureHome,
  removeFixtureHomes,
  snapshotHome,
  type FixtureManifestOptions,
  type FixtureStage,
} from "./existing-fixtures.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  MigrationProtocolError,
  type MigrationEffectKind,
  type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  BackendPublicationCoordinator,
  backendPublicationCanonicalSha256,
  backendPublicationJournalPath,
  readBackendMaintenanceJournal,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";

/**
 * Every call goes through the router now, which consults the snapshot class.
 * These fixtures hold a complete snapshot, the state every manifest-bearing
 * generation is in (a manifest exists only after capture completed).
 */
const completeSnapshot = async () => ({ state: "complete" as const, witness: {} as never });
function abortCommand(input: Parameters<typeof performMigrationAbortCommand>[0]) {
  return performMigrationAbortCommand({
    ...input,
    _resolution: {
      ...input._resolution,
      _operationsForTesting: { classifySnapshot: completeSnapshot, ...input._resolution?._operationsForTesting },
    },
  });
}

const roots: string[] = [];
const MACHINE_ID = "018f0b5d-1234-4abc-8def-1234567890ab";
const CREATED_AT = "2026-08-12T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-cli-abort-"));
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

describe("performMigrationAbortCommand: real end-to-end paths", () => {
  it("aborts a real held journal for real, manifestPhase null (genesis never ran) -- the exit-0 postcondition is a real readback, not a trusted return value", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true });
    // Positive control: the real journal really is terminal on disk.
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });

  it("aborts a real held journal with a real planned manifest (router row 19), settling the manifest and reading its phase back from real durable state", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
  });

  it("is idempotent for real: aborting an already-aborted generation still reports ok with the same readback", async () => {
    const home = makeHome();
    await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const first = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    const second = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    // Same readback, but a repeat finds both writes already made: nothing was applied.
    expect(second).toEqual({ ...first, applied: false });
    expect(first).toMatchObject({ applied: true });
  });
});

describe("performMigrationAbortCommand: a copy effect that begins after routing (synthesis S3)", () => {
  it("answers exit 6 naming resume when a copy effect begins between the router's read and abort's own manifest read", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    const planned = manifest(held.generationId);
    store.create(planned);
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store,
      _operationsForTesting: {
        performAbort: async (input) => {
          const dryRun = beginMigrationEffect(planned, { effectId: "e".repeat(64), kind: "verify-dry-run", inputSha256: "f".repeat(64), startedAt: CREATED_AT });
          store.update("generation-1", planned.checksumSha256, () => dryRun);
          const dryRunDone = completeMigrationEffect(dryRun, {
            effectId: "e".repeat(64), completedAt: CREATED_AT,
            report: { kind: "dry-run", reportId: "report-1", reportSha256: "9".repeat(64), createdAt: CREATED_AT },
          });
          store.update("generation-1", dryRun.checksumSha256, () => dryRunDone);
          store.update("generation-1", dryRunDone.checksumSha256, () =>
            beginMigrationEffect(dryRunDone, { effectId: "d".repeat(64), kind: "copy-batch", inputSha256: "f".repeat(64), startedAt: CREATED_AT }));
          return performMigrationAbort(input);
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-manifest-needs-resume", evidence: "manifest-readback", next: "resume" });
    expect(renderMigrationAbortEnvelope(result)).toMatchObject({ exitCode: 6, outcome: "incomplete-recoverable", next: "resume" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });
});

describe("performMigrationAbortCommand: the boundary catch (round-1 B-4)", () => {
  it("maps an unknown throw from the journal readback to unexpected-failure, reporting applied:true since a write may already have happened", async () => {
    const home = makeHome();
    await heldJournal(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1", homeDir: home, coordinator: coordinatorFor(home),
      _operationsForTesting: { readJournal: () => { throw new TypeError("boom with /a/path"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "TypeError", applied: true });
    // The abort itself did complete; the boundary reported what it could not rule out.
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
  });
});

describe("performMigrationAbortCommand: refusal paths", () => {
  it("refuses publication-occupies-slot when injected observation reports a v2 publication journal", async () => {
    const home = makeHome();
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      _operationsForTesting: { observeJournal: () => ({ kind: "publication", publicationId: "publication-1", phase: "preparing" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "publication-occupies-slot" });
  });

  it("refuses journal-unresolvable, carrying the observation's evidence", async () => {
    const home = makeHome();
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      _operationsForTesting: { observeJournal: () => ({ kind: "unresolvable", evidence: "journal-checksum-mismatch" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "journal-unresolvable", evidence: "journal-checksum-mismatch" });
  });

  it("refuses abort-nothing-to-abort for a real absent journal (no injection: a genuinely fresh home with nothing to abort)", async () => {
    const home = makeHome();
    const result = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home });
    expect(result).toEqual({ status: "refuse", reason: "abort-nothing-to-abort" });
  });

  it("classifies a refused performMigrationAbort result through classifyMigrationAbortRefusal, carrying the raw evidence alongside the classified reason", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "refuse", evidence: "journal-unexpected-state", mutated: false }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-journal-moved", evidence: "journal-unexpected-state" });
  });

  it("refuses abort-readback-mismatch when performAbort reports completed but the real journal is not actually terminal (injected readJournal, proving the postcondition is a genuine re-read rather than trusting the return value)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
        readJournal: () => held, // still "maintenance-held", not terminal
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it.each([
    ["a later generation's aborted journal", (held: BackendMaintenanceJournal) => ({ ...held, phase: "maintenance-aborted" as const, generationId: "generation-2" })],
    ["this generation's completed selection", (held: BackendMaintenanceJournal) => ({ ...held, phase: "selection-completed" as const })],
    ["another generation's completed selection", (held: BackendMaintenanceJournal) => ({ ...held, phase: "selection-completed" as const, generationId: "generation-2" })],
  ])("refuses abort-readback-mismatch when the readback is %s rather than this generation's maintenance-aborted journal (Codex PR #1653: any terminal journal must not pass)", async (_name, replace) => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1", homeDir: home, coordinator: coordinatorFor(home),
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
        readJournal: () => replace(held),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-readback-mismatch when the readback journal is entirely absent despite performAbort reporting completed", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
        readJournal: () => null,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-unresolvable when the manifest presence probe cannot be established on readback (a real terminal journal from a prior real abort, then an injected unresolvable manifestStore for the readback itself -- proving this is a distinct check from performMigrationAbort's own internal one, not merely unreachable code)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const coordinator = coordinatorFor(home);
    // Real abort first, so the journal is genuinely terminal on disk.
    const real = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator });
    expect(real.status).toBe("ok");
    const unresolvableStore = {
      probeManifestPresence: () => ({ status: "unresolvable" as const, reason: "internal-error" }),
    } as unknown as MigrationManifestStore;
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: unresolvableStore,
      // The router reads the real (absent) manifest; only the read-back sees the injected store.
      _resolution: { manifestStore: new MigrationManifestStore({ homeDir: home }) },
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-internal-error", applied: true });
  });

  it("refuses abort-unresolvable when reading the present manifest throws on readback (a real terminal journal from a prior real abort, plus a real manifest present, then an injected read failure for the readback step specifically)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    const real = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(real.status).toBe("ok");
    const throwingStore = {
      probeManifestPresence: () => store.probeManifestPresence(held.generationId),
      read: () => { throw new MigrationProtocolError("checksum-mismatch", "test"); },
    } as unknown as MigrationManifestStore;
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: throwingStore,
      // The router sees the planned manifest the held journal implies; only the read-back sees the injected store.
      _resolution: { manifestStore: { probeManifestPresence: () => ({ status: "present" as const }), read: () => manifest(held.generationId) } as unknown as MigrationManifestStore },
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-checksum-mismatch", applied: true });
  });

  it("refuses abort-readback-mismatch when the present manifest reads back as not settled, after a real terminal journal (an unexpected disagreement performMigrationAbort itself would not have produced, isolated from the journal-not-terminal case by first making the journal genuinely terminal for real)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    // Real abort first (against a genesis-absent state), so the journal is
    // genuinely terminal on disk -- isolating this test to the manifest
    // disagreement specifically, not the journal-not-terminal case.
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256,
      sourceSelectionSha256: held.sourceSelectionSha256,
      abortEvidenceSha256: "c".repeat(64),
    });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: store,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch", applied: true });
  });

  it("refuses abort-unresolvable with manifest-internal-error evidence when reading the present manifest throws a non-MigrationProtocolError on readback", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const coordinator = coordinatorFor(home);
    const real = await abortCommand({ confirmGenerationId: "generation-1", homeDir: home, coordinator, manifestStore: store });
    expect(real.status).toBe("ok");
    const throwingStore = {
      probeManifestPresence: () => store.probeManifestPresence(held.generationId),
      read: () => { throw new Error("an unrelated internal failure"); },
    } as unknown as MigrationManifestStore;
    const result = await abortCommand({
      confirmGenerationId: "generation-1",
      homeDir: home,
      coordinator,
      manifestStore: throwingStore,
      // The router sees the planned manifest the held journal implies; only the read-back sees the injected store.
      _resolution: { manifestStore: { probeManifestPresence: () => ({ status: "present" as const }), read: () => manifest(held.generationId) } as unknown as MigrationManifestStore },
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: true }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-internal-error", applied: true });
  });
});
function pendingCopyBatchManifest(store: MigrationManifestStore): MigrationManifest {
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
  return copying;
}

describe("performMigrationAbortCommand: the confirmation fence (plan section 9, round-1 B-1/A-10)", () => {
  it("an omitted token refuses abort-confirmation-missing, names the live generation, and leaves journal and manifest bytes identical", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;

    const result = await abortCommand({ homeDir: home, coordinator: coordinatorFor(home), manifestStore: store });

    expect(result).toEqual({ status: "refuse", reason: "abort-confirmation-missing", generationId: held.generationId });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });

  it("a mismatched token refuses abort-confirmation-moved and leaves journal and manifest bytes identical", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;

    const result = await abortCommand({
      confirmGenerationId: "some-other-generation", homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "refuse", reason: "abort-confirmation-moved", generationId: held.generationId });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);
  });

  it("positive control: the matching token performs the same abort for real", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));

    const result = await abortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
  });
});

describe("performMigrationAbortCommand: --dry-run (round-1 B-1/A-10)", () => {
  it("runs every read, reports applied:false, and leaves journal and manifest bytes identical; the real run afterwards does the work", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    store.create(manifest(held.generationId));
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const manifestBefore = store.read(held.generationId).checksumSha256;
    const coordinator = coordinatorFor(home);

    const dry = await abortCommand({
      confirmGenerationId: held.generationId, dryRun: true, homeDir: home, coordinator, manifestStore: store,
    });
    expect(dry).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-held", manifestPhase: null, applied: false });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).checksumSha256).toBe(manifestBefore);

    const real = await abortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator, manifestStore: store,
    });
    expect(real).toMatchObject({ status: "ok", applied: true, manifestPhase: "aborted" });
  });

  it("refuses with the class the real run would get when the manifest has a pending copy effect", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    pendingCopyBatchManifest(store);

    const dry = await abortCommand({
      confirmGenerationId: held.generationId, dryRun: true, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });
    // Router row 21 with a pending copy effect: abort is a non-owner and names resume (exit 6).
    expect(dry).toEqual({ status: "refuse", reason: "route-resume-required", generationId: held.generationId, next: "resume" });
  });

  it("still enforces the fence under --dry-run", async () => {
    const home = makeHome();
    await heldJournal(home);
    const dry = await abortCommand({ dryRun: true, homeDir: home, coordinator: coordinatorFor(home) });
    expect(dry).toMatchObject({ status: "refuse", reason: "abort-confirmation-missing" });
  });
});

describe("performMigrationAbortCommand: applied tracks whether a durable write preceded the refusal (round-1 A-2/B-6)", () => {
  it("a refusal after the journal was terminalized reports applied:true (the manifest write fails)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const real = new MigrationManifestStore({ homeDir: home });
    real.create(manifest(held.generationId));
    const failingStore = {
      probeManifestPresence: (id: string) => real.probeManifestPresence(id),
      read: (id: string) => real.read(id),
      update: () => { throw new MigrationProtocolError("unexpected-state", "test"); },
    } as unknown as MigrationManifestStore;

    const result = await abortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: failingStore,
    });

    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
    expect(result).toEqual({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state", applied: true });
  });

  it("a readback refusal after an idempotent repeat that wrote nothing reports no applied flag either", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const result = await abortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home),
      _operationsForTesting: {
        observeJournal: () => ({ kind: "hold", journal: held }),
        performAbort: async () => ({ status: "completed", mutated: false }),
        readJournal: () => held, // still "maintenance-held", not terminal
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "abort-readback-mismatch" });
  });

  it("a refusal before any write reports no applied flag (the pending-effect refusal leaves the journal held)", async () => {
    const home = makeHome();
    const held = await heldJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    pendingCopyBatchManifest(store);

    const result = await abortCommand({
      confirmGenerationId: held.generationId, homeDir: home, coordinator: coordinatorFor(home), manifestStore: store,
    });

    expect(result).toEqual({ status: "refuse", reason: "route-resume-required", generationId: held.generationId, next: "resume" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });
});

describe("performMigrationAbortCommand: routed through rows 4 to 9 and the R7 rows (plan-v5 Part B (1))", () => {
  const AT = new Date(CREATED_AT);
  const fx = { roots: [] as string[] };
  afterEach(() => removeFixtureHomes(fx.roots));

  /** A held journal and a real manifest at `stage`; optionally already aborted (the journal side only). */
  async function crashFixture(stage: FixtureStage | null, options: { abortJournal?: boolean; pending?: MigrationEffectKind; manifest?: FixtureManifestOptions } = {}) {
    const home = makeFixtureHome(fx.roots);
    const held = await heldFixtureJournal(home);
    const store = new MigrationManifestStore({ homeDir: home });
    if (stage !== null) createFixtureManifest(store, stage, { ...(options.pending === undefined ? {} : { pending: options.pending }), ...options.manifest });
    const aborted = options.abortJournal === true ? await abortedFromHeld(home, held) : null;
    return { home, held, store, aborted };
  }

  async function abortedFromHeld(home: string, held: BackendMaintenanceJournal): Promise<BackendMaintenanceJournal> {
    return maintenanceCoordinator(home).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: "c".repeat(64),
    });
  }

  const noAbortMaintenance = (home: string): BackendPublicationCoordinator => {
    const real = maintenanceCoordinator(home);
    return new Proxy(real, {
      get(target, property, receiver) {
        if (property === "abortMaintenance") return () => { throw new Error("abortMaintenance must not be called again"); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };

  describe.each<[string, FixtureStage]>([
    ["19 (planned, nothing pending)", "planned"],
    ["21 (dry-run-verified, nothing pending)", "dry-run-verified"],
    ["21 (copying, nothing pending)", "copying"],
    ["22 (copied, nothing pending; owner ruling R7)", "copied"],
  ])("owner ruling R7, row %s", (_label, stage) => {
    it("abort settles both sides: the journal terminal and the manifest aborted, both read back", async () => {
      const { home, held, store } = await crashFixture(stage);
      const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, now: AT });
      expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
      expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-aborted");
      expect(store.read(held.generationId).phase).toBe("aborted");
    });
  });

  it("row 20 (pending verify-dry-run): abort is a non-owner, exits 6 naming resume, and changes nothing", async () => {
    const { home, held } = await crashFixture("planned", { pending: "verify-dry-run" });
    const before = snapshotHome(home);
    const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
    expect(result).toEqual({ status: "refuse", reason: "route-resume-required", generationId: held.generationId, next: "resume" });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("row 23 (pending verify-generation): abort is a non-owner, exits 6 naming verify, and changes nothing", async () => {
    const report = fixtureVerificationReport();
    const { home, held } = await crashFixture("copied", { pending: "verify-generation", manifest: { report } });
    const before = snapshotHome(home);
    const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
    expect(result).toEqual({ status: "refuse", reason: "route-resume-required", generationId: held.generationId, next: "verify" });
    expect(snapshotHome(home)).toEqual(before);
  });

  describe("row 5 (owner ruling R8): idempotent, read-only confirmation of a settled pair", () => {
    it("with the manifest never created: no write, exit 0 with applied:false, and a second invocation agrees", async () => {
      const { home, held } = await crashFixture(null);
      const first = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
      expect(first).toMatchObject({ status: "ok", applied: true, manifestPhase: null });
      const before = snapshotHome(home);
      const second = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
      const third = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
      expect(second).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: null, applied: false });
      expect(third).toEqual(second);
      expect(snapshotHome(home)).toEqual(before);
    });

    it("with a settled aborted manifest: no write, the settled pair is read back, and the second invocation returns the same", async () => {
      const { home, held } = await crashFixture("copied");
      await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, now: AT });
      const before = snapshotHome(home);
      const again = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, coordinator: noAbortMaintenance(home) });
      expect(again).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: false });
      expect(snapshotHome(home)).toEqual(before);
    });

    it("still requires the confirmation token", async () => {
      const { home, held } = await crashFixture(null, { abortJournal: true });
      const before = snapshotHome(home);
      expect(await abortCommand({ homeDir: home })).toEqual({ status: "refuse", reason: "abort-confirmation-missing", generationId: held.generationId });
      expect(snapshotHome(home)).toEqual(before);
    });
  });

  describe("row 6 (owner ruling R10): completes the carried abort effect without aborting the journal again", () => {
    async function crashedAfterBegin() {
      const fixture = await crashFixture("copied");
      await performMigrationAbort({
        homeDir: fixture.home, coordinator: maintenanceCoordinator(fixture.home), journal: fixture.held,
        abortEvidenceSha256: "c".repeat(64), manifestStore: fixture.store, now: AT,
        _operationsForTesting: { completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "crash before completion"); } },
      });
      expect(fixture.store.read(fixture.held.generationId).pendingEffect?.kind).toBe("abort");
      return fixture;
    }

    it("completes the pair, applied:true, with the journal bytes unchanged", async () => {
      const { home, held, store } = await crashedAfterBegin();
      const journalBefore = readFileSync(backendPublicationJournalPath(home));
      const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, coordinator: noAbortMaintenance(home) });
      expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
      expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
      expect(store.read(held.generationId).pendingEffect).toBeNull();
    });

    it("--dry-run makes the checks and writes nothing", async () => {
      const { home, held } = await crashedAfterBegin();
      const before = snapshotHome(home);
      const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, dryRun: true });
      expect(result).toMatchObject({ status: "ok", applied: false });
      expect(snapshotHome(home)).toEqual(before);
    });

    it("a carried effect that is not this generation's abort writes nothing and refuses exit 5", async () => {
      const home = makeFixtureHome(fx.roots);
      const held = await heldFixtureJournal(home);
      const store = new MigrationManifestStore({ homeDir: home });
      createFixtureManifest(store, "copied", { pending: "abort", pendingEffectId: "not-the-abort-effect" });
      await abortedFromHeld(home, held);
      const before = snapshotHome(home);
      const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
      expect(result).toEqual({ status: "refuse", reason: "abort-carried-effect-mismatch", evidence: "carried-effect-mismatch" });
      expect(snapshotHome(home)).toEqual(before);
    });
  });

  it("row 8 (the crash after abortMaintenance, before the manifest abort began): completes the manifest side without aborting the journal again", async () => {
    const { home, held, store } = await crashFixture("copied", { abortJournal: true });
    const journalBefore = readFileSync(backendPublicationJournalPath(home));
    const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, coordinator: noAbortMaintenance(home), now: AT });
    expect(result).toEqual({ status: "ok", generationId: held.generationId, journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
    expect(readFileSync(backendPublicationJournalPath(home)).equals(journalBefore)).toBe(true);
    expect(store.read(held.generationId).phase).toBe("aborted");
  });

  describe("a retry after an interrupted abort seals the journal's persisted evidence (Bug #1659)", () => {
    // The journal stamps its own clock, so the twin homes only agree byte-for-byte under a pinned Date.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(AT);
    });
    afterEach(() => vi.useRealTimers());

    const crashing = (operations: Parameters<typeof performMigrationAbort>[0]["_operationsForTesting"]) => ({
      performAbort: (input: Parameters<typeof performMigrationAbort>[0]) => performMigrationAbort({ ...input, _operationsForTesting: operations }),
    });
    const uninterrupted = async (): Promise<MigrationManifest> => {
      const { home, held, store } = await crashFixture("copied");
      expect(await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, now: AT })).toMatchObject({ status: "ok", applied: true });
      return store.read(held.generationId);
    };

    it("row 8: the retry seals the manifest to journal.abortEvidenceSha256, byte-identical to an uninterrupted run", async () => {
      const expected = await uninterrupted();
      const { home, held, store } = await crashFixture("copied");
      // The first abort terminalizes the journal, then dies before the manifest's abort effect begins.
      expect(await abortCommand({
        homeDir: home, confirmGenerationId: held.generationId, now: AT,
        _operationsForTesting: crashing({ beginEffect: () => { throw new MigrationProtocolError("unexpected-state", "crash before begin"); } }),
      })).toMatchObject({ status: "refuse", applied: true });
      const aborted = readBackendMaintenanceJournal(home)!;
      expect([aborted.phase, store.read(held.generationId).phase]).toEqual(["maintenance-aborted", "copied"]);
      // The retry's caller digests the aborted journal, which is not the evidence the journal persisted.
      expect(backendPublicationCanonicalSha256({
        version: 1, kind: "migration-abort-cli-request", generationId: aborted.generationId, checksumSha256: aborted.checksumSha256,
      })).not.toBe(aborted.abortEvidenceSha256);

      expect(await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, coordinator: noAbortMaintenance(home), now: AT }))
        .toMatchObject({ status: "ok", applied: true });
      const settled = store.read(held.generationId);
      expect(settled).toEqual(expected);
      expect(settled.reports.find((report) => report.kind === "abort")!.reportSha256).toBe(backendPublicationCanonicalSha256({
        version: 1, kind: "migration-abort-report", generationId: held.generationId,
        abortEvidenceSha256: aborted.abortEvidenceSha256, completedAt: AT.toISOString(),
      }));
    });

    it("row 6: a retry that completes the carried effect seals the same evidence", async () => {
      const expected = await uninterrupted();
      const { home, held, store } = await crashFixture("copied");
      expect(await abortCommand({
        homeDir: home, confirmGenerationId: held.generationId, now: AT,
        _operationsForTesting: crashing({ completeEffect: () => { throw new MigrationProtocolError("unexpected-state", "crash before completion"); } }),
      })).toMatchObject({ status: "refuse", applied: true });
      expect(store.read(held.generationId).pendingEffect?.kind).toBe("abort");
      expect(await abortCommand({ homeDir: home, confirmGenerationId: held.generationId, coordinator: noAbortMaintenance(home) }))
        .toMatchObject({ status: "ok", applied: true });
      expect(store.read(held.generationId)).toEqual(expected);
    });
  });

  it("row 7 (aborted journal beside a pending copy effect): operator required, exit 7, nothing changed", async () => {
    const { home, held } = await crashFixture("copying", { pending: "complete-copy", abortJournal: true });
    const before = snapshotHome(home);
    const result = await abortCommand({ homeDir: home, confirmGenerationId: held.generationId });
    expect(result).toEqual({ status: "refuse", reason: "route-operator-required", generationId: held.generationId, next: null });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("row 9 (aborted journal beside an active manifest): refuses exit 5 and never calls performMigrationAbort (S4-3)", async () => {
    const { home, held } = await crashFixture("verified", { abortJournal: true });
    const store = new MigrationManifestStore({ homeDir: home });
    const current = store.read(held.generationId);
    // An active manifest cannot be built through the abort-capable phases, so route a fabricated one.
    const performAbort = vi.fn();
    const completePending = vi.fn();
    const result = await abortCommand({
      homeDir: home, confirmGenerationId: held.generationId,
      _resolution: { manifestStore: { probeManifestPresence: () => ({ status: "present" as const }), read: () => ({ ...current, phase: "active" }) } as unknown as MigrationManifestStore },
      _operationsForTesting: { performAbort, completePending },
    });
    expect(result).toEqual({ status: "refuse", reason: "route-contradiction", generationId: held.generationId, next: null });
    expect(performAbort).not.toHaveBeenCalled();
    expect(completePending).not.toHaveBeenCalled();
  });

  it("a terminal journal of another generation is refused exit 2 when a different --generation is named, writing nothing", async () => {
    const { home, held, store } = await crashFixture("copied", { abortJournal: true });
    createFixtureManifest(store, "copied", { generationId: "generation-9" });
    const before = snapshotHome(home);
    const result = await abortCommand({ homeDir: home, generation: "generation-9", confirmGenerationId: "generation-9" });
    expect(result).toEqual({ status: "refuse", reason: "abort-other-generation", generationId: held.generationId });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("row 4: naming another generation while a hold is live acts on the live hold, confirmed by the live hold's id", async () => {
    const { home, held, store } = await crashFixture(null);
    // The other generation exists: an earlier, settled one with its own manifest.
    createFixtureManifest(store, "rolled-back", { generationId: "generation-9" });
    const wrong = await abortCommand({ homeDir: home, generation: "generation-9", confirmGenerationId: "generation-9" });
    expect(wrong).toEqual({ status: "refuse", reason: "abort-confirmation-moved", generationId: held.generationId });
    const right = await abortCommand({ homeDir: home, generation: "generation-9", confirmGenerationId: held.generationId });
    expect(right).toMatchObject({ status: "ok", generationId: held.generationId, applied: true });
  });

  it("naming a generation nothing records refuses generation-unknown and leaves the live hold alone (Codex PR #1653: a stranger's hold is not this id's evidence)", async () => {
    const { home, held } = await crashFixture(null);
    expect(await abortCommand({ homeDir: home, generation: "generation-9", confirmGenerationId: held.generationId }))
      .toEqual({ status: "refuse", reason: "generation-unknown" });
    expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");
  });

  it("passes a malformed --generation through as the resolver's usage refusal", async () => {
    const { home, held } = await crashFixture(null);
    expect(await abortCommand({ homeDir: home, generation: "../x", confirmGenerationId: held.generationId }))
      .toEqual({ status: "refuse", reason: "generation-invalid" });
  });
});

