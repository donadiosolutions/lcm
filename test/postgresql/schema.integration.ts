import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadPostgreSqlMigrations,
  runPostgreSqlMigrations,
} from "../../src/storage/postgresql/migrations.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  inspectPostgreSqlSearchConfiguration,
  POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
} from "../../src/storage/postgresql/search-configuration.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);

const SCHEMA_BASELINE_SQL = loadPostgreSqlMigrations()
  .find(({ id }) => id === "0002_schema_baseline")?.sql ?? "";
const PINNED_NORMALIZATION_RULES = JSON.parse(
  /\$rules\$(\{[^\n]+\})\$rules\$::jsonb/u.exec(SCHEMA_BASELINE_SQL)?.[1] ?? "{}",
) as Record<string, string>;

const DOMAIN_TABLES = [
  "context_items",
  "conversations",
  "fenced_leases",
  "ingest_checkpoints",
  "large_files",
  "machines",
  "message_parts",
  "messages",
  "native_transcripts",
  "passive_event_inbox",
  "project_aliases",
  "projects",
  "promoted_memories",
  "promoted_memory_tags",
  "recall_surfacing",
  "redaction_counters",
  "session_ingest_log",
  "session_instructions",
  "summaries",
  "summary_large_files",
  "summary_messages",
  "summary_parents",
  "transcript_messages",
] as const;

const FOREIGN_KEY_DELETE_ACTIONS = [
  "context_items|CASCADE|1",
  "context_items|NO ACTION|2",
  "conversations|RESTRICT|1",
  "fenced_leases|RESTRICT|2",
  "ingest_checkpoints|RESTRICT|2",
  "large_files|CASCADE|1",
  "message_parts|CASCADE|1",
  "messages|CASCADE|1",
  "native_transcripts|RESTRICT|2",
  "passive_event_inbox|RESTRICT|2",
  "project_aliases|RESTRICT|2",
  "promoted_memories|RESTRICT|1",
  "promoted_memory_tags|CASCADE|1",
  "recall_surfacing|RESTRICT|1",
  "redaction_counters|RESTRICT|1",
  "session_ingest_log|RESTRICT|1",
  "session_instructions|RESTRICT|2",
  "summaries|CASCADE|1",
  "summary_large_files|CASCADE|1",
  "summary_messages|CASCADE|1",
  "summary_messages|NO ACTION|1",
  "summary_parents|CASCADE|1",
  "summary_parents|NO ACTION|1",
  "transcript_messages|CASCADE|1",
  "transcript_messages|RESTRICT|1",
] as const;

interface SeededScope {
  machineId: string;
  otherMachineId: string;
  projectId: string;
  otherProjectId: string;
  conversationId: string;
  otherConversationId: string;
}

async function seedScope(database: PostgreSqlRuntime): Promise<SeededScope> {
  const machines = await database.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ('machine-a', 'Machine A'), ('machine-b', 'Machine B')`,
  }, { domain: "factory", operation: "seedMachines" });
  const machineRows = await database.query<{ machine_id: string }>({
    text: "SELECT machine_id FROM lcm.machines ORDER BY identity_key",
  }, { domain: "factory", operation: "readSeedMachines" });
  const projects = await database.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (display_name)
           VALUES ('Project A'), ('Project B')`,
  }, { domain: "factory", operation: "seedProjects" });
  const projectRows = await database.query<{ project_id: string }>({
    text: "SELECT project_id FROM lcm.projects ORDER BY display_name",
  }, { domain: "factory", operation: "readSeedProjects" });
  const [machineId, otherMachineId] = machineRows.rows.map((row) => row.machine_id);
  const [projectId, otherProjectId] = projectRows.rows.map((row) => row.project_id);
  const conversations = await database.query<{ conversation_id: string }>({
    text: `INSERT INTO lcm.conversations (project_id, session_id)
           VALUES ($1, 'session-a'), ($2, 'session-a')
           RETURNING conversation_id`,
    values: [projectId, otherProjectId],
  }, { domain: "factory", operation: "seedConversations" });
  const conversationByProject = await database.query<{
    conversation_id: string;
    project_id: string;
  }>({
    text: `SELECT project_id, conversation_id
           FROM lcm.conversations
           WHERE project_id = ANY($1::uuid[])`,
    values: [[projectId, otherProjectId]],
  }, { domain: "factory", operation: "readSeedConversations" });
  const conversationId = conversationByProject.rows.find((row) => row.project_id === projectId)?.conversation_id;
  const otherConversationId = conversationByProject.rows.find((row) => row.project_id === otherProjectId)?.conversation_id;
  if (!machineId || !otherMachineId || !projectId || !otherProjectId || !conversationId || !otherConversationId) {
    throw new Error(`incomplete schema seed: ${machines.rowCount}/${projects.rowCount}/${conversations.rowCount}`);
  }
  return { machineId, otherMachineId, projectId, otherProjectId, conversationId, otherConversationId };
}

async function expectConstraintFailure(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ backend: "postgresql" });
}

