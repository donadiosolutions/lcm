import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlIdentityExecutor,
} from "../../src/storage/postgresql/identity-repository.js";
import {
  PostgreSqlIdentityCreateOutcomeUnknownError,
  PostgreSqlIdentityConflictError,
  PostgreSqlIdentityNotFoundError,
  PostgreSqlIdentityRepository,
  PostgreSqlIdentityUnlinkPathOutcomeUnknownError,
  PostgreSqlIdentityUnlinkProjectOutcomeUnknownError,
} from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";
import type {
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): PostgreSqlIdentityExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const transaction = vi.fn(async (
    callback: (transactionExecutor: PostgreSqlIdentityExecutor) => Promise<unknown>,
  ) => callback(identityExecutor));
  const identityExecutor = { query, transaction } as unknown as PostgreSqlIdentityExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return identityExecutor;
}

const machineRow = {
  machine_id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012",
  identity_key: `machine:${"a".repeat(64)}`,
  display_name: "Machine A",
  registered_at: new Date("2026-01-01T00:00:00Z"),
  last_seen_at: "2026-01-02T00:00:00.000Z",
};

const projectRow = {
  project_id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
  display_name: "Project A",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: "2026-01-01T00:00:00.000Z",
};

const aliasRow = {
  project_id: projectRow.project_id,
  machine_id: machineRow.machine_id,
  path: "/work/project",
  normalized_path: "/work/project",
  linked_at: new Date("2026-01-01T00:00:00Z"),
};

