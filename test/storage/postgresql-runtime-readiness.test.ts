import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

const migrationMockState = vi.hoisted(() => ({
  duplicateColumnIdentity: false,
  returnNoLatestSnapshot: false,
}));

vi.mock("../../src/storage/postgresql/migrations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/postgresql/migrations.js")>();
  return {
    ...actual,
    loadPostgreSqlSchemaSnapshots: () => {
      const snapshots = actual.loadPostgreSqlSchemaSnapshots();
      if (!migrationMockState.duplicateColumnIdentity) return snapshots;
      const last = snapshots.at(-1)!;
      return [
        ...snapshots.slice(0, -1),
        {
          ...last,
          columnAclIdentities: [
            ...last.columnAclIdentities,
            last.columnAclIdentities[0]!,
          ],
        },
      ];
    },
    selectLatestPostgreSqlSchemaSnapshot: (...args: Parameters<typeof actual.selectLatestPostgreSqlSchemaSnapshot>) => (
      migrationMockState.returnNoLatestSnapshot
        ? null
        : actual.selectLatestPostgreSqlSchemaSnapshot(...args)
    ),
  };
});

import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST,
  PostgreSqlRuntimeReadinessError,
  verifyPostgreSqlRuntimeSchema,
  type PostgreSqlRuntimePrivilegeEntry,
} from "../../src/storage/postgresql/runtime-readiness.js";
import {
  getPostgreSqlSchemaSnapshotExpectations,
  loadPostgreSqlMigrations,
  loadPostgreSqlSchemaSnapshots,
} from "../../src/storage/postgresql/migrations.js";
import { REQUIRED_POSTGRESQL_EXTENSIONS } from "../../src/storage/postgresql/extensions.js";
import { POSTGRESQL_SEARCH_CONFIGURATION_SHA256 } from "../../src/storage/postgresql/search-configuration.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function executor(): {
  readonly seam: PostgreSqlQueryExecutor;
  readonly queries: readonly { config: unknown; options: PostgreSqlQueryOptions }[];
} {
  const queries: { config: unknown; options: PostgreSqlQueryOptions }[] = [];
  const query = vi.fn(async (
    config: unknown,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<QueryResultRow>> => {
    queries.push({ config, options });
    return result([]);
  });
  return { seam: { query }, queries };
}

interface ReadyExecutorOptions {
  readonly includeSequenceRuntimeGrant?: boolean;
  readonly omitLcmPublicDefault?: boolean;
  readonly omitPublicSchemaUsage?: boolean;
  readonly omitPublicFunctionExecute?: boolean;
  readonly omitOptionalDirectGrants?: boolean;
  readonly partialOptionalDirectGrants?: boolean;
  readonly partialOptionalEffectiveGrants?: boolean;
  readonly incompleteEffectivePrivileges?: boolean;
  readonly operationOverrides?: Readonly<Record<string, ReadyExecutorOverride>>;
}

type ReadyExecutorBaseResult = QueryResult<QueryResultRow>;
type ReadyExecutorOverride =
  | readonly QueryResultRow[]
  | ReadyExecutorBaseResult
  | { readonly error: unknown }
  | ((base: ReadyExecutorBaseResult) => ReadyExecutorBaseResult | readonly QueryResultRow[]);

function mutateRows(
  mutation: (rows: QueryResultRow[]) => void,
): (base: ReadyExecutorBaseResult) => ReadyExecutorBaseResult {
  return (base) => {
    const rows = base.rows.map((row) => ({ ...row }));
    mutation(rows);
    return replaceRows(base, rows);
  };
}

function replaceRows(
  base: ReadyExecutorBaseResult,
  rows: readonly QueryResultRow[],
): ReadyExecutorBaseResult {
  return { ...base, rowCount: rows.length, rows };
}

function readyExecutor(fixtureOptions: ReadyExecutorOptions = {}): {
  readonly seam: PostgreSqlQueryExecutor;
  readonly queries: readonly { config: unknown; options: PostgreSqlQueryOptions }[];
} {
  const queries: { config: unknown; options: PostgreSqlQueryOptions }[] = [];
  const migrations = loadPostgreSqlMigrations();
  const snapshot = loadPostgreSqlSchemaSnapshots().at(-1)!;
  const expectations = getPostgreSqlSchemaSnapshotExpectations(snapshot);
  const runtimeRole = "lcm_test_runtime";
  const includeSequenceRuntimeGrant = fixtureOptions.includeSequenceRuntimeGrant ?? true;
  const optionalRelationEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional
    .filter(({ kind }) => kind === "relation");
  const optionalColumnEntries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional
    .filter(({ kind }) => kind === "column");
  const selectedOptionalRelationEntries = fixtureOptions.omitOptionalDirectGrants
    ? []
    : fixtureOptions.partialOptionalDirectGrants
      ? optionalRelationEntries.slice(0, 1)
      : optionalRelationEntries;
  const selectedOptionalColumnEntries = fixtureOptions.omitOptionalDirectGrants
    ? []
    : fixtureOptions.partialOptionalDirectGrants
      ? []
      : optionalColumnEntries;
  const omitLcmPublicDefault = fixtureOptions.omitLcmPublicDefault ?? true;
  const ownerRow = {
    grantee_is_owner: true,
    grantee_name: null,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const runtimeRow = {
    grantee_is_owner: false,
    grantee_name: runtimeRole,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const publicRow = {
    grantee_is_owner: false,
    grantee_name: null,
    grantor_is_owner: true,
    is_grantable: false,
  };
  const query = vi.fn(async (
    config: unknown,
    queryOptions: PostgreSqlQueryOptions,
  ): Promise<QueryResult<QueryResultRow>> => {
    queries.push({ config, options: queryOptions });
    const operation = queryOptions.operation;
    const applyOverride = (base: ReadyExecutorBaseResult): ReadyExecutorBaseResult => {
      const override = fixtureOptions.operationOverrides?.[operation];
      if (override === undefined) return base;
      if (typeof override === "function") {
        const replacement = override(base);
        return Array.isArray(replacement) ? replaceRows(base, replacement) : replacement;
      }
      if (Array.isArray(override)) return replaceRows(base, override);
      if ("error" in override) throw override.error;
      return override;
    };
    if (operation === "inspectServerReadiness") {
      return applyOverride(result([{
        server_version_num: 180004,
        server_encoding: "UTF8",
        timezone: "UTC",
        tls: true,
      }]));
    }
    if (operation === "inspectRuntimeRolePolicy") {
      return applyOverride(result([{
        current_user_name: runtimeRole,
        session_user_name: runtimeRole,
        role_exists: true,
        superuser: false,
        create_role: false,
        create_database: false,
        replication: false,
        bypass_rls: false,
        membership_count: 0,
        tls: true,
        expected_owner_match: false,
        expected_owner_count: 1,
        expected_owner_oid: "100",
        database_owner_count: 1,
        database_owner_oid_count: 1,
        database_owner_oid: "100",
        database_owner_match: true,
      }]));
    }
    if (operation === "runtimeReadinessExtensions") {
      return applyOverride(result(REQUIRED_POSTGRESQL_EXTENSIONS.map((name) => ({
        name,
        default_version: "1.0",
        installed_version: "1.0",
        installed_schema: "public",
        relocatable: true,
        preloaded: name === "pg_stat_statements" ? true : null,
      }))));
    }
    if (operation === "runtimeReadinessExtensions:probePgStatStatements") {
      return applyOverride(result([{ stats_reset: new Date() }]));
    }
    if (operation === "runtimeReadinessSearchConfiguration") {
      return applyOverride(result([{
        actual_sha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
        object_count: "19",
        ownership_ready: true,
      }]));
    }
    if (operation === "readMigrations") {
      return applyOverride(result(migrations.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }))));
    }
    if (operation === "inspectSchemaOwnership") {
      return applyOverride(result([{
        expected_owner_exists: true,
        schema_exists: true,
        schema_owned: true,
        ledger_exists: true,
        ledger_kind: "r",
        ledger_owned: true,
        expected_object_count: snapshot.managedObjectIdentities.length,
        actual_object_count: snapshot.managedObjectIdentities.length,
        owned_object_count: snapshot.managedObjectIdentities.length,
      }]));
    }
    if (operation === "inspectSchemaDefinitions") {
      return applyOverride(result([{
        baseline_applied: true,
        expected_object_count: expectations.definitionObjectCount,
        existing_object_count: expectations.definitionObjectCount,
        actual_definition_group_counts: expectations.definitionGroupCounts,
        actual_definition_group_hashes: expectations.definitionGroupHashes,
        missing_object_count: 0,
        drifted_definition_group_count: 0,
      }]));
    }
    if (operation === "inspectIdentityFunctions") {
      return applyOverride(result([{
        expected_function_count: snapshot.identityFunctions.length,
        existing_function_count: snapshot.identityFunctions.length,
        drifted_function_count: 0,
      }]));
    }
    if (operation === "inspectSchemaAcl") {
      return applyOverride(result([
        ...["lcm", "public"].flatMap((schema_name) => [
          { schema_name, object_identity: schema_name, privilege_type: "CREATE", ...ownerRow },
          { schema_name, object_identity: schema_name, privilege_type: "USAGE", ...ownerRow },
          ...(!(omitLcmPublicDefault && schema_name === "lcm")
            && !(fixtureOptions.omitPublicSchemaUsage && schema_name === "public")
            ? [{ schema_name, object_identity: schema_name, privilege_type: "USAGE", ...publicRow }]
            : []),
        ]),
        { schema_name: "lcm", object_identity: "lcm", privilege_type: "USAGE", ...runtimeRow },
        { schema_name: "public", object_identity: "public", privilege_type: "USAGE", ...runtimeRow },
      ]));
    }
    if (operation === "inspectRelationAcl") {
      const ownerPrivileges = (object: string): readonly string[] => (
        object.startsWith("table|")
          ? ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]
          : ["SELECT", "UPDATE", "USAGE"]
      );
      const required = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required;
      const objects = (config as { values?: unknown[] }).values?.[0] as string[];
      const rows = [
        ...objects.flatMap((object) => [
          ...ownerPrivileges(object).map((privilege_type) => ({ object_identity: object, privilege_type, ...ownerRow })),
          ...required
            .filter((entry) => (
              entry.kind === "relation"
                ? `table|${entry.object.replace(/^lcm\./u, "")}` === object
                : entry.kind === "sequence" && includeSequenceRuntimeGrant
                  ? `sequence|${entry.object.replace(/^lcm\./u, "")}` === object
                  : false
            ))
            .map(({ privilege }) => ({ object_identity: object, privilege_type: privilege, ...runtimeRow })),
          ...selectedOptionalRelationEntries
            .filter(({ object: entryObject }) => (
              `table|${entryObject.replace(/^lcm\./u, "")}` === object
            ))
            .map(({ privilege }) => ({ object_identity: object, privilege_type: privilege, ...runtimeRow })),
        ]),
      ];
      return applyOverride(result(rows));
    }
    if (operation === "inspectColumnAcl") {
      const columns = [
        ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required,
        ...selectedOptionalColumnEntries,
      ].filter(({ kind }) => kind === "column") as readonly PostgreSqlRuntimePrivilegeEntry[];
      return applyOverride(result(columns.map((entry) => ({
        object_identity: `${entry.object}|${entry.column}`,
        privilege_type: entry.privilege,
        ...runtimeRow,
      }))));
    }
    if (operation === "inspectFunctionAcl") {
      const identities = [...new Set([
        ...snapshot.managedObjectIdentities
          .filter((identity) => identity.startsWith("function|"))
          .map((identity) => {
            const [, name, args] = identity.split("|");
            return `lcm.${name}(${args ?? ""})`;
          }),
        ...POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
          .filter(({ kind }) => kind === "function")
          .map(({ object }) => object),
      ])];
      const functions = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
        .filter(({ kind }) => kind === "function");
      return applyOverride(result([
        ...identities.flatMap((function_identity) => {
          const entry = functions.find((candidate) => candidate.object === function_identity);
          const extension_name = entry?.object.startsWith("public.digest(")
            ? "pgcrypto"
            : entry?.object.startsWith("public.similarity")
              ? "pg_trgm"
              : null;
          return [
            { function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...ownerRow },
            ...(entry === undefined ? [] : [
              { function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...runtimeRow },
              ...(entry.extension !== undefined && !fixtureOptions.omitPublicFunctionExecute
                ? [{ function_identity, object_identity: function_identity, extension_name, privilege_type: "EXECUTE", ...publicRow }]
                : []),
            ]),
          ];
        }),
      ]));
    }
    if (operation === "inspectEffectivePrivileges") {
      const values = (config as { values?: unknown[] }).values ?? [];
      const functionObjects = values[14] as unknown[];
      const functionExpected = values[16] as unknown[];
      const rows: QueryResultRow[] = [];
      let flippedOptionalEffective = false;
      const addRows = (
        privilege_kind: string,
        objects: readonly unknown[],
        columns: readonly unknown[] | null,
        privileges: readonly unknown[],
        expected: readonly unknown[],
      ): void => {
        for (let index = 0; index < objects.length; index += 1) {
          const object_identity = objects[index];
          const column_name = columns === null ? null : columns[index];
          const privilege_type = privileges[index];
          const expectedValue = expected[index];
          const optional = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.optional.some((entry) => (
            entry.kind === privilege_kind
              && entry.object === object_identity
              && (entry.column ?? null) === column_name
              && entry.privilege === privilege_type
          ));
          const effective = fixtureOptions.partialOptionalEffectiveGrants
            && optional
            && expectedValue === true
            && !flippedOptionalEffective
            ? (flippedOptionalEffective = true, false)
            : expectedValue;
          rows.push({
            privilege_kind,
            object_identity,
            column_name,
            privilege_type,
            expected: expectedValue,
            effective,
          });
        }
      };
      addRows("schema", values[1] as unknown[], null, values[2] as unknown[], values[3] as unknown[]);
      addRows("relation", values[4] as unknown[], null, values[5] as unknown[], values[6] as unknown[]);
      addRows("sequence", values[7] as unknown[], null, values[8] as unknown[], values[9] as unknown[]);
      addRows("column", values[10] as unknown[], values[11] as unknown[], values[12] as unknown[], values[13] as unknown[]);
      addRows("function", functionObjects, null, [
        ...functionObjects.map(() => "EXECUTE"),
      ], functionExpected);
      return applyOverride(result(fixtureOptions.incompleteEffectivePrivileges ? rows.slice(0, -1) : rows));
    }
    return applyOverride(result([]));
  });
  return { seam: { query }, queries };
}

