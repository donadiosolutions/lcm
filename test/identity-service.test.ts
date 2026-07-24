import {
  mkdirSync,
  mkdtempSync,
  rmSync,
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
  clearProjectMapCache,
  projectMapPath,
  resolveProjectIdentity,
  setRemoteProjectBinding,
} from "../src/project-map.js";
import type {
  RegisteredMachine,
  RemoteProject,
  RemoteProjectAlias,
} from "../src/storage/postgresql/identity-repository.js";

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
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

function alias(projectId: string, path: string): RemoteProjectAlias {
  return {
    machineId: MACHINE_ID,
    path,
    normalizedPath: path,
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

function fakeRepository(): IdentityRepository & {
  [K in keyof IdentityRepository]: IdentityRepository[K] & ReturnType<typeof vi.fn>;
} {
  const projects = new Map<string, RemoteProject>();
  const aliases = new Map<string, { projectId: string; alias: RemoteProjectAlias }>();
  let nextProjectId = PROJECT_A;
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
      const firstAlias = alias(nextProjectId, input.normalizedPath);
      project.aliases = [firstAlias];
      projects.set(nextProjectId, project);
      aliases.set(input.normalizedPath, { projectId: nextProjectId, alias: firstAlias });
      return project;
    }),
    linkProject: vi.fn(async (input): Promise<RemoteProjectAlias> => {
      const existing = aliases.get(input.normalizedPath);
      if (existing && existing.projectId !== input.projectId) throw new Error("collision");
      const linked = alias(input.projectId, input.normalizedPath);
      aliases.set(input.normalizedPath, { projectId: input.projectId, alias: linked });
      projects.set(
        input.projectId,
        projects.get(input.projectId) ?? remoteProject(input.projectId),
      );
      return linked;
    }),
    unlinkPath: vi.fn(async (_machineId, normalizedPath) => {
      const existing = aliases.get(normalizedPath);
      aliases.delete(normalizedPath);
      return existing ?? null;
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
    resolveProject: vi.fn(async (_machineId, normalizedPath) => aliases.get(normalizedPath) ?? null),
    listProjects: vi.fn(async () => [...projects.values()]),
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
    repository.listProjects = vi.fn(async () => [remoteProject(PROJECT_A)]);
    await expect(showProject(POSTGRESQL_CONFIG, path, deps))
      .resolves.toMatchObject({ remote: { projectId: PROJECT_A } });

    repository.listProjects = vi.fn(async () => []);
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
    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toThrow("already bound");
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
      .rejects.toThrow("display name must not be blank");

    const path = makeProject("default-name");
    await createProject(POSTGRESQL_CONFIG, path, {}, deps);
    expect(repository.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "default-name" }),
    );
  });

  it("compensates when a created remote project cannot be written locally", async () => {
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
      .rejects.toThrow("Expected property name");
    expect(repository.unlinkProject).toHaveBeenCalledWith(MACHINE_ID, PROJECT_A);
    expect(repository.deleteProjectIfUnreferenced).toHaveBeenCalledWith(PROJECT_A);
  });

  it("returns an exact recovery command when project creation and cleanup both fail", async () => {
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
    repository.unlinkProject = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(createProject(POSTGRESQL_CONFIG, path, {}, deps))
      .rejects.toMatchObject({
        name: "ProjectIdentityReconciliationError",
        remediation: expect.stringContaining(`lcm project link ${PROJECT_A}`),
      });
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

  it("links a remote UUID and requires acknowledgement only for data-bearing rebinds", async () => {
    await register();
    const path = makeProject("remote-link");
    const first = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
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

  it("accepts an uncertain link only after authoritative matching readback", async () => {
    await register();
    const path = makeProject("uncertain-confirmed");
    repository.linkProject = vi.fn(async (input) => {
      const linked = alias(input.projectId, input.normalizedPath);
      repository.resolveProject = vi.fn(async () => ({
        projectId: input.projectId,
        alias: linked,
      }));
      throw new Error("commit result lost");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .resolves.toMatchObject({
        local: { remoteProjectId: PROJECT_A },
        remoteAlias: { normalizedPath: path },
      });
  });

  it("reports uncertain links when readback is absent or unavailable", async () => {
    await register();
    const absent = makeProject("uncertain-absent");
    repository.linkProject = vi.fn(async () => {
      throw new Error("commit result lost");
    });
    repository.resolveProject = vi.fn(async () => null);
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, absent, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(`lcm project link ${PROJECT_A}`),
      });

    const unavailable = makeProject("uncertain-readback-fails");
    repository.resolveProject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("readback unavailable"));
    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, unavailable, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
  });

  it("restores a prior remote alias when a rebind fails", async () => {
    await register();
    const path = makeProject("restore-prior");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    const originalLink = repository.linkProject.getMockImplementation()!;
    repository.linkProject = vi.fn(async (input) => {
      if (input.projectId === PROJECT_B) throw new Error("rebind failed");
      return originalLink(input);
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toBeInstanceOf(ProjectIdentityReconciliationError);
    await expect(repository.resolveProject(MACHINE_ID, path))
      .resolves.toMatchObject({ projectId: PROJECT_A });
  });

  it("reports when a failed rebind cannot restore its prior remote alias", async () => {
    await register();
    const path = makeProject("restore-prior-fails");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps);
    repository.linkProject = vi.fn(async () => {
      throw new Error("all links fail");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_B, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining("project list --json"),
      });
  });

  it("restores a newly linked remote alias after a local binding write failure", async () => {
    await register();
    const path = makeProject("restore-new-link");
    const originalUnlink = repository.unlinkPath.getMockImplementation()!;
    repository.linkProject = vi.fn(async (input) => {
      const linked = alias(input.projectId, input.normalizedPath);
      repository.resolveProject = vi.fn(async () => ({
        projectId: input.projectId,
        alias: linked,
      }));
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(projectMapPath(), "{broken");
      return linked;
    });
    repository.unlinkPath = vi.fn(async (machineId, normalizedPath) => {
      await originalUnlink(machineId, normalizedPath);
      return null;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow();
    expect(repository.unlinkPath).toHaveBeenCalled();
  });

  it("observes an absent remote alias after rolling back a local binding failure", async () => {
    await register();
    const path = makeProject("restore-new-link-absent");
    const originalLink = repository.linkProject.getMockImplementation()!;
    repository.linkProject = vi.fn(async (input) => {
      const linked = await originalLink(input);
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(projectMapPath(), "{broken");
      return linked;
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toThrow();
    await expect(repository.resolveProject(MACHINE_ID, path)).resolves.toBeNull();
  });

  it("reports when local binding failure cannot restore PostgreSQL", async () => {
    await register();
    const path = makeProject("restore-new-link-fails");
    repository.linkProject = vi.fn(async (input) => {
      mkdirSync(join(home, ".lcm"), { recursive: true });
      writeFileSync(projectMapPath(), "{broken");
      return alias(input.projectId, input.normalizedPath);
    });
    repository.unlinkPath = vi.fn(async () => {
      throw new Error("restore failed");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, PROJECT_A, path, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(`lcm project link ${PROJECT_A}`),
      });
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
    expect(repository.linkProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, normalizedPath: linked }),
    );
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
    expect(repository.unlinkPath).toHaveBeenCalledWith(MACHINE_ID, occupied);
  });

  it("reports when local alias collision cleanup fails remotely", async () => {
    await register();
    const canonical = makeProject("alias-cleanup-fails-canonical");
    const occupiedCanonical = makeProject("alias-cleanup-fails-occupied");
    const occupied = makeProject("alias-cleanup-fails-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const occupiedIdentity = resolveProjectIdentity(occupiedCanonical);
    await linkProject(SQLITE_CONFIG, occupiedIdentity.id, occupied, {}, deps);
    repository.unlinkPath = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(`project unlink ${occupied}`),
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
    repository.unlinkPath.mockClear();

    await expect(linkProject(POSTGRESQL_CONFIG, bound.local.id, occupied, {}, deps))
      .rejects.toThrow("already mapped");
    expect(repository.unlinkPath).not.toHaveBeenCalled();
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

  it("relinks remote aliases when clearing a canonical local binding fails", async () => {
    await register();
    const canonical = makeProject("unbind-restore-canonical");
    const linked = makeProject("unbind-restore-alias");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkProject.getMockImplementation()!;
    repository.unlinkProject = vi.fn(async (machineId, projectId) => {
      const removed = await originalUnlink(machineId, projectId);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps)).rejects.toThrow();
    expect(repository.linkProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, normalizedPath: linked }),
    );
  });

  it("reports when canonical unbind rollback cannot relink PostgreSQL aliases", async () => {
    await register();
    const canonical = makeProject("unbind-restore-fails");
    await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    const originalUnlink = repository.unlinkProject.getMockImplementation()!;
    repository.unlinkProject = vi.fn(async (machineId, projectId) => {
      const removed = await originalUnlink(machineId, projectId);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.linkProject = vi.fn(async () => {
      throw new Error("relink failed");
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, canonical, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(`lcm project link ${PROJECT_A}`),
      });
  });

  it("restores a removed remote alias when its local removal fails", async () => {
    await register();
    const canonical = makeProject("unlink-alias-restore-canonical");
    const linked = makeProject("unlink-alias-restore-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkPath.getMockImplementation()!;
    repository.unlinkPath = vi.fn(async (machineId, normalizedPath) => {
      const removed = await originalUnlink(machineId, normalizedPath);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps)).rejects.toThrow();
    expect(repository.linkProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A, normalizedPath: linked }),
    );
  });

  it("reports when remote alias removal rollback cannot restore PostgreSQL", async () => {
    await register();
    const canonical = makeProject("unlink-alias-restore-fails-canonical");
    const linked = makeProject("unlink-alias-restore-fails-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    const originalUnlink = repository.unlinkPath.getMockImplementation()!;
    repository.unlinkPath = vi.fn(async (machineId, normalizedPath) => {
      const removed = await originalUnlink(machineId, normalizedPath);
      writeFileSync(projectMapPath(), "{broken");
      return removed;
    });
    repository.linkProject = vi.fn(async () => {
      throw new Error("restore failed");
    });

    await expect(unlinkProject(POSTGRESQL_CONFIG, linked, deps))
      .rejects.toMatchObject({
        remediation: expect.stringContaining(`lcm project link ${PROJECT_A}`),
      });
  });

  it("preserves the local removal error when PostgreSQL removed no alias", async () => {
    await register();
    const canonical = makeProject("unlink-alias-absent-canonical");
    const linked = makeProject("unlink-alias-absent-path");
    const bound = await linkProject(POSTGRESQL_CONFIG, PROJECT_A, canonical, {}, deps);
    await linkProject(POSTGRESQL_CONFIG, bound.local.id, linked, {}, deps);
    repository.unlinkPath = vi.fn(async () => {
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
