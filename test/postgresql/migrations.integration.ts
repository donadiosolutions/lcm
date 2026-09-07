import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Client,
  type DatabaseError,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadPostgreSqlMigrations,
  loadPostgreSqlSchemaSnapshots,
  PostgreSqlBaselineDefinitionPreflightError,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";
import type {
  PostgreSqlMigration,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST,
  verifyPostgreSqlRuntimeSchema,
} from "../../src/storage/postgresql/runtime-readiness.js";
import {
  PostgreSqlRuntime,
  POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES,
} from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  createPostgreSqlTestDatabase,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
  writePostgreSqlBaselineDefinitionFingerprints,
} from "./harness.js";

beforeAll(assertHarnessReady);

function migration(id: string, sql: string): PostgreSqlMigration {
  return {
    id,
    filename: `${id}.sql`,
    sql,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}

const ledgerSql = `CREATE SCHEMA IF NOT EXISTS lcm;
CREATE TABLE IF NOT EXISTS lcm.schema_migrations (
  id text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);`;

const REQUIRED_RUNTIME_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
] as const;

const OPTIONAL_RUNTIME_GRANT_SCRIPT = "postgresql-runtime-transcript-grants.sql";

async function applyRuntimeGrantScripts(
  database: PostgreSqlTestDatabase,
  options: {
    readonly includeTranscript?: boolean;
    readonly omit?: readonly string[];
  } = {},
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  const scripts = options.includeTranscript === true
    ? [...REQUIRED_RUNTIME_GRANT_SCRIPTS, OPTIONAL_RUNTIME_GRANT_SCRIPT]
    : REQUIRED_RUNTIME_GRANT_SCRIPTS;
  try {
    for (const script of scripts) {
      if (options.omit?.includes(script)) continue;
      const template = readFileSync(
        join(process.cwd(), "src", "storage", "postgresql", "reference", script),
        "utf8",
      );
      const sql = template
        .split("\n")
        .filter((line) => !line.startsWith("\\"))
        .join("\n")
        .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
      await administrator.query({ text: sql }, {
        domain: "factory",
        operation: `applyRuntimeGrantScript:${script}`,
      });
    }
  } finally {
    await administrator.close();
  }
}

async function readCurrentDatabaseOwner(administrator: PostgreSqlRuntime): Promise<string> {
  const result = await administrator.query<{ database_owner: string }>({
    text: `SELECT pg_catalog.pg_get_userbyid(database.datdba)::text AS database_owner
           FROM pg_catalog.pg_database AS database
           WHERE database.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`,
  }, { domain: "factory", operation: "readCurrentDatabaseOwner" });
  const owner = result.rows.length === 1 ? result.rows[0]?.database_owner : undefined;
  if (typeof owner !== "string") throw new Error("PostgreSQL database owner readback failed");
  return owner;
}

interface IndexCatalogState extends QueryResultRow {
  readonly object_name: string;
  readonly definition: string;
  readonly indisvalid: boolean;
  readonly indisready: boolean;
  readonly indislive: boolean;
}

interface ManagedIndexInventoryState extends QueryResultRow {
  readonly index_count: number;
  readonly index_sha256: string;
  readonly invalid_index_count: number;
}

async function waitForInvalidReadyLiveIndex(
  observer: PostgreSqlRuntime,
  indexName: string,
): Promise<IndexCatalogState> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await readIndexCatalogState(
      observer,
      indexName,
      "waitForInvalidReadyLiveIndex",
    );
    if (
      row?.indisvalid === false
      && row.indisready === true
      && row.indislive === true
    ) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for invalid ready live PostgreSQL index");
}

async function readIndexCatalogState(
  observer: PostgreSqlRuntime,
  indexName: string,
  operation: string,
): Promise<IndexCatalogState | null> {
  const state = await observer.query<IndexCatalogState>({
    text: `SELECT index_relation.relname AS object_name,
                    pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
                    index_metadata.indisvalid,
                    index_metadata.indisready,
                    index_metadata.indislive
             FROM pg_catalog.pg_index AS index_metadata
             JOIN pg_catalog.pg_class AS index_relation
               ON index_relation.oid OPERATOR(pg_catalog.=) index_metadata.indexrelid
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=) index_relation.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND index_relation.relname OPERATOR(pg_catalog.=) $1`,
      values: [indexName],
  }, { domain: "factory", operation });
  if (state.rows.length === 0) return null;
  const row = state.rows[0];
  if (
    state.rows.length !== 1
    || row === undefined
    || row.object_name !== indexName
    || typeof row.definition !== "string"
    || typeof row.indisvalid !== "boolean"
    || typeof row.indisready !== "boolean"
    || typeof row.indislive !== "boolean"
  ) {
    throw new Error("invalid PostgreSQL index catalog fixture state");
  }
  return row;
}

async function readManagedIndexInventory(
  observer: PostgreSqlRuntime,
  managedTableNames: readonly string[],
  operation: string,
): Promise<ManagedIndexInventoryState> {
  const result = await observer.query<ManagedIndexInventoryState>({
    text: `WITH actual_indexes AS (
             SELECT index_relation.relname AS object_name,
                    pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
                    index_metadata.indisvalid AS is_valid
             FROM pg_catalog.pg_class AS index_relation
             JOIN pg_catalog.pg_index AS index_metadata
               ON index_metadata.indexrelid OPERATOR(pg_catalog.=) index_relation.oid
             JOIN pg_catalog.pg_namespace AS index_namespace
               ON index_namespace.oid OPERATOR(pg_catalog.=) index_relation.relnamespace
             JOIN pg_catalog.pg_class AS relation
               ON relation.oid OPERATOR(pg_catalog.=) index_metadata.indrelid
             JOIN pg_catalog.pg_namespace AS relation_namespace
               ON relation_namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
             WHERE index_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation_namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND relation.relkind OPERATOR(pg_catalog.=) ANY (
                 ARRAY['r', 'p']::pg_catalog."char"[]
               )
               AND index_relation.relkind OPERATOR(pg_catalog.=) 'i'
               AND index_metadata.indisready
               AND index_metadata.indislive
               AND relation.relname OPERATOR(pg_catalog.=) ANY ($1::pg_catalog.text[])
           )
           SELECT pg_catalog.count(*)::pg_catalog.int4 AS index_count,
                  pg_catalog.encode(public.digest(COALESCE(pg_catalog.string_agg(
                    pg_catalog.concat_ws('|', object_name, definition),
                    E'\\n' ORDER BY object_name
                  ), ''), 'sha256'), 'hex') AS index_sha256,
                  pg_catalog.count(*) FILTER (
                    WHERE actual_indexes.is_valid IS DISTINCT FROM true
                  )::pg_catalog.int4 AS invalid_index_count
           FROM actual_indexes`,
    values: [managedTableNames],
  }, { domain: "factory", operation });
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row === undefined
    || !Number.isSafeInteger(row.index_count)
    || row.index_count < 0
    || !/^[0-9a-f]{64}$/u.test(row.index_sha256)
    || !Number.isSafeInteger(row.invalid_index_count)
    || row.invalid_index_count < 0
  ) {
    throw new Error("invalid managed-index inventory fixture state");
  }
  return row;
}

async function waitForSummaryMigrationRelationLock(
  admin: PostgreSqlRuntime,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await admin.query<{ blocked: boolean }>({
      text: `SELECT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_stat_activity
               WHERE datname OPERATOR(pg_catalog.=)
                   pg_catalog.current_database()
                 AND usename OPERATOR(pg_catalog.=) 'lcm_test_migrator'
                 AND state OPERATOR(pg_catalog.=) 'active'
                 AND wait_event_type OPERATOR(pg_catalog.=) 'Lock'
                 AND query LIKE
                   '%LOCK TABLE lcm.summary_parents IN SHARE ROW EXCLUSIVE MODE%'
             ) AS blocked`,
    }, { domain: "factory", operation: "waitForSummaryMigrationRelationLock" });
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("summary integrity migration did not wait on its relation lock");
}

async function applySummaryContextRuntimeGrant(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(
      process.cwd(),
      "src",
      "storage",
      "postgresql",
      "reference",
      "postgresql-runtime-summary-context-grants.sql",
    ),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "factory",
    operation: "applySummaryContextRuntimeGrantBeforeMigration",
  });
}

async function applyCoordinationRuntimeGrant(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(
      process.cwd(),
      "src",
      "storage",
      "postgresql",
      "reference",
      "postgresql-runtime-coordination-grants.sql",
    ),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "factory",
    operation: "applyCoordinationRuntimeGrantBeforeMigration",
  });
}

async function executeRawMigrationExpectingFailure(
  database: PostgreSqlTestDatabase,
  pending: PostgreSqlMigration,
): Promise<DatabaseError> {
  const client = new Client(
    POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(
      settings(database.migratorUrl),
    ),
  );
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(pending.sql);
      throw new Error("damaged summary graph unexpectedly passed migration");
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        !(error instanceof Error)
        || !("code" in error)
        || typeof error.code !== "string"
      ) {
        throw error;
      }
      return error as DatabaseError;
    }
  } finally {
    await client.end();
  }
}

