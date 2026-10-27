import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import {
  ActivationArtifactIdentityMismatchError,
  ActivationArtifactPresenceUnresolvableError,
  publishActivationArtifact,
  type ActivationArtifactRecoveryMaterial,
} from "../../src/migration/activation-artifact-store.js";
import {
  driveActivationPublication,
  readSealedMaterialContent,
  type ActivationPublicationCoordinator,
  type ActivationPublicationInput,
} from "../../src/migration/activation-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { composeBackendPublicationMaterial } from "../../src/storage/backend-publication-material.js";
import { createInMemoryRemoteGuardProvider } from "../storage/backend-publication-guard-double.js";
import {
  BackendPublicationCoordinator,
  backendPublicationDirectory,
  backendPublicationHistoryDirectory,
  backendPublicationMaterialContent,
  type BackendPublicationObserver,
  backendPublicationJournalPath,
  backendPublicationMaterialWitness,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationAppendBarrierAsync,
  withBackendPublicationConsumerLockAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationJournal,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryFile,
} from "../../src/storage/backend-publication.js";

const PUBLICATION_ID = "publication-a";
const TARGET = "postgresql" as const;
const EVIDENCE_A = "a".repeat(64);
const EVIDENCE_B = "b".repeat(64);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-publication-"));
  roots.push(value);
  return value;
}

function absentFile(): BackendPublicationRecoveryFile {
  return { presence: "absent" };
}

function artifactMaterial(
  overrides: Partial<ActivationArtifactRecoveryMaterial> = {},
): ActivationArtifactRecoveryMaterial {
  return {
    version: 1,
    publicationId: PUBLICATION_ID,
    source: { config: absentFile(), projectMap: absentFile() },
    target: { config: absentFile(), projectMap: absentFile() },
    projects: [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
    ],
    ...overrides,
  };
}

function absentWitness() {
  return {
    presence: "absent" as const,
    rawSha256: null,
    semanticSha256: null,
    byteLength: 0 as const,
    mode: null,
    uid: null,
    gid: null,
    nlink: null,
    dev: null,
    ino: null,
    parentDev: null,
    parentIno: null,
  };
}

function baseJournal(overrides: Partial<BackendPublicationJournal> = {}): BackendPublicationJournal {
  return {
    version: 2,
    publicationId: PUBLICATION_ID,
    sourceBackend: "sqlite",
    targetBackend: TARGET,
    phase: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expectedConfigSha256: "c".repeat(64),
    expectedProjectMapSha256: "d".repeat(64),
    intendedConfigSha256: "c".repeat(64),
    intendedProjectMapSha256: "d".repeat(64),
    publishedConfigSha256: "c".repeat(64),
    publishedProjectMapSha256: "d".repeat(64),
    recoveryReference: null,
    sourceState: { config: absentWitness(), projectMap: absentWitness() },
    targetState: { config: absentWitness(), projectMap: absentWitness() },
    projects: [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A, fence: null },
    ],
    checksumSha256: "e".repeat(64),
    ...overrides,
  };
}

type FenceMode = "satisfied" | "absent" | "unresolvable";

function fakeGuard(responses: Record<string, FenceMode>): ActivationLeasePublicationGuard {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error("unexpected call to " + name); });
  return {
    acquire: unexpected("acquire"),
    renew: unexpected("renew"),
    release: unexpected("release"),
    read: vi.fn(async (input: { projectId: string; targetBackend: string; evidenceSha256: string }) => {
      const mode = responses[input.projectId] ?? "absent";
      if (mode === "unresolvable") {
        throw new PostgreSqlStorageOperationError(
          "STORAGE_OPERATION_FAILED",
          { domain: "coordination", operation: "readBackendPublication", projectId: input.projectId },
          "42501",
          false,
        );
      }
      if (mode === "absent") return null;
      return {
        projectId: input.projectId,
        machineId: "machine-a",
        publicationId: PUBLICATION_ID,
        targetBackend: input.targetBackend,
        evidenceSha256: input.evidenceSha256,
        fencingToken: 1n,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        renewedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
    }),
  };
}

function fakeCoordinator(
  overrides: Partial<ActivationPublicationCoordinator> = {},
): ActivationPublicationCoordinator {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error("unexpected call to " + name); });
  return {
    recoverPending: overrides.recoverPending ?? unexpected("recoverPending"),
    prepare: overrides.prepare ?? unexpected("prepare"),
    resume: overrides.resume ?? unexpected("resume"),
    abort: overrides.abort ?? unexpected("abort"),
  };
}