describe("PostgreSQL schema baseline", () => {
  it("fingerprints the owned text-search contract and fails closed on mapping drift", async () => {
    await withPostgreSqlTestDatabase("schema-search-config", async (database) => {
      await expect(inspectPostgreSqlSearchConfiguration(database.migrator))
        .resolves.toEqual({
          name: "lcm.search_v1",
          expectedSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
          actualSha256: POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
          objectCount: 19,
          ownershipReady: true,
          ready: true,
        });

      await database.migrator.query({
        text: "ALTER TEXT SEARCH CONFIGURATION lcm.search_v1 DROP MAPPING FOR uint",
      }, { domain: "factory", operation: "simulateSearchConfigurationDrift" });

      await expect(inspectPostgreSqlSearchConfiguration(database.migrator))
        .resolves.toMatchObject({
          actualSha256: null,
          objectCount: 18,
          ready: false,
        });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          operation: "preflightSearchConfiguration",
          searchConfiguration: expect.objectContaining({ objectCount: 18, ready: false }),
        });
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        searchConfiguration: expect.objectContaining({ objectCount: 18, ready: false }),
      });
    });
  });

  it("fails closed when the normalization function definition drifts", async () => {
    await withPostgreSqlTestDatabase("schema-function-drift", async (database) => {
      await database.migrator.query({
        text: `CREATE OR REPLACE FUNCTION lcm.normalize_search_text(input text)
               RETURNS text
               LANGUAGE sql
               IMMUTABLE
               PARALLEL SAFE
               SET search_path = pg_catalog
               AS $function$ SELECT $1 $function$`,
      }, { domain: "factory", operation: "simulateNormalizationDefinitionDrift" });

      await expect(inspectPostgreSqlSearchConfiguration(database.migrator))
        .resolves.toMatchObject({
          actualSha256: expect.not.stringMatching(
            new RegExp(`^${POSTGRESQL_SEARCH_CONFIGURATION_SHA256}$`, "u"),
          ),
          objectCount: 19,
          ownershipReady: true,
          ready: false,
        });
    });
  });

  it("fails closed when normalization function ownership drifts", async () => {
    await withPostgreSqlTestDatabase("schema-function-owner", async (database) => {
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({
          text: "ALTER FUNCTION lcm.normalize_search_text(text) OWNER TO lcm_test_runtime",
        }, { domain: "factory", operation: "simulateNormalizationOwnerDrift" });
      } finally {
        await admin.close();
      }

      await expect(inspectPostgreSqlSearchConfiguration(database.migrator))
        .resolves.toMatchObject({
          actualSha256: expect.any(String),
          objectCount: 19,
          ownershipReady: false,
          ready: false,
        });
    });
  });

  it("creates the complete catalog, UUIDv7 identities, generated search columns, and least-privilege baseline", async () => {
    await withPostgreSqlTestDatabase("schema-catalog", async (database) => {
      const tables = await database.migrator.query<{ tablename: string }>({
        text: `SELECT tablename FROM pg_catalog.pg_tables
               WHERE schemaname = 'lcm' AND tablename <> 'schema_migrations'
               ORDER BY tablename`,
      }, { domain: "factory", operation: "inspectSchemaTables" });
      expect(tables.rows.map((row) => row.tablename)).toEqual(DOMAIN_TABLES);
      await expect(database.migrator.query<{ description: string }>({
        text: `SELECT pg_catalog.obj_description(
                 'lcm.summary_large_files'::pg_catalog.regclass,
                 'pg_class'
               ) AS description`,
      }, { domain: "factory", operation: "inspectOpaqueSummaryFileContract" }))
        .resolves.toMatchObject({
          rows: [{
            description: expect.stringContaining(
              "deleting a large_files row must preserve this reference",
            ),
          }],
        });

      const constraints = await database.migrator.query<{
        table_name: string;
        constraint_type: string;
        definition: string;
      }>({
        text: `SELECT relation.relname AS table_name,
                      con.contype::text AS constraint_type,
                      replace(pg_get_constraintdef(con.oid, true), 'lcm.', '') AS definition
               FROM pg_catalog.pg_constraint AS con
               JOIN pg_catalog.pg_class AS relation ON relation.oid = con.conrelid
               JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm'
                 AND con.contype IN ('c', 'f', 'p', 'u')
               ORDER BY relation.relname, con.contype,
                        pg_get_constraintdef(con.oid, true)`,
      }, { domain: "factory", operation: "inspectSchemaConstraints" });
      const normalizedConstraints = constraints.rows
        .map((row) => `${row.table_name}|${row.constraint_type}|${row.definition}`)
        .join("\n");
      expect(constraints.rowCount).toBe(166);
      expect(createHash("sha256").update(normalizedConstraints).digest("hex"))
        .toBe("7c10f183b4136fa876940752282deb0c8714ed81f492b6d42ffac2b455d08292");

      const deleteActions = await database.migrator.query<{
        table_name: string;
        delete_action: string;
        action_count: string;
      }>({
        text: `SELECT relation.relname AS table_name,
                      CASE con.confdeltype
                        WHEN 'a' THEN 'NO ACTION'
                        WHEN 'r' THEN 'RESTRICT'
                        WHEN 'c' THEN 'CASCADE'
                        WHEN 'n' THEN 'SET NULL'
                        WHEN 'd' THEN 'SET DEFAULT'
                      END AS delete_action,
                      count(*)::text AS action_count
               FROM pg_catalog.pg_constraint AS con
               JOIN pg_catalog.pg_class AS relation ON relation.oid = con.conrelid
               JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm' AND con.contype = 'f'
               GROUP BY relation.relname, con.confdeltype
               ORDER BY relation.relname, delete_action`,
      }, { domain: "factory", operation: "inspectForeignKeyActions" });
      expect(deleteActions.rows.map((row) => (
        `${row.table_name}|${row.delete_action}|${row.action_count}`
      ))).toEqual(FOREIGN_KEY_DELETE_ACTIONS);
      const deferredSourceReferences = await database.migrator.query<{
        constraint_count: string;
        table_name: string;
      }>({
        text: `SELECT table_name, count(*)::text AS constraint_count
               FROM information_schema.table_constraints
               WHERE constraint_schema = 'lcm'
                 AND constraint_type = 'FOREIGN KEY'
                 AND is_deferrable = 'YES'
                 AND initially_deferred = 'YES'
               GROUP BY table_name
               ORDER BY table_name`,
      }, { domain: "factory", operation: "inspectDeferredSourceReferences" });
      expect(deferredSourceReferences.rows).toEqual([
        { constraint_count: "2", table_name: "context_items" },
        { constraint_count: "1", table_name: "summary_messages" },
        { constraint_count: "1", table_name: "summary_parents" },
      ]);

      const unindexedForeignKeys = await database.migrator.query<{
        table_name: string;
        definition: string;
      }>({
        text: `SELECT relation.relname AS table_name, pg_get_constraintdef(con.oid, true) AS definition
               FROM pg_catalog.pg_constraint AS con
               JOIN pg_catalog.pg_class AS relation ON relation.oid = con.conrelid
               JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm' AND con.contype = 'f'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_index AS idx
                   WHERE idx.indrelid = con.conrelid
                     AND idx.indisvalid AND idx.indisready
                     AND NOT EXISTS (
                       SELECT 1
                       FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
                       WHERE idx.indkey[key.ordinal - 1] <> key.attnum
                     )
                     AND (
                       idx.indpred IS NULL OR
                       pg_get_expr(idx.indpred, idx.indrelid) IN (
                         '(message_id IS NOT NULL)',
                         '(summary_id IS NOT NULL)',
                         '(machine_id IS NOT NULL)'
                       )
                     )
                 )
               ORDER BY relation.relname, definition`,
      }, { domain: "factory", operation: "inspectForeignKeyIndexes" });
      expect(unindexedForeignKeys.rows).toEqual([]);

      const explicitIndexes = await database.migrator.query<{
        index_definition: string;
        index_name: string;
      }>({
        text: `SELECT index_relation.relname AS index_name,
                      pg_catalog.pg_get_indexdef(index_relation.oid) AS index_definition
               FROM pg_catalog.pg_index AS index_metadata
               JOIN pg_catalog.pg_class AS table_relation
                 ON table_relation.oid = index_metadata.indrelid
               JOIN pg_catalog.pg_class AS index_relation
                 ON index_relation.oid = index_metadata.indexrelid
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = table_relation.relnamespace
               WHERE namespace.nspname = 'lcm'
                 AND table_relation.relname <> 'schema_migrations'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_constraint AS constraint_metadata
                   WHERE constraint_metadata.conindid = index_relation.oid
                 )
               ORDER BY index_relation.relname`,
      }, { domain: "factory", operation: "inspectExplicitSchemaIndexes" });
      expect(explicitIndexes.rowCount).toBe(49);
      expect(explicitIndexes.rows.map(({ index_name }) => index_name))
        .not.toContain("message_parts_metadata_idx");
      const provenanceIndex = explicitIndexes.rows.find(
        ({ index_name }) => index_name === "promoted_memories_source_summary_idx",
      );
      expect(provenanceIndex?.index_definition).toContain(
        "(project_id, source_project_id, source_summary_id)",
      );
      expect(provenanceIndex?.index_definition).toContain(
        "WHERE (source_summary_id IS NOT NULL)",
      );
      expect(explicitIndexes.rows.find(
        ({ index_name }) => index_name === "promoted_memory_tags_lookup_idx",
      )?.index_definition).toContain("(project_id, tag, memory_id)");
      expect(explicitIndexes.rows.find(
        ({ index_name }) => index_name === "promoted_memory_tags_normalized_lookup_idx",
      )?.index_definition).toContain("(project_id, normalized_tag, memory_id)");
      expect(explicitIndexes.rows.find(
        ({ index_name }) => index_name === "promoted_memory_tags_search_document_idx",
      )?.index_definition).toContain("USING gin (search_document)");
      expect(explicitIndexes.rows.find(
        ({ index_name }) => index_name === "promoted_memory_tags_tag_trgm_idx",
      )?.index_definition).toContain(
        "USING gin (lcm.normalize_search_text(tag) gin_trgm_ops)",
      );

      const scope = await seedScope(database.migrator);
      const splitConversation = await database.migrator.query<{ conversation_id: string }>({
        text: `INSERT INTO lcm.conversations (project_id, session_id, title)
               VALUES ($1, 'session-a', 'split') RETURNING conversation_id`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedSplitConversation" });
      await expect(database.migrator.query<{ conversation_id: string }>({
        text: `SELECT conversation_id FROM lcm.conversations
               WHERE project_id = $1 AND session_id = 'session-a'
               ORDER BY created_at DESC, conversation_id DESC`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "readSplitConversations" }))
        .resolves.toMatchObject({
          rows: [
            { conversation_id: splitConversation.rows[0]?.conversation_id },
            { conversation_id: scope.conversationId },
          ],
        });
      const identityVersions = await database.migrator.query<{
        machine_version: number;
        project_version: number;
      }>({
        text: `SELECT uuid_extract_version($1::uuid) AS machine_version,
                      uuid_extract_version($2::uuid) AS project_version`,
        values: [scope.machineId, scope.projectId],
      }, { domain: "factory", operation: "inspectUuidVersions" });
      expect(identityVersions.rows[0]).toEqual({ machine_version: 7, project_version: 7 });

      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.machines (machine_id, identity_key)
               VALUES ('6ba7b810-9dad-41d1-80b4-00c04fd430c8', 'legacy-machine')`,
      }, { domain: "factory", operation: "rejectLegacyDistributedIdentity" }));

      const generated = await database.migrator.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>({
        text: `SELECT table_name, column_name, data_type
               FROM information_schema.columns
               WHERE table_schema = 'lcm'
                 AND is_generated = 'ALWAYS'
               ORDER BY table_name, column_name`,
      }, { domain: "factory", operation: "inspectGeneratedColumns" });
      expect(generated.rows).toEqual([
        { table_name: "messages", column_name: "search_document", data_type: "tsvector" },
        { table_name: "promoted_memories", column_name: "search_document", data_type: "tsvector" },
        { table_name: "promoted_memory_tags", column_name: "normalized_tag", data_type: "text" },
        { table_name: "promoted_memory_tags", column_name: "search_document", data_type: "tsvector" },
        { table_name: "summaries", column_name: "search_document", data_type: "tsvector" },
      ]);
      const tagNormalization = await database.migrator.query<{ expression: string }>({
        text: `SELECT pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
                        AS expression
               FROM pg_catalog.pg_attrdef AS attribute_default
               JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid = attribute_default.adrelid
                AND attribute.attnum = attribute_default.adnum
               JOIN pg_catalog.pg_class AS relation
                 ON relation.oid = attribute_default.adrelid
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'lcm'
                 AND relation.relname = 'promoted_memory_tags'
                 AND attribute.attname = 'normalized_tag'`,
      }, { domain: "factory", operation: "inspectTagNormalizationContract" });
      expect(tagNormalization.rows[0]?.expression).toContain("pg_unicode_fast");

      const normalization = await database.migrator.query<{
        description: string;
        parallel_safety: string;
        unaccent_dependencies: string;
        volatility: string;
      }>({
        text: `SELECT pg_catalog.obj_description(procedure.oid, 'pg_proc') AS description,
                      procedure.provolatile::text AS volatility,
                      procedure.proparallel::text AS parallel_safety,
                      count(extension.oid) FILTER (WHERE extension.extname = 'unaccent')::text
                        AS unaccent_dependencies
               FROM pg_catalog.pg_proc AS procedure
               JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
               LEFT JOIN pg_catalog.pg_depend AS dependency ON dependency.objid = procedure.oid
               LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = dependency.refobjid
               WHERE namespace.nspname = 'lcm' AND procedure.proname = 'normalize_search_text'
               GROUP BY procedure.oid`,
      }, { domain: "factory", operation: "inspectNormalizationContract" });
      expect(normalization.rows[0]).toEqual({
        description: "PostgreSQL 18 pg_unicode_fast case mapping; pinned PostgreSQL 18.4 unaccent.rules SHA-256 ecf4c41c0883dee17d02431e0a7f24a2611aadf8fe1da06e98c6ccb4acc4a981; canonical JSON SHA-256 21d9c6e1f20f37d7d804b81dc7f62372b68de9ff05037d5f4f3c85cef4868588 (2661 rules)",
        parallel_safety: "s",
        unaccent_dependencies: "0",
        volatility: "i",
      });
      expect(Object.keys(PINNED_NORMALIZATION_RULES)).toHaveLength(2_661);
      await expect(database.migrator.query<{ mismatch_count: string }>({
        text: `SELECT count(*)::text AS mismatch_count
               FROM pg_catalog.unnest($1::text[]) AS pinned(source_character)
               WHERE lcm.normalize_search_text(source_character) IS DISTINCT FROM
                 public.unaccent(
                   'public.unaccent'::regdictionary,
                   pg_catalog.lower(
                     source_character COLLATE pg_catalog.pg_unicode_fast
                   )
                 )`,
        values: [Object.keys(PINNED_NORMALIZATION_RULES)],
      }, { domain: "factory", operation: "compareAllPinnedNormalizationRules" }))
        .resolves.toMatchObject({ rows: [{ mismatch_count: "0" }] });

      const privileges = await database.migrator.query<{
        migrator_insert: boolean;
        runtime_select: boolean;
        public_select: boolean;
      }>({
        text: `SELECT
                 has_table_privilege(current_user, 'lcm.messages', 'INSERT') AS migrator_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.messages', 'SELECT') AS runtime_select,
                 has_table_privilege('public', 'lcm.messages', 'SELECT') AS public_select`,
      }, { domain: "factory", operation: "inspectSchemaPrivileges" });
      expect(privileges.rows[0]).toEqual({
        migrator_insert: true,
        runtime_select: false,
        public_select: false,
      });

      await database.migrator.query({
        text: `CREATE TABLE lcm.operator_owned_metadata (key text PRIMARY KEY);
               INSERT INTO lcm.operator_owned_metadata (key) VALUES ('preserve-me')`,
      }, { domain: "factory", operation: "seedUnknownSchemaObject" });
      await expect(runPostgreSqlMigrations(database.migrator)).resolves.toMatchObject({ applied: [] });
      await expect(database.migrator.query<{ key: string }>({
        text: "SELECT key FROM lcm.operator_owned_metadata",
      }, { domain: "factory", operation: "verifyUnknownSchemaObject" }))
        .resolves.toMatchObject({ rows: [{ key: "preserve-me" }] });
    });
  });

  it("keeps indexed normalization stable when the mutable unaccent extension is removed", async () => {
    await withPostgreSqlTestDatabase("schema-pinned-normalization", async (database) => {
      const scope = await seedScope(database.migrator);
      const normalize = async (): Promise<string> => {
        const result = await database.migrator.query<{ normalized: string }>({
          text: "SELECT lcm.normalize_search_text('Café ﬃ ⅒') AS normalized",
        }, { domain: "factory", operation: "readPinnedNormalization" });
        return result.rows[0]?.normalized ?? "";
      };

      expect(await normalize()).toBe("cafe ffi  1/10");
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query({ text: "DROP EXTENSION unaccent" }, {
          domain: "factory",
          operation: "simulateUnaccentRuleRemoval",
        });
      } finally {
        await admin.close();
      }
      expect(await normalize()).toBe("cafe ffi  1/10");
      await database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 0, 'user', 'Café after extension drift', 4)`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "writeWithPinnedNormalization" });
      await expect(database.migrator.query<{ search_document: string }>({
        text: `SELECT search_document::text
               FROM lcm.messages
               WHERE project_id = $1 AND conversation_id = $2 AND seq = 0`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "readStableSearchDocument" }))
        .resolves.toMatchObject({ rows: [{ search_document: "'after':2 'cafe':1 'drift':4 'extension':3" }] });
      await expect(database.runtime.health()).resolves.toMatchObject({
        status: "unavailable",
        extensions: expect.arrayContaining([
          expect.objectContaining({ name: "unaccent", status: "uninstalled" }),
        ]),
      });
    });
  });

  it("enforces project and conversation scope, range checks, uniqueness, and cascade policy", async () => {
    await withPostgreSqlTestDatabase("schema-integrity", async (database) => {
      const scope = await seedScope(database.migrator);
      await database.migrator.query({
        text: `INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path)
               VALUES ($1, $2, '/workspace/a', '/workspace/a')`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "seedAlias" });
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path)
               VALUES ($1, $2, '/workspace/a/', '/workspace/a')`,
        values: [scope.otherProjectId, scope.machineId],
      }, { domain: "factory", operation: "rejectAliasCollision" }));
      await database.migrator.query({
        text: `INSERT INTO lcm.session_ingest_log (project_id, session_id, message_count)
               VALUES ($1, 'session-a', 1)`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedSessionIngest" });
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.session_ingest_log (project_id, session_id, message_count)
               VALUES ($1, 'session-a', 2)`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "rejectDuplicateSessionIngest" }));
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.session_ingest_log (project_id, session_id, message_count)
               VALUES ($1, 'bad-count', -1)`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "rejectNegativeSessionIngestCount" }));

      const message = await database.migrator.query<{ message_id: string }>({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 0, 'user', 'Café schema baseline', 3)
               RETURNING message_id`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedMessage" });
      const messageId = message.rows[0]?.message_id;
      expect(messageId).toBeDefined();
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 1, 'user', 'cross-project', 1)`,
        values: [scope.otherProjectId, scope.conversationId],
      }, { domain: "factory", operation: "rejectCrossProjectMessage" }));
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 0, 'assistant', 'duplicate sequence', 1)`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "rejectDuplicateMessageSequence" }));
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 1, 'assistant', 'negative tokens', -1)`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "rejectNegativeTokens" }));

      const opaquePartMetadata = "  { \"source\" : fixture }\nnot-json  ";
      await database.migrator.query({
        text: `INSERT INTO lcm.message_parts
                 (project_id, conversation_id, message_id, session_id, part_type,
                  ordinal, metadata, step_cost)
               VALUES ($1, $2, $3, 'session-a', 'text', 0, $4, 0)`,
        values: [scope.projectId, scope.conversationId, messageId, opaquePartMetadata],
      }, { domain: "factory", operation: "seedMessagePart" });
      await expect(database.migrator.query<{
        data_type: string;
        metadata: string;
        step_cost: number;
      }>({
        text: `SELECT information_schema.columns.data_type, part.metadata, part.step_cost
               FROM lcm.message_parts AS part
               CROSS JOIN information_schema.columns
               WHERE information_schema.columns.table_schema = 'lcm'
                 AND information_schema.columns.table_name = 'message_parts'
                 AND information_schema.columns.column_name = 'metadata'
                 AND part.project_id = $1
                 AND part.conversation_id = $2
                 AND part.message_id = $3`,
        values: [scope.projectId, scope.conversationId, messageId],
      }, { domain: "factory", operation: "readOpaqueMessagePartMetadata" }))
        .resolves.toMatchObject({
          rows: [{ data_type: "text", metadata: opaquePartMetadata, step_cost: 0 }],
        });
      await database.migrator.query({
        text: "DELETE FROM lcm.messages WHERE message_id = $1",
        values: [messageId],
      }, { domain: "factory", operation: "deleteOwnedMessage" });
      const partCount = await database.migrator.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM lcm.message_parts WHERE message_id = $1",
        values: [messageId],
      }, { domain: "factory", operation: "verifyMessagePartCascade" });
      expect(partCount.rows[0]?.count).toBe("0");

      const sourceMessage = await database.migrator.query<{ message_id: string }>({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 1, 'assistant', 'source message', 2)
               RETURNING message_id`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedSourceMessage" });
      const summary = await database.migrator.query<{ summary_id: string }>({
        text: `INSERT INTO lcm.summaries
                 (summary_id, project_id, conversation_id, kind, content, token_count)
               VALUES ('sum_0123456789abcdef', $1, $2, 'leaf', 'caller ID summary', 2)
               RETURNING summary_id`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedSummary" });
      expect(summary.rows[0]?.summary_id).toBe("sum_0123456789abcdef");
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_messages
                 (project_id, conversation_id, summary_id, message_id, ordinal)
               VALUES ($1, $2, $3, $4, 0)`,
        values: [scope.projectId, scope.conversationId, summary.rows[0]?.summary_id, sourceMessage.rows[0]?.message_id],
      }, { domain: "factory", operation: "linkSummaryMessage" });
      await expectConstraintFailure(database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: "DELETE FROM lcm.messages WHERE message_id = $1",
          values: [sourceMessage.rows[0]?.message_id],
        }, { domain: "factory", operation: "restrictSourceMessageDeleteAtCommit" });
      }));
      const transcript = await database.migrator.query<{ transcript_id: string }>({
        text: `INSERT INTO lcm.native_transcripts
                 (project_id, machine_id, client_name, format_name, format_version,
                  native_session_id, source_locator, source_ordinal, observed_at,
                  scrubber_version, content_sha256, ingest_key, native_payload)
               VALUES ($1, $2, 'codex', 'jsonl', '1', 'session-a', '/source/a', 0,
                       statement_timestamp(), '1', $3, $4, '{}'::jsonb)
               RETURNING transcript_id`,
        values: [scope.projectId, scope.machineId, "a".repeat(64), "b".repeat(64)],
      }, { domain: "factory", operation: "seedNativeTranscript" });
      await database.migrator.query({
        text: `INSERT INTO lcm.transcript_messages
                 (project_id, transcript_id, conversation_id, message_id, source_ordinal)
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          scope.projectId,
          transcript.rows[0]?.transcript_id,
          scope.conversationId,
          sourceMessage.rows[0]?.message_id,
        ],
      }, { domain: "factory", operation: "linkTranscriptMessage" });
      await database.migrator.query({
        text: "DELETE FROM lcm.native_transcripts WHERE transcript_id = $1",
        values: [transcript.rows[0]?.transcript_id],
      }, { domain: "factory", operation: "deleteNativeTranscript" });
      await expect(database.migrator.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM lcm.transcript_messages WHERE transcript_id = $1",
        values: [transcript.rows[0]?.transcript_id],
      }, { domain: "factory", operation: "verifyTranscriptLinkCascade" }))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.summary_parents
                 (project_id, conversation_id, summary_id, parent_summary_id, ordinal)
               VALUES ($1, $2, $3, $3, 0)`,
        values: [scope.projectId, scope.conversationId, summary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "rejectSelfSummaryEdge" }));
      await expectConstraintFailure(database.migrator.query({
        text: `INSERT INTO lcm.context_items
                 (project_id, conversation_id, ordinal, item_type, message_id, summary_id)
               VALUES ($1, $2, 0, 'message', $3, $4)`,
        values: [scope.projectId, scope.conversationId, sourceMessage.rows[0]?.message_id, summary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "rejectAmbiguousContextItem" }));

      const memory = await database.migrator.query<{ memory_id: string }>({
        text: `INSERT INTO lcm.promoted_memories
                 (project_id, content, source_summary_id, source_project_id, confidence)
               VALUES ($1, 'durable memory', $2, 'source-a', 0.75)
               RETURNING memory_id`,
        values: [scope.projectId, summary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "seedPromotedMemory" });
      await database.migrator.query({
        text: "DELETE FROM lcm.summaries WHERE project_id = $1 AND summary_id = $2",
        values: [scope.projectId, summary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "deleteSourceSummary" });
      const preserved = await database.migrator.query<{
        source_project_id: string;
        source_summary_id: string;
      }>({
        text: `SELECT source_project_id, source_summary_id
               FROM lcm.promoted_memories WHERE memory_id = $1`,
        values: [memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "verifyPromotedPreservation" });
      expect(preserved.rows[0]).toEqual({
        source_project_id: "source-a",
        source_summary_id: summary.rows[0]?.summary_id,
      });
      await expect(database.migrator.query<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM lcm.summary_messages
               WHERE project_id = $1 AND summary_id = $2`,
        values: [scope.projectId, summary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "verifySummaryJoinCascade" }))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
      await expect(database.migrator.query({
        text: "DELETE FROM lcm.messages WHERE message_id = $1",
        values: [sourceMessage.rows[0]?.message_id],
      }, { domain: "factory", operation: "deleteReleasedSourceMessage" })).resolves.toBeDefined();

      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memory_tags (project_id, memory_id, ordinal, tag)
               VALUES ($1, $2, 0, 'type:decision')`,
        values: [scope.projectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "seedPromotedTag" });
      await database.migrator.query({
        text: `INSERT INTO lcm.recall_surfacing (project_id, memory_id, session_id)
               VALUES ($1, $2, 'session-a')`,
        values: [scope.projectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "seedRecallSurfacing" });
      await database.migrator.query({
        text: "DELETE FROM lcm.promoted_memories WHERE memory_id = $1",
        values: [memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "deletePromotedMemory" });
      await expect(database.migrator.query<{
        recalled_memory_id: string;
        recall_count: string;
        tag_count: string;
      }>({
        text: `SELECT
                 (SELECT count(*)::text FROM lcm.promoted_memory_tags
                 WHERE memory_id = $1::uuid) AS tag_count,
                 (SELECT count(*)::text FROM lcm.recall_surfacing
                  WHERE memory_id = $1::text) AS recall_count,
                 (SELECT max(memory_id) FROM lcm.recall_surfacing
                  WHERE memory_id = $1::text) AS recalled_memory_id`,
        values: [memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "verifyPromotedChildrenCascade" }))
        .resolves.toMatchObject({
          rows: [{
            recalled_memory_id: memory.rows[0]?.memory_id,
            recall_count: "1",
            tag_count: "0",
          }],
        });

      const disposableConversation = await database.migrator.query<{ conversation_id: string }>({
        text: `INSERT INTO lcm.conversations (project_id, session_id)
               VALUES ($1, 'disposable-session') RETURNING conversation_id`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedDisposableConversation" });
      const disposableConversationId = disposableConversation.rows[0]?.conversation_id;
      const disposableMessage = await database.migrator.query<{ message_id: string }>({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 0, 'user', 'disposable', 1) RETURNING message_id`,
        values: [scope.projectId, disposableConversationId],
      }, { domain: "factory", operation: "seedDisposableMessage" });
      const disposableSummary = await database.migrator.query<{ summary_id: string }>({
        text: `INSERT INTO lcm.summaries
                 (project_id, conversation_id, kind, content, token_count)
               VALUES ($1, $2, 'leaf', 'disposable', 1) RETURNING summary_id`,
        values: [scope.projectId, disposableConversationId],
      }, { domain: "factory", operation: "seedDisposableSummary" });
      const disposableParent = await database.migrator.query<{ summary_id: string }>({
        text: `INSERT INTO lcm.summaries
                 (project_id, conversation_id, kind, content, token_count)
               VALUES ($1, $2, 'condensed', 'disposable parent', 1) RETURNING summary_id`,
        values: [scope.projectId, disposableConversationId],
      }, { domain: "factory", operation: "seedDisposableParentSummary" });
      await database.migrator.query({
        text: `INSERT INTO lcm.message_parts
                 (project_id, conversation_id, message_id, session_id, part_type, ordinal)
               VALUES ($1, $2, $3, 'disposable-session', 'text', 0)`,
        values: [scope.projectId, disposableConversationId, disposableMessage.rows[0]?.message_id],
      }, { domain: "factory", operation: "seedDisposablePart" });
      await database.migrator.query({
        text: `INSERT INTO lcm.context_items
                 (project_id, conversation_id, ordinal, item_type, summary_id)
               VALUES ($1, $2, 0, 'summary', $3)`,
        values: [scope.projectId, disposableConversationId, disposableSummary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "seedDisposableContext" });
      await database.migrator.query({
        text: `INSERT INTO lcm.context_items
                 (project_id, conversation_id, ordinal, item_type, message_id)
               VALUES ($1, $2, 1, 'message', $3)`,
        values: [scope.projectId, disposableConversationId, disposableMessage.rows[0]?.message_id],
      }, { domain: "factory", operation: "seedDisposableMessageContext" });
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_messages
                 (project_id, conversation_id, summary_id, message_id, ordinal)
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          scope.projectId,
          disposableConversationId,
          disposableSummary.rows[0]?.summary_id,
          disposableMessage.rows[0]?.message_id,
        ],
      }, { domain: "factory", operation: "seedDisposableSummaryMessage" });
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_parents
                 (project_id, conversation_id, summary_id, parent_summary_id, ordinal)
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          scope.projectId,
          disposableConversationId,
          disposableSummary.rows[0]?.summary_id,
          disposableParent.rows[0]?.summary_id,
        ],
      }, { domain: "factory", operation: "seedDisposableSummaryParent" });
      const disposableFile = await database.migrator.query<{ file_id: string }>({
        text: `INSERT INTO lcm.large_files
                 (file_id, project_id, conversation_id, storage_uri)
               VALUES ('file-1', $1, $2, 'file:///disposable')
               RETURNING file_id`,
        values: [scope.projectId, disposableConversationId],
      }, { domain: "factory", operation: "seedDisposableLargeFile" });
      expect(disposableFile.rows[0]?.file_id).toBe("file-1");
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_large_files
                 (project_id, conversation_id, summary_id, file_id, ordinal)
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          scope.projectId,
          disposableConversationId,
          disposableSummary.rows[0]?.summary_id,
          disposableFile.rows[0]?.file_id,
        ],
      }, { domain: "factory", operation: "seedDisposableSummaryFile" });
      await expectConstraintFailure(database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: "DELETE FROM lcm.messages WHERE message_id = $1",
          values: [disposableMessage.rows[0]?.message_id],
        }, { domain: "factory", operation: "restrictDisposableMessageAtCommit" });
      }));
      await expectConstraintFailure(database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: "DELETE FROM lcm.summaries WHERE project_id = $1 AND summary_id = $2",
          values: [scope.projectId, disposableParent.rows[0]?.summary_id],
        }, { domain: "factory", operation: "restrictDisposableParentAtCommit" });
      }));
      await expectConstraintFailure(database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: "DELETE FROM lcm.summaries WHERE project_id = $1 AND summary_id = $2",
          values: [scope.projectId, disposableSummary.rows[0]?.summary_id],
        }, { domain: "factory", operation: "restrictDisposableContextSummaryAtCommit" });
      }));
      await database.migrator.query({
        text: "DELETE FROM lcm.conversations WHERE conversation_id = $1",
        values: [disposableConversationId],
      }, { domain: "factory", operation: "deleteOwnedConversation" });
      await expect(database.migrator.query<{ child_count: string }>({
        text: `SELECT (
                 (SELECT count(*) FROM lcm.messages WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.summaries WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.context_items WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.large_files WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.summary_messages WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.summary_parents WHERE conversation_id = $1) +
                 (SELECT count(*) FROM lcm.summary_large_files WHERE conversation_id = $1)
               )::text AS child_count`,
        values: [disposableConversationId],
      }, { domain: "factory", operation: "verifyConversationCascade" }))
        .resolves.toMatchObject({ rows: [{ child_count: "0" }] });

      await expectConstraintFailure(database.migrator.query({
        text: "DELETE FROM lcm.projects WHERE project_id = $1",
        values: [scope.projectId],
      }, { domain: "factory", operation: "restrictProjectDelete" }));
      await expectConstraintFailure(database.migrator.query({
        text: "DELETE FROM lcm.machines WHERE machine_id = $1",
        values: [scope.machineId],
      }, { domain: "factory", operation: "restrictMachineDelete" }));
      await database.migrator.query({
        text: `INSERT INTO lcm.fenced_leases
                 (project_id, resource_type, resource_key, owner_machine_id, owner_process_id,
                  operation, renewed_at, expires_at)
               VALUES ($1, 'project', 'release-check', $2, 'worker', 'test',
                       statement_timestamp() + interval '10 seconds',
                       statement_timestamp() + interval '1 minute')`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "seedReleaseFence" });
      await expectConstraintFailure(database.migrator.query({
        text: `UPDATE lcm.fenced_leases SET released_at = statement_timestamp()
               WHERE project_id = $1 AND resource_key = 'release-check'`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "rejectReleaseBeforeRenewal" }));
    });
  });

  it("does not reuse fencing tokens when released or expired lease rows are cleaned up", async () => {
    await withPostgreSqlTestDatabase("schema-fencing-allocation", async (database) => {
      const scope = await seedScope(database.migrator);
      const acquire = async (operation: string): Promise<bigint> => {
        const result = await database.migrator.query<{ fencing_token: string }>({
          text: `INSERT INTO lcm.fenced_leases
                   (project_id, resource_type, resource_key, owner_machine_id,
                    owner_process_id, operation, expires_at)
                 VALUES ($1, 'conversation', $2::text, $3, 'worker', $4,
                         statement_timestamp() + interval '1 minute')
                 RETURNING fencing_token::text`,
          values: [scope.projectId, scope.conversationId, scope.machineId, operation],
        }, { domain: "factory", operation });
        return BigInt(result.rows[0]?.fencing_token ?? "0");
      };

      const firstToken = await acquire("acquireFirstFence");
      await database.migrator.query({
        text: `UPDATE lcm.fenced_leases
               SET released_at = statement_timestamp()
               WHERE project_id = $1 AND resource_type = 'conversation' AND resource_key = $2::text`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "releaseFirstFence" });
      await database.migrator.query({
        text: `DELETE FROM lcm.fenced_leases
               WHERE project_id = $1 AND resource_type = 'conversation' AND resource_key = $2::text`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "cleanReleasedFence" });

      const secondToken = await acquire("acquireSecondFence");
      expect(secondToken).toBeGreaterThan(firstToken);
      await database.migrator.query({
        text: `UPDATE lcm.fenced_leases
               SET acquired_at = statement_timestamp() - interval '3 minutes',
                   renewed_at = statement_timestamp() - interval '2 minutes',
                   expires_at = statement_timestamp() - interval '1 minute'
               WHERE project_id = $1 AND resource_type = 'conversation' AND resource_key = $2::text`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "expireSecondFence" });
      await database.migrator.query({
        text: `DELETE FROM lcm.fenced_leases
               WHERE project_id = $1 AND resource_type = 'conversation' AND resource_key = $2::text`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "cleanExpiredFence" });

      const thirdToken = await acquire("acquireThirdFence");
      expect(thirdToken).toBeGreaterThan(secondToken);
    });
  });

  it("uses the intended FTS, trigram, inbox, and lease indexes", async () => {
    await withPostgreSqlTestDatabase("schema-plans", async (database) => {
      const scope = await seedScope(database.migrator);
      await database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               VALUES ($1, $2, 0, 'user', 'Café schema baseline', 3)`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedMessageQueryPlan" });
      await database.migrator.query({
        text: `INSERT INTO lcm.passive_event_inbox
                 (project_id, machine_id, event_id, event_version, machine_sequence, event_type, payload)
               VALUES ($1, $2, uuidv7(), 1, 0, 'message.created', '{}'::jsonb)`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "seedInboxQueryPlan" });
      await database.migrator.query({
        text: `INSERT INTO lcm.fenced_leases
                 (project_id, resource_type, resource_key, owner_machine_id, owner_process_id,
                  operation, expires_at)
               VALUES ($1, 'conversation', $2::text, $3, 'worker-1', 'compact',
                       statement_timestamp() + interval '1 minute')`,
        values: [scope.projectId, scope.conversationId, scope.machineId],
      }, { domain: "factory", operation: "seedLeaseQueryPlan" });
      await database.migrator.query({
        text: `INSERT INTO lcm.messages
                 (project_id, conversation_id, seq, role, content, token_count)
               SELECT $1, $2, generated.seq, 'user', 'ordinary filler content', 3
               FROM generate_series(1, 20000) AS generated(seq)`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedMessageCardinality" });
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memories(project_id,content)
               SELECT $1, 'tag plan filler ' || generated.seq::text
               FROM generate_series(0, 4000) AS generated(seq)`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedPromotedTagMemories" });
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memory_tags(project_id,memory_id,ordinal,tag)
               SELECT project_id, memory_id, 0,
                      CASE content
                        WHEN 'tag plan filler 0' THEN 'Café tag-only needle'
                        ELSE 'ordinary label'
                      END
               FROM lcm.promoted_memories
               WHERE project_id = $1`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedPromotedTagCardinality" });
      await database.migrator.query({
        text: `INSERT INTO lcm.passive_event_inbox
                 (project_id, machine_id, event_id, event_version, machine_sequence, event_type, payload)
               SELECT $1, $2, uuidv7(), 1, generated.seq, 'message.created', '{}'::jsonb
               FROM generate_series(1, 4000) AS generated(seq)`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "seedInboxCardinality" });
      await database.migrator.query({
        text: `INSERT INTO lcm.fenced_leases
                 (project_id, resource_type, resource_key, owner_machine_id, owner_process_id,
                  operation, acquired_at, renewed_at, expires_at)
               SELECT $1, 'fixture', generated.seq::text, $2, 'worker-1', 'compact',
                      statement_timestamp() - interval '2 hours',
                      statement_timestamp() - interval '2 hours',
                      statement_timestamp() - generated.seq * interval '1 second'
               FROM generate_series(1, 4000) AS generated(seq)`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "seedLeaseCardinality" });
      await database.migrator.query({
        text: `ANALYZE lcm.messages;
               ANALYZE lcm.promoted_memory_tags;
               ANALYZE lcm.passive_event_inbox;
               ANALYZE lcm.fenced_leases`,
      }, {
        domain: "factory",
        operation: "analyzeSchemaPlans",
      });
      await database.migrator.query({ text: "VACUUM (ANALYZE) lcm.messages" }, {
        domain: "factory",
        operation: "flushMessageGinPendingList",
      });
      await database.migrator.query({ text: "VACUUM (ANALYZE) lcm.promoted_memory_tags" }, {
        domain: "factory",
        operation: "flushPromotedTagGinPendingList",
      });

      const explain = async (text: string, values: unknown[]): Promise<string> => {
        const result = await database.migrator.query<{ "QUERY PLAN": unknown }>({ text, values }, {
          domain: "factory",
          operation: "explainSchemaQuery",
        });
        return JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
      };
      const fullTextPlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT message_id FROM lcm.messages
         WHERE search_document @@ websearch_to_tsquery('lcm.search_v1', $1)`,
        ["cafe"],
      );
      expect(fullTextPlan).toContain("messages_search_document_idx");

      const trigramPlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT message_id FROM lcm.messages
         WHERE lcm.normalize_search_text(content) % lcm.normalize_search_text($1)`,
        ["schema baseline"],
      );
      expect(trigramPlan).toContain("messages_content_trgm_idx");

      const tagFullTextPlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT memory_id FROM lcm.promoted_memory_tags
         WHERE search_document @@ websearch_to_tsquery('lcm.search_v1', $1)`,
        ["cafe"],
      );
      expect(tagFullTextPlan).toContain("promoted_memory_tags_search_document_idx");

      const tagTrigramPlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT memory_id FROM lcm.promoted_memory_tags
         WHERE lcm.normalize_search_text(tag) % lcm.normalize_search_text($1)`,
        ["tag-only needle"],
      );
      expect(tagTrigramPlan).toContain("promoted_memory_tags_tag_trgm_idx");

      const inboxPlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT inbox_id FROM lcm.passive_event_inbox
         WHERE project_id = $1 AND machine_id = $2 AND status IN ('pending', 'retry')
         ORDER BY machine_sequence, inbox_id LIMIT 10`,
        [scope.projectId, scope.machineId],
      );
      expect(inboxPlan).toContain("passive_event_inbox_ready_idx");

      const leasePlan = await explain(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT resource_key FROM lcm.fenced_leases
         WHERE released_at IS NULL AND expires_at <= statement_timestamp()
         ORDER BY expires_at LIMIT 10`,
        [],
      );
      expect(leasePlan).toContain("fenced_leases_expiry_idx");
    });
  });

  it("rejects invalid native, promoted, checkpoint, instruction, inbox, and lease rows", async () => {
    await withPostgreSqlTestDatabase("schema-invalid-matrix", async (database) => {
      const scope = await seedScope(database.migrator);
      const hashA = "a".repeat(64);
      const hashB = "b".repeat(64);
      await database.migrator.query({
        text: `INSERT INTO lcm.native_transcripts
          (project_id,machine_id,client_name,format_name,format_version,native_session_id,
           source_locator,source_ordinal,observed_at,scrubber_version,content_sha256,ingest_key,native_payload)
          VALUES ($1,$2,'codex','jsonl','1','s','/a',0,statement_timestamp(),'1',$3,$4,'{}')`,
        values: [scope.projectId, scope.machineId, hashA, hashB],
      }, { domain: "factory", operation: "seedNativeMatrix" });
      const memory = await database.migrator.query<{ memory_id: string }>({
        text: "INSERT INTO lcm.promoted_memories(project_id,content) VALUES($1,'memory') RETURNING memory_id",
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedMemoryMatrix" });
      await expect(database.migrator.query<{ normalized_tag: string }>({
        text: `INSERT INTO lcm.promoted_memory_tags(project_id,memory_id,ordinal,tag)
               VALUES($1,$2,0,'ÄBC')
               RETURNING normalized_tag`,
        values: [scope.projectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "verifyBuiltinTagNormalization" }))
        .resolves.toMatchObject({ rows: [{ normalized_tag: "äbc" }] });
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memory_tags(project_id,memory_id,ordinal,tag)
               VALUES
                 ($1,$2,1,'Foo'),
                 ($1,$2,2,'foo'),
                 ($1,$2,3,''),
                 ($1,$2,4,' spaced '),
                 ($1,$2,5,'Foo')`,
        values: [scope.projectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "seedExactPromotedTags" });
      await expect(database.migrator.query<{
        exact_foo_count: string;
        exact_lower_count: string;
        tags: string[];
      }>({
        text: `SELECT array_agg(tag ORDER BY ordinal) AS tags,
                      count(*) FILTER (WHERE tag = 'Foo')::text AS exact_foo_count,
                      count(*) FILTER (WHERE tag = 'foo')::text AS exact_lower_count
               FROM lcm.promoted_memory_tags
               WHERE project_id = $1 AND memory_id = $2`,
        values: [scope.projectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "verifyExactPromotedTags" }))
        .resolves.toMatchObject({
          rows: [{
            exact_foo_count: "2",
            exact_lower_count: "1",
            tags: ["ÄBC", "Foo", "foo", "", " spaced ", "Foo"],
          }],
        });
      await database.migrator.query({
        text: `INSERT INTO lcm.session_instructions(project_id,slot,content,content_hash)
               VALUES($1,1,'instructions','hash-1')`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedInstructionMatrix" });
      await expect(database.migrator.query<{ content_hash: string }>({
        text: `SELECT content_hash FROM lcm.session_instructions
               WHERE project_id = $1 AND slot = 1`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "readInstructionContractHash" }))
        .resolves.toMatchObject({ rows: [{ content_hash: "hash-1" }] });
      const eventId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
      await database.migrator.query({
        text: `INSERT INTO lcm.passive_event_inbox
          (project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload)
          VALUES($1,$2,$3,1,0,'event','{}')`,
        values: [scope.projectId, scope.machineId, eventId],
      }, { domain: "factory", operation: "seedInboxMatrix" });
      const localMessage = await database.migrator.query<{ message_id: string }>({
        text: "INSERT INTO lcm.messages(project_id,conversation_id,seq,role,content,token_count) VALUES($1,$2,0,'user','local',1) RETURNING message_id",
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedLocalPolicyMessage" });
      const remoteMessage = await database.migrator.query<{ message_id: string }>({
        text: "INSERT INTO lcm.messages(project_id,conversation_id,seq,role,content,token_count) VALUES($1,$2,0,'user','remote',1) RETURNING message_id",
        values: [scope.otherProjectId, scope.otherConversationId],
      }, { domain: "factory", operation: "seedRemotePolicyMessage" });
      const localSummary = await database.migrator.query<{ summary_id: string }>({
        text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count) VALUES($1,$2,'leaf','local',1) RETURNING summary_id",
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "seedLocalPolicySummary" });
      const remoteSummary = await database.migrator.query<{ summary_id: string }>({
        text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count) VALUES($1,$2,'leaf','remote',1) RETURNING summary_id",
        values: [scope.otherProjectId, scope.otherConversationId],
      }, { domain: "factory", operation: "seedRemotePolicySummary" });
      const remoteFile = await database.migrator.query<{ file_id: string }>({
        text: "INSERT INTO lcm.large_files(project_id,conversation_id,storage_uri) VALUES($1,$2,'file:///remote') RETURNING file_id",
        values: [scope.otherProjectId, scope.otherConversationId],
      }, { domain: "factory", operation: "seedRemotePolicyFile" });
      const crossConversation = await database.migrator.query<{ conversation_id: string }>({
        text: `INSERT INTO lcm.conversations(project_id,session_id,title)
               VALUES($1,'cross-file-session','cross-file') RETURNING conversation_id`,
        values: [scope.projectId],
      }, { domain: "factory", operation: "seedCrossFileConversation" });
      const crossConversationFileId = "file_aaaaaaaaaaaaaaaa";
      await database.migrator.query({
        text: `INSERT INTO lcm.large_files(file_id,project_id,conversation_id,storage_uri)
               VALUES($1,$2,$3,'file:///cross-conversation')`,
        values: [crossConversationFileId, scope.projectId, crossConversation.rows[0]?.conversation_id],
      }, { domain: "factory", operation: "seedCrossConversationFile" });
      const unresolvedFileId = "file_bbbbbbbbbbbbbbbb";
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_large_files
                 (project_id,conversation_id,summary_id,file_id,ordinal)
               VALUES
                 ($1,$2,$3,$4,0),
                 ($1,$2,$3,$4,1),
                 ($1,$2,$3,$5,2)`,
        values: [
          scope.projectId,
          scope.conversationId,
          localSummary.rows[0]?.summary_id,
          crossConversationFileId,
          unresolvedFileId,
        ],
      }, { domain: "factory", operation: "preserveOpaqueSummaryFileIds" });
      await expect(database.migrator.query<{ file_ids: string[] }>({
        text: `SELECT array_agg(file_id ORDER BY ordinal) AS file_ids
               FROM lcm.summary_large_files
               WHERE project_id=$1 AND summary_id=$2`,
        values: [scope.projectId, localSummary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "readOpaqueSummaryFileIds" }))
        .resolves.toMatchObject({
          rows: [{ file_ids: [crossConversationFileId, crossConversationFileId, unresolvedFileId] }],
        });
      const directlyDeletedFileId = "file_cccccccccccccccc";
      await database.migrator.query({
        text: `INSERT INTO lcm.large_files(file_id,project_id,conversation_id,storage_uri)
               VALUES($1,$2,$3,'file:///direct-delete')`,
        values: [
          directlyDeletedFileId,
          scope.projectId,
          scope.conversationId,
        ],
      }, { domain: "factory", operation: "seedDirectlyDeletedLargeFile" });
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_large_files
                 (project_id,conversation_id,summary_id,file_id,ordinal)
               VALUES($1,$2,$3,$4,3)`,
        values: [
          scope.projectId,
          scope.conversationId,
          localSummary.rows[0]?.summary_id,
          directlyDeletedFileId,
        ],
      }, { domain: "factory", operation: "referenceDirectlyDeletedLargeFile" });
      await database.migrator.query({
        text: `DELETE FROM lcm.large_files
               WHERE project_id=$1 AND conversation_id=$2 AND file_id=$3`,
        values: [scope.projectId, scope.conversationId, directlyDeletedFileId],
      }, { domain: "factory", operation: "deleteReferencedLargeFileDirectly" });
      await expect(database.migrator.query<{ retained: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1 FROM lcm.summary_large_files
                 WHERE project_id=$1 AND summary_id=$2 AND file_id=$3
               ) AS retained`,
        values: [
          scope.projectId,
          localSummary.rows[0]?.summary_id,
          directlyDeletedFileId,
        ],
      }, { domain: "factory", operation: "verifyOpaqueSummaryFileSurvivesDeletion" }))
        .resolves.toMatchObject({ rows: [{ retained: true }] });
      await expect(database.migrator.query<{
        earliest_only: boolean;
        latest_only: boolean;
      }>({
        text: `WITH earliest_only AS (
                 INSERT INTO lcm.summaries
                   (project_id,conversation_id,kind,content,token_count,earliest_at)
                 VALUES($1,$2,'leaf','earliest only',0,now())
                 RETURNING earliest_at IS NOT NULL AND latest_at IS NULL AS accepted
               ), latest_only AS (
                 INSERT INTO lcm.summaries
                   (project_id,conversation_id,kind,content,token_count,latest_at)
                 VALUES($1,$2,'leaf','latest only',0,now())
                 RETURNING earliest_at IS NULL AND latest_at IS NOT NULL AS accepted
               )
               SELECT earliest_only.accepted AS earliest_only,
                      latest_only.accepted AS latest_only
               FROM earliest_only, latest_only`,
        values: [scope.projectId, scope.conversationId],
      }, { domain: "factory", operation: "acceptOneSidedSummaryTimestamps" }))
        .resolves.toMatchObject({
          rows: [{ earliest_only: true, latest_only: true }],
        });
      await database.migrator.query({
        text: `INSERT INTO lcm.summaries
                 (summary_id, project_id, conversation_id, kind, content, token_count)
               VALUES
                 ('leaf-1', $1, $2, 'leaf', 'shared local ID', 1),
                 ('leaf-1', $3, $4, 'leaf', 'shared remote ID', 1)`,
        values: [
          scope.projectId,
          scope.conversationId,
          scope.otherProjectId,
          scope.otherConversationId,
        ],
      }, { domain: "factory", operation: "seedProjectScopedSummaryIds" });
      await database.migrator.query({
        text: `INSERT INTO lcm.large_files
                 (file_id, project_id, conversation_id, storage_uri)
               VALUES
                 ('file-1', $1, $2, 'file:///shared-local'),
                 ('file-1', $3, $4, 'file:///shared-remote')`,
        values: [
          scope.projectId,
          scope.conversationId,
          scope.otherProjectId,
          scope.otherConversationId,
        ],
      }, { domain: "factory", operation: "seedProjectScopedFileIds" });
      await expect(database.migrator.query<{ file_count: string; summary_count: string }>({
        text: `SELECT
                 (SELECT count(*)::text FROM lcm.summaries
                  WHERE summary_id = 'leaf-1') AS summary_count,
                 (SELECT count(*)::text FROM lcm.large_files
                  WHERE file_id = 'file-1') AS file_count`,
      }, { domain: "factory", operation: "verifyProjectScopedCallerIds" }))
        .resolves.toMatchObject({
          rows: [{ file_count: "2", summary_count: "2" }],
        });
      await database.migrator.query({
        text: `INSERT INTO lcm.recall_surfacing(project_id,memory_id,session_id)
               VALUES
                 ($1,'id-1','session-a'),
                 ($1,'id-x',NULL),
                 ($2,$3,'cross-project-source')`,
        values: [scope.projectId, scope.otherProjectId, memory.rows[0]?.memory_id],
      }, { domain: "factory", operation: "preserveOpaqueRecallIds" });
      await expect(database.migrator.query<{
        memory_ids: string[];
        null_session_count: string;
      }>({
        text: `SELECT array_agg(memory_id ORDER BY surfacing_id) AS memory_ids,
                      count(*) FILTER (WHERE session_id IS NULL)::text AS null_session_count
               FROM lcm.recall_surfacing`,
      }, { domain: "factory", operation: "readOpaqueRecallIds" }))
        .resolves.toMatchObject({
          rows: [{
            memory_ids: ["id-1", "id-x", memory.rows[0]?.memory_id],
            null_session_count: "1",
          }],
        });
      const externalProvenance = await database.migrator.query<{
        source_project_id: string;
        source_summary_id: string;
      }>({
        text: `INSERT INTO lcm.promoted_memories
                 (project_id, content, source_project_id, source_summary_id)
               VALUES ($1, 'cross-project provenance', 'external-project', $2)
               RETURNING source_project_id, source_summary_id`,
        values: [scope.projectId, remoteSummary.rows[0]?.summary_id],
      }, { domain: "factory", operation: "preserveCrossProjectProvenance" });
      expect(externalProvenance.rows).toEqual([{
        source_project_id: "external-project",
        source_summary_id: remoteSummary.rows[0]?.summary_id,
      }]);
      await expect(database.migrator.query<{
        claimed_by: string;
        immediate_attempt: boolean;
        immediate_claim: boolean;
      }>({
        text: `INSERT INTO lcm.passive_event_inbox
                 (project_id, machine_id, event_id, event_version, machine_sequence,
                  event_type, payload, status, received_at, next_attempt_at, claimed_at, claimed_by)
               VALUES ($1, $2, uuidv7(), 1, 12, 'event', '{}'::jsonb, 'claimed',
                       statement_timestamp(), statement_timestamp(), statement_timestamp(), 'worker')
               RETURNING claimed_by,
                         next_attempt_at = received_at AS immediate_attempt,
                         claimed_at = received_at AS immediate_claim`,
        values: [scope.projectId, scope.machineId],
      }, { domain: "factory", operation: "acceptInboxTimestampBoundaries" }))
        .resolves.toMatchObject({
          rows: [{ claimed_by: "worker", immediate_attempt: true, immediate_claim: true }],
        });

      const invalidCases: Array<{ operation: string; text: string; values: unknown[] }> = [
        { operation: "summaryMessageCrossScope", text: "INSERT INTO lcm.summary_messages(project_id,conversation_id,summary_id,message_id,ordinal) VALUES($1,$2,$3,$4,0)", values: [scope.projectId, scope.conversationId, localSummary.rows[0]?.summary_id, remoteMessage.rows[0]?.message_id] },
        { operation: "summaryParentCrossScope", text: "INSERT INTO lcm.summary_parents(project_id,conversation_id,summary_id,parent_summary_id,ordinal) VALUES($1,$2,$3,$4,0)", values: [scope.projectId, scope.conversationId, localSummary.rows[0]?.summary_id, remoteSummary.rows[0]?.summary_id] },
        { operation: "contextMessageCrossScope", text: "INSERT INTO lcm.context_items(project_id,conversation_id,ordinal,item_type,message_id) VALUES($1,$2,0,'message',$3)", values: [scope.projectId, scope.conversationId, remoteMessage.rows[0]?.message_id] },
        { operation: "summaryFileOwnerCrossScope", text: "INSERT INTO lcm.summary_large_files(project_id,conversation_id,summary_id,file_id,ordinal) VALUES($1,$2,$3,$4,3)", values: [scope.projectId, crossConversation.rows[0]?.conversation_id, localSummary.rows[0]?.summary_id, remoteFile.rows[0]?.file_id] },
        { operation: "transcriptProvenanceCrossScope", text: "INSERT INTO lcm.transcript_messages(project_id,transcript_id,conversation_id,message_id,source_ordinal) SELECT $1,transcript_id,$2,$3,0 FROM lcm.native_transcripts WHERE project_id=$1 LIMIT 1", values: [scope.projectId, scope.conversationId, remoteMessage.rows[0]?.message_id] },
        { operation: "messagePartNaNCost", text: "INSERT INTO lcm.message_parts(project_id,conversation_id,message_id,session_id,part_type,ordinal,step_cost) VALUES($1,$2,$3,'s','step_start',0,'NaN'::double precision)", values: [scope.projectId, scope.conversationId, localMessage.rows[0]?.message_id] },
        { operation: "messagePartPositiveInfinityCost", text: "INSERT INTO lcm.message_parts(project_id,conversation_id,message_id,session_id,part_type,ordinal,step_cost) VALUES($1,$2,$3,'s','step_start',0,'Infinity'::double precision)", values: [scope.projectId, scope.conversationId, localMessage.rows[0]?.message_id] },
        { operation: "messagePartNegativeInfinityCost", text: "INSERT INTO lcm.message_parts(project_id,conversation_id,message_id,session_id,part_type,ordinal,step_cost) VALUES($1,$2,$3,'s','step_start',0,'-Infinity'::double precision)", values: [scope.projectId, scope.conversationId, localMessage.rows[0]?.message_id] },
        { operation: "nativeDigest", text: `INSERT INTO lcm.native_transcripts(project_id,machine_id,client_name,format_name,format_version,native_session_id,source_locator,source_ordinal,observed_at,scrubber_version,content_sha256,ingest_key,native_payload) VALUES($1,$2,'c','f','1','s','/b',0,now(),'1','bad',$3,'{}')`, values: [scope.projectId, scope.machineId, hashA] },
        { operation: "nativePayload", text: `INSERT INTO lcm.native_transcripts(project_id,machine_id,client_name,format_name,format_version,native_session_id,source_locator,source_ordinal,observed_at,scrubber_version,content_sha256,ingest_key,native_payload) VALUES($1,$2,'c','f','1','s','/b',0,now(),'1',$3,$4,'1')`, values: [scope.projectId, scope.machineId, hashA, "c".repeat(64)] },
        { operation: "nativeTime", text: `INSERT INTO lcm.native_transcripts(project_id,machine_id,client_name,format_name,format_version,native_session_id,source_locator,source_ordinal,observed_at,ingested_at,scrubber_version,content_sha256,ingest_key,native_payload) VALUES($1,$2,'c','f','1','s','/b',0,now(),now()-interval '1 day','1',$3,$4,'{}')`, values: [scope.projectId, scope.machineId, hashA, "d".repeat(64)] },
        { operation: "nativeIdempotency", text: `INSERT INTO lcm.native_transcripts(project_id,machine_id,client_name,format_name,format_version,native_session_id,source_locator,source_ordinal,observed_at,scrubber_version,content_sha256,ingest_key,native_payload) VALUES($1,$2,'c','f','1','s','/duplicate',1,now(),'1',$3,$4,'{}')`, values: [scope.projectId, scope.machineId, hashA, hashB] },
        { operation: "promotedConfidence", text: "INSERT INTO lcm.promoted_memories(project_id,content,confidence) VALUES($1,'bad',1.1)", values: [scope.projectId] },
        { operation: "promotedMetadata", text: "INSERT INTO lcm.promoted_memories(project_id,content,metadata) VALUES($1,'bad','[]')", values: [scope.projectId] },
        { operation: "promotedArchiveTime", text: "INSERT INTO lcm.promoted_memories(project_id,content,created_at,archived_at) VALUES($1,'bad',now(),now()-interval '1 day')", values: [scope.projectId] },
        { operation: "promotedTagOrdinal", text: "INSERT INTO lcm.promoted_memory_tags(project_id,memory_id,ordinal,tag) VALUES($1,$2,-1,'bad')", values: [scope.projectId, memory.rows[0]?.memory_id] },
        { operation: "checkpointCount", text: "INSERT INTO lcm.ingest_checkpoints(project_id,machine_id,client_name,source_locator,imported_count) VALUES($1,$2,'c','/a',-1)", values: [scope.projectId, scope.machineId] },
        { operation: "checkpointPayload", text: "INSERT INTO lcm.ingest_checkpoints(project_id,machine_id,client_name,source_locator,checkpoint) VALUES($1,$2,'c','/a','[]')", values: [scope.projectId, scope.machineId] },
        { operation: "summaryKind", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count) VALUES($1,$2,'invalid','s',0)", values: [scope.projectId, scope.conversationId] },
        { operation: "summaryTimestampOrder", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count,earliest_at,latest_at) VALUES($1,$2,'leaf','s',0,now(),now()-interval '1 day')", values: [scope.projectId, scope.conversationId] },
        { operation: "summaryDepth", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count,depth) VALUES($1,$2,'leaf','s',0,-1)", values: [scope.projectId, scope.conversationId] },
        { operation: "summaryTokenCount", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count) VALUES($1,$2,'leaf','s',-1)", values: [scope.projectId, scope.conversationId] },
        { operation: "summaryDescendantCount", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count,descendant_count) VALUES($1,$2,'leaf','s',0,-1)", values: [scope.projectId, scope.conversationId] },
        { operation: "summaryDescendantTokens", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count,descendant_token_count) VALUES($1,$2,'leaf','s',0,-1)", values: [scope.projectId, scope.conversationId] },
        { operation: "summarySourceTokens", text: "INSERT INTO lcm.summaries(project_id,conversation_id,kind,content,token_count,source_message_token_count) VALUES($1,$2,'leaf','s',0,-1)", values: [scope.projectId, scope.conversationId] },
        { operation: "instructionUnique", text: "INSERT INTO lcm.session_instructions(project_id,slot,content,content_hash) VALUES($1,1,'duplicate',$2)", values: [scope.projectId, hashB] },
        { operation: "inboxStatus", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status) VALUES($1,$2,uuidv7(),1,1,'e','{}','unknown')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxStatusTime", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status) VALUES($1,$2,uuidv7(),1,1,'e','{}','claimed')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxAppliedEquivalence", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,applied_at) VALUES($1,$2,uuidv7(),1,3,'e','{}',now())", values: [scope.projectId, scope.machineId] },
        { operation: "inboxQuarantineEquivalence", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status,quarantined_at) VALUES($1,$2,uuidv7(),1,4,'e','{}','quarantined',now())", values: [scope.projectId, scope.machineId] },
        { operation: "inboxEmptyQuarantineReason", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status,quarantined_at,quarantine_reason) VALUES($1,$2,uuidv7(),1,13,'e','{}','quarantined',now(),'')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxWhitespaceQuarantineReason", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status,quarantined_at,quarantine_reason) VALUES($1,$2,uuidv7(),1,14,'e','{}','quarantined',now(),'   ')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxClaimPair", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,claimed_by) VALUES($1,$2,uuidv7(),1,5,'e','{}','worker')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxTimestampOrder", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status,applied_at) VALUES($1,$2,uuidv7(),1,6,'e','{}','applied',now()-interval '1 day')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxRetryBeforeReceipt", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,received_at,next_attempt_at) VALUES($1,$2,uuidv7(),1,10,'e','{}',now(),now()-interval '1 second')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxBlankClaimOwner", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload,status,claimed_at,claimed_by) VALUES($1,$2,uuidv7(),1,11,'e','{}','claimed',now(),'   ')", values: [scope.projectId, scope.machineId] },
        { operation: "inboxEventUnique", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload) VALUES($1,$2,$3,1,2,'e','{}')", values: [scope.projectId, scope.machineId, eventId] },
        { operation: "inboxSequenceUnique", text: "INSERT INTO lcm.passive_event_inbox(project_id,machine_id,event_id,event_version,machine_sequence,event_type,payload) VALUES($1,$2,uuidv7(),1,0,'e','{}')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseToken", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,fencing_token,expires_at) OVERRIDING SYSTEM VALUE VALUES($1,'r','k',$2,'p','o',0,now()+interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseExpiry", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,expires_at) VALUES($1,'r','k',$2,'p','o',now()-interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseResourceType", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,expires_at) VALUES($1,'','k',$2,'p','o',now()+interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseResourceKey", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,expires_at) VALUES($1,'r','',$2,'p','o',now()+interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseOwner", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,expires_at) VALUES($1,'r','k',$2,'','o',now()+interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "leaseOperation", text: "INSERT INTO lcm.fenced_leases(project_id,resource_type,resource_key,owner_machine_id,owner_process_id,operation,expires_at) VALUES($1,'r','k',$2,'p','',now()+interval '1 minute')", values: [scope.projectId, scope.machineId] },
        { operation: "redactionCategory", text: "INSERT INTO lcm.redaction_counters(project_id,category,count) VALUES($1,'invalid',0)", values: [scope.projectId] },
        { operation: "redactionCount", text: "INSERT INTO lcm.redaction_counters(project_id,category,count) VALUES($1,'global',-1)", values: [scope.projectId] },
      ];
      for (const invalid of invalidCases) {
        await expectConstraintFailure(database.migrator.query({ text: invalid.text, values: invalid.values }, {
          domain: "factory", operation: invalid.operation,
        }));
      }
    });
  });
});
