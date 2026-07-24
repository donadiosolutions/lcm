import { createHash } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlIdentityExecutor,
} from "../../src/storage/postgresql/identity-repository.js";
import {
  PostgreSqlIdentityCreateOutcomeUnknownError,
  PostgreSqlIdentityConflictError,
  PostgreSqlIdentityLinkOutcomeUnknownError,
  PostgreSqlIdentityNotFoundError,
  PostgreSqlIdentityRegistrationError,
  PostgreSqlIdentityReplaceAliasesOutcomeUnknownError,
  PostgreSqlIdentityRepository,
  PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError,
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
    const error = await repository.registerMachine(machineRow.identity_key, "Machine A")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostgreSqlIdentityRegistrationError);
    expect(error).toMatchObject({
      operation: "registerMachine",
      message: "PostgreSQL machine registration did not return an identity",
    });
    expect(JSON.stringify(error)).not.toContain(machineRow.identity_key);
    expect(String(error)).not.toContain(machineRow.identity_key);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
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

  it("uses a deterministic valid display name when a legacy machine row has NULL", async () => {
    const repository = new PostgreSqlIdentityRepository(executor(() => result([{
      ...machineRow,
      display_name: null,
    }])));

    await expect(repository.recoverMachine(machineRow.machine_id)).resolves.toMatchObject({
      machineId: machineRow.machine_id,
      displayName: `Machine ${machineRow.machine_id}`,
    });
  });

  it("creates a project and every initial alias in one transaction", async () => {
    const secondAlias = {
      ...aliasRow,
      path: "/work/project-alias",
      normalized_path: "/work/project-alias",
    };
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.projects")) return result([projectRow]);
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      if (config.text.includes("INSERT INTO lcm.project_aliases")) {
        return result([
          config.values?.[3] === secondAlias.normalized_path ? secondAlias : aliasRow,
        ]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.createProject({
      machineId: machineRow.machine_id,
      displayName: "Project A",
      path: "/work/project",
      normalizedPath: "/work/project",
      aliases: [
        { path: aliasRow.path, normalizedPath: aliasRow.normalized_path },
        { path: secondAlias.path, normalizedPath: secondAlias.normalized_path },
      ],
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
      }, {
        machineId: machineRow.machine_id,
        path: "/work/project-alias",
        normalizedPath: "/work/project-alias",
        linkedAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "createProject",
    });
    const createCall = db.query.mock.calls.find(
      ([query]) => query.text.includes("INSERT INTO lcm.projects"),
    );
    expect(createCall?.[0]).toMatchObject({
      text: expect.stringContaining("identity_key, display_name"),
      values: [expect.stringMatching(/^[a-f0-9]{64}$/u), "Project A"],
    });
    expect(createCall?.[0].values?.[0]).not.toBe(
      createHash("sha256").update("/work/project").digest("hex"),
    );
    expect(createCall?.[1]).toMatchObject({ operation: "createProject" });
  });

  it.each([
    ["blank", "   ", "must not be blank"],
    ["too long", "x".repeat(257), "at most 256"],
    ["control characters", "bad\nname", "control characters"],
  ])("rejects a %s project display name before opening a transaction", async (
    _case,
    displayName,
    message,
  ) => {
    const db = executor(() => result([]));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.createProject({
      machineId: machineRow.machine_id,
      displayName,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    })).rejects.toThrow(message);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("trims Unicode project display names at the persistence boundary", async () => {
    const unicodeProjectRow = { ...projectRow, display_name: "Projeto café" };
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.projects")) return result([unicodeProjectRow]);
      if (config.text.includes("SELECT project_id FROM")) return result([{ project_id: projectRow.project_id }]);
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result([aliasRow]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.createProject({
      machineId: machineRow.machine_id,
      displayName: "  Projeto café  ",
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    })).resolves.toMatchObject({ displayName: "Projeto café" });
    expect(db.query.mock.calls[0][0]).toMatchObject({
      values: [expect.stringMatching(/^[a-f0-9]{64}$/u), "Projeto café"],
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

    await expect(repository.linkProjectWithOwnership(input)).resolves.toMatchObject({
      alias: { path: aliasRow.path },
      inserted: true,
    });
    insertReturnsRow = false;
    await expect(repository.linkProjectWithOwnership(input)).resolves.toMatchObject({
      alias: { path: aliasRow.path },
      inserted: false,
    });
    await expect(repository.linkProject(input)).resolves.toMatchObject({ path: aliasRow.path });
  });

  it("preserves alias insertion ownership when a link COMMIT outcome is unknown", async () => {
    const db = executor((config) => {
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
        operation: "linkProject",
        projectId: projectRow.project_id,
      });
    });
    const repository = new PostgreSqlIdentityRepository(db);

    const error = await repository.linkProjectWithOwnership({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      path: aliasRow.path,
      normalizedPath: aliasRow.normalized_path,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostgreSqlIdentityLinkOutcomeUnknownError);
    expect((error as PostgreSqlIdentityLinkOutcomeUnknownError).candidate).toMatchObject({
      alias: { normalizedPath: aliasRow.normalized_path },
      inserted: true,
    });
    expect((error as PostgreSqlIdentityLinkOutcomeUnknownError).toJSON()).toMatchObject({
      backend: "postgresql",
      projectId: projectRow.project_id,
      domain: "identity",
      operation: "linkProject",
    });
    expect(JSON.stringify((error as PostgreSqlIdentityLinkOutcomeUnknownError).toJSON()))
      .not.toContain(aliasRow.path);
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

  it("atomically replaces every requested alias only for the expected prior owner", async () => {
    const replacementId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const secondAlias = {
      ...aliasRow,
      path: "/work/alias",
      normalized_path: "/work/alias",
    };
    let currentRows: QueryResultRow[] = [aliasRow, secondAlias];
    let insertedRows: QueryResultRow[] = [];
    let selectCount = 0;
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: replacementId }]);
      }
      if (config.text.includes("FOR UPDATE")) {
        selectCount += 1;
        return result(selectCount % 2 === 1
          ? currentRows
          : [aliasRow, secondAlias].map((row) => ({ ...row, project_id: replacementId })));
      }
      if (config.text.includes("UPDATE lcm.project_aliases")) return result([]);
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result(insertedRows);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);
    const input = {
      machineId: machineRow.machine_id,
      expectedPriorProjectId: projectRow.project_id,
      projectId: replacementId,
      aliases: [
        { path: aliasRow.path, normalizedPath: aliasRow.normalized_path },
        { path: secondAlias.path, normalizedPath: secondAlias.normalized_path },
      ],
    };

    await expect(repository.replaceProjectAliases(input))
      .resolves.toMatchObject({
        aliases: [{}, {}],
        prior: [{}, {}],
        inserted: [false, false],
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
    }), expect.objectContaining({ operation: "replaceProjectAliases" }));

    currentRows = [aliasRow];
    await expect(repository.replaceProjectAliases(input))
      .resolves.toMatchObject({
        aliases: [{}, {}],
        prior: [{}, null],
        inserted: [false, false],
      });
    insertedRows = [{ ...secondAlias, project_id: replacementId }];
    await expect(repository.replaceProjectAliases(input))
      .resolves.toMatchObject({
        aliases: [{}, {}],
        prior: [{}, null],
        inserted: [false, true],
      });
    insertedRows = [];
    currentRows = [{ ...aliasRow, project_id: replacementId }, secondAlias];
    await expect(repository.replaceProjectAliases(input))
      .resolves.toMatchObject({
        aliases: [{}, {}],
        prior: [{ projectId: replacementId }, { projectId: projectRow.project_id }],
      });
    currentRows = [aliasRow, { ...secondAlias, project_id: "foreign" }];
    await expect(repository.replaceProjectAliases(input)).resolves.toBeNull();

    const missing = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(missing.replaceProjectAliases(input))
      .rejects.toBeInstanceOf(PostgreSqlIdentityNotFoundError);
  });

  it("inserts an absent alias during an initial binding without an expected prior owner", async () => {
    let selectCount = 0;
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: projectRow.project_id }]);
      }
      if (config.text.includes("FOR UPDATE")) {
        selectCount += 1;
        return result(selectCount === 1 ? [] : [aliasRow]);
      }
      if (config.text.includes("INSERT INTO lcm.project_aliases")) return result([aliasRow]);
      if (config.text.includes("UPDATE lcm.project_aliases")) {
        throw new Error("initial binding must not update an absent alias");
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.replaceProjectAliases({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      aliases: [{
        path: aliasRow.path,
        normalizedPath: aliasRow.normalized_path,
      }],
    })).resolves.toMatchObject({
      aliases: [{ normalizedPath: aliasRow.normalized_path }],
      prior: [null],
      inserted: [true],
    });
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("INSERT INTO lcm.project_aliases"),
      values: [
        projectRow.project_id,
        machineRow.machine_id,
        aliasRow.path,
        aliasRow.normalized_path,
      ],
    }), expect.objectContaining({ operation: "replaceProjectAliases" }));
    expect(db.query.mock.calls.some(([config]) => (
      (config as QueryConfig<unknown[]>).text.includes("UPDATE lcm.project_aliases")
    ))).toBe(false);
  });

  it("refreshes and compensates a same-owner alias lexical path transactionally", async () => {
    const priorAlias = {
      ...aliasRow,
      path: "/work/../work/project",
    };
    const refreshedAlias = {
      ...aliasRow,
      path: "/work/project",
    };
    let selectCount = 0;
    const replacementDb = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: projectRow.project_id }]);
      }
      if (config.text.includes("FOR UPDATE")) {
        selectCount += 1;
        return result(selectCount === 1 ? [priorAlias] : [refreshedAlias]);
      }
      if (config.text.includes("UPDATE lcm.project_aliases")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(replacementDb);
    const aliases = [{
      path: refreshedAlias.path,
      normalizedPath: refreshedAlias.normalized_path,
    }];

    const mutation = await repository.replaceProjectAliases({
      machineId: machineRow.machine_id,
      projectId: projectRow.project_id,
      aliases,
    });
    expect(mutation).toMatchObject({
      aliases: [{ path: refreshedAlias.path }],
      prior: [{
        projectId: projectRow.project_id,
        alias: { path: priorAlias.path },
      }],
      inserted: [false],
    });
    expect(replacementDb.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("SET path = $1"),
      values: [
        refreshedAlias.path,
        machineRow.machine_id,
        refreshedAlias.normalized_path,
        projectRow.project_id,
      ],
    }), expect.objectContaining({ operation: "replaceProjectAliases" }));

    const restoreDb = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result([refreshedAlias]);
      if (config.text.includes("UPDATE lcm.project_aliases")) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const restoringRepository = new PostgreSqlIdentityRepository(restoreDb);
    await expect(restoringRepository.restoreProjectAliasBatch(
      machineRow.machine_id,
      projectRow.project_id,
      mutation!.prior,
      mutation!.inserted,
      aliases,
    )).resolves.toBe(true);
    expect(restoreDb.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("SET project_id = $1"),
      values: [
        projectRow.project_id,
        priorAlias.path,
        machineRow.machine_id,
        priorAlias.normalized_path,
        projectRow.project_id,
      ],
    }), expect.objectContaining({ operation: "restoreProjectAliasBatch" }));
  });

  it("preserves batch replacement snapshots when COMMIT outcomes are unknown", async () => {
    const replacementId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const insertedAlias = {
      ...aliasRow,
      project_id: replacementId,
      path: "/work/local-only",
      normalized_path: "/work/local-only",
    };
    let selectCount = 0;
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: replacementId }]);
      }
      if (config.text.includes("FOR UPDATE")) {
        selectCount += 1;
        return result(selectCount === 1
          ? [aliasRow]
          : [{ ...aliasRow, project_id: replacementId }, insertedAlias]);
      }
      if (
        config.text.includes("UPDATE lcm.project_aliases")
        || config.text.includes("INSERT INTO lcm.project_aliases")
      ) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    db.transaction.mockImplementation(async (callback) => {
      await callback(db);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "replaceProjectAliases",
        projectId: replacementId,
      });
    });
    const repository = new PostgreSqlIdentityRepository(db);

    const error = await repository.replaceProjectAliases({
      machineId: machineRow.machine_id,
      expectedPriorProjectId: projectRow.project_id,
      projectId: replacementId,
      aliases: [
        { path: aliasRow.path, normalizedPath: aliasRow.normalized_path },
        { path: insertedAlias.path, normalizedPath: insertedAlias.normalized_path },
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostgreSqlIdentityReplaceAliasesOutcomeUnknownError);
    expect((error as PostgreSqlIdentityReplaceAliasesOutcomeUnknownError).candidate)
      .toMatchObject({
        aliases: [{ normalizedPath: aliasRow.normalized_path }, {
          normalizedPath: insertedAlias.normalized_path,
        }],
        prior: [{ projectId: projectRow.project_id }, null],
        inserted: [false, false],
      });
  });

  it("rolls back a batch replacement when an absent alias is claimed concurrently", async () => {
    const replacementId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const secondAlias = {
      ...aliasRow,
      project_id: "foreign",
      path: "/work/local-only",
      normalized_path: "/work/local-only",
    };
    let selectCount = 0;
    const db = executor((config) => {
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: replacementId }]);
      }
      if (config.text.includes("FOR UPDATE")) {
        selectCount += 1;
        return result(selectCount === 1
          ? [aliasRow]
          : [{ ...aliasRow, project_id: replacementId }, secondAlias]);
      }
      if (
        config.text.includes("UPDATE lcm.project_aliases")
        || config.text.includes("INSERT INTO lcm.project_aliases")
      ) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.replaceProjectAliases({
      machineId: machineRow.machine_id,
      expectedPriorProjectId: projectRow.project_id,
      projectId: replacementId,
      aliases: [
        { path: aliasRow.path, normalizedPath: aliasRow.normalized_path },
        { path: secondAlias.path, normalizedPath: secondAlias.normalized_path },
      ],
    })).resolves.toBeNull();
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
    expect(pathError).toMatchObject({ operation: "unlinkPath" });

    const ownedError = await repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    ).catch((caught: unknown) => caught);
    expect(ownedError).toBeInstanceOf(PostgreSqlIdentityUnlinkPathOutcomeUnknownError);
    expect(ownedError).toMatchObject({ operation: "unlinkProjectAliasIfOwned" });
    expect(JSON.stringify(ownedError)).not.toContain(aliasRow.path);

    const projectError = await repository.unlinkProject(
      machineRow.machine_id,
      projectRow.project_id,
    ).catch((caught: unknown) => caught);
    expect(projectError).toBeInstanceOf(PostgreSqlIdentityUnlinkProjectOutcomeUnknownError);
    expect((projectError as PostgreSqlIdentityUnlinkProjectOutcomeUnknownError).aliases)
      .toEqual([expect.objectContaining({ normalizedPath: aliasRow.normalized_path })]);
  });

  it("does not report an uncertain owned unlink when COMMIT follows a null deletion", async () => {
    const commitError = new PostgreSqlCommitOutcomeUnknownError({
      domain: "identity",
      operation: "unlinkProjectAliasIfOwned",
      projectId: projectRow.project_id,
    });
    const db = executor(() => result([]));
    db.transaction.mockImplementation(async (
      callback: (transactionExecutor: PostgreSqlIdentityExecutor) => Promise<unknown>,
    ): Promise<never> => {
      await callback(db);
      throw commitError;
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.unlinkProjectAliasIfOwned(
      machineRow.machine_id,
      aliasRow.normalized_path,
      projectRow.project_id,
    )).rejects.toBe(commitError);
  });

  it("batch unlinks and restores only an exact expected-owner alias set", async () => {
    const secondAlias = {
      ...aliasRow,
      path: "/work/alias",
      normalized_path: "/work/alias",
    };
    let currentRows: QueryResultRow[] = [aliasRow, secondAlias];
    const db = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result(currentRows);
      if (config.text.includes("DELETE FROM lcm.project_aliases")) return result(currentRows);
      if (config.text.includes("SELECT project_id FROM")) {
        return result([{ project_id: projectRow.project_id }]);
      }
      if (config.text.includes("INSERT INTO lcm.project_aliases")) {
        return result([aliasRow]);
      }
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);
    const paths = [aliasRow.normalized_path, secondAlias.normalized_path];
    const inputs = [
      { path: aliasRow.path, normalizedPath: aliasRow.normalized_path },
      { path: secondAlias.path, normalizedPath: secondAlias.normalized_path },
    ];

    const removed = await repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      inputs,
    );
    expect(removed).toHaveLength(2);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("normalized_path = ANY($3::text[])"),
      values: [machineRow.machine_id, projectRow.project_id, paths],
    }), expect.objectContaining({ operation: "unlinkProjectAliasesIfOwned" }));

    currentRows = [aliasRow];
    await expect(repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      inputs,
    )).resolves.toHaveLength(1);
    currentRows = [aliasRow, { ...secondAlias, project_id: "other" }];
    await expect(repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      inputs,
    )).resolves.toBeNull();

    currentRows = [];
    await expect(repository.restoreProjectAliases(
      machineRow.machine_id,
      projectRow.project_id,
      removed!,
    )).resolves.toBe(true);
    currentRows = [aliasRow];
    await expect(repository.restoreProjectAliases(
      machineRow.machine_id,
      projectRow.project_id,
      removed!,
    )).resolves.toBe(false);
  });

  it("preserves batch unlink snapshots when COMMIT outcomes are unknown", async () => {
    let rows: QueryResultRow[] = [aliasRow];
    const db = executor(() => result(rows));
    db.transaction.mockImplementation(async (callback) => {
      await callback(db);
      throw new PostgreSqlCommitOutcomeUnknownError({
        domain: "identity",
        operation: "unlinkProjectAliasesIfOwned",
        projectId: projectRow.project_id,
      });
    });
    const repository = new PostgreSqlIdentityRepository(db);

    const removed = await repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
    ).catch((error: unknown) => error);
    expect(removed).toBeInstanceOf(PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError);
    expect((removed as PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError).aliases)
      .toEqual([expect.objectContaining({ normalizedPath: aliasRow.normalized_path })]);

    rows = [];
    const absent = await repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
    ).catch((error: unknown) => error);
    expect(absent).toBeInstanceOf(PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError);
    expect((absent as PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError).aliases).toEqual([]);

    rows = [{ ...aliasRow, project_id: "foreign" }];
    const collision = await repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
    ).catch((error: unknown) => error);
    expect(collision).toBeInstanceOf(PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError);
    expect((collision as PostgreSqlIdentityUnlinkAliasesOutcomeUnknownError).aliases).toEqual([]);
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
    await expect(repository.unlinkProjectAliasesIfOwned(
      machineRow.machine_id,
      projectRow.project_id,
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
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

  it("restores an exact mixed alias batch and rejects ownership changes", async () => {
    const priorProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
    const secondAlias = {
      ...aliasRow,
      path: "/work/inserted",
      normalized_path: "/work/inserted",
    };
    const thirdAlias = {
      ...aliasRow,
      path: "/work/idempotent",
      normalized_path: "/work/idempotent",
    };
    const currentRows = [aliasRow, secondAlias, thirdAlias];
    const db = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result(currentRows);
      if (
        config.text.includes("DELETE FROM lcm.project_aliases")
        || config.text.includes("UPDATE lcm.project_aliases")
      ) return result([]);
      throw new Error(`unexpected SQL: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);
    const aliases = currentRows.map((row) => ({
      path: row.path,
      normalizedPath: row.normalized_path,
    }));

    await expect(repository.restoreProjectAliasBatch(
      machineRow.machine_id,
      projectRow.project_id,
      [{
        projectId: priorProjectId,
        alias: {
          machineId: machineRow.machine_id,
          path: "/work/original",
          normalizedPath: aliasRow.normalized_path,
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      }, null, {
        projectId: projectRow.project_id,
        alias: {
          machineId: machineRow.machine_id,
          path: thirdAlias.path,
          normalizedPath: thirdAlias.normalized_path,
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      }],
      [false, true, false],
      aliases,
    )).resolves.toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("UPDATE lcm.project_aliases"),
      values: [
        priorProjectId,
        "/work/original",
        machineRow.machine_id,
        aliasRow.normalized_path,
        projectRow.project_id,
      ],
    }), expect.objectContaining({ operation: "restoreProjectAliasBatch" }));
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("DELETE FROM lcm.project_aliases"),
      values: [
        machineRow.machine_id,
        secondAlias.normalized_path,
        projectRow.project_id,
      ],
    }), expect.objectContaining({ operation: "restoreProjectAliasBatch" }));

    const missing = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(missing.restoreProjectAliasBatch(
      machineRow.machine_id,
      projectRow.project_id,
      [null],
      [true],
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
    )).resolves.toBe(false);
    const foreign = new PostgreSqlIdentityRepository(executor(() => result([
      { ...aliasRow, project_id: priorProjectId },
    ])));
    await expect(foreign.restoreProjectAliasBatch(
      machineRow.machine_id,
      projectRow.project_id,
      [null],
      [true],
      [{ path: aliasRow.path, normalizedPath: aliasRow.normalized_path }],
    )).resolves.toBe(false);
  });

  it("preserves a concurrent same-project winner absent from the prior snapshot", async () => {
    const db = executor((config) => {
      if (config.text.includes("FOR UPDATE")) return result([aliasRow]);
      throw new Error(`unexpected mutation: ${config.text}`);
    });
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.restoreProjectAliasBatch(
      machineRow.machine_id,
      projectRow.project_id,
      [null],
      [false],
      [{ path: "/work/loser", normalizedPath: aliasRow.normalized_path }],
    )).resolves.toBe(true);
    expect(db.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("DELETE FROM") }),
      expect.anything(),
    );
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
      [aliasRow.normalized_path],
    )).resolves.toBe(true);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "identity",
      operation: "cleanupCreatedProject",
      projectId: projectRow.project_id,
    });
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("normalized_path = ANY($3::text[])"),
      values: [
        machineRow.machine_id,
        projectRow.project_id,
        [aliasRow.normalized_path],
      ],
    }), expect.any(Object));
    deleteProject = false;
    await expect(repository.cleanupCreatedProject(
      machineRow.machine_id,
      projectRow.project_id,
      [aliasRow.normalized_path],
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

  it("resolves persisted lexical paths without recomputing normalized identities", async () => {
    const second = {
      ...aliasRow,
      path: "/work/deleted-link",
      normalized_path: "/work/original-target",
    };
    const db = executor(() => result([second, aliasRow]));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.resolveProjectAliasesByPath(
      machineRow.machine_id,
      [second.path, aliasRow.path],
    )).resolves.toEqual([
      expect.objectContaining({
        projectId: projectRow.project_id,
        alias: expect.objectContaining({
          path: second.path,
          normalizedPath: second.normalized_path,
        }),
      }),
      expect.objectContaining({
        projectId: projectRow.project_id,
        alias: expect.objectContaining({
          path: aliasRow.path,
          normalizedPath: aliasRow.normalized_path,
        }),
      }),
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("path = ANY($2::text[])"),
      values: [
        machineRow.machine_id,
        [second.path, aliasRow.path],
      ],
    }), expect.objectContaining({ operation: "resolveProjectAliasesByPath" }));

    db.query.mockClear();
    await expect(repository.resolveProjectAliasesByPath(
      machineRow.machine_id,
      [],
    )).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
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

  it("gets one project through a parameterized project-ID-filtered snapshot", async () => {
    const secondAlias = {
      ...aliasRow,
      path: "/work/project-alias",
      normalized_path: "/work/project-alias",
    };
    const db = executor(() => result([
      { ...projectRow, ...aliasRow },
      { ...projectRow, ...secondAlias },
    ]));
    const repository = new PostgreSqlIdentityRepository(db);

    await expect(repository.getProject(projectRow.project_id)).resolves.toEqual(
      expect.objectContaining({
        projectId: projectRow.project_id,
        aliases: [
          expect.objectContaining({ normalizedPath: aliasRow.normalized_path }),
          expect.objectContaining({ normalizedPath: secondAlias.normalized_path }),
        ],
      }),
    );
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("WHERE project.project_id = $1"),
      values: [projectRow.project_id],
    }), {
      domain: "identity",
      operation: "getProject",
      projectId: projectRow.project_id,
    });

    const missing = new PostgreSqlIdentityRepository(executor(() => result([])));
    await expect(missing.getProject(projectRow.project_id)).resolves.toBeNull();
  });
});