function baseInput(overrides: Partial<ActivationPublicationInput> = {}): ActivationPublicationInput {
  return {
    homeDir: tempHome(),
    lockToken: {} as BackendPublicationLockToken,
    publicationId: PUBLICATION_ID,
    sourceBackend: "sqlite",
    targetBackend: TARGET,
    identityDigest: "f".repeat(64),
    projects: [
      { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
    ],
    ...overrides,
  };
}

/** Wrap a real coordinator so each entry point can be asserted on, while
 * every call still reaches the real machine with the retained token. */
function spyOn(real: BackendPublicationCoordinator) {
  return {
    recoverPending: vi.fn((options, token) => real.recoverPending(options, token)),
    prepare: vi.fn((input, token) => real.prepare(input, token)),
    resume: vi.fn((token) => real.resume(token)),
    abort: vi.fn((token) => real.abort(token)),
  } satisfies ActivationPublicationCoordinator;
}
describe("driveActivationPublication", () => {
  it("asserts fences for every project and refuses with fence-unresolvable when one is unresolvable", async () => {
    const guard = fakeGuard({ "remote-a": "unresolvable" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("fence-unresolvable");
    expect(result.journal).toBeNull();
    expect(result.fenceChecks).toHaveLength(1);
    expect(result.fenceChecks[0]!.assertion.status).toBe("unresolvable");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("refuses with fence-unsatisfied when a covered project's lease is absent", async () => {
    const guard = fakeGuard({ "remote-a": "absent" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("fence-unsatisfied");
    expect(result.fenceChecks[0]!.assertion.status).toBe("unsatisfied");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("prioritizes fence-unresolvable over fence-unsatisfied across multiple projects", async () => {
    const guard = fakeGuard({ "remote-a": "absent", "remote-b": "unresolvable" });
    const coordinator = fakeCoordinator();
    const input = baseInput({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
        { localProjectId: "local-b", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_B },
      ],
    });
    const result = await driveActivationPublication(guard, coordinator, input);
    expect(result.status).toBe("fence-unresolvable");
    expect(result.fenceChecks).toHaveLength(2);
  });

  it("handles zero covered projects without asserting any fence", async () => {
    const guard = fakeGuard({});
    const journal = baseJournal({ phase: "completed", projects: [] });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput({ projects: [] }), {
      readPublicationJournal: () => journal,
    });
    expect(result.status).toBe("completed");
    expect(result.fenceChecks).toEqual([]);
    expect(guard.read).not.toHaveBeenCalled();
  });

  it("reports completed when recoverPending drives this exact publicationId to completed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "completed", publicationId: PUBLICATION_ID });
    const recoverPending = vi.fn(async () => journal);
    const coordinator = fakeCoordinator({ recoverPending });
    const input = baseInput();
    const result = await driveActivationPublication(guard, coordinator, input, {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result).toMatchObject({ status: "completed", journal });
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
  });

  it("reports aborted when recoverPending drives this exact publicationId to aborted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "aborted", publicationId: PUBLICATION_ID });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "aborting" }),
    });
    expect(result).toMatchObject({ status: "aborted", journal });
  });

  it("reports publication-collision when a different, still in-flight generation occupies the journal", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ publicationId: "other-publication", phase: "guarded" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => journal,
    });
    expect(result.status).toBe("publication-collision");
    expect(result.journal).toEqual(journal);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.resume).not.toHaveBeenCalled();
  });

  it("treats a stale completed journal from an unrelated generation as absent and proceeds to a fresh prepare", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "completed" });
    const prepared = baseJournal({ phase: "prepared" });
    const resumed = baseJournal({ phase: "completed" });
    const prepare = vi.fn(async () => prepared);
    const resume = vi.fn(async () => resumed);
    const coordinator = fakeCoordinator({
      prepare,
      resume,
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact, readPublicationJournal: () => stale },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
    expect(prepare).toHaveBeenCalled();
  });

  it("treats a stale aborted journal from an unrelated generation as absent and proceeds to a fresh prepare", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "aborted" });
    const resumed = baseJournal({ phase: "completed" });
    const coordinator = fakeCoordinator({
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => resumed),
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact, readPublicationJournal: () => stale },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
  });

  it("reports artifact-unresolvable when the artifact presence read cannot be completed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const readArtifact = () => {
      throw new ActivationArtifactPresenceUnresolvableError("cannot determine presence");
    };
    const result = await driveActivationPublication(guard, coordinator, baseInput(), { readArtifact });
    expect(result.status).toBe("artifact-unresolvable");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("rethrows an unrecognized artifact read error unchanged", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const boom = new Error("boom");
    const readArtifact = () => { throw boom; };
    await expect(
      driveActivationPublication(guard, coordinator, baseInput(), { readArtifact }),
    ).rejects.toThrow(boom);
  });

  it("reports artifact-missing when no artifact is durably persisted at the identity digest", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => null },
    );
    expect(result.status).toBe("artifact-missing");
  });

  it("reports artifact-identity-mismatch when the artifact's publicationId differs from the caller's", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({ publicationId: "different-publication" });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("reports artifact-identity-mismatch when the artifact covers a different number of projects", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({ projects: [] });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
  });

  it("reports artifact-identity-mismatch when the artifact covers a differing project identity", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const artifact = artifactMaterial({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B },
      ],
    });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result.status).toBe("artifact-identity-mismatch");
  });

  it("prepares and resumes a fresh publication from the persisted artifact, retaining one lock token throughout", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const prepared = baseJournal({ phase: "prepared" });
    const resumed = baseJournal({ phase: "completed" });
    const recoverPending = vi.fn(async () => null);
    const prepare = vi.fn(async () => prepared);
    const resume = vi.fn(async () => resumed);
    const coordinator = fakeCoordinator({ recoverPending, prepare, resume });
    const input = baseInput();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      input,
      { readArtifact: () => artifact },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
    expect(recoverPending).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: artifact.publicationId,
        sourceBackend: input.sourceBackend,
        targetBackend: input.targetBackend,
        material: { source: artifact.source, target: artifact.target },
        projects: artifact.projects,
      }),
      input.lockToken,
    );
    expect(resume).toHaveBeenCalledWith(input.lockToken);
  });

  it("reports aborted when a fresh dispatch resumes into an aborted phase", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const resumed = baseJournal({ phase: "aborted" });
    const coordinator = fakeCoordinator({
      recoverPending: vi.fn(async () => null),
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => resumed),
    });
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result).toMatchObject({ status: "aborted", journal: resumed });
  });

  it("uses readActivationArtifact by default and reports artifact-missing for an empty home", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => null) });
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("artifact-missing");
  });
});

