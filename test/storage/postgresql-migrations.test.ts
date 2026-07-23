import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlMigration,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  loadPostgreSqlMigrations,
  PostgreSqlSchemaOwnershipPreflightError,
  PostgreSqlServerVersionPreflightError,
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";
import { REQUIRED_POSTGRESQL_EXTENSIONS } from "../../src/storage/postgresql/extensions.js";

function migration(id: string, sql = `SELECT '${id}'`): PostgreSqlMigration {
  return { id, filename: `${id}.sql`, sql, sha256: createHash("sha256").update(sql).digest("hex") };
}

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(options: {
  ledger?: boolean;
  current?: Array<{ id: string; checksum_sha256: string }>;
  failOperation?: string;
  schemaOwnership?: "absent" | "owned" | "unowned" | "missing" | "invalid" | "inconsistent";
  serverVersion?: number | "missing";
} = {}) {
  const operations: string[] = [];
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    context: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => {
    operations.push(context.operation);
    if (context.operation === options.failOperation) throw new Error("private SQL failure");
    if (context.operation === "preflightServerVersion") {
      return result(options.serverVersion === "missing"
        ? [] as R[]
        : [{ server_version_num: options.serverVersion ?? 180004 }] as unknown as R[]);
    }
    if (context.operation === "preflightRequiredExtensions") {
      return result(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
        name,
        default_version: "1.0",
        installed_version: "1.0",
        installed_schema: "public",
        relocatable: true,
        preloaded: name === "pg_stat_statements" ? true : null,
      })) as unknown as R[]);
    }
    if (context.operation === "preflightSchemaOwnership") {
      if (options.schemaOwnership === "missing") return result([] as R[]);
      if (options.schemaOwnership === "invalid") {
        return result([{ schema_exists: "yes", owned_by_current_user: 1 }] as unknown as R[]);
      }
      if (options.schemaOwnership === "inconsistent") {
        return result([{ schema_exists: false, owned_by_current_user: true }] as unknown as R[]);
      }
      return result([{
        schema_exists: options.schemaOwnership !== undefined && options.schemaOwnership !== "absent",
        owned_by_current_user: options.schemaOwnership === "owned",
      }] as unknown as R[]);
    }
    if (context.operation === "inspectMigrationLedger") return result([{ ledger_exists: options.ledger ?? false }] as unknown as R[]);
    if (context.operation === "readMigrations") return result((options.current ?? []) as unknown as R[]);
    return result([] as R[]);
  });
  const seam = {
    query,
    transaction: vi.fn(async <T>(callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>) => callback({ query })),
  };
  return { seam, operations };
}

