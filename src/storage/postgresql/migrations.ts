import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlMigration,
  PostgreSqlMigrationResult,
  PostgreSqlQueryExecutor,
} from "./contracts.js";
import {
  assertRequiredPostgreSqlExtensionCatalogReady,
  assertRequiredPostgreSqlExtensionsReady,
} from "./extensions.js";
import { assertPostgreSqlSearchConfigurationReady } from "./search-configuration.js";

const MIGRATION_MANIFEST = [
  {
    id: "0001_migration_ledger",
    filename: "0001_migration_ledger.sql",
    sha256: "e2c0f7e366ba291032f6c62436e8db21b3b5bf3589f7f6c889b18a315eb81e63",
  },
  {
    id: "0002_schema_baseline",
    filename: "0002_schema_baseline.sql",
    sha256: "c97d053f16663197dadea1fb67823a5a05e3bdf3bfe3b6113003aaf16c77a276",
  },
] as const;

type MigrationRow = QueryResultRow & { id: string; checksum_sha256: string };
type LedgerRow = QueryResultRow & { ledger_exists: boolean };
type ServerVersionRow = QueryResultRow & { server_version_num: unknown };
type PostmasterEpochRow = QueryResultRow & { postmaster_started_at: Date | string };
type PostmasterContinuityRow = QueryResultRow & { preflight_still_valid: boolean };
type SchemaOwnershipRow = QueryResultRow & {
  current_user_name: unknown;
  schema_exists: unknown;
  owned_by_current_user: unknown;
};
type SchemaAclRow = QueryResultRow & {
  schema_exists: unknown;
  public_create: unknown;
};
type ServerEncodingRow = QueryResultRow & { server_encoding: unknown };
type ManagedObjectOwnershipRow = QueryResultRow & {
  current_user_name: unknown;
  baseline_applied: unknown;
  expected_object_count: unknown;
  existing_object_count: unknown;
  missing_object_count: unknown;
  unowned_object_count: unknown;
};
type IdentityFunctionFingerprintRow = QueryResultRow & {
  baseline_applied: unknown;
  expected_function_count: unknown;
  existing_function_count: unknown;
  drifted_function_count: unknown;
};

export const REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION = 18 as const;
export const REQUIRED_POSTGRESQL_SERVER_ENCODING = "UTF8" as const;

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

export class PostgreSqlServerEncodingPreflightError extends StorageOperationError {
  constructor(
    readonly serverEncoding: string | null,
    operation = "preflightServerEncoding",
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      operation,
    );
  }

  readonly requiredServerEncoding = REQUIRED_POSTGRESQL_SERVER_ENCODING;
  readonly remediation =
    "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      serverEncoding: this.serverEncoding,
      requiredServerEncoding: this.requiredServerEncoding,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSchemaOwnershipPreflightError extends StorageOperationError {
  constructor(
    readonly schemaExists: boolean | null,
    readonly ownedByMigrator: boolean | null,
    readonly requiredOwner: string | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSchemaOwnership",
    );
    this.remediation = requiredOwner === null
      ? null
      : `Transfer ownership of schema "lcm" and its LCM-owned objects to PostgreSQL role ${quoteIdentifier(requiredOwner)}, then rerun migrations.`;
  }

  readonly schemaName = "lcm";
  readonly remediation: string | null;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      schemaExists: this.schemaExists,
      ownedByMigrator: this.ownedByMigrator,
      requiredOwner: this.requiredOwner,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlManagedObjectOwnershipPreflightError extends StorageOperationError {
  constructor(
    readonly baselineApplied: boolean | null,
    readonly expectedObjectCount: number | null,
    readonly existingObjectCount: number | null,
    readonly missingObjectCount: number | null,
    readonly unownedObjectCount: number | null,
    readonly requiredOwner: string | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightManagedObjectOwnership",
    );
    this.remediation = missingObjectCount !== null && missingObjectCount > 0
      ? "Restore every missing LCM-managed object from the matching packaged migration artifact or a verified backup, then rerun migrations."
      : requiredOwner === null
        ? null
        : `Transfer ownership of every LCM-managed object in schema "lcm" to PostgreSQL role ${quoteIdentifier(requiredOwner)}, then rerun migrations.`;
  }

  readonly schemaName = "lcm";
  readonly remediation: string | null;

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      baselineApplied: this.baselineApplied,
      expectedObjectCount: this.expectedObjectCount,
      existingObjectCount: this.existingObjectCount,
      missingObjectCount: this.missingObjectCount,
      unownedObjectCount: this.unownedObjectCount,
      requiredOwner: this.requiredOwner,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlIdentityFunctionPreflightError extends StorageOperationError {
  constructor(
    readonly baselineApplied: boolean | null,
    readonly expectedFunctionCount: number | null,
    readonly existingFunctionCount: number | null,
    readonly driftedFunctionCount: number | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightIdentityFunctionDefinitions",
    );
  }

  readonly schemaName = "lcm";
  readonly remediation =
    "Restore the packaged LCM identity-enforcement functions and their security configuration, then rerun migrations.";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      baselineApplied: this.baselineApplied,
      expectedFunctionCount: this.expectedFunctionCount,
      existingFunctionCount: this.existingFunctionCount,
      driftedFunctionCount: this.driftedFunctionCount,
      remediation: this.remediation,
    };
  }
}