describe("driveActivationPublication: journal gate (#1443)", () => {
  const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

  function maintenanceJournal(phase: BackendMaintenanceJournal["phase"]): BackendMaintenanceJournal {
    return {
      version: 3,
      publicationId: "migration-generation-1",
      sourceBackend: "sqlite",
      targetBackend: null,
      phase,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      generationId: "generation-1",
      sourceSelectionSha256: EVIDENCE_A,
      queueEvidenceSha256: EVIDENCE_B,
      roster: [],
      selectedGenerationId: null,
      terminalEvidenceSha256: null,
      abortEvidenceSha256: null,
      checksumSha256: "9".repeat(64),
    };
  }

  /** A faithful coordinator double: recoverPending records that it ran and
   * drives any journal it is given to completed, as #resumeUnlocked does. A
   * double that returned the journal unchanged would pass on the broken base. */
  function drivingCoordinator(journal: BackendPublicationJournal | null) {
    const recoverPending = vi.fn(async () => (journal === null ? null : { ...journal, phase: "completed" as const }));
    return fakeCoordinator({ recoverPending });
  }

  function realHome(): string {
    const value = mkdtempSync(join(tmpdir(), "lcm-activation-publication-real-"));
    mkdirSync(join(value, ".lcm"), { mode: 0o700 });
    roots.push(value);
    return value;
  }

  function realCoordinatorFor(homeDir: string) {
    const material = artifactMaterial();
    const state = backendPublicationMaterialWitness({ source: material.source, target: material.target });
    const targetState = backendPublicationMaterialWitness({ source: material.target, target: material.target });
    let observed = state;
    const fences = new Map<string, BackendPublicationFenceRecord>();
    const driver: BackendPublicationDriver = {
      observeLocalState: async () => observed,
      publishProjectMap: async ({ permit }) => {
        permit.assertActive();
        observed = { ...observed, projectMap: targetState.projectMap };
        return targetState.projectMap;
      },
      publishConfig: async ({ permit }) => {
        permit.assertActive();
        observed = { ...observed, config: targetState.config };
        return targetState.config;
      },
      restoreConfig: async () => state.config,
      restoreProjectMap: async () => state.projectMap,
      acquireRemoteGuard: async ({ journal, project }) => {
        const fence: BackendPublicationFenceRecord = {
          projectId: project.remoteProjectId,
          machineId: MACHINE,
          publicationId: journal.publicationId,
          targetBackend: journal.targetBackend,
          evidenceSha256: project.evidenceSha256,
          fencingToken: "1",
          acquiredAt: "2026-09-19T00:00:00.000Z",
          renewedAt: "2026-09-19T00:00:00.000Z",
          expiresAt: "2999-09-19T00:00:00.000Z",
          releasedAt: null,
          databaseExpired: false,
        };
        fences.set(project.remoteProjectId, fence);
        return fence;
      },
      readRemoteGuard: async ({ project }) => fences.get(project.remoteProjectId) ?? null,
      releaseRemoteGuard: async ({ project, fence }) => {
        fences.set(project.remoteProjectId, { ...fence, releasedAt: "2026-09-19T00:01:00.000Z" });
      },
    };
    return new BackendPublicationCoordinator({ homeDir, driver });
  }

  async function holdMaintenance(homeDir: string): Promise<BackendMaintenanceJournal> {
    return realCoordinatorFor(homeDir).enterMaintenance({
      publicationId: "migration-generation-1",
      generationId: "generation-1",
      sourceSelectionSha256: EVIDENCE_A,
      queueEvidenceSha256: EVIDENCE_B,
      roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000012", evidenceSha256: EVIDENCE_A }],
      now: new Date("2026-09-19T00:00:00.000Z"),
    });
  }

  it.each([
    ["localProjectId", { localProjectId: "local-a", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_B }],
    ["remoteProjectId", { localProjectId: "local-b", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B }],
    ["both ids with differing evidence", { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B }],
  ])("refuses duplicate-publication-input for a repeated %s before any I/O", async (_label, second) => {
    const guard = fakeGuard({ "remote-a": "satisfied", "remote-b": "satisfied" });
    const coordinator = fakeCoordinator();
    const readMaintenanceJournal = vi.fn(() => null);
    const readPublicationJournal = vi.fn(() => null);
    const readArtifact = vi.fn(() => null);
    const input = baseInput({
      projects: [
        { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
        second,
      ],
    });
    const result = await driveActivationPublication(guard, coordinator, input, {
      readMaintenanceJournal,
      readPublicationJournal,
      readArtifact,
    });
    expect(result).toMatchObject({ status: "duplicate-publication-input", journal: null, fenceChecks: [] });
    expect(guard.read).not.toHaveBeenCalled();
    expect(readMaintenanceJournal).not.toHaveBeenCalled();
    expect(readPublicationJournal).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("refuses duplicate inputs even when an earlier completed publication exists for this id", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = drivingCoordinator(baseJournal({ phase: "completed" }));
    const duplicate = { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A };
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput({ projects: [duplicate, duplicate] }),
      { readPublicationJournal: () => baseJournal({ phase: "completed" }) },
    );
    expect(result.status).toBe("duplicate-publication-input");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("reports publication-unresolvable, never absent, when the maintenance journal peek throws", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readMaintenanceJournal: () => { throw new Error("unsafe storage"); },
    });
    expect(result).toMatchObject({ status: "publication-unresolvable", journal: null, fenceChecks: [] });
    expect(result.detail).toContain("unsafe storage");
    expect(guard.read).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("reports publication-unresolvable when the version-2 journal peek throws", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => { throw new Error("checksum mismatch"); },
    });
    expect(result).toMatchObject({ status: "publication-unresolvable", journal: null, fenceChecks: [] });
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(guard.read).not.toHaveBeenCalled();
  });

  it.each(["maintenance-entering", "maintenance-held", "selection-prepared"] as const)(
    "refuses with maintenance-in-flight for a version-3 journal in phase %s, without any coordinator call",
    async (phase) => {
      const guard = fakeGuard({ "remote-a": "satisfied" });
      const coordinator = fakeCoordinator();
      const readPublicationJournal = vi.fn(() => null);
      const result = await driveActivationPublication(guard, coordinator, baseInput(), {
        readMaintenanceJournal: () => maintenanceJournal(phase),
        readPublicationJournal,
      });
      expect(result).toMatchObject({ status: "maintenance-in-flight", journal: null, fenceChecks: [] });
      expect(result.detail).toContain(phase);
      expect(guard.read).not.toHaveBeenCalled();
      expect(readPublicationJournal).not.toHaveBeenCalled();
      expect(coordinator.recoverPending).not.toHaveBeenCalled();
      expect(coordinator.prepare).not.toHaveBeenCalled();
    },
  );

  it("refuses a real held version-3 journal through the default peek and leaves its bytes unchanged", async () => {
    const homeDir = realHome();
    await holdMaintenance(homeDir);
    const journalPath = backendPublicationJournalPath(homeDir);
    const before = readFileSync(journalPath, "utf8");
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(
      fakeGuard({ "remote-a": "satisfied" }),
      coordinator,
      baseInput({ homeDir }),
    );
    expect(result).toMatchObject({ status: "maintenance-in-flight", journal: null, fenceChecks: [] });
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("prepares and resumes a fresh publication over a real terminal selection-completed version-3 journal", async () => {
    const homeDir = realHome();
    const held = await holdMaintenance(homeDir);
    const real = realCoordinatorFor(homeDir);
    const prepared = await real.prepareMaintenanceSelection({
      expectedChecksumSha256: held.checksumSha256,
      generationId: "generation-1",
      targetBackend: "postgresql",
      terminalEvidenceSha256: EVIDENCE_B,
    });
    await real.completeMaintenanceSelection({
      expectedChecksumSha256: prepared.checksumSha256,
      generationId: "generation-1",
      terminalEvidenceSha256: EVIDENCE_B,
    });
    expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
    const artifact = artifactMaterial();
    const published = publishActivationArtifact({ homeDir, material: artifact });
    const coordinator = spyOn(real);
    const result = await withBackendPublicationConsumerLockAsync(homeDir, (lockToken) =>
      driveActivationPublication(
        fakeGuard({ "remote-a": "satisfied" }),
        coordinator,
        baseInput({ homeDir, lockToken, identityDigest: published.identityDigest }),
      ));
    expect(result.status).toBe("completed");
    expect(result.journal?.publicationId).toBe(PUBLICATION_ID);
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
    expect(coordinator.resume).toHaveBeenCalledTimes(1);
    expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    expect(readBackendPublicationJournal(homeDir)?.phase).toBe("completed");
    expect(readdirSync(backendPublicationHistoryDirectory(homeDir)).length).toBeGreaterThanOrEqual(1);
  });

  it("treats a terminal maintenance-aborted version-3 journal as the same fresh dispatch, with leases asserted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const prepare = vi.fn(async () => baseJournal({ phase: "prepared" }));
    const resume = vi.fn(async () => baseJournal({ phase: "completed" }));
    const coordinator = fakeCoordinator({ prepare, resume });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readMaintenanceJournal: () => maintenanceJournal("maintenance-aborted"),
      readPublicationJournal: () => { throw new Error("must not be read after a terminal version-3 journal"); },
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(guard.read).toHaveBeenCalledTimes(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not drive an unrelated in-flight version-2 journal: collision without recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const unrelated = baseJournal({ publicationId: "other-publication", phase: "guarded" });
    const coordinator = drivingCoordinator(unrelated);
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => unrelated,
    });
    expect(result).toMatchObject({ status: "publication-collision", journal: unrelated, fenceChecks: [] });
    expect(guard.read).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("treats an unrelated terminal version-2 journal as a fresh dispatch without recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "aborted" });
    const coordinator = fakeCoordinator({
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => baseJournal({ phase: "completed" })),
    });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => stale,
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(guard.read).toHaveBeenCalledTimes(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it.each(["completed", "aborted"] as const)(
    "returns the %s result for a terminal journal of this publication without asserting leases",
    async (phase) => {
      const guard = fakeGuard({});
      const terminal = baseJournal({ phase });
      const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => terminal) });
      const input = baseInput();
      const result = await driveActivationPublication(guard, coordinator, input, {
        readPublicationJournal: () => terminal,
      });
      expect(result).toMatchObject({ status: phase, journal: terminal, fenceChecks: [], dispatch: "terminal-report" });
      expect(guard.read).not.toHaveBeenCalled();
      // A terminal journal is reported, never driven: the coordinator is not
      // called at all (plan-v7.1 amendment 3's "completed" row; an aborted
      // journal that is not the pre-seal shape is never re-prepared).
      expect(coordinator.recoverPending).not.toHaveBeenCalled();
    },
  );

  it("resumes a non-terminal journal of this publication under the retained token after asserting leases", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const inFlight = baseJournal({ phase: "guarded" });
    const driven = baseJournal({ phase: "completed" });
    const recoverPending = vi.fn(async () => driven);
    const coordinator = fakeCoordinator({ recoverPending });
    const input = baseInput();
    const result = await driveActivationPublication(guard, coordinator, input, {
      readPublicationJournal: () => inFlight,
    });
    expect(result).toMatchObject({ status: "completed", journal: driven });
    expect(result.fenceChecks).toHaveLength(1);
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
  });

  it("refuses a non-terminal journal of this publication when its lease is not satisfied", async () => {
    const guard = fakeGuard({ "remote-a": "absent" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result.status).toBe("fence-unsatisfied");
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
  });

  it("reports a collision when recoverPending finds a different in-flight journal than the peek showed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const raced = baseJournal({ publicationId: "raced-publication", phase: "guarded" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => raced) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
    });
    expect(result).toMatchObject({ status: "publication-collision", journal: raced });
  });

  it("falls through to a fresh dispatch when the journal vanished between the peek and recoverPending", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator({
      recoverPending: vi.fn(async () => null),
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => baseJournal({ phase: "completed" })),
    });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
      readArtifact: () => artifactMaterial(),
    });
    expect(result.status).toBe("completed");
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
  });

  it("maps an artifact identity digest mismatch from the reader to artifact-identity-mismatch", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readArtifact: () => { throw new ActivationArtifactIdentityMismatchError("digest does not match"); },
    });
    expect(result).toMatchObject({ status: "artifact-identity-mismatch", journal: null });
    expect(result.detail).toContain("digest does not match");
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });
});

