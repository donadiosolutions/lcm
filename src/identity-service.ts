import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ResolvedStorageConfig } from "./daemon/config.js";
import {
  ensurePendingMachineIdentity,
  finalizeMachineIdentity,
  isUuidV7,
  normalizeMachineDisplayName,
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
  PostgreSqlIdentityCreateOutcomeUnknownError,
  PostgreSqlIdentityReplaceAliasesOutcomeUnknownError,
  PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError,
  PostgreSqlIdentityUnlinkPathOutcomeUnknownError,
  type RemoteAliasOwnership,
  type RemoteAliasBatchMutation,
  type RegisteredMachine,
  type RemoteProject,
  type RemoteProjectAlias,
  type RemoteProjectAliasInput,
} from "./storage/postgresql/identity-repository.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./storage/postgresql/errors.js";
import { PostgreSqlRuntime } from "./storage/postgresql/runtime.js";

export interface IdentityRepository {
  registerMachine(identityKey: string, displayName: string): Promise<RegisteredMachine>;
  recoverMachine(machineId: string): Promise<RegisteredMachine>;
  createProject(input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly path: string;
    readonly normalizedPath: string;
    readonly aliases?: readonly RemoteProjectAliasInput[];
  }): Promise<RemoteProject>;
  linkProject(input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias>;
  replaceProjectAlias(input: {
    readonly machineId: string;
    readonly expectedPriorProjectId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias | null>;
  replaceProjectAliases(input: {
    readonly machineId: string;
    readonly expectedPriorProjectId?: string;
    readonly projectId: string;
    readonly aliases: readonly RemoteProjectAliasInput[];
  }): Promise<RemoteAliasBatchMutation | null>;
  unlinkPath(
    machineId: string,
    normalizedPath: string,
  ): Promise<{ readonly projectId: string; readonly alias: RemoteProjectAlias } | null>;
  unlinkProjectAliasIfOwned(
    machineId: string,
    normalizedPath: string,
    projectId: string,
  ): Promise<RemoteAliasOwnership | null>;
  unlinkProjectAliasesIfOwned(
    machineId: string,
    projectId: string,
    aliases: readonly RemoteProjectAliasInput[],
  ): Promise<RemoteProjectAlias[] | null>;
  unlinkProject(machineId: string, projectId: string): Promise<RemoteProjectAlias[]>;
  deleteProjectIfUnreferenced(projectId: string): Promise<boolean>;
  cleanupCreatedProject(
    machineId: string,
    projectId: string,
    normalizedPaths: readonly string[],
  ): Promise<boolean>;
  restoreProjectAlias(input: {
    readonly machineId: string;
    readonly normalizedPath: string;
    readonly currentProjectId: string;
    readonly prior: RemoteAliasOwnership | null;
  }): Promise<boolean>;
  restoreProjectAliases(
    machineId: string,
    projectId: string,
    aliases: readonly RemoteProjectAlias[],
  ): Promise<boolean>;
  restoreProjectAliasBatch(
    machineId: string,
    currentProjectId: string,
    prior: readonly (RemoteAliasOwnership | null)[],
    aliases: readonly RemoteProjectAliasInput[],
  ): Promise<boolean>;
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
  return { path: absolute, normalizedPath: realpathSync(absolute) };
}

function remoteEntryPaths(entry: ProjectMapEntry): Array<{
  readonly path: string;
  readonly normalizedPath: string;
}> {
  const paths = new Map<string, { readonly path: string; readonly normalizedPath: string }>();
  for (const entryPath of [entry.canonical, ...entry.aliases]) {
    const remote = remotePath(entryPath);
    paths.set(remote.normalizedPath, remote);
  }
  return [...paths.values()];
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
    try {
      await session.close();
    } catch {
      // Session cleanup is best-effort and never replaces the operation result.
    }
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
  const requestedDisplayName = options.displayName === undefined
    ? undefined
    : normalizeMachineDisplayName(options.displayName);
  const pending = ensurePendingMachineIdentity(
    requestedDisplayName,
    deps.homeDir,
  );
  const displayName = requestedDisplayName ?? pending.identity.displayName;
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
  normalizedPaths: readonly string[],
): Promise<void> {
  await repository.cleanupCreatedProject(machineId, projectId, normalizedPaths);
}

async function createRemoteProject(
  repository: IdentityRepository,
  input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly path: string;
    readonly normalizedPath: string;
    readonly aliases: readonly RemoteProjectAliasInput[];
  },
): Promise<RemoteProject> {
  try {
    return await repository.createProject(input);
  } catch (error) {
    if (!(error instanceof PostgreSqlIdentityCreateOutcomeUnknownError)) throw error;
    const candidate = error.candidate;
    let resolved: Array<RemoteAliasOwnership | null>;
    try {
      resolved = await Promise.all(
        input.aliases.map(
          ({ normalizedPath }) => repository.resolveProject(input.machineId, normalizedPath),
        ),
      );
    } catch {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL project creation commit outcome is unknown and readback failed",
        `Inspect \`lcm project list --json\`, then run \`lcm project link ${candidate.projectId} ${input.path}\` only if that project owns the path.`,
      );
    }
    if (resolved.every((owner) => owner === null)) {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL did not retain the project aliases after the uncertain create",
        `Rerun \`lcm project create ${input.path} --name ${JSON.stringify(input.displayName)}\`.`,
      );
    }
    if (resolved.every((owner) => owner?.projectId === candidate.projectId)) return candidate;
    const ownerIds = [...new Set(
      resolved.flatMap((owner) => owner ? [owner.projectId] : []),
    )];
    throw new ProjectIdentityReconciliationError(
      `PostgreSQL project creation candidate ${candidate.projectId} does not own every local path; observed owners: ${ownerIds.join(", ")}`,
      `Run \`lcm project show ${input.path} --json\` and resolve the collision before retrying.`,
    );
  }
}

