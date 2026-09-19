import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import type { ActivationLeasePublicationGuard } from "../../src/migration/activation-lease.js";
import {
  ActivationArtifactPresenceUnresolvableError,
  type ActivationArtifactRecoveryMaterial,
} from "../../src/migration/activation-artifact-store.js";
import {
  driveActivationPublication,
  type ActivationPublicationCoordinator,
  type ActivationPublicationInput,
} from "../../src/migration/activation-publication.js";
import type {
  BackendPublicationJournal,
  BackendPublicationLockToken,
  BackendPublicationRecoveryFile,
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
    projects: [],
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
    const journal = baseJournal({ phase: "completed" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput({ projects: [] }));
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
    const result = await driveActivationPublication(guard, coordinator, input);
    expect(result).toMatchObject({ status: "completed", journal });
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
  });

  it("reports aborted when recoverPending drives this exact publicationId to aborted", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ phase: "aborted", publicationId: PUBLICATION_ID });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result).toMatchObject({ status: "aborted", journal });
  });

  it("reports publication-collision when a different, still in-flight generation occupies the journal", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const journal = baseJournal({ publicationId: "other-publication", phase: "guarded" });
    const coordinator = fakeCoordinator({ recoverPending: vi.fn(async () => journal) });
    const result = await driveActivationPublication(guard, coordinator, baseInput());
    expect(result.status).toBe("publication-collision");
    expect(result.journal).toEqual(journal);
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
      recoverPending: vi.fn(async () => stale),
      prepare,
      resume,
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
    );
    expect(result).toMatchObject({ status: "completed", journal: resumed });
    expect(prepare).toHaveBeenCalled();
  });

  it("treats a stale aborted journal from an unrelated generation as absent and proceeds to a fresh prepare", async () => {
    const guard = fakeGuard({ "remote-a": "satisfied" });
    const stale = baseJournal({ publicationId: "other-publication", phase: "aborted" });
    const resumed = baseJournal({ phase: "completed" });
    const coordinator = fakeCoordinator({
      recoverPending: vi.fn(async () => stale),
      prepare: vi.fn(async () => baseJournal({ phase: "prepared" })),
      resume: vi.fn(async () => resumed),
    });
    const artifact = artifactMaterial();
    const result = await driveActivationPublication(
      guard,
      coordinator,
      baseInput(),
      { readArtifact: () => artifact },
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
    expect(recoverPending).toHaveBeenCalledWith({ disposition: "resume" }, input.lockToken);
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