describe("driveActivationPublication: reused publicationId with a different identity (#1443)", () => {
  const PROJECT_B = { localProjectId: "local-b", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_B };

  const mismatches: ReadonlyArray<[string, Partial<BackendPublicationJournal>, string]> = [
    ["sourceBackend", { sourceBackend: "postgresql" }, "sourceBackend postgresql rather than sqlite"],
    ["targetBackend", { targetBackend: "sqlite" }, "targetBackend sqlite rather than postgresql"],
    [
      "project evidence",
      { projects: [{ localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_B, fence: null }] },
      "a different set of covered projects",
    ],
    [
      "project remoteProjectId",
      { projects: [{ localProjectId: "local-a", remoteProjectId: "remote-b", evidenceSha256: EVIDENCE_A, fence: null }] },
      "a different set of covered projects",
    ],
    [
      "project count",
      {
        projects: [
          { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A, fence: null },
          { ...PROJECT_B, fence: null },
        ],
      },
      "a different set of covered projects",
    ],
  ];

  describe.each(["completed", "aborted", "guarded"] as const)("for a peeked same-id journal at phase %s", (phase) => {
    it.each(mismatches)(
      "refuses a differing %s as publication-collision without asserting leases or calling the coordinator",
      async (_label, overrides, expectedDetail) => {
        const guard = fakeGuard({ "remote-a": "satisfied" });
        const coordinator = fakeCoordinator();
        const reused = baseJournal({ phase, ...overrides });
        const readArtifact = vi.fn(() => artifactMaterial());
        const result = await driveActivationPublication(guard, coordinator, baseInput(), {
          readPublicationJournal: () => reused,
          readArtifact,
        });
        expect(result).toMatchObject({ status: "publication-collision", journal: reused, fenceChecks: [] });
        expect(result.detail).toContain("reuses publicationId " + PUBLICATION_ID + " at phase " + phase);
        expect(result.detail).toContain(expectedDetail);
        expect(guard.read).not.toHaveBeenCalled();
        expect(readArtifact).not.toHaveBeenCalled();
        expect(coordinator.recoverPending).not.toHaveBeenCalled();
        expect(coordinator.prepare).not.toHaveBeenCalled();
        expect(coordinator.resume).not.toHaveBeenCalled();
      },
    );
  });

  it("refuses a same-id journal recoverPending returns with a different identity instead of reporting it", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const raced = baseJournal({ phase: "completed", targetBackend: "sqlite" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => raced) });
    const input = baseInput();
    const result = await driveActivationPublication(guard, coordinator, input, {
      readPublicationJournal: () => baseJournal({ phase: "guarded" }),
      readArtifact: () => artifactMaterial(),
    });
    expect(result).toMatchObject({ status: "publication-collision", journal: raced });
    expect(result.detail).toContain("recoverPending returned reuses publicationId " + PUBLICATION_ID);
    expect(result.detail).toContain("targetBackend sqlite rather than postgresql");
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.resume).not.toHaveBeenCalled();
  });

  it.each(["completed", "guarded"] as const)(
    "still accepts a same-id journal at phase %s whose identity matches regardless of project order or fence state",
    async (phase) => {
      const guard = fakeGuard({ "remote-a": "satisfied", "remote-b": "satisfied" });
      const fence: BackendPublicationFenceRecord = {
        projectId: "remote-a",
        machineId: "machine-a",
        publicationId: PUBLICATION_ID,
        targetBackend: TARGET,
        evidenceSha256: EVIDENCE_A,
        fencingToken: "1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        renewedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
      const matching = baseJournal({
        phase,
        projects: [
          { ...PROJECT_B, fence: null },
          { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A, fence },
        ],
      });
      const driven = { ...matching, phase: "completed" as const };
      const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => driven) });
      const input = baseInput({
        projects: [
          { localProjectId: "local-a", remoteProjectId: "remote-a", evidenceSha256: EVIDENCE_A },
          PROJECT_B,
        ],
      });
      const result = await driveActivationPublication(guard, coordinator, input, {
        readPublicationJournal: () => matching,
      });
      if (phase === "completed") {
        expect(result).toMatchObject({ status: "completed", journal: matching, fenceChecks: [], dispatch: "terminal-report" });
        expect(coordinator.recoverPending).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: "completed", journal: driven });
        expect(result.fenceChecks).toHaveLength(2);
        expect(coordinator.recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
      }
      expect(coordinator.prepare).not.toHaveBeenCalled();
    },
  );
});