export async function createProject(
  config: ResolvedStorageConfig,
  path = process.cwd(),
  options: { readonly displayName?: string } = {},
  dependencyOverrides?: Partial<IdentityServiceDependencies>,
): Promise<{ readonly local: ProjectIdentity; readonly remote: RemoteProject }> {
  requirePostgreSqlConfig(config);
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
  const entryPaths = remoteEntryPaths(showProjectMapEntry(local.id).entry);
  const selectedPath = remotePath(projectPath);
  return withSession(config, deps, async (repository) => {
    const remote = await createRemoteProject(repository, {
      machineId: machine.machineId,
      displayName,
      ...selectedPath,
      aliases: entryPaths,
    });
    try {
      setRemoteProjectBinding(remote.projectId, { hash: local.id });
    } catch (error) {
      try {
        await compensateCreatedProject(
          repository,
          remote.projectId,
          machine.machineId,
          entryPaths.map(({ normalizedPath }) => normalizedPath),
        );
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
    if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
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

async function confirmRemoteBatchReplacement(
  repository: IdentityRepository,
  input: {
    readonly machineId: string;
    readonly expectedPriorProjectId?: string;
    readonly projectId: string;
    readonly aliases: readonly RemoteProjectAliasInput[];
    readonly recoveryPath: string;
  },
): Promise<RemoteAliasBatchMutation> {
  try {
    const replaced = await repository.replaceProjectAliases(input);
    if (replaced) return replaced;
    throw new ProjectIdentityReconciliationError(
      "PostgreSQL alias ownership changed before the authorized project rebind",
      "Inspect `lcm project list --json` and reconcile every local project path explicitly.",
    );
  } catch (error) {
    if (!(error instanceof PostgreSqlIdentityReplaceAliasesOutcomeUnknownError)) throw error;
    let resolved: Array<RemoteAliasOwnership | null>;
    try {
      resolved = await Promise.all(
        input.aliases.map(
          ({ normalizedPath }) => repository.resolveProject(input.machineId, normalizedPath),
        ),
      );
    } catch {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL project rebind commit outcome is unknown and readback failed",
        `Inspect \`lcm project list --json\`, then rerun \`lcm project link ${input.projectId} ${input.recoveryPath}\`.`,
      );
    }
    if (resolved.every((owner) => owner?.projectId === input.projectId)) {
      return error.candidate;
    }
    if (resolved.every((owner, index) => {
      const prior = error.candidate.prior[index];
      return prior
        ? owner?.projectId === prior.projectId
        : owner === null;
    })) {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL retained the prior alias owners after the uncertain project rebind",
        `Rerun \`lcm project link ${input.projectId} ${input.recoveryPath}\`; the operation is safe to retry.`,
      );
    }
    throw new ProjectIdentityReconciliationError(
      "PostgreSQL alias ownership diverged during the uncertain project rebind",
      "Inspect `lcm project list --json` and reconcile every local project path explicitly.",
    );
  }
}

async function restoreRemoteBatchReplacement(
  repository: IdentityRepository,
  machineId: string,
  currentProjectId: string,
  mutation: RemoteAliasBatchMutation,
  aliases: readonly RemoteProjectAliasInput[],
): Promise<boolean> {
  try {
    return await repository.restoreProjectAliasBatch(
      machineId,
      currentProjectId,
      mutation.prior,
      aliases,
    );
  } catch (error) {
    if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
    try {
      const owners = await Promise.all(
        aliases.map(
          ({ normalizedPath }) => repository.resolveProject(machineId, normalizedPath),
        ),
      );
      return owners.every((owner, index) => {
        const prior = mutation.prior[index];
        return prior
          ? owner?.projectId === prior.projectId
          : owner === null;
      });
    } catch {
      return false;
    }
  }
}

async function confirmRemoteAliasUnlink(
  repository: IdentityRepository,
  machineId: string,
  normalizedPath: string,
  expectedProjectId: string,
  path: string,
): Promise<RemoteAliasOwnership | null> {
  try {
    return await repository.unlinkProjectAliasIfOwned(
      machineId,
      normalizedPath,
      expectedProjectId,
    );
  } catch (error) {
    if (!(error instanceof PostgreSqlIdentityUnlinkPathOutcomeUnknownError)) throw error;
    let resolved: RemoteAliasOwnership | null;
    try {
      resolved = await repository.resolveProject(machineId, normalizedPath);
    } catch {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL alias unlink commit outcome is unknown and readback failed",
        `Inspect \`lcm project list --json\`, then rerun \`lcm project unlink ${path}\`.`,
      );
    }
    if (!resolved) return error.candidate;
    if (resolved.projectId === expectedProjectId) {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL retained the alias after the uncertain unlink",
        `Rerun \`lcm project unlink ${path}\`; the operation is safe to retry.`,
      );
    }
    throw new ProjectIdentityReconciliationError(
      `PostgreSQL alias ownership changed to project ${resolved.projectId} during unlink`,
      "Inspect `lcm project list --json` and reconcile the path explicitly.",
    );
  }
}

async function confirmRemoteProjectAliasesUnlink(
  repository: IdentityRepository,
  machineId: string,
  projectId: string,
  canonicalPath: string,
  aliases: readonly RemoteProjectAliasInput[],
): Promise<RemoteProjectAlias[]> {
  try {
    const removed = await repository.unlinkProjectAliasesIfOwned(
      machineId,
      projectId,
      aliases,
    );
    if (removed) return removed;
    throw new ProjectIdentityReconciliationError(
      "PostgreSQL alias ownership changed before the authorized project unlink",
      "Inspect `lcm project list --json` and reconcile every local project path explicitly.",
    );
  } catch (error) {
    if (!(error instanceof PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError)) throw error;
    try {
      const owners = await Promise.all(
        aliases.map(
          ({ normalizedPath }) => repository.resolveProject(machineId, normalizedPath),
        ),
      );
      if (owners.every((owner) => owner === null)) return [...error.aliases];
      const removedPaths = new Set(error.aliases.map(({ normalizedPath }) => normalizedPath));
      if (owners.every((owner, index) => (
        removedPaths.has(aliases[index].normalizedPath)
          ? owner?.projectId === projectId
          : owner === null
      ))) {
        throw new ProjectIdentityReconciliationError(
          "PostgreSQL retained the local project aliases after the uncertain unlink",
          `Rerun \`lcm project unlink ${canonicalPath}\`; the operation is safe to retry.`,
        );
      }
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL alias ownership diverged during the uncertain project unlink",
        "Inspect `lcm project list --json` and reconcile every local project path explicitly.",
      );
    } catch (readbackError) {
      if (readbackError instanceof ProjectIdentityReconciliationError) throw readbackError;
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL project unlink commit outcome is unknown and readback failed",
        `Inspect \`lcm project list --json\`, then rerun \`lcm project unlink ${canonicalPath}\`.`,
      );
    }
  }
}