export class PostgreSqlSchemaAclPreflightError extends StorageOperationError {
  constructor(
    readonly schemaExists: boolean | null,
    readonly publicCreate: boolean | null,
  ) {
    super(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "preflightSchemaAcl",
    );
  }

  readonly schemaName = "lcm";
  readonly remediation = "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;";

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      schemaName: this.schemaName,
      schemaExists: this.schemaExists,
      publicCreate: this.publicCreate,
      remediation: this.remediation,
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

function sanitizeNonnegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function sanitizePostgreSqlServerEncoding(value: unknown): string | null {
  return typeof value === "string"
    && /^[A-Z0-9_-]{1,32}$/u.test(value)
    ? value
    : null;
}

function sanitizeRoleName(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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
  // The functional pg_stat_statements probe can raise SQLSTATE 55000 when the
  // library was not preloaded. Run it before opening the all-or-nothing DDL
  // transaction so that expected readiness failure cannot poison that scope.
  const postmasterEpoch = await executor.query<PostmasterEpochRow>({
    text: "SELECT pg_catalog.pg_postmaster_start_time()::text AS postmaster_started_at",
  }, { domain: "factory", operation: "capturePostmasterEpoch", signal: options.signal });
  const postmasterStartedAt = postmasterEpoch.rows[0]?.postmaster_started_at;
  if (!(postmasterStartedAt instanceof Date) && typeof postmasterStartedAt !== "string") {
    throw migrationError("capturePostmasterEpoch");
  }
  const serverEncodingResult = await executor.query<ServerEncodingRow>({
    text: "SELECT pg_catalog.current_setting('server_encoding') AS server_encoding",
  }, { domain: "factory", operation: "preflightServerEncoding", signal: options.signal });
  const serverEncoding = sanitizePostgreSqlServerEncoding(
    serverEncodingResult.rows[0]?.server_encoding,
  );
  if (serverEncoding !== REQUIRED_POSTGRESQL_SERVER_ENCODING) {
    throw new PostgreSqlServerEncodingPreflightError(serverEncoding);
  }
  await assertRequiredPostgreSqlExtensionsReady(executor, { signal: options.signal });
  return executor.transaction(async (transaction) => {
    await transaction.query({
      text: "SET LOCAL search_path = pg_catalog, public",
    }, { domain: "factory", operation: "pinMigrationSearchPath", signal: options.signal });

    await transaction.query({
      text: `SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          pg_catalog.current_database() OPERATOR(pg_catalog.||) ':lcm:migrations',
          0
        )
      )`,
    }, { domain: "factory", operation: "lockMigrations", signal: options.signal });

    const serverVersion = await transaction.query<ServerVersionRow>({
      text: "SELECT pg_catalog.current_setting('server_version_num')::integer AS server_version_num",
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

    const continuity = await transaction.query<PostmasterContinuityRow>({
      text: `SELECT
               pg_catalog.pg_postmaster_start_time()::text OPERATOR(pg_catalog.=) $1::text
               AND EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_get_loaded_modules() AS loaded
                 WHERE loaded.module_name OPERATOR(pg_catalog.=) 'pg_stat_statements'
                    OR loaded.file_name OPERATOR(pg_catalog.~)
                      '(^|/)pg_stat_statements([.][^/]*)?$'
               ) AS preflight_still_valid`,
      values: [postmasterStartedAt],
    }, { domain: "factory", operation: "verifyPostmasterContinuity", signal: options.signal });
    if (continuity.rows[0]?.preflight_still_valid !== true) {
      throw migrationError("verifyPostmasterContinuity");
    }

    await assertRequiredPostgreSqlExtensionCatalogReady(transaction, {
      operation: "revalidateRequiredExtensionCatalog",
      pgStatStatementsPreloaded: true,
      signal: options.signal,
    });

    const schemaOwnership = await transaction.query<SchemaOwnershipRow>({
      text: `SELECT
        CURRENT_USER::text AS current_user_name,
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
    const requiredOwner = sanitizeRoleName(schemaOwnership.rows[0]?.current_user_name);
    const ownershipReady = requiredOwner !== null
      && ((schemaExists === false && ownedByMigrator === false)
        || (schemaExists === true && ownedByMigrator === true));
    if (!ownershipReady) {
      throw new PostgreSqlSchemaOwnershipPreflightError(
        schemaExists,
        ownedByMigrator,
        requiredOwner,
      );
    }

    const schemaAcl = await transaction.query<SchemaAclRow>({
      text: `SELECT
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
        ) AS schema_exists,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              namespace.nspacl,
              pg_catalog.acldefault('n', namespace.nspowner)
            )
          ) AS privilege
          WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
            AND privilege.grantee OPERATOR(pg_catalog.=) 0
            AND privilege.privilege_type OPERATOR(pg_catalog.=) 'CREATE'
        ) AS public_create`,
    }, { domain: "factory", operation: "preflightSchemaAcl", signal: options.signal });
    const aclSchemaExists = sanitizeBoolean(schemaAcl.rows[0]?.schema_exists);
    const publicCreate = sanitizeBoolean(schemaAcl.rows[0]?.public_create);
    if (
      aclSchemaExists === null
      || publicCreate === null
      || aclSchemaExists !== schemaExists
      || (aclSchemaExists === false && publicCreate !== false)
      || publicCreate
    ) {
      throw new PostgreSqlSchemaAclPreflightError(aclSchemaExists, publicCreate);
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
    const baselineApplied = current.some(({ id }) => id === "0002_schema_baseline");

    const managedOwnership = await transaction.query<ManagedObjectOwnershipRow>({
      text: `WITH migration_role AS (
               SELECT role.oid
               FROM pg_catalog.pg_roles AS role
               WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER
             ),
             managed_objects(owner_oid) AS (
               SELECT relation.relowner
               FROM pg_catalog.pg_class AS relation
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
               WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                 AND (
                   (
                     relation.relkind OPERATOR(pg_catalog.=) 'r'
                     AND relation.relname OPERATOR(pg_catalog.=) ANY (
                       ARRAY[
                         'schema_migrations', 'machines', 'projects', 'project_aliases',
                         'conversations', 'messages', 'message_parts', 'native_transcripts',
                         'transcript_messages', 'summaries', 'summary_messages',
                         'summary_parents', 'context_items', 'large_files',
                         'summary_large_files', 'promoted_memories', 'promoted_memory_tags',
                         'recall_surfacing', 'redaction_counters', 'ingest_checkpoints',
                         'session_ingest_log', 'session_instructions', 'passive_event_inbox',
                         'fenced_leases'
                       ]::pg_catalog.text[]
                     )
                   )
                   OR (
                     relation.relkind OPERATOR(pg_catalog.=) 'S'
                     AND relation.relname OPERATOR(pg_catalog.=) ANY (
                       ARRAY[
                         'conversations_conversation_id_seq',
                         'messages_message_id_seq',
                         'recall_surfacing_surfacing_id_seq',
                         'session_instructions_instruction_id_seq',
                         'passive_event_inbox_inbox_id_seq',
                         'fenced_leases_fencing_token_seq'
                       ]::pg_catalog.text[]
                     )
                   )
                 )
               UNION ALL
               SELECT procedure.proowner
               FROM pg_catalog.pg_proc AS procedure
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
               WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                 AND procedure.prokind OPERATOR(pg_catalog.=) 'f'
                 AND (
                   (
                     procedure.proname OPERATOR(pg_catalog.=) 'normalize_search_text'
                     AND procedure.pronargs OPERATOR(pg_catalog.=) 1
                     AND procedure.proargtypes[0] OPERATOR(pg_catalog.=)
                       pg_catalog.to_regtype('pg_catalog.text')
                   )
                   OR (
                     procedure.proname OPERATOR(pg_catalog.=)
                       'enforce_summary_id_uniqueness'
                     AND procedure.pronargs OPERATOR(pg_catalog.=) 0
                   )
                   OR (
                     procedure.proname OPERATOR(pg_catalog.=)
                       'enforce_large_file_id_uniqueness'
                     AND procedure.pronargs OPERATOR(pg_catalog.=) 0
                   )
                   OR (
                     procedure.proname OPERATOR(pg_catalog.=)
                       'enforce_session_ingest_id_uniqueness'
                     AND procedure.pronargs OPERATOR(pg_catalog.=) 0
                   )
                 )
               UNION ALL
               SELECT dictionary.dictowner
               FROM pg_catalog.pg_ts_dict AS dictionary
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid OPERATOR(pg_catalog.=) dictionary.dictnamespace
               WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                 AND dictionary.dictname OPERATOR(pg_catalog.=) 'simple_v1'
               UNION ALL
               SELECT configuration.cfgowner
               FROM pg_catalog.pg_ts_config AS configuration
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid OPERATOR(pg_catalog.=) configuration.cfgnamespace
               WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                 AND configuration.cfgname OPERATOR(pg_catalog.=) 'search_v1'
             )
             SELECT CURRENT_USER::pg_catalog.text AS current_user_name,
                    $1::pg_catalog.bool AS baseline_applied,
                    36::pg_catalog.int4 AS expected_object_count,
                    pg_catalog.count(*)::pg_catalog.int4 AS existing_object_count,
                    CASE
                      WHEN $1::pg_catalog.bool
                        THEN (36 - pg_catalog.count(*))::pg_catalog.int4
                      ELSE 0::pg_catalog.int4
                    END AS missing_object_count,
                    pg_catalog.count(*) FILTER (
                      WHERE managed_objects.owner_oid OPERATOR(pg_catalog.<>) migration_role.oid
                    )::pg_catalog.int4 AS unowned_object_count
             FROM managed_objects
             CROSS JOIN migration_role`,
      values: [baselineApplied],
    }, {
      domain: "factory",
      operation: "preflightManagedObjectOwnership",
      signal: options.signal,
    });
    const catalogBaselineApplied = sanitizeBoolean(
      managedOwnership.rows[0]?.baseline_applied,
    );
    const expectedObjectCount = sanitizeNonnegativeCount(
      managedOwnership.rows[0]?.expected_object_count,
    );
    const existingObjectCount = sanitizeNonnegativeCount(
      managedOwnership.rows[0]?.existing_object_count,
    );
    const missingObjectCount = sanitizeNonnegativeCount(
      managedOwnership.rows[0]?.missing_object_count,
    );
    const unownedObjectCount = sanitizeNonnegativeCount(
      managedOwnership.rows[0]?.unowned_object_count,
    );
    const managedRequiredOwner = sanitizeRoleName(
      managedOwnership.rows[0]?.current_user_name,
    );
    if (
      catalogBaselineApplied === null
      || catalogBaselineApplied !== baselineApplied
      || expectedObjectCount !== 36
      || existingObjectCount === null
      || missingObjectCount === null
      || unownedObjectCount === null
      || (baselineApplied && existingObjectCount + missingObjectCount !== expectedObjectCount)
      || (!baselineApplied && missingObjectCount !== 0)
      || missingObjectCount !== 0
      || unownedObjectCount > existingObjectCount
      || unownedObjectCount !== 0
      || managedRequiredOwner === null
      || managedRequiredOwner !== requiredOwner
    ) {
      throw new PostgreSqlManagedObjectOwnershipPreflightError(
        catalogBaselineApplied,
        expectedObjectCount,
        existingObjectCount,
        missingObjectCount,
        unownedObjectCount,
        managedRequiredOwner,
      );
    }

    const identityFunctionFingerprints =
      await transaction.query<IdentityFunctionFingerprintRow>({
        text: `WITH expected_functions(function_name, prosrc_sha256) AS (
                 VALUES
                   (
                     'enforce_summary_id_uniqueness'::pg_catalog.text,
                     '588b89ccad1812592ae24358f0096205dc87613a7d7fe73b28dc544d089f0210'::pg_catalog.text
                   ),
                   (
                     'enforce_large_file_id_uniqueness'::pg_catalog.text,
                     '88a8ec57d47017294c1532788dafc3e89fc406887e92338f89b3dc24033906ac'::pg_catalog.text
                   ),
                   (
                     'enforce_session_ingest_id_uniqueness'::pg_catalog.text,
                     '99df5c443c85f2620ed281c2b05ba4a18af4cfd8c1cd408671af3f7d0f9bed22'::pg_catalog.text
                   )
               ),
               actual_functions AS (
                 SELECT procedure.proname AS function_name,
                        procedure.oid AS function_oid,
                        procedure.prosrc,
                        procedure.prosecdef,
                        procedure.proleakproof,
                        procedure.provolatile,
                        procedure.proparallel,
                        procedure.proconfig,
                        language.lanname,
                        procedure.prorettype,
                        EXISTS (
                          SELECT 1
                          FROM pg_catalog.aclexplode(
                            COALESCE(
                              procedure.proacl,
                              pg_catalog.acldefault('f', procedure.proowner)
                            )
                          ) AS privilege
                          WHERE privilege.grantee OPERATOR(pg_catalog.=) 0
                            AND privilege.privilege_type OPERATOR(pg_catalog.=) 'EXECUTE'
                        ) AS public_execute
                 FROM pg_catalog.pg_proc AS procedure
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid OPERATOR(pg_catalog.=) procedure.pronamespace
                 JOIN pg_catalog.pg_language AS language
                   ON language.oid OPERATOR(pg_catalog.=) procedure.prolang
                 WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                   AND procedure.prokind OPERATOR(pg_catalog.=) 'f'
                   AND procedure.pronargs OPERATOR(pg_catalog.=) 0
                   AND procedure.proname OPERATOR(pg_catalog.=) ANY (
                     ARRAY[
                       'enforce_summary_id_uniqueness',
                       'enforce_large_file_id_uniqueness',
                       'enforce_session_ingest_id_uniqueness'
                     ]::pg_catalog.text[]
                   )
               )
               SELECT $1::pg_catalog.bool AS baseline_applied,
                      pg_catalog.count(*)::pg_catalog.int4 AS expected_function_count,
                      pg_catalog.count(actual_functions.function_oid)::pg_catalog.int4
                        AS existing_function_count,
                      CASE
                        WHEN $1::pg_catalog.bool THEN pg_catalog.count(*) FILTER (
                          WHERE actual_functions.function_oid IS NULL
                            OR pg_catalog.encode(
                              public.digest(actual_functions.prosrc, 'sha256'),
                              'hex'
                            ) OPERATOR(pg_catalog.<>) expected_functions.prosrc_sha256
                            OR actual_functions.lanname OPERATOR(pg_catalog.<>) 'plpgsql'
                            OR actual_functions.prorettype OPERATOR(pg_catalog.<>)
                              pg_catalog.to_regtype('pg_catalog.trigger')
                            OR actual_functions.prosecdef
                            OR actual_functions.proleakproof
                            OR actual_functions.provolatile OPERATOR(pg_catalog.<>) 'v'
                            OR actual_functions.proparallel OPERATOR(pg_catalog.<>) 'u'
                            OR actual_functions.proconfig IS DISTINCT FROM
                              ARRAY['search_path=pg_catalog, public']::pg_catalog.text[]
                            OR actual_functions.public_execute
                        )::pg_catalog.int4
                        ELSE 0::pg_catalog.int4
                      END AS drifted_function_count
               FROM expected_functions
               LEFT JOIN actual_functions USING (function_name)`,
        values: [baselineApplied],
      }, {
        domain: "factory",
        operation: "preflightIdentityFunctionDefinitions",
        signal: options.signal,
      });
    const fingerprintBaselineApplied = sanitizeBoolean(
      identityFunctionFingerprints.rows[0]?.baseline_applied,
    );
    const expectedFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.expected_function_count,
    );
    const existingFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.existing_function_count,
    );
    const driftedFunctionCount = sanitizeNonnegativeCount(
      identityFunctionFingerprints.rows[0]?.drifted_function_count,
    );
    if (
      fingerprintBaselineApplied === null
      || fingerprintBaselineApplied !== baselineApplied
      || expectedFunctionCount !== 3
      || existingFunctionCount === null
      || existingFunctionCount > expectedFunctionCount
      || driftedFunctionCount === null
      || driftedFunctionCount > expectedFunctionCount
      || driftedFunctionCount !== 0
    ) {
      throw new PostgreSqlIdentityFunctionPreflightError(
        fingerprintBaselineApplied,
        expectedFunctionCount,
        existingFunctionCount,
        driftedFunctionCount,
      );
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
    await assertPostgreSqlSearchConfigurationReady(transaction, { signal: options.signal });
    return {
      applied,
      current: migrations.map((migration) => migration.id),
    };
  }, { domain: "factory", operation: "migrate", signal: options.signal });
}
