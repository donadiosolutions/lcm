import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedStorageConfig } from "../src/daemon/config.js";
import {
  createProject,
  linkProject,
  listProjects,
  ProjectIdentityReconciliationError,
  recoverMachine,
  registerMachine,
  RemoteIdentityConfigurationError,
  showMachine,
  showProject,
  unlinkProject,
  type IdentityRepository,
  type IdentityServiceDependencies,
} from "../src/identity-service.js";
import {
  addProjectAlias,
  clearRemoteProjectBinding,
  clearProjectMapCache,
  listProjectMapEntries,
  projectMapPath,
  removeProjectAlias,
  resolveProjectIdentity,
  setRemoteProjectBinding,
  showProjectMapEntry,
} from "../src/project-map.js";
import {
  PostgreSqlIdentityAliasPathConflictError,
  PostgreSqlIdentityConflictError,
  PostgreSqlIdentityCreateOutcomeUnknownError,
  PostgreSqlIdentityLinkOutcomeUnknownError,
  PostgreSqlIdentityNotFoundError,
  PostgreSqlIdentityReplaceAliasesOutcomeUnknownError,
  PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError,
  PostgreSqlIdentityUnlinkPathOutcomeUnknownError,
  type RegisteredMachine,
  type RemoteAliasOwnership,
  type RemoteProject,
  type RemoteProjectAlias,
  type RemoteProjectAliasMutation,
} from "../src/storage/postgresql/identity-repository.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../src/storage/postgresql/errors.js";
import { quoteShellArgument } from "../src/shell-quote.js";
import {
  ensurePendingMachineIdentity,
  machineIdentityPath,
} from "../src/machine-identity.js";
import { withPrivateMutationLockAsync } from "../src/private-mutation-lock.js";

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const MACHINE_B = "018f22c4-6d2a-7f10-9a4c-6b8d3e5f9013";
const PROJECT_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const PROJECT_B = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
const SQLITE_CONFIG: ResolvedStorageConfig = { backend: "sqlite" };
const POSTGRESQL_CONFIG: ResolvedStorageConfig = {
  backend: "postgresql",
  postgresql: {
    url: "postgresql://user:secret@db.example/lcm",
    caFile: "/secure/ca.pem",
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
  },
};