// ---------------------------------------------------------------------------
// plan-v7.1 amendment 3: the version-2 dispatch table on the REAL coordinator
// over the real #1433 driver (real config.json / map.json under a temp home)
// with the in-memory remote guard provider. Crashes are injected through the
// coordinator's observer seam at exact journal phases, so every row below is
// reached from durable state the real machine actually produces.
// ---------------------------------------------------------------------------

describe("driveActivationPublication: version-2 dispatch table on the real coordinator (plan-v7.1 A1/A3)", () => {
  const HASH_A = "a".repeat(64);
  const REMOTE_ID_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";

  type Fixture = Readonly<{
    homeDir: string;
    provider: ReturnType<typeof createInMemoryRemoteGuardProvider>;
    identityDigest: string;
    projects: ActivationPublicationInput["projects"];
    coordinator: (observer?: BackendPublicationObserver) => BackendPublicationCoordinator;
    input: (lockToken: BackendPublicationLockToken) => ActivationPublicationInput;
    guard: () => ActivationLeasePublicationGuard;
    materialPath: string;
  }>;

  function fixture(): Fixture {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-activation-publication-dispatch-"));
    roots.push(homeDir);
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, keep: true }) + "\n", { mode: 0o600 });
    writeFileSync(join(homeDir, ".lcm", "map.json"), JSON.stringify({ [HASH_A]: { canonical: "/repos/one", aliases: [] } }) + "\n", { mode: 0o600 });
    const composed = composeBackendPublicationMaterial({
      homeDir,
      targetBackend: "postgresql",
      bindings: [{ localProjectId: HASH_A, remoteProjectId: REMOTE_ID_A, evidenceSha256: EVIDENCE_A }],
    });
    const projects = composed.projects.map((project) => ({
      localProjectId: project.localProjectId,
      remoteProjectId: project.remoteProjectId,
      evidenceSha256: project.evidenceSha256,
    }));
    const published = publishActivationArtifact({
      homeDir,
      material: { version: 1, publicationId: PUBLICATION_ID, source: composed.material.source, target: composed.material.target, projects },
    });
    const provider = createInMemoryRemoteGuardProvider();
    return {
      homeDir,
      provider,
      identityDigest: published.identityDigest,
      projects,
      coordinator: (observer) => createBackendPublicationCoordinator({ homeDir, remoteGuard: { mode: "delegated", provider }, observer }),
      input: (lockToken) => baseInput({ homeDir, lockToken, identityDigest: published.identityDigest, projects }),
      guard: () => fakeGuard({ [REMOTE_ID_A]: "satisfied" }),
      materialPath: join(backendPublicationDirectory(homeDir), PUBLICATION_ID + ".material"),
    };
  }

  /** An observer that throws (simulating a crash) the first time the given
   * event fires, or, for "after-journal-write", the first time the journal
   * just written is at the given phase. */
  function crashAt(homeDir: string, event: string, phase?: BackendPublicationJournal["phase"]): BackendPublicationObserver {
    let fired = false;
    return (observed) => {
      if (fired || observed !== event) return;
      if (phase !== undefined && readBackendPublicationJournal(homeDir)?.phase !== phase) return;
      fired = true;
      throw new Error("injected crash at " + event + (phase === undefined ? "" : " " + phase));
    };
  }

  async function prepareInput(f: Fixture) {
    const composed = composeBackendPublicationMaterial({
      homeDir: f.homeDir,
      targetBackend: "postgresql",
      bindings: [{ localProjectId: HASH_A, remoteProjectId: REMOTE_ID_A, evidenceSha256: EVIDENCE_A }],
    });
    return {
      publicationId: PUBLICATION_ID,
      sourceBackend: "sqlite" as const,
      targetBackend: "postgresql" as const,
      material: composed.material,
      projects: composed.projects,
    };
  }

  async function drive(f: Fixture, real: BackendPublicationCoordinator, guard = f.guard()) {
    const coordinator = spyOn(real);
    const result = await withBackendPublicationAppendBarrierAsync(f.homeDir, (lockToken) =>
      driveActivationPublication(guard, coordinator, f.input(lockToken)));
    return { result, coordinator };
  }

  function expectPublished(f: Fixture): void {
    const config = JSON.parse(readFileSync(join(f.homeDir, ".lcm", "config.json"), "utf8")) as { storage: { backend: string }; keep: boolean };
    expect(config.storage.backend).toBe("postgresql");
    expect(config.keep).toBe(true);
    const map = JSON.parse(readFileSync(join(f.homeDir, ".lcm", "map.json"), "utf8")) as Record<string, { remoteProjectId?: string }>;
    expect(map[HASH_A]!.remoteProjectId).toBe(REMOTE_ID_A);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("completed");
  }

  it("fresh prepare: no journal -> prepare + resume on the real driver publishes config and map", async () => {
    const f = fixture();
    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "completed", dispatch: "fresh-prepare" });
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expectPublished(f);
  });

  it("pre-seal crash (preparing, no reference, material absent): controlled abort under the token, then prepare with the SAME publicationId", async () => {
    const f = fixture();
    await expect(f.coordinator(crashAt(f.homeDir, "before-material-seal")).prepare(await prepareInput(f))).rejects.toThrow(/injected crash/);
    const stranded = readBackendPublicationJournal(f.homeDir);
    expect(stranded).toMatchObject({ phase: "preparing", recoveryReference: null, publicationId: PUBLICATION_ID });
    expect(existsSync(f.materialPath)).toBe(false);

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "completed", dispatch: "controlled-abort-then-prepare" });
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.abort).toHaveBeenCalledTimes(1);
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare.mock.calls[0]![0].publicationId).toBe(PUBLICATION_ID);
    expectPublished(f);
    // The controlled abort's terminal journal was archived by prepare(), not left as the live record.
    expect(readdirSync(backendPublicationHistoryDirectory(f.homeDir)).length).toBeGreaterThanOrEqual(1);
  });

  it("crash after the controlled abort and before the re-prepare leaves the single re-preparable aborted shape; the next call re-prepares it", async () => {
    const f = fixture();
    await expect(f.coordinator(crashAt(f.homeDir, "before-material-seal")).prepare(await prepareInput(f))).rejects.toThrow(/injected crash/);
    const real = f.coordinator();
    const crashing = {
      ...spyOn(real),
      prepare: vi.fn(async () => { throw new Error("injected crash after controlled abort"); }),
    } satisfies ActivationPublicationCoordinator;
    await expect(withBackendPublicationAppendBarrierAsync(f.homeDir, (lockToken) =>
      driveActivationPublication(f.guard(), crashing, f.input(lockToken)))).rejects.toThrow(/after controlled abort/);
    expect(crashing.abort).toHaveBeenCalledTimes(1);
    const aborted = readBackendPublicationJournal(f.homeDir);
    expect(aborted).toMatchObject({
      phase: "aborted", recoveryReference: null, publishedConfigSha256: null, publishedProjectMapSha256: null, publicationId: PUBLICATION_ID,
    });
    expect(existsSync(f.materialPath)).toBe(false);

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "completed", dispatch: "reprepare-aborted" });
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
    expectPublished(f);
  });

  it("operator abort of a sealed (prepared) publication: reported as aborted, never re-prepared, material not even read", async () => {
    const f = fixture();
    const real = f.coordinator();
    await real.prepare(await prepareInput(f));
    const aborted = await real.abort();
    expect(aborted.phase).toBe("aborted");
    expect(aborted.recoveryReference).not.toBeNull();
    expect(existsSync(f.materialPath)).toBe(false);

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "aborted", dispatch: "terminal-report", fenceChecks: [] });
    expect(result.journal?.phase).toBe("aborted");
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(f.homeDir, ".lcm", "config.json"), "utf8")).storage.backend).toBe("sqlite");
  });

  it("abort after a publish witness was recorded is reported as aborted and never re-prepared", async () => {
    const f = fixture();
    const real = f.coordinator();
    await real.prepare(await prepareInput(f));
    await expect(f.coordinator(crashAt(f.homeDir, "after-journal-write", "config-published")).resume()).rejects.toThrow(/injected crash/);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("config-published");
    const aborted = await real.abort();
    expect(aborted).toMatchObject({ phase: "aborted" });
    expect(aborted.publishedConfigSha256).not.toBeNull();

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "aborted", dispatch: "terminal-report" });
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.abort).not.toHaveBeenCalled();
  });

  it("post-seal crash (preparing, no reference, material present): sealed bytes equal the artifact -> resume completes", async () => {
    const f = fixture();
    await expect(f.coordinator(crashAt(f.homeDir, "after-material-seal")).prepare(await prepareInput(f))).rejects.toThrow(/injected crash/);
    expect(readBackendPublicationJournal(f.homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
    expect(existsSync(f.materialPath)).toBe(true);

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "completed", dispatch: "resume-after-material-check" });
    expect(result.fenceChecks).toHaveLength(1);
    expect(coordinator.recoverPending).toHaveBeenCalledTimes(1);
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.abort).not.toHaveBeenCalled();
    expectPublished(f);
  });

  it("post-seal crash with sealed bytes that differ from the artifact: artifact-identity-mismatch, nothing driven", async () => {
    const f = fixture();
    await expect(f.coordinator(crashAt(f.homeDir, "after-material-seal")).prepare(await prepareInput(f))).rejects.toThrow(/injected crash/);
    const sealed = readFileSync(f.materialPath, "utf8");
    rmSync(f.materialPath);
    writeFileSync(f.materialPath, sealed.replace(PUBLICATION_ID, PUBLICATION_ID) + " ", { mode: 0o600 });

    const { result, coordinator } = await drive(f, f.coordinator());
    expect(result).toMatchObject({ status: "artifact-identity-mismatch", dispatch: "resume-after-material-check" });
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("preparing");
  });

  it.each(["prepared", "acquiring", "guarded", "map-published", "config-published"] as const)(
    "forward phase %s: fence precheck then recoverPending resume completes",
    async (phase) => {
      const f = fixture();
      const real = f.coordinator();
      await real.prepare(await prepareInput(f));
      if (phase !== "prepared") {
        await expect(f.coordinator(crashAt(f.homeDir, "after-journal-write", phase)).resume()).rejects.toThrow(/injected crash/);
      }
      expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe(phase);
      const { result, coordinator } = await drive(f, f.coordinator());
      expect(result).toMatchObject({ status: "completed", dispatch: "resume" });
      expect(result.fenceChecks).toHaveLength(1);
      expect(coordinator.recoverPending).toHaveBeenCalledTimes(1);
      expect(coordinator.prepare).not.toHaveBeenCalled();
      expectPublished(f);
    },
  );

  it.each(["releasing", "released"] as const)(
    "release tail %s (A3): recoverPending with NO fence precheck, even when the lease guard would report the fence absent",
    async (phase) => {
      const f = fixture();
      const real = f.coordinator();
      await real.prepare(await prepareInput(f));
      const event = phase === "releasing" ? "before-release" : "before-finalize";
      await expect(f.coordinator(crashAt(f.homeDir, event)).resume()).rejects.toThrow(/injected crash/);
      expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe(phase);
      // An absent-fence guard would refuse any precheck; the release tail must not run one.
      const { result, coordinator } = await drive(f, f.coordinator(), fakeGuard({}));
      expect(result).toMatchObject({ status: "completed", dispatch: "release-tail", fenceChecks: [] });
      expect(coordinator.recoverPending).toHaveBeenCalledTimes(1);
      expectPublished(f);
      // No fresh lease row: the provider still holds exactly the one released fence.
      const fence = await f.provider.readRemoteGuard({ homeDir: f.homeDir, journal: result.journal!, project: result.journal!.projects[0]! }, "release");
      expect(fence?.releasedAt).not.toBeNull();
    },
  );

  it("abort family (aborting): recoverPending completes the abort with no fence precheck and reports aborted", async () => {
    const f = fixture();
    const real = f.coordinator();
    await real.prepare(await prepareInput(f));
    await expect(f.coordinator(crashAt(f.homeDir, "after-journal-write", "config-published")).resume()).rejects.toThrow(/injected crash/);
    await expect(f.coordinator(crashAt(f.homeDir, "after-journal-write", "aborting")).abort()).rejects.toThrow(/injected crash/);
    expect(readBackendPublicationJournal(f.homeDir)?.phase).toBe("aborting");

    const { result, coordinator } = await drive(f, f.coordinator(), fakeGuard({}));
    expect(result).toMatchObject({ status: "aborted", dispatch: "abort-completion", fenceChecks: [] });
    expect(coordinator.recoverPending).toHaveBeenCalledTimes(1);
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(f.homeDir, ".lcm", "config.json"), "utf8")).storage.backend).toBe("sqlite");
  });

  it("completed journal of this publication is reported without driving anything", async () => {
    const f = fixture();
    await drive(f, f.coordinator());
    const { result, coordinator } = await drive(f, f.coordinator(), fakeGuard({}));
    expect(result).toMatchObject({ status: "completed", dispatch: "terminal-report", fenceChecks: [] });
    expect(coordinator.recoverPending).not.toHaveBeenCalled();
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });
});

