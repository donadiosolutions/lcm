import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlMigration,
  PostgreSqlMigrationResult,
  PostgreSqlQueryExecutor,
} from "./contracts.js";
import { assertRequiredPostgreSqlExtensionsReady } from "./extensions.js";

const MIGRATION_MANIFEST = [
  {
    id: "0001_migration_ledger",
    filename: "0001_migration_ledger.sql",
    sha256: "e2c0f7e366ba291032f6c62436e8db21b3b5bf3589f7f6c889b18a315eb81e63",
  },
  {
    id: "0002_schema_baseline",
    filename: "0002_schema_baseline.sql",
    sha256: "b38237ab861dd2b0d8086d356b1b056ed6359955571515c2eacaf1ecdb0f894e",
  },
] as const;

type MigrationRow = QueryResultRow & { id: string; checksum_sha256: string };
type LedgerRow = QueryResultRow & { ledger_exists: boolean };
type ServerVersionRow = QueryResultRow & { server_version_num: unknown };
type SchemaOwnershipRow = QueryResultRow & {
  schema_exists: unknown;
  owned_by_current_user: unknown;
};

export const REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION = 18 as const;

export class PostgreSqlServerVersionPreflightError extends StorageOperationError {
  constructor(
    readonly serverVersionNumber: number | null,
    readonly serverMajorVersion: number | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightServerVersion",
    );
  }

  readonly requiredServerMajorVersion = REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      serverVersionNumber: this.serverVersionNumber,
      serverMajorVersion: this.serverMajorVersion,
      requiredServerMajorVersion: this.requiredServerMajorVersion,
    };
  }
}

export class PostgreSqlSchemaOwnershipPreflightError extends StorageOperationError {
  constructor(
    readonly schemaExists: boolean | null,
    readonly ownedByMigrator: boolean | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSchemaOwnership",
    );
  }

  readonly schemaName = "lcm";
  readonly requiredOwner = "migration-role";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      schemaExists: this.schemaExists,
      ownedByMigrator: this.ownedByMigrator,
      requiredOwner: this.requiredOwner,
    };
  }
}

function sanitizeServerVersionNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function migrationError(operation: string): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_INITIALIZATION_FAILED",
    "postgresql",
    undefined,
    "factory",
    operation,
  );
}

export function loadPostgreSqlMigrations(
  readMigration: typeof readFileSync = readFileSync,
): PostgreSqlMigration[] {
  return MIGRATION_MANIFEST.map((entry) => {
    let sql: string;
    try {
      sql = readMigration(new URL(`./migrations/${entry.filename}`, import.meta.url), "utf8");
    } catch {
      throw migrationError("loadMigrations");
    }
    const sha256 = createHash("sha256").update(sql).digest("hex");
    if (sha256 !== entry.sha256) throw migrationError("verifyMigrationArtifact");
    return { ...entry, sql };
  });
}

function validateMigrations(migrations: readonly PostgreSqlMigration[]): void {
  let previous = "";
  const ids = new Set<string>();
  for (const migration of migrations) {
    const actual = createHash("sha256").update(migration.sql).digest("hex");
    if (
      !/^[0-9]{4}_[a-z0-9_]+$/u.test(migration.id)
      || ids.has(migration.id)
      || migration.id <= previous
      || migration.sha256 !== actual
    ) {
      throw migrationError("validateMigrations");
    }
    ids.add(migration.id);
    previous = migration.id;
  }
}

export async function runPostgreSqlMigrations(
  executor: PostgreSqlQueryExecutor & {
    transaction<T>(
      callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
      options: { domain: "factory"; operation: string; signal?: AbortSignal },
    ): Promise<T>;
  },
  options: { migrations?: readonly PostgreSqlMigration[]; signal?: AbortSignal } = {},
): Promise<PostgreSqlMigrationResult> {
  const migrations = [...(options.migrations ?? loadPostgreSqlMigrations())];
  validateMigrations(migrations);
  return executor.transaction(async (transaction) => {
    await transaction.query({
      text: "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':lcm:migrations', 0))",
    }, { domain: "factory", operation: "lockMigrations", signal: options.signal });

    const serverVersion = await transaction.query<ServerVersionRow>({
      text: "SELECT current_setting('server_version_num')::integer AS server_version_num",
    }, { domain: "factory", operation: "preflightServerVersion", signal: options.signal });
    const serverVersionNumber = sanitizeServerVersionNumber(
      serverVersion.rows[0]?.server_version_num,
    );
    const serverMajorVersion = serverVersionNumber === null
      ? null
      : Math.floor(serverVersionNumber / 10_000);
    if (serverMajorVersion !== REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION) {
      throw new PostgreSqlServerVersionPreflightError(
        serverVersionNumber,
        serverMajorVersion,
      );
    }

    await assertRequiredPostgreSqlExtensionsReady(transaction, { signal: options.signal });

    const schemaOwnership = await transaction.query<SchemaOwnershipRow>({
      text: `SELECT
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace
          WHERE nspname = 'lcm'
        ) AS schema_exists,
        COALESCE((
          SELECT namespace.nspowner = role.oid
          FROM pg_catalog.pg_namespace AS namespace
          INNER JOIN pg_catalog.pg_roles AS role ON role.rolname = CURRENT_USER
          WHERE namespace.nspname = 'lcm'
        ), false) AS owned_by_current_user`,
    }, { domain: "factory", operation: "preflightSchemaOwnership", signal: options.signal });
    const schemaExists = sanitizeBoolean(schemaOwnership.rows[0]?.schema_exists);
    const ownedByMigrator = sanitizeBoolean(schemaOwnership.rows[0]?.owned_by_current_user);
    const ownershipReady = (schemaExists === false && ownedByMigrator === false)
      || (schemaExists === true && ownedByMigrator === true);
    if (!ownershipReady) {
      throw new PostgreSqlSchemaOwnershipPreflightError(schemaExists, ownedByMigrator);
    }

    const ledger = await transaction.query<LedgerRow>({
      text: "SELECT to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger_exists",
    }, { domain: "factory", operation: "inspectMigrationLedger", signal: options.signal });
    const current = ledger.rows[0]?.ledger_exists
      ? (await transaction.query<MigrationRow>({
        text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id",
      }, { domain: "factory", operation: "readMigrations", signal: options.signal })).rows
      : [];

    if (current.length > migrations.length) throw migrationError("verifyMigrationHistory");
    for (let index = 0; index < current.length; index += 1) {
      const expected = migrations[index];
      const applied = current[index];
      if (!expected || applied.id !== expected.id || applied.checksum_sha256 !== expected.sha256) {
        throw migrationError("verifyMigrationHistory");
      }
    }

    const applied: string[] = [];
    for (const migration of migrations.slice(current.length)) {
      await transaction.query({ text: migration.sql }, {
        domain: "factory",
        operation: `applyMigration:${migration.id}`,
        signal: options.signal,
      });
      await transaction.query({
        text: "INSERT INTO lcm.schema_migrations (id, checksum_sha256) VALUES ($1, $2)",
        values: [migration.id, migration.sha256],
      }, { domain: "factory", operation: "recordMigration", signal: options.signal });
      applied.push(migration.id);
    }
    return {
      applied,
      current: migrations.map((migration) => migration.id),
    };
  }, { domain: "factory", operation: "migrate", signal: options.signal });
}