async function restoreRemoteUnlinkedAliases(
  repository: IdentityRepository,
  machineId: string,
  projectId: string,
  aliases: readonly RemoteProjectAlias[],
): Promise<boolean> {
  try {
    return await repository.restoreProjectAliases(machineId, projectId, aliases);
  } catch (error) {
    if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
    try {
      const owners = await Promise.all(
        aliases.map(
          (alias) => repository.resolveProject(machineId, alias.normalizedPath),
        ),
      );
      return owners.every((owner) => owner?.projectId === projectId);
    } catch {
      return false;
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
  requirePostgreSqlConfig(config);
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
    const entryPaths = remoteEntryPaths(showProjectMapEntry(local.id).entry);
    const mutation = await confirmRemoteBatchReplacement(repository, {
      machineId: machine.machineId,
      ...(local.remoteProjectId && local.remoteProjectId !== remoteProjectId
        ? { expectedPriorProjectId: local.remoteProjectId }
        : {}),
      projectId: remoteProjectId,
      aliases: entryPaths,
      recoveryPath: projectPath,
    });
    const remoteAlias = mutation.aliases.find(
      (alias) => alias.normalizedPath === path.normalizedPath,
    );
    if (!remoteAlias) {
      throw new ProjectIdentityReconciliationError(
        "PostgreSQL binding did not return the selected local project path",
        "Inspect `lcm project list --json` and reconcile every local project path explicitly.",
      );
    }
    try {
      setRemoteProjectBinding(remoteProjectId, {
        hash: local.id,
        allowExistingData: options.allowExistingData,
      });
    } catch (error) {
      let restored = false;
      try {
        restored = await restoreRemoteBatchReplacement(
          repository,
          machine.machineId,
          remoteProjectId,
          mutation,
          entryPaths,
        );
      } catch {
        // The reconciliation error below preserves one recovery contract.
      }
      if (!restored) {
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
  requirePostgreSqlConfig(config);
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
          await confirmRemoteAliasUnlink(
            repository,
            machine.machineId,
            alias.normalizedPath,
            shown.entry.remoteProjectId!,
            aliasPath,
          );
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
    requirePostgreSqlConfig(config);
    const deps = dependencies(dependencyOverrides);
    const machine = requireMachineIdentity(deps.homeDir);
    return withSession(config, deps, async (repository) => {
      const entryPaths = remoteEntryPaths(shown.entry);
      const removed = await confirmRemoteProjectAliasesUnlink(
        repository,
        machine.machineId,
        shown.entry.remoteProjectId!,
        shown.entry.canonical,
        entryPaths,
      );
      try {
        clearRemoteProjectBinding(shown.hash);
      } catch (error) {
        try {
          const restored = await restoreRemoteUnlinkedAliases(
            repository,
            machine.machineId,
            shown.entry.remoteProjectId!,
            removed,
          );
          if (!restored) throw new Error("PostgreSQL aliases changed during restoration");
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
    return {
      hash: shown.hash,
      aliasRemoved: true,
    };
  }
  requirePostgreSqlConfig(config);
  const deps = dependencies(dependencyOverrides);
  const machine = requireMachineIdentity(deps.homeDir);
  return withSession(config, deps, async (repository) => {
    const removed = await confirmRemoteAliasUnlink(
      repository,
      machine.machineId,
      remotePath(aliasPath).normalizedPath,
      shown.entry.remoteProjectId!,
      aliasPath,
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