describe("driveActivationPublication: material attribution and controlled-abort guards (injected)", () => {
  const preparing = () => baseJournal({ phase: "preparing", recoveryReference: null, publishedConfigSha256: null, publishedProjectMapSha256: null });

  it("is artifact-unresolvable, never a controlled abort, when the sealed material cannot be attributed", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => preparing(),
      readSealedMaterial: () => ({ kind: "unresolvable", detail: "EIO" }),
    });
    expect(result).toMatchObject({ status: "artifact-unresolvable", dispatch: null });
    expect(result.detail).toContain("EIO");
    expect(coordinator.abort).not.toHaveBeenCalled();
    expect(guard.read).not.toHaveBeenCalled();
  });

  it("is publication-unresolvable when the controlled abort does not reach aborted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const abort = vi.fn(async () => baseJournal({ phase: "aborting" }));
    const coordinator = fakeCoordinator({ abort });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => preparing(),
      readSealedMaterial: () => ({ kind: "absent" }),
      readArtifact: () => artifactMaterial(),
    });
    expect(result).toMatchObject({ status: "publication-unresolvable", dispatch: "controlled-abort-then-prepare" });
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("reports publication-collision when recoverPending after a matching sealed-material check returns another journal", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const content = backendPublicationMaterialContent(PUBLICATION_ID, { source: artifact.source, target: artifact.target });
    const recoverPending = vi.fn(async () => baseJournal({ publicationId: "publication-z", phase: "completed" }));
    const coordinator = fakeCoordinator({ recoverPending });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => preparing(),
      readSealedMaterial: () => ({ kind: "present", content }),
      readArtifact: () => artifact,
    });
    expect(result).toMatchObject({ status: "publication-collision", dispatch: "resume-after-material-check" });
  });

  it("reports aborted when the resume after a matching sealed-material check ends in the coordinator's own abort", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const artifact = artifactMaterial();
    const content = backendPublicationMaterialContent(PUBLICATION_ID, { source: artifact.source, target: artifact.target });
    const recoverPending = vi.fn(async () => baseJournal({ phase: "aborted" }));
    const coordinator = fakeCoordinator({ recoverPending });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => preparing(),
      readSealedMaterial: () => ({ kind: "present", content }),
      readArtifact: () => artifact,
    });
    expect(result).toMatchObject({ status: "aborted", dispatch: "resume-after-material-check" });
  });

  it("an aborted candidate (no reference, no witnesses) whose material is nevertheless present is reported as aborted, not re-prepared", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const coordinator = fakeCoordinator();
    const aborted = baseJournal({ phase: "aborted", recoveryReference: null, publishedConfigSha256: null, publishedProjectMapSha256: null });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => aborted,
      readSealedMaterial: () => ({ kind: "present", content: "x" }),
    });
    expect(result).toMatchObject({ status: "aborted", dispatch: "terminal-report" });
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it("a preparing journal that already carries a recovery reference is an ordinary resume (no material read)", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "preparing", recoveryReference: { relativePath: PUBLICATION_ID + ".material", sealSha256: "1".repeat(64), byteLength: 2 } });
    const readSealedMaterial = vi.fn(() => ({ kind: "absent" as const }));
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => ({ ...journal, phase: "completed" as const })) });
    const result = await driveActivationPublication(guard, coordinator, baseInput(), {
      readPublicationJournal: () => journal,
      readSealedMaterial,
    });
    expect(result).toMatchObject({ status: "completed", dispatch: "resume" });
    expect(readSealedMaterial).not.toHaveBeenCalled();
  });
});

