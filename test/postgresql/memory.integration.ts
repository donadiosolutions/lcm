import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlCoordinationRepository,
  PostgreSqlPromotedMemoryRepository,
  PostgreSqlRecallRepository,
  PostgreSqlRedactionAdminRepository,
} from "../../src/storage/postgresql/memory-repositories.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import {
  POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE,
} from "../storage/postgresql-conformance-manifest.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantMemoryRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-memory-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "promoted-memory",
    operation: "grantMemoryRuntimePrivileges",
  });
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(label).digest("hex"), label],
  }, { domain: "identity", operation: "createMemoryTestProject" });
  return result.rows[0].project_id;
}

async function createMachine(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<string> {
  const result = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING machine_id`,
    values: [
      `machine:${createHash("sha256").update(label).digest("hex")}`,
      label,
    ],
  }, { domain: "identity", operation: "createMemoryTestMachine" });
  return result.rows[0].machine_id;
}

describe("PostgreSQL 18 memory and administration repositories", () => {
  it("requires and admits only the reviewed least-privilege grant shape", async () => {
    await withPostgreSqlTestDatabase("memory-grants", async (database) => {
      const projectId = await createProject(database, "Memory grants");
      const repository = new PostgreSqlPromotedMemoryRepository(
        database.runtime,
        projectId,
      );
      await expect(repository.insert({ content: "denied" }))
        .rejects.toMatchObject({
          backend: "postgresql",
          domain: "promoted-memory",
          operation: "insert",
          projectId,
        });

      await grantMemoryRuntimePrivileges(database);
      await expect(repository.insert({ content: "granted" }))
        .resolves.toMatch(/^[0-9a-f-]{36}$/u);

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        memories_select: boolean;
        memories_delete: boolean;
        memories_insert: boolean;
        memories_content_insert: boolean;
        memories_project_update: boolean;
        memories_truncate: boolean;
        tags_insert: boolean;
        recall_insert: boolean;
        recall_sequence_usage: boolean;
        recall_sequence_select: boolean;
        redaction_update: boolean;
        ingest_update: boolean;
        instructions_update: boolean;
        instructions_sequence_usage: boolean;
        instructions_sequence_select: boolean;
        conversations_select: boolean;
        normalize_execute: boolean;
        normalize_grant_option: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'USAGE'
                 ) AS schema_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'CREATE'
                 ) AS schema_create,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'SELECT'
                 ) AS memories_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'DELETE'
                 ) AS memories_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'INSERT'
                 ) AS memories_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories',
                   'content', 'INSERT'
                 ) AS memories_content_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories',
                   'project_id', 'UPDATE'
                 ) AS memories_project_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'TRUNCATE'
                 ) AS memories_truncate,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memory_tags',
                   'tag', 'INSERT'
                 ) AS tags_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.recall_surfacing',
                   'memory_id', 'INSERT'
                 ) AS recall_insert,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.recall_surfacing_surfacing_id_seq',
                   'USAGE'
                 ) AS recall_sequence_usage,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.recall_surfacing_surfacing_id_seq',
                   'SELECT'
                 ) AS recall_sequence_select,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.redaction_counters',
                   'count', 'UPDATE'
                 ) AS redaction_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.session_ingest_log',
                   'message_count', 'UPDATE'
                 ) AS ingest_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.session_instructions',
                   'content', 'UPDATE'
                 ) AS instructions_update,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.session_instructions_instruction_id_seq',
                   'USAGE'
                 ) AS instructions_sequence_usage,
                 has_sequence_privilege(
                   'lcm_test_runtime',
                   'lcm.session_instructions_instruction_id_seq',
                   'SELECT'
                 ) AS instructions_sequence_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.conversations', 'SELECT'
                 ) AS conversations_select,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'lcm.normalize_search_text(text)',
                   'EXECUTE'
                 ) AS normalize_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'lcm.normalize_search_text(text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.is_grantable
                 ) AS normalize_grant_option`,
      }, {
        domain: "promoted-memory",
        operation: "inspectMemoryRuntimePrivileges",
      });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        memories_select: true,
        memories_delete: true,
        memories_insert: false,
        memories_content_insert: true,
        memories_project_update: false,
        memories_truncate: false,
        tags_insert: true,
        recall_insert: true,
        recall_sequence_usage: true,
        recall_sequence_select: false,
        redaction_update: true,
        ingest_update: true,
        instructions_update: true,
        instructions_sequence_usage: true,
        instructions_sequence_select: false,
        conversations_select: false,
        normalize_execute: true,
        normalize_grant_option: false,
      });
      await expect(runPostgreSqlMigrations(database.migrator)).resolves
        .toMatchObject({ applied: [] });
    });
  });

  it("passes each staged backend-neutral repository contract", async () => {
    await withPostgreSqlTestDatabase("memory-conformance", async (database) => {
      await grantMemoryRuntimePrivileges(database);
      const machineId = await createMachine(database, "Memory conformance");
      const promotedProject = await createProject(database, "Promoted conformance");
      const recallProject = await createProject(database, "Recall conformance");
      const redactionProject = await createProject(database, "Redaction conformance");
      const coordinationProject = await createProject(
        database,
        "Coordination conformance",
      );

      const promotedRepository = new PostgreSqlPromotedMemoryRepository(
        database.runtime,
        promotedProject,
      );
      await POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.promotedMemory.exercise(
        promotedRepository,
      );
      const importedMemoryId = "550e8400-e29b-41d4-a716-446655440000";
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memories (
                 memory_id, project_id, content, source_summary_id,
                 source_project_id, metadata
               )
               VALUES ($1, $2, $3, $4, $5, $6::pg_catalog.jsonb)`,
        values: [
          importedMemoryId,
          promotedProject,
          "imported SQLite memory",
          "sqlite-summary",
          "sqlite-project",
          JSON.stringify({ imported: true }),
        ],
      }, {
        domain: "promoted-memory",
        operation: "seedImportedSqliteMemory",
      });
      await database.migrator.query({
        text: `INSERT INTO lcm.promoted_memory_tags (
                 project_id, memory_id, ordinal, tag
               )
               VALUES ($1, $2, 0, $3)`,
        values: [promotedProject, importedMemoryId, "sqlite-tag"],
      }, {
        domain: "promoted-memory",
        operation: "seedImportedSqliteMemoryTag",
      });
      expect(await promotedRepository.getById(importedMemoryId)).toMatchObject({
        id: importedMemoryId,
        tags: ["sqlite-tag"],
        metadata: { imported: true },
        sourceSummaryId: "sqlite-summary",
        projectId: "sqlite-project",
      });
      await promotedRepository.update(importedMemoryId, {
        tags: ["updated-import"],
        metadata: { imported: "updated" },
      });
      expect(await promotedRepository.getById(importedMemoryId)).toMatchObject({
        tags: ["updated-import"],
        metadata: { imported: "updated" },
      });
      await promotedRepository.deleteById(importedMemoryId);
      expect(await promotedRepository.getById(importedMemoryId)).toBeNull();
      await POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.recall.exercise(
        new PostgreSqlRecallRepository(database.runtime, recallProject),
      );
      await POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.redactionAdmin.exercise(
        new PostgreSqlRedactionAdminRepository(
          database.runtime,
          redactionProject,
        ),
      );
      await POSTGRESQL_PROJECT_REPOSITORY_CONFORMANCE.coordination.exercise(
        new PostgreSqlCoordinationRepository(
          database.runtime,
          coordinationProject,
          machineId,
        ),
      );
    });
  });

  it("preserves project isolation under concurrent counters, ingest, recall, and purge", async () => {
    await withPostgreSqlTestDatabase("memory-isolation", async (database) => {
      await grantMemoryRuntimePrivileges(database);
      const machineId = await createMachine(database, "Memory isolation");
      const firstProject = await createProject(database, "Memory project A");
      const secondProject = await createProject(database, "Memory project B");
      const firstPromoted = new PostgreSqlPromotedMemoryRepository(
        database.runtime,
        firstProject,
      );
      const secondPromoted = new PostgreSqlPromotedMemoryRepository(
        database.runtime,
        secondProject,
      );
      const firstRecall = new PostgreSqlRecallRepository(
        database.runtime,
        firstProject,
      );
      const firstRedaction = new PostgreSqlRedactionAdminRepository(
        database.runtime,
        firstProject,
      );
      const secondRedaction = new PostgreSqlRedactionAdminRepository(
        database.runtime,
        secondProject,
      );
      const firstCoordination = new PostgreSqlCoordinationRepository(
        database.runtime,
        firstProject,
        machineId,
      );
      const secondCoordination = new PostgreSqlCoordinationRepository(
        database.runtime,
        secondProject,
        machineId,
      );
      await database.migrator.query({
        text: `INSERT INTO lcm.conversations (
                 project_id, session_id, title
               )
               VALUES ($1, $2, $3)`,
        values: [firstProject, "retained-session", "retained conversation"],
      }, {
        domain: "conversations",
        operation: "seedRetainedConversation",
      });

      const firstMemoryId = await firstPromoted.insert({
        content: "first project memory",
        tags: ["one", "Mixed", "", " spaced ", "Mixed"],
        metadata: { provenance: { source: "project-a" } },
      });
      const secondMemoryId = await secondPromoted.insert({
        content: "second project memory",
        tags: ["second"],
        metadata: { provenance: { source: "project-b" } },
      });
      await firstPromoted.insert({
        content: "acted on first memory",
        tags: [
          "signal:memory_used",
          "memoryXid:not-an-exact-prefix",
          `memory_id:${firstMemoryId}`,
        ],
      });
      await firstRecall.logSurfacing(
        [firstMemoryId, firstMemoryId, firstMemoryId],
        "shared-session",
      );
      expect((await firstRecall.getFeedback([firstMemoryId]))
        .get(firstMemoryId)).toMatchObject({
          usageCount: 1,
          surfacingCount: 3,
        });
      expect(await firstRecall.getStats()).toMatchObject({
        memoriesSurfaced: 1,
        memoriesActedUpon: 1,
        recallPrecision: 100,
        topRecalled: [{
          id: firstMemoryId,
          content: "first project memory",
          actCount: 1,
        }],
      });

      await Promise.all(Array.from({ length: 20 }, () =>
        firstRedaction.upsertCounts({
          gitleaks: 1,
          builtIn: 1,
          global: 1,
          project: 1,
        })));
      expect(await firstRedaction.getCounts()).toEqual({
        gitleaks: 20,
        builtIn: 20,
        global: 20,
        project: 20,
        total: 80,
      });
      expect(await secondRedaction.getCounts()).toMatchObject({ total: 0 });

      await Promise.all(Array.from({ length: 20 }, () =>
        firstCoordination.recordSessionIngest("shared-session", 7)));
      expect(await firstCoordination.getSessionIngest("shared-session"))
        .toMatchObject({ messageCount: 7 });
      const ingestRows = await database.migrator.query<{ count: number }>({
        text: `SELECT pg_catalog.count(*)::pg_catalog.int4 AS count
               FROM lcm.session_ingest_log
               WHERE project_id = $1`,
        values: [firstProject],
      }, { domain: "coordination", operation: "countConcurrentIngestRows" });
      expect(ingestRows.rows[0].count).toBe(1);

      await firstCoordination.upsertSessionInstructions(2, "first", "hash-a");
      await secondCoordination.upsertSessionInstructions(2, "second", "hash-b");
      expect(await firstCoordination.getSessionInstructions(2))
        .toMatchObject({ content: "first" });
      expect(await secondCoordination.getSessionInstructions(2))
        .toMatchObject({ content: "second" });

      expect(await firstRedaction.purgeProjectState()).toEqual({
        promotedMemories: 2,
        promotedTags: 8,
        recallSurfacings: 3,
        redactionCounters: 4,
        sessionIngestLogs: 1,
        sessionInstructions: 1,
      });
      expect(await firstPromoted.getAll()).toEqual([]);
      expect(await firstRecall.getStats()).toMatchObject({
        memoriesSurfaced: 0,
        memoriesActedUpon: 0,
      });
      expect(await firstCoordination.getSessionIngest("shared-session"))
        .toBeNull();
      expect(await secondPromoted.getById(secondMemoryId)).toMatchObject({
        content: "second project memory",
        metadata: { provenance: { source: "project-b" } },
      });
      expect(await secondCoordination.getSessionInstructions(2))
        .toMatchObject({ content: "second" });
      const residuals = await database.migrator.query<{
        project_count: number;
        first_conversations: number;
        first_search_rows: number;
        second_search_rows: number;
      }>({
        text: `SELECT
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.projects
                   WHERE project_id = ANY ($1::pg_catalog.uuid[])
                 ) AS project_count,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.conversations
                   WHERE project_id = $2
                 ) AS first_conversations,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.promoted_memories
                   WHERE project_id = $2
                     AND search_document IS NOT NULL
                 ) AS first_search_rows,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.promoted_memories
                   WHERE project_id = $3
                     AND search_document IS NOT NULL
                 ) AS second_search_rows`,
        values: [
          [firstProject, secondProject],
          firstProject,
          secondProject,
        ],
      }, { domain: "redaction-admin", operation: "inspectPurgeResiduals" });
      expect(residuals.rows[0]).toEqual({
        project_count: 2,
        first_conversations: 1,
        first_search_rows: 0,
        second_search_rows: 1,
      });
    });
  });

  it("rolls back every earlier purge delete when a later table is denied", async () => {
    await withPostgreSqlTestDatabase("memory-purge-rollback", async (database) => {
      await grantMemoryRuntimePrivileges(database);
      const machineId = await createMachine(database, "Purge rollback");
      const projectId = await createProject(database, "Purge rollback");
      const promoted = new PostgreSqlPromotedMemoryRepository(
        database.runtime,
        projectId,
      );
      const recall = new PostgreSqlRecallRepository(database.runtime, projectId);
      const redaction = new PostgreSqlRedactionAdminRepository(
        database.runtime,
        projectId,
      );
      const coordination = new PostgreSqlCoordinationRepository(
        database.runtime,
        projectId,
        machineId,
      );
      const memoryId = await promoted.insert({
        content: "must survive",
        tags: ["survive"],
      });
      await recall.logSurfacing([memoryId], null);
      await redaction.upsertCounts({
        gitleaks: 1,
        builtIn: 0,
        global: 0,
        project: 0,
      });
      await coordination.recordSessionIngest("session", 1);
      await coordination.upsertSessionInstructions(1, "rules", "hash");
      await database.migrator.query({
        text: `REVOKE DELETE ON TABLE lcm.session_instructions
               FROM lcm_test_runtime`,
      }, {
        domain: "redaction-admin",
        operation: "denyLatePurgeDelete",
      });

      await expect(redaction.purgeProjectState()).rejects.toMatchObject({
        backend: "postgresql",
        domain: "redaction-admin",
        operation: "purgeProjectState",
        projectId,
      });
      const counts = await database.migrator.query<{
        memories: number;
        tags: number;
        recall: number;
        redaction: number;
        ingest: number;
        instructions: number;
      }>({
        text: `SELECT
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.promoted_memories WHERE project_id = $1
                 ) AS memories,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.promoted_memory_tags WHERE project_id = $1
                 ) AS tags,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.recall_surfacing WHERE project_id = $1
                 ) AS recall,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.redaction_counters WHERE project_id = $1
                 ) AS redaction,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.session_ingest_log WHERE project_id = $1
                 ) AS ingest,
                 (
                   SELECT pg_catalog.count(*)::pg_catalog.int4
                   FROM lcm.session_instructions WHERE project_id = $1
                 ) AS instructions`,
        values: [projectId],
      }, { domain: "redaction-admin", operation: "verifyPurgeRollback" });
      expect(counts.rows[0]).toEqual({
        memories: 1,
        tags: 1,
        recall: 1,
        redaction: 1,
        ingest: 1,
        instructions: 1,
      });
    });
  });
});
