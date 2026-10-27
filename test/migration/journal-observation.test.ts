import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeMigrationMaintenanceJournal,
  type MigrationJournalObservation,
} from "../../src/migration/journal-observation.js";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  backendPublicationDirectory,
  backendPublicationJournalPath,
  backendPublicationMaterialWitness,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  type BackendPublicationDriver,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-journal-observation-"));
  roots.push(home);
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  return home;
}

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode: 0o600,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

/**
 * Writes a durable v2 publication journal at phase "preparing" and stops
 * there. `prepare()` writes the journal (via the driver's observeLocalState
 * only) before it seals or authenticates material, so a driver that only
 * implements observeLocalState is enough to get a real, on-disk v2 journal;
 * the caller's material is deliberately inconsistent so prepare() throws
 * immediately afterward at the material-authentication step, which this
 * fixture expects and swallows because only the durable journal write
 * matters here.
 */
async function writeV2PublicationFixture(home: string): Promise<void> {
  const materialInput: BackendPublicationRecoveryMaterial = {
    source: { config: recoveryFile('{"backend":"sqlite"}'), projectMap: recoveryFile('{"projects":[]}') },
    target: { config: recoveryFile('{"backend":"postgresql"}'), projectMap: recoveryFile('{"projects":["remote"]}') },
  };
  const targetWitness = backendPublicationMaterialWitness({ source: materialInput.target, target: materialInput.target });
  const driver: BackendPublicationDriver = {
    observeLocalState: async () => targetWitness,
    publishProjectMap: async () => { throw new Error("must not run in this fixture"); },
    acquireRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    readRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    releaseRemoteGuard: async () => { throw new Error("must not run in this fixture"); },
    publishConfig: async () => { throw new Error("must not run in this fixture"); },
    restoreConfig: async () => { throw new Error("must not run in this fixture"); },
    restoreProjectMap: async () => { throw new Error("must not run in this fixture"); },
  };
  const coordinator = new BackendPublicationCoordinator({ homeDir: home, driver });
  try {
    await coordinator.prepare({
      publicationId: "publication-1",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: materialInput,
      projects: [{ localProjectId: "local-project", remoteProjectId: "remote-project", evidenceSha256: "a".repeat(64) }],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    throw new Error("fixture expected prepare() to fail after the journal write");
  } catch (error) {
    if (error instanceof Error && error.message === "fixture expected prepare() to fail after the journal write") throw error;
    // Expected: material authentication fails after the durable journal
    // write this fixture depends on. Positive control below confirms it.
  }
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

async function writeV3HoldFixture(home: string) {
  return coordinatorFor(home).enterMaintenance({
    publicationId: "maintenance-publication",
    generationId: "maintenance-generation",
    sourceSelectionSha256: "a".repeat(64),
    queueEvidenceSha256: "b".repeat(64),
    roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab", queueCutoff: null, evidenceSha256: "a".repeat(64) }],
  });
}

describe("observeMigrationMaintenanceJournal (section 4.2 four-valued journal read)", () => {
  it("is absent when nothing has ever touched the publication directory", () => {
    const home = makeHome();
    expect(observeMigrationMaintenanceJournal({ homeDir: home })).toEqual({ kind: "absent" });
  });

  it("is a hold when a real v3 maintenance journal is present, and returns the real journal object", async () => {
    const home = makeHome();
    const journal = await writeV3HoldFixture(home);
    expect(journal.phase).toBe("maintenance-held");
    const result = observeMigrationMaintenanceJournal({ homeDir: home });
    expect(result).toEqual({ kind: "hold", journal });
  });

  it("is a publication, never absent, when a real v2 publication journal occupies the slot (red: this is the exact defect section 2.8 exists to prevent)", async () => {
    const home = makeHome();
    await writeV2PublicationFixture(home);
    // Positive control: confirm the fixture really did write a v2 journal,
    // and that the v3-typed reader really does see it as null, before asking
    // the four-valued observer to interpret that.
    expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "preparing" });
    expect(readBackendMaintenanceJournal(home)).toBeNull();
    const result = observeMigrationMaintenanceJournal({ homeDir: home });
    expect(result).toEqual({ kind: "publication", publicationId: "publication-1", phase: "preparing" });
  });

  it("is unresolvable, never absent, when the v3 reader itself throws (a corrupted v3 journal)", async () => {
    const home = makeHome();
    await writeV3HoldFixture(home);
    const path = backendPublicationJournalPath(home);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.checksumSha256 = "f".repeat(64);
    writeFileSync(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    // Positive control.
    expect(() => readBackendMaintenanceJournal(home)).toThrow(BackendPublicationJournalError);
    const result = observeMigrationMaintenanceJournal({ homeDir: home });
    expect(result).toEqual({ kind: "unresolvable", evidence: expect.stringMatching(/^journal-/u) });
    expect((result as Extract<MigrationJournalObservation, { kind: "unresolvable" }>).evidence)
      .toBe("journal-checksum-mismatch");
  });

  it("is unresolvable when the maintenance read is genuinely absent but the publication read fails for its own reason (injected: this pairing has no real-world trigger because both readers observe the same file deterministically, per the owner-approved reasoning for the analogous sqlite-snapshot case)", () => {
    const home = makeHome();
    const result = observeMigrationMaintenanceJournal({
      homeDir: home,
      _operationsForTesting: {
        readMaintenance: () => null,
        readPublication: () => { throw new BackendPublicationJournalError("unsafe-storage", "injected"); },
      },
    });
    expect(result).toEqual({ kind: "unresolvable", evidence: "journal-unsafe-storage" });
  });

  it("preserves the specific reason for evidence rather than collapsing every failure to one label", async () => {
    const home = makeHome();
    await writeV3HoldFixture(home);
    const migrations = backendPublicationDirectory(home);
    chmodSync(migrations, 0o755);
    let result: MigrationJournalObservation;
    try {
      result = observeMigrationMaintenanceJournal({ homeDir: home });
    } finally {
      chmodSync(migrations, 0o700);
    }
    expect(result.kind).toBe("unresolvable");
    expect((result as Extract<MigrationJournalObservation, { kind: "unresolvable" }>).evidence).toMatch(/^journal-/u);
  });

  it("propagates an unrecognised (non-BackendPublicationJournalError) failure shape as internal-error evidence (injected: every real throw from both readers is provably a typed BackendPublicationJournalError)", () => {
    const home = makeHome();
    const result = observeMigrationMaintenanceJournal({
      homeDir: home,
      _operationsForTesting: {
        readMaintenance: () => { throw new Error("unexpected shape"); },
      },
    });
    expect(result).toEqual({ kind: "unresolvable", evidence: "journal-internal-error" });
  });

  it("treats an omitted homeDir as the default (asserted through injected readers, never against the real user home)", () => {
    const result = observeMigrationMaintenanceJournal({
      _operationsForTesting: { readMaintenance: () => null, readPublication: () => null },
    });
    expect(result).toEqual({ kind: "absent" });
  });
});