describe("PostgreSQL migration runner", () => {
  it("loads the pinned artifact and rejects missing or drifted files", () => {
    const migrations = loadPostgreSqlMigrations();
    expect(migrations).toEqual([
      expect.objectContaining({ id: "0001_migration_ledger", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      expect.objectContaining({ id: "0002_schema_baseline", sha256: "97436c0fb6b82d699d55f6c17554ebc229b776f24b9a75b19d66041e781979a9" }),
    ]);
    expect(migrations[1]?.sql).toContain(
      "fencing_token bigint GENERATED ALWAYS AS IDENTITY CHECK (fencing_token > 0)",
    );
    expect(migrations[1]?.sql).toContain("lcm.fenced_leases_fencing_token_seq");
    expect(() => loadPostgreSqlMigrations(() => { throw new Error("missing private path"); }))
      .toThrowError(expect.objectContaining({ operation: "loadMigrations" }));
    expect(() => loadPostgreSqlMigrations(() => "altered migration"))
      .toThrowError(expect.objectContaining({ operation: "verifyMigrationArtifact" }));
  });

  it.each([
    { migrations: [migration("bad")] },
    { migrations: [migration("0001_valid"), migration("0001_valid")] },
    { migrations: [migration("0002_later"), migration("0001_earlier")] },
    { migrations: [{ ...migration("0001_valid"), sha256: "0".repeat(64) }] },
  ])("rejects malformed migration manifests", async ({ migrations }) => {
    await expect(runPostgreSqlMigrations(executor().seam, { migrations }))
      .rejects.toMatchObject({ operation: "validateMigrations" });
  });

  it("applies and records pending migrations atomically with the signal", async () => {
    const fake = executor();
    const signal = new AbortController().signal;
    const migrations = [migration("0001_first"), migration("0002_second")];
    await expect(runPostgreSqlMigrations(fake.seam, { migrations, signal })).resolves.toEqual({
      applied: ["0001_first", "0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toEqual([
      "lockMigrations",
      "preflightServerVersion",
      "preflightRequiredExtensions",
      "preflightSchemaOwnership",
      "inspectMigrationLedger",
      "applyMigration:0001_first",
      "recordMigration",
      "applyMigration:0002_second",
      "recordMigration",
    ]);
    expect(fake.seam.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "factory", operation: "migrate", signal,
    });
  });

  it("accepts exact ordered history and applies only pending files", async () => {
    const migrations = [migration("0001_first"), migration("0002_second")];
    const fake = executor({ ledger: true, current: [{ id: migrations[0].id, checksum_sha256: migrations[0].sha256 }] });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations })).resolves.toEqual({
      applied: ["0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toContain("readMigrations");
  });

  it("accepts a pre-existing schema owned by the migration role", async () => {
    const fake = executor({ schemaOwnership: "owned" });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations: [] }))
      .resolves.toEqual({ applied: [], current: [] });
    expect(fake.operations).toContain("preflightSchemaOwnership");
  });

  it.each([
    { current: [{ id: "0001_first", checksum_sha256: "x" }, { id: "0002_second", checksum_sha256: "x" }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_unknown", checksum_sha256: migration("0001_first").sha256 }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_first", checksum_sha256: "0".repeat(64) }], migrations: [migration("0001_first")] },
  ])("rejects unknown, excess, or checksum-drifted history", async ({ current, migrations }) => {
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam, { migrations }))
      .rejects.toMatchObject({ operation: "verifyMigrationHistory" });
  });

  it("uses the packaged manifest by default and propagates transactional failures safely", async () => {
    const current = loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }));
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam)).resolves.toMatchObject({ applied: [] });
    await expect(runPostgreSqlMigrations(executor({ failOperation: "lockMigrations" }).seam, { migrations: [] }))
      .rejects.toThrow("private SQL failure");
  });

  it("fails extension preflight before inspecting or changing the schema", async () => {
    const fake = executor({ failOperation: "preflightRequiredExtensions" });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations: [migration("0001_first")] }))
      .rejects.toThrow("private SQL failure");
    expect(fake.operations).toEqual([
      "lockMigrations",
      "preflightServerVersion",
      "preflightRequiredExtensions",
    ]);
  });

  it.each([
    {
      label: "owned by another role",
      schemaOwnership: "unowned" as const,
      schemaExists: true,
      ownedByMigrator: false,
    },
    {
      label: "missing catalog result",
      schemaOwnership: "missing" as const,
      schemaExists: null,
      ownedByMigrator: null,
    },
    {
      label: "malformed catalog result",
      schemaOwnership: "invalid" as const,
      schemaExists: null,
      ownedByMigrator: null,
    },
    {
      label: "contradictory catalog result",
      schemaOwnership: "inconsistent" as const,
      schemaExists: false,
      ownedByMigrator: true,
    },
  ])("fails closed when schema ownership is $label", async ({
    schemaOwnership,
    schemaExists,
    ownedByMigrator,
  }) => {
    const fake = executor({ schemaOwnership });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlSchemaOwnershipPreflightError);
    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "preflightSchemaOwnership",
      schemaName: "lcm",
      schemaExists,
      ownedByMigrator,
      requiredOwner: "migration-role",
    });
    expect((failure as PostgreSqlSchemaOwnershipPreflightError).toJSON()).toMatchObject({
      schemaName: "lcm",
      schemaExists,
      ownedByMigrator,
      requiredOwner: "migration-role",
    });
    expect(fake.operations).toEqual([
      "lockMigrations",
      "preflightServerVersion",
      "preflightRequiredExtensions",
      "preflightSchemaOwnership",
    ]);
  });

  it.each([
    {
      label: "wrong",
      serverVersion: 190001 as const,
      serverVersionNumber: 190001,
      serverMajorVersion: 19,
    },
    {
      label: "missing",
      serverVersion: "missing" as const,
      serverVersionNumber: null,
      serverMajorVersion: null,
    },
    {
      label: "invalid",
      serverVersion: -1 as const,
      serverVersionNumber: null,
      serverMajorVersion: null,
    },
    {
      label: "non-integer",
      serverVersion: 180004.5 as const,
      serverVersionNumber: null,
      serverMajorVersion: null,
    },
  ])("rejects a $label PostgreSQL server version before extension or schema inspection", async ({
    serverVersion,
    serverVersionNumber,
    serverMajorVersion,
  }) => {
    const fake = executor({ serverVersion });
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: [migration("0001_first")],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlServerVersionPreflightError);
    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "preflightServerVersion",
      serverVersionNumber,
      serverMajorVersion,
      requiredServerMajorVersion: 18,
    });
    expect((failure as PostgreSqlServerVersionPreflightError).toJSON()).toMatchObject({
      serverVersionNumber,
      serverMajorVersion,
      requiredServerMajorVersion: REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
    });
    expect(fake.operations).toEqual(["lockMigrations", "preflightServerVersion"]);
  });
});
