import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

export interface PostgreSqlIdentityExecutor extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    options: { domain: "identity"; operation: string; projectId?: string; signal?: AbortSignal },
  ): Promise<T>;
}

export interface RegisteredMachine {
  readonly machineId: string;
  readonly identityKey: string;
  readonly displayName: string;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface RemoteProjectAlias {
  readonly machineId: string;
  readonly path: string;
  readonly normalizedPath: string;
  readonly linkedAt: string;
}

export interface RemoteProject {
  readonly projectId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly aliases: readonly RemoteProjectAlias[];
}

export interface RemoteAliasOwnership {
  readonly projectId: string;
  readonly alias: RemoteProjectAlias;
}

export interface RemoteProjectAliasInput {
  readonly path: string;
  readonly normalizedPath: string;
}

export interface RemoteProjectAliasMutation {
  readonly alias: RemoteProjectAlias;
  /**
   * True only when this transaction inserted the alias. A same-project alias
   * returned after an ON CONFLICT race is shared state and is not owned by
   * this invocation for compensation.
   */
  readonly inserted: boolean;
}

export interface RemoteAliasBatchMutation {
  readonly aliases: readonly RemoteProjectAlias[];
  readonly prior: readonly (RemoteAliasOwnership | null)[];
  /**
   * True only when this transaction inserted the aligned alias. An absent
   * prior snapshot can still be followed by a concurrent same-project winner.
   */
  readonly inserted: readonly boolean[];
}

type MachineRow = QueryResultRow & {
  machine_id: string;
  identity_key: string;
  display_name: string | null;
  registered_at: Date | string;
  last_seen_at: Date | string;
};

type ProjectRow = QueryResultRow & {
  project_id: string;
  display_name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type AliasRow = QueryResultRow & {
  project_id: string;
  machine_id: string;
  path: string;
  normalized_path: string;
  linked_at: Date | string;
};

type ProjectAliasJoinRow = ProjectRow & {
  machine_id: string | null;
  path: string | null;
  normalized_path: string | null;
  linked_at: Date | string | null;
};

export class PostgreSqlIdentityConflictError extends StorageOperationError {
  constructor(
    readonly machineId: string,
    readonly normalizedPath: string,
    readonly existingProjectId: string,
    readonly requestedProjectId: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      requestedProjectId,
      "identity",
      "linkProject",
    );
    this.name = "PostgreSqlIdentityConflictError";
    this.message =
      `path ${normalizedPath} on machine ${machineId} is already linked to project ${existingProjectId}; refusing to redirect it to ${requestedProjectId}`;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      machineId: this.machineId,
      normalizedPath: this.normalizedPath,
      existingProjectId: this.existingProjectId,
      requestedProjectId: this.requestedProjectId,
    };
  }
}

export class PostgreSqlIdentityNotFoundError extends StorageOperationError {
  constructor(
    readonly identityType: "machine" | "project",
    readonly identityId: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      identityType === "project" ? identityId : undefined,
      "identity",
      identityType === "machine" ? "recoverMachine" : "requireProject",
    );
    this.name = "PostgreSqlIdentityNotFoundError";
    this.message = `${identityType} ${identityId} was not found in PostgreSQL`;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      identityType: this.identityType,
      identityId: this.identityId,
    };
  }
}

export class PostgreSqlIdentityRegistrationError extends StorageOperationError {
  constructor() {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      undefined,
      "identity",
      "registerMachine",
    );
    this.name = "PostgreSqlIdentityRegistrationError";
    this.message = "PostgreSQL machine registration did not return an identity";
  }
}

export class PostgreSqlIdentityCreateOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(readonly candidate: RemoteProject) {
    super({
      domain: "identity",
      operation: "createProject",
      projectId: candidate.projectId,
    });
    this.name = "PostgreSqlIdentityCreateOutcomeUnknownError";
  }
}

export class PostgreSqlIdentityLinkOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(
    readonly projectIdCandidate: string,
    readonly candidate: RemoteProjectAliasMutation,
  ) {
    super({
      domain: "identity",
      operation: "linkProject",
      projectId: projectIdCandidate,
    });
    this.name = "PostgreSqlIdentityLinkOutcomeUnknownError";
  }
}

export class PostgreSqlIdentityUnlinkPathOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(
    readonly candidate: RemoteAliasOwnership | null,
    operation: "unlinkPath" | "unlinkProjectAliasIfOwned" = "unlinkPath",
  ) {
    super({
      domain: "identity",
      operation,
      projectId: candidate?.projectId,
    });
    this.name = "PostgreSqlIdentityUnlinkPathOutcomeUnknownError";
  }
}

export class PostgreSqlIdentityUnlinkProjectOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(
    readonly projectIdCandidate: string,
    readonly aliases: readonly RemoteProjectAlias[],
  ) {
    super({
      domain: "identity",
      operation: "unlinkProject",
      projectId: projectIdCandidate,
    });
    this.name = "PostgreSqlIdentityUnlinkProjectOutcomeUnknownError";
  }
}

export class PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(
    readonly projectIdCandidate: string,
    readonly aliases: readonly RemoteProjectAlias[],
  ) {
    super({
      domain: "identity",
      operation: "unlinkProjectAliasesIfOwned",
      projectId: projectIdCandidate,
    });
    this.name = "PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError";
  }
}

export class PostgreSqlIdentityReplaceAliasesOutcomeUnknownError
  extends PostgreSqlCommitOutcomeUnknownError {
  constructor(
    readonly projectIdCandidate: string,
    readonly candidate: RemoteAliasBatchMutation,
  ) {
    super({
      domain: "identity",
      operation: "replaceProjectAliases",
      projectId: projectIdCandidate,
    });
    this.name = "PostgreSqlIdentityReplaceAliasesOutcomeUnknownError";
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function validatedProjectDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("project display name must not be blank");
  if (normalized.length > 256) throw new Error("project display name must be at most 256 characters");
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("project display name must not contain control characters");
  }
  return normalized;
}