describe("PostgreSQL identity repository", () => {
  it("registers a machine idempotently with parameterized SQL", async () => {
    const db = executor(() => result([machineRow]));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.registerMachine(machineRow.identity_key, machineRow.display_name))
      .resolves.toEqual({
        machineId: machineRow.machine_id,
        identityKey: machineRow.identity_key,
        displayName: "Machine A",
        registeredAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      });
    expect(db.query.mock.calls[0][0]).toMatchObject({
      text: expect.stringContaining("ON CONFLICT (identity_key) DO UPDATE"),
      values: [machineRow.identity_key, "Machine A"],
    });
  });

  it("fails closed when registration returns no row", async () => {
    const repository = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(repository.registerMachine(machineRow.identity_key, "Machine A"))
      .rejects.toBeInstanceOf(PostgreSqlIdentityNotFoundError);
  });

  it("recovers an existing machine and rejects an unknown ID", async () => {
    const present = new PostgreSqlIdentityRepository(executor(() => result([machineRow])));
    await expect(present.recoverMachine(machineRow.machine_id))
      .resolves.toMatchObject({ machineId: machineRow.machine_id });

    const missing = new PostgreSqlIdentityRepository(executor(() => result([])));
    const missingError = await missing.recoverMachine("missing").catch((error: unknown) => error);
    expect(missingError).toMatchObject({ identityType: "machine", identityId: "missing" });
    expect((missingError as PostgreSqlIdentityNotFoundError).toJSON()).toMatchObject({
      identityType: "machine",
      identityId: "missing",
      domain: "identity",
    });
  });

  it("creates a project and its first alias in one transaction", async () => {
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.projects")) return result([projectRow]);
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result([aliasRow]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.createProject({
      machineId: machineRow.machine_id,
      displayName: "Project A",
      path: "/work/project",
      normalizedPath: "/work/project",
    })).resolves.toEqual({
      projectId: projectRow.project_id,
      displayName: "Project A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      aliases: [{
        machineId: machineRow.machine_id,
        path: "/work/project",
        normalizedPath: "/work/project",
        linkedAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "createProject",
    });
  });

  it("rejects a project insert that returns no identity", async () => {
    const repository = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(repository.createProject({
      machineId: machineRow.machine_id,
      displayName: "Project A",
      path: "/work/project",
      normalizedPath: "/work/project",
    })).rejects.toMatchObject({ identityType: "project" });
  });

  it("preserves the candidate UUID when a create COMMIT outcome is unknown", async () => {
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.projects")) return result([projectRow]);
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: projectRow.project_id }]);
      }
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result([aliasRow]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    db.transaction.mockImplementationOnce(async (callback) => {
      await callback(db);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "createProject",
      });
    });
    const repository = new PostgreSqlIdentityRepository(db);

    const error = await repository.createProject({
      machineId: machineRow.machine_id,
      displayName: "Project A",
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostgreSqlIdentityCreateOutcomeUnknownError);
    expect((error as PostgreSqlIdentityCreateOutcomeUnknownError).candidate)
      .toMatchObject({ projectId: projectRow.project_id });
  });

  it("links a new alias and treats the identical existing link as idempotent", async () => {
    let insertReturnsRow = true;
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      if (config.text.includes("INSERT INTO lcm.project_aliases")) {
        return result(insertReturnsRow ? [aliasRow] : []);
      }
      if (config.text.includes("FROM lcm.project_aliases")) return result([aliasRow]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);
    const input = {
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    };

    await expect(repository.linkProject(input)).resolves.toMatchObject({ path: aliasRow.path });
    insertReturnsRow = false;
    await expect(repository.linkProject(input)).resolves.toMatchObject({ path: aliasRow.path });
  });

  it("atomically replaces an alias only for the expected prior owner", async () => {
    let replaced = true;
    const replacementId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: replacementId }]);
      }
      if (config.text.includes("UPDATE lcm.project_aliases")) {
        return result(replaced ? [{ ...aliasRow, project_id: replacementId }] : []);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);
    const input = {
      machineId: machineRow.machine_id,
      expectedPriorProjectId: projectRow.project_id,
      projectId: replacementId,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    };

    await expect(repository.replaceProjectAlias(input))
      .resolves.toMatchObject({ normalizedPath: aliasRow.normalized_path });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "replaceProjectAlias",
      projectId: replacementId,
    });
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("AND project_id = $5"),
      values: [
        replacementId,
        aliasRow.path,
        machineRow.machine_id,
        aliasRow.normalized_path,
        projectRow.project_id,
      ],
    }), expect.any(Object));
    replaced = false;
    await expect(repository.replaceProjectAlias(input)).resolves.toBeNull();

    const missing = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(missing.replaceProjectAlias(input))
      .rejects.toBeInstanceOf(PostgreSqlIdentityNotFoundError);
  });

  it("rejects missing projects, collisions, and vanished conflicting rows", async () => {
    const missingProject = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(missingProject.linkProject({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    })).rejects.toMatchObject({ identityType: "project", identityId: projectRow.project_id });

    const otherProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const conflict = new PostgreSqlIdentityRepository(executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      if (config.text.includes("INSERT INTO")) return result([]);
      return result([{ ...aliasRow, project_id: otherProjectId }]);
    }));
    const conflictError = await conflict.linkProject({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    }).catch((error: unknown) => error);
    expect(conflictError).toBeInstanceOf(PostgreSqlIdentityConflictError);
    expect((conflictError as PostgreSqlIdentityConflictError).toJSON()).toMatchObject({
      existingProjectId: otherProjectId,
      requestedProjectId: projectRow.project_id,
      machineId: machineRow.machine_id,
      normalizedPath: aliasRow.normalized_path,
    });

    const vanished = new PostgreSqlIdentityRepository(executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      return result([]);
    }));
    await expect(vanished.linkProject({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    })).rejects.toMatchObject({ identityType: "project" });
  });

  it("unlinks paths and whole machine-project bindings", async () => {
    let rows: QueryResultRow[] = [aliasRow];
    const db = executor(() => result(rows));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.unlinkPath(machineRow.machine_id, aliasRow.normalized_path))
      .resolves.toMatchObject({ projectId: projectRow.project_id });
    rows = [];
    await expect(repository.unlinkPath(machineRow.machine_id, aliasRow.normalized_path))
      .resolves.toBeNull();
    rows = [aliasRow];
    await expect(repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    )).resolves.toMatchObject({ projectId: projectRow.project_id });
    expect(db.query).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("AND project_id = $3"),
      values: [machineRow.machine_id, aliasRow.normalized_path, projectRow.project_id],
    }), expect.objectContaining({ operation: "unlinkProjectAliasIfOwned" }));
    rows = [];
    await expect(repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    )).resolves.toBeNull();
    rows = [aliasRow, { ...aliasRow, path: "/alias", normalized_path: "/alias" }];
    await expect(repository.unlinkProject(machineRow.machine_id, projectRow.project_id))
      .resolves.toHaveLength(2);
  });

  it("preserves unlink snapshots when their COMMIT outcomes are unknown", async () => {
    const db = executor(() => result([aliasRow]));
    const ambiguous = async (
      callback: (transactionExecutor: PostgreSqlIdentityExecutor) => Promise<unknown>,
    ): Promise<never> => {
      await callback(db);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "unlink",
        projectId: projectRow.project_id,
      });
    };
    db.transaction.mockImplementation(ambiguous);
    const repository = new PostgreSqlIdentityRepository(db);

    const pathError = await repository.unlinkPath(
      machineRow.machine_id,
      aliasRow.normalized_path,
    ).catch((caught: unknown) => caught);
    expect(pathError).toBeInstanceOf(PostgreSqlIdentityUnlinkPathOutcomeUnknownError);
    expect((pathError as PostgreSqlIdentityUnlinkPathOutcomeUnknownError).candidate)
      .toMatchObject({ projectId: projectRow.project_id });

    const ownedError = await repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    ).catch((caught: unknown) => caught);
    expect(ownedError).toBeInstanceOf(PostgreSqlIdentityUnlinkPathOutcomeUnknownError);

    const projectError = await repository.unlinkProject(
      machineRow.machine_id,
      projectRow.project_id,
    ).catch((caught: unknown) => caught);
    expect(projectError).toBeInstanceOf(PostgreSqlIdentityUnlinkProjectOutcomeUnknownError);
    expect((projectError as PostgreSqlIdentityUnlinkProjectOutcomeUnknownError).aliases)
      .toEqual([expect.objectContaining({ normalizedPath: aliasRow.normalized_path })]);
  });

  it("rethrows unlink failures that occur before a candidate snapshot exists", async () => {
    const original = new Error("transaction did not start");
    const db = executor(() => result([]));
    db.transaction.mockRejectedValue(original);
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.unlinkPath(machineRow.machine_id, aliasRow.normalized_path))
      .rejects.toBe(original);
    await expect(repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    )).rejects.toBe(original);
    await expect(repository.unlinkProject(machineRow.machine_id, projectRow.project_id))
      .rejects.toBe(original);
  });

  it("restores aliases transactionally only while the expected project owns the path", async () => {
    const priorProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const priorAlias = {
      ...aliasRow,
      project_id: priorProjectId,
      path: "/work/original",
    };
    const db = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result([aliasRow]);
      if (config.text.includes("DELETE FROM lcm.project_aliases")) return result([]);
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: priorProjectId }]);
      }
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result([priorAlias]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.restoreProjectAlias({
      machineId: machineRow.machine_id,
      normalizedPath: aliasRow.normalized_path,
      currentProjectId: projectRow.project_id,
      prior: {
        projectId: priorProjectId,
        alias: {
          machineId: machineRow.machine_id,
          path: priorAlias.path,
          normalizedPath: priorAlias.normalized_path,
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).resolves.toBe(true);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "restoreProjectAlias",
      projectId: projectRow.project_id,
    });
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("AND project_id = $3"),
      values: [machineRow.machine_id, aliasRow.normalized_path, projectRow.project_id],
    }), expect.any(Object));

    const changed = new PostgreSqlIdentityRepository(executor((config) => {
      if (config.text.includes("FOR UPDATE")) {
        return result([{ ...aliasRow, project_id: priorProjectId }]);
      }
      throw new Error(`unexpected SQL after ownership change: ${config.text}`);
    }));
    await expect(changed.restoreProjectAlias({
      machineId: machineRow.machine_id,
      normalizedPath: aliasRow.normalized_path,
      currentProjectId: projectRow.project_id,
      prior: null,
    })).resolves.toBe(false);

    const absent = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(absent.restoreProjectAlias({
      machineId: machineRow.machine_id,
      normalizedPath: aliasRow.normalized_path,
      currentProjectId: projectRow.project_id,
      prior: null,
    })).resolves.toBe(true);
  });

  it("deletes only unreferenced projects", async () => {
    let rows: QueryResultRow[] = [{ project_id: projectRow.project_id }];
    const db = executor(() => result(rows));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.deleteProjectIfUnreferenced(projectRow.project_id)).resolves.toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("NOT EXISTS"),
      values: [projectRow.project_id],
    }), expect.objectContaining({ operation: "deleteEmptyProject" }));
    rows = [];
    await expect(repository.deleteProjectIfUnreferenced(projectRow.project_id)).resolves.toBe(false);
  });

  it("cleans up created aliases and their unreferenced project in one transaction", async () => {
    let deleteProject = true;
    const db = executor((config) => {
      if (config.text.includes("DELETE FROM lcm.project_aliases")) return result([]);
      if (config.text.includes("DELETE FROM lcm.projects")) {
        return result(deleteProject ? [{ project_id: projectRow.project_id }] : []);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.cleanupCreatedProject(
      machineRow.machine_id,
      projectRow.project_id,
      aliasRow.normalized_path,
    )).resolves.toBe(true);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "cleanupCreatedProject",
      projectId: projectRow.project_id,
    });
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("AND normalized_path = $3"),
      values: [
        machineRow.machine_id,
        projectRow.project_id,
        aliasRow.normalized_path,
      ],
    }), expect.any(Object));
    deleteProject = false;
    await expect(repository.cleanupCreatedProject(
      machineRow.machine_id,
      projectRow.project_id,
      aliasRow.normalized_path,
    )).resolves.toBe(false);
  });

  it("resolves path bindings or reports absence", async () => {
    let rows: QueryResultRow[] = [aliasRow];
    const repository = new PostgreSqlIdentityRepository(executor(() => result(rows)));
    await expect(repository.resolveProject(machineRow.machine_id, aliasRow.normalized_path))
      .resolves.toMatchObject({ projectId: projectRow.project_id });
    rows = [];
    await expect(repository.resolveProject(machineRow.machine_id, aliasRow.normalized_path))
      .resolves.toBeNull();
  });

  it("lists projects with deterministic grouped aliases", async () => {
    const secondProject = {
      ...projectRow,
      project_id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9022",
      display_name: "Project B",
    };
    const secondAlias = {
      ...aliasRow,
      path: "/work/project-alias",
      normalized_path: "/work/project-alias",
    };
    const db = executor(() => result([
      { ...projectRow, ...aliasRow },
      { ...projectRow, ...secondAlias },
      {
        ...secondProject,
        machine_id: null,
        path: null,
        normalized_path: null,
        linked_at: null,
      },
    ]));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: projectRow.project_id,
        aliases: [
          expect.objectContaining({ normalizedPath: aliasRow.normalized_path }),
          expect.objectContaining({ normalizedPath: secondAlias.normalized_path }),
        ],
      }),
      expect.objectContaining({
        projectId: secondProject.project_id,
        aliases: [],
      }),
    ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("LEFT JOIN lcm.project_aliases"),
    }), expect.objectContaining({ operation: "listProjects" }));
  });
});
