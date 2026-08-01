import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrationProjectPaths } from "../../src/storage/migration-manifest.js";
import {
  PostgreSqlMigrationAdapter,
  type PostgreSqlMigrationFence,
  type PostgreSqlMigrationIdentity,
} from "../../src/storage/postgresql/migration-adapter.js";
import { PostgreSqlWorkCoordinator } from "../../src/storage/postgresql/coordination.js";
import { loadPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import type { MigrationRow } from "../../src/storage/sqlite/migration-adapter.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const roots: string[] = [];
const targetHash = createHash("sha256").update("migration target").digest("hex");
const otherHash = createHash("sha256").update("migration other").digest("hex");
const createdAt = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function grantMigrationPrivileges(database: PostgreSqlTestDatabase): Promise<void> {
  const template = readFileSync(join(process.cwd(), "docs", "postgresql-data-migration-grants.sql"), "utf8");
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_data_migration_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "transaction",
    operation: "grantDataMigrationPrivileges",
  });
}

async function createMachine(database: PostgreSqlTestDatabase, label: string): Promise<string> {
  const result = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING machine_id`,
    values: [`machine:${createHash("sha256").update(label).digest("hex")}`, label],
  }, { domain: "identity", operation: "createMigrationMachine" });
  return result.rows[0]!.machine_id;
}

async function createProject(database: PostgreSqlTestDatabase, identityKey: string, label: string): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
    values: [identityKey, label],
  }, { domain: "identity", operation: "createMigrationProject" });
  return result.rows[0]!.project_id;
}

async function createIdentity(database: PostgreSqlTestDatabase) {
  const machineId = await createMachine(database, "Migration machine");
  const remoteProjectId = await createProject(database, targetHash, "Migration target");
  const otherProjectId = await createProject(database, otherHash, "Migration other");
  const aliases = ["/workspace/migration", "/workspace/migration-alias"];
  for (const path of aliases) {
    await database.migrator.query({
      text: `INSERT INTO lcm.project_aliases (project_id, machine_id, path, normalized_path)
             VALUES ($1, $2, $3, $3)`,
      values: [remoteProjectId, machineId, path],
    }, { domain: "identity", operation: "createMigrationAlias" });
  }
  const identity: PostgreSqlMigrationIdentity = {
    localProjectId: targetHash,
    remoteProjectId,
    machineId,
    aliases,
  };
  return { identity, otherProjectId };
}

async function acquireFence(database: PostgreSqlTestDatabase, identity: PostgreSqlMigrationIdentity): Promise<{ coordinator: PostgreSqlWorkCoordinator; fence: PostgreSqlMigrationFence }> {
  const coordinator = new PostgreSqlWorkCoordinator(database.runtime, identity.remoteProjectId, identity.machineId);
  const processId = "migration-integration-worker";
  const lease = await coordinator.acquireLease({
    resourceType: "storage-migration",
    resourceKey: "migration-integration-generation",
    processId,
    operation: "reversible-storage-migration",
    ttlMs: 60_000,
  });
  if (!lease) throw new Error("failed to acquire migration integration lease");
  return {
    coordinator,
    fence: {
      resourceType: lease.resourceType,
      resourceKey: lease.resourceKey,
      processId,
      operation: "reversible-storage-migration",
      fencingToken: lease.fencingToken,
    },
  };
}

function conversation(conversationId: number, title: string): MigrationRow {
  return {
    conversation_id: conversationId,
    session_id: `migration-session-${conversationId}`,
    title,
    bootstrapped_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("PostgreSQL 18 reversible data migration", () => {
  it("requires the dedicated reviewed grants without admitting identity or destructive privileges", async () => {
    await withPostgreSqlTestDatabase("migration-grants", async (database) => {
      const { identity } = await createIdentity(database);
      const adapter = new PostgreSqlMigrationAdapter(database.runtime, identity);
      await expect(adapter.destinationState()).rejects.toMatchObject({
        backend: "postgresql",
        domain: "transaction",
        operation: "migrationDestinationProject",
        projectId: identity.remoteProjectId,
      });

      await grantMigrationPrivileges(database);
      await expect(adapter.destinationState()).resolves.toMatchObject({ projectExists: true, stateRows: 0 });
      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        project_select: boolean;
        project_insert: boolean;
        conversation_select: boolean;
        conversation_insert: boolean;
        conversation_update: boolean;
        conversation_delete: boolean;
        conversation_truncate: boolean;
        sequence_select: boolean;
        sequence_update: boolean;
        native_select: boolean;
        native_insert: boolean;
        lease_select: boolean;
        lease_insert: boolean;
        lease_update: boolean;
        lease_delete: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'USAGE') AS schema_usage,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'SELECT') AS project_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'INSERT') AS project_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'SELECT') AS conversation_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'INSERT') AS conversation_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'UPDATE') AS conversation_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'DELETE') AS conversation_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'TRUNCATE') AS conversation_truncate,
                 has_sequence_privilege('lcm_test_runtime', 'lcm.conversations_conversation_id_seq', 'SELECT') AS sequence_select,
                 has_sequence_privilege('lcm_test_runtime', 'lcm.conversations_conversation_id_seq', 'UPDATE') AS sequence_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.native_transcripts', 'SELECT') AS native_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.native_transcripts', 'INSERT') AS native_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.fenced_leases', 'SELECT') AS lease_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.fenced_leases', 'INSERT') AS lease_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.fenced_leases', 'UPDATE') AS lease_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.fenced_leases', 'DELETE') AS lease_delete`,
      }, { domain: "transaction", operation: "inspectDataMigrationPrivileges" });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        project_select: true,
        project_insert: false,
        conversation_select: true,
        conversation_insert: true,
        conversation_update: false,
        conversation_delete: false,
        conversation_truncate: false,
        sequence_select: true,
        sequence_update: true,
        native_select: true,
        native_insert: false,
        lease_select: true,
        lease_insert: true,
        lease_update: true,
        lease_delete: true,
      });
    });
  });

  it("copies exact stable IDs, converges reruns, preserves other projects, and advances shared sequences monotonically", async () => {
    await withPostgreSqlTestDatabase("migration-copy", async (database) => {
      await grantMigrationPrivileges(database);
      const { identity, otherProjectId } = await createIdentity(database);
      await database.migrator.query({
        text: `INSERT INTO lcm.conversations
                 (conversation_id, project_id, session_id, title, created_at, updated_at)
               VALUES (9000, $1, 'other-session', 'other project', $2, $2)`,
        values: [otherProjectId, createdAt],
      }, { domain: "transaction", operation: "seedOtherMigrationProject" });
      await database.migrator.query({
        text: "SELECT pg_catalog.setval('lcm.conversations_conversation_id_seq'::pg_catalog.regclass, 9000, true)",
      }, { domain: "transaction", operation: "seedMigrationSequence" });

      const adapter = new PostgreSqlMigrationAdapter(database.runtime, identity);
      expect(await adapter.destinationState()).toMatchObject({ projectExists: true, stateRows: 0 });
      await expect(adapter.assertEmptyDestination()).resolves.toBeUndefined();
      await expect(adapter.verifyAliases()).resolves.toBeUndefined();
      expect(await adapter.schemaHistory()).toEqual(loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, sha256 })));

      const { coordinator, fence } = await acquireFence(database, identity);
      try {
        await expect(adapter.writeBatch("conversations", [conversation(42, "first")], fence)).resolves.toEqual({ rows: 1, uncertainCommitRecovered: false });
        await expect(adapter.writeBatch("conversations", [conversation(42, "first")], fence)).resolves.toEqual({ rows: 1, uncertainCommitRecovered: false });
        await expect(adapter.writeBatch("conversations", [conversation(42, "divergent")], fence)).rejects.toMatchObject({
          backend: "postgresql",
          domain: "transaction",
          operation: "migrationWriteBatch:conversations",
          projectId: identity.remoteProjectId,
        });
        await expect(adapter.writeBatch("conversations", [], fence)).resolves.toEqual({ rows: 0, uncertainCommitRecovered: false });
        await adapter.repairSharedSequences(fence);
        let sequence = await database.migrator.query<{ last_value: string }>({
          text: "SELECT last_value::text FROM lcm.conversations_conversation_id_seq",
        }, { domain: "transaction", operation: "readMigrationSequence" });
        expect(BigInt(sequence.rows[0]!.last_value)).toBeGreaterThanOrEqual(9000n);

        await adapter.writeBatch("conversations", [conversation(10_000, "largest")], fence);
        await adapter.repairSharedSequences(fence);
        sequence = await database.migrator.query<{ last_value: string }>({
          text: "SELECT last_value::text FROM lcm.conversations_conversation_id_seq",
        }, { domain: "transaction", operation: "readAdvancedMigrationSequence" });
        expect(BigInt(sequence.rows[0]!.last_value)).toBeGreaterThanOrEqual(10_000n);

        const inventory = await adapter.inventory();
        expect(inventory.find(({ table }) => table === "conversations")?.rows).toBe(2);
        expect(await adapter.sample("conversations", 1)).toEqual([conversation(42, "first")]);
        await expect(adapter.verifyRelationalIntegrity()).resolves.toBeUndefined();
        const other = await database.migrator.query<{ conversation_id: string; title: string }>({
          text: "SELECT conversation_id::text, title FROM lcm.conversations WHERE project_id = $1",
          values: [otherProjectId],
        }, { domain: "transaction", operation: "verifyOtherMigrationProject" });
        expect(other.rows).toEqual([{ conversation_id: "9000", title: "other project" }]);
      } finally {
        await coordinator.releaseLease(fence);
      }
    });
  });

  it("exports project-scoped operational sidecars as private deterministic JSONL", async () => {
    await withPostgreSqlTestDatabase("migration-sidecars", async (database) => {
      await grantMigrationPrivileges(database);
      const { identity } = await createIdentity(database);
      await database.migrator.query({
        text: `INSERT INTO lcm.native_transcripts (
                 project_id, machine_id, client_name, format_name, format_version,
                 native_session_id, source_locator, source_ordinal, observed_at,
                 scrubber_version, content_sha256, ingest_key, native_payload
               ) VALUES ($1, $2, 'codex', 'jsonl', '1', 'session', '/scrubbed/source', 0,
                         $3, '1', $4, $5, '{"scrubbed":true}'::jsonb)`,
        values: [identity.remoteProjectId, identity.machineId, "2020-01-01T00:00:00.000Z", "a".repeat(64), "b".repeat(64)],
      }, { domain: "transaction", operation: "seedMigrationTranscriptSidecar" });
      await database.migrator.query({
        text: `INSERT INTO lcm.passive_event_inbox
                 (project_id, machine_id, event_id, event_version, machine_sequence, event_type, payload)
               VALUES ($1, $2, uuidv7(), 1, 1, 'migration', '{"scrubbed":true}'::jsonb)`,
        values: [identity.remoteProjectId, identity.machineId],
      }, { domain: "transaction", operation: "seedMigrationEventSidecar" });
      await database.migrator.query({
        text: `INSERT INTO lcm.ingest_checkpoints
                 (project_id, machine_id, client_name, source_locator, checkpoint)
               VALUES ($1, $2, 'codex', '/scrubbed/source', '{"cursor":1}'::jsonb)`,
        values: [identity.remoteProjectId, identity.machineId],
      }, { domain: "transaction", operation: "seedMigrationCheckpointSidecar" });

      const root = mkdtempSync(join(tmpdir(), "lcm-pg-migration-sidecars-"));
      roots.push(root);
      chmodSync(root, 0o700);
      const paths = migrationProjectPaths("018f1234-5678-7abc-8def-0123456789ab", targetHash, root);
      const projectDirectory = paths.directory;
      const generationDirectory = join(root, ".lcm", "migrations", "018f1234-5678-7abc-8def-0123456789ab");
      const projectsDirectory = join(generationDirectory, "projects");
      for (const directory of [join(root, ".lcm"), join(root, ".lcm", "migrations"), generationDirectory, projectsDirectory, projectDirectory]) {
        await import("node:fs").then(({ mkdirSync }) => mkdirSync(directory, { recursive: true, mode: 0o700 }));
      }
      const adapter = new PostgreSqlMigrationAdapter(database.runtime, identity);
      const exported = await adapter.exportOperationalSidecars(paths);
      const repeated = await adapter.exportOperationalSidecars(paths);
      expect(repeated).toEqual(exported);
      for (const [name, path] of [
        ["native", paths.nativeTranscriptSidecar],
        ["passive", paths.passiveEventSidecar],
        ["checkpoint", paths.checkpointSidecar],
      ] as const) {
        const stat = statSync(path);
        expect(stat.mode & 0o777, name).toBe(0o600);
        expect(stat.nlink, name).toBe(1);
        const content = readFileSync(path, "utf8");
        expect(content, name).toContain("scrubbed");
        expect(content.endsWith("\n"), name).toBe(true);
      }
    });
  });
});