const EXPECTED_OWNER = "lcm_test_migrator";

function mutateFirstField(field: string, value: unknown): ReadyExecutorOverride {
  return mutateRows((rows) => {
    if (rows[0] === undefined) throw new Error(`fixture row missing for ${field}`);
    rows[0][field] = value;
  });
}

function mutateEffectiveRow(
  mutation: (row: QueryResultRow, rows: QueryResultRow[]) => void,
): ReadyExecutorOverride {
  return mutateRows((rows) => {
    if (rows[0] === undefined) throw new Error("effective fixture row missing");
    mutation(rows[0], rows);
  });
}

async function expectReadinessFailure(
  fake: ReturnType<typeof readyExecutor>,
  reason: string,
): Promise<PostgreSqlRuntimeReadinessError> {
  const failure = await verifyPostgreSqlRuntimeSchema(fake.seam, {
    expectedOwner: EXPECTED_OWNER,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PostgreSqlRuntimeReadinessError);
  expect(failure).toMatchObject({ reason });
  return failure as PostgreSqlRuntimeReadinessError;
}

describe("PostgreSQL runtime schema and grant readiness", () => {
  it("exposes an immutable versioned privilege manifest and verifier seam", () => {
    expect(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version).toBeGreaterThan(0);
    expect(Object.isFrozen(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required)).toBe(true);
    expect(typeof verifyPostgreSqlRuntimeSchema).toBe("function");
  });

  it("requires the exact passive-event inbox write columns from the coordination grant", () => {
    const entries = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind, object }) => kind === "column" && object === "lcm.passive_event_inbox")
      .map(({ column, privilege }) => `${privilege}|${column}`);

    expect(entries).toEqual([
      "INSERT|project_id",
      "INSERT|machine_id",
      "INSERT|event_id",
      "INSERT|event_version",
      "INSERT|machine_sequence",
      "INSERT|event_type",
      "INSERT|payload",
      "UPDATE|status",
      "UPDATE|attempt_count",
      "UPDATE|next_attempt_at",
      "UPDATE|claimed_at",
      "UPDATE|claimed_by",
      "UPDATE|applied_at",
      "UPDATE|quarantined_at",
      "UPDATE|quarantine_reason",
    ]);
  });

  it("uses the exact PostgreSQL function identity signatures without duplicates", () => {
    const identities = POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.required
      .filter(({ kind }) => kind === "function")
      .map(({ object }) => object);

    expect(identities).toEqual([
      "lcm.normalize_search_text(input text)",
      "public.digest(text, text)",
      "public.digest(bytea, text)",
      "public.similarity(text, text)",
      "public.similarity_op(text, text)",
    ]);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("propagates the caller signal to every readiness query", async () => {
    const fake = readyExecutor();
    const controller = new AbortController();

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: EXPECTED_OWNER,
      signal: controller.signal,
    })).resolves.toBeDefined();

    expect(fake.queries.length).toBeGreaterThan(0);
    expect(fake.queries.every(({ options }) => options.signal === controller.signal)).toBe(true);
  });

  it.each([
    ["missing role row", []],
    ["malformed current role", mutateFirstField("current_user_name", 17)],
    ["malformed session role", mutateFirstField("session_user_name", null)],
    ["session role mismatch", mutateFirstField("session_user_name", "other_runtime")],
    ["owner role", mutateRows((rows) => {
      rows[0]!.current_user_name = EXPECTED_OWNER;
      rows[0]!.session_user_name = EXPECTED_OWNER;
    })],
    ["missing role flag", mutateFirstField("role_exists", false)],
    ["superuser", mutateFirstField("superuser", true)],
    ["role creation", mutateFirstField("create_role", true)],
    ["database creation", mutateFirstField("create_database", true)],
    ["replication", mutateFirstField("replication", true)],
    ["row-security bypass", mutateFirstField("bypass_rls", true)],
    ["membership", mutateFirstField("membership_count", 1)],
    ["TLS", mutateFirstField("tls", false)],
    ["malformed boolean", mutateFirstField("superuser", "false")],
    ["expected owner match", mutateFirstField("expected_owner_match", true)],
  ] as const)("rejects runtime role policy: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectRuntimeRolePolicy: override } }),
      "runtime-role-policy",
    );
  });

  it.each([
    ["runtime role owns the current database", mutateRows((rows) => {
      rows[0]!.database_owner_oid = "200";
      rows[0]!.database_owner_match = false;
    })],
    ["foreign role owns the current database", mutateRows((rows) => {
      rows[0]!.database_owner_oid = "300";
      rows[0]!.database_owner_match = false;
    })],
    ["database owner evidence is missing", mutateFirstField("database_owner_count", 0)],
    ["database owner evidence is duplicated", mutateFirstField("database_owner_count", 2)],
    ["database owner evidence is malformed", mutateFirstField("database_owner_oid", null)],
    ["expected owner evidence is malformed", mutateFirstField("expected_owner_oid", "not-an-oid")],
    ["database owner match is malformed", mutateFirstField("database_owner_match", "false")],
    ["role policy evidence is duplicated", (base: ReadyExecutorBaseResult) => (
      replaceRows(base, [...base.rows, ...base.rows])
    )],
  ] as const)("rejects database-owner authority evidence: %s before domain work", async (_label, override) => {
    const fake = readyExecutor({ operationOverrides: { inspectRuntimeRolePolicy: override } });
    await expectReadinessFailure(fake, "runtime-role-policy");
    expect(fake.queries.map(({ options }) => options.operation)).toEqual([
      "inspectServerReadiness",
      "inspectRuntimeRolePolicy",
    ]);
  });

  it.each([
    ["missing server row", []],
    ["unsupported major", mutateFirstField("server_version_num", 170000)],
    ["malformed version", mutateFirstField("server_version_num", "180004")],
    ["non-UTF8 encoding", mutateFirstField("server_encoding", "SQL_ASCII")],
    ["non-UTC timezone", mutateFirstField("timezone", "America/Sao_Paulo")],
    ["malformed timezone", mutateFirstField("timezone", null)],
    ["unencrypted connection", mutateFirstField("tls", false)],
  ] as const)("rejects server preflight: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectServerReadiness: override } }),
      "server-preflight",
    );
  });

  it("accepts the exact 18.0.0 server version spelling", async () => {
    await expect(verifyPostgreSqlRuntimeSchema(
      readyExecutor({
        operationOverrides: { inspectServerReadiness: mutateFirstField("server_version_num", 180000) },
      }).seam,
      { expectedOwner: EXPECTED_OWNER },
    )).resolves.toBeDefined();
  });

  it("maps extension and search preflight errors to stable readiness reasons", async () => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          "runtimeReadinessExtensions": mutateFirstField("installed_version", "2.0"),
        },
      }),
      "extension-preflight",
    );
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          runtimeReadinessSearchConfiguration: mutateFirstField("actual_sha256", "0".repeat(64)),
        },
      }),
      "search-preflight",
    );
  });

  it.each([
    ["wrong ledger length", mutateRows((rows) => rows.pop())],
    ["malformed ledger id", mutateFirstField("id", 17)],
    ["malformed ledger checksum", mutateFirstField("checksum_sha256", 17)],
    ["ledger id drift", mutateFirstField("id", "0001_wrong")],
    ["ledger checksum drift", mutateFirstField("checksum_sha256", "0".repeat(64))],
  ] as const)("rejects migration ledger: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { readMigrations: override } }),
      "migration-ledger",
    );
  });

  it.each([
    ["missing ownership row", []],
    ["expected owner missing", mutateFirstField("expected_owner_exists", false)],
    ["schema missing", mutateFirstField("schema_exists", false)],
    ["schema ownership", mutateFirstField("schema_owned", false)],
    ["ledger missing", mutateFirstField("ledger_exists", false)],
    ["ledger kind", mutateFirstField("ledger_kind", "v")],
    ["ledger ownership", mutateFirstField("ledger_owned", false)],
    ["malformed expected count", mutateFirstField("expected_object_count", "1")],
    ["expected count drift", mutateFirstField("expected_object_count", 0)],
    ["malformed actual count", mutateFirstField("actual_object_count", "1")],
    ["actual count drift", mutateFirstField("actual_object_count", 0)],
    ["malformed owned count", mutateFirstField("owned_object_count", "1")],
    ["owned count drift", mutateFirstField("owned_object_count", 0)],
  ] as const)("rejects schema ownership: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectSchemaOwnership: override } }),
      "schema-ownership",
    );
  });

  it.each([
    ["missing definition row", []],
    ["baseline not applied", mutateFirstField("baseline_applied", false)],
    ["definition expected count", mutateFirstField("expected_object_count", 0)],
    ["definition existing count malformed", mutateFirstField("existing_object_count", "1")],
    ["definition existing count drift", mutateFirstField("existing_object_count", 0)],
    ["definition missing count", mutateFirstField("missing_object_count", 1)],
    ["definition drift count", mutateFirstField("drifted_definition_group_count", 1)],
    ["definition counts malformed", mutateFirstField("actual_definition_group_counts", "bad")],
    ["definition hashes malformed", mutateFirstField("actual_definition_group_hashes", "bad")],
    ["definition counts length", mutateRows((rows) => {
      rows[0]!.actual_definition_group_counts = [];
    })],
    ["definition hashes length", mutateRows((rows) => {
      rows[0]!.actual_definition_group_hashes = [];
    })],
    ["definition count drift", mutateRows((rows) => {
      const counts = [...rows[0]!.actual_definition_group_counts as number[]];
      counts[0] = (counts[0] ?? 0) + 1;
      rows[0]!.actual_definition_group_counts = counts;
    })],
    ["definition hash drift", mutateRows((rows) => {
      const hashes = [...rows[0]!.actual_definition_group_hashes as string[]];
      hashes[0] = "0".repeat(64);
      rows[0]!.actual_definition_group_hashes = hashes;
    })],
  ] as const)("rejects schema definition fingerprint: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectSchemaDefinitions: override } }),
      "schema-fingerprint",
    );
  });

  it.each([
    ["missing identity row", []],
    ["identity expected count", mutateFirstField("expected_function_count", 0)],
    ["identity existing count", mutateFirstField("existing_function_count", 0)],
    ["identity drift count", mutateFirstField("drifted_function_count", 1)],
  ] as const)("rejects identity function fingerprint: %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectIdentityFunctions: override } }),
      "schema-fingerprint",
    );
  });

  const aclOperations = [
    "inspectSchemaAcl",
    "inspectRelationAcl",
    "inspectColumnAcl",
    "inspectFunctionAcl",
  ] as const;

  it.each(aclOperations)("rejects malformed ACL rows for %s", async (operation) => {
    const override = operation === "inspectSchemaAcl"
      ? mutateFirstField("schema_name", null)
      : operation === "inspectFunctionAcl"
        ? mutateFirstField("function_identity", 17)
        : mutateFirstField("object_identity", 17);
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { [operation]: override } }),
      "acl-shape",
    );
  });

  it.each(aclOperations)("rejects missing ACL rows for %s", async (operation) => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          [operation]: mutateRows((rows) => { rows.shift(); }),
        },
      }),
      "acl-shape",
    );
  });

  it.each([
    ["foreign grantee", (rows: QueryResultRow[]) => {
      rows[0]!.grantee_is_owner = false;
      rows[0]!.grantee_name = "foreign_role";
    }],
    ["foreign grantor", (rows: QueryResultRow[]) => { rows[0]!.grantor_is_owner = false; }],
    ["grant option", (rows: QueryResultRow[]) => { rows[0]!.is_grantable = true; }],
    ["extra", (rows: QueryResultRow[]) => {
      rows.push({ ...rows[0]!, privilege_type: "UNEXPECTED" });
    }],
  ] as const)("rejects %s ACL rows for every ACL category", async (_label, mutation) => {
    for (const operation of aclOperations) {
      await expectReadinessFailure(
        readyExecutor({ operationOverrides: { [operation]: mutateRows(mutation) } }),
        "acl-shape",
      );
    }
  });

  it("rejects a non-string ACL grantee after the boolean shape is valid", async () => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          inspectSchemaAcl: mutateRows((rows) => {
            rows[0]!.grantee_is_owner = false;
            rows[0]!.grantee_name = 17;
          }),
        },
      }),
      "acl-shape",
    );
  });

  it.each(aclOperations)("rejects malformed ACL booleans for %s", async (operation) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { [operation]: mutateFirstField("is_grantable", "false") } }),
      "acl-shape",
    );
  });

  it.each([
    ["kind", mutateEffectiveRow((row) => { row.privilege_kind = "invalid"; })],
    ["object", mutateEffectiveRow((row) => { row.object_identity = 17; })],
    ["column", mutateEffectiveRow((row) => { row.column_name = 17; })],
    ["privilege", mutateEffectiveRow((row) => { row.privilege_type = 17; })],
    ["expected boolean", mutateEffectiveRow((row) => { row.expected = "true"; })],
    ["effective boolean", mutateEffectiveRow((row) => { row.effective = "true"; })],
  ] as const)("rejects malformed effective %s rows", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectEffectivePrivileges: override } }),
      "effective-privilege",
    );
  });

  it.each([
    ["duplicate", mutateEffectiveRow((_row, rows) => { rows[1] = { ...rows[0]! }; })],
    ["extra", mutateEffectiveRow((row) => { row.object_identity = "lcm.unexpected"; })],
    ["expected mismatch", mutateEffectiveRow((row) => { row.expected = false; })],
    ["effective mismatch", mutateEffectiveRow((row) => { row.effective = false; })],
  ] as const)("rejects effective privilege %s", async (_label, override) => {
    await expectReadinessFailure(
      readyExecutor({ operationOverrides: { inspectEffectivePrivileges: override } }),
      "effective-privilege",
    );
  });

  it("rejects duplicate generated effective privilege keys", async () => {
    migrationMockState.duplicateColumnIdentity = true;
    try {
      await expectReadinessFailure(readyExecutor(), "effective-privilege");
    } finally {
      migrationMockState.duplicateColumnIdentity = false;
    }
  });

  it("rejects a valid migration ledger when no matching snapshot exists", async () => {
    migrationMockState.returnNoLatestSnapshot = true;
    try {
      await expectReadinessFailure(readyExecutor(), "migration-ledger");
    } finally {
      migrationMockState.returnNoLatestSnapshot = false;
    }
  });

  it("sanitizes an unexpected executor error while preserving known readiness errors", async () => {
    const unexpected = await verifyPostgreSqlRuntimeSchema(readyExecutor({
      operationOverrides: {
        inspectServerReadiness: { error: new Error("secret executor detail") },
      },
    }).seam, { expectedOwner: EXPECTED_OWNER }).catch((error: unknown) => error);
    expect(unexpected).toMatchObject({
      reason: "server-preflight",
      operation: "verifyRuntimeReadiness",
    });
    expect(JSON.stringify(unexpected)).not.toContain("secret executor detail");

    const known = await verifyPostgreSqlRuntimeSchema(readyExecutor({
      operationOverrides: { inspectServerReadiness: [] },
    }).seam, { expectedOwner: EXPECTED_OWNER }).catch((error: unknown) => error);
    expect(known).toMatchObject({
      reason: "server-preflight",
      operation: "inspectServerReadiness",
    });
  });

  it("accepts sequence runtime USAGE using sequence identities in direct ACL verification", async () => {
    const fake = readyExecutor({ includeSequenceRuntimeGrant: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it("accepts the hardened lcm schema ACL without a PUBLIC USAGE default", async () => {
    const fake = readyExecutor({ omitLcmPublicDefault: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it("accepts hardened public schema and extension function ACL defaults", async () => {
    const fake = readyExecutor({
      omitPublicSchemaUsage: true,
      omitPublicFunctionExecute: true,
    });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
  });

  it.each([
    ["missing", null],
    ["malformed", 17],
    ["detached", null],
    ["wrong extension", "foreign_extension"],
  ] as const)("rejects %s extension ownership evidence for required functions", async (_label, extensionName) => {
    await expectReadinessFailure(
      readyExecutor({
        operationOverrides: {
          inspectFunctionAcl: mutateRows((rows) => {
            const row = rows.find(({ function_identity }) => function_identity === "public.digest(text, text)");
            if (row !== undefined) row.extension_name = extensionName;
          }),
        },
      }),
      "acl-shape",
    );
  });

  it("accepts readiness when the optional transcript grant set is entirely absent", async () => {
    const fake = readyExecutor({ omitOptionalDirectGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({ runtimeRole: "lcm_test_runtime" });
    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toContain("inspectEffectivePrivileges");
  });

  it("rejects a partial optional effective grant set", async () => {
    const fake = readyExecutor({ partialOptionalEffectiveGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "effective-privilege" });
  });

  it("rejects a partial optional direct grant set after inspecting relation and column ACLs", async () => {
    const fake = readyExecutor({ partialOptionalDirectGrants: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "acl-shape" });
    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toEqual(expect.arrayContaining(["inspectRelationAcl", "inspectColumnAcl"]));
  });

  it("probes tables separately from sequences and probes SELECT column privileges", async () => {
    const fake = readyExecutor();
    await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    });

    expect(fake.queries.map(({ options: queryOptions }) => queryOptions.operation))
      .toContain("inspectEffectivePrivileges");

    const effective = fake.queries.find(({ options: queryOptions }) => (
      queryOptions.operation === "inspectEffectivePrivileges"
    ));
    expect(effective).toBeDefined();
    const config = effective!.config as { readonly text: string; readonly values: readonly unknown[] };
    const relationObjects = config.values[4] as readonly string[];
    const sequenceObjects = config.values[7] as readonly string[];
    const columnPrivileges = config.values[12] as readonly string[];
    const functionObjects = config.values[14] as readonly string[];
    const functionLookupObjects = config.values[15] as readonly string[];
    const functionExpected = config.values[16] as readonly boolean[];

    expect(relationObjects.every((object) => !object.includes("_seq"))).toBe(true);
    expect(sequenceObjects).toEqual(expect.arrayContaining([
      "lcm.conversations_conversation_id_seq",
      "lcm.messages_message_id_seq",
    ]));
    expect(columnPrivileges).toContain("SELECT");
    expect(functionObjects).toContain("lcm.normalize_search_text(input text)");
    expect(functionLookupObjects).toContain("lcm.normalize_search_text(text)");
    expect(functionExpected.every((expected) => expected === true)).toBe(true);
    expect(config.text).toContain("has_table_privilege");
    expect(config.text).toContain("has_sequence_privilege");
    expect(config.text).toContain("has_column_privilege");
  });

  it("rejects an incomplete effective privilege probe result", async () => {
    const fake = readyExecutor({ incompleteEffectivePrivileges: true });

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).rejects.toMatchObject({ reason: "effective-privilege" });
  });

  it("returns only a frozen sanitized witness after complete read-only readiness", async () => {
    const fake = readyExecutor();

    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    })).resolves.toMatchObject({
      currentMigrationIds: expect.any(Array),
      expectedOwner: "lcm_test_migrator",
      runtimeRole: expect.any(String),
      managedObjectCount: expect.any(Number),
      definitionObjectCount: expect.any(Number),
      privilegeManifestVersion: POSTGRESQL_RUNTIME_PRIVILEGE_MANIFEST.version,
    });
    const witness = await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    });
    expect(Object.isFrozen(witness)).toBe(true);
    expect(Object.isFrozen(witness.currentMigrationIds)).toBe(true);
    expect(Object.keys(witness).sort()).toEqual([
      "currentMigrationIds",
      "definitionObjectCount",
      "expectedOwner",
      "managedObjectCount",
      "privilegeManifestVersion",
      "runtimeRole",
    ]);
  });

  it("fails closed without exposing observed ownership, memberships, SQL, or values", async () => {
    const fake = executor();
    const error = await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "lcm_test_migrator",
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      operation: expect.any(String),
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("attacker_owner");
    expect(serialized).not.toContain("lcm_test_runtime");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("SELECT");
  });

  it("binds expected-owner checks and never emits mutating or migration-lock SQL", async () => {
    const fake = readyExecutor();
    await verifyPostgreSqlRuntimeSchema(fake.seam, {
      expectedOwner: "attacker_owner",
    }).catch(() => undefined);

    expect(fake.queries.some(({ config }) => (
      typeof config === "object"
      && config !== null
      && "values" in config
      && Array.isArray((config as { values?: unknown[] }).values)
      && (config as { values: unknown[] }).values.includes("attacker_owner")
    ))).toBe(true);
    for (const { config } of fake.queries) {
      const text = typeof config === "object" && config !== null && "text" in config
        ? String((config as { text?: unknown }).text)
        : "";
      expect(text).not.toMatch(/\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
      expect(text).not.toContain("pg_advisory");
      expect(text).not.toContain("schema_migrations (id");
    }
  });

  it.each([
    "",
    "attacker\nowner",
    "a".repeat(64),
  ])("rejects malformed configured owner %j before database access", async (expectedOwner) => {
    const fake = executor();
    await expect(verifyPostgreSqlRuntimeSchema(fake.seam, { expectedOwner }))
      .rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
    expect(fake.queries).toHaveLength(0);
  });
});
