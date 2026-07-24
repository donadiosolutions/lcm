import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ResolvedStorageConfig } from "./daemon/config.js";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  isUuidV7,
  readMachineIdentity,
  recoverMachineIdentity,
  requireMachineIdentity,
  type MachineIdentity,
  type MachineIdentityRecoveryResult,
  type StoredMachineIdentity,
} from "./machine-identity.js";
import {
  addProjectAlias,
  clearRemoteProjectBinding,
  isProjectHash,
  listProjectMapEntries,
  normalizeProjectPath,
  projectMapEntryHasStoredData,
  removeProjectAlias,
  resolveProjectIdentity,
  setRemoteProjectBinding,
  showProjectMapEntry,
  type ProjectIdentity,
  type ProjectMap,
  type ProjectMapEntry,
} from "./project-map.js";
import {
  PostgreSqlIdentityRepository,
  type RegisteredMachine,
  type RemoteProject,
  type RemoteProjectAlias,
} from "./storage/postgresql/identity-repository.js";
import { PostgreSqlRuntime } from "./storage/postgresql/runtime.js";

export interface IdentityRepository {
  registerMachine(identityKey: string, displayName: string): Promise<RegisteredMachine>;
  recoverMachine(machineId: string): Promise<RegisteredMachine>;
  createProject(input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProject>;
  linkProject(input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias>;
  unlinkPath(
    machineId: string,
    normalizedPath: string,
  ): Promise<{ readonly projectId: string; readonly alias: RemoteProjectAlias } | null>;
  unlinkProject(machineId: string, projectId: string): Promise<RemoteProjectAlias[]>;
  deleteProjectIfUnreferenced(projectId: string): Promise<boolean>;
  resolveProject(
    machineId: string,
    normalizedPath: string,
  ): Promise<{ readonly projectId: string; readonly alias: RemoteProjectAlias } | null>;
  listProjects(): Promise<RemoteProject[]>;
}

export interface IdentitySession {
  readonly repository: IdentityRepository;
  close(): Promise<void>;
}

export interface IdentityServiceDependencies {
  readonly openSession: (config: ResolvedStorageConfig) => Promise<IdentitySession>;
  readonly homeDir?: string;
}

export class RemoteIdentityConfigurationError extends Error {
  constructor() {
    super(
      "PostgreSQL identity commands require storage.backend \"postgresql\", LCM_POSTGRES_URL, and LCM_POSTGRES_CA_FILE.",
    );
    this.name = "RemoteIdentityConfigurationError";
  }
}

export class ProjectIdentityReconciliationError extends Error {
  constructor(message: string, readonly remediation: string) {
    super(`${message}. ${remediation}`);
    this.name = "ProjectIdentityReconciliationError";
  }
}

function requirePostgreSqlConfig(
  config: ResolvedStorageConfig,
): Extract<ResolvedStorageConfig, { backend: "postgresql" }> {
  if (config.backend !== "postgresql") throw new RemoteIdentityConfigurationError();
  return config;
}

export async function openPostgreSqlIdentitySession(
  config: ResolvedStorageConfig,
): Promise<IdentitySession> {
  const postgresql = requirePostgreSqlConfig(config);
  const runtime = new PostgreSqlRuntime(postgresql.postgresql);
  try {
    const health = await runtime.health();
    if (health.status !== "healthy") {
      throw health.error ?? new Error("PostgreSQL identity storage is unavailable");
    }
    return {
      repository: new PostgreSqlIdentityRepository(runtime),
      close: () => runtime.close(),
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

const DEFAULT_DEPENDENCIES: IdentityServiceDependencies = {
  openSession: openPostgreSqlIdentitySession,
};

function dependencies(
  overrides?: Partial<IdentityServiceDependencies>,
): IdentityServiceDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function assertProjectDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`project path does not exist: ${absolute}`);
  if (!statSync(absolute).isDirectory()) {
    throw new Error(`project path must be an existing directory: ${absolute}`);
  }
  return absolute;
}

function remotePath(path: string): { readonly path: string; readonly normalizedPath: string } {
  const absolute = resolve(path);
  return { path: absolute, normalizedPath: absolute };
}

async function withSession<T>(
  config: ResolvedStorageConfig,
  deps: IdentityServiceDependencies,
  callback: (repository: IdentityRepository) => Promise<T>,
): Promise<T> {
  requirePostgreSqlConfig(config);
  const session = await deps.openSession(config);
  try {
    return await callback(session.repository);
  } finally {
    await session.close();
  }
}

function machineFromRegistered(registered: RegisteredMachine): MachineIdentity {
  return {
    version: 1,
    identityKey: registered.identityKey,
    machineId: registered.machineId,
    displayName: registered.displayName,
  };
}

export async function registerMachine(
  config: ResolvedStorageConfig,
  options: { readonly displayName?: string } = {},
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{ readonly identity: MachineIdentity; readonly created: boolean }> {
  requirePostgreSqlConfig(config);
  const deps = dependencies(dependencyOverrides);
  const pending = ensurePendingMachineIdentity(
    options.displayName,
    deps.homeDir,
  );
  const displayName = options.displayName?.trim() || pending.identity.displayName;
  return withSession(config, deps, async (repository) => {
    const registered = await repository.registerMachine(
      pending.identity.identityKey,
      displayName,
    );
    const identity = finalizeMachineIdentity(
      pending.identity,
      registered.machineId,
      registered.displayName,
      deps.homeDir,
    );
    return { identity, created: pending.created };
  });
}

export function showMachine(
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): StoredMachineIdentity | null {
  return readMachineIdentity(dependencies(dependencyOverrides).homeDir);
}

export async function recoverMachine(
  config: ResolvedStorageConfig,
  machineId: string,
  options: { readonly force?: boolean } = {},
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<MachineIdentityRecoveryResult> {
  if (!isUuidV7(machineId)) throw new Error(`invalid PostgreSQL machine UUIDv7: ${machineId}`);
  const deps = dependencies(dependencyOverrides);
  return withSession(config, deps, async (repository) => {
    const registered = await repository.recoverMachine(machineId);
    return recoverMachineIdentity(machineFromRegistered(registered), {
      force: options.force,
      homeDir: deps.homeDir,
    });
  });
}

export interface LocalProjectListing {
  readonly hash: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly remoteProjectId?: string;
}

export interface ProjectListing {
  readonly local: readonly LocalProjectListing[];
  readonly remote?: readonly RemoteProject[];
}

function localProjectListing(map: ProjectMap): LocalProjectListing[] {
  return Object.entries(map)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, entry]) => ({
      hash,
      canonical: entry.canonical,
      aliases: [...entry.aliases],
      ...(entry.remoteProjectId ? { remoteProjectId: entry.remoteProjectId } : {}),
    }));
}

export async function listProjects(
  config: ResolvedStorageConfig,
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<ProjectListing> {
  const local = localProjectListing(listProjectMapEntries());
  if (config.backend === "sqlite") return { local };
  const deps = dependencies(dependencyOverrides);
  const remote = await withSession(config, deps, (repository) => repository.listProjects());
  return { local, remote };
}

export async function showProject(
  config: ResolvedStorageConfig,
  target?: string,
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{
  readonly hash: string;
  readonly entry: ProjectMapEntry;
  readonly transient?: boolean;
  readonly remote?: RemoteProject;
}> {
  const shown = showProjectMapEntry(target);
  if (config.backend === "sqlite" || !shown.entry.remoteProjectId) return shown;
  const deps = dependencies(dependencyOverrides);
  const projects = await withSession(config, deps, (repository) => repository.listProjects());
  const remote = projects.find(({ projectId }) => projectId === shown.entry.remoteProjectId);
  if (!remote) {
    throw new ProjectIdentityReconciliationError(
      `local project ${shown.hash} references missing PostgreSQL project ${shown.entry.remoteProjectId}`,
      `Run \`lcm project unlink ${shown.entry.canonical}\` or link the correct project explicitly.`,
    );
  }
  return { ...shown, remote };
}

async function compensateCreatedProject(
  repository: IdentityRepository,
  projectId: string,
  machineId: string,
): Promise<void> {
  await repository.unlinkProject(machineId, projectId);
  await repository.deleteProjectIfUnreferenced(projectId);
}

export async function createProject(
  config: ResolvedStorageConfig,
  path = process.cwd(),
  options: { readonly displayName?: string } = {},
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{ readonly local: ProjectIdentity; readonly remote: RemoteProject }> {
  const projectPath = assertProjectDirectory(path);
  const deps = dependencies(dependencyOverrides);
  const machine = requireMachineIdentity(deps.homeDir);
  const displayName = options.displayName?.trim() || basename(normalizeProjectPath(projectPath));
  if (!displayName) throw new Error("project display name must not be blank");
  const local = resolveProjectIdentity(projectPath);
  if (local.remoteProjectId) {
    throw new Error(
      `local project ${local.id} is already bound to PostgreSQL project ${local.remoteProjectId}`,
    );
  }
  return withSession(config, deps, async (repository) => {
    const remote = await repository.createProject({
      machineId: machine.machineId,
      displayName,
      ...remotePath(local.canonical),
    });
    try {
      setRemoteProjectBinding(remote.projectId, { hash: local.id });
    } catch (error) {
      try {
        await compensateCreatedProject(repository, remote.projectId, machine.machineId);
      } catch {
        throw new ProjectIdentityReconciliationError(
          "PostgreSQL created the project but the local binding and automatic cleanup both failed",
          `Run \`lcm project link ${remote.projectId} ${local.canonical}\` to reconcile it.`,
        );
      }
      throw error;
    }
    return {
      local: resolveProjectIdentity(projectPath),
      remote,
    };
  });
}

async function confirmRemoteLink(
  repository: IdentityRepository,
  input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  },
): Promise<RemoteProjectAlias> {
  try {
    return await repository.linkProject(input);
  } catch (error) {
    try {
      const resolved = await repository.resolveProject(input.machineId, input.normalizedPath);
      if (resolved?.projectId === input.projectId) return resolved.alias;
    } catch {
      // Preserve the original safe failure and provide an idempotent command.
    }
    throw new ProjectIdentityReconciliationError(
      "PostgreSQL project linking did not produce an authoritative result",
      `Rerun \`lcm project link ${input.projectId} ${input.path}\`; the operation is idempotent.`,
    );
  }
}

async function restoreRemoteAlias(
  repository: IdentityRepository,
  machineId: string,
  prior: { readonly projectId: string; readonly alias: RemoteProjectAlias } | null,
  currentProjectId: string,
  normalizedPath: string,
): Promise<void> {
  await repository.unlinkPath(machineId, normalizedPath);
  if (prior) {
    await repository.linkProject({
      machineId,
      projectId: prior.projectId,
      path: prior.alias.path,
      normalizedPath: prior.alias.normalizedPath,
    });
  } else {
    const current = await repository.resolveProject(machineId, normalizedPath);
    if (current?.projectId === currentProjectId) {
      await repository.unlinkPath(machineId, normalizedPath);
    }
  }
}

async function linkRemoteProject(
  config: ResolvedStorageConfig,
  remoteProjectId: string,
  projectPath: string,
  options: { readonly allowExistingData?: boolean },
  deps: IdentityServiceDependencies,
): Promise<{
  readonly local: ProjectIdentity;
  readonly remoteAlias: RemoteProjectAlias;
}> {
  const machine = requireMachineIdentity(deps.homeDir);
  const local = resolveProjectIdentity(projectPath);
  if (
    local.remoteProjectId
    && local.remoteProjectId !== remoteProjectId
    && projectMapEntryHasStoredData(local.id)
    && !options.allowExistingData
  ) {
    throw new Error(
      `project ${local.id} already has local data; rerun with --allow-existing-data to rebind it explicitly`,
    );
  }
  const path = remotePath(projectPath);
  return withSession(config, deps, async (repository) => {
    const prior = await repository.resolveProject(machine.machineId, path.normalizedPath);
    if (prior && prior.projectId !== remoteProjectId) {
      await repository.unlinkPath(machine.machineId, path.normalizedPath);
    }
    let remoteAlias: RemoteProjectAlias;
    try {
      remoteAlias = await confirmRemoteLink(repository, {
        machineId: machine.machineId,
        projectId: remoteProjectId,
        ...path,
      });
    } catch (error) {
      if (prior && prior.projectId !== remoteProjectId) {
        try {
          await restoreRemoteAlias(
            repository,
            machine.machineId,
            prior,
            remoteProjectId,
            path.normalizedPath,
          );
        } catch {
          throw new ProjectIdentityReconciliationError(
            "PostgreSQL relinking failed and the prior alias could not be restored",
            `Inspect \`lcm project list --json\`, then link ${projectPath} explicitly.`,
          );
        }
      }
      throw error;
    }
    try {
      setRemoteProjectBinding(remoteProjectId, {
        hash: local.id,
        allowExistingData: options.allowExistingData,
      });
    } catch (error) {
      try {
        await restoreRemoteAlias(
          repository,
          machine.machineId,
          prior,
          remoteProjectId,
          path.normalizedPath,
        );
      } catch {
        throw new ProjectIdentityReconciliationError(
          "the local project map write failed and PostgreSQL could not be restored",
          `Inspect \`lcm project list --json\`, then rerun \`lcm project link ${remoteProjectId} ${projectPath}\`.`,
        );
      }
      throw error;
    }
    return {
      local: resolveProjectIdentity(projectPath),
      remoteAlias,
    };
  });
}

async function linkLocalAlias(
  config: ResolvedStorageConfig,
  target: string,
  aliasPath: string,
  deps: IdentityServiceDependencies,
): Promise<{
  readonly local: ProjectIdentity;
  readonly remoteAlias?: RemoteProjectAlias;
}> {
  const targetOptions = isProjectHash(target) ? { hash: target } : { canonical: target };
  const shown = showProjectMapEntry(target);
  if (shown.transient) throw new Error(`unknown local project target: ${target}`);
  if (!shown.entry.remoteProjectId) {
    const result = addProjectAlias(aliasPath, targetOptions);
    return { local: resolveProjectIdentity(result.entry.canonical) };
  }
  const machine = requireMachineIdentity(deps.homeDir);
  const alias = remotePath(aliasPath);
  return withSession(config, deps, async (repository) => {
    const prior = await repository.resolveProject(machine.machineId, alias.normalizedPath);
    const remoteAlias = await confirmRemoteLink(repository, {
      machineId: machine.machineId,
      projectId: shown.entry.remoteProjectId!,
      ...alias,
    });
    try {
      addProjectAlias(aliasPath, targetOptions);
    } catch (error) {
      if (!prior) {
        try {
          await repository.unlinkPath(machine.machineId, alias.normalizedPath);
        } catch {
          throw new ProjectIdentityReconciliationError(
            "the local alias write failed and its PostgreSQL alias could not be removed",
            `Run \`lcm project unlink ${aliasPath}\` to reconcile it.`,
          );
        }
      }
      throw error;
    }
    return {
      local: resolveProjectIdentity(shown.entry.canonical),
      remoteAlias,
    };
  });
}

export async function linkProject(
  config: ResolvedStorageConfig,
  target: string,
  path = process.cwd(),
  options: { readonly allowExistingData?: boolean } = {},
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{
  readonly local: ProjectIdentity;
  readonly remoteAlias?: RemoteProjectAlias;
}> {
  const projectPath = assertProjectDirectory(path);
  const deps = dependencies(dependencyOverrides);
  return isUuidV7(target)
    ? linkRemoteProject(config, target, projectPath, options, deps)
    : linkLocalAlias(config, target, projectPath, deps);
}

async function relinkAliases(
  repository: IdentityRepository,
  machineId: string,
  projectId: string,
  aliases: readonly RemoteProjectAlias[],
): Promise<void> {
  for (const alias of aliases) {
    await repository.linkProject({
      machineId,
      projectId,
      path: alias.path,
      normalizedPath: alias.normalizedPath,
    });
  }
}

export async function unlinkProject(
  config: ResolvedStorageConfig,
  path = process.cwd(),
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{
  readonly hash: string;
  readonly remoteProjectId?: string;
  readonly aliasRemoved: boolean;
}> {
  const projectPath = resolve(path);
  const shown = showProjectMapEntry(projectPath);
  if (shown.transient) throw new Error(`project is not mapped: ${projectPath}`);
  const aliasPath = shown.entry.aliases.find((alias) => resolve(alias) === projectPath);
  if (!aliasPath) {
    if (!shown.entry.remoteProjectId) {
      throw new Error(`canonical project ${shown.hash} has no remote binding to unlink`);
    }
    const deps = dependencies(dependencyOverrides);
    const machine = requireMachineIdentity(deps.homeDir);
    return withSession(config, deps, async (repository) => {
      const removed = await repository.unlinkProject(
        machine.machineId,
        shown.entry.remoteProjectId!,
      );
      try {
        clearRemoteProjectBinding(shown.hash);
      } catch (error) {
        try {
          await relinkAliases(
            repository,
            machine.machineId,
            shown.entry.remoteProjectId!,
            removed,
          );
        } catch {
          throw new ProjectIdentityReconciliationError(
            "the local unbind failed and PostgreSQL aliases could not be restored",
            `Rerun \`lcm project link ${shown.entry.remoteProjectId} ${shown.entry.canonical}\`.`,
          );
        }
        throw error;
      }
      return {
        hash: shown.hash,
        remoteProjectId: shown.entry.remoteProjectId,
        aliasRemoved: false,
      };
    });
  }
  if (!shown.entry.remoteProjectId) {
    removeProjectAlias(aliasPath, { hash: shown.hash });
    return { hash: shown.hash, aliasRemoved: true };
  }
  const deps = dependencies(dependencyOverrides);
  const machine = requireMachineIdentity(deps.homeDir);
  return withSession(config, deps, async (repository) => {
    const removed = await repository.unlinkPath(
      machine.machineId,
      remotePath(aliasPath).normalizedPath,
    );
    try {
      removeProjectAlias(aliasPath, { hash: shown.hash });
    } catch (error) {
      if (removed) {
        try {
          await repository.linkProject({
            machineId: machine.machineId,
            projectId: removed.projectId,
            path: removed.alias.path,
            normalizedPath: removed.alias.normalizedPath,
          });
        } catch {
          throw new ProjectIdentityReconciliationError(
            "the local alias removal failed and PostgreSQL could not be restored",
            `Rerun \`lcm project link ${shown.entry.remoteProjectId} ${aliasPath}\`.`,
          );
        }
      }
      throw error;
    }
    return {
      hash: shown.hash,
      remoteProjectId: shown.entry.remoteProjectId,
      aliasRemoved: true,
    };
  });
}