describe("PostgreSQL migrations and database isolation", () => {
  it.each([
    { label: "without transcript grants", includeTranscript: false },
    { label: "with transcript grants", includeTranscript: true },
  ])("verifies PG18 runtime readiness $label", async ({ label, includeTranscript }) => {
    await withPostgreSqlTestDatabase(
      `runtime-readiness-${label}`,
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database, { includeTranscript });

        const readiness = await verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        });
        const version = await database.runtime.query<{
          server_version_num: number;
          server_encoding: string;
          timezone: string;
          role: string;
          tls: boolean;
        }>({
          text: `SELECT
                   pg_catalog.current_setting('server_version_num')::integer
                     AS server_version_num,
                   pg_catalog.current_setting('server_encoding') AS server_encoding,
                   pg_catalog.current_setting('TimeZone') AS timezone,
                   CURRENT_USER::text AS role,
                   COALESCE((
                     SELECT ssl
                     FROM pg_catalog.pg_stat_ssl
                     WHERE pid = pg_catalog.pg_backend_pid()
                   ), false) AS tls`,
        }, { domain: "factory", operation: "verifyRuntimeReadinessWitness" });
        expect(version.rows).toEqual([{
          server_version_num: expect.any(Number),
          server_encoding: "UTF8",
          timezone: "UTC",
          role: "lcm_test_runtime",
          tls: true,
        }]);
        expect(Math.floor(version.rows[0]!.server_version_num / 10_000)).toBe(18);

        const expectedMigrationIds = loadPostgreSqlMigrations().map(({ id }) => id);
        expect(readiness).toMatchObject({
          currentMigrationIds: expectedMigrationIds,
          expectedOwner: "lcm_test_migrator",
          runtimeRole: "lcm_test_runtime",
          managedObjectCount: expect.any(Number),
          definitionObjectCount: expect.any(Number),
          privilegeManifestVersion: POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version,
        });
        expect(Object.keys(readiness).sort()).toEqual([
          "currentMigrationIds",
          "definitionObjectCount",
          "expectedOwner",
          "managedObjectCount",
          "privilegeManifestVersion",
          "runtimeRole",
        ]);

        const ledger = await database.runtime.query<{
          id: string;
          checksum_sha256: string;
        }>({
          text: `SELECT id, checksum_sha256
                 FROM lcm.schema_migrations
                 ORDER BY id`,
        }, { domain: "factory", operation: "verifyRuntimeMigrationLedger" });
        expect(ledger.rows).toEqual(loadPostgreSqlMigrations().map((entry) => ({
          id: entry.id,
          checksum_sha256: entry.sha256,
        })));
      },
      { runMigrations: false },
    );
  });

  it.each([
    ["runtime role", "lcm_test_runtime"],
    ["foreign role", "lcm_harness_admin"],
  ] as const)("rejects readiness when the %s owns the current database", async (_label, owner) => {
    await withPostgreSqlTestDatabase(
      `runtime-readiness-database-owner-${owner}`,
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
        try {
          await expect(readCurrentDatabaseOwner(administrator))
            .resolves.toBe("lcm_test_migrator");
          await administrator.query({
            text: `ALTER DATABASE "${database.name}" OWNER TO ${owner}`,
          }, { domain: "factory", operation: "mutateCurrentDatabaseOwner" });
          await expect(readCurrentDatabaseOwner(administrator)).resolves.toBe(owner);

          const failure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          expect(failure).toMatchObject({
            reason: "runtime-role-policy",
            operation: "inspectRuntimeRolePolicy",
          });
          expect(JSON.stringify(failure)).not.toContain(database.name);
        } finally {
          try {
            await administrator.query({
              text: `ALTER DATABASE "${database.name}" OWNER TO lcm_test_migrator`,
            }, { domain: "factory", operation: "restoreCurrentDatabaseOwner" });
            await expect(readCurrentDatabaseOwner(administrator))
              .resolves.toBe("lcm_test_migrator");
          } finally {
            await administrator.close();
          }
        }
      },
      { runMigrations: false },
    );
  });

  it("verifies readiness when PUBLIC schema and extension defaults are revoked", async () => {
    await withPostgreSqlTestDatabase(
      "runtime-readiness-hardened-public",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
        try {
          await administrator.query({
            text: `REVOKE USAGE ON SCHEMA public FROM PUBLIC;
                   REVOKE EXECUTE ON FUNCTION
                     public.digest(text, text),
                     public.digest(bytea, text),
                     public.similarity(text, text),
                     public.similarity_op(text, text)
                     FROM PUBLIC`,
          }, { domain: "factory", operation: "revokePublicRuntimeDefaults" });
        } finally {
          await administrator.close();
        }

        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        })).resolves.toMatchObject({
          runtimeRole: "lcm_test_runtime",
        });
      },
      { runMigrations: false },
    );
  });

  it("rejects a detached extension-owned function", async () => {
    await withPostgreSqlTestDatabase(
      "runtime-readiness-detached-extension",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
        try {
          await administrator.query({
            text: "ALTER EXTENSION pgcrypto DROP FUNCTION public.digest(text, text)",
          }, { domain: "factory", operation: "detachRuntimeExtensionFunction" });
        } finally {
          await administrator.close();
        }

        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        })).rejects.toMatchObject({
          reason: "extension-preflight",
          operation: "inspectRequiredExtensionFunctions",
        });
      },
      { runMigrations: false },
    );
  });

  it.each(REQUIRED_RUNTIME_GRANT_SCRIPTS)(
    "rejects readiness when %s is omitted",
    async (omittedScript) => {
      await withPostgreSqlTestDatabase(
        `readiness-omit-${omittedScript}`,
        async (database) => {
          await runPostgreSqlMigrations(database.migrator);
          await applyRuntimeGrantScripts(database, { omit: [omittedScript] });

          await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          })).rejects.toMatchObject({
            backend: "postgresql",
            code: "STORAGE_INITIALIZATION_FAILED",
          });
        },
        { runMigrations: false },
      );
    },
  );

  it("rejects an overbroad PUBLIC managed-table grant", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-public-grant",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        await database.migrator.query({
          text: "GRANT SELECT ON TABLE lcm.projects TO PUBLIC",
        }, { domain: "factory", operation: "injectReadinessPublicGrant" });

        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        })).rejects.toMatchObject({
          reason: "schema-fingerprint",
          operation: "inspectSchemaDefinitions",
        });
      },
      { runMigrations: false },
    );
  });

  it("reports one column ACL object for multiple unsanctioned privileges", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-column-acl-object-count",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        type DefinitionDiagnosticRow = {
          readonly actual_definition_group_counts: readonly number[];
          readonly actual_definition_group_hashes: readonly string[];
          readonly drifted_definition_group_count: number;
          readonly existing_object_count: number;
          readonly expected_object_count: number;
          readonly missing_object_count: number;
        };
        let readinessDefinitionRow: DefinitionDiagnosticRow | undefined;
        const captureReadinessQuery = async <
          R extends QueryResultRow = QueryResultRow,
          I extends unknown[] = unknown[],
        >(
          config: QueryConfig<I>,
          options: PostgreSqlQueryOptions,
        ): Promise<QueryResult<R>> => {
          const result = await database.runtime.query<R, I>(config, options);
          if (options.operation === "inspectSchemaDefinitions") {
            readinessDefinitionRow = result.rows[0] as DefinitionDiagnosticRow | undefined;
          }
          return result;
        };
        const readinessExecutor: PostgreSqlQueryExecutor = {
          query: captureReadinessQuery,
        };
        try {
          await database.migrator.query({
            text: `GRANT SELECT (display_name), UPDATE (display_name)
                   ON TABLE lcm.projects TO PUBLIC`,
          }, { domain: "factory", operation: "injectMultipleUnsanctionedColumnPrivileges" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(readinessExecutor, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          const migrationColumnAcl = migrationFailure
            instanceof PostgreSqlBaselineDefinitionPreflightError
            ? migrationFailure.actualDefinitionGroups?.find(
              ({ objectKind }) => objectKind === "column_acl",
            )
            : undefined;
          const latestSnapshot = loadPostgreSqlSchemaSnapshots().at(-1)!;
          const diagnostic = {
            readinessFailure,
            migrationFailure,
            readinessExpectedObjectCount:
              readinessDefinitionRow?.expected_object_count,
            readinessExistingObjectCount:
              readinessDefinitionRow?.existing_object_count,
            readinessMissingObjectCount:
              readinessDefinitionRow?.missing_object_count,
            readinessDriftedDefinitionGroupCount:
              readinessDefinitionRow?.drifted_definition_group_count,
            readinessColumnAclCount:
              readinessDefinitionRow?.actual_definition_group_counts[4],
            migrationColumnAclCount: migrationColumnAcl?.objectCount,
            readinessColumnAclSha256:
              readinessDefinitionRow?.actual_definition_group_hashes[4],
            migrationColumnAclSha256: migrationColumnAcl?.definitionSha256,
          };
          expect(diagnostic).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              existingObjectCount: 880,
              expectedObjectCount: 880,
              missingObjectCount: 0,
              operation: "preflightBaselineDefinitions",
            },
            readinessExpectedObjectCount: 880,
            readinessExistingObjectCount: 880,
            readinessMissingObjectCount: 0,
            readinessDriftedDefinitionGroupCount: 1,
            readinessColumnAclCount: 253,
            migrationColumnAclCount: 253,
            readinessColumnAclSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            migrationColumnAclSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          });
          expect(diagnostic.readinessColumnAclSha256)
            .toBe(diagnostic.migrationColumnAclSha256);
          expect(diagnostic.readinessColumnAclSha256)
            .not.toBe(latestSnapshot.definitionHashes.columnAcl);
        } finally {
          await database.migrator.query({
            text: `REVOKE SELECT (display_name), UPDATE (display_name)
                   ON TABLE lcm.projects FROM PUBLIC`,
          }, { domain: "factory", operation: "removeMultipleUnsanctionedColumnPrivileges" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected non-internal triggers on managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-trigger",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        await database.migrator.query({
          text: `CREATE TRIGGER unexpected_schema_fingerprint_trigger
                 BEFORE INSERT ON lcm.session_ingest_log
                 FOR EACH ROW
                 EXECUTE FUNCTION lcm.enforce_session_ingest_id_uniqueness()`,
        }, { domain: "factory", operation: "injectUnexpectedManagedTrigger" });
        try {
          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: `DROP TRIGGER unexpected_schema_fingerprint_trigger
                   ON lcm.session_ingest_log`,
          }, { domain: "factory", operation: "removeUnexpectedManagedTrigger" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected constraints on managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-constraint",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `ALTER TABLE lcm.session_ingest_log
                   ADD CONSTRAINT unexpected_schema_fingerprint_constraint
                   CHECK (char_length(session_id) >= 0)`,
          }, { domain: "factory", operation: "injectUnexpectedManagedConstraint" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: `ALTER TABLE lcm.session_ingest_log
                   DROP CONSTRAINT IF EXISTS unexpected_schema_fingerprint_constraint`,
          }, { domain: "factory", operation: "removeUnexpectedManagedConstraint" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects inbound foreign keys targeting managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-inbound-foreign-key",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `CREATE TABLE public.operator_reference (
                     project_id uuid NOT NULL,
                     CONSTRAINT operator_reference_project_fk
                       FOREIGN KEY (project_id)
                       REFERENCES lcm.projects(project_id)
                       ON DELETE CASCADE
                   )`,
          }, { domain: "factory", operation: "injectInboundManagedForeignKey" });
          const project = await database.migrator.query<{ project_id: string }>({
            text: `INSERT INTO lcm.projects (identity_key, display_name)
                   VALUES (pg_catalog.repeat('b', 64), 'Inbound FK probe')
                   RETURNING project_id::pg_catalog.text`,
          }, { domain: "factory", operation: "seedInboundManagedForeignKeyProject" });
          await database.migrator.query({
            text: `INSERT INTO public.operator_reference (project_id)
                   VALUES ($1::pg_catalog.uuid)`,
            values: [project.rows[0]!.project_id],
          }, { domain: "factory", operation: "seedInboundManagedForeignKeyReference" });
          await database.migrator.query({
            text: "DELETE FROM lcm.projects WHERE project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid",
            values: [project.rows[0]!.project_id],
          }, { domain: "factory", operation: "exerciseInboundManagedForeignKeyCascade" });
          const cascade = await database.migrator.query<{ reference_count: string }>({
            text: `SELECT pg_catalog.count(*)::pg_catalog.text AS reference_count
                   FROM public.operator_reference`,
          }, { domain: "factory", operation: "readInboundManagedForeignKeyCascade" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ cascade, readinessFailure, migrationFailure }).toMatchObject({
            cascade: { rows: [{ reference_count: "0" }] },
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: "DROP TABLE IF EXISTS public.operator_reference",
          }, { domain: "factory", operation: "removeInboundManagedForeignKey" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected ordinary columns with write-affecting semantics", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-ordinary-column",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `ALTER TABLE lcm.session_ingest_log
                   ADD COLUMN unexpected_write_guard text NOT NULL DEFAULT 'injected'`,
          }, { domain: "factory", operation: "injectUnexpectedManagedOrdinaryColumn" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: "ALTER TABLE lcm.session_ingest_log DROP COLUMN IF EXISTS unexpected_write_guard",
          }, { domain: "factory", operation: "removeUnexpectedManagedOrdinaryColumn" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unvalidated NOT NULL constraints with existing null rows", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unvalidated-not-null",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `DO $lcm$
                   DECLARE
                     baseline_constraint name;
                   BEGIN
                     SELECT constraint_metadata.conname
                     INTO STRICT baseline_constraint
                     FROM pg_catalog.pg_constraint AS constraint_metadata
                     JOIN pg_catalog.pg_class AS relation
                       ON relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
                     JOIN pg_catalog.pg_namespace AS namespace
                       ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                     JOIN pg_catalog.pg_attribute AS attribute
                       ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
                      AND constraint_metadata.conkey OPERATOR(pg_catalog.=)
                        ARRAY[attribute.attnum]::pg_catalog.int2[]
                     WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                       AND relation.relname OPERATOR(pg_catalog.=) 'projects'
                       AND attribute.attname OPERATOR(pg_catalog.=) 'display_name'
                       AND constraint_metadata.contype OPERATOR(pg_catalog.=) 'n';

                     EXECUTE pg_catalog.format(
                       'ALTER TABLE lcm.projects DROP CONSTRAINT %I',
                       baseline_constraint
                     );
                     INSERT INTO lcm.projects (identity_key, display_name)
                     VALUES (pg_catalog.repeat('e', 64), NULL);
                     EXECUTE pg_catalog.format(
                       'ALTER TABLE lcm.projects ADD CONSTRAINT %I NOT NULL display_name NOT VALID',
                       baseline_constraint
                     );
                   END
                   $lcm$`,
          }, { domain: "factory", operation: "injectUnvalidatedNotNullConstraint" });
          const invalidState = await database.migrator.query<{
            attnotnull: boolean;
            conenforced: boolean;
            convalidated: boolean;
            null_rows: string;
          }>({
            text: `SELECT attribute.attnotnull,
                          constraint_metadata.convalidated,
                          constraint_metadata.conenforced,
                          (SELECT pg_catalog.count(*)::pg_catalog.text
                           FROM lcm.projects
                           WHERE display_name IS NULL) AS null_rows
                   FROM pg_catalog.pg_constraint AS constraint_metadata
                   JOIN pg_catalog.pg_class AS relation
                     ON relation.oid OPERATOR(pg_catalog.=) constraint_metadata.conrelid
                   JOIN pg_catalog.pg_namespace AS namespace
                     ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
                   JOIN pg_catalog.pg_attribute AS attribute
                     ON attribute.attrelid OPERATOR(pg_catalog.=) relation.oid
                    AND constraint_metadata.conkey OPERATOR(pg_catalog.=)
                      ARRAY[attribute.attnum]::pg_catalog.int2[]
                   WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
                     AND relation.relname OPERATOR(pg_catalog.=) 'projects'
                     AND attribute.attname OPERATOR(pg_catalog.=) 'display_name'
                     AND constraint_metadata.contype OPERATOR(pg_catalog.=) 'n'`,
          }, { domain: "factory", operation: "readUnvalidatedNotNullConstraint" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ invalidState, readinessFailure, migrationFailure }).toMatchObject({
            invalidState: {
              rows: [{
                attnotnull: true,
                conenforced: true,
                convalidated: false,
                null_rows: "1",
              }],
            },
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: `ALTER TABLE lcm.projects ALTER COLUMN display_name DROP NOT NULL;
                   DELETE FROM lcm.projects
                   WHERE identity_key OPERATOR(pg_catalog.=) pg_catalog.repeat('e', 64);
                   ALTER TABLE lcm.projects ALTER COLUMN display_name SET NOT NULL`,
          }, { domain: "factory", operation: "restoreValidatedNotNullConstraint" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected generated columns on managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-generated-column",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `ALTER TABLE lcm.session_ingest_log
                   ADD COLUMN unexpected_generated_key text
                   GENERATED ALWAYS AS (md5(session_id)) STORED`,
          }, { domain: "factory", operation: "injectUnexpectedManagedGeneratedColumn" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: "ALTER TABLE lcm.session_ingest_log DROP COLUMN IF EXISTS unexpected_generated_key",
          }, { domain: "factory", operation: "removeUnexpectedManagedGeneratedColumn" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected valid indexes on managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-index",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `CREATE UNIQUE INDEX unexpected_schema_fingerprint_index
                   ON lcm.session_ingest_log (lower(session_id))`,
          }, { domain: "factory", operation: "injectUnexpectedManagedIndex" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: `DROP INDEX IF EXISTS lcm.unexpected_schema_fingerprint_index`,
          }, { domain: "factory", operation: "removeUnexpectedManagedIndex" });
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects an invalid ready live replacement with an expected index fingerprint", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-invalid-expected-index",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        const snapshot = loadPostgreSqlSchemaSnapshots().at(-1);
        if (snapshot === undefined) throw new Error("missing PostgreSQL schema snapshot fixture");
        const indexName = "conversations_project_order_idx";
        const canonicalIndex = await readIndexCatalogState(
          database.migrator,
          indexName,
          "readCanonicalExpectedIndex",
        );
        if (
          canonicalIndex === null
          || canonicalIndex.indisvalid !== true
          || canonicalIndex.indisready !== true
          || canonicalIndex.indislive !== true
        ) {
          throw new Error("expected canonical PostgreSQL index is not valid ready live");
        }
        const canonicalInventory = await readManagedIndexInventory(
          database.migrator,
          snapshot.tableIdentities,
          "readCanonicalManagedIndexInventory",
        );
        if (canonicalInventory.invalid_index_count !== 0) {
          throw new Error("canonical PostgreSQL index inventory contains an invalid index");
        }
        const concurrentDefinition = canonicalIndex.definition.replace(
          /^CREATE INDEX /u,
          "CREATE INDEX CONCURRENTLY ",
        );
        if (concurrentDefinition === canonicalIndex.definition) {
          throw new Error("expected standalone PostgreSQL index definition");
        }
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
        const blocker = new Client(
          POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(
            settings(database.migratorUrl),
          ),
        );
        const creator = new Client(
          POSTGRESQL_RUNTIME_DEFAULT_DEPENDENCIES.buildConfig(
            settings(database.migratorUrl),
          ),
        );
        let creatorPid: number | undefined;
        let creation: Promise<unknown> | undefined;
        let mutationStarted = false;
        const restoreAuthoritativeIndex = async (): Promise<void> => {
          if (!mutationStarted) return;
          await database.migrator.query({
            text: `DROP INDEX IF EXISTS lcm.${indexName}`,
          }, { domain: "factory", operation: "dropInvalidExpectedIndexForRestore" });
          await database.migrator.query({
            text: canonicalIndex.definition,
          }, { domain: "factory", operation: "restoreAuthoritativeExpectedIndex" });
          mutationStarted = false;
        };
        try {
          await blocker.connect();
          await creator.connect();
          mutationStarted = true;
          await database.migrator.query({
            text: `DROP INDEX lcm.${indexName}`,
          }, { domain: "factory", operation: "dropAuthoritativeExpectedIndex" });
          await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await blocker.query("SELECT pg_catalog.count(*) FROM lcm.conversations");
          creatorPid = (await creator.query<{ pid: number }>(
            "SELECT pg_catalog.pg_backend_pid() AS pid",
          )).rows[0]?.pid;
          if (!Number.isSafeInteger(creatorPid)) {
            throw new Error("invalid concurrent-index creator backend PID");
          }

          creation = creator.query(concurrentDefinition).then(() => {
            throw new Error("concurrent index creation unexpectedly completed");
          }).catch((error: unknown) => error);

          const waitingIndex = await waitForInvalidReadyLiveIndex(
            database.migrator,
            indexName,
          );
          expect(waitingIndex).toEqual({
            ...canonicalIndex,
            indisvalid: false,
            indisready: true,
            indislive: true,
          });
          await administrator.query({
            text: "SELECT pg_catalog.pg_cancel_backend($1) AS cancelled",
            values: [creatorPid],
          }, { domain: "factory", operation: "cancelInvalidExpectedIndexCreation" });
          await blocker.query("ROLLBACK");
          await expect(creation).resolves.toMatchObject({ code: "57014" });
          creation = undefined;

          const invalidIndex = await readIndexCatalogState(
            database.migrator,
            indexName,
            "readCancelledExpectedIndex",
          );
          expect(invalidIndex).toEqual({
            ...canonicalIndex,
            indisvalid: false,
            indisready: true,
            indislive: true,
          });
          const invalidInventory = await readManagedIndexInventory(
            database.migrator,
            snapshot.tableIdentities,
            "readInvalidManagedIndexInventory",
          );
          expect(invalidInventory).toEqual({
            ...canonicalInventory,
            invalid_index_count: 1,
          });

          type DefinitionDiagnosticRow = QueryResultRow & {
            readonly actual_definition_group_counts: readonly number[];
            readonly actual_definition_group_hashes: readonly string[];
            readonly invalid_index_count: number;
            readonly missing_object_count: number;
            readonly drifted_definition_group_count: number;
          };
          let readinessDefinitionRow: DefinitionDiagnosticRow | undefined;
          const readinessExecutor: PostgreSqlQueryExecutor = {
            query: async <
              R extends QueryResultRow = QueryResultRow,
              I extends unknown[] = unknown[],
            >(
              config: QueryConfig<I>,
              options: PostgreSqlQueryOptions,
            ): Promise<QueryResult<R>> => {
              const result = await database.runtime.query<R, I>(config, options);
              if (options.operation === "inspectSchemaDefinitions") {
                readinessDefinitionRow = result.rows[0] as DefinitionDiagnosticRow | undefined;
              }
              return result;
            },
          };
          let migrationDefinitionRow: DefinitionDiagnosticRow | undefined;
          const migrationExecutor = {
            query: <
              R extends QueryResultRow = QueryResultRow,
              I extends unknown[] = unknown[],
            >(config: QueryConfig<I>, options: PostgreSqlQueryOptions): Promise<QueryResult<R>> => (
              database.migrator.query<R, I>(config, options)
            ),
            transaction: async <T>(
              callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
              options: { domain: "factory"; operation: string; signal?: AbortSignal },
            ): Promise<T> => database.migrator.transaction(async (transaction) => callback({
              query: async <
                R extends QueryResultRow = QueryResultRow,
                I extends unknown[] = unknown[],
              >(
                config: QueryConfig<I>,
                queryOptions: PostgreSqlQueryOptions,
              ): Promise<QueryResult<R>> => {
                const result = await transaction.query<R, I>(config, queryOptions);
                if (queryOptions.operation === "preflightBaselineDefinitions") {
                  migrationDefinitionRow = result.rows[0] as DefinitionDiagnosticRow | undefined;
                }
                return result;
              },
            }), options),
          };

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(readinessExecutor, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(migrationExecutor)
            .catch((error: unknown) => error);
          expect({
            readinessFailure,
            migrationFailure,
            readinessDefinitionRow,
            migrationDefinitionRow,
          }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 0,
              operation: "preflightBaselineDefinitions",
            },
            readinessDefinitionRow: {
              invalid_index_count: 1,
              missing_object_count: 0,
              drifted_definition_group_count: 0,
            },
            migrationDefinitionRow: {
              invalid_index_count: 1,
              missing_object_count: 0,
              drifted_definition_group_count: 0,
            },
          });
          expect(readinessDefinitionRow?.actual_definition_group_counts[0])
            .toBe(canonicalInventory.index_count);
          expect(migrationDefinitionRow?.actual_definition_group_counts[0])
            .toBe(canonicalInventory.index_count);
          expect(readinessDefinitionRow?.actual_definition_group_hashes[0])
            .toBe(canonicalInventory.index_sha256);
          expect(migrationDefinitionRow?.actual_definition_group_hashes[0])
            .toBe(canonicalInventory.index_sha256);
          expect(JSON.stringify([readinessFailure, migrationFailure])).not.toContain(indexName);

          await restoreAuthoritativeIndex();
          await expect(readIndexCatalogState(
            database.migrator,
            indexName,
            "readRestoredExpectedIndex",
          )).resolves.toEqual(canonicalIndex);
          await expect(readManagedIndexInventory(
            database.migrator,
            snapshot.tableIdentities,
            "readRestoredManagedIndexInventory",
          )).resolves.toEqual(canonicalInventory);
          await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
          await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({
            applied: [],
          });
        } finally {
          if (creatorPid !== undefined) {
            await administrator.query({
              text: "SELECT pg_catalog.pg_cancel_backend($1) AS cancelled",
              values: [creatorPid],
            }, { domain: "factory", operation: "cancelExpectedIndexCreationDuringCleanup" })
              .catch(() => undefined);
          }
          await blocker.query("ROLLBACK").catch(() => undefined);
          await creation?.catch(() => undefined);
          await creator.end().catch(() => undefined);
          await blocker.end().catch(() => undefined);
          try {
            await restoreAuthoritativeIndex();
            await expect(readIndexCatalogState(
              database.migrator,
              indexName,
              "verifyAuthoritativeExpectedIndexRestored",
            )).resolves.toEqual(canonicalIndex);
          } finally {
            await administrator.close();
          }
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects unexpected non-view DML rewrite rules on managed tables", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-unexpected-rewrite-rule",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        try {
          await database.migrator.query({
            text: `CREATE RULE unexpected_schema_fingerprint_rule AS
                   ON INSERT TO lcm.session_ingest_log
                   DO INSTEAD NOTHING`,
          }, { domain: "factory", operation: "injectUnexpectedManagedRewriteRule" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          await database.migrator.query({
            text: `DROP RULE IF EXISTS unexpected_schema_fingerprint_rule
                   ON lcm.session_ingest_log`,
          }, { domain: "factory", operation: "removeUnexpectedManagedRewriteRule" });
        }
      },
      { runMigrations: false },
    );
  });

  it("keeps the restricted runtime unable to mutate the ledger, create, or migrate", async () => {
    await withPostgreSqlTestDatabase(
      "readiness-runtime-denials",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        await expect(verifyPostgreSqlRuntimeSchema(database.runtime, {
          expectedOwner: "lcm_test_migrator",
        })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });

        for (const [operation, text] of [
          ["denyRuntimeLedgerInsert", "INSERT INTO lcm.schema_migrations (id, checksum_sha256) VALUES ('9999_forbidden', repeat('0', 64))"],
          ["denyRuntimeLedgerUpdate", "UPDATE lcm.schema_migrations SET checksum_sha256 = repeat('0', 64)"],
          ["denyRuntimeLedgerDelete", "DELETE FROM lcm.schema_migrations"],
          ["denyRuntimeLedgerTruncate", "TRUNCATE TABLE lcm.schema_migrations"],
          ["denyRuntimeSchemaCreate", "CREATE TABLE lcm.runtime_forbidden (id integer)"],
        ] as const) {
          await expect(database.runtime.query({ text }, {
            domain: "factory",
            operation,
          })).rejects.toMatchObject({ backend: "postgresql" });
        }

        const pending = migration(
          "0007_runtime_forbidden",
          "CREATE TABLE lcm.runtime_migration_forbidden (id integer)",
        );
        await expect(runPostgreSqlMigrations(database.runtime, {
          migrations: [...loadPostgreSqlMigrations(), pending],
        })).rejects.toMatchObject({
          backend: "postgresql",
          code: "STORAGE_INITIALIZATION_FAILED",
        });
      },
      { runMigrations: false },
    );
  });

  it.each([
    { label: "0002 baseline", migrationCount: 2, snapshotCount: 1 },
    { label: "0003 machine identity", migrationCount: 3, snapshotCount: 2 },
    { label: "0004 machine display name", migrationCount: 4, snapshotCount: 3 },
    { label: "0005 summary context integrity", migrationCount: 5, snapshotCount: 4 },
    { label: "0006 transfer ledger", migrationCount: 6, snapshotCount: 5 },
  ])("validates the registered $label catalog snapshot", async ({
    label,
    migrationCount,
    snapshotCount,
  }) => {
    const database = await createPostgreSqlTestDatabase(
      `migration-prefix-${label.replaceAll(" ", "-")}`,
      { runMigrations: false },
    );
    try {
      const migrations = loadPostgreSqlMigrations().slice(0, migrationCount);
      const schemaSnapshots = loadPostgreSqlSchemaSnapshots().slice(0, snapshotCount);
      const result = await runPostgreSqlMigrations(database.migrator, {
        migrations,
        schemaSnapshots,
      }).catch((error: unknown) => {
        writePostgreSqlBaselineDefinitionFingerprints(error);
        throw error;
      });
      expect(result).toEqual({
        applied: migrations.map(({ id }) => id),
        current: migrations.map(({ id }) => id),
      });
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations,
        schemaSnapshots,
      })).resolves.toEqual({
        applied: [],
        current: migrations.map(({ id }) => id),
      });
    } finally {
      await database.drop();
    }
  });

  it("locks out concurrent writers before cycle preflight and rolls back installation", async () => {
    const database = await createPostgreSqlTestDatabase(
      "migration-summary-cycle-preflight",
      { runMigrations: false },
    );
    const writer = new PostgreSqlRuntime(settings(database.migratorUrl));
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    let releaseWriter: (() => void) | undefined;
    let writerReady: (() => void) | undefined;
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerStarted = new Promise<void>((resolve) => {
      writerReady = resolve;
    });
    let writerRun: Promise<void> | undefined;
    try {
      const migrations = loadPostgreSqlMigrations();
      const snapshots = loadPostgreSqlSchemaSnapshots();
      await runPostgreSqlMigrations(database.migrator, {
        migrations: migrations.slice(0, 4),
        schemaSnapshots: snapshots.slice(0, 3),
      });
      const project = await database.migrator.query<{ project_id: string }>({
        text: `INSERT INTO lcm.projects (identity_key, display_name)
               VALUES (pg_catalog.repeat('c', 64), 'Cycle preflight')
               RETURNING project_id`,
      }, { domain: "factory", operation: "seedCyclePreflightProject" });
      const projectId = project.rows[0]?.project_id;
      const conversation = await database.migrator.query<{
        conversation_id: string;
      }>({
        text: `INSERT INTO lcm.conversations (project_id, session_id)
               VALUES ($1, 'cycle-preflight')
               RETURNING conversation_id`,
        values: [projectId],
      }, { domain: "factory", operation: "seedCyclePreflightConversation" });
      const conversationId = conversation.rows[0]?.conversation_id;
      const summaries = await database.migrator.query<{
        summary_id: string;
        summary_key: string;
      }>({
        text: `INSERT INTO lcm.summaries
                 (summary_id, project_id, conversation_id, kind, content, token_count)
               VALUES
                 ('cycle-a', $1, $2, 'leaf', 'cycle a', 1),
                 ('cycle-b', $1, $2, 'leaf', 'cycle b', 1),
                 ('cycle-c', $1, $2, 'leaf', 'cycle c', 1)
               RETURNING summary_id, summary_key`,
        values: [projectId, conversationId],
      }, { domain: "factory", operation: "seedCyclePreflightSummaries" });
      const summaryKeys = new Map(
        summaries.rows.map(({ summary_id, summary_key }) => [summary_id, summary_key]),
      );
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_parents
                 (project_id, conversation_id, summary_key, parent_summary_key, ordinal)
               VALUES
                 ($1, $2, $3, $4, 0),
                 ($1, $2, $4, $5, 0)`,
        values: [
          projectId,
          conversationId,
          summaryKeys.get("cycle-a"),
          summaryKeys.get("cycle-b"),
          summaryKeys.get("cycle-c"),
        ],
      }, { domain: "factory", operation: "seedSummaryCyclePath" });

      writerRun = writer.transaction(async (transaction) => {
        await transaction.query({
          text: `INSERT INTO lcm.summary_parents
                   (project_id, conversation_id, summary_key, parent_summary_key, ordinal)
                 VALUES ($1, $2, $3, $4, 0)`,
          values: [
            projectId,
            conversationId,
            summaryKeys.get("cycle-c"),
            summaryKeys.get("cycle-a"),
          ],
        }, { domain: "factory", operation: "seedConcurrentClosingCycleEdge" });
        writerReady?.();
        await writerRelease;
      }, { domain: "factory", operation: "holdConcurrentClosingCycleEdge" });
      await writerStarted;

      const migrationRun = runPostgreSqlMigrations(database.migrator);
      await waitForSummaryMigrationRelationLock(admin);
      releaseWriter?.();
      await writerRun;
      await expect(migrationRun)
        .rejects.toMatchObject({
          backend: "postgresql",
          operation: "applyMigration:0005_summary_context_integrity",
          sqlState: "23000",
        });
      await expect(database.migrator.query<{
        applied: boolean;
        function_exists: boolean;
        preserved_edges: string;
      }>({
        text: `SELECT
                 EXISTS (
                   SELECT 1
                   FROM lcm.schema_migrations
                   WHERE id = '0005_summary_context_integrity'
                 ) AS applied,
                 pg_catalog.to_regprocedure(
                   'lcm.enforce_summary_parent_dag_integrity()'
                 ) IS NOT NULL AS function_exists,
                 (SELECT pg_catalog.count(*)::pg_catalog.text
                  FROM lcm.summary_parents) AS preserved_edges`,
      }, { domain: "factory", operation: "verifyCyclePreflightRollback" }))
        .resolves.toMatchObject({
          rows: [{
            applied: false,
            function_exists: false,
            preserved_edges: "3",
          }],
        });
    } finally {
      releaseWriter?.();
      await writerRun?.catch(() => undefined);
      await writer.close();
      await admin.close();
      await database.drop();
    }
  });

  it("reports every deterministic 0005 damage preflight without repairing rows and accepts reviewed grants", async () => {
    const database = await createPostgreSqlTestDatabase(
      "migration-summary-damage",
      { runMigrations: false },
    );
    const admin = new PostgreSqlRuntime(settings(database.adminUrl, {
      poolMax: 1,
    }));
    try {
      const migrations = loadPostgreSqlMigrations();
      const snapshots = loadPostgreSqlSchemaSnapshots();
      await runPostgreSqlMigrations(database.migrator, {
        migrations: migrations.slice(0, 4),
        schemaSnapshots: snapshots.slice(0, 3),
      });
      const project = await database.migrator.query<{ project_id: string }>({
        text: `INSERT INTO lcm.projects (identity_key, display_name)
               VALUES (pg_catalog.repeat('d', 64), 'Damage preflight')
               RETURNING project_id`,
      }, { domain: "factory", operation: "seedDamagePreflightProject" });
      const projectId = project.rows[0].project_id;
      const conversations = await database.migrator.query<{
        conversation_id: string;
        session_id: string;
      }>({
        text: `INSERT INTO lcm.conversations (project_id, session_id)
               VALUES
                 ($1, 'damage-primary'),
                 ($1, 'damage-foreign')
               RETURNING conversation_id::pg_catalog.text, session_id`,
        values: [projectId],
      }, { domain: "factory", operation: "seedDamagePreflightConversations" });
      const conversationBySession = new Map(
        conversations.rows.map((row) => [row.session_id, row.conversation_id]),
      );
      const primaryConversationId = conversationBySession.get("damage-primary")!;
      const foreignConversationId = conversationBySession.get("damage-foreign")!;
      const summaries = await database.migrator.query<{
        summary_id: string;
        summary_key: string;
      }>({
        text: `INSERT INTO lcm.summaries (
                 summary_id, project_id, conversation_id, kind, content,
                 token_count
               )
               VALUES
                 ('damage-child-a', $1, $2, 'leaf', 'child a', 1),
                 ('damage-child-b', $1, $2, 'leaf', 'child b', 1),
                 ('damage-parent-a', $1, $2, 'leaf', 'parent a', 1),
                 ('damage-parent-b', $1, $2, 'leaf', 'parent b', 1),
                 ('damage-foreign-a', $1, $3, 'leaf', 'foreign a', 1),
                 ('damage-foreign-b', $1, $3, 'leaf', 'foreign b', 1)
               RETURNING summary_id, summary_key::pg_catalog.text`,
        values: [projectId, primaryConversationId, foreignConversationId],
      }, { domain: "factory", operation: "seedDamagePreflightSummaries" });
      const key = new Map(
        summaries.rows.map((row) => [row.summary_id, row.summary_key]),
      );
      const generated = await database.migrator.query<{ value: string }>({
        text: `SELECT value::pg_catalog.text
               FROM (
                 VALUES (pg_catalog.uuidv7()), (pg_catalog.uuidv7()),
                        (pg_catalog.uuidv7()), (pg_catalog.uuidv7())
               ) AS generated(value)
               ORDER BY value`,
      }, { domain: "factory", operation: "createDamagePreflightOrphans" });
      const orphanKeys = generated.rows.map((row) => row.value);
      const pending = migrations[4]!;

      const insertDamagedEdges = async (
        childKeys: readonly [string, string],
        parentKeys: readonly [string, string],
      ): Promise<void> => {
        await admin.query({
          text: "SET session_replication_role = replica",
        }, { domain: "factory", operation: "enableDamagePreflightReplicaMode" });
        await admin.query({
          text: `INSERT INTO lcm.summary_parents (
                   project_id, conversation_id, summary_key,
                   parent_summary_key, ordinal
                 )
                 VALUES
                   ($1, $2, $3, $4, 0),
                   ($1, $2, $5, $6, 0)`,
          values: [
            projectId,
            primaryConversationId,
            childKeys[0],
            parentKeys[0],
            childKeys[1],
            parentKeys[1],
          ],
        }, { domain: "factory", operation: "seedDamagedSummaryEdges" });
        await admin.query({
          text: "SET session_replication_role = origin",
        }, { domain: "factory", operation: "restoreDamagePreflightOriginMode" });
      };
      const clearDamagedEdges = async (): Promise<void> => {
        await admin.query({
          text: "SET session_replication_role = replica",
        }, { domain: "factory", operation: "enableDamageCleanupReplicaMode" });
        await admin.query({
          text: "DELETE FROM lcm.summary_parents",
        }, { domain: "factory", operation: "clearDamagedSummaryEdges" });
        await admin.query({
          text: "SET session_replication_role = origin",
        }, { domain: "factory", operation: "restoreDamageCleanupOriginMode" });
      };
      const expectDamage = async (
        constraint: string,
        identity: string,
      ): Promise<void> => {
        const error = await executeRawMigrationExpectingFailure(
          database,
          pending,
        );
        expect(error.code).toBe("23000");
        expect(error.constraint).toBe(constraint);
        expect(error.message).toContain(projectId);
        expect(error.message).toContain(primaryConversationId);
        expect(error.message).toContain(identity);
        await expect(database.migrator.query<{
          applied: boolean;
          function_exists: boolean;
          preserved_edges: number;
        }>({
          text: `SELECT
                   EXISTS (
                     SELECT 1
                     FROM lcm.schema_migrations
                     WHERE id = '0005_summary_context_integrity'
                   ) AS applied,
                   pg_catalog.to_regprocedure(
                     'lcm.enforce_summary_parent_dag_integrity()'
                   ) IS NOT NULL AS function_exists,
                   (
                     SELECT COUNT(*)::pg_catalog.int4
                     FROM lcm.summary_parents
                   ) AS preserved_edges`,
        }, { domain: "factory", operation: "inspectDamagePreflightRollback" }))
          .resolves.toMatchObject({
            rows: [{
              applied: false,
              function_exists: false,
              preserved_edges: 2,
            }],
          });
      };

      const primaryChildren = [
        key.get("damage-child-a")!,
        key.get("damage-child-b")!,
      ].sort() as [string, string];
      const foreignChildren = [
        key.get("damage-foreign-a")!,
        key.get("damage-foreign-b")!,
      ].sort() as [string, string];
      const primaryParents = [
        key.get("damage-parent-a")!,
        key.get("damage-parent-b")!,
      ].sort() as [string, string];

      await insertDamagedEdges(
        [orphanKeys[0]!, orphanKeys[1]!],
        primaryParents,
      );
      await expectDamage(
        "summary_parents_project_id_conversation_id_summary_key_fkey",
        orphanKeys[0]!,
      );
      await clearDamagedEdges();

      await insertDamagedEdges(foreignChildren, primaryParents);
      await expectDamage(
        "summary_parents_project_id_conversation_id_summary_key_fkey",
        foreignChildren[0],
      );
      await clearDamagedEdges();

      await insertDamagedEdges(
        primaryChildren,
        [orphanKeys[2]!, orphanKeys[3]!],
      );
      await expectDamage(
        "summary_parents_project_id_conversation_id_parent_summary__fkey",
        orphanKeys[2]!,
      );
      await clearDamagedEdges();

      await insertDamagedEdges(primaryChildren, foreignChildren);
      await expectDamage(
        "summary_parents_project_id_conversation_id_parent_summary__fkey",
        foreignChildren[0],
      );
      await clearDamagedEdges();

      await database.migrator.query({
        text: `ALTER TABLE lcm.summary_parents
                 DROP CONSTRAINT summary_parents_check`,
      }, { domain: "factory", operation: "openSelfEdgeDamageFixture" });
      await insertDamagedEdges(primaryChildren, primaryChildren);
      await expectDamage(
        "summary_parents_check",
        primaryChildren[0],
      );
      await clearDamagedEdges();
      await database.migrator.query({
        text: `ALTER TABLE lcm.summary_parents
                 ADD CONSTRAINT summary_parents_check
                 CHECK (summary_key <> parent_summary_key)`,
      }, { domain: "factory", operation: "restoreSummaryParentSelfCheck" });

      await applySummaryContextRuntimeGrant(database);
      await expect(runPostgreSqlMigrations(database.migrator)).resolves.toEqual({
        applied: ["0005_summary_context_integrity", "0006_transfer_ledger"],
        current: migrations.map(({ id }) => id),
      });
      await expect(runPostgreSqlMigrations(database.migrator)).resolves.toEqual({
        applied: [],
        current: migrations.map(({ id }) => id),
      });
    } finally {
      await admin.query({
        text: "SET session_replication_role = origin",
      }, { domain: "factory", operation: "restoreDamageFixtureOriginMode" })
        .catch(() => undefined);
      await admin.close();
      await database.drop();
    }
  });

  it("applies empty, repeated, and concurrent migration runs deterministically", async () => {
    const database = await createPostgreSqlTestDatabase("migration-concurrency", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_owned_metadata (key text PRIMARY KEY);
               INSERT INTO lcm.operator_owned_metadata (key) VALUES ('preserve-me')`,
      }, { domain: "factory", operation: "seedPreexistingSchema" });
      const second = new PostgreSqlRuntime(settings(database.migratorUrl));
      try {
        const [firstResult, secondResult] = await Promise.all([
          runPostgreSqlMigrations(database.migrator),
          runPostgreSqlMigrations(second),
        ]);
        expect([firstResult.applied, secondResult.applied].sort((left, right) => right.length - left.length))
          .toEqual([[
            "0001_migration_ledger",
            "0002_schema_baseline",
            "0003_machine_identity_key",
            "0004_machine_display_name",
            "0005_summary_context_integrity",
            "0006_transfer_ledger",
          ], []]);
        await expect(database.migrator.query<{ key: string }>({
          text: "SELECT key FROM lcm.operator_owned_metadata",
        }, { domain: "factory", operation: "verifyPreexistingSchema" }))
          .resolves.toMatchObject({ rows: [{ key: "preserve-me" }] });
        await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({ applied: [] });
      } finally {
        await second.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("rolls back the complete pending set and a migration whose ledger insert fails", async () => {
    const database = await createPostgreSqlTestDatabase("migration-atomic", { runMigrations: false });
    try {
      const baseline = migration("0001_atomic_ledger", ledgerSql);
      const successful = migration("0002_atomic_probe", "CREATE TABLE lcm.pending_set_probe (id integer PRIMARY KEY);");
      const failing = migration("0003_atomic_failure", "CREATE TABLE lcm.pending_failure_probe (id integer); SELECT missing FROM absent;");
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [baseline, successful, failing],
        schemaSnapshots: [],
      })).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ ledger: boolean; probe: boolean }>({
        text: `SELECT to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
                      to_regclass('lcm.pending_set_probe') IS NOT NULL AS probe`,
      }, { domain: "factory", operation: "verifyPendingSetRollback" }))
        .resolves.toMatchObject({ rows: [{ ledger: false, probe: false }] });

      const ledgerFailure = migration("0001_ledger_failure", `CREATE SCHEMA lcm;
        CREATE TABLE lcm.schema_migrations (
          id text PRIMARY KEY CHECK (id <> '0001_ledger_failure'),
          checksum_sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
        );
        CREATE TABLE lcm.ledger_failure_probe (id integer PRIMARY KEY);`);
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [ledgerFailure],
        schemaSnapshots: [],
      }))
        .rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ ledger: boolean; probe: boolean }>({
        text: `SELECT to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
                      to_regclass('lcm.ledger_failure_probe') IS NOT NULL AS probe`,
      }, { domain: "factory", operation: "verifyLedgerInsertRollback" }))
        .resolves.toMatchObject({ rows: [{ ledger: false, probe: false }] });
    } finally {
      await database.drop();
    }
  });

  it("pins native built-ins and deparser settings under hostile ambient GUCs", async () => {
    const database = await createPostgreSqlTestDatabase("migration-search-path", {
      runMigrations: false,
    });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA hostile_builtins;
               CREATE FUNCTION hostile_builtins.current_setting(setting_name text)
               RETURNS text LANGUAGE sql IMMUTABLE RETURN '190000';
               CREATE FUNCTION hostile_builtins.uuidv7()
               RETURNS uuid LANGUAGE sql IMMUTABLE
               RETURN '6ba7b810-9dad-41d1-80b4-00c04fd430c8'::uuid;
               CREATE FUNCTION hostile_builtins.btrim(input text)
               RETURNS text LANGUAGE sql IMMUTABLE RETURN '';
               SET search_path = hostile_builtins, pg_catalog, public;
               SET quote_all_identifiers = on`,
      }, { domain: "factory", operation: "installHostileMigrationBuiltins" });

      const failing = migration(
        "0002_hostile_failure",
        "CREATE TABLE lcm.hostile_rollback_probe (id integer); SELECT missing FROM absent;",
      );
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [migration("0001_hostile_ledger", ledgerSql), failing],
        schemaSnapshots: [],
      })).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ exists: boolean }>({
        text: "SELECT pg_catalog.to_regclass('lcm.hostile_rollback_probe') IS NOT NULL AS exists",
      }, { domain: "factory", operation: "verifyHostileMigrationRollback" }))
        .resolves.toMatchObject({ rows: [{ exists: false }] });

      const rollbackSearchPath = await database.migrator.query<{ search_path: string }>({
        text: "SHOW search_path",
      }, { domain: "factory", operation: "verifyRollbackSearchPath" });
      expect(rollbackSearchPath.rows).toEqual([{
        search_path: "hostile_builtins, pg_catalog, public",
      }]);
      await expect(database.migrator.query<{ quote_all_identifiers: string }>({
        text: "SHOW quote_all_identifiers",
      }, { domain: "factory", operation: "verifyRollbackDeparserSettings" }))
        .resolves.toMatchObject({ rows: [{ quote_all_identifiers: "on" }] });

      await runPostgreSqlMigrations(database.migrator);
      const inserted = await database.migrator.query<{ machine_version: number }>({
        text: `INSERT INTO lcm.machines (identity_key)
               VALUES ('machine:${"c".repeat(64)}')
               RETURNING pg_catalog.uuid_extract_version(machine_id) AS machine_version`,
      }, { domain: "factory", operation: "verifyNativeMigrationBuiltins" });
      expect(inserted.rows).toEqual([{ machine_version: 7 }]);

      const committedSearchPath = await database.migrator.query<{ search_path: string }>({
        text: "SHOW search_path",
      }, { domain: "factory", operation: "verifyCommittedSearchPath" });
      expect(committedSearchPath.rows).toEqual([{
        search_path: "hostile_builtins, pg_catalog, public",
      }]);
      await expect(database.migrator.query<{ quote_all_identifiers: string }>({
        text: "SHOW quote_all_identifiers",
      }, { domain: "factory", operation: "verifyCommittedDeparserSettings" }))
        .resolves.toMatchObject({ rows: [{ quote_all_identifiers: "on" }] });
    } finally {
      await database.drop();
    }
  });

  it("rejects a non-UTF8 database before DDL and reports runtime incompatibility", async () => {
    const database = await createPostgreSqlTestDatabase("migration-latin1", {
      runMigrations: false,
      serverEncoding: "LATIN1",
    });
    try {
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({
        operation: "preflightServerEncoding",
        remediation:
          "Create or restore the LCM database with server_encoding UTF8, then rerun readiness.",
        requiredServerEncoding: "UTF8",
        serverEncoding: "LATIN1",
      });
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        serverEncoding: "LATIN1",
        error: {
          operation: "health",
          requiredServerEncoding: "UTF8",
          serverEncoding: "LATIN1",
        },
      });
      await expect(database.migrator.query<{ schema_exists: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_namespace
                 WHERE nspname OPERATOR(pg_catalog.=) 'lcm'
               ) AS schema_exists`,
      }, { domain: "factory", operation: "verifyEncodingPreflightNoDdl" }))
        .resolves.toMatchObject({ rows: [{ schema_exists: false }] });
    } finally {
      await database.drop();
    }
  });

  it("fails closed on a colliding operator function without replacing it", async () => {
    const database = await createPostgreSqlTestDatabase("function-collision", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE FUNCTION lcm.normalize_search_text(input text) RETURNS text
               LANGUAGE sql IMMUTABLE RETURN 'operator:' || input`,
      }, { domain: "factory", operation: "seedFunctionCollision" });
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ behavior: string; domain_table: boolean }>({
        text: `SELECT lcm.normalize_search_text('value') AS behavior,
                      to_regclass('lcm.machines') IS NOT NULL AS domain_table`,
      }, { domain: "factory", operation: "verifyFunctionCollisionRollback" }))
        .resolves.toMatchObject({ rows: [{ behavior: "operator:value", domain_table: false }] });
    } finally {
      await database.drop();
    }
  });

  it("preserves PUBLIC privileges on unknown pre-existing schema objects", async () => {
    const database = await createPostgreSqlTestDatabase("unknown-acls", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_table (id integer);
               CREATE SEQUENCE lcm.operator_sequence;
               CREATE FUNCTION lcm.operator_function() RETURNS integer LANGUAGE sql IMMUTABLE RETURN 1;
               GRANT SELECT ON lcm.operator_table TO PUBLIC;
               GRANT USAGE ON SEQUENCE lcm.operator_sequence TO PUBLIC;
               GRANT EXECUTE ON FUNCTION lcm.operator_function() TO PUBLIC`,
      }, { domain: "factory", operation: "seedUnknownAcls" });
      await runPostgreSqlMigrations(database.migrator);
      await expect(database.migrator.query<{
        unknown_table: boolean;
        unknown_sequence: boolean;
        unknown_function: boolean;
        owned_table: boolean;
        owned_sequence: boolean;
        owned_function: boolean;
      }>({
        text: `SELECT
          has_table_privilege('public', 'lcm.operator_table', 'SELECT') AS unknown_table,
          has_sequence_privilege('public', 'lcm.operator_sequence', 'USAGE') AS unknown_sequence,
          has_function_privilege('public', 'lcm.operator_function()', 'EXECUTE') AS unknown_function,
          has_table_privilege('public', 'lcm.messages', 'SELECT') AS owned_table,
          has_sequence_privilege('public', 'lcm.messages_message_id_seq', 'USAGE') AS owned_sequence,
          has_function_privilege('public', 'lcm.normalize_search_text(text)', 'EXECUTE') AS owned_function`,
      }, { domain: "factory", operation: "verifyScopedRevokes" })).resolves.toMatchObject({ rows: [{
        unknown_table: true,
        unknown_sequence: true,
        unknown_function: true,
        owned_table: false,
        owned_sequence: false,
        owned_function: false,
      }] });
    } finally {
      await database.drop();
    }
  });

  it("fails before owned DDL when a pre-existing lcm schema grants PUBLIC CREATE", async () => {
    const database = await createPostgreSqlTestDatabase("public-schema-create", { runMigrations: false });
    try {
      await database.migrator.query({
        text: `CREATE SCHEMA lcm;
               CREATE TABLE lcm.operator_table (value text);
               INSERT INTO lcm.operator_table VALUES ('preserve-me');
               GRANT CREATE ON SCHEMA lcm TO PUBLIC`,
      }, { domain: "factory", operation: "seedPublicSchemaCreate" });
      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{
        public_create: boolean;
        value: string;
        owned_table: boolean;
        ledger: boolean;
      }>({
        text: `SELECT has_schema_privilege('public', 'lcm', 'CREATE') AS public_create,
                      (SELECT value FROM lcm.operator_table) AS value,
                      to_regclass('lcm.machines') IS NOT NULL AS owned_table,
                      to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger`,
      }, { domain: "factory", operation: "verifyPublicSchemaCreateRollback" })).resolves.toMatchObject({ rows: [{
        public_create: true,
        value: "preserve-me",
        owned_table: false,
        ledger: false,
      }] });
    } finally {
      await database.drop();
    }
  });

  it("rechecks PUBLIC CREATE drift before a repeated run or later migration", async () => {
    await withPostgreSqlTestDatabase("public-schema-create-drift", async (database) => {
      await database.migrator.query({
        text: "GRANT CREATE ON SCHEMA lcm TO PUBLIC",
      }, { domain: "factory", operation: "driftPublicSchemaCreate" });
      const later = migration(
        "0007_public_acl_probe",
        "CREATE TABLE lcm.public_acl_probe (id integer PRIMARY KEY);",
      );

      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [...loadPostgreSqlMigrations(), later],
      })).rejects.toMatchObject({
        operation: "preflightSchemaAcl",
        publicCreate: true,
        remediation: "REVOKE CREATE ON SCHEMA \"lcm\" FROM PUBLIC;",
        schemaExists: true,
        schemaName: "lcm",
      });
      await expect(database.migrator.query<{
        applied_count: string;
        probe_exists: boolean;
        public_create: boolean;
      }>({
        text: `SELECT
                 (SELECT count(*)::text FROM lcm.schema_migrations) AS applied_count,
                 pg_catalog.to_regclass('lcm.public_acl_probe') IS NOT NULL AS probe_exists,
                 pg_catalog.has_schema_privilege('public', 'lcm', 'CREATE')
                   AS public_create`,
      }, { domain: "factory", operation: "verifyRecurringPublicAclRollback" }))
        .resolves.toMatchObject({
          rows: [{
              applied_count: "6",
            probe_exists: false,
            public_create: true,
          }],
        });
    });
  });

  it("rejects an administrator-owned schema despite delegated migrator CREATE", async () => {
    const database = await createPostgreSqlTestDatabase("schema-owner", { runMigrations: false });
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      await admin.query({
        text: `CREATE SCHEMA lcm AUTHORIZATION lcm_harness_admin;
               CREATE TABLE lcm.operator_table (value text);
               INSERT INTO lcm.operator_table VALUES ('preserve-me');
               GRANT USAGE, CREATE ON SCHEMA lcm TO lcm_test_migrator`,
      }, { domain: "factory", operation: "seedAdminOwnedSchema" });

      await expect(runPostgreSqlMigrations(database.migrator)).rejects.toMatchObject({
        backend: "postgresql",
        operation: "preflightSchemaOwnership",
        schemaExists: true,
        ownedByMigrator: false,
        requiredOwner: "lcm_test_migrator",
        remediation: "Transfer ownership of schema \"lcm\" and its LCM-owned objects to PostgreSQL role \"lcm_test_migrator\", then rerun migrations.",
      });
      await expect(admin.query<{
        admin_owned: boolean;
        migrator_create: boolean;
        value: string;
        ledger: boolean;
        owned_table: boolean;
      }>({
        text: `SELECT
          namespace.nspowner = 'lcm_harness_admin'::regrole AS admin_owned,
          has_schema_privilege('lcm_test_migrator', 'lcm', 'CREATE') AS migrator_create,
          (SELECT value FROM lcm.operator_table) AS value,
          to_regclass('lcm.schema_migrations') IS NOT NULL AS ledger,
          to_regclass('lcm.machines') IS NOT NULL AS owned_table
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname = 'lcm'`,
      }, { domain: "factory", operation: "verifyAdminOwnedSchemaPreserved" }))
        .resolves.toMatchObject({ rows: [{
          admin_owned: true,
          migrator_create: true,
          value: "preserve-me",
          ledger: false,
          owned_table: false,
        }] });
    } finally {
      try {
        await admin.close();
      } finally {
        await database.drop();
      }
    }
  });

  it("reports ledger ownership drift through the dedicated relation preflight", async () => {
    await withPostgreSqlTestDatabase("ledger-owner-drift", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({
          text: "ALTER TABLE lcm.schema_migrations OWNER TO lcm_harness_admin",
        }, { domain: "factory", operation: "driftMigrationLedgerOwner" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            ledgerExists: true,
            operation: "preflightMigrationLedgerRelation",
            ownedByMigrator: false,
            relationKind: "r",
            relationName: "schema_migrations",
            requiredOwner: "lcm_test_migrator",
            requiredRelationKind: "r",
            schemaName: "lcm",
          });
      } finally {
        await admin.query({
          text: "ALTER TABLE lcm.schema_migrations OWNER TO lcm_test_migrator",
        }, { domain: "factory", operation: "restoreMigrationLedgerOwner" });
        await admin.close();
      }
    });
  });

  it("rejects a migration session in replica mode before schema trust", async () => {
    await withPostgreSqlTestDatabase("migration-replication-role", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl, { poolMax: 1 }));
      try {
        await admin.query({
          text: "SET session_replication_role = replica",
        }, { domain: "factory", operation: "enableReplicaRoleForMigration" });
        await expect(runPostgreSqlMigrations(admin))
          .rejects.toMatchObject({
            operation: "preflightSessionReplicationRole",
            remediation:
              "Set session_replication_role to origin on the migration connection, or reconnect with its default session state, then rerun migrations.",
            requiredSessionReplicationRole: "origin",
            sessionReplicationRole: "replica",
          });
      } finally {
        await admin.query({
          text: "SET session_replication_role = origin",
        }, { domain: "factory", operation: "restoreOriginRoleAfterMigrationPreflight" });
        await expect(admin.query<{ session_replication_role: string }>({
          text: `SELECT pg_catalog.current_setting(
                   'session_replication_role'
                 ) AS session_replication_role`,
        }, { domain: "factory", operation: "verifyOriginRoleAfterMigrationPreflight" }))
          .resolves.toMatchObject({
            rows: [{ session_replication_role: "origin" }],
          });
        await admin.close();
      }
    });
  });

  it("rejects a view masquerading as the migration ledger before reading it", async () => {
    await withPostgreSqlTestDatabase("ledger-wrong-relkind", async (database) => {
      let ledgerRenamed = false;
      let replacementViewCreated = false;
      try {
        await database.migrator.query({
          text: "ALTER TABLE lcm.schema_migrations RENAME TO schema_migrations_backup",
        }, { domain: "factory", operation: "renameMigrationLedgerForRelkindDrift" });
        ledgerRenamed = true;
        await database.migrator.query({
          text: "CREATE VIEW lcm.schema_migrations AS SELECT 1::integer AS wrong_column",
        }, { domain: "factory", operation: "replaceMigrationLedgerWithView" });
        replacementViewCreated = true;

        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            ledgerExists: true,
            operation: "preflightMigrationLedgerRelation",
            ownedByMigrator: true,
            relationKind: "v",
            relationName: "schema_migrations",
            requiredOwner: "lcm_test_migrator",
            requiredRelationKind: "r",
            schemaName: "lcm",
          });
        await expect(database.migrator.query<{ applied_count: string }>({
          text: "SELECT count(*)::text AS applied_count FROM lcm.schema_migrations_backup",
        }, { domain: "factory", operation: "verifyLedgerRowsPreservedAfterRelkindDrift" }))
          .resolves.toMatchObject({ rows: [{ applied_count: "6" }] });
      } finally {
        if (replacementViewCreated) {
          await database.migrator.query({
            text: "DROP VIEW lcm.schema_migrations",
          }, { domain: "factory", operation: "dropReplacementMigrationLedgerView" });
        }
        if (ledgerRenamed) {
          await database.migrator.query({
            text: "ALTER TABLE lcm.schema_migrations_backup RENAME TO schema_migrations",
          }, { domain: "factory", operation: "restoreMigrationLedgerAfterRelkindDrift" });
        }
      }
    });
  });

  it("rechecks ownership of every managed object class while ignoring unknown objects", async () => {
    await withPostgreSqlTestDatabase("managed-owner-drift", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      const later = migration(
        "0007_managed_owner_probe",
        "CREATE TABLE lcm.managed_owner_probe (id integer PRIMARY KEY);",
      );
      try {
        await admin.query({
          text: `CREATE TABLE lcm.operator_admin_owned (value text);
                 ALTER TABLE lcm.operator_admin_owned OWNER TO lcm_harness_admin`,
        }, { domain: "factory", operation: "seedUnknownAdminOwnedObject" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .resolves.toMatchObject({ applied: [] });

        const drifts = [
          {
            label: "table",
            apply: "ALTER TABLE lcm.messages OWNER TO lcm_harness_admin",
            restore: "ALTER TABLE lcm.messages OWNER TO lcm_test_migrator",
          },
          {
            label: "sequence",
            apply: "ALTER TABLE lcm.fenced_leases OWNER TO lcm_harness_admin",
            restore: "ALTER TABLE lcm.fenced_leases OWNER TO lcm_test_migrator",
          },
          {
            label: "normalization function",
            apply:
              "ALTER FUNCTION lcm.normalize_search_text(text) OWNER TO lcm_harness_admin",
            restore:
              "ALTER FUNCTION lcm.normalize_search_text(text) OWNER TO lcm_test_migrator",
          },
          {
            label: "trigger function",
            apply:
              "ALTER FUNCTION lcm.enforce_summary_id_uniqueness() OWNER TO lcm_harness_admin",
            restore:
              "ALTER FUNCTION lcm.enforce_summary_id_uniqueness() OWNER TO lcm_test_migrator",
          },
          {
            label: "dictionary",
            apply:
              "ALTER TEXT SEARCH DICTIONARY lcm.simple_v1 OWNER TO lcm_harness_admin",
            restore:
              "ALTER TEXT SEARCH DICTIONARY lcm.simple_v1 OWNER TO lcm_test_migrator",
          },
          {
            label: "configuration",
            apply:
              "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 OWNER TO lcm_harness_admin",
            restore:
              "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 OWNER TO lcm_test_migrator",
          },
        ] as const;

        for (const drift of drifts) {
          await admin.query({ text: drift.apply }, {
            domain: "factory",
            operation: `driftManagedOwner:${drift.label}`,
          });
          try {
            const failure = await runPostgreSqlMigrations(database.migrator, {
              migrations: [...loadPostgreSqlMigrations(), later],
            }).catch((error: unknown) => error);
            expect(failure).toMatchObject({
              existingObjectCount: 40,
              operation: "preflightManagedObjectOwnership",
              requiredOwner: "lcm_test_migrator",
              schemaName: "lcm",
            });
            expect((failure as { unownedObjectCount?: number }).unownedObjectCount)
              .toBeGreaterThan(0);
          } finally {
            await admin.query({ text: drift.restore }, {
              domain: "factory",
              operation: `restoreManagedOwner:${drift.label}`,
            });
          }
          await expect(runPostgreSqlMigrations(database.migrator))
            .resolves.toMatchObject({ applied: [] });
        }

        await expect(database.migrator.query<{
          applied_count: string;
          operator_preserved: boolean;
          probe_exists: boolean;
        }>({
          text: `SELECT
                   (SELECT pg_catalog.count(*)::pg_catalog.text
                    FROM lcm.schema_migrations) AS applied_count,
                   pg_catalog.to_regclass('lcm.operator_admin_owned') IS NOT NULL
                     AS operator_preserved,
                   pg_catalog.to_regclass('lcm.managed_owner_probe') IS NOT NULL
                     AS probe_exists`,
        }, { domain: "factory", operation: "verifyManagedOwnerRollback" }))
          .resolves.toMatchObject({
            rows: [{
              applied_count: "6",
              operator_preserved: true,
              probe_exists: false,
            }],
          });
      } finally {
        await admin.close();
      }
    });
  });

  it("ignores same-name trigger and constraint collisions on operator tables", async () => {
    await withPostgreSqlTestDatabase("definition-collision", async (database) => {
      try {
        await database.migrator.query({
          text: `CREATE TABLE lcm.operator_definition_collision (
                   operator_id integer,
                   project_id uuid,
                   session_id text,
                   CONSTRAINT session_ingest_log_message_count_check
                     CHECK (operator_id > 0)
                 );
                 CREATE TRIGGER session_ingest_log_enforce_session_id_uniqueness
                   BEFORE INSERT ON lcm.operator_definition_collision
                   FOR EACH ROW
                   EXECUTE FUNCTION lcm.enforce_session_ingest_id_uniqueness()`,
        }, { domain: "factory", operation: "seedDefinitionNameCollisions" });

        await expect(runPostgreSqlMigrations(database.migrator))
          .resolves.toMatchObject({ applied: [] });
        await expect(database.migrator.query<{
          constraint_collision: boolean;
          trigger_collision: boolean;
        }>({
          text: `SELECT
                   EXISTS (
                     SELECT 1
                     FROM pg_catalog.pg_constraint AS constraint_metadata
                     JOIN pg_catalog.pg_class AS relation
                       ON relation.oid = constraint_metadata.conrelid
                     JOIN pg_catalog.pg_namespace AS namespace
                       ON namespace.oid = relation.relnamespace
                     WHERE namespace.nspname = 'lcm'
                       AND relation.relname = 'operator_definition_collision'
                       AND constraint_metadata.conname =
                         'session_ingest_log_message_count_check'
                   ) AS constraint_collision,
                   EXISTS (
                     SELECT 1
                     FROM pg_catalog.pg_trigger AS trigger
                     JOIN pg_catalog.pg_class AS relation
                       ON relation.oid = trigger.tgrelid
                     JOIN pg_catalog.pg_namespace AS namespace
                       ON namespace.oid = relation.relnamespace
                     WHERE namespace.nspname = 'lcm'
                       AND relation.relname = 'operator_definition_collision'
                       AND trigger.tgname =
                         'session_ingest_log_enforce_session_id_uniqueness'
                   ) AS trigger_collision`,
        }, { domain: "factory", operation: "verifyDefinitionNameCollisions" }))
          .resolves.toMatchObject({
            rows: [{
              constraint_collision: true,
              trigger_collision: true,
            }],
          });
      } finally {
        await database.migrator.query({
          text: "DROP TABLE IF EXISTS lcm.operator_definition_collision",
        }, { domain: "factory", operation: "dropDefinitionNameCollisions" });
      }
    });
  });

  it("rejects a missing object from the recorded 0002 inventory", async () => {
    await withPostgreSqlTestDatabase("migration-missing-object", async (database) => {
      await database.migrator.query({
        text: "DROP TABLE lcm.redaction_counters",
      }, { domain: "factory", operation: "simulateMissingBaselineObject" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          expectedObjectCount: 40,
          existingObjectCount: 39,
          missingObjectCount: 1,
          operation: "preflightManagedObjectOwnership",
        });
    });
  });

  it.each([
    {
      kind: "index",
      objectName: "session_ingest_log_identity_lookup_idx",
      sql: "DROP INDEX lcm.session_ingest_log_identity_lookup_idx",
    },
    {
      kind: "trigger",
      objectName: "session_ingest_log_enforce_session_id_uniqueness",
      sql: `DROP TRIGGER session_ingest_log_enforce_session_id_uniqueness
            ON lcm.session_ingest_log`,
    },
  ])("rejects a dropped baseline $kind", async ({ kind, objectName, sql }) => {
    await withPostgreSqlTestDatabase(`migration-missing-${kind}`, async (database) => {
      await database.migrator.query({ text: sql }, {
        domain: "factory",
        operation: `simulateMissingBaselineDefinition:${objectName}`,
      });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 879,
          missingObjectCount: 1,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects a disabled baseline identity trigger", async () => {
    await withPostgreSqlTestDatabase("migration-disabled-trigger", async (database) => {
      await database.migrator.query({
        text: `ALTER TABLE lcm.session_ingest_log
               DISABLE TRIGGER session_ingest_log_enforce_session_id_uniqueness`,
      }, {
        domain: "factory",
        operation: "simulateDisabledBaselineTrigger",
      });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("enforces session identity uniqueness in replica and origin modes", async () => {
    await withPostgreSqlTestDatabase("identity-trigger-replica", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await expect(admin.query<{ replication_role: string }>({
          text: `SELECT pg_catalog.current_setting(
                   'session_replication_role'
                 ) AS replication_role`,
        }, { domain: "factory", operation: "verifyOriginReplicationRole" }))
          .resolves.toMatchObject({ rows: [{ replication_role: "origin" }] });
        const project = await database.migrator.query<{ project_id: string }>({
          text: `INSERT INTO lcm.projects (identity_key, display_name)
                 VALUES (pg_catalog.repeat('a', 64), 'replica identity project')
                 RETURNING project_id::pg_catalog.text`,
        }, { domain: "factory", operation: "createReplicaIdentityProject" });
        const projectId = project.rows[0]!.project_id;
        await admin.query({
          text: "SET session_replication_role = replica",
        }, { domain: "factory", operation: "enableReplicaRole" });
        await admin.query({
          text: `INSERT INTO lcm.session_ingest_log
                   (project_id, session_id, message_count)
                 VALUES ($1, 'replica-session', 1)`,
          values: [projectId],
        }, { domain: "factory", operation: "claimReplicaSessionIdentity" });
        await expect(admin.query({
          text: `INSERT INTO lcm.session_ingest_log
                   (project_id, session_id, message_count)
                 VALUES ($1, 'replica-session', 1)`,
          values: [projectId],
        }, { domain: "factory", operation: "rejectReplicaSessionIdentity" }))
          .rejects.toMatchObject({
            operation: "rejectReplicaSessionIdentity",
            sqlState: "23505",
          });
      } finally {
        await admin.query({
          text: "SET session_replication_role = origin",
        }, { domain: "factory", operation: "restoreOriginRole" });
        await admin.close();
      }
    });
  });

  it("normalizes null identity-sequence ACLs with sequence defaults", async () => {
    await withPostgreSqlTestDatabase("identity-sequence-default-acl", async (database) => {
      try {
        await database.migrator.query({
          text: `ALTER TABLE lcm.conversations
                   ALTER COLUMN conversation_id DROP IDENTITY;
                 ALTER TABLE lcm.conversations
                   ALTER COLUMN conversation_id
                   ADD GENERATED BY DEFAULT AS IDENTITY`,
        }, { domain: "factory", operation: "recreateIdentitySequenceWithDefaultAcl" });
        await expect(database.migrator.query<{ relacl_is_null: boolean }>({
          text: `SELECT relation.relacl IS NULL AS relacl_is_null
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = relation.relnamespace
                 WHERE namespace.nspname = 'lcm'
                   AND relation.relname = 'conversations_conversation_id_seq'`,
        }, { domain: "factory", operation: "inspectIdentitySequenceDefaultAcl" }))
          .resolves.toMatchObject({ rows: [{ relacl_is_null: true }] });
        await expect(runPostgreSqlMigrations(database.migrator))
          .resolves.toMatchObject({ applied: [] });
      } finally {
        await database.migrator.query({
          text: `REVOKE ALL PRIVILEGES
                 ON SEQUENCE lcm.conversations_conversation_id_seq
                 FROM PUBLIC`,
        }, { domain: "factory", operation: "restoreIdentitySequenceExplicitAcl" });
      }
    });
  });

  it("rejects constraint drift containing an lcm-qualified string literal", async () => {
    await withPostgreSqlTestDatabase("constraint-literal-drift", async (database) => {
      await database.migrator.query({
        text: `ALTER TABLE lcm.machines
                 DROP CONSTRAINT machines_display_name_check;
               ALTER TABLE lcm.machines
                 ADD CONSTRAINT machines_display_name_check
                 CHECK (display_name IS NULL OR btrim(display_name) <> 'lcm.')`,
      }, { domain: "factory", operation: "simulateConstraintLiteralDrift" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects disabled internal constraint triggers", async () => {
    await withPostgreSqlTestDatabase("constraint-trigger-disabled", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({
          text: "ALTER TABLE lcm.messages DISABLE TRIGGER ALL",
        }, { domain: "factory", operation: "disableBaselineConstraintTriggers" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await admin.query({
          text: "ALTER TABLE lcm.messages ENABLE TRIGGER ALL",
        }, { domain: "factory", operation: "restoreBaselineConstraintTriggers" });
        await admin.close();
      }
    });
  });

  it("rejects a generated column whose expression is dropped", async () => {
    await withPostgreSqlTestDatabase("generated-column-drift", async (database) => {
      await database.migrator.query({
        text: `ALTER TABLE lcm.session_ingest_log
               ALTER COLUMN session_id_sha256 DROP EXPRESSION`,
      }, { domain: "factory", operation: "dropGeneratedColumnExpression" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 2,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects generated column nullability drift", async () => {
    await withPostgreSqlTestDatabase("generated-column-nullability-drift", async (database) => {
      try {
        await database.migrator.query({
          text: `ALTER TABLE lcm.recall_surfacing
                 ALTER COLUMN session_id_sha256 SET NOT NULL`,
        }, { domain: "factory", operation: "alterGeneratedColumnNullability" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: `ALTER TABLE lcm.recall_surfacing
                 ALTER COLUMN session_id_sha256 DROP NOT NULL`,
        }, { domain: "factory", operation: "restoreGeneratedColumnNullability" });
      }
    });
  });

  it("pins every ordinary column on the allowlisted baseline tables", async () => {
    await withPostgreSqlTestDatabase("ordinary-column-inventory", async (database) => {
      const snapshot = loadPostgreSqlSchemaSnapshots()[0]!;
      const result = await database.migrator.query<{ object_identity: string }>({
        text: `SELECT pg_catalog.concat_ws(
                         '|',
                         relation.relname,
                         attribute.attname
                       ) AS object_identity
               FROM pg_catalog.pg_attribute AS attribute
               JOIN pg_catalog.pg_class AS relation
                 ON relation.oid = attribute.attrelid
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm'
                 AND relation.relkind = 'r'
                 AND relation.relname = ANY ($1::text[])
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
                 AND attribute.attgenerated = ''
               ORDER BY object_identity`,
        values: [snapshot.tableIdentities],
      }, { domain: "factory", operation: "verifyOrdinaryColumnInventory" });
      expect(result.rows.map(({ object_identity }) => object_identity))
        .toEqual([...snapshot.ordinaryColumnIdentities].sort());
      expect(snapshot.ordinaryColumnIdentities).toHaveLength(210);
      expect(snapshot.ordinaryColumnIdentities).toContain("recall_surfacing|surfaced_at");
    });
  });

  it("rejects ordinary column metadata drift", async () => {
    await withPostgreSqlTestDatabase("ordinary-column-drift", async (database) => {
      await database.migrator.query({
        text: "ALTER TABLE lcm.projects ALTER COLUMN identity_key DROP NOT NULL",
      }, { domain: "factory", operation: "dropProjectIdentityNotNull" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects ordinary column collation drift", async () => {
    await withPostgreSqlTestDatabase("ordinary-column-collation-drift", async (database) => {
      await database.migrator.query({
        text: `ALTER TABLE lcm.projects
               ALTER COLUMN display_name TYPE text COLLATE pg_catalog."C"`,
      }, { domain: "factory", operation: "alterProjectDisplayNameCollation" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects table persistence drift", async () => {
    await withPostgreSqlTestDatabase("table-persistence-drift", async (database) => {
      await database.migrator.query({
        text: "ALTER TABLE lcm.schema_migrations SET UNLOGGED",
      }, { domain: "factory", operation: "alterBaselineTablePersistence" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects managed table access-method drift", async () => {
    await withPostgreSqlTestDatabase(
      "table-access-method-drift",
      async (database) => {
        await runPostgreSqlMigrations(database.migrator);
        await applyRuntimeGrantScripts(database);
        const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
        const accessMethodName = `${database.name.slice(0, 47)}_heap_alias`;
        let accessMethodCreated = false;
        try {
          const support = await administrator.query<{ supported: boolean }>({
            text: `SELECT pg_catalog.to_regprocedure(
                     'pg_catalog.heap_tableam_handler(internal)'
                   ) IS NOT NULL AS supported`,
          }, { domain: "factory", operation: "inspectHeapTableAccessMethodHandler" });
          expect(support).toMatchObject({ rows: [{ supported: true }] });

          await administrator.query({
            text: `CREATE ACCESS METHOD "${accessMethodName}"
                   TYPE TABLE HANDLER pg_catalog.heap_tableam_handler`,
          }, { domain: "factory", operation: "createHeapTableAccessMethodAlias" });
          accessMethodCreated = true;
          await administrator.query({
            text: `ALTER TABLE lcm.projects
                   SET ACCESS METHOD "${accessMethodName}"`,
          }, { domain: "factory", operation: "alterManagedTableAccessMethod" });

          const readinessFailure = await verifyPostgreSqlRuntimeSchema(database.runtime, {
            expectedOwner: "lcm_test_migrator",
          }).catch((error: unknown) => error);
          const migrationFailure = await runPostgreSqlMigrations(database.migrator)
            .catch((error: unknown) => error);
          expect({ readinessFailure, migrationFailure }).toMatchObject({
            readinessFailure: {
              reason: "schema-fingerprint",
              operation: "inspectSchemaDefinitions",
            },
            migrationFailure: {
              baselineApplied: true,
              driftedDefinitionGroupCount: 1,
              expectedObjectCount: 880,
              existingObjectCount: 880,
              missingObjectCount: 0,
              operation: "preflightBaselineDefinitions",
            },
          });
        } finally {
          try {
            if (accessMethodCreated) {
              try {
                await administrator.query({
                  text: "ALTER TABLE lcm.projects SET ACCESS METHOD heap",
                }, { domain: "factory", operation: "restoreManagedTableAccessMethod" });
              } finally {
                await administrator.query({
                  text: `DROP ACCESS METHOD "${accessMethodName}"`,
                }, { domain: "factory", operation: "dropHeapTableAccessMethodAlias" });
              }
            }
          } finally {
            await administrator.close();
          }
        }
      },
      { runMigrations: false },
    );
  });

  it("rejects table row-level-security drift", async () => {
    await withPostgreSqlTestDatabase("table-row-security-drift", async (database) => {
      try {
        await database.migrator.query({
          text: `ALTER TABLE lcm.projects ENABLE ROW LEVEL SECURITY;
                 ALTER TABLE lcm.projects FORCE ROW LEVEL SECURITY`,
        }, { domain: "factory", operation: "enableProjectRowSecurity" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: `ALTER TABLE lcm.projects NO FORCE ROW LEVEL SECURITY;
                 ALTER TABLE lcm.projects DISABLE ROW LEVEL SECURITY`,
        }, { domain: "factory", operation: "restoreProjectRowSecurity" });
      }
    });
  });

  it("rejects inheritance relationships involving managed tables", async () => {
    await withPostgreSqlTestDatabase("table-inheritance-drift", async (database) => {
      try {
        await database.migrator.query({
          text: "CREATE TABLE lcm.projects_inheritance_probe () INHERITS (lcm.projects)",
        }, { domain: "factory", operation: "createManagedTableInheritance" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: "DROP TABLE IF EXISTS lcm.projects_inheritance_probe",
        }, { domain: "factory", operation: "dropManagedTableInheritance" });
      }
    });
  });

  it("rejects relation ACL drift", async () => {
    await withPostgreSqlTestDatabase("relation-acl-drift", async (database) => {
      await database.migrator.query({
        text: "GRANT SELECT ON TABLE lcm.projects TO PUBLIC",
      }, { domain: "factory", operation: "grantPublicProjectSelect" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("normalizes the documented runtime identity grants but rejects extra privileges", async () => {
    await withPostgreSqlTestDatabase("runtime-identity-grants", async (database) => {
      await database.migrator.query({
        text: `GRANT USAGE ON SCHEMA lcm TO lcm_test_runtime;
               GRANT SELECT ON lcm.machines, lcm.projects, lcm.project_aliases
                 TO lcm_test_runtime;
               GRANT INSERT (identity_key, display_name) ON lcm.machines
                 TO lcm_test_runtime;
               GRANT UPDATE (display_name, last_seen_at) ON lcm.machines
                 TO lcm_test_runtime;
               GRANT INSERT (identity_key, display_name) ON lcm.projects
                 TO lcm_test_runtime;
               GRANT DELETE ON lcm.projects TO lcm_test_runtime;
               GRANT INSERT (project_id, machine_id, path, normalized_path)
                 ON lcm.project_aliases TO lcm_test_runtime;
               GRANT UPDATE (project_id, path, linked_at)
                 ON lcm.project_aliases TO lcm_test_runtime;
               GRANT DELETE ON lcm.project_aliases TO lcm_test_runtime`,
      }, { domain: "factory", operation: "grantRuntimeIdentityPrivileges" });

      await expect(runPostgreSqlMigrations(database.migrator))
        .resolves.toMatchObject({ applied: [] });

      await database.migrator.query({
        text: "GRANT TRUNCATE ON lcm.projects TO lcm_test_runtime",
      }, { domain: "factory", operation: "grantUnexpectedRuntimePrivilege" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("normalizes passive replication grants but rejects broader inbox writes", async () => {
    await withPostgreSqlTestDatabase("runtime-passive-event-grants", async (database) => {
      await applyCoordinationRuntimeGrant(database);
      await expect(runPostgreSqlMigrations(database.migrator))
        .resolves.toMatchObject({ applied: [] });

      await database.migrator.query({
        text: `GRANT UPDATE (payload)
               ON lcm.passive_event_inbox TO lcm_test_runtime`,
      }, { domain: "factory", operation: "grantUnexpectedInboxPayloadUpdate" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects column ACL drift", async () => {
    await withPostgreSqlTestDatabase("column-acl-drift", async (database) => {
      try {
        await database.migrator.query({
          text: "GRANT SELECT (identity_key) ON lcm.projects TO PUBLIC",
        }, { domain: "factory", operation: "grantPublicProjectIdentitySelect" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: "REVOKE SELECT (identity_key) ON lcm.projects FROM PUBLIC",
        }, { domain: "factory", operation: "revokePublicProjectIdentitySelect" });
      }
    });
  });

  it("rejects identity-sequence parameter drift", async () => {
    await withPostgreSqlTestDatabase("identity-sequence-drift", async (database) => {
      await database.migrator.query({
        text: `ALTER SEQUENCE lcm.conversations_conversation_id_seq
               MAXVALUE 999999 CYCLE`,
      }, { domain: "factory", operation: "alterIdentitySequenceParameters" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rejects identity-sequence persistence drift", async () => {
    await withPostgreSqlTestDatabase("identity-sequence-persistence-drift", async (database) => {
      try {
        await database.migrator.query({
          text: "ALTER SEQUENCE lcm.conversations_conversation_id_seq SET UNLOGGED",
        }, { domain: "factory", operation: "setIdentitySequenceUnlogged" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedDefinitionGroupCount: 1,
            expectedObjectCount: 880,
            existingObjectCount: 880,
            missingObjectCount: 0,
            operation: "preflightBaselineDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: "ALTER SEQUENCE lcm.conversations_conversation_id_seq SET LOGGED",
        }, { domain: "factory", operation: "restoreIdentitySequencePersistence" });
      }
    });
  });

  it("binds constraint names to their definitions", async () => {
    await withPostgreSqlTestDatabase("constraint-name-drift", async (database) => {
      await database.migrator.query({
        text: `ALTER TABLE lcm.machines
                 RENAME CONSTRAINT machines_identity_key_check
                 TO machines_identity_key_check_swap;
               ALTER TABLE lcm.machines
                 RENAME CONSTRAINT machines_display_name_check
                 TO machines_identity_key_check;
               ALTER TABLE lcm.machines
                 RENAME CONSTRAINT machines_identity_key_check_swap
                 TO machines_display_name_check`,
      }, { domain: "factory", operation: "swapMachineConstraintNames" });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          expectedObjectCount: 880,
          existingObjectCount: 880,
          missingObjectCount: 0,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("rolls back a pending migration that violates its target schema snapshot", async () => {
    await withPostgreSqlTestDatabase("target-schema-snapshot", async (database) => {
      const invalidTarget = migration(
        "0007_invalid_column_snapshot",
        "ALTER TABLE lcm.projects ALTER COLUMN identity_key DROP NOT NULL",
      );
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [...loadPostgreSqlMigrations(), invalidTarget],
      })).rejects.toMatchObject({
        baselineApplied: true,
        driftedDefinitionGroupCount: 1,
        operation: "preflightBaselineDefinitions",
      });
      await expect(database.migrator.query<{
        applied: boolean;
        not_null: boolean;
      }>({
        text: `SELECT
                 EXISTS (
                   SELECT 1
                   FROM lcm.schema_migrations
                   WHERE id = '0007_invalid_column_snapshot'
                 ) AS applied,
                 attribute.attnotnull AS not_null
               FROM pg_catalog.pg_attribute AS attribute
               JOIN pg_catalog.pg_class AS relation
                 ON relation.oid = attribute.attrelid
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm'
                 AND relation.relname = 'projects'
                 AND attribute.attname = 'identity_key'`,
      }, { domain: "factory", operation: "verifyTargetSchemaSnapshotRollback" }))
        .resolves.toMatchObject({
          rows: [{ applied: false, not_null: true }],
        });
    });
  });

  it("uses versioned managed inventories for valid additions and target rollback", async () => {
    await withPostgreSqlTestDatabase("target-managed-snapshot", async (database) => {
      const packagedMigrations = loadPostgreSqlMigrations();
      const packagedSnapshots = loadPostgreSqlSchemaSnapshots();
      const baselineSnapshot = packagedSnapshots.at(-1)!;
      const addManagedObject = migration(
        "0007_add_managed_snapshot_probe",
        "CREATE TABLE lcm.managed_snapshot_probe (id integer PRIMARY KEY)",
      );
      const futureSnapshot = {
        ...baselineSnapshot,
        managedObjectIdentities: [
          ...baselineSnapshot.managedObjectIdentities,
          "table|managed_snapshot_probe",
        ],
        migrationId: addManagedObject.id,
      };
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [...packagedMigrations, addManagedObject],
        schemaSnapshots: [...packagedSnapshots, futureSnapshot],
      })).resolves.toMatchObject({ applied: [addManagedObject.id] });

      const dropManagedObject = migration(
        "0008_drop_managed_snapshot_probe",
        "DROP TABLE lcm.managed_snapshot_probe",
      );
      const damagedTargetSnapshot = {
        ...futureSnapshot,
        migrationId: dropManagedObject.id,
      };
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [...packagedMigrations, addManagedObject, dropManagedObject],
        schemaSnapshots: [
          ...packagedSnapshots,
          futureSnapshot,
          damagedTargetSnapshot,
        ],
      })).rejects.toMatchObject({
        baselineApplied: true,
        expectedObjectCount: 41,
        existingObjectCount: 40,
        missingObjectCount: 1,
        operation: "preflightManagedObjectOwnership",
      });
      await expect(database.migrator.query<{
        applied: boolean;
        table_exists: boolean;
      }>({
        text: `SELECT
                 EXISTS (
                   SELECT 1
                   FROM lcm.schema_migrations
                   WHERE id = '0008_drop_managed_snapshot_probe'
                 ) AS applied,
                 pg_catalog.to_regclass('lcm.managed_snapshot_probe')
                   IS NOT NULL AS table_exists`,
      }, { domain: "factory", operation: "verifyTargetManagedSnapshotRollback" }))
        .resolves.toMatchObject({
          rows: [{ applied: false, table_exists: true }],
        });
    });
  });

  it.each([
    {
      label: "body",
      sql: `CREATE OR REPLACE FUNCTION lcm.enforce_summary_id_uniqueness()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
              RETURN NEW;
            END
            $function$`,
    },
    {
      label: "security configuration",
      sql: "ALTER FUNCTION lcm.enforce_large_file_id_uniqueness() SECURITY DEFINER",
    },
  ])("rejects identity-trigger $label drift", async ({ label, sql }) => {
    await withPostgreSqlTestDatabase(`migration-trigger-${label}`, async (database) => {
      await database.migrator.query({ text: sql }, {
        domain: "factory",
        operation: `simulateIdentityFunctionDrift:${label}`,
      });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedFunctionCount: 1,
          existingFunctionCount: 4,
          expectedFunctionCount: 4,
          operation: "preflightIdentityFunctionDefinitions",
        });
    });
  });

  it("rejects identity-trigger EXECUTE granted to a named role", async () => {
    await withPostgreSqlTestDatabase("migration-trigger-named-acl", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({
          text: "CREATE ROLE lcm_identity_acl_probe",
        }, { domain: "factory", operation: "createIdentityAclProbeRole" });
        await database.migrator.query({
          text: `GRANT EXECUTE
                 ON FUNCTION lcm.enforce_session_ingest_id_uniqueness()
                 TO lcm_identity_acl_probe`,
        }, { domain: "factory", operation: "grantIdentityFunctionToNamedRole" });
        await expect(runPostgreSqlMigrations(database.migrator))
          .rejects.toMatchObject({
            baselineApplied: true,
            driftedFunctionCount: 1,
            existingFunctionCount: 4,
            expectedFunctionCount: 4,
            operation: "preflightIdentityFunctionDefinitions",
          });
      } finally {
        await database.migrator.query({
          text: `REVOKE ALL
                 ON FUNCTION lcm.enforce_session_ingest_id_uniqueness()
                 FROM lcm_identity_acl_probe`,
        }, { domain: "factory", operation: "revokeIdentityFunctionFromNamedRole" });
        await admin.query({
          text: "DROP ROLE lcm_identity_acl_probe",
        }, { domain: "factory", operation: "dropIdentityAclProbeRole" });
        await admin.close();
      }
    });
  });

  it("rejects checksum drift and rolls back a failed pending migration", async () => {
    await withPostgreSqlTestDatabase("migration-drift", async (database) => {
      const baseline = migration("0001_migration_ledger", ledgerSql);
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [baseline],
        schemaSnapshots: [],
      }))
        .rejects.toMatchObject({ operation: "verifyMigrationHistory" });

      const current = await database.migrator.query<{ checksum_sha256: string }>({
        text: "SELECT checksum_sha256 FROM lcm.schema_migrations WHERE id = $1",
        values: ["0001_migration_ledger"],
      }, { domain: "factory", operation: "readChecksum" });
      const exactBaseline: PostgreSqlMigration = {
        ...baseline,
        sha256: current.rows[0].checksum_sha256,
        sql: await import("node:fs").then(({ readFileSync }) => readFileSync(
          new URL("../../src/storage/postgresql/migrations/0001_migration_ledger.sql", import.meta.url),
          "utf8",
        )),
      };
      const failing = migration("0002_failure", "CREATE TABLE lcm.rollback_probe (id integer); SELECT missing_column FROM missing_table;");
      await expect(runPostgreSqlMigrations(database.migrator, {
        migrations: [exactBaseline, failing],
        schemaSnapshots: [],
      }))
        .rejects.toMatchObject({ backend: "postgresql" });
      await expect(database.migrator.query<{ exists: boolean }>({
        text: "SELECT to_regclass('lcm.rollback_probe') IS NOT NULL AS exists",
      }, { domain: "factory", operation: "verifyRollback" })).resolves.toMatchObject({ rows: [{ exists: false }] });
    });
  });

  it("creates isolated databases concurrently and blocks an insufficient runtime role", async () => {
    const databases = await Promise.all([
      createPostgreSqlTestDatabase("parallel-a"),
      createPostgreSqlTestDatabase("parallel-b"),
      createPostgreSqlTestDatabase("parallel-c"),
    ]);
    try {
      expect(new Set(databases.map((database) => database.name)).size).toBe(3);
      await Promise.all(databases.map(async (database) => {
        const forbidden = migration(
          "0007_runtime_forbidden",
          "CREATE TABLE lcm.runtime_forbidden (id integer);",
        );
        await expect(runPostgreSqlMigrations(database.runtime, {
          migrations: [...loadPostgreSqlMigrations(), forbidden],
        })).rejects.toMatchObject({
          backend: "postgresql",
          code: "STORAGE_INITIALIZATION_FAILED",
          operation: "preflightSchemaOwnership",
          ownedByMigrator: false,
          requiredOwner: "lcm_test_runtime",
          schemaExists: true,
          schemaName: "lcm",
        });
      }));
    } finally {
      await Promise.all(databases.map(async (database) => database.drop()));
    }
  });

  it("deduplicates concurrent and repeated database drops", async () => {
    const database = await createPostgreSqlTestDatabase("drop-concurrency");

    const first = database.drop();
    const concurrent = database.drop();
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined]);

    const repeated = database.drop();
    expect(repeated).toBe(first);
    await expect(repeated).resolves.toBeUndefined();
  });

  it("deduplicates a failed guarded drop and permits a deliberate retry", async () => {
    const database = await createPostgreSqlTestDatabase("sentinel-guard");
    const admin = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = 'mismatched'",
      }, { domain: "factory", operation: "corruptSentinel" });
      const failed = database.drop();
      const concurrentFailure = database.drop();
      expect(concurrentFailure).toBe(failed);
      await expect(failed).rejects.toThrow("refusing to drop");
      await admin.query({
        text: "UPDATE public.__lcm_test_run_sentinel SET run_id = $1",
        values: [process.env.LCM_TEST_POSTGRES_RUN_ID],
      }, { domain: "factory", operation: "repairSentinel" });
      const retry = database.drop();
      expect(retry).not.toBe(failed);
      expect(database.drop()).toBe(retry);
      await expect(retry).resolves.toBeUndefined();
    } finally {
      await admin.close();
      await database.drop();
    }
  });
});
