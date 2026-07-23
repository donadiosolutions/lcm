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
  PostgreSqlManagedObjectOwnershipPreflightError,
  PostgreSqlSchemaAclPreflightError,
  PostgreSqlSchemaOwnershipPreflightError,
  PostgreSqlServerEncodingPreflightError,
  PostgreSqlServerVersionPreflightError,
  REQUIRED_POSTGRESQL_SERVER_ENCODING,
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";
import { REQUIRED_POSTGRESQL_EXTENSIONS } from "../../src/storage/postgresql/extensions.js";
import { POSTGRESQL_SEARCH_CONFIGURATION_SHA256 } from "../../src/storage/postgresql/search-configuration.js";

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
  schemaOwnership?:
    | "absent"
    | "owned"
    | "unowned"
    | "missing"
    | "invalid"
    | "inconsistent"
    | "empty-user"
    | "long-user"
    | "missing-user"
    | "unsafe-user"
    | "quoted-user";
  serverVersion?: number | "missing";
  serverEncoding?: unknown;
  postmasterEpoch?: unknown;
  postmasterContinuity?: boolean | "missing";
  schemaAcl?: "absent" | "ready" | "public" | "missing" | "invalid" | "inconsistent";
  managedOwnership?: "ready" | "unowned" | "missing" | "invalid" | "inconsistent" | "different-user";
} = {}) {
  const operations: string[] = [];
  const query = vi.fn(async <R extends QueryResultRow>(
    _config: unknown,
    context: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>> => {
    operations.push(context.operation);
    if (context.operation === options.failOperation) throw new Error("private SQL failure");
    if (context.operation === "capturePostmasterEpoch") {
      return options.postmasterEpoch === null
        ? result([] as R[])
        : result([{
          postmaster_started_at: options.postmasterEpoch ?? "2026-01-01 00:00:00+00",
        }] as unknown as R[]);
    }
    if (context.operation === "preflightServerEncoding") {
      return options.serverEncoding === "missing"
        ? result([] as R[])
        : result([{
          server_encoding: options.serverEncoding ?? REQUIRED_POSTGRESQL_SERVER_ENCODING,
        }] as unknown as R[]);
    }
    if (context.operation.endsWith("probePgStatStatements")) {
      return result([{ stats_reset: new Date() }] as unknown as R[]);
    }
    if (context.operation === "verifyPostmasterContinuity") {
      return options.postmasterContinuity === "missing"
        ? result([] as R[])
        : result([{
          preflight_still_valid: options.postmasterContinuity ?? true,
        }] as unknown as R[]);
    }
    if (context.operation === "preflightSearchConfiguration") {
      return result([{
        actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        object_count: "19",
        ownership_ready: true,
      }] as unknown as R[]);
    }
    if (context.operation === "preflightServerVersion") {
      return result(options.serverVersion === "missing"
        ? [] as R[]
        : [{ server_version_num: options.serverVersion ?? 180004 }] as unknown as R[]);
    }
    if (
      context.operation === "preflightRequiredExtensions"
      || context.operation === "revalidateRequiredExtensionCatalog"
    ) {
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
        return result([{
          current_user_name: 7,
          schema_exists: "yes",
          owned_by_current_user: 1,
        }] as unknown as R[]);
      }
      if (options.schemaOwnership === "inconsistent") {
        return result([{
          current_user_name: "lcm_test_migrator",
          schema_exists: false,
          owned_by_current_user: true,
        }] as unknown as R[]);
      }
      return result([{
        current_user_name: options.schemaOwnership === "missing-user"
          ? null
          : options.schemaOwnership === "empty-user"
            ? ""
            : options.schemaOwnership === "long-user"
              ? "a".repeat(257)
              : options.schemaOwnership === "unsafe-user"
                ? "unsafe\nrole"
                : options.schemaOwnership === "quoted-user"
                  ? 'migration"owner'
                  : "lcm_test_migrator",
        schema_exists: options.schemaOwnership !== undefined && options.schemaOwnership !== "absent",
        owned_by_current_user: options.schemaOwnership === "owned",
      }] as unknown as R[]);
    }
    if (context.operation === "preflightSchemaAcl") {
      if (options.schemaAcl === "missing") return result([] as R[]);
      if (options.schemaAcl === "invalid") {
        return result([{ schema_exists: "yes", public_create: 1 }] as unknown as R[]);
      }
      if (options.schemaAcl === "inconsistent") {
        return result([{ schema_exists: false, public_create: true }] as unknown as R[]);
      }
      return result([{
        schema_exists: options.schemaAcl !== undefined && options.schemaAcl !== "absent",
        public_create: options.schemaAcl === "public",
      }] as unknown as R[]);
    }
    if (context.operation === "preflightManagedObjectOwnership") {
      if (options.managedOwnership === "missing") return result([] as R[]);
      if (options.managedOwnership === "invalid") {
        return result([{
          current_user_name: 7,
          existing_object_count: "many",
          unowned_object_count: false,
        }] as unknown as R[]);
      }
      return result([{
        current_user_name: options.managedOwnership === "different-user"
          ? "different_migrator"
          : "lcm_test_migrator",
        existing_object_count: options.managedOwnership === "inconsistent" ? 0 : 35,
        unowned_object_count: options.managedOwnership === "unowned"
          || options.managedOwnership === "inconsistent"
          ? 1
          : 0,
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
      expect.objectContaining({ id: "0002_schema_baseline", sha256: "6386af13407e8944ce188c9ce19b5944f27b9fa58a4ad8660ede347c8beacfa2" }),
    ]);
    expect(migrations[1]?.sql).toContain(
      "fencing_token bigint GENERATED ALWAYS AS IDENTITY CHECK (fencing_token > 0)",
    );
    expect(migrations[1]?.sql).toContain(
      `catalog SHA-256 ${POSTGRESQL_SEARCH_CONFIGURATION_SHA256}`,
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
    const fake = executor({ postmasterEpoch: new Date("2026-01-01T00:00:00Z") });
    const signal = new AbortController().signal;
    const migrations = [migration("0001_first"), migration("0002_second")];
    await expect(runPostgreSqlMigrations(fake.seam, { migrations, signal })).resolves.toEqual({
      applied: ["0001_first", "0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
      "preflightSchemaAcl",
      "preflightManagedObjectOwnership",
      "inspectMigrationLedger",
      "applyMigration:0001_first",
      "recordMigration",
      "applyMigration:0002_second",
      "recordMigration",
      "preflightSearchConfiguration",
    ]);
    expect(fake.seam.query).toHaveBeenNthCalledWith(5, {
      text: "SET LOCAL search_path = pg_catalog, public",
    }, {
      domain: "factory",
      operation: "pinMigrationSearchPath",
      signal,
    });
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
    const fake = executor({ schemaAcl: "ready", schemaOwnership: "owned" });
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
    await expect(runPostgreSqlMigrations(executor({ failOperation: "pinMigrationSearchPath" }).seam, { migrations: [] }))
      .rejects.toThrow("private SQL failure");
  });

  it("fails extension preflight before inspecting or changing the schema", async () => {
    const fake = executor({ failOperation: "preflightRequiredExtensions" });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations: [migration("0001_first")] }))
      .rejects.toThrow("private SQL failure");
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
    ]);
  });

  it.each([
    { label: "missing", postmasterEpoch: null },
    { label: "malformed", postmasterEpoch: 7 },
  ])("fails closed on a $label captured postmaster epoch", async ({ postmasterEpoch }) => {
    await expect(runPostgreSqlMigrations(
      executor({ postmasterEpoch }).seam,
      { migrations: [] },
    )).rejects.toMatchObject({ operation: "capturePostmasterEpoch" });
  });

  it.each([
    { label: "non-UTF8", serverEncoding: "LATIN1", expected: "LATIN1" },
    { label: "missing", serverEncoding: "missing", expected: null },
    { label: "malformed", serverEncoding: 7, expected: null },
    { label: "unsafe", serverEncoding: "UTF8\nprivate", expected: null },
  ])("rejects $label server encoding before extension inspection or DDL", async ({
    serverEncoding,
    expected,
  }) => {
    const fake = executor({ serverEncoding });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlServerEncodingPreflightError);
    expect(failure).toMatchObject({
      operation: "preflightServerEncoding",
      remediation:
        "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.",
      requiredServerEncoding: REQUIRED_POSTGRESQL_SERVER_ENCODING,
      serverEncoding: expected,
    });
    expect((failure as PostgreSqlServerEncodingPreflightError).toJSON()).toMatchObject({
      requiredServerEncoding: "UTF8",
      serverEncoding: expected,
    });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
    ]);
    const encodingSql = (fake.seam.query.mock.calls[1]?.[0] as { text?: string }).text ?? "";
    expect(encodingSql).toBe(
      "SELECT pg_catalog.current_setting('server_encoding') AS server_encoding",
    );
    expect(fake.seam.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { label: "changed", postmasterContinuity: false as const },
    { label: "missing", postmasterContinuity: "missing" as const },
  ])("fails closed when postmaster continuity is $label", async ({ postmasterContinuity }) => {
    await expect(runPostgreSqlMigrations(
      executor({ postmasterContinuity }).seam,
      { migrations: [] },
    )).rejects.toMatchObject({ operation: "verifyPostmasterContinuity" });
  });

  it.each([
    {
      label: "owned by another role",
      schemaOwnership: "unowned" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: "lcm_test_migrator",
      remediation: "Transfer ownership of schema \"lcm\" and its LCM-owned objects to PostgreSQL role \"lcm_test_migrator\", then rerun migrations.",
    },
    {
      label: "missing catalog result",
      schemaOwnership: "missing" as const,
      schemaExists: null,
      ownedByMigrator: null,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "malformed catalog result",
      schemaOwnership: "invalid" as const,
      schemaExists: null,
      ownedByMigrator: null,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "contradictory catalog result",
      schemaOwnership: "inconsistent" as const,
      schemaExists: false,
      ownedByMigrator: true,
      requiredOwner: "lcm_test_migrator",
      remediation: "Transfer ownership of schema \"lcm\" and its LCM-owned objects to PostgreSQL role \"lcm_test_migrator\", then rerun migrations.",
    },
    {
      label: "missing the current user",
      schemaOwnership: "missing-user" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "an empty current user",
      schemaOwnership: "empty-user" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "an overlong current user",
      schemaOwnership: "long-user" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "an unsafe current user",
      schemaOwnership: "unsafe-user" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: null,
      remediation: null,
    },
    {
      label: "a quoted current user",
      schemaOwnership: "quoted-user" as const,
      schemaExists: true,
      ownedByMigrator: false,
      requiredOwner: 'migration"owner',
      remediation: "Transfer ownership of schema \"lcm\" and its LCM-owned objects to PostgreSQL role \"migration\"\"owner\", then rerun migrations.",
    },
  ])("fails closed when schema ownership is $label", async ({
    schemaOwnership,
    schemaExists,
    ownedByMigrator,
    requiredOwner,
    remediation,
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
      requiredOwner,
      remediation,
    });
    expect((failure as PostgreSqlSchemaOwnershipPreflightError).toJSON()).toMatchObject({
      schemaName: "lcm",
      schemaExists,
      ownedByMigrator,
      requiredOwner,
      remediation,
    });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
    ]);
  });

  it.each([
    {
      label: "PUBLIC CREATE",
      schemaAcl: "public" as const,
      schemaExists: true,
      publicCreate: true,
    },
    {
      label: "missing catalog result",
      schemaAcl: "missing" as const,
      schemaExists: null,
      publicCreate: null,
    },
    {
      label: "malformed catalog result",
      schemaAcl: "invalid" as const,
      schemaExists: null,
      publicCreate: null,
    },
    {
      label: "contradictory catalog result",
      schemaAcl: "inconsistent" as const,
      schemaExists: false,
      publicCreate: true,
    },
  ])("fails closed when schema ACL readiness has $label", async ({
    schemaAcl,
    schemaExists,
    publicCreate,
  }) => {
    const fake = executor({ schemaAcl, schemaOwnership: "owned" });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlSchemaAclPreflightError);
    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "preflightSchemaAcl",
      publicCreate,
      remediation: "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;",
      schemaExists,
      schemaName: "lcm",
    });
    expect((failure as PostgreSqlSchemaAclPreflightError).toJSON()).toMatchObject({
      publicCreate,
      remediation: "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;",
      schemaExists,
      schemaName: "lcm",
    });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
      "preflightSchemaAcl",
    ]);
  });

  it.each([
    {
      label: "an unowned managed object",
      managedOwnership: "unowned" as const,
      existingObjectCount: 35,
      unownedObjectCount: 1,
      requiredOwner: "lcm_test_migrator",
    },
    {
      label: "a missing catalog row",
      managedOwnership: "missing" as const,
      existingObjectCount: null,
      unownedObjectCount: null,
      requiredOwner: null,
    },
    {
      label: "malformed catalog values",
      managedOwnership: "invalid" as const,
      existingObjectCount: null,
      unownedObjectCount: null,
      requiredOwner: null,
    },
    {
      label: "contradictory catalog counts",
      managedOwnership: "inconsistent" as const,
      existingObjectCount: 0,
      unownedObjectCount: 1,
      requiredOwner: "lcm_test_migrator",
    },
    {
      label: "a changed current role",
      managedOwnership: "different-user" as const,
      existingObjectCount: 35,
      unownedObjectCount: 0,
      requiredOwner: "different_migrator",
    },
  ])("fails closed when managed ownership reports $label", async ({
    managedOwnership,
    existingObjectCount,
    unownedObjectCount,
    requiredOwner,
  }) => {
    const fake = executor({
      managedOwnership,
      schemaAcl: "ready",
      schemaOwnership: "owned",
    });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlManagedObjectOwnershipPreflightError);
    expect(failure).toMatchObject({
      existingObjectCount,
      operation: "preflightManagedObjectOwnership",
      requiredOwner,
      schemaName: "lcm",
      unownedObjectCount,
    });
    expect((failure as PostgreSqlManagedObjectOwnershipPreflightError).toJSON())
      .toMatchObject({
        existingObjectCount,
        requiredOwner,
        schemaName: "lcm",
        unownedObjectCount,
      });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
      "preflightSchemaAcl",
      "preflightManagedObjectOwnership",
    ]);
    const ownershipCall = fake.seam.query.mock.calls.find(([, context]) => (
      context.operation === "preflightManagedObjectOwnership"
    ));
    const ownershipSql = (ownershipCall?.[0] as { text?: string } | undefined)?.text ?? "";
    for (const catalog of [
      "pg_catalog.pg_class",
      "pg_catalog.pg_proc",
      "pg_catalog.pg_ts_dict",
      "pg_catalog.pg_ts_config",
      "OPERATOR(pg_catalog.=)",
    ]) expect(ownershipSql).toContain(catalog);
  });

  it.each([
    {
      label: "PostgreSQL 17",
      serverVersion: 170006 as const,
      serverVersionNumber: 170006,
      serverMajorVersion: 17,
    },
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
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "lockMigrations",
      "preflightServerVersion",
    ]);
    expect(fake.seam.query.mock.calls.every(([config]) => {
      const text = typeof config === "object"
        && config !== null
        && "text" in config
        && typeof config.text === "string"
        ? config.text
        : "";
      return !text.includes("pg_get_loaded_modules");
    })).toBe(true);
  });
});
