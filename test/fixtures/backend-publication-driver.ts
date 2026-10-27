import {
  BackendPublicationCoordinator,
  backendPublicationMaterialWitness,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
} from "../../src/storage/backend-publication.js";

/** An in-memory publication driver and material for driving a REAL BackendPublicationCoordinator without PostgreSQL. */
const capturedAt = "2026-09-06T00:00:00.000Z";

export function publicationRecoveryFile(content: string): BackendPublicationRecoveryFile {
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

export function publicationMaterial(): BackendPublicationRecoveryMaterial {
  return {
    source: {
      config: publicationRecoveryFile('{"backend":"sqlite"}'),
      projectMap: publicationRecoveryFile('{"projects":[]}'),
    },
    target: {
      config: publicationRecoveryFile('{"backend":"postgresql"}'),
      projectMap: publicationRecoveryFile('{"projects":["remote"]}'),
    },
  };
}

export function workingPublicationDriver(materialInput: BackendPublicationRecoveryMaterial): BackendPublicationDriver {
  let state = backendPublicationMaterialWitness(materialInput);
  const targetState = backendPublicationMaterialWitness({ source: materialInput.target, target: materialInput.target });
  const fences = new Map<string, BackendPublicationFenceRecord>();
  return {
    acquireRemoteGuard: async ({ journal, project }) => {
      const fence: BackendPublicationFenceRecord = {
        projectId: project.remoteProjectId,
        machineId: "machine-1",
        publicationId: journal.publicationId,
        targetBackend: journal.targetBackend,
        evidenceSha256: project.evidenceSha256,
        fencingToken: "1",
        acquiredAt: capturedAt,
        renewedAt: capturedAt,
        expiresAt: "2999-08-06T12:00:00.000Z",
        releasedAt: null,
        databaseExpired: false,
      };
      fences.set(project.remoteProjectId, fence);
      return fence;
    },
    readRemoteGuard: async ({ project }) => fences.get(project.remoteProjectId) ?? null,
    releaseRemoteGuard: async ({ project, fence }) => {
      fences.set(project.remoteProjectId, { ...fence, releasedAt: capturedAt });
    },
    observeLocalState: async () => state,
    publishProjectMap: async ({ permit }) => {
      permit.assertActive();
      state = { ...state, projectMap: targetState.projectMap };
      return targetState.projectMap;
    },
    publishConfig: async ({ permit }) => {
      permit.assertActive();
      state = { ...state, config: targetState.config };
      return targetState.config;
    },
    restoreConfig: async ({ permit }) => {
      permit.assertActive();
      return targetState.config;
    },
    restoreProjectMap: async ({ permit }) => {
      permit.assertActive();
      return targetState.projectMap;
    },
  };
}

/** The covered project of the rollback fixtures: a 64-hex local id (the project map's key shape) and its PostgreSQL id. */
export const FIXTURE_LOCAL_PROJECT_ID = "c".repeat(64);
export const FIXTURE_REMOTE_PROJECT_ID = "01990000-0000-7000-8000-0000000000aa";

function fixtureProjectMapFile(bound: boolean): BackendPublicationRecoveryFile {
  return publicationRecoveryFile(JSON.stringify({
    [FIXTURE_LOCAL_PROJECT_ID]: {
      canonical: "/covered",
      aliases: [],
      ...(bound ? { remoteProjectId: FIXTURE_REMOTE_PROJECT_ID } : {}),
    },
  }));
}

/** The material of the rollback publication: postgresql config and bound map become sqlite config and unbound map. */
export function rollbackPublicationMaterial(): BackendPublicationRecoveryMaterial {
  return {
    source: {
      config: publicationRecoveryFile('{"storage":{"backend":"postgresql"}}'),
      projectMap: fixtureProjectMapFile(true),
    },
    target: {
      config: publicationRecoveryFile('{"storage":{"backend":"sqlite"}}'),
      projectMap: fixtureProjectMapFile(false),
    },
  };
}

/** The retained material of the activation the rollback unwinds: the same files in the opposite direction. */
export function activationPublicationMaterial(): BackendPublicationRecoveryMaterial {
  const rollback = rollbackPublicationMaterial();
  return { source: rollback.target, target: rollback.source };
}

/** A coordinator over the in-memory driver that publishes the rollback material. */
export function rollbackFixtureCoordinator(homeDir: string): BackendPublicationCoordinator {
  return new BackendPublicationCoordinator({ homeDir, driver: workingPublicationDriver(rollbackPublicationMaterial()) });
}
