import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type {
  PostgreSqlMigration,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
} from "../../src/storage/postgresql/contracts.js";
import {
  getPostgreSqlSchemaSnapshotExpectations,
  loadPostgreSqlMigrations,
  loadPostgreSqlSchemaSnapshots,
  PostgreSqlBaselineDefinitionPreflightError,
  PostgreSqlIdentityFunctionPreflightError,
  PostgreSqlMigrationLedgerRelationPreflightError,
  PostgreSqlManagedObjectOwnershipPreflightError,
  PostgreSqlSchemaAclPreflightError,
  PostgreSqlSchemaOwnershipPreflightError,
  PostgreSqlSessionReplicationRolePreflightError,
  PostgreSqlServerEncodingPreflightError,
  PostgreSqlServerVersionPreflightError,
  REQUIRED_POSTGRESQL_SERVER_ENCODING,
  REQUIRED_POSTGRESQL_SERVER_MAJOR_VERSION,
  runPostgreSqlMigrations,
  selectLatestPostgreSqlSchemaSnapshot,
} from "../../src/storage/postgresql/migrations.js";
import type { PostgreSqlSchemaSnapshot } from "../../src/storage/postgresql/migrations.js";
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
  ledgerRelation?: "view" | "unowned" | "missing" | "invalid" | "inconsistent";
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
  sessionReplicationRole?: "origin" | "replica" | "local" | "missing" | "invalid";
  schemaAcl?: "absent" | "ready" | "public" | "missing" | "invalid" | "inconsistent";
  managedOwnership?: "ready" | "unowned" | "missing-object" | "missing" | "invalid" | "inconsistent" | "different-user";
  baselineDefinitions?:
    | "ready"
    | "missing-object"
    | "drifted"
    | "missing"
    | "invalid"
    | "invalid-hash"
    | "inconsistent";
  identityFunctions?: "ready" | "drifted" | "missing" | "invalid" | "inconsistent";
} = {}) {
  const operations: string[] = [];
  const query = vi.fn(async <R extends QueryResultRow>(
    config: unknown,
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
    if (context.operation === "preflightSessionReplicationRole") {
      if (options.sessionReplicationRole === "missing") return result([] as R[]);
      return result([{
        session_replication_role: options.sessionReplicationRole === "invalid"
          ? 7
          : options.sessionReplicationRole ?? "origin",
      }] as unknown as R[]);
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
    if (context.operation === "preflightMigrationLedgerRelation") {
      if (options.ledgerRelation === "missing") return result([] as R[]);
      if (options.ledgerRelation === "invalid") {
        return result([{
          current_user_name: 7,
          ledger_exists: "yes",
          owned_by_current_user: 1,
          relation_kind: 4,
        }] as unknown as R[]);
      }
      if (options.ledgerRelation === "inconsistent") {
        return result([{
          current_user_name: "lcm_test_migrator",
          ledger_exists: false,
          owned_by_current_user: true,
          relation_kind: "r",
        }] as unknown as R[]);
      }
      const ledgerExists = options.ledger === true
        || options.ledgerRelation === "view"
        || options.ledgerRelation === "unowned";
      return result([{
        current_user_name: "lcm_test_migrator",
        ledger_exists: ledgerExists,
        owned_by_current_user: ledgerExists
          ? options.ledgerRelation !== "unowned"
          : null,
        relation_kind: ledgerExists
          ? options.ledgerRelation === "view" ? "v" : "r"
          : null,
      }] as unknown as R[]);
    }
    if (context.operation === "preflightManagedObjectOwnership") {
      if (options.managedOwnership === "missing") return result([] as R[]);
      if (options.managedOwnership === "invalid") {
        return result([{
          current_user_name: 7,
          baseline_applied: "yes",
          expected_object_count: "many",
          existing_object_count: "many",
          missing_object_count: false,
          unowned_object_count: false,
        }] as unknown as R[]);
      }
      const expectedObjectCount =
        (config as { values?: unknown[] }).values?.[0] as number;
      return result([{
        current_user_name: options.managedOwnership === "different-user"
          ? "different_migrator"
          : "lcm_test_migrator",
        baseline_applied: (options.current ?? []).some(({ id }) => id === "0002_schema_baseline"),
        expected_object_count: expectedObjectCount,
        existing_object_count: options.managedOwnership === "inconsistent"
          ? 0
          : options.managedOwnership === "missing-object"
            ? expectedObjectCount - 1
            : expectedObjectCount,
        missing_object_count: options.managedOwnership === "missing-object" ? 1 : 0,
        unowned_object_count: options.managedOwnership === "unowned"
          || options.managedOwnership === "inconsistent"
          ? 1
          : 0,
      }] as unknown as R[]);
    }
    if (context.operation === "preflightIdentityFunctionDefinitions") {
      if (options.identityFunctions === "missing") return result([] as R[]);
      if (options.identityFunctions === "invalid") {
        return result([{
          baseline_applied: "yes",
          expected_function_count: "two",
          existing_function_count: false,
          drifted_function_count: null,
        }] as unknown as R[]);
      }
      return result([{
        baseline_applied: true,
        expected_function_count: 3,
        existing_function_count: options.identityFunctions === "inconsistent" ? 4 : 3,
        drifted_function_count: options.identityFunctions === "drifted" ? 1 : 0,
      }] as unknown as R[]);
    }
    if (context.operation === "preflightBaselineDefinitions") {
      if (options.baselineDefinitions === "missing") return result([] as R[]);
      if (options.baselineDefinitions === "invalid") {
        return result([{
          baseline_applied: "yes",
          expected_object_count: "many",
          existing_object_count: false,
          missing_object_count: null,
          drifted_definition_group_count: "none",
        }] as unknown as R[]);
      }
      const expectedObjectCount =
        (config as { values?: unknown[] }).values?.[10] as number;
      const definitionGroupCounts =
        (config as { values?: unknown[] }).values?.[12] as number[];
      const definitionGroupHashes =
        (config as { values?: unknown[] }).values?.[13] as string[];
      const actualDefinitionGroupCounts = [...definitionGroupCounts];
      const actualDefinitionGroupHashes = [...definitionGroupHashes];
      if (options.baselineDefinitions === "missing-object") {
        actualDefinitionGroupCounts[0] = actualDefinitionGroupCounts[0]! - 1;
        actualDefinitionGroupHashes[0] = "f".repeat(64);
      } else if (options.baselineDefinitions === "drifted") {
        actualDefinitionGroupHashes[0] = "f".repeat(64);
      } else if (options.baselineDefinitions === "invalid-hash") {
        actualDefinitionGroupHashes[0] = "not-a-sha256";
      }
      return result([{
        actual_definition_group_counts: actualDefinitionGroupCounts,
        actual_definition_group_hashes: actualDefinitionGroupHashes,
        baseline_applied: true,
        expected_object_count: expectedObjectCount,
        existing_object_count: options.baselineDefinitions === "inconsistent"
          ? expectedObjectCount + 1
          : options.baselineDefinitions === "missing-object"
            ? expectedObjectCount - 1
            : expectedObjectCount,
        missing_object_count: options.baselineDefinitions === "missing-object" ? 1 : 0,
        drifted_definition_group_count:
          options.baselineDefinitions === "drifted"
          || options.baselineDefinitions === "missing-object"
            ? 1
            : 0,
      }] as unknown as R[]);
    }
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
  it("derives changed future expectations and selects by migration history, not registry order", () => {
    const snapshot = (
      migrationId: string,
      counts: readonly [number, number, number, number, number, number, number, number, number],
      identityFunctionNames: readonly string[],
    ): PostgreSqlSchemaSnapshot => ({
      constraintIdentities: Array.from({ length: counts[2] }, (_, index) => `t|c${index}`),
      columnAclIdentities:
        Array.from({ length: counts[4] }, (_, index) => `t|a${index}`),
      definitionHashes: {
        columnAcl: `${migrationId}-column-acl`,
        constraint: `${migrationId}-constraint`,
        generatedColumn: `${migrationId}-generated`,
        identitySequence: `${migrationId}-sequence`,
        index: `${migrationId}-index`,
        ordinaryColumn: `${migrationId}-ordinary`,
        relationAcl: `${migrationId}-relation-acl`,
        table: `${migrationId}-table`,
        trigger: `${migrationId}-trigger`,
      },
      generatedColumnIdentities:
        Array.from({ length: counts[3] }, (_, index) => `t|g${index}`),
      identitySequenceIdentities:
        Array.from({ length: counts[5] }, (_, index) => `s${index}`),
      identityFunctions: identityFunctionNames.map((name) => ({
        name,
        sha256: `${name}-sha256`,
      })),
      indexNames: Array.from({ length: counts[0] }, (_, index) => `i${index}`),
      managedObjectIdentities: [
        `table|${migrationId}`,
        ...identityFunctionNames.map((name) => `function|${name}|`),
      ],
      migrationId,
      ordinaryColumnIdentities:
        Array.from({ length: counts[8] }, (_, index) => `t|o${index}`),
      relationAclIdentities:
        Array.from({ length: counts[7] }, (_, index) => `table|a${index}`),
      tableIdentities: Array.from({ length: counts[6] }, (_, index) => `t${index}`),
      triggerIdentities: Array.from({ length: counts[1] }, (_, index) => `t|tr${index}`),
    });
    const older = snapshot(
      "0002_schema_baseline",
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      ["old_helper"],
    );
    const newer = snapshot("0003_future", [2, 0, 3, 1, 7, 2, 4, 5, 6], [
      "new_helper",
      "second_helper",
    ]);

    expect(selectLatestPostgreSqlSchemaSnapshot(
      ["0001_migration_ledger", older.migrationId, newer.migrationId],
      [newer, older],
    )).toBe(newer);
    expect(getPostgreSqlSchemaSnapshotExpectations(newer)).toEqual({
      definitionGroupCounts: [2, 0, 3, 1, 7, 2, 4, 5, 6],
      definitionGroupHashes: [
        "0003_future-index",
        "0003_future-trigger",
        "0003_future-constraint",
        "0003_future-generated",
        "0003_future-column-acl",
        "0003_future-sequence",
        "0003_future-table",
        "0003_future-relation-acl",
        "0003_future-ordinary",
      ],
      definitionGroupKinds: [
        "index",
        "trigger",
        "constraint",
        "generated_column",
        "column_acl",
        "identity_sequence",
        "table",
        "relation_acl",
        "ordinary_column",
      ],
      definitionObjectCount: 30,
      identityFunctionHashes: ["new_helper-sha256", "second_helper-sha256"],
      identityFunctionNames: ["new_helper", "second_helper"],
    });
    expect(selectLatestPostgreSqlSchemaSnapshot(["0001_migration_ledger"], [
      newer,
      older,
    ])).toBeNull();
  });

  it("loads the pinned artifact and rejects missing or drifted files", () => {
    const migrations = loadPostgreSqlMigrations();
    expect(migrations).toEqual([
      expect.objectContaining({ id: "0001_migration_ledger", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      expect.objectContaining({ id: "0002_schema_baseline", sha256: "3f255f3c3a402047313f197c63434742259033cbb0ef590276569eb684d8d260" }),
      expect.objectContaining({ id: "0003_machine_identity_key", sha256: "bdc38d19bde5825eb1d59e9044769cbf9cac52be5c9fe34237f93ec347c3807b" }),
      expect.objectContaining({ id: "0004_machine_display_name", sha256: "f12b4e5493da187e4c8cd4083766010b896961225cadd6fe568e4e99264e3421" }),
    ]);
    expect(migrations[1]?.sql).toContain(
      "fencing_token bigint GENERATED ALWAYS AS IDENTITY CHECK (fencing_token > 0)",
    );
    expect(migrations[1]?.sql).toMatch(
      /CREATE TABLE lcm\.message_parts \([\s\S]*?ordinal bigint NOT NULL CHECK \(ordinal >= 0\)/u,
    );
    expect(migrations[1]?.sql).toContain(
      `catalog SHA-256 ${POSTGRESQL_SEARCH_CONFIGURATION_SHA256}`,
    );
    expect(migrations[1]?.sql).toContain("lcm.fenced_leases_fencing_token_seq");
    expect(migrations[1]?.sql).toContain(
      "WHEN TG_OP OPERATOR(pg_catalog.=) 'UPDATE' THEN OLD.ingest_key",
    );
    const conversationsDefinition = /CREATE TABLE lcm\.conversations \(([\s\S]*?)\n\);/u
      .exec(migrations[1]!.sql)?.[1];
    const instructionsDefinition = /CREATE TABLE lcm\.session_instructions \(([\s\S]*?)\n\);/u
      .exec(migrations[1]!.sql)?.[1];
    expect(conversationsDefinition).toContain("session_id text NOT NULL,");
    expect(conversationsDefinition).not.toContain("session_id <> ''");
    expect(instructionsDefinition).toContain(
      "session_id text NOT NULL CHECK (session_id <> '')",
    );
    expect(instructionsDefinition).toContain(
      "UNIQUE (project_id, machine_id, scope_hash)",
    );
    expect(() => loadPostgreSqlMigrations(() => { throw new Error("missing private path"); }))
      .toThrowError(expect.objectContaining({ operation: "loadMigrations" }));
    expect(() => loadPostgreSqlMigrations(() => "altered migration"))
      .toThrowError(expect.objectContaining({ operation: "verifyMigrationArtifact" }));
  });

  it("pins the complete latest PostgreSQL 18 definition inventory", () => {
    const snapshots = loadPostgreSqlSchemaSnapshots();
    const snapshot = snapshots.at(-1)!;

    expect(getPostgreSqlSchemaSnapshotExpectations(snapshot)).toMatchObject({
      definitionGroupCounts: [52, 3, 174, 15, 225, 6, 24, 30, 210],
      definitionGroupHashes: [
        "6d95eda805e9cd5d0b246daaa763a6919262f64e1129dc93f0ee95291276a7fd",
        "229e8dd0e6a1c953dd18b4220da95be28121db72f4fbba199e1d6808c4b7afcc",
        "1cf8dc0e9303c7bdd086bcae679edc31493d26f67c81999c8e5b2fba491e0778",
        "78a5508248b93c86a59ea633136154ae4ab7cf3569e020053a1dc0d1c2fc0590",
        "e2581c7c70cbec57d64bb02ac1520fe27336efb326618b36add668cb1431e98c",
        "907a4bbb955d22d4ed88199acd38dc27e5095a0b943d51480f82a50464367702",
        "5ccf4137ba8c1dbe8462176414b89f30616b26622d9680d77c5e2ae271d2f64d",
        "f9ace407bb5e2cae0310c03df6e156644ea9716fc45d3d55ce2b0c2d7a77d31b",
        "e0daf9a1d97b62f6baf491c35d3b45d5082336538e44da8651afaa1180e11e8a",
      ],
      definitionObjectCount: 739,
    });
    expect(snapshots.map(({ migrationId, definitionHashes }) => ({
      migrationId,
      constraintSha256: definitionHashes.constraint,
    }))).toEqual([
      {
        migrationId: "0002_schema_baseline",
        constraintSha256:
          "8bb79c117c498a89c920826ff65b88ad615f871ba3e8607e4b00d1d115d9aa1a",
      },
      {
        migrationId: "0003_machine_identity_key",
        constraintSha256:
          "4698227bc02a8d777955eb41286a4964dda8da82d1561c9a154b67e2a034906f",
      },
      {
        migrationId: "0004_machine_display_name",
        constraintSha256:
          "1cf8dc0e9303c7bdd086bcae679edc31493d26f67c81999c8e5b2fba491e0778",
      },
    ]);
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
    await expect(runPostgreSqlMigrations(fake.seam, { migrations, schemaSnapshots: [], signal })).resolves.toEqual({
      applied: ["0001_first", "0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
      "preflightSchemaAcl",
      "preflightMigrationLedgerRelation",
      "preflightManagedObjectOwnership",
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
    expect(fake.seam.query).toHaveBeenNthCalledWith(6, {
      text: "SET LOCAL quote_all_identifiers = off",
    }, {
      domain: "factory",
      operation: "pinMigrationDeparserSettings",
      signal,
    });
    expect(fake.seam.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "factory", operation: "migrate", signal,
    });
  });

  it("validates the registered target snapshot after applying its migration", async () => {
    const migrations = loadPostgreSqlMigrations();
    const schemaSnapshots = loadPostgreSqlSchemaSnapshots();
    const fake = executor();
    await expect(runPostgreSqlMigrations(fake.seam, { migrations, schemaSnapshots }))
      .resolves.toEqual({
        applied: [
          "0001_migration_ledger",
          "0002_schema_baseline",
          "0003_machine_identity_key",
          "0004_machine_display_name",
        ],
        current: [
          "0001_migration_ledger",
          "0002_schema_baseline",
          "0003_machine_identity_key",
          "0004_machine_display_name",
        ],
      });
    expect(fake.operations).toEqual(expect.arrayContaining([
      "applyMigration:0002_schema_baseline",
      "preflightBaselineDefinitions",
      "preflightIdentityFunctionDefinitions",
    ]));
    expect(fake.operations.indexOf("applyMigration:0002_schema_baseline"))
      .toBeLessThan(fake.operations.indexOf("preflightBaselineDefinitions"));
    expect(fake.operations.indexOf("applyMigration:0003_machine_identity_key"))
      .toBeLessThan(fake.operations.indexOf("preflightBaselineDefinitions"));
    expect(fake.operations.indexOf("applyMigration:0004_machine_display_name"))
      .toBeLessThan(fake.operations.indexOf("preflightBaselineDefinitions"));
    expect(fake.operations.indexOf("preflightBaselineDefinitions"))
      .toBeLessThan(fake.operations.indexOf("preflightSearchConfiguration"));
  });

  it("rejects duplicate and unknown schema snapshot registry migration IDs", async () => {
    const migrations = loadPostgreSqlMigrations();
    const snapshot = loadPostgreSqlSchemaSnapshots()[0]!;
    for (const [schemaSnapshots, reason, migrationId, message] of [
      [
        [snapshot, snapshot],
        "duplicate_migration_id",
        snapshot.migrationId,
        `PostgreSQL schema snapshot registry contains duplicate migrationId ${snapshot.migrationId}`,
      ],
      [
        [{ ...snapshot, migrationId: "0003_unknown_snapshot" }],
        "unknown_migration_id",
        "0003_unknown_snapshot",
        "PostgreSQL schema snapshot registry references unknown migrationId 0003_unknown_snapshot",
      ],
      [
        [{
          ...snapshot,
          identityFunctions: [
            snapshot.identityFunctions[0]!,
            snapshot.identityFunctions[0]!,
          ],
        }],
        "duplicate_identity_function",
        snapshot.migrationId,
        `PostgreSQL schema snapshot ${snapshot.migrationId} contains duplicate identity function names`,
      ],
      [
        [{
          ...snapshot,
          identityFunctions: [{
            ...snapshot.identityFunctions[0]!,
            name: "unexpected_identity_function",
          }],
        }],
        "identity_function_mismatch",
        snapshot.migrationId,
        `PostgreSQL schema snapshot ${snapshot.migrationId} identity functions do not match managed zero-argument functions`,
      ],
    ] as const) {
      const fake = executor();
      const failure = await runPostgreSqlMigrations(fake.seam, {
        migrations,
        schemaSnapshots,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        message,
        migrationId,
        operation: "validateSchemaSnapshotRegistry",
        reason,
      });
      expect((failure as { toJSON(): unknown }).toJSON()).toMatchObject({
        message,
        migrationId,
        reason,
      });
      expect(fake.seam.query).not.toHaveBeenCalled();
    }

    const inherited = executor();
    await expect(runPostgreSqlMigrations(inherited.seam, {
      migrations: [migration("0001_unrelated")],
    })).rejects.toMatchObject({
      migrationId: snapshot.migrationId,
      operation: "validateSchemaSnapshotRegistry",
      reason: "unknown_migration_id",
    });
    expect(inherited.seam.query).not.toHaveBeenCalled();
  });

  it("accepts exact ordered history and applies only pending files", async () => {
    const migrations = [migration("0001_first"), migration("0002_second")];
    const fake = executor({ ledger: true, current: [{ id: migrations[0].id, checksum_sha256: migrations[0].sha256 }] });
    await expect(runPostgreSqlMigrations(fake.seam, {
      migrations,
      schemaSnapshots: [],
    })).resolves.toEqual({
      applied: ["0002_second"],
      current: ["0001_first", "0002_second"],
    });
    expect(fake.operations).toContain("readMigrations");
    expect(fake.operations.indexOf("preflightMigrationLedgerRelation"))
      .toBeLessThan(fake.operations.indexOf("preflightManagedObjectOwnership"));
    expect(fake.operations.indexOf("preflightMigrationLedgerRelation"))
      .toBeLessThan(fake.operations.indexOf("readMigrations"));
    const ledgerPreflightCall = fake.seam.query.mock.calls.find(([, context]) => (
      context.operation === "preflightMigrationLedgerRelation"
    ));
    const ledgerPreflightSql =
      (ledgerPreflightCall?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(ledgerPreflightSql).toContain("pg_catalog.pg_class");
    expect(ledgerPreflightSql).toContain("pg_catalog.pg_namespace");
    expect(ledgerPreflightSql).not.toContain("FROM lcm.schema_migrations");
  });

  it("accepts a pre-existing schema owned by the migration role", async () => {
    const fake = executor({ schemaAcl: "ready", schemaOwnership: "owned" });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations: [], schemaSnapshots: [] }))
      .resolves.toEqual({ applied: [], current: [] });
    expect(fake.operations).toContain("preflightSchemaOwnership");
  });

  it.each([
    {
      label: "a view in place of the ledger",
      ledgerRelation: "view" as const,
      ledgerExists: true,
      relationKind: "v",
      ownedByMigrator: true,
      requiredOwner: "lcm_test_migrator",
    },
    {
      label: "a ledger owned by another role",
      ledgerRelation: "unowned" as const,
      ledgerExists: true,
      relationKind: "r",
      ownedByMigrator: false,
      requiredOwner: "lcm_test_migrator",
    },
    {
      label: "a missing catalog result",
      ledgerRelation: "missing" as const,
      ledgerExists: null,
      relationKind: null,
      ownedByMigrator: null,
      requiredOwner: null,
    },
    {
      label: "malformed catalog values",
      ledgerRelation: "invalid" as const,
      ledgerExists: null,
      relationKind: null,
      ownedByMigrator: null,
      requiredOwner: null,
    },
    {
      label: "a contradictory absent relation",
      ledgerRelation: "inconsistent" as const,
      ledgerExists: false,
      relationKind: "r",
      ownedByMigrator: true,
      requiredOwner: "lcm_test_migrator",
    },
  ])("fails closed before ledger reads for $label", async ({
    ledgerRelation,
    ledgerExists,
    relationKind,
    ownedByMigrator,
    requiredOwner,
  }) => {
    const fake = executor({
      ledgerRelation,
      schemaAcl: "ready",
      schemaOwnership: "owned",
    });
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: loadPostgreSqlMigrations(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlMigrationLedgerRelationPreflightError);
    expect(failure).toMatchObject({
      ledgerExists,
      operation: "preflightMigrationLedgerRelation",
      ownedByMigrator,
      relationKind,
      relationName: "schema_migrations",
      requiredOwner,
      requiredRelationKind: "r",
      schemaName: "lcm",
    });
    expect((failure as PostgreSqlMigrationLedgerRelationPreflightError).toJSON())
      .toMatchObject({
        ledgerExists,
        ownedByMigrator,
        relationKind,
        relationName: "schema_migrations",
        requiredOwner,
        requiredRelationKind: "r",
      });
    expect(fake.operations).not.toContain("preflightManagedObjectOwnership");
    expect(fake.operations).not.toContain("readMigrations");
  });

  it.each([
    { current: [{ id: "0001_first", checksum_sha256: "x" }, { id: "0002_second", checksum_sha256: "x" }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_unknown", checksum_sha256: migration("0001_first").sha256 }], migrations: [migration("0001_first")] },
    { current: [{ id: "0001_first", checksum_sha256: "0".repeat(64) }], migrations: [migration("0001_first")] },
  ])("rejects unknown, excess, or checksum-drifted history", async ({ current, migrations }) => {
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam, {
      migrations,
      schemaSnapshots: [],
    }))
      .rejects.toMatchObject({ operation: "verifyMigrationHistory" });
  });

  it("uses the packaged manifest by default and propagates transactional failures safely", async () => {
    const current = loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 }));
    await expect(runPostgreSqlMigrations(executor({ ledger: true, current }).seam)).resolves.toMatchObject({ applied: [] });
    await expect(runPostgreSqlMigrations(executor({ failOperation: "lockMigrations" }).seam, { migrations: [], schemaSnapshots: [] }))
      .rejects.toThrow("private SQL failure");
    await expect(runPostgreSqlMigrations(executor({ failOperation: "pinMigrationSearchPath" }).seam, { migrations: [], schemaSnapshots: [] }))
      .rejects.toThrow("private SQL failure");
    await expect(runPostgreSqlMigrations(executor({
      failOperation: "pinMigrationDeparserSettings",
    }).seam, { migrations: [], schemaSnapshots: [] })).rejects.toThrow("private SQL failure");
  });

  it.each([
    {
      label: "replica mode",
      sessionReplicationRole: "replica" as const,
      reportedRole: "replica",
    },
    {
      label: "local mode",
      sessionReplicationRole: "local" as const,
      reportedRole: "local",
    },
    {
      label: "a missing setting row",
      sessionReplicationRole: "missing" as const,
      reportedRole: null,
    },
    {
      label: "a malformed setting value",
      sessionReplicationRole: "invalid" as const,
      reportedRole: null,
    },
  ])("rejects $label before migration catalog trust", async ({
    sessionReplicationRole,
    reportedRole,
  }) => {
    const fake = executor({ sessionReplicationRole });
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: [],
      schemaSnapshots: [],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlSessionReplicationRolePreflightError);
    expect(failure).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      operation: "preflightSessionReplicationRole",
      remediation:
        "Set session_replication_role to origin on the migration connection, or reconnect with its default session state, then rerun migrations.",
      requiredSessionReplicationRole: "origin",
      sessionReplicationRole: reportedRole,
    });
    expect((failure as PostgreSqlSessionReplicationRolePreflightError).toJSON())
      .toMatchObject({
        requiredSessionReplicationRole: "origin",
        sessionReplicationRole: reportedRole,
      });
    expect(fake.operations).toEqual([
      "capturePostmasterEpoch",
      "preflightServerEncoding",
      "preflightRequiredExtensions",
      "preflightRequiredExtensions:probePgStatStatements",
      "pinMigrationSearchPath",
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
    ]);
    for (const laterOperation of [
      "lockMigrations",
      "preflightSchemaOwnership",
      "preflightMigrationLedgerRelation",
      "preflightManagedObjectOwnership",
      "readMigrations",
      "preflightBaselineDefinitions",
    ]) {
      expect(fake.operations).not.toContain(laterOperation);
    }
  });

  it("fails extension preflight before inspecting or changing the schema", async () => {
    const fake = executor({ failOperation: "preflightRequiredExtensions" });
    await expect(runPostgreSqlMigrations(fake.seam, { migrations: [migration("0001_first")], schemaSnapshots: [] }))
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
      { migrations: [], schemaSnapshots: [] },
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
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: loadPostgreSqlMigrations(),
    })
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
      { migrations: [], schemaSnapshots: [] },
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
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: loadPostgreSqlMigrations(),
    })
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
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
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
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations: [], schemaSnapshots: [] })
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
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
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
      existingObjectCount: 36,
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
      existingObjectCount: 36,
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
    const failure = await runPostgreSqlMigrations(fake.seam, {
      migrations: loadPostgreSqlMigrations(),
    })
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
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
      "lockMigrations",
      "preflightServerVersion",
      "verifyPostmasterContinuity",
      "revalidateRequiredExtensionCatalog",
      "preflightSchemaOwnership",
      "preflightSchemaAcl",
      "preflightMigrationLedgerRelation",
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

  it("rejects a missing managed object after the 0002 baseline is recorded", async () => {
    const migrations = loadPostgreSqlMigrations();
    const current = migrations.slice(0, 2).map(({ id, sha256 }) => ({
      id,
      checksum_sha256: sha256,
    }));
    const fake = executor({
      current,
      ledger: true,
      managedOwnership: "missing-object",
      schemaAcl: "ready",
      schemaOwnership: "owned",
    });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlManagedObjectOwnershipPreflightError);
    expect(failure).toMatchObject({
      baselineApplied: true,
      expectedObjectCount: 36,
      existingObjectCount: 35,
      missingObjectCount: 1,
      operation: "preflightManagedObjectOwnership",
    });
    expect(fake.operations).not.toContain("applyMigration:0002_schema_baseline");
  });

  it.each([
    {
      label: "a missing index, trigger, or constraint",
      baselineDefinitions: "missing-object" as const,
      baselineApplied: true,
      expectedObjectCount: 739,
      existingObjectCount: 738,
      missingObjectCount: 1,
      driftedDefinitionGroupCount: 1,
    },
    {
      label: "definition drift",
      baselineDefinitions: "drifted" as const,
      baselineApplied: true,
      expectedObjectCount: 739,
      existingObjectCount: 739,
      missingObjectCount: 0,
      driftedDefinitionGroupCount: 1,
    },
    {
      label: "a missing catalog row",
      baselineDefinitions: "missing" as const,
      baselineApplied: null,
      expectedObjectCount: null,
      existingObjectCount: null,
      missingObjectCount: null,
      driftedDefinitionGroupCount: null,
    },
    {
      label: "malformed catalog values",
      baselineDefinitions: "invalid" as const,
      baselineApplied: null,
      expectedObjectCount: null,
      existingObjectCount: null,
      missingObjectCount: null,
      driftedDefinitionGroupCount: null,
    },
    {
      label: "a malformed definition fingerprint",
      baselineDefinitions: "invalid-hash" as const,
      baselineApplied: true,
      expectedObjectCount: 739,
      existingObjectCount: 739,
      missingObjectCount: 0,
      driftedDefinitionGroupCount: 0,
    },
    {
      label: "contradictory catalog counts",
      baselineDefinitions: "inconsistent" as const,
      baselineApplied: true,
      expectedObjectCount: 739,
      existingObjectCount: 740,
      missingObjectCount: 0,
      driftedDefinitionGroupCount: 0,
    },
  ])("rejects $label in the baseline definition inventory", async ({
    baselineDefinitions,
    baselineApplied,
    expectedObjectCount,
    existingObjectCount,
    missingObjectCount,
    driftedDefinitionGroupCount,
  }) => {
    const migrations = loadPostgreSqlMigrations();
    const current = migrations.slice(0, 2).map(({ id, sha256 }) => ({
      id,
      checksum_sha256: sha256,
    }));
    const fake = executor({
      baselineDefinitions,
      current,
      ledger: true,
      schemaAcl: "ready",
      schemaOwnership: "owned",
    });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlBaselineDefinitionPreflightError);
    expect(failure).toMatchObject({
      actualDefinitionGroups: baselineDefinitions === "missing"
        || baselineDefinitions === "invalid"
        || baselineDefinitions === "invalid-hash"
        ? null
        : expect.arrayContaining([
          expect.objectContaining({
            objectKind: "index",
            objectCount: baselineDefinitions === "missing-object" ? 51 : 52,
            definitionSha256: baselineDefinitions === "missing-object"
              || baselineDefinitions === "drifted"
              ? "f".repeat(64)
              : expect.stringMatching(/^[0-9a-f]{64}$/u),
          }),
        ]),
      baselineApplied,
      driftedDefinitionGroupCount,
      existingObjectCount,
      expectedObjectCount,
      missingObjectCount,
      operation: "preflightBaselineDefinitions",
      remediation:
        "Restore every missing or changed LCM baseline table, relation ACL, column ACL, index, trigger, constraint, identity sequence, ordinary column, and generated column from the matching packaged migration artifact or a verified backup, then rerun migrations.",
    });
    const serializedFailure =
      (failure as PostgreSqlBaselineDefinitionPreflightError).toJSON();
    expect(serializedFailure).toMatchObject({
        baselineApplied,
        driftedDefinitionGroupCount,
        existingObjectCount,
        expectedObjectCount,
        missingObjectCount,
      });
    expect(serializedFailure).not.toHaveProperty("actualDefinitionGroups");
    expect(JSON.stringify(serializedFailure)).not.toMatch(/[0-9a-f]{64}/u);
    expect((failure as PostgreSqlBaselineDefinitionPreflightError).remediation)
      .toContain("column ACL");
    const inventoryCall = fake.seam.query.mock.calls.find(([, context]) => (
      context.operation === "preflightBaselineDefinitions"
    ));
    const inventorySql =
      (inventoryCall?.[0] as { text?: string } | undefined)?.text ?? "";
    for (const catalog of [
      "pg_catalog.pg_index",
      "pg_catalog.pg_trigger",
      "pg_catalog.pg_constraint",
      "pg_catalog.pg_attribute",
      "pg_catalog.pg_attrdef",
      "pg_catalog.pg_sequence",
      "pg_catalog.pg_depend",
      "pg_catalog.pg_collation",
      "pg_catalog.aclexplode",
      "pg_catalog.acldefault",
      "pg_catalog.pg_get_indexdef",
      "pg_catalog.pg_get_triggerdef",
      "pg_catalog.pg_get_constraintdef",
      "pg_catalog.pg_get_expr",
      "pg_catalog.format_type",
      "attribute.attnotnull",
      "attribute.attidentity",
      "attribute.attacl",
      "relation.relpersistence",
      "sequence_relation.relpersistence",
      "relation.relrowsecurity",
      "relation.relforcerowsecurity",
      "relation.relispartition",
      "pg_catalog.pg_inherits",
      "trigger.tgenabled",
      "trigger.tgconstraint",
      "object_name",
    ]) expect(inventorySql).toContain(catalog);
    expect((inventoryCall?.[0] as { values?: unknown[] } | undefined)?.values)
      .toEqual([
        true,
        expect.arrayContaining(["session_ingest_log_identity_lookup_idx"]),
        expect.arrayContaining([
          "session_ingest_log|session_ingest_log_enforce_session_id_uniqueness",
        ]),
        expect.arrayContaining(["session_ingest_log|session_ingest_log_pkey"]),
        expect.arrayContaining(["session_ingest_log|session_id_sha256"]),
        expect.arrayContaining(["projects|identity_key", "recall_surfacing|surfaced_at"]),
        expect.arrayContaining(["conversations_conversation_id_seq"]),
        expect.arrayContaining(["schema_migrations", "fenced_leases"]),
        expect.arrayContaining(["table|schema_migrations", "sequence|fenced_leases_fencing_token_seq"]),
        expect.arrayContaining([
          "projects|identity_key",
          "session_ingest_log|session_id_sha256",
        ]),
        739,
        [
          "index",
          "trigger",
          "constraint",
          "generated_column",
          "column_acl",
          "identity_sequence",
          "table",
          "relation_acl",
          "ordinary_column",
        ],
        [52, 3, 174, 15, 225, 6, 24, 30, 210],
        [
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ],
      ]);
    expect(inventorySql).toContain("pg_catalog.unnest");
    expect(inventorySql).toContain("WHEN 'S' THEN 's'::pg_catalog.\"char\"");
    for (const hardcodedGroupCount of [
      52, 3, 174, 15, 225, 6, 24, 30, 210,
    ]) {
      expect(inventorySql).not.toMatch(
        new RegExp(`\\b${hardcodedGroupCount}::pg_catalog\\.int4`, "u"),
      );
    }
  });

  it.each([
    {
      label: "drifted",
      identityFunctions: "drifted" as const,
      baselineApplied: true,
      expectedFunctionCount: 3,
      existingFunctionCount: 3,
      driftedFunctionCount: 1,
    },
    {
      label: "missing",
      identityFunctions: "missing" as const,
      baselineApplied: null,
      expectedFunctionCount: null,
      existingFunctionCount: null,
      driftedFunctionCount: null,
    },
    {
      label: "malformed",
      identityFunctions: "invalid" as const,
      baselineApplied: null,
      expectedFunctionCount: null,
      existingFunctionCount: null,
      driftedFunctionCount: null,
    },
    {
      label: "inconsistent",
      identityFunctions: "inconsistent" as const,
      baselineApplied: true,
      expectedFunctionCount: 3,
      existingFunctionCount: 4,
      driftedFunctionCount: 0,
    },
  ])("rejects $label identity-function fingerprint state", async ({
    identityFunctions,
    baselineApplied,
    expectedFunctionCount,
    existingFunctionCount,
    driftedFunctionCount,
  }) => {
    const migrations = loadPostgreSqlMigrations();
    const current = migrations.slice(0, 2).map(({ id, sha256 }) => ({
      id,
      checksum_sha256: sha256,
    }));
    const fake = executor({
      current,
      identityFunctions,
      ledger: true,
      schemaAcl: "ready",
      schemaOwnership: "owned",
    });
    const failure = await runPostgreSqlMigrations(fake.seam, { migrations })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgreSqlIdentityFunctionPreflightError);
    expect(failure).toMatchObject({
      baselineApplied,
      driftedFunctionCount,
      existingFunctionCount,
      expectedFunctionCount,
      operation: "preflightIdentityFunctionDefinitions",
      remediation:
        "Restore the packaged LCM identity-enforcement functions and their security configuration, then rerun migrations.",
    });
    expect((failure as PostgreSqlIdentityFunctionPreflightError).toJSON())
      .toMatchObject({
        baselineApplied,
        driftedFunctionCount,
        existingFunctionCount,
        expectedFunctionCount,
      });
    const fingerprintCall = fake.seam.query.mock.calls.find(([, context]) => (
      context.operation === "preflightIdentityFunctionDefinitions"
    ));
    const fingerprintSql =
      (fingerprintCall?.[0] as { text?: string } | undefined)?.text ?? "";
    for (const fingerprintedField of [
      "prosrc",
      "prosecdef",
      "proleakproof",
      "provolatile",
      "proparallel",
      "proconfig",
      "normalized_acl",
      "aclexplode",
      "owner|owner|EXECUTE|false",
    ]) expect(fingerprintSql).toContain(fingerprintedField);
    expect(fingerprintSql).toContain("pg_catalog.unnest");
    expect(fingerprintSql).not.toContain("'enforce_summary_id_uniqueness'");
    expect((fingerprintCall?.[0] as { values?: unknown[] } | undefined)?.values)
      .toEqual([
        true,
        [
          "enforce_summary_id_uniqueness",
          "enforce_large_file_id_uniqueness",
          "enforce_session_ingest_id_uniqueness",
        ],
        [
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ],
      ]);
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
      schemaSnapshots: [],
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
      "pinMigrationDeparserSettings",
      "preflightSessionReplicationRole",
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