function alias(
  projectId: string,
  normalizedPath: string,
  path = normalizedPath,
): RemoteProjectAlias {
  return {
    machineId: MACHINE_ID,
    path,
    normalizedPath,
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
}

function remoteProject(projectId: string, displayName = "Project"): RemoteProject {
  return {
    projectId,
    displayName,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    aliases: [],
  };
}

function batchMutation(
  projectId: string,
  paths: readonly string[],
  prior: readonly (RemoteAliasOwnership | null)[] = paths.map(() => null),
  inserted: readonly boolean[] = prior.map((owner) => owner === null),
) {
  return {
    aliases: paths.map((path) => alias(projectId, path)),
    prior,
    inserted,
  };
}

function fakeRepository(): IdentityRepository & {
  [K in keyof IdentityRepository]: IdentityRepository[K] & ReturnType<typeof vi.fn>;
} {
  const projects = new Map<string, RemoteProject>();
  const aliases = new Map<string, { projectId: string; alias: RemoteProjectAlias }>();
  let nextProjectId = PROJECT_A;
  const linkWithOwnership = async (
    input: Parameters<IdentityRepository["linkProject"]>[0],
  ): Promise<RemoteProjectAliasMutation> => {
    const existing = aliases.get(input.normalizedPath);
    if (existing && existing.projectId !== input.projectId) throw new Error("collision");
    if (existing) return { alias: existing.alias, inserted: false };
    const linked = alias(input.projectId, input.normalizedPath, input.path);
    aliases.set(input.normalizedPath, { projectId: input.projectId, alias: linked });
    projects.set(
      input.projectId,
      projects.get(input.projectId) ?? remoteProject(input.projectId),
    );
    return { alias: linked, inserted: true };
  };
  const repository: IdentityRepository = {
    registerMachine: vi.fn(async (identityKey: string, displayName: string): Promise<RegisteredMachine> => ({
      machineId: MACHINE_ID,
      identityKey,
      displayName,
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })),
    recoverMachine: vi.fn(async (machineId: string): Promise<RegisteredMachine> => ({
      machineId,
      identityKey: `machine:${"a".repeat(64)}`,
      displayName: "Recovered",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    })),
    createProject: vi.fn(async (input): Promise<RemoteProject> => {
      const project = remoteProject(nextProjectId, input.displayName);
      const inputs = input.aliases ?? [{
        path: input.path,
        normalizedPath: input.normalizedPath,
      }];
      project.aliases = inputs.map(({ path, normalizedPath }) => (
        alias(nextProjectId, normalizedPath, path)
      ));
      projects.set(nextProjectId, project);
      for (const remoteAlias of project.aliases) {
        aliases.set(remoteAlias.normalizedPath, {
          projectId: nextProjectId,
          alias: remoteAlias,
        });
      }
      return project;
    }),
    linkProject: vi.fn(async (input): Promise<RemoteProjectAlias> => (
      (await linkWithOwnership(input)).alias
    )),
    linkProjectWithOwnership: vi.fn(linkWithOwnership),
    replaceProjectAlias: vi.fn(async (input): Promise<RemoteProjectAlias | null> => {
      const existing = aliases.get(input.normalizedPath);
      if (existing?.projectId !== input.expectedPriorProjectId) return null;
      const linked = alias(input.projectId, input.normalizedPath, input.path);
      aliases.set(input.normalizedPath, { projectId: input.projectId, alias: linked });
      projects.set(
        input.projectId,
        projects.get(input.projectId) ?? remoteProject(input.projectId),
      );
      return linked;
    }),
    replaceProjectAliases: vi.fn(async (input) => {
      const current = input.aliases.map(({ normalizedPath }) => aliases.get(normalizedPath) ?? null);
      if (current.some((owner) => (
        owner
        && owner.projectId !== input.projectId
        && owner.projectId !== input.expectedPriorProjectId
      ))) {
        return null;
      }
      input.aliases.forEach(({ path, normalizedPath }, index) => {
        const owner = current[index];
        if (owner?.projectId === input.projectId && owner.alias.path !== path) {
          throw new PostgreSqlIdentityAliasPathConflictError(
            input.machineId,
            normalizedPath,
            input.projectId,
            owner.alias.path,
            path,
          );
        }
      });
      const linked = input.aliases.map(({ path, normalizedPath }) => {
        const remoteAlias = alias(input.projectId, normalizedPath, path);
        aliases.set(normalizedPath, { projectId: input.projectId, alias: remoteAlias });
        return remoteAlias;
      });
      return {
        aliases: linked,
        prior: current,
        inserted: current.map((owner) => owner === null),
      };
    }),
    restoreProjectAliasBatch: vi.fn(async (
      _machineId,
      currentProjectId,
      prior,
      inserted,
      inputs,
    ) => {
      const current = inputs.map(({ normalizedPath }) => aliases.get(normalizedPath));
      if (current.some((owner) => owner?.projectId !== currentProjectId)) return false;
      inputs.forEach(({ normalizedPath }, index) => {
        const previous = prior[index];
        if (previous) aliases.set(normalizedPath, previous);
        else if (inserted[index]) aliases.delete(normalizedPath);
      });
      return true;
    }),
    unlinkPath: vi.fn(async (_machineId, normalizedPath) => {
      const existing = aliases.get(normalizedPath);
      aliases.delete(normalizedPath);
      return existing ?? null;
    }),
    unlinkProjectAliasIfOwned: vi.fn(async (_machineId, normalizedPath, projectId, path) => {
      const existing = aliases.get(normalizedPath);
      if (existing?.projectId !== projectId || existing.alias.path !== path) return null;
      aliases.delete(normalizedPath);
      return existing;
    }),
    unlinkProjectAliasesIfOwned: vi.fn(async (_machineId, projectId, inputs) => {
      const current = inputs.map(({ normalizedPath }) => aliases.get(normalizedPath));
      if (current.some((owner, index) => (
        owner
        && (
          owner.projectId !== projectId
          || owner.alias.path !== inputs[index]?.path
        )
      ))) return null;
      const removed = current.flatMap((owner) => owner ? [owner.alias] : []);
      for (const { normalizedPath } of inputs) aliases.delete(normalizedPath);
      return removed;
    }),
    unlinkProject: vi.fn(async (_machineId, projectId) => {
      const removed: RemoteProjectAlias[] = [];
      for (const [path, value] of aliases) {
        if (value.projectId === projectId) {
          removed.push(value.alias);
          aliases.delete(path);
        }
      }
      return removed;
    }),
    deleteProjectIfUnreferenced: vi.fn(async (projectId) => projects.delete(projectId)),
    cleanupCreatedProject: vi.fn(async (_machineId, projectId, normalizedPaths) => {
      for (const normalizedPath of normalizedPaths) {
        const existing = aliases.get(normalizedPath);
        if (existing?.projectId === projectId) aliases.delete(normalizedPath);
      }
      return projects.delete(projectId);
    }),
    restoreProjectAlias: vi.fn(async (input) => {
      const current = aliases.get(input.normalizedPath);
      if (current && current.projectId !== input.currentProjectId) return false;
      aliases.delete(input.normalizedPath);
      if (input.prior) aliases.set(input.normalizedPath, input.prior);
      return true;
    }),
    restoreProjectAliases: vi.fn(async (_machineId, projectId, restoredAliases) => {
      if (restoredAliases.some((restored) => aliases.has(restored.normalizedPath))) {
        return false;
      }
      for (const restored of restoredAliases) {
        aliases.set(restored.normalizedPath, { projectId, alias: restored });
      }
      return true;
    }),
    resolveProjectAliasesByPath: vi.fn(async (_machineId, paths) => (
      [...aliases.values()]
        .filter((owner) => paths.includes(owner.alias.path))
        .sort((left, right) => (
          left.alias.path.localeCompare(right.alias.path)
          || left.alias.normalizedPath.localeCompare(right.alias.normalizedPath)
          || left.projectId.localeCompare(right.projectId)
        ))
    )),
    resolveProject: vi.fn(async (_machineId, normalizedPath) => aliases.get(normalizedPath) ?? null),
    listProjects: vi.fn(async () => [...projects.values()]),
    getProject: vi.fn(async (projectId) => projects.get(projectId) ?? null),
  };
  Object.defineProperty(repository, "setNextProjectId", {
    value: (value: string) => { nextProjectId = value; },
  });
  return repository as ReturnType<typeof fakeRepository>;
}

describe("identity service", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;
  let repository: ReturnType<typeof fakeRepository>;
  let close: ReturnType<typeof vi.fn>;
  let deps: Partial<IdentityServiceDependencies>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-identity-service-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    clearProjectMapCache();
    repository = fakeRepository();
    close = vi.fn(async () => undefined);
    deps = {
      homeDir: home,
      openSession: vi.fn(async () => ({ repository, close })),
    };
  });

  afterEach(() => {
    clearProjectMapCache();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  function makeProject(name: string): string {
    const path = join(home, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  async function register(): Promise<void> {
    await registerMachine(POSTGRESQL_CONFIG, { displayName: "Machine A" }, deps);
  }

  it("registers, shows, and idempotently refreshes a machine identity", async () => {
    const first = await registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Machine A" },
      deps,
    );
    const second = await registerMachine(POSTGRESQL_CONFIG, {}, deps);

    expect(first.created).toBe(true);
    expect(first.identity).toMatchObject({ machineId: MACHINE_ID, displayName: "Machine A" });
    expect(second.created).toBe(false);
    expect(second.identity).toEqual(first.identity);
    expect(showMachine(deps)).toEqual(first.identity);
    expect(repository.registerMachine).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("normalizes and validates a requested machine name before PostgreSQL mutation", async () => {
    await register();
    await registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "  Renamed Machine  " },
      deps,
    );
    expect(repository.registerMachine).toHaveBeenLastCalledWith(
      expect.any(String),
      "Renamed Machine",
    );
    const calls = repository.registerMachine.mock.calls.length;
    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "bad\u0000name" },
      deps,
    )).rejects.toThrow("printable characters");
    expect(repository.registerMachine).toHaveBeenCalledTimes(calls);
  });

  it("serializes concurrent PostgreSQL upserts and reconciles the waiting registration", async () => {
    await register();
    const identityKey = showMachine(deps)!.identityKey;
    let databaseDisplayName = "Machine A";
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstReachedRepository = new Promise<void>((resolve) => { firstStarted = resolve; });
    repository.registerMachine = vi.fn(async (_identityKey, displayName) => {
      if (displayName === "First Rename") {
        firstStarted();
        await firstGate;
      }
      databaseDisplayName = displayName;
      return {
        machineId: MACHINE_ID,
        identityKey,
        displayName,
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
    });
    repository.recoverMachine = vi.fn(async () => ({
      machineId: MACHINE_ID,
      identityKey,
      displayName: databaseDisplayName,
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }));

    const first = registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "First Rename" },
      deps,
    );
    await firstReachedRepository;
    const second = registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Second Rename" },
      deps,
    );
    expect(repository.registerMachine).toHaveBeenCalledTimes(1);
    releaseFirst();

    await expect(first).resolves.toMatchObject({
      identity: { machineId: MACHINE_ID, displayName: "First Rename" },
    });
    await expect(second).resolves.toMatchObject({
      identity: { machineId: MACHINE_ID, displayName: "Second Rename" },
    });
    expect(databaseDisplayName).toBe("Second Rename");
    expect(showMachine(deps)).toMatchObject({
      identityKey,
      machineId: MACHINE_ID,
      displayName: "Second Rename",
    });
    expect(repository.recoverMachine).not.toHaveBeenCalled();
  });

  it("keeps a concurrent registration newer than a forced recovery read", async () => {
    await register();
    const original = showMachine(deps)!;
    let releaseRecovery!: () => void;
    let recoveryStarted!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recoveryReachedRepository = new Promise<void>(
      (resolve) => { recoveryStarted = resolve; },
    );
    repository.recoverMachine = vi.fn(async () => {
      const stale = {
        machineId: MACHINE_ID,
        identityKey: original.identityKey,
        displayName: original.displayName,
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      recoveryStarted();
      await recoveryGate;
      return stale;
    });
    repository.registerMachine.mockClear();

    const recovering = recoverMachine(
      POSTGRESQL_CONFIG,
      MACHINE_ID,
      { force: true },
      deps,
    );
    await recoveryReachedRepository;
    const registering = registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "New Machine Name" },
      deps,
    );
    expect(repository.registerMachine).not.toHaveBeenCalled();
    releaseRecovery();

    await expect(recovering).resolves.toMatchObject({
      identity: { displayName: "Machine A" },
    });
    await expect(registering).resolves.toMatchObject({
      identity: { displayName: "New Machine Name" },
    });
    expect(repository.registerMachine).toHaveBeenCalledWith(
      original.identityKey,
      "New Machine Name",
    );
    expect(showMachine(deps)).toMatchObject({
      identityKey: original.identityKey,
      machineId: MACHINE_ID,
      displayName: "New Machine Name",
    });
  });

  it("does not retry malformed remote identity locks during registration", async () => {
    mkdirSync(join(home, ".lcm"), { recursive: true });
    writeFileSync(`${machineIdentityPath(home)}.remote.lock`, "not json\n", {
      mode: 0o600,
    });

    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Machine A" },
      deps,
    )).rejects.toThrow("remote identity lock is malformed");
    expect(repository.registerMachine).not.toHaveBeenCalled();
  });

  it("reconciles an out-of-band local rename from authoritative registration readback", async () => {
    await register();
    const original = showMachine(deps)!;
    repository.registerMachine = vi.fn(async (identityKey, displayName) => {
      writeFileSync(
        machineIdentityPath(home),
        `${JSON.stringify({ ...original, displayName: "Out-of-band Rename" })}\n`,
        { mode: 0o600 },
      );
      return {
        machineId: MACHINE_ID,
        identityKey,
        displayName,
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
    });
    repository.recoverMachine = vi.fn(async () => ({
      machineId: MACHINE_ID,
      identityKey: original.identityKey,
      displayName: "Requested Rename",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }));

    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Requested Rename" },
      deps,
    )).resolves.toMatchObject({
      identity: { displayName: "Requested Rename" },
    });
    expect(repository.recoverMachine).toHaveBeenCalledWith(MACHINE_ID);
    expect(showMachine(deps)).toMatchObject({
      identityKey: original.identityKey,
      machineId: MACHINE_ID,
      displayName: "Requested Rename",
    });
  });

  it.each([
    {
      case: "machine ID",
      recoveredMachineId: "018f22c4-6d2a-7f10-9a4c-6b8d3e5f9013",
      recoveredIdentityKey: undefined,
    },
    {
      case: "identity key",
      recoveredMachineId: MACHINE_ID,
      recoveredIdentityKey: `machine:${"b".repeat(64)}`,
    },
  ])("fails closed when registration readback returns a different $case", async ({
    recoveredMachineId,
    recoveredIdentityKey,
  }) => {
    await register();
    const original = showMachine(deps)!;
    repository.registerMachine = vi.fn(async (identityKey, displayName) => {
      writeFileSync(
        machineIdentityPath(home),
        `${JSON.stringify({ ...original, displayName: "Concurrent Rename" })}\n`,
        { mode: 0o600 },
      );
      return {
        machineId: MACHINE_ID,
        identityKey,
        displayName,
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
    });
    repository.recoverMachine = vi.fn(async () => ({
      machineId: recoveredMachineId,
      identityKey: recoveredIdentityKey ?? original.identityKey,
      displayName: "Requested Rename",
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }));

    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Requested Rename" },
      deps,
    )).rejects.toThrow("machine identity changed during registration");
    expect(showMachine(deps)).toMatchObject({ displayName: "Concurrent Rename" });
  });

  it("preserves non-concurrency machine finalization errors", async () => {
    repository.registerMachine = vi.fn(async (identityKey, displayName) => ({
      machineId: "not-a-uuid",
      identityKey,
      displayName,
      registeredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    }));

    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "Machine A" },
      deps,
    )).rejects.toThrow("PostgreSQL returned an invalid machine ID");
    expect(repository.recoverMachine).not.toHaveBeenCalled();
  });

  it("honors an explicit retry name while retaining the pending identity key", async () => {
    const pending = ensurePendingMachineIdentity("Winning Machine", home);

    await expect(registerMachine(
      POSTGRESQL_CONFIG,
      { displayName: "  Requested Retry  " },
      deps,
    )).resolves.toMatchObject({
      created: false,
      identity: {
        identityKey: pending.identity.identityKey,
        displayName: "Requested Retry",
      },
    });
    expect(repository.registerMachine).toHaveBeenCalledWith(
      pending.identity.identityKey,
      "Requested Retry",
    );
  });

  it("bounds registration retries when the remote identity lock stays busy", async () => {
    const lockPath = `${machineIdentityPath(home)}.remote.lock`;
    let releaseLock!: () => void;
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = withPrivateMutationLockAsync(
      lockPath,
      "remote identity",
      async () => {
        signalAcquired();
        await release;
      },
    );
    await acquired;
    const waitForRetry = vi.fn(async () => undefined);

    try {
      await expect(registerMachine(
        POSTGRESQL_CONFIG,
        { displayName: "Machine A" },
        {
          ...deps,
          remoteIdentityLockMaxAttempts: 2,
          waitForRemoteIdentityLock: waitForRetry,
        },
      )).rejects.toMatchObject({
        name: "MachineIdentityFileError",
        message: expect.stringContaining("remained busy after 2 attempts"),
        remediation: expect.stringContaining("lcm machine register"),
      });
      expect(waitForRetry).toHaveBeenCalledTimes(1);
      expect(repository.registerMachine).not.toHaveBeenCalled();
      expect(showMachine(deps)).toBeNull();
    } finally {
      releaseLock();
      await holder;
    }
  });

  it("requires PostgreSQL configuration before creating local registration state", async () => {
    await expect(registerMachine(SQLITE_CONFIG, {}, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    expect(showMachine(deps)).toBeNull();
  });

  it("recovers an explicit machine ID and validates its shape", async () => {
    await expect(recoverMachine(POSTGRESQL_CONFIG, MACHINE_ID, {}, deps))
      .resolves.toMatchObject({ identity: { machineId: MACHINE_ID, displayName: "Recovered" } });
    await expect(recoverMachine(POSTGRESQL_CONFIG, "not-v7", {}, deps))
      .rejects.toThrow("invalid PostgreSQL machine UUIDv7");
  });

  it("rejects forced machine recovery while a project create is in progress", async () => {
    await register();
    const path = makeProject("recover-during-create");
    const originalCreate = repository.createProject.getMockImplementation()!;
    let releaseCreate!: () => void;
    let createReachedRepository!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { createReachedRepository = resolve; },
    );
    repository.createProject = vi.fn(async (input) => {
      const created = await originalCreate(input);
      createReachedRepository();
      await createGate;
      return created;
    });
    repository.recoverMachine.mockClear();

    const creating = createProject(POSTGRESQL_CONFIG, path, {}, deps);
    await repositoryReached;
    await expect(recoverMachine(
      POSTGRESQL_CONFIG,
      MACHINE_B,
      { force: true },
      deps,
    )).rejects.toThrow("remote identity mutation is already in progress");
    expect(repository.recoverMachine).not.toHaveBeenCalled();
    expect(showMachine(deps)).toMatchObject({ machineId: MACHINE_ID });
    releaseCreate();

    await expect(creating).resolves.toMatchObject({
      local: { remoteProjectId: PROJECT_A },
    });
    expect(repository.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: MACHINE_ID }),
    );
  });

  it("rejects forced machine recovery while a project link is in progress", async () => {
    await register();
    const path = makeProject("recover-during-link");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    let releaseLink!: () => void;
    let linkReachedRepository!: () => void;
    const linkGate = new Promise<void>((resolve) => { releaseLink = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { linkReachedRepository = resolve; },
    );
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const linked = await originalReplace(input);
      linkReachedRepository();
      await linkGate;
      return linked;
    });
    repository.recoverMachine.mockClear();

    const linking = linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    await repositoryReached;
    await expect(recoverMachine(
      POSTGRESQL_CONFIG,
      MACHINE_B,
      { force: true },
      deps,
    )).rejects.toThrow("remote identity mutation is already in progress");
    expect(repository.recoverMachine).not.toHaveBeenCalled();
    expect(showMachine(deps)).toMatchObject({ machineId: MACHINE_ID });
    releaseLink();

    await expect(linking).resolves.toMatchObject({
      local: { remoteProjectId: PROJECT_A },
    });
    expect(repository.replaceProjectAliases).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: MACHINE_ID }),
    );
  });

  it("rejects forced machine recovery while a project unlink is in progress", async () => {
    await register();
    const path = makeProject("recover-during-unlink");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    let releaseUnlink!: () => void;
    let unlinkReachedRepository!: () => void;
    const unlinkGate = new Promise<void>((resolve) => { releaseUnlink = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { unlinkReachedRepository = resolve; },
    );
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, aliases) => {
      const removed = await originalUnlink(machineId, projectId, aliases);
      unlinkReachedRepository();
      await unlinkGate;
      return removed;
    });
    repository.recoverMachine.mockClear();

    const unlinking = unlinkProject(POSTGRESQL_CONFIG, path, deps);
    await repositoryReached;
    await expect(recoverMachine(
      POSTGRESQL_CONFIG,
      MACHINE_B,
      { force: true },
      deps,
    )).rejects.toThrow("remote identity mutation is already in progress");
    expect(repository.recoverMachine).not.toHaveBeenCalled();
    expect(showMachine(deps)).toMatchObject({ machineId: MACHINE_ID });
    releaseUnlink();

    await expect(unlinking).resolves.toMatchObject({
      remoteProjectId: PROJECT_A,
      aliasRemoved: false,
    });
    expect(repository.unlinkProjectAliasesIfOwned).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      expect.any(Array),
    );
  });

  it("uses the recovered machine only after recovery releases remote identity ownership", async () => {
    await register();
    const path = makeProject("create-after-recovery");
    const localCanonical = makeProject("local-link-during-recovery-canonical");
    const localAlias = makeProject("local-link-during-recovery-alias");
    const local = resolveProjectIdentity(localCanonical);
    const originalRecover = repository.recoverMachine.getMockImplementation()!;
    let releaseRecovery!: () => void;
    let recoveryReachedRepository!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { recoveryReachedRepository = resolve; },
    );
    repository.recoverMachine = vi.fn(async (machineId) => {
      const recovered = await originalRecover(machineId);
      recoveryReachedRepository();
      await recoveryGate;
      return recovered;
    });

    const recovering = recoverMachine(
      POSTGRESQL_CONFIG,
      MACHINE_B,
      { force: true },
      deps,
    );
    await repositoryReached;
    await expect(linkProject(SQLITE_CONFIG, local.id, localAlias, {}, deps))
      .resolves.toMatchObject({ local: { id: local.id } });
    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toThrow("remote identity mutation is already in progress");
    expect(repository.createProject).not.toHaveBeenCalled();
    releaseRecovery();

    await expect(recovering).resolves.toMatchObject({
      identity: { machineId: MACHINE_B },
    });
    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .resolves.toMatchObject({ local: { remoteProjectId: PROJECT_A } });
    expect(repository.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: MACHINE_B }),
    );
  });

  it("lists local projects offline and enriches PostgreSQL listings", async () => {
    const path = makeProject("list");
    const secondPath = makeProject("list-second");
    resolveProjectIdentity(path);
    resolveProjectIdentity(secondPath);
    setRemoteProjectBinding(PROJECT_A, { canonical: secondPath });
    expect(await listProjects(SQLITE_CONFIG, deps)).toMatchObject({
      local: expect.arrayContaining([
        { canonical: path, aliases: [], hash: expect.any(String) },
        {
          canonical: secondPath,
          aliases: [],
          hash: expect.any(String),
          remoteProjectId: PROJECT_A,
        },
      ]),
    });
    expect(deps.openSession).not.toHaveBeenCalled();

    repository.listProjects = vi.fn(async () => [remoteProject(PROJECT_A)]);
    const listed = await listProjects(POSTGRESQL_CONFIG, deps);
    expect(listed.remote).toEqual([expect.objectContaining({ projectId: PROJECT_A })]);
  });

  it("shows local projects offline and validates remote bindings online", async () => {
    const path = makeProject("show");
    resolveProjectIdentity(path);
    expect(await showProject(SQLITE_CONFIG, path, deps))
      .toMatchObject({ entry: { canonical: path } });

    setRemoteProjectBinding(PROJECT_A, { canonical: path });
    repository.getProject = vi.fn(async () => remoteProject(PROJECT_A));
    await expect(showProject(POSTGRESQL_CONFIG, path, deps))
      .resolves.toMatchObject({ remote: { projectId: PROJECT_A } });
    expect(repository.getProject).toHaveBeenCalledWith(PROJECT_A);
    expect(repository.listProjects).not.toHaveBeenCalled();

    repository.getProject = vi.fn(async () => null);
    await expect(showProject(POSTGRESQL_CONFIG, path, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
  });

  it("creates a remote project and binds the unchanged local hash", async () => {
    await register();
    const path = makeProject("create");
    const before = resolveProjectIdentity(path);

    const created = await createProject(
      POSTGRESQL_CONFIG,
      path,
      { displayName: "Created" },
      deps,
    );

    expect(created.local).toEqual({ ...before, remoteProjectId: PROJECT_A });
    expect(created.remote).toMatchObject({ projectId: PROJECT_A, displayName: "Created" });
    expect(repository.createProject.mock.calls[0]?.[0]).not.toHaveProperty("identityKey");
    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toThrow("already bound");
  });

  it("retains the entered path while realpath-normalizing the remote alias", async () => {
    await register();
    const canonical = makeProject("create-realpath");
    const entered = join(home, "create-realpath-link");
    symlinkSync(canonical, entered);

    const created = await createProject(POSTGRESQL_CONFIG, entered, {}, deps);

    expect(repository.createProject).toHaveBeenCalledWith(expect.objectContaining({
      path: entered,
      normalizedPath: canonical,
      aliases: [{ path: entered, normalizedPath: canonical }],
    }));
    expect(showProjectMapEntry(created.local.id).entry).toEqual({
      canonical,
      aliases: [entered],
      remoteProjectId: PROJECT_A,
    });
    await expect(repository.resolveProject(MACHINE_ID, canonical))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: entered, normalizedPath: canonical },
      });
    await expect(showProject(POSTGRESQL_CONFIG, entered, deps))
      .resolves.toMatchObject({
        hash: created.local.id,
        entry: { canonical, aliases: [entered], remoteProjectId: PROJECT_A },
      });
    await expect(unlinkProject(POSTGRESQL_CONFIG, entered, deps))
      .resolves.toMatchObject({
        hash: created.local.id,
        remoteProjectId: PROJECT_A,
        aliasRemoved: true,
      });
    expect(showProjectMapEntry(created.local.id).entry.aliases).toEqual([]);
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
  });

  it("restores the prior local map when symlink project creation fails remotely", async () => {
    await register();
    const canonical = makeProject("create-symlink-remote-failure-target");
    const entered = join(home, "create-symlink-remote-failure-entered");
    symlinkSync(canonical, entered);
    const remoteFailure = new PostgreSqlIdentityNotFoundError("project", PROJECT_A);
    repository.createProject = vi.fn(async () => {
      throw remoteFailure;
    });

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBe(remoteFailure);

    expect(showProjectMapEntry(canonical).entry).toEqual({
      canonical,
      aliases: [],
    });
  });

  it("restores a newly added symlink alias when session acquisition fails and permits retry", async () => {
    await register();
    const canonical = makeProject("create-session-failure-target");
    const entered = join(home, "create-session-failure-entered");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    const acquisitionFailure = new Error("session acquisition failed");
    const originalOpenSession = deps.openSession!;
    const openSession = vi.fn()
      .mockRejectedValueOnce(acquisitionFailure)
      .mockImplementation(originalOpenSession);
    deps = { ...deps, openSession };

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBe(acquisitionFailure);
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [],
    });
    expect(repository.createProject).not.toHaveBeenCalled();

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .resolves.toMatchObject({
        local: { id: local.id, canonical, remoteProjectId: PROJECT_A },
      });
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [entered],
      remoteProjectId: PROJECT_A,
    });
    expect(repository.createProject).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it("accepts an exact concurrent alias restoration when session acquisition fails", async () => {
    await register();
    const canonical = makeProject("create-session-concurrent-restore-target");
    const entered = join(home, "create-session-concurrent-restore-entered");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    const acquisitionFailure = new Error("session acquisition failed");
    deps = {
      ...deps,
      openSession: vi.fn(async () => {
        removeProjectAlias(entered, { hash: local.id });
        throw acquisitionFailure;
      }),
    };

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBe(acquisitionFailure);
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [],
    });
  });

  it("does not clobber a concurrent map change while restoring after session failure", async () => {
    await register();
    const canonical = makeProject("create-session-concurrent-change-target");
    const entered = join(home, "create-session-concurrent-change-entered");
    const concurrent = makeProject("create-session-concurrent-change-alias");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    deps = {
      ...deps,
      openSession: vi.fn(async () => {
        addProjectAlias(concurrent, { hash: local.id });
        throw new Error("session acquisition failed");
      }),
    };

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toThrow("changed during coordinated mutation");
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [entered, concurrent],
    });
    expect(repository.createProject).not.toHaveBeenCalled();
  });

  it("retains an existing local alias when session acquisition fails", async () => {
    await register();
    const canonical = makeProject("create-session-existing-target");
    const entered = makeProject("create-session-existing-entered");
    const local = resolveProjectIdentity(canonical);
    addProjectAlias(entered, { hash: local.id });
    const acquisitionFailure = new Error("session acquisition failed");
    deps = {
      ...deps,
      openSession: vi.fn(async () => {
        throw acquisitionFailure;
      }),
    };

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBe(acquisitionFailure);
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [entered],
    });
  });

  it("accepts an equivalent concurrent restoration after remote creation fails", async () => {
    await register();
    const canonical = makeProject("create-symlink-concurrent-remote-failure-target");
    const entered = join(home, "create-symlink-concurrent-remote-failure-entered");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    const remoteFailure = new PostgreSqlIdentityNotFoundError("project", PROJECT_A);
    repository.createProject = vi.fn(async () => {
      removeProjectAlias(entered, { hash: local.id });
      throw remoteFailure;
    });

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBe(remoteFailure);
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [],
    });
  });

  it("retains the lexical alias and published project after symlink binding failure", async () => {
    await register();
    const canonical = makeProject("create-symlink-bind-failure-target");
    const entered = join(home, "create-symlink-bind-failure-entered");
    symlinkSync(canonical, entered);
    repository.createProject = vi.fn(async (input) => ({
      ...remoteProject("invalid-project-id", input.displayName),
      aliases: [alias("invalid-project-id", canonical, entered)],
    }));
    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(quoteShellArgument(entered)),
      });

    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
    expect(showProjectMapEntry(canonical).entry).toEqual({
      canonical,
      aliases: [entered],
    });
  });

  it("does not run destructive cleanup after a published symlink project", async () => {
    await register();
    const canonical = makeProject("create-symlink-concurrent-restore-target");
    const entered = join(home, "create-symlink-concurrent-restore-entered");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    repository.createProject = vi.fn(async (input) => ({
      ...remoteProject("invalid-project-id", input.displayName),
      aliases: [alias("invalid-project-id", canonical, entered)],
    }));
    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
    expect(showProjectMapEntry(local.id).entry).toEqual({
      canonical,
      aliases: [entered],
    });
  });

  it("reconciles only genuinely ambiguous project-create commits", async () => {
    await register();
    const committed = makeProject("create-uncertain-committed");
    const originalCreate = repository.createProject.getMockImplementation()!;
    repository.createProject = vi.fn(async (input) => {
      const candidate = await originalCreate(input);
      throw new PostgreSqlIdentityCreateOutcomeUnknownError(candidate);
    });

    await expect(createProject(POSTGRESQL_CONFIG, committed, {}, deps))
      .resolves.toMatchObject({
        local: { remoteProjectId: PROJECT_A },
        remote: { projectId: PROJECT_A },
      });

    const deterministic = makeProject("create-deterministic-error");
    const notFound = new PostgreSqlIdentityNotFoundError("project", PROJECT_B);
    repository.createProject = vi.fn(async () => {
      throw notFound;
    });
    await expect(createProject(POSTGRESQL_CONFIG, deterministic, {}, deps))
      .rejects.toBe(notFound);
    expect(repository.resolveProject).not.toHaveBeenCalledWith(
      MACHINE_ID,
      deterministic,
    );
  });

  it("fails closed for absent, mismatched, or unavailable ambiguous-create readback", async () => {
    await register();
    const absent = makeProject("create-uncertain-absent");
    repository.createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityCreateOutcomeUnknownError(
        remoteProject(PROJECT_A, "A Name"),
      );
    });
    repository.resolveProject = vi.fn(async () => null);
    await expect(createProject(POSTGRESQL_CONFIG, absent, { displayName: "A Name" }, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project create --name ${quoteShellArgument("A Name")} -- ${quoteShellArgument(absent)}`,
        ),
      });

    const mismatched = makeProject("create-uncertain-mismatched");
    repository.resolveProject = vi.fn(async () => ({
      projectId: PROJECT_B,
      alias: alias(PROJECT_B, mismatched),
    }));
    await expect(createProject(POSTGRESQL_CONFIG, mismatched, {}, deps))
      .rejects.toMatchObject({
        message: expect.stringContaining(`candidate ${PROJECT_A}`),
        remediation: expect.stringContaining(
          `lcm project show --json -- ${quoteShellArgument(mismatched)}`,
        ),
      });

    const lexicalMismatch = makeProject("create-uncertain-lexical-mismatch");
    const lexicalMismatchAlias = makeProject("create-uncertain-lexical-mismatch-alias");
    addProjectAlias(lexicalMismatchAlias, {
      hash: resolveProjectIdentity(lexicalMismatch).id,
    });
    repository.resolveProject = vi.fn(async (_machineId, normalizedPath) => ({
      projectId: PROJECT_A,
      alias: alias(
        PROJECT_A,
        normalizedPath,
        normalizedPath === lexicalMismatch
          ? lexicalMismatch
          : `${lexicalMismatchAlias}-concurrent-winner`,
      ),
    }));
    await expect(createProject(POSTGRESQL_CONFIG, lexicalMismatch, {}, deps))
      .rejects.toMatchObject({
        message: expect.stringContaining(
          `candidate ${PROJECT_A} does not own every requested local alias exactly`,
        ),
      });
    expect(showProjectMapEntry(lexicalMismatch).entry.remoteProjectId).toBeUndefined();

    const mixed = makeProject("create-uncertain-mixed");
    const mixedAlias = makeProject("create-uncertain-mixed-alias");
    addProjectAlias(mixedAlias, { hash: resolveProjectIdentity(mixed).id });
    repository.resolveProject = vi.fn(async (_machineId, normalizedPath) => (
      normalizedPath === mixed
        ? { projectId: PROJECT_B, alias: alias(PROJECT_B, mixed) }
        : null
    ));
    await expect(createProject(POSTGRESQL_CONFIG, mixed, {}, deps))
      .rejects.toMatchObject({
        message: expect.stringContaining(`observed owners: ${PROJECT_B}`),
      });

    const unreadable = makeProject("create-uncertain-unreadable");
    repository.resolveProject = vi.fn(async () => {
      throw new Error("readback unavailable");
    });
    await expect(createProject(POSTGRESQL_CONFIG, unreadable, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(unreadable)}`,
        ),
      });
  });

  it("shell-quotes every dynamic create retry argument without interpolation", async () => {
    await register();
    const projectPath = makeProject("-- spaced ' ` $(not-executed)");
    const displayName = "-- Name ' ` $(not-executed)";
    repository.createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityCreateOutcomeUnknownError(
        remoteProject(PROJECT_A, displayName),
      );
    });
    repository.resolveProject = vi.fn(async () => null);

    await expect(createProject(
      POSTGRESQL_CONFIG,
      projectPath,
      { displayName },
      deps,
    )).rejects.toMatchObject({
      remediation: `Rerun \`lcm project create --name ${quoteShellArgument(displayName)} -- ${quoteShellArgument(projectPath)}\`.`,
    });
  });

  it("validates project paths and defaults the display name", async () => {
    await register();
    await expect(createProject(POSTGRESQL_CONFIG, join(home, "missing"), {}, deps))
      .rejects.toThrow("does not exist");
    const file = join(home, "file");
    writeFileSync(file, "");
    await expect(createProject(POSTGRESQL_CONFIG, file, {}, deps))
      .rejects.toThrow("must be an existing directory");
    await expect(createProject(POSTGRESQL_CONFIG, "/", {}, deps))
      .resolves.toMatchObject({ remote: { displayName: "Filesystem root" } });
    expect(repository.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayName: "Filesystem root",
        path: "/",
        normalizedPath: "/",
      }),
    );
    const named = makeProject("validated-name");
    await expect(createProject(POSTGRESQL_CONFIG, named, { displayName: "   " }, deps))
      .rejects.toThrow("display name must not be blank");
    await expect(createProject(POSTGRESQL_CONFIG, named, { displayName: "bad\nname" }, deps))
      .rejects.toThrow("control characters");
    await expect(createProject(POSTGRESQL_CONFIG, named, { displayName: "x".repeat(257) }, deps))
      .rejects.toThrow("at most 256");
    await expect(createProject(POSTGRESQL_CONFIG, named, { displayName: "  Projeto café  " }, deps))
      .resolves.toMatchObject({ remote: { displayName: "Projeto café" } });

    const path = makeProject("default-name");
    await createProject(POSTGRESQL_CONFIG, path, {}, deps);
    expect(repository.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "default-name" }),
    );
    expect(repository.createProject.mock.calls.at(-1)?.[0]).not.toHaveProperty("identityKey");
  });

  it("defaults the project name from the selected symlink's lexical basename", async () => {
    await register();
    const canonical = makeProject("default-name-canonical-target");
    const entered = join(home, "default-name-selected-symlink");
    symlinkSync(canonical, entered);

    await expect(createProject(POSTGRESQL_CONFIG, entered, {}, deps))
      .resolves.toMatchObject({
        local: { canonical },
        remote: { displayName: "default-name-selected-symlink" },
      });
    expect(repository.createProject).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "default-name-selected-symlink",
      path: entered,
      normalizedPath: canonical,
    }));
  });

  it("preserves a created remote project when its local binding cannot be written", async () => {
    await register();
    const path = makeProject("create-compensate");
    repository.createProject = vi.fn(async (input) => {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(projectMapPath(), "{broken");
      return {
        ...remoteProject(PROJECT_A, input.displayName),
        aliases: [alias(PROJECT_A, path)],
      };
    });
    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(path)}`,
        ),
      });
    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
  });

  it("preserves a project adopted by another LCM home before the creator map fails", async () => {
    await register();
    const path = makeProject("create-cross-home-adoption");
    const otherHome = join(home, "other-home");
    mkdirSync(join(otherHome, ".lcm"), { recursive: true });
    copyFileSync(machineIdentityPath(home), machineIdentityPath(otherHome));
    const otherDeps: Partial<IdentityServiceDependencies> = {
      homeDir: otherHome,
      openSession: deps.openSession,
    };
    const originalCreate = repository.createProject.getMockImplementation()!;
    repository.createProject = vi.fn(async (input) => {
      const remote = await originalCreate(input);
      process.env.HOME = otherHome;
      process.env.USERPROFILE = otherHome;
      clearProjectMapCache();
      try {
        await linkProject(POSTGRESQL_CONFIG, remote.projectId, path, {}, otherDeps);
      } finally {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        clearProjectMapCache();
      }
      writeFileSync(projectMapPath(), "{broken");
      return remote;
    });

    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(path)}`,
        ),
      });
    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
    await expect(repository.getProject(PROJECT_A)).resolves.toMatchObject({
      projectId: PROJECT_A,
    });

    process.env.HOME = otherHome;
    process.env.USERPROFILE = otherHome;
    clearProjectMapCache();
    try {
      expect(showProjectMapEntry(path).entry.remoteProjectId).toBe(PROJECT_A);
    } finally {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      clearProjectMapCache();
    }
  });

  it("preserves a created project adopted by an identical concurrent local binding", async () => {
    await register();
    const path = makeProject("create-concurrent-adoption");
    const local = resolveProjectIdentity(path);
    const originalCreate = repository.createProject.getMockImplementation()!;
    repository.createProject = vi.fn(async (input) => {
      const remote = await originalCreate(input);
      setRemoteProjectBinding(remote.projectId, { hash: local.id });
      return remote;
    });

    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .resolves.toMatchObject({
        local: { id: local.id, remoteProjectId: PROJECT_A },
        remote: { projectId: PROJECT_A },
      });
    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
    await expect(repository.getProject(PROJECT_A)).resolves.toMatchObject({
      projectId: PROJECT_A,
    });
  });

  it("ignores destructive cleanup availability after project publication", async () => {
    await register();
    const path = makeProject("create-cleanup-fails");
    repository.createProject = vi.fn(async (input) => {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(projectMapPath(), "{broken");
      return {
        ...remoteProject(PROJECT_A, input.displayName),
        aliases: [alias(PROJECT_A, path)],
      };
    });
    repository.cleanupCreatedProject = vi.fn(async () => true);

    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(path)}`,
        ),
      });
    expect(repository.cleanupCreatedProject).not.toHaveBeenCalled();
  });

  it("links and unlinks a local-only alias under SQLite", async () => {
    const canonical = makeProject("local-canonical");
    const linked = makeProject("local-alias");
    const local = resolveProjectIdentity(canonical);

    await expect(linkProject(SQLITE_CONFIG, local.id, linked, {}, deps))
      .resolves.toMatchObject({ local: { id: local.id } });
    expect(resolveProjectIdentity(linked).id).toBe(local.id);
    await expect(unlinkProject(SQLITE_CONFIG, linked, deps))
      .resolves.toMatchObject({ hash: local.id, aliasRemoved: true });
    await expect(unlinkProject(SQLITE_CONFIG, canonical, deps))
      .rejects.toThrow("no remote binding");
    await expect(linkProject(SQLITE_CONFIG, "unknown-local-target", linked, {}, deps))
      .rejects.toThrow("unknown local project target");
    await expect(unlinkProject(SQLITE_CONFIG, makeProject("unmapped-unlink"), deps))
      .rejects.toThrow("project is not mapped");
  });

  it("validates PostgreSQL configuration before machine registration for remote mutations", async () => {
    const path = makeProject("config-before-machine");
    await expect(createProject(SQLITE_CONFIG, path, {}, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    await expect(linkProject(SQLITE_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);

    const local = resolveProjectIdentity(path);
    setRemoteProjectBinding(PROJECT_A, { hash: local.id });
    await expect(unlinkProject(SQLITE_CONFIG, path, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("requires PostgreSQL configuration for alias operations on a remote-bound entry", async () => {
    const canonical = makeProject("sqlite-bound-canonical");
    const linked = makeProject("sqlite-bound-alias");
    const local = resolveProjectIdentity(canonical);
    setRemoteProjectBinding(PROJECT_A, { hash: local.id });

    await expect(linkProject(SQLITE_CONFIG, local.id, linked, {}, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    addProjectAlias(linked, { hash: local.id });
    await expect(unlinkProject(SQLITE_CONFIG, linked, deps))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("preserves callback results and failures when identity session close fails", async () => {
    close.mockRejectedValue(new Error("close failed"));
    repository.listProjects.mockResolvedValue([remoteProject(PROJECT_A)]);
    await expect(listProjects(POSTGRESQL_CONFIG, deps))
      .resolves.toMatchObject({ remote: [expect.objectContaining({ projectId: PROJECT_A })] });

    const primary = new Error("primary operation failed");
    repository.listProjects.mockRejectedValue(primary);
    await expect(listProjects(POSTGRESQL_CONFIG, deps)).rejects.toBe(primary);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("links a remote UUID and requires acknowledgement only for data-bearing rebinds", async () => {
    await register();
    const path = makeProject("remote-link");
    const first = await linkProject(POSTGRESQL_CONFIG, PROJECT_A.toUpperCase(), path, {}, deps);
    expect(first.local.remoteProjectId).toBe(PROJECT_A);

    mkdirSync(join(home, ".lcm", "projects", first.local.id), { recursive: true });
    writeFileSync(join(home, ".lcm", "projects", first.local.id, "db.sqlite"), "");
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toThrow("--allow-existing-data");
    await expect(linkProject(
      POSTGRESQL_CONFIG,
      PROJECT_B,
      path,
      { allowExistingData: true },
      deps,
    )).resolves.toMatchObject({ local: { remoteProjectId: PROJECT_B } });
  });

  it("links a remote UUID when the selected CLI path is a symlink to the canonical entry", async () => {
    await register();
    const canonical = makeProject("remote-link-symlink-target");
    const entered = join(home, "remote-link-symlink-entered");
    symlinkSync(canonical, entered);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, entered, {}, deps))
      .resolves.toMatchObject({
        local: { canonical, remoteProjectId: PROJECT_A },
        remoteAlias: { path: entered, normalizedPath: canonical },
      });
    expect(repository.replaceProjectAliases).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: [{ path: entered, normalizedPath: canonical }],
        recoveryPath: entered,
      }),
    );
    expect(showProjectMapEntry(canonical).entry.aliases).toContain(entered);
  });

  it("idempotently relinks a symlink-created project using PostgreSQL lexical spelling", async () => {
    await register();
    const canonical = makeProject("remote-relink-created-symlink-target");
    const entered = join(home, "remote-relink-created-symlink-entered");
    symlinkSync(canonical, entered);
    const created = await createProject(POSTGRESQL_CONFIG, entered, {}, deps);
    repository.replaceProjectAliases.mockClear();

    await expect(linkProject(
      POSTGRESQL_CONFIG,
      created.remote.projectId,
      entered,
      {},
      deps,
    )).resolves.toMatchObject({
      local: { canonical, remoteProjectId: created.remote.projectId },
      remoteAlias: { path: entered, normalizedPath: canonical },
    });
    expect(repository.replaceProjectAliases).toHaveBeenCalledWith({
      machineId: MACHINE_ID,
      projectId: created.remote.projectId,
      aliases: [{ path: entered, normalizedPath: canonical }],
      recoveryPath: entered,
    });
  });

  it("compensates when a committed batch omits the selected symlink identity", async () => {
    await register();
    const canonical = makeProject("remote-link-missing-selected-target");
    const entered = join(home, "remote-link-missing-selected-entered");
    symlinkSync(canonical, entered);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const mutation = await originalReplace(input);
      return mutation ? { ...mutation, aliases: [] } : null;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, entered, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalled();
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("atomically rebinds every remote alias represented by one local map entry", async () => {
    await register();
    const canonical = makeProject("batch-rebind-canonical");
    const aliasA = makeProject("batch-rebind-alias-a");
    const aliasB = makeProject("batch-rebind-alias-b");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, aliasA, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, aliasB, {}, deps);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, aliasA, {}, deps))
      .resolves.toMatchObject({
        local: { id: bound.local.id, remoteProjectId: PROJECT_B },
        remoteAlias: { normalizedPath: aliasA },
      });
    expect(repository.replaceProjectAliases).toHaveBeenLastCalledWith({
      machineId: MACHINE_ID,
      expectedPriorProjectId: PROJECT_A,
      projectId: PROJECT_B,
      aliases: expect.arrayContaining([
        { path: canonical, normalizedPath: canonical },
        { path: aliasA, normalizedPath: aliasA },
        { path: aliasB, normalizedPath: aliasB },
      ]),
      recoveryPath: aliasA,
    });
    for (const path of [canonical, aliasA, aliasB]) {
      await expect(repository.resolveProject(MACHINE_ID, path))
        .resolves.toMatchObject({ projectId: PROJECT_B });
    }
  });

  it("initial UUID binding atomically inserts every pre-existing local alias", async () => {
    await register();
    const canonical = makeProject("initial-batch-canonical");
    const aliasA = makeProject("initial-batch-alias-a");
    const aliasB = makeProject("initial-batch-alias-b");
    const local = resolveProjectIdentity(canonical);
    await linkProject(SQLITE_CONFIG, local.id, aliasA, {}, deps);
    await linkProject(SQLITE_CONFIG, local.id, aliasB, {}, deps);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, aliasA, {}, deps))
      .resolves.toMatchObject({ local: { remoteProjectId: PROJECT_A } });
    for (const path of [canonical, aliasA, aliasB]) {
      await expect(repository.resolveProject(MACHINE_ID, path))
        .resolves.toMatchObject({ projectId: PROJECT_A });
    }
  });

  it("rejects duplicate normalized identities on create but preserves the selected link spelling", async () => {
    await register();
    const canonical = makeProject("duplicate-normalized-canonical");
    const entered = join(home, "duplicate-normalized-symlink");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);
    writeFileSync(projectMapPath(), JSON.stringify({
      [local.id]: { canonical, aliases: [entered] },
    }));
    clearProjectMapCache();

    await expect(createProject(POSTGRESQL_CONFIG, canonical, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, entered, {}, deps))
      .resolves.toMatchObject({
        local: { remoteProjectId: PROJECT_A },
        remoteAlias: { path: entered, normalizedPath: canonical },
      });
    expect(repository.createProject).not.toHaveBeenCalled();
    expect(repository.replaceProjectAliases).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: [{ path: entered, normalizedPath: canonical }],
      }),
    );
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
  });

  it("rejects a duplicate normalized pair that does not contain the selected spelling", async () => {
    await register();
    const canonical = makeProject("duplicate-normalized-three-way-canonical");
    const first = join(home, "duplicate-normalized-three-way-first");
    const selected = join(home, "duplicate-normalized-three-way-selected");
    symlinkSync(canonical, first);
    symlinkSync(canonical, selected);
    const local = resolveProjectIdentity(canonical);
    writeFileSync(projectMapPath(), JSON.stringify({
      [local.id]: { canonical, aliases: [first, selected] },
    }));
    clearProjectMapCache();

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, selected, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.replaceProjectAliases).not.toHaveBeenCalled();
  });

  it("rejects adding a symlink alias that duplicates an existing normalized identity", async () => {
    const canonical = makeProject("duplicate-local-link-canonical");
    const entered = join(home, "duplicate-local-link-symlink");
    symlinkSync(canonical, entered);
    const local = resolveProjectIdentity(canonical);

    await expect(linkProject(SQLITE_CONFIG, local.id, entered, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(showProjectMapEntry(local.id).entry.aliases).toEqual([]);
  });

  it("removes a legacy duplicate-normalized alias without deleting the canonical remote row", async () => {
    await register();
    const canonical = makeProject("duplicate-unlink-canonical");
    const entered = join(home, "duplicate-unlink-symlink");
    symlinkSync(canonical, entered);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    writeFileSync(projectMapPath(), JSON.stringify({
      [bound.local.id]: {
        canonical,
        aliases: [entered],
        remoteProjectId: PROJECT_A,
      },
    }));
    clearProjectMapCache();

    await expect(unlinkProject(POSTGRESQL_CONFIG, entered, deps))
      .resolves.toMatchObject({ aliasRemoved: true, remoteProjectId: PROJECT_A });
    await expect(repository.resolveProject(MACHINE_ID, canonical))
      .resolves.toMatchObject({ projectId: PROJECT_A });
    expect(showProjectMapEntry(bound.local.id).entry.aliases).toEqual([]);
  });

  it("project creation includes every pre-existing local alias", async () => {
    await register();
    const canonical = makeProject("create-batch-canonical");
    const linked = makeProject("create-batch-alias");
    const local = resolveProjectIdentity(canonical);
    await linkProject(SQLITE_CONFIG, local.id, linked, {}, deps);

    await expect(createProject(POSTGRESQL_CONFIG, canonical, {}, deps))
      .resolves.toMatchObject({
        remote: {
          aliases: expect.arrayContaining([
            expect.objectContaining({ normalizedPath: canonical }),
            expect.objectContaining({ normalizedPath: linked }),
          ]),
        },
      });
    await expect(repository.resolveProject(MACHINE_ID, linked))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("initial batch binding rolls back every path when one local alias has a foreign owner", async () => {
    await register();
    const canonical = makeProject("initial-collision-canonical");
    const linked = makeProject("initial-collision-alias");
    const local = resolveProjectIdentity(canonical);
    await linkProject(SQLITE_CONFIG, local.id, linked, {}, deps);
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_B,
      path: linked,
      normalizedPath: linked,
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, linked))
      .resolves.toMatchObject({ projectId: PROJECT_B });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("rebind inserts a missing remote row for a legacy local-only alias", async () => {
    await register();
    const canonical = makeProject("rebind-missing-canonical");
    const linked = makeProject("rebind-missing-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    await repository.unlinkProjectAliasIfOwned(MACHINE_ID, linked, PROJECT_A, linked);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, canonical, {}, deps))
      .resolves.toMatchObject({ local: { remoteProjectId: PROJECT_B } });
    for (const path of [canonical, linked]) {
      await expect(repository.resolveProject(MACHINE_ID, path))
        .resolves.toMatchObject({ projectId: PROJECT_B });
    }
  });

  it("rebinds a stale symlink alias using its immutable PostgreSQL path identity", async () => {
    await register();
    const canonical = makeProject("rebind-stale-canonical");
    const originalTarget = makeProject("rebind-stale-original");
    const replacementTarget = makeProject("rebind-stale-replacement");
    const entered = join(home, "rebind-stale-entered");
    symlinkSync(originalTarget, entered);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, entered, {}, deps);
    rmSync(entered);
    symlinkSync(replacementTarget, entered);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, canonical, {}, deps))
      .resolves.toMatchObject({ local: { remoteProjectId: PROJECT_B } });
    expect(repository.replaceProjectAliases).toHaveBeenLastCalledWith(
      expect.objectContaining({
        aliases: expect.arrayContaining([
          { path: entered, normalizedPath: originalTarget },
        ]),
      }),
    );
    await expect(repository.resolveProject(MACHINE_ID, originalTarget))
      .resolves.toMatchObject({ projectId: PROJECT_B });
    await expect(repository.resolveProject(MACHINE_ID, replacementTarget)).resolves.toBeNull();
  });

  it("restores every prior alias when a multi-alias rebind cannot update the local map", async () => {
    await register();
    const canonical = makeProject("batch-rebind-restore-canonical");
    const linked = makeProject("batch-rebind-restore-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const replaced = await originalReplace(input);
      if (input.projectId === PROJECT_B) writeFileSync(projectMapPath(), "{broken");
      return replaced;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, linked, {}, deps))
      .rejects.toThrow();
    for (const path of [canonical, linked]) {
      await expect(repository.resolveProject(MACHINE_ID, path))
        .resolves.toMatchObject({ projectId: PROJECT_A });
    }
  });

  it("authoritatively readbacks ambiguous multi-alias rebind restoration", async () => {
    await register();
    const canonical = makeProject("batch-restore-ambiguous-canonical");
    const linked = makeProject("batch-restore-ambiguous-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    const originalRestore = repository.restoreProjectAliasBatch.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const replaced = await originalReplace(input);
      if (input.projectId === PROJECT_B) {
        writeFileSync(projectMapPath(), "{broken");
      }
      return replaced;
    });
    repository.restoreProjectAliasBatch = vi.fn(async (...input) => {
      await originalRestore(...input);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "restoreProjectAliasBatch",
        projectId: PROJECT_B,
      });
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, linked, {}, deps))
      .rejects.toThrow("Expected property name");
    for (const path of [canonical, linked]) {
      await expect(repository.resolveProject(MACHINE_ID, path))
        .resolves.toMatchObject({ projectId: PROJECT_A });
    }
  });

  it("authoritatively readbacks an ambiguous restoration to an absent alias", async () => {
    await register();
    const path = makeProject("batch-restore-ambiguous-absent");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    const originalRestore = repository.restoreProjectAliasBatch.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const replaced = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      return replaced;
    });
    repository.restoreProjectAliasBatch = vi.fn(async (...input) => {
      await originalRestore(...input);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "restoreProjectAliasBatch",
        projectId: PROJECT_A,
      });
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow("Expected property name");
    await expect(repository.resolveProject(MACHINE_ID, path)).resolves.toBeNull();
  });

  it("preserves an unowned same-project alias during ambiguous batch restoration", async () => {
    await register();
    const path = makeProject("batch-restore-concurrent-winner");
    repository.replaceProjectAliases = vi.fn(async (input) => {
      await repository.linkProject({
        machineId: input.machineId,
        projectId: input.projectId,
        path,
        normalizedPath: path,
      });
      writeFileSync(projectMapPath(), "{broken");
      return batchMutation(input.projectId, [path], [null], [false]);
    });
    repository.restoreProjectAliasBatch = vi.fn(async () => {
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "restoreProjectAliasBatch",
        projectId: PROJECT_A,
      });
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow("Expected property name");
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("fails closed when multi-alias rebind restoration is absent, deterministic, or unreadable", async () => {
    for (const outcome of ["absent", "deterministic", "unreadable"] as const) {
      clearProjectMapCache();
      rmSync(join(home, ".lcm"), { recursive: true, force: true });
      const canonical = makeProject(`batch-restore-${outcome}`);
      await register();
      await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
      const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
      repository.replaceProjectAliases = vi.fn(async (input) => {
        if (input.projectId === PROJECT_B) {
          const replaced = await originalReplace(input);
          writeFileSync(projectMapPath(), "{broken");
          return replaced;
        }
        return originalReplace(input);
      });
      repository.restoreProjectAliasBatch = vi.fn(async () => {
        if (outcome === "absent") return false;
        if (outcome === "deterministic") throw new Error("restore failed");
        throw new PostgreSqlCommitOutcomeUnknownError({
          domain: "identity",
          operation: "restoreProjectAliasBatch",
          projectId: PROJECT_B,
        });
      });
      if (outcome === "unreadable") {
        repository.resolveProject = vi.fn(async () => {
          throw new Error("readback failed");
        });
      }

      await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, canonical, {}, deps))
        .rejects.toMatchObject({
          remediation: expect.stringContaining(
            `lcm project link -- ${quoteShellArgument(PROJECT_B)}`,
          ),
        });
      repository = fakeRepository();
      deps = {
        homeDir: home,
        openSession: vi.fn(async () => ({ repository, close })),
      };
    }
  });

  it("fails closed if a batch rebind omits the selected path", async () => {
    await register();
    const path = makeProject("batch-rebind-missing-selected");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.replaceProjectAliases = vi.fn(async () => batchMutation(
      PROJECT_B,
      ["/different-path"],
    ));

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
  });

  it("reports reconciliation when batch rebind compensation returns no aliases", async () => {
    await register();
    const path = makeProject("batch-rebind-empty-compensation");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.replaceProjectAliases = vi.fn(async (input) => {
      writeFileSync(projectMapPath(), "{broken");
      return batchMutation(input.projectId, [path]);
    });
    repository.restoreProjectAliasBatch = vi.fn(async () => false);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_B)}`,
        ),
      });
  });

  it("accepts an uncertain link only after authoritative matching readback", async () => {
    await register();
    const path = makeProject("uncertain-confirmed");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const candidate = await originalReplace(input);
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        candidate!,
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .resolves.toMatchObject({
        local: { remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: path },
      });
  });

  it("rejects ambiguous same-project rebind readback with a stale lexical path", async () => {
    await register();
    const path = makeProject("uncertain-same-project-lexical-rollback");
    const priorPath = `${path}/.`;
    const priorAlias = alias(PROJECT_A, path, priorPath);
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_A,
      path: priorPath,
      normalizedPath: path,
    });
    repository.replaceProjectAliases = vi.fn(async (input) => {
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        batchMutation(
          input.projectId,
          [path],
          [{ projectId: PROJECT_A, alias: priorAlias }],
          [false],
        ),
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining("safe to retry"),
      });
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: priorPath, normalizedPath: path },
      });
    expect(resolveProjectIdentity(path).remoteProjectId).toBeUndefined();
  });

  it("clears insertion ownership after uncertain batch readback before compensation", async () => {
    await register();
    const path = makeProject("uncertain-confirmed-compensation");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const candidate = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        candidate!,
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow("Expected property name");
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      [expect.objectContaining({
        projectId: PROJECT_A,
        alias: expect.objectContaining({ path }),
      })],
      [false],
      [{ path, normalizedPath: path }],
    );
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("rejects a same-owner lexical path collision without changing either home", async () => {
    await register();
    const path = makeProject("lexical-refresh-compensation");
    const priorPath = `${path}/.`;
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_A,
      path: priorPath,
      normalizedPath: path,
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toBeInstanceOf(PostgreSqlIdentityAliasPathConflictError);
    expect(repository.restoreProjectAliasBatch).not.toHaveBeenCalled();
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: priorPath },
      });
  });

  it("does not restore an exact alias after uncertain idempotent readback", async () => {
    await register();
    const path = makeProject("lexical-refresh-uncertain");
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_A,
      path,
      normalizedPath: path,
    });
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const candidate = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        candidate!,
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow("Expected property name");
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      [expect.objectContaining({
        projectId: PROJECT_A,
        alias: expect.objectContaining({ path }),
      })],
      [false],
      [{ path, normalizedPath: path }],
    );
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path },
      });
  });

  it("rejects a lexical collision before entering local-map reconciliation", async () => {
    await register();
    const path = makeProject("lexical-restore-readback");
    const priorPath = `${path}/.`;
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_A,
      path: priorPath,
      normalizedPath: path,
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toBeInstanceOf(PostgreSqlIdentityAliasPathConflictError);
    expect(repository.restoreProjectAliasBatch).not.toHaveBeenCalled();
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: priorPath, normalizedPath: path },
      });
  });

  it("does not restore a stale foreign owner after uncertain rebind readback", async () => {
    await register();
    const path = makeProject("foreign-rebind-uncertain");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const candidate = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        candidate!,
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toThrow("Expected property name");
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_B,
      [expect.objectContaining({
        projectId: PROJECT_B,
        alias: expect.objectContaining({ path }),
      })],
      [false],
      [{ path, normalizedPath: path }],
    );
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({
        projectId: PROJECT_B,
        alias: { path },
      });
  });

  it("reports uncertain links when readback is absent or unavailable", async () => {
    await register();
    const absent = makeProject("uncertain-absent");
    repository.replaceProjectAliases = vi.fn(async (input) => {
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        batchMutation(input.projectId, input.aliases.map(({ normalizedPath }) => normalizedPath)),
      );
    });
    repository.resolveProject = vi.fn(async () => null);
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, absent, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
        ),
      });

    const unavailable = makeProject("uncertain-readback-fails");
    repository.resolveProject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("readback unavailable"));
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, unavailable, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
  });

  it("preserves deterministic project-link conflicts and not-found errors", async () => {
    await register();
    const path = makeProject("deterministic-link-errors");
    const conflict = new PostgreSqlIdentityConflictError(
      MACHINE_ID,
      path,
      PROJECT_B,
      PROJECT_A,
    );
    repository.replaceProjectAliases = vi.fn(async () => {
      throw conflict;
    });
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toBe(conflict);

    const missing = new PostgreSqlIdentityNotFoundError("project", PROJECT_A);
    repository.replaceProjectAliases = vi.fn(async () => {
      throw missing;
    });
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toBe(missing);
  });

  it("never replaces a remotely owned alias without a matching local binding", async () => {
    await register();
    const path = makeProject("remote-owner-mismatch");
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_B,
      path,
      normalizedPath: path,
    });
    repository.unlinkPath.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
    expect(repository.unlinkPath).not.toHaveBeenCalled();
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({ projectId: PROJECT_B });
  });

  it("stops when ownership changes during an otherwise authorized rebind", async () => {
    await register();
    const path = makeProject("remote-owner-race");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.replaceProjectAliases = vi.fn(async () => null);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining("project list --json"),
      });
    expect(repository.linkProject).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_B }),
    );
  });

  it("leaves the prior remote alias intact when an atomic rebind fails", async () => {
    await register();
    const path = makeProject("restore-prior");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.replaceProjectAliases = vi.fn(async () => {
      throw new Error("rebind failed");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toThrow("rebind failed");
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("readbacks ambiguous atomic rebinds without redirecting another owner", async () => {
    await register();
    const path = makeProject("ambiguous-rebind");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const candidate = await originalReplace(input);
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        input.projectId,
        candidate!,
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .resolves.toMatchObject({ local: { remoteProjectId: PROJECT_B } });

    setRemoteProjectBinding(PROJECT_A, { canonical: path, allowExistingData: true });
    await originalReplace({
      machineId: MACHINE_ID,
      expectedPriorProjectId: PROJECT_B,
      projectId: PROJECT_A,
      aliases: [{ path, normalizedPath: path }],
    });
    repository.replaceProjectAliases = vi.fn(async () => {
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        PROJECT_B,
        batchMutation(PROJECT_B, [path], [{
          projectId: PROJECT_A,
          alias: alias(PROJECT_A, path),
        }]),
      );
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("safe to retry"),
      });
  });

  it("fails closed when ambiguous rebind readback is missing, changed, or unavailable", async () => {
    await register();
    const path = makeProject("ambiguous-rebind-failures");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.replaceProjectAliases = vi.fn(async () => {
      throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(
        PROJECT_B,
        batchMutation(PROJECT_B, [path], [{
          projectId: PROJECT_A,
          alias: alias(PROJECT_A, path),
        }]),
      );
    });

    repository.resolveProject = vi.fn().mockResolvedValue(null);
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });

    repository.resolveProject = vi.fn().mockResolvedValue({
      projectId: PROJECT_B + "-other",
      alias: alias(PROJECT_B, path),
    });
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });

    repository.resolveProject = vi.fn().mockRejectedValue(new Error("readback failed"));
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_B)}`,
        ),
      });
  });

  it("restores a newly linked remote alias after a local binding write failure", async () => {
    await register();
    const path = makeProject("restore-new-link");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const mutation = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      return mutation;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow();
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalled();
  });

  it("observes an absent remote alias after rolling back a local binding failure", async () => {
    await register();
    const path = makeProject("restore-new-link-absent");
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const mutation = await originalReplace(input);
      writeFileSync(projectMapPath(), "{broken");
      return mutation;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow();
    await expect(repository.resolveProject(MACHINE_ID, path)).resolves.toBeNull();
  });

  it("reports when local binding failure cannot restore PostgreSQL", async () => {
    await register();
    const path = makeProject("restore-new-link-fails");
    repository.replaceProjectAliases = vi.fn(async (input) => {
      writeFileSync(projectMapPath(), "{broken");
      return batchMutation(
        input.projectId,
        input.aliases.map(({ normalizedPath }) => normalizedPath),
      );
    });
    repository.restoreProjectAliasBatch = vi.fn(async () => {
      throw new Error("restore failed");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
        ),
      });
  });

  it("reports reconciliation instead of clobbering changed alias ownership", async () => {
    await register();
    const path = makeProject("restore-owner-changed");
    repository.replaceProjectAliases = vi.fn(async (input) => {
      writeFileSync(projectMapPath(), "{broken");
      return batchMutation(
        input.projectId,
        input.aliases.map(({ normalizedPath }) => normalizedPath),
      );
    });
    repository.restoreProjectAliasBatch = vi.fn(async () => false);

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
        ),
      });
    expect(repository.restoreProjectAliasBatch).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      [null],
      [true],
      [{ path, normalizedPath: path }],
    );
  });

  it("syncs local aliases for remotely bound projects", async () => {
    await register();
    const canonical = makeProject("remote-alias-canonical");
    const linked = makeProject("remote-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps))
      .resolves.toMatchObject({
        local: { id: bound.local.id, remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: linked },
      });
    expect(repository.linkProjectWithOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, normalizedPath: linked }),
    );
  });

  it("authoritatively confirms ambiguous bound-entry alias links", async () => {
    await register();
    const canonical = makeProject("remote-alias-uncertain-canonical");
    const linked = makeProject("remote-alias-uncertain");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalLink = repository.linkProjectWithOwnership.getMockImplementation()!;
    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      await originalLink(input);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "linkProject",
        projectId: input.projectId,
      });
    });

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps))
      .resolves.toMatchObject({
        local: { id: bound.local.id, remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: linked },
      });
  });

  it("rejects ambiguous bound-entry alias links with another lexical path", async () => {
    await register();
    const canonical = makeProject("remote-alias-lexical-canonical");
    const linked = makeProject("remote-alias-lexical");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "linkProject",
        projectId: input.projectId,
      });
    });
    repository.resolveProject = vi.fn(async (_machineId, normalizedPath) => ({
      projectId: PROJECT_A,
      alias: alias(PROJECT_A, normalizedPath, `${linked}/.`),
    }));

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(linked)}`,
        ),
      });
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(linked);
  });

  it("fails closed for deterministic, absent, and unreadable bound-entry alias links", async () => {
    await register();
    const canonical = makeProject("remote-alias-fail-canonical");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const deterministic = makeProject("remote-alias-deterministic");
    const deterministicError = new Error("deterministic alias failure");
    repository.linkProjectWithOwnership = vi.fn(async () => {
      throw deterministicError;
    });
    await expect(linkProject(
      POSTGRESQL_CONFIG,
      bound.local.id,
      deterministic,
      {},
      deps,
    )).rejects.toBe(deterministicError);

    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "linkProject",
        projectId: input.projectId,
      });
    });
    const absent = makeProject("remote-alias-absent");
    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, absent, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)} ${quoteShellArgument(absent)}`,
        ),
    });

    const unreadable = makeProject("remote-alias-unreadable");
    repository.resolveProject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("readback unavailable"));
    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, unreadable, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
  });

  it("removes a remote alias when its local alias write collides", async () => {
    await register();
    const canonical = makeProject("alias-cleanup-canonical");
    const occupiedCanonical = makeProject("alias-cleanup-occupied");
    const occupied = makeProject("alias-cleanup-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const occupiedIdentity = resolveProjectIdentity(occupiedCanonical);
    await linkProject(SQLITE_CONFIG, occupiedIdentity.id, occupied, {}, deps);

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toThrow("already mapped");
    expect(repository.unlinkProjectAliasIfOwned).toHaveBeenCalledWith(
      MACHINE_ID,
      occupied,
      PROJECT_A,
      occupied,
    );
  });

  it("reports when local alias collision cleanup fails remotely", async () => {
    await register();
    const canonical = makeProject("alias-cleanup-fails-canonical");
    const occupiedCanonical = makeProject("alias-cleanup-fails-occupied");
    const occupied = makeProject("alias-cleanup-fails-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const occupiedIdentity = resolveProjectIdentity(occupiedCanonical);
    await linkProject(SQLITE_CONFIG, occupiedIdentity.id, occupied, {}, deps);
    repository.unlinkProjectAliasIfOwned = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `project unlink -- ${quoteShellArgument(occupied)}`,
        ),
      });
  });

  it("leaves an already-existing remote alias intact when the local alias write collides", async () => {
    await register();
    const canonical = makeProject("alias-prior-canonical");
    const occupiedCanonical = makeProject("alias-prior-occupied");
    const occupied = makeProject("alias-prior-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const occupiedIdentity = resolveProjectIdentity(occupiedCanonical);
    await linkProject(SQLITE_CONFIG, occupiedIdentity.id, occupied, {}, deps);
    await repository.linkProject({
      machineId: MACHINE_ID,
      projectId: PROJECT_A,
      path: occupied,
      normalizedPath: occupied,
    });
    repository.unlinkProjectAliasIfOwned.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(bound.local.id)} ${quoteShellArgument(occupied)}`,
        ),
      });
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
  });

  it("accepts an identical concurrent local alias link after losing the map CAS", async () => {
    await register();
    const canonical = makeProject("alias-idempotent-canonical");
    const linked = makeProject("alias-idempotent-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalLink = repository.linkProjectWithOwnership.getMockImplementation()!;
    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      const mutation = await originalLink(input);
      addProjectAlias(linked, { hash: bound.local.id });
      return mutation;
    });
    repository.unlinkProjectAliasIfOwned.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps))
      .resolves.toMatchObject({
        local: { id: bound.local.id, remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: linked },
      });
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
  });

  it("does not confirm a different symlink with the same normalized realpath", async () => {
    await register();
    const canonical = makeProject("alias-lexical-race-canonical");
    const aliasTarget = makeProject("alias-lexical-race-target");
    const requested = join(home, "alias-lexical-race-requested");
    const winner = join(home, "alias-lexical-race-winner");
    symlinkSync(aliasTarget, requested, "dir");
    symlinkSync(aliasTarget, winner, "dir");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalLink = repository.linkProjectWithOwnership.getMockImplementation()!;
    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      const remoteWinner = await originalLink({ ...input, path: winner });
      addProjectAlias(winner, { hash: bound.local.id });
      return { alias: remoteWinner.alias, inserted: false };
    });

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, requested, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(quoteShellArgument(requested)),
      });
    expect(showProjectMapEntry(bound.local.id).entry.aliases).toEqual([winner]);
    await expect(repository.resolveProject(MACHINE_ID, aliasTarget))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: winner, normalizedPath: aliasTarget },
      });
  });

  it("preserves a concurrent same-project alias winner when the local alias write collides", async () => {
    await register();
    const canonical = makeProject("alias-race-canonical");
    const occupiedCanonical = makeProject("alias-race-occupied");
    const occupied = makeProject("alias-race-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const occupiedIdentity = resolveProjectIdentity(occupiedCanonical);
    await linkProject(SQLITE_CONFIG, occupiedIdentity.id, occupied, {}, deps);
    const originalLink = repository.linkProjectWithOwnership.getMockImplementation()!;
    repository.linkProjectWithOwnership = vi.fn(async (input) => {
      const winner = await originalLink({
        ...input,
        path: `${input.path}-winner`,
      });
      return {
        alias: winner.alias,
        inserted: false,
      };
    });
    repository.unlinkProjectAliasIfOwned.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(bound.local.id)} ${quoteShellArgument(occupied)}`,
        ),
      });
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
    await expect(repository.resolveProject(MACHINE_ID, occupied))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: `${occupied}-winner` },
      });
  });

  it("unlinks a remote alias and a canonical binding without deleting local state", async () => {
    await register();
    const canonical = makeProject("unlink-canonical");
    const linked = makeProject("unlink-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .resolves.toMatchObject({ aliasRemoved: true, remoteProjectId: PROJECT_A });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .resolves.toMatchObject({ aliasRemoved: false, remoteProjectId: PROJECT_A });
    expect(resolveProjectIdentity(canonical)).toMatchObject({
      id: bound.local.id,
      canonical,
    });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("does not treat an unrecorded symlink to the canonical path as a canonical unlink", async () => {
    await register();
    const canonical = makeProject("unlink-unrecorded-symlink-canonical");
    const recordedAlias = makeProject("unlink-unrecorded-symlink-recorded-alias");
    const unrecorded = join(home, "unlink-unrecorded-symlink");
    symlinkSync(canonical, unrecorded);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, recordedAlias, {}, deps);
    repository.unlinkProjectAliasesIfOwned.mockClear();
    repository.unlinkProjectAliasIfOwned.mockClear();
    vi.mocked(deps.openSession!).mockClear();

    await expect(unlinkProject(POSTGRESQL_CONFIG, unrecorded, deps))
      .rejects.toThrow(`project is not mapped: ${unrecorded}`);

    expect(repository.unlinkProjectAliasesIfOwned).not.toHaveBeenCalled();
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
    expect(deps.openSession).not.toHaveBeenCalled();
    expect(showProjectMapEntry(bound.local.id).entry).toEqual({
      canonical,
      aliases: [recordedAlias],
      remoteProjectId: PROJECT_A,
    });
    await expect(repository.resolveProject(MACHINE_ID, canonical))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: canonical, normalizedPath: canonical },
      });
    await expect(repository.resolveProject(MACHINE_ID, recordedAlias))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: recordedAlias, normalizedPath: recordedAlias },
      });
  });

  it("does not restore remote aliases after a concurrent canonical unlink already won", async () => {
    await register();
    const canonical = makeProject("unlink-canonical-concurrent-winner");
    const linked = makeProject("unlink-canonical-concurrent-winner-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, inputs) => {
      const removed = await originalUnlink(machineId, projectId, inputs);
      clearRemoteProjectBinding(bound.local.id, PROJECT_A, {
        expectedEntry: showProjectMapEntry(bound.local.id).entry,
      });
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .resolves.toEqual({
        hash: bound.local.id,
        remoteProjectId: PROJECT_A,
        aliasRemoved: false,
      });
    expect(repository.restoreProjectAliases).not.toHaveBeenCalled();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, linked)).resolves.toBeNull();
  });

  it("unlinks a deleted symlink alias by its persisted PostgreSQL identity", async () => {
    await register();
    const canonical = makeProject("unlink-deleted-link-canonical");
    const target = makeProject("unlink-deleted-link-target");
    const entered = join(home, "unlink-deleted-link-entered");
    symlinkSync(target, entered);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, entered, {}, deps);
    rmSync(entered);

    await expect(unlinkProject(POSTGRESQL_CONFIG, entered, deps))
      .resolves.toMatchObject({ aliasRemoved: true, remoteProjectId: PROJECT_A });
    await expect(repository.resolveProject(MACHINE_ID, target)).resolves.toBeNull();
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(entered);
  });

  it("does not reinterpret a retargeted symlink while unlinking its stored alias", async () => {
    await register();
    const canonical = makeProject("unlink-retarget-canonical");
    const originalTarget = makeProject("unlink-retarget-original");
    const replacementTarget = makeProject("unlink-retarget-replacement");
    const entered = join(home, "unlink-retarget-entered");
    const retained = join(home, "unlink-retarget-retained");
    symlinkSync(originalTarget, entered);
    symlinkSync(replacementTarget, retained);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, entered, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, retained, {}, deps);
    rmSync(entered);
    symlinkSync(replacementTarget, entered);

    await expect(unlinkProject(POSTGRESQL_CONFIG, entered, deps))
      .resolves.toMatchObject({ aliasRemoved: true });
    await expect(repository.resolveProject(MACHINE_ID, originalTarget)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, replacementTarget))
      .resolves.toMatchObject({ projectId: PROJECT_A, alias: { path: retained } });
  });

  it("canonical unlink removes a deleted alias using the stored normalized key", async () => {
    await register();
    const canonical = makeProject("unbind-deleted-link-canonical");
    const target = makeProject("unbind-deleted-link-target");
    const entered = join(home, "unbind-deleted-link-entered");
    symlinkSync(target, entered);
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, entered, {}, deps);
    rmSync(entered);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .resolves.toMatchObject({ aliasRemoved: false });
    await expect(repository.resolveProject(MACHINE_ID, target)).resolves.toBeNull();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("fails closed when PostgreSQL returns duplicate aliases for one lexical path", async () => {
    await register();
    const canonical = makeProject("unlink-duplicate-path");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    repository.resolveProjectAliasesByPath = vi.fn(async () => [
      { projectId: PROJECT_A, alias: alias(PROJECT_A, canonical) },
      { projectId: PROJECT_A, alias: alias(PROJECT_A, `${canonical}-other`, canonical) },
    ]);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.unlinkProjectAliasesIfOwned).not.toHaveBeenCalled();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
  });

  it("rejects a stored lexical path owned by another project before unlink mutation", async () => {
    await register();
    const canonical = makeProject("unlink-foreign-owner");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    repository.resolveProjectAliasesByPath = vi.fn(async () => [{
      projectId: PROJECT_B,
      alias: alias(PROJECT_B, canonical),
    }]);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining("foreign owner"),
      });
    expect(repository.unlinkProjectAliasesIfOwned).not.toHaveBeenCalled();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
  });

  it("rejects foreign stored owners before alias unlink or project rebind mutations", async () => {
    await register();
    const canonical = makeProject("foreign-owner-rebind-canonical");
    const linked = makeProject("foreign-owner-rebind-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    repository.resolveProjectAliasesByPath = vi.fn(async (_machineId, paths) =>
      paths.map((path) => ({
        projectId: PROJECT_B,
        alias: alias(PROJECT_B, path),
      })));
    repository.unlinkProjectAliasIfOwned.mockClear();
    repository.replaceProjectAliases.mockClear();

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, canonical, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
    expect(repository.replaceProjectAliases).not.toHaveBeenCalled();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
    expect(showProjectMapEntry(bound.local.id).entry.aliases).toContain(linked);
  });

  it("canonical unlink preserves aliases owned by a distinct local entry on the same project", async () => {
    await register();
    const first = makeProject("shared-project-first");
    const firstAlias = makeProject("shared-project-first-alias");
    const sibling = makeProject("shared-project-sibling");
    const firstBound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, first, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, firstBound.local.id, firstAlias, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, sibling, {}, deps);

    await expect(unlinkProject(POSTGRESQL_CONFIG, first, deps))
      .resolves.toMatchObject({ hash: firstBound.local.id, aliasRemoved: false });
    await expect(repository.resolveProject(MACHINE_ID, first)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, firstAlias)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, sibling))
      .resolves.toMatchObject({ projectId: PROJECT_A });
    expect(resolveProjectIdentity(sibling).remoteProjectId).toBe(PROJECT_A);
  });

  it("canonical unlink tolerates a missing remote row for a retained local alias", async () => {
    await register();
    const canonical = makeProject("unlink-missing-canonical");
    const linked = makeProject("unlink-missing-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    await repository.unlinkProjectAliasIfOwned(MACHINE_ID, linked, PROJECT_A, linked);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .resolves.toMatchObject({ hash: bound.local.id, aliasRemoved: false });
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
    await expect(repository.resolveProject(MACHINE_ID, linked)).resolves.toBeNull();
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("rejects canonical unlink when an exact entry alias no longer has the expected owner", async () => {
    await register();
    const canonical = makeProject("unlink-owner-mismatch");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    repository.unlinkProjectAliasesIfOwned = vi.fn(async () => null);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
  });

  it("authoritatively confirms ambiguous alias unlinks and rejects unchanged owners", async () => {
    await register();
    const canonical = makeProject("uncertain-unlink-canonical");
    const linked = makeProject("uncertain-unlink-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      const candidate = await originalUnlink(machineId, normalizedPath, projectId, path);
      throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError(candidate);
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .resolves.toMatchObject({ aliasRemoved: true });

    const absentAtCommit = makeProject("uncertain-unlink-null-candidate");
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, absentAtCommit, {}, deps);
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      await originalUnlink(machineId, normalizedPath, projectId, path);
      throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError(
        null,
        "unlinkProjectAliasIfOwned",
      );
    });
    await expect(unlinkProject(POSTGRESQL_CONFIG, absentAtCommit, deps))
      .resolves.toMatchObject({ aliasRemoved: true });
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(absentAtCommit);

    const linkedAgain = makeProject("uncertain-unlink-alias-again");
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linkedAgain, {}, deps);
    const candidate = await repository.resolveProject(MACHINE_ID, linkedAgain);
    repository.unlinkProjectAliasIfOwned = vi.fn(async () => {
      throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError(candidate);
    });
    await expect(unlinkProject(POSTGRESQL_CONFIG, linkedAgain, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("safe to retry"),
      });
    expect(resolveProjectIdentity(linkedAgain).id).toBe(bound.local.id);
  });

  it("fails closed when ambiguous alias-unlink readback changes or fails", async () => {
    await register();
    const canonical = makeProject("uncertain-unlink-fail-canonical");
    const changed = makeProject("uncertain-unlink-changed");
    const unreadable = makeProject("uncertain-unlink-unreadable");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, changed, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, unreadable, {}, deps);
    repository.unlinkProjectAliasIfOwned = vi.fn(async (_machine, path) => {
      throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError({
        projectId: PROJECT_A,
        alias: alias(PROJECT_A, path),
      });
    });
    repository.resolveProject = vi.fn(async (_machine, path) => {
      if (path === changed) return { projectId: PROJECT_B, alias: alias(PROJECT_B, path) };
      throw new Error("readback failed");
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, changed, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
    await expect(unlinkProject(POSTGRESQL_CONFIG, unreadable, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project unlink -- ${quoteShellArgument(unreadable)}`,
        ),
      });
  });

  it("authoritatively confirms ambiguous whole-project unlinks", async () => {
    await register();
    const canonical = makeProject("uncertain-unbind-canonical");
    const linked = makeProject("uncertain-unbind-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const aliases = await originalUnlink(machineId, projectId, paths);
      throw new PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError(projectId, aliases ?? []);
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .resolves.toMatchObject({ aliasRemoved: false, remoteProjectId: PROJECT_A });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
  });

  it("treats retained expected rows plus previously missing rows as a safe unlink retry", async () => {
    await register();
    const canonical = makeProject("uncertain-unbind-missing-canonical");
    const linked = makeProject("uncertain-unbind-missing-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    repository.unlinkProjectAliasesIfOwned = vi.fn(async () => {
      throw new PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError(
        PROJECT_A,
        [alias(PROJECT_A, canonical)],
      );
    });
    const originalResolve = repository.resolveProject.getMockImplementation()!;
    repository.resolveProject = vi.fn(async (machineId, normalizedPath) => (
      normalizedPath === linked ? null : originalResolve(machineId, normalizedPath)
    ));

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("safe to retry"),
      });
  });

  it("removes a local alias when its persisted PostgreSQL row is already absent", async () => {
    await register();
    const canonical = makeProject("unlink-absent-row-canonical");
    const linked = makeProject("unlink-absent-row-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    await repository.unlinkProjectAliasIfOwned(MACHINE_ID, linked, PROJECT_A, linked);
    repository.unlinkProjectAliasIfOwned.mockClear();

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .resolves.toMatchObject({ aliasRemoved: true });
    expect(repository.unlinkProjectAliasIfOwned).not.toHaveBeenCalled();
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(linked);
  });

  it("fails closed when ambiguous whole-project unlink retains, changes, or cannot read aliases", async () => {
    await register();
    const canonical = makeProject("uncertain-unbind-fail-canonical");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const candidate = alias(PROJECT_A, canonical);
    repository.unlinkProjectAliasesIfOwned = vi.fn(async () => {
      throw new PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError(PROJECT_A, [candidate]);
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("safe to retry"),
      });

    repository.resolveProject = vi.fn(async () => ({
      projectId: PROJECT_B,
      alias: alias(PROJECT_B, canonical),
    }));
    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });

    repository.resolveProject = vi.fn(async () => {
      throw new Error("readback failed");
    });
    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project unlink -- ${quoteShellArgument(canonical)}`,
        ),
      });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
    expect(bound.local.id).toBe(resolveProjectIdentity(canonical).id);
  });

  it("propagates deterministic whole-project unlink failures", async () => {
    await register();
    const canonical = makeProject("deterministic-unbind-failure");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    repository.unlinkProjectAliasesIfOwned = vi.fn(async () => {
      throw new Error("unlink failed before commit");
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toThrow("unlink failed before commit");
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_A);
  });

  it("relinks remote aliases when clearing a canonical local binding fails", async () => {
    await register();
    const canonical = makeProject("unbind-restore-canonical");
    const linked = makeProject("unbind-restore-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const removed = await originalUnlink(machineId, projectId, paths);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps)).rejects.toThrow();
    expect(repository.restoreProjectAliases).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      expect.arrayContaining([expect.objectContaining({ normalizedPath: linked })]),
    );
  });

  it("does not overwrite a concurrent local rebind while compensating canonical unlink", async () => {
    await register();
    const canonical = makeProject("unbind-cas-rebind");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const removed = await originalUnlink(machineId, projectId, paths);
      setRemoteProjectBinding(PROJECT_B, { canonical });
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toThrow("changed during coordinated mutation");
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBe(PROJECT_B);
    expect(repository.restoreProjectAliases).toHaveBeenCalledWith(
      MACHINE_ID,
      PROJECT_A,
      expect.arrayContaining([expect.objectContaining({ normalizedPath: canonical })]),
    );
  });

  it("retains a concurrent local alias and compensates a stale initial remote binding", async () => {
    await register();
    const canonical = makeProject("bind-cas-alias-canonical");
    const concurrentAlias = makeProject("bind-cas-alias-new");
    const local = resolveProjectIdentity(canonical);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const mutation = await originalReplace(input);
      addProjectAlias(concurrentAlias, { hash: local.id });
      return mutation;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps))
      .rejects.toThrow("changed during coordinated mutation");
    expect(listProjectMapEntries()[local.id]).toMatchObject({
      aliases: [concurrentAlias],
    });
    expect(resolveProjectIdentity(canonical).remoteProjectId).toBeUndefined();
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
  });

  it("accepts an identical concurrent remote binding after losing the map CAS", async () => {
    await register();
    const canonical = makeProject("bind-cas-identical");
    const local = resolveProjectIdentity(canonical);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const mutation = await originalReplace(input);
      setRemoteProjectBinding(PROJECT_A, { hash: local.id });
      return mutation;
    });
    repository.restoreProjectAliasBatch.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps))
      .resolves.toMatchObject({
        local: { id: local.id, remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: canonical },
      });
    expect(repository.restoreProjectAliasBatch).not.toHaveBeenCalled();
  });

  it("authoritatively readbacks ambiguous batch restoration after local unbind failure", async () => {
    await register();
    const canonical = makeProject("unbind-restore-ambiguous");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    const originalRestore = repository.restoreProjectAliases.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const removed = await originalUnlink(machineId, projectId, paths);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.restoreProjectAliases = vi.fn(async (machineId, projectId, aliases) => {
      await originalRestore(machineId, projectId, aliases);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "restoreProjectAliases",
        projectId,
      });
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toThrow("Expected property name");
    await expect(repository.resolveProject(MACHINE_ID, canonical))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("rejects ambiguous canonical-unlink restoration with another lexical path", async () => {
    await register();
    const canonical = makeProject("unbind-restore-lexical");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const concurrentPath = `${canonical}/.`;
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    const originalRestore = repository.restoreProjectAliases.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const removed = await originalUnlink(machineId, projectId, paths);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.restoreProjectAliases = vi.fn(async (machineId, projectId, aliases) => {
      await originalRestore(machineId, projectId, aliases);
      await repository.replaceProjectAlias({
        machineId,
        expectedPriorProjectId: projectId,
        projectId,
        path: concurrentPath,
        normalizedPath: canonical,
      });
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "restoreProjectAliases",
        projectId,
      });
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    await expect(repository.resolveProject(MACHINE_ID, canonical))
      .resolves.toMatchObject({
        projectId: PROJECT_A,
        alias: { path: concurrentPath, normalizedPath: canonical },
      });
  });

  it("fails closed when batch restoration after unbind is deterministic or unreadable", async () => {
    for (const outcome of ["deterministic", "unreadable"] as const) {
      clearProjectMapCache();
      rmSync(join(home, ".lcm"), { recursive: true, force: true });
      const canonical = makeProject(`unbind-restore-${outcome}`);
      await register();
      await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
      const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
      repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
        const removed = await originalUnlink(machineId, projectId, paths);
        writeFileSync(projectMapPath(), "{broken");
        return removed;
      });
      repository.restoreProjectAliases = vi.fn(async (_machineId, projectId) => {
        if (outcome === "deterministic") throw new Error("restore failed");
        throw new PostgreSqlCommitOutcomeUnknownError({
          domain: "identity",
          operation: "restoreProjectAliases",
          projectId,
        });
      });
      if (outcome === "unreadable") {
        repository.resolveProject = vi.fn(async () => {
          throw new Error("readback failed");
        });
      }

      await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
        .rejects.toMatchObject({
          remediation: expect.stringContaining(
            `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
          ),
        });
      repository = fakeRepository();
      deps = {
        homeDir: home,
        openSession: vi.fn(async () => ({ repository, close })),
      };
    }
  });

  it("reports when canonical unbind rollback cannot relink PostgreSQL aliases", async () => {
    await register();
    const canonical = makeProject("unbind-restore-fails");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasesIfOwned = vi.fn(async (machineId, projectId, paths) => {
      const removed = await originalUnlink(machineId, projectId, paths);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.restoreProjectAliases = vi.fn(async () => false);

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
        ),
      });
  });

  it("restores a removed remote alias when its local removal fails", async () => {
    await register();
    const canonical = makeProject("unlink-alias-restore-canonical");
    const linked = makeProject("unlink-alias-restore-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
      addProjectAlias(makeProject("unlink-alias-concurrent-add"), { hash: bound.local.id });
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps)).rejects.toThrow();
    expect(repository.linkProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, normalizedPath: linked }),
    );
  });

  it("does not restore PostgreSQL when an overlapping local alias unlink already won", async () => {
    await register();
    const canonical = makeProject("unlink-alias-overlap-canonical");
    const linked = makeProject("unlink-alias-overlap-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const expectedEntry = showProjectMapEntry(bound.local.id).entry;
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
      removeProjectAlias(linked, { hash: bound.local.id, expectedEntry });
      return removed;
    });
    repository.linkProject.mockClear();

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .resolves.toEqual({
        hash: bound.local.id,
        remoteProjectId: PROJECT_A,
        aliasRemoved: true,
      });
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(linked);
    expect(repository.linkProject).not.toHaveBeenCalled();
  });

  it("rejects alias linking while the same remote alias is being unlinked", async () => {
    await register();
    const canonical = makeProject("unlink-link-coordination-canonical");
    const linked = makeProject("unlink-link-coordination-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    let releaseUnlink!: () => void;
    let unlinkReachedRepository!: () => void;
    const unlinkGate = new Promise<void>((resolve) => { releaseUnlink = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { unlinkReachedRepository = resolve; },
    );
    repository.unlinkProjectAliasIfOwned = vi.fn(
      async (machineId, normalizedPath, projectId, path) => {
        const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
        unlinkReachedRepository();
        await unlinkGate;
        return removed;
      },
    );

    const unlinking = unlinkProject(POSTGRESQL_CONFIG, linked, deps);
    await repositoryReached;
    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps))
      .rejects.toThrow("project identity mutation is already in progress");
    releaseUnlink();

    await expect(unlinking).resolves.toMatchObject({ aliasRemoved: true });
    expect(listProjectMapEntries()[bound.local.id].aliases).not.toContain(linked);
    await expect(repository.resolveProject(MACHINE_ID, linked)).resolves.toBeNull();
  });

  it("rejects remote UUID linking while the same project is being unlinked", async () => {
    await register();
    const canonical = makeProject("unlink-remote-link-coordination-canonical");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasesIfOwned.getMockImplementation()!;
    let releaseUnlink!: () => void;
    let unlinkReachedRepository!: () => void;
    const unlinkGate = new Promise<void>((resolve) => { releaseUnlink = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { unlinkReachedRepository = resolve; },
    );
    repository.unlinkProjectAliasesIfOwned = vi.fn(
      async (machineId, projectId, normalizedPaths) => {
        const removed = await originalUnlink(machineId, projectId, normalizedPaths);
        unlinkReachedRepository();
        await unlinkGate;
        return removed;
      },
    );

    const unlinking = unlinkProject(POSTGRESQL_CONFIG, canonical, deps);
    await repositoryReached;
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps))
      .rejects.toThrow("project identity mutation is already in progress");
    releaseUnlink();

    await expect(unlinking).resolves.toMatchObject({
      hash: bound.local.id,
      remoteProjectId: PROJECT_A,
      aliasRemoved: false,
    });
    expect(listProjectMapEntries()[bound.local.id].remoteProjectId).toBeUndefined();
    await expect(repository.resolveProject(MACHINE_ID, canonical)).resolves.toBeNull();
  });

  it("classifies unlink under the project lock while a remote link is in progress", async () => {
    await register();
    const canonical = makeProject("link-unlink-classification-canonical");
    resolveProjectIdentity(canonical);
    const originalReplace = repository.replaceProjectAliases.getMockImplementation()!;
    let releaseLink!: () => void;
    let linkReachedRepository!: () => void;
    const linkGate = new Promise<void>((resolve) => { releaseLink = resolve; });
    const repositoryReached = new Promise<void>(
      (resolve) => { linkReachedRepository = resolve; },
    );
    repository.replaceProjectAliases = vi.fn(async (input) => {
      const linked = await originalReplace(input);
      linkReachedRepository();
      await linkGate;
      return linked;
    });

    const linking = linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await repositoryReached;
    expect(showProjectMapEntry(canonical).entry.remoteProjectId).toBeUndefined();
    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toThrow("project identity mutation is already in progress");
    releaseLink();

    await expect(linking).resolves.toMatchObject({
      local: { remoteProjectId: PROJECT_A },
    });
    expect(showProjectMapEntry(canonical).entry.remoteProjectId).toBe(PROJECT_A);
  });

  it("accepts an uncertain alias restoration after authoritative readback", async () => {
    await register();
    const canonical = makeProject("unlink-alias-uncertain-restore-canonical");
    const linked = makeProject("unlink-alias-uncertain-restore-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    const originalLink = repository.linkProject.getMockImplementation()!;
    repository.linkProject = vi.fn(async (input) => {
      const restored = await originalLink(input);
      throw new PostgreSqlIdentityLinkOutcomeUnknownError(input.projectId, {
        alias: restored,
        inserted: true,
      });
    });

    const error = await unlinkProject(POSTGRESQL_CONFIG, linked, deps)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProjectIdentityReconciliationError);
    expect(repository.resolveProject).toHaveBeenCalledWith(MACHINE_ID, linked);
    await expect(repository.resolveProject(MACHINE_ID, linked)).resolves.toMatchObject({
      projectId: PROJECT_A,
      alias: { path: linked },
    });
  });

  it.each(["project", "path", "readback"] as const)(
    "rejects an uncertain alias restoration after %s divergence",
    async (outcome) => {
      await register();
      const canonical = makeProject(`unlink-alias-uncertain-${outcome}-canonical`);
      const linked = makeProject(`unlink-alias-uncertain-${outcome}-path`);
      const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
      await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
      const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
      repository.unlinkProjectAliasIfOwned = vi.fn(async (
        machineId,
        normalizedPath,
        projectId,
        path,
      ) => {
        const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
        writeFileSync(projectMapPath(), "{broken");
        return removed;
      });
      repository.linkProject = vi.fn(async (input) => {
        throw new PostgreSqlIdentityLinkOutcomeUnknownError(input.projectId, {
          alias: alias(input.projectId, input.normalizedPath, input.path),
          inserted: true,
        });
      });
      repository.resolveProject = vi.fn(async () => {
        if (outcome === "readback") throw new Error("readback failed");
        if (outcome === "project") {
          return {
            projectId: PROJECT_B,
            alias: alias(PROJECT_B, linked),
          };
        }
        return {
          projectId: PROJECT_A,
          alias: alias(PROJECT_A, linked, `${linked}-other-lexical-path`),
        };
      });

      await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
        .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    },
  );

  it("reports when remote alias removal rollback cannot restore PostgreSQL", async () => {
    await register();
    const canonical = makeProject("unlink-alias-restore-fails-canonical");
    const linked = makeProject("unlink-alias-restore-fails-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProjectAliasIfOwned.getMockImplementation()!;
    repository.unlinkProjectAliasIfOwned = vi.fn(async (
      machineId,
      normalizedPath,
      projectId,
      path,
    ) => {
      const removed = await originalUnlink(machineId, normalizedPath, projectId, path);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.linkProject = vi.fn(async () => {
      throw new Error("restore failed");
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(
          `lcm project link -- ${quoteShellArgument(PROJECT_A)}`,
        ),
      });
  });

  it("preserves the local removal error when PostgreSQL removed no alias", async () => {
    await register();
    const canonical = makeProject("unlink-alias-absent-canonical");
    const linked = makeProject("unlink-alias-absent-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    repository.unlinkProjectAliasIfOwned = vi.fn(async () => {
      writeFileSync(projectMapPath(), "{broken");
      return null;
    });
    repository.linkProject.mockClear();

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps)).rejects.toThrow();
    expect(repository.linkProject).not.toHaveBeenCalledWith(
      expect.objectContaining({ normalizedPath: linked }),
    );
  });
});
