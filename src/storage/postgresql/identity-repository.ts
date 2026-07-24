import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";

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

type MachineRow = QueryResultRow & {
  machine_id: string;
  identity_key: string;
  display_name: string;
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function machineFromRow(row: MachineRow): RegisteredMachine {
  return {
    machineId: row.machine_id,
    identityKey: row.identity_key,
    displayName: row.display_name,
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
    if (!row) throw new PostgreSqlIdentityNotFoundError("machine", identityKey);
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
  }): Promise<RemoteProject> {
    return this.executor.transaction(async (transaction) => {
      const created = await transaction.query<ProjectRow>({
        text: `INSERT INTO lcm.projects (display_name)
               VALUES ($1)
               RETURNING project_id, display_name, created_at, updated_at`,
        values: [input.displayName],
      }, { domain: "identity", operation: "createProject" });
      const row = created.rows[0];
      if (!row) throw new PostgreSqlIdentityNotFoundError("project", input.displayName);
      const alias = await this.linkWithExecutor(transaction, {
        machineId: input.machineId,
        projectId: row.project_id,
        path: input.path,
        normalizedPath: input.normalizedPath,
      });
      return {
        projectId: row.project_id,
        displayName: row.display_name,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        aliases: [alias],
      };
    }, { domain: "identity", operation: "createProject" });
  }

  async linkProject(input: {
    readonly machineId: string;
    readonly projectId: string;
    readonly path: string;
    readonly normalizedPath: string;
  }): Promise<RemoteProjectAlias> {
    return this.executor.transaction(
      (transaction) => this.linkWithExecutor(transaction, input),
      { domain: "identity", operation: "linkProject", projectId: input.projectId },
    );
  }

  private async linkWithExecutor(
    executor: PostgreSqlQueryExecutor,
    input: {
      readonly machineId: string;
      readonly projectId: string;
      readonly path: string;
      readonly normalizedPath: string;
    },
  ): Promise<RemoteProjectAlias> {
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
    if (insertedRow) return aliasFromRow(insertedRow);
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
    return aliasFromRow(row);
  }

  async unlinkPath(
    machineId: string,
    normalizedPath: string,
  ): Promise<{ readonly projectId: string; readonly alias: RemoteProjectAlias } | null> {
    const result = await this.executor.query<AliasRow>({
      text: `DELETE FROM lcm.project_aliases
             WHERE machine_id = $1 AND normalized_path = $2
             RETURNING project_id, machine_id, path, normalized_path, linked_at`,
      values: [machineId, normalizedPath],
    }, { domain: "identity", operation: "unlinkPath" });
    const row = result.rows[0];
    return row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
  }

  async unlinkProject(machineId: string, projectId: string): Promise<RemoteProjectAlias[]> {
    const result = await this.executor.query<AliasRow>({
      text: `DELETE FROM lcm.project_aliases
             WHERE machine_id = $1 AND project_id = $2
             RETURNING project_id, machine_id, path, normalized_path, linked_at`,
      values: [machineId, projectId],
    }, { domain: "identity", operation: "unlinkProject", projectId });
    return result.rows.map(aliasFromRow);
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

  async resolveProject(
    machineId: string,
    normalizedPath: string,
  ): Promise<{ readonly projectId: string; readonly alias: RemoteProjectAlias } | null> {
    const result = await this.executor.query<AliasRow>({
      text: `SELECT project_id, machine_id, path, normalized_path, linked_at
             FROM lcm.project_aliases
             WHERE machine_id = $1 AND normalized_path = $2`,
      values: [machineId, normalizedPath],
    }, { domain: "identity", operation: "resolveProject" });
    const row = result.rows[0];
    return row ? { projectId: row.project_id, alias: aliasFromRow(row) } : null;
  }

  async listProjects(): Promise<RemoteProject[]> {
    const [projects, aliases] = await Promise.all([
      this.executor.query<ProjectRow>({
        text: `SELECT project_id, display_name, created_at, updated_at
               FROM lcm.projects
               ORDER BY created_at, project_id`,
      }, { domain: "identity", operation: "listProjects" }),
      this.executor.query<AliasRow>({
        text: `SELECT project_id, machine_id, path, normalized_path, linked_at
               FROM lcm.project_aliases
               ORDER BY project_id, machine_id, normalized_path`,
      }, { domain: "identity", operation: "listProjectAliases" }),
    ]);
    const aliasesByProject = new Map<string, RemoteProjectAlias[]>();
    for (const row of aliases.rows) {
      const collected = aliasesByProject.get(row.project_id) ?? [];
      collected.push(aliasFromRow(row));
      aliasesByProject.set(row.project_id, collected);
    }
    return projects.rows.map((row) => ({
      projectId: row.project_id,
      displayName: row.display_name,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      aliases: aliasesByProject.get(row.project_id) ?? [],
    }));
  }
}