function machineFromRow(row: MachineRow): RegisteredMachine {
  return {
    machineId: row.machine_id,
    identityKey: row.identity_key,
    displayName: row.display_name ?? `Machine ${row.machine_id}`,
    registeredAt: iso(row.registered_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function aliasFromRow(row: AliasRow): RemoteProjectAlias {
  return {
    machineId: row.machine_id,
    path: row.path,
    normalizedPath: row.normalized_path,
    linkedAt: iso(row.linked_at),
  };
}

class PostgreSqlIdentityBatchConflictMarker extends StorageOperationError {
  constructor(projectId: string) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "identity",
      "replaceProjectAliases",
    );
    this.name = "PostgreSqlIdentityBatchConflictMarker";
  }
}

export class PostgreSqlIdentityRepository {
  constructor(private readonly executor: PostgreSqlIdentityExecutor) {}

  async registerMachine(identityKey: string, displayName: string): Promise<RegisteredMachine> {
    const result = await this.executor.query<MachineRow>({
      text: `INSERT INTO lcm.machines (identity_key, display_name)
             VALUES ($1, $2)
             ON CONFLICT (identity_key) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 last_seen_at = statement_timestamp()
             RETURNING machine_id, identity_key, display_name,
                       registered_at, last_seen_at`,
      values: [identityKey, displayName],
    }, { domain: "identity", operation: "registerMachine" });
    const row = result.rows[0];
    if (!row) throw new PostgreSqlIdentityRegistrationError();
    return machineFromRow(row);
  }

  async recoverMachine(machineId: string): Promise<RegisteredMachine> {
    const result = await this.executor.query<MachineRow>({
      text: `SELECT machine_id, identity_key, display_name,
                    registered_at, last_seen_at
             FROM lcm.machines
             WHERE machine_id = $1`,
      values: [machineId],
    }, { domain: "identity", operation: "recoverMachine" });
    const row = result.rows[0];
    if (!row) throw new PostgreSqlIdentityNotFoundError("machine", machineId);
    return machineFromRow(row);
  }

  async createProject(input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly path: string;
    readonly normalizedPath: string;
    readonly aliases?: readonly RemoteProjectAliasInput[];
  }): Promise<RemoteProject> {
    const displayName = validatedProjectDisplayName(input.displayName);
    let candidate: RemoteProject | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const created = await transaction.query<ProjectRow>({
          text: `INSERT INTO lcm.projects (display_name)
                 VALUES ($1)
                 RETURNING project_id, display_name, created_at, updated_at`,
          values: [displayName],
        }, { domain: "identity", operation: "createProject" });
        const row = created.rows[0];
        if (!row) throw new PostgreSqlIdentityNotFoundError("project", displayName);
        const aliasInputs = input.aliases ?? [{
          path: input.path,
          normalizedPath: input.normalizedPath,
        }];
        const aliases: RemoteProjectAlias[] = [];
        for (const aliasInput of aliasInputs) {
          aliases.push((await this.linkWithExecutor(transaction, {
            machineId: input.machineId,
            projectId: row.project_id,
            ...aliasInput,
          })).alias);
        }
        candidate = {
          projectId: row.project_id,
          displayName: row.display_name,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          aliases,
        };
        return candidate;
      }, { domain: "identity", operation: "createProject" });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        throw new PostgreSqlIdentityCreateOutcomeUnknownError(candidate);
      }
      throw error;
    }
  }

  async replaceProjectAlias(input: {
    readonly machineId: string;
    readonly expectedPriorProjectId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias | null> {
    return this.executor.transaction(async (transaction) => {
      const project = await transaction.query<{ project_id: string }>({
        text: "SELECT project_id FROM lcm.projects WHERE project_id = $1",
        values: [input.projectId],
      }, { domain: "identity", operation: "requireProject", projectId: input.projectId });
      if (!project.rows[0]) {
        throw new PostgreSqlIdentityNotFoundError("project", input.projectId);
      }
      const replaced = await transaction.query<AliasRow>({
        text: `UPDATE lcm.project_aliases
               SET project_id = $1,
                   path = $2,
                   linked_at = statement_timestamp()
               WHERE machine_id = $3
                 AND normalized_path = $4
                 AND project_id = $5
               RETURNING project_id, machine_id, path, normalized_path, linked_at`,
        values: [
          input.projectId,
          input.path,
          input.machineId,
          input.normalizedPath,
          input.expectedPriorProjectId,
        ],
      }, { domain: "identity", operation: "replaceProjectAlias", projectId: input.projectId });
      const row = replaced.rows[0];
      return row ? aliasFromRow(row) : null;
    }, { domain: "identity", operation: "replaceProjectAlias", projectId: input.projectId });
  }

  async replaceProjectAliases(input: {
    readonly machineId: string;
    readonly expectedPriorProjectId?: string;
    readonly projectId: string;
    readonly aliases: readonly RemoteProjectAliasInput[];
  }): Promise<RemoteAliasBatchMutation | null> {
    let candidate: RemoteAliasBatchMutation | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const project = await transaction.query<{ project_id: string }>({
          text: "SELECT project_id FROM lcm.projects WHERE project_id = $1",
          values: [input.projectId],
        }, { domain: "identity", operation: "requireProject", projectId: input.projectId });
        if (!project.rows[0]) {
          throw new PostgreSqlIdentityNotFoundError("project", input.projectId);
        }
        const normalizedPaths = input.aliases.map(({ normalizedPath }) => normalizedPath);
        const current = await transaction.query<AliasRow>({
          text: `SELECT project_id, machine_id, path, normalized_path, linked_at
                 FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND normalized_path = ANY($2::text[])
                 FOR UPDATE`,
          values: [input.machineId, normalizedPaths],
        }, { domain: "identity", operation: "replaceProjectAliases", projectId: input.projectId });
        if (current.rows.some((row) => (
          row.project_id !== input.projectId
          && row.project_id !== input.expectedPriorProjectId
        ))) {
          return null;
        }
        const currentByPath = new Map(current.rows.map((row) => [row.normalized_path, row]));
        const prior = input.aliases.map(({ normalizedPath }) => {
          const row = currentByPath.get(normalizedPath);
          return row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
        });
        const inserted = input.aliases.map(() => false);
        for (const [index, alias] of input.aliases.entries()) {
          const row = currentByPath.get(alias.normalizedPath);
          if (row?.project_id === input.expectedPriorProjectId) {
            await transaction.query({
              text: `UPDATE lcm.project_aliases
                     SET project_id = $1,
                         path = $2,
                         linked_at = statement_timestamp()
                     WHERE machine_id = $3
                       AND normalized_path = $4
                       AND project_id = $5`,
              values: [
                input.projectId,
                alias.path,
                input.machineId,
                alias.normalizedPath,
                input.expectedPriorProjectId,
              ],
            }, { domain: "identity", operation: "replaceProjectAliases", projectId: input.projectId });
          } else if (!row) {
            const created = await transaction.query<AliasRow>({
              text: `INSERT INTO lcm.project_aliases
                       (project_id, machine_id, path, normalized_path)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (machine_id, normalized_path) DO NOTHING
                     RETURNING project_id, machine_id, path, normalized_path, linked_at`,
              values: [input.projectId, input.machineId, alias.path, alias.normalizedPath],
            }, { domain: "identity", operation: "replaceProjectAliases", projectId: input.projectId });
            inserted[index] = created.rows.length === 1;
          }
        }
        const final = await transaction.query<AliasRow>({
          text: `SELECT project_id, machine_id, path, normalized_path, linked_at
                 FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND normalized_path = ANY($2::text[])
                 FOR UPDATE`,
          values: [input.machineId, normalizedPaths],
        }, { domain: "identity", operation: "replaceProjectAliases", projectId: input.projectId });
        const finalByPath = new Map(final.rows.map((row) => [row.normalized_path, row]));
        if (
          final.rows.length !== input.aliases.length
          || final.rows.some((row) => row.project_id !== input.projectId)
        ) {
          throw new PostgreSqlIdentityBatchConflictMarker(input.projectId);
        }
        candidate = {
          aliases: input.aliases.map(
            ({ normalizedPath }) => aliasFromRow(finalByPath.get(normalizedPath)!),
          ),
          prior,
          inserted,
        };
        return candidate;
      }, { domain: "identity", operation: "replaceProjectAliases", projectId: input.projectId });
    } catch (error) {
      if (error instanceof PostgreSqlIdentityBatchConflictMarker) return null;
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        throw new PostgreSqlIdentityReplaceAliasesOutcomeUnknownError(input.projectId, candidate);
      }
      throw error;
    }
  }

  async linkProject(input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias> {
    return (await this.linkProjectWithOwnership(input)).alias;
  }

  async linkProjectWithOwnership(input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAliasMutation> {
    let candidate: RemoteProjectAliasMutation | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        candidate = await this.linkWithExecutor(transaction, input);
        return candidate;
      }, { domain: "identity", operation: "linkProject", projectId: input.projectId });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        throw new PostgreSqlIdentityLinkOutcomeUnknownError(input.projectId, candidate);
      }
      throw error;
    }
  }

  private async linkWithExecutor(
    executor: PostgreSqlQueryExecutor,
    input: {
      readonly machineId: string;
      readonly projectId: string;
      readonly path: string;
      readonly normalizedPath: string;
    },
  ): Promise<RemoteProjectAliasMutation> {
    const project = await executor.query<{ project_id: string }>({
      text: "SELECT project_id FROM lcm.projects WHERE project_id = $1",
      values: [input.projectId],
    }, { domain: "identity", operation: "requireProject", projectId: input.projectId });
    if (!project.rows[0]) {
      throw new PostgreSqlIdentityNotFoundError("project", input.projectId);
    }
    const inserted = await executor.query<AliasRow>({
      text: `INSERT INTO lcm.project_aliases
               (project_id, machine_id, path, normalized_path)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (machine_id, normalized_path) DO NOTHING
             RETURNING project_id, machine_id, path, normalized_path, linked_at`,
      values: [input.projectId, input.machineId, input.path, input.normalizedPath],
    }, { domain: "identity", operation: "linkProject", projectId: input.projectId });
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return {
        alias: aliasFromRow(insertedRow),
        inserted: true,
      };
    }
    const existing = await executor.query<AliasRow>({
      text: `SELECT project_id, machine_id, path, normalized_path, linked_at
             FROM lcm.project_aliases
             WHERE machine_id = $1 AND normalized_path = $2`,
      values: [input.machineId, input.normalizedPath],
    }, { domain: "identity", operation: "resolveAlias", projectId: input.projectId });
    const row = existing.rows[0];
    if (!row) {
      throw new PostgreSqlIdentityNotFoundError("project", input.projectId);
    }
    if (row.project_id !== input.projectId) {
      throw new PostgreSqlIdentityConflictError(
        input.machineId,
        input.normalizedPath,
        row.project_id,
        input.projectId,
      );
    }
    return {
      alias: aliasFromRow(row),
      inserted: false,
    };
  }

  async unlinkPath(
    machineId: string,
    normalizedPath: string,
  ): Promise<RemoteAliasOwnership | null> {
    let candidate: RemoteAliasOwnership | null | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const result = await transaction.query<AliasRow>({
          text: `DELETE FROM lcm.project_aliases
                 WHERE machine_id = $1 AND normalized_path = $2
                 RETURNING project_id, machine_id, path, normalized_path, linked_at`,
          values: [machineId, normalizedPath],
        }, { domain: "identity", operation: "unlinkPath" });
        const row = result.rows[0];
        candidate = row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
        return candidate;
      }, { domain: "identity", operation: "unlinkPath" });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate !== undefined) {
        throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError(candidate);
      }
      throw error;
    }
  }

  async unlinkProjectAliasIfOwned(
    machineId: string,
    normalizedPath: string,
    projectId: string,
  ): Promise<RemoteAliasOwnership | null> {
    let candidate: RemoteAliasOwnership | null | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const result = await transaction.query<AliasRow>({
          text: `DELETE FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND normalized_path = $2
                   AND project_id = $3
                 RETURNING project_id, machine_id, path, normalized_path, linked_at`,
          values: [machineId, normalizedPath, projectId],
        }, { domain: "identity", operation: "unlinkProjectAliasIfOwned", projectId });
        const row = result.rows[0];
        candidate = row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
        return candidate;
      }, { domain: "identity", operation: "unlinkProjectAliasIfOwned", projectId });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate !== undefined) {
        throw new PostgreSqlIdentityUnlinkPathOutcomeUnknownError(
          candidate,
          "unlinkProjectAliasIfOwned",
        );
      }
      throw error;
    }
  }

  async unlinkProjectAliasesIfOwned(
    machineId: string,
    projectId: string,
    aliases: readonly RemoteProjectAliasInput[],
  ): Promise<RemoteProjectAlias[] | null> {
    let candidate: RemoteProjectAlias[] | null | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const normalizedPaths = aliases.map(({ normalizedPath }) => normalizedPath);
        const current = await transaction.query<AliasRow>({
          text: `SELECT project_id, machine_id, path, normalized_path, linked_at
                 FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND normalized_path = ANY($2::text[])
                 FOR UPDATE`,
          values: [machineId, normalizedPaths],
        }, { domain: "identity", operation: "unlinkProjectAliasesIfOwned", projectId });
        if (current.rows.some((row) => row.project_id !== projectId)) {
          candidate = null;
          return null;
        }
        const removed = await transaction.query<AliasRow>({
          text: `DELETE FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND project_id = $2
                   AND normalized_path = ANY($3::text[])
                 RETURNING project_id, machine_id, path, normalized_path, linked_at`,
          values: [machineId, projectId, normalizedPaths],
        }, { domain: "identity", operation: "unlinkProjectAliasesIfOwned", projectId });
        candidate = removed.rows.map(aliasFromRow);
        return candidate;
      }, { domain: "identity", operation: "unlinkProjectAliasesIfOwned", projectId });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate !== undefined) {
        throw new PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError(
          projectId,
          candidate ?? [],
        );
      }
      throw error;
    }
  }

  async restoreProjectAliases(
    machineId: string,
    projectId: string,
    aliases: readonly RemoteProjectAlias[],
  ): Promise<boolean> {
    return this.executor.transaction(async (transaction) => {
      const normalizedPaths = aliases.map((alias) => alias.normalizedPath);
      const current = await transaction.query<AliasRow>({
        text: `SELECT project_id, machine_id, path, normalized_path, linked_at
               FROM lcm.project_aliases
               WHERE machine_id = $1
                 AND normalized_path = ANY($2::text[])
               FOR UPDATE`,
        values: [machineId, normalizedPaths],
      }, { domain: "identity", operation: "restoreProjectAliases", projectId });
      if (current.rows.length > 0) return false;
      for (const alias of aliases) {
        await this.linkWithExecutor(transaction, {
          machineId,
          projectId,
          path: alias.path,
          normalizedPath: alias.normalizedPath,
        });
      }
      return true;
    }, { domain: "identity", operation: "restoreProjectAliases", projectId });
  }

  async restoreProjectAliasBatch(
    machineId: string,
    currentProjectId: string,
    prior: readonly (RemoteAliasOwnership | null)[],
    inserted: readonly boolean[],
    aliases: readonly RemoteProjectAliasInput[],
  ): Promise<boolean> {
    return this.executor.transaction(async (transaction) => {
      const normalizedPaths = aliases.map(({ normalizedPath }) => normalizedPath);
      const current = await transaction.query<AliasRow>({
        text: `SELECT project_id, machine_id, path, normalized_path, linked_at
               FROM lcm.project_aliases
               WHERE machine_id = $1
                 AND normalized_path = ANY($2::text[])
               FOR UPDATE`,
        values: [machineId, normalizedPaths],
      }, { domain: "identity", operation: "restoreProjectAliasBatch", projectId: currentProjectId });
      if (
        current.rows.length !== aliases.length
        || current.rows.some((row) => row.project_id !== currentProjectId)
      ) {
        return false;
      }
      for (const [index, alias] of aliases.entries()) {
        const previous = prior[index];
        if (!previous && inserted[index]) {
          await transaction.query({
            text: `DELETE FROM lcm.project_aliases
                   WHERE machine_id = $1
                     AND normalized_path = $2
                     AND project_id = $3`,
            values: [machineId, alias.normalizedPath, currentProjectId],
          }, { domain: "identity", operation: "restoreProjectAliasBatch", projectId: currentProjectId });
        } else if (previous && previous.projectId !== currentProjectId) {
          await transaction.query({
            text: `UPDATE lcm.project_aliases
                   SET project_id = $1,
                       path = $2,
                       linked_at = statement_timestamp()
                   WHERE machine_id = $3
                     AND normalized_path = $4
                     AND project_id = $5`,
            values: [
              previous.projectId,
              previous.alias.path,
              machineId,
              alias.normalizedPath,
              currentProjectId,
            ],
          }, { domain: "identity", operation: "restoreProjectAliasBatch", projectId: currentProjectId });
        }
      }
      return true;
    }, { domain: "identity", operation: "restoreProjectAliasBatch", projectId: currentProjectId });
  }

  /**
   * Restore a path after a coordinated local write fails. The comparison and
   * replacement share one transaction so a concurrent owner is never deleted.
   */
  async restoreProjectAlias(input: {
    readonly machineId: string;
    readonly normalizedPath: string;
    readonly currentProjectId: string;
    readonly prior: RemoteAliasOwnership | null;
  }): Promise<boolean> {
    return this.executor.transaction(async (transaction) => {
      const current = await transaction.query<AliasRow>({
        text: `SELECT project_id, machine_id, path, normalized_path, linked_at
               FROM lcm.project_aliases
               WHERE machine_id = $1 AND normalized_path = $2
               FOR UPDATE`,
        values: [input.machineId, input.normalizedPath],
      }, {
        domain: "identity",
        operation: "restoreProjectAlias",
        projectId: input.currentProjectId,
      });
      const currentRow = current.rows[0];
      if (currentRow && currentRow.project_id !== input.currentProjectId) return false;
      if (currentRow) {
        await transaction.query({
          text: `DELETE FROM lcm.project_aliases
                 WHERE machine_id = $1
                   AND normalized_path = $2
                   AND project_id = $3`,
          values: [input.machineId, input.normalizedPath, input.currentProjectId],
        }, {
          domain: "identity",
          operation: "restoreProjectAlias",
          projectId: input.currentProjectId,
        });
      }
      if (input.prior) {
        await this.linkWithExecutor(transaction, {
          machineId: input.machineId,
          projectId: input.prior.projectId,
          path: input.prior.alias.path,
          normalizedPath: input.prior.alias.normalizedPath,
        });
      }
      return true;
    }, {
      domain: "identity",
      operation: "restoreProjectAlias",
      projectId: input.currentProjectId,
    });
  }

  async unlinkProject(machineId: string, projectId: string): Promise<RemoteProjectAlias[]> {
    let candidate: RemoteProjectAlias[] | undefined;
    try {
      return await this.executor.transaction(async (transaction) => {
        const result = await transaction.query<AliasRow>({
          text: `DELETE FROM lcm.project_aliases
                 WHERE machine_id = $1 AND project_id = $2
                 RETURNING project_id, machine_id, path, normalized_path, linked_at`,
          values: [machineId, projectId],
        }, { domain: "identity", operation: "unlinkProject", projectId });
        candidate = result.rows.map(aliasFromRow);
        return candidate;
      }, { domain: "identity", operation: "unlinkProject", projectId });
    } catch (error) {
      if (error instanceof PostgreSqlCommitOutcomeUnknownError && candidate) {
        throw new PostgreSqlIdentityUnlinkProjectOutcomeUnknownError(projectId, candidate);
      }
      throw error;
    }
  }

  async deleteProjectIfUnreferenced(projectId: string): Promise<boolean> {
    const result = await this.executor.query<{ project_id: string }>({
      text: `DELETE FROM lcm.projects AS project
             WHERE project.project_id = $1
               AND NOT EXISTS (
                 SELECT 1
                 FROM lcm.project_aliases AS alias
                 WHERE alias.project_id = project.project_id
               )
             RETURNING project_id`,
      values: [projectId],
    }, { domain: "identity", operation: "deleteEmptyProject", projectId });
    return result.rows.length === 1;
  }

  /** Remove this machine's aliases and the resulting empty project atomically. */
  async cleanupCreatedProject(
    machineId: string,
    projectId: string,
    normalizedPaths: readonly string[],
  ): Promise<boolean> {
    return this.executor.transaction(async (transaction) => {
      await transaction.query({
        text: `DELETE FROM lcm.project_aliases
               WHERE machine_id = $1
                 AND project_id = $2
                 AND normalized_path = ANY($3::text[])`,
        values: [machineId, projectId, [...normalizedPaths]],
      }, { domain: "identity", operation: "cleanupCreatedProject", projectId });
      const deleted = await transaction.query<{ project_id: string }>({
        text: `DELETE FROM lcm.projects AS project
               WHERE project.project_id = $1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM lcm.project_aliases AS alias
                   WHERE alias.project_id = project.project_id
                 )
               RETURNING project_id`,
        values: [projectId],
      }, { domain: "identity", operation: "cleanupCreatedProject", projectId });
      return deleted.rows.length === 1;
    }, { domain: "identity", operation: "cleanupCreatedProject", projectId });
  }

  async resolveProject(
    machineId: string,
    normalizedPath: string,
  ): Promise<RemoteAliasOwnership | null> {
    const result = await this.executor.query<AliasRow>({
      text: `SELECT project_id, machine_id, path, normalized_path, linked_at
             FROM lcm.project_aliases
             WHERE machine_id = $1 AND normalized_path = $2`,
      values: [machineId, normalizedPath],
    }, { domain: "identity", operation: "resolveProject" });
    const row = result.rows[0];
    return row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
  }

  async resolveProjectAliasesByPath(
    machineId: string,
    paths: readonly string[],
  ): Promise<RemoteAliasOwnership[]> {
    if (paths.length === 0) return [];
    const result = await this.executor.query<AliasRow>({
      text: `SELECT project_id, machine_id, path, normalized_path, linked_at
             FROM lcm.project_aliases
             WHERE machine_id = $1
               AND path = ANY($2::text[])
             ORDER BY path ASC, normalized_path ASC, project_id ASC`,
      values: [machineId, paths],
    }, { domain: "identity", operation: "resolveProjectAliasesByPath" });
    return result.rows.map((row) => ({
      projectId: row.project_id,
      alias: aliasFromRow(row),
    }));
  }

  async listProjects(): Promise<RemoteProject[]> {
    const joined = await this.executor.query<ProjectAliasJoinRow>({
      text: `SELECT project.project_id,
                    project.display_name,
                    project.created_at,
                    project.updated_at,
                    alias.machine_id,
                    alias.path,
                    alias.normalized_path,
                    alias.linked_at
             FROM lcm.projects AS project
             LEFT JOIN lcm.project_aliases AS alias
               ON alias.project_id = project.project_id
             ORDER BY project.created_at,
                      project.project_id,
                      alias.machine_id,
                      alias.normalized_path`,
    }, { domain: "identity", operation: "listProjects" });
    const projects: Array<Omit<RemoteProject, "aliases"> & {
      aliases: RemoteProjectAlias[];
    }> = [];
    for (const row of joined.rows) {
      let project = projects.at(-1);
      if (project?.projectId !== row.project_id) {
        project = {
          projectId: row.project_id,
          displayName: row.display_name,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          aliases: [],
        };
        projects.push(project);
      }
      if (
        row.machine_id !== null
        && row.path !== null
        && row.normalized_path !== null
        && row.linked_at !== null
      ) {
        project.aliases.push(aliasFromRow({
          ...row,
          machine_id: row.machine_id,
          path: row.path,
          normalized_path: row.normalized_path,
          linked_at: row.linked_at,
        }));
      }
    }
    return projects;
  }
}