describe("readSealedMaterialContent", () => {
  function publicationHome(): { homeDir: string; directory: string } {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-sealed-material-"));
    roots.push(homeDir);
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    const directory = backendPublicationDirectory(homeDir);
    mkdirSync(directory, { mode: 0o700 });
    return { homeDir, directory };
  }

  it("is positively absent only for ENOENT under an authenticated publication directory", () => {
    const { homeDir } = publicationHome();
    expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toEqual({ kind: "absent" });
  });

  it("returns the exact present bytes", () => {
    const { homeDir, directory } = publicationHome();
    writeFileSync(join(directory, PUBLICATION_ID + ".material"), "{}\n", { mode: 0o600 });
    expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toEqual({ kind: "present", content: "{}\n" });
  });

  it("is unresolvable when the publication directory is missing or unauthenticated", () => {
    const missing = mkdtempSync(join(tmpdir(), "lcm-sealed-material-missing-"));
    roots.push(missing);
    expect(readSealedMaterialContent(missing, PUBLICATION_ID)).toMatchObject({ kind: "unresolvable" });
    const { homeDir, directory } = publicationHome();
    chmodSync(directory, 0o755);
    try {
      expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toMatchObject({ kind: "unresolvable" });
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it("is unresolvable, never absent, when the material file's permission is denied", () => {
    const { homeDir, directory } = publicationHome();
    const path = join(directory, PUBLICATION_ID + ".material");
    writeFileSync(path, "{}\n", { mode: 0o000 });
    try {
      expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toMatchObject({ kind: "unresolvable" });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("is unresolvable, never absent, for a reader refusal without an errno code (a symlinked material file)", () => {
    const { homeDir, directory } = publicationHome();
    writeFileSync(join(directory, "elsewhere"), "{}\n", { mode: 0o600 });
    symlinkSync(join(directory, "elsewhere"), join(directory, PUBLICATION_ID + ".material"));
    expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toMatchObject({ kind: "unresolvable" });
  });

  it("still reads when process.getuid is unavailable (owner check pinned to undefined, like the sibling stores)", () => {
    const { homeDir, directory } = publicationHome();
    writeFileSync(join(directory, PUBLICATION_ID + ".material"), "{}\n", { mode: 0o600 });
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toEqual({ kind: "present", content: "{}\n" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("is unresolvable when the publication directory stops authenticating during the read", () => {
    const { homeDir, directory } = publicationHome();
    writeFileSync(join(directory, PUBLICATION_ID + ".material"), "{}\n", { mode: 0o600 });
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const original = nodeFs.statSync as typeof import("node:fs").statSync;
    let reads = 0;
    nodeFs.statSync = ((path: Parameters<typeof original>[0], ...rest: unknown[]) => {
      const stat = (original as unknown as (...args: unknown[]) => unknown)(path, ...rest) as { ino: bigint | number; isDirectory?: () => boolean };
      if (String(path) === directory && typeof stat.ino === "bigint") {
        reads += 1;
        // The reader's own open+stat passes; the post-read re-assertion sees another inode.
        if (reads > 1) return Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, { ino: stat.ino + 1n });
      }
      return stat;
    }) as unknown;
    syncBuiltinESMExports();
    try {
      expect(readSealedMaterialContent(homeDir, PUBLICATION_ID)).toMatchObject({ kind: "unresolvable", detail: expect.stringContaining("changed") });
    } finally {
      nodeFs.statSync = original;
      syncBuiltinESMExports();
    }
  });
});

