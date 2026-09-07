import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDaemonConfig } from "../../src/daemon/config.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { backendDiagnosticFailure, collectBackendDiagnostics } from "../../src/storage/diagnostics.js";
import { readPostgreSqlDiagnosticMetrics } from "../../src/storage/postgresql/diagnostics.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);

describe("read-only PostgreSQL diagnostics", () => {
  it("aggregates admitted projects with SELECT-only privileges and preserves rows; revoked SELECT is permission-denied", async () => {
    await withPostgreSqlTestDatabase("diagnostics", async (database) => {
      const context = { domain: "factory", operation: "diagnosticFixture" } as const;
      const projectIds: string[] = [];
      for (const label of ["diagnostic-private-a", "diagnostic-private-b"]) {
        const project = await database.migrator.query<{ project_id: string }>({
          text: "INSERT INTO lcm.projects (identity_key, display_name) VALUES ($1, $2) RETURNING project_id",
          values: [createHash("sha256").update(label).digest("hex"), label],
        }, context);
        projectIds.push(project.rows[0].project_id);
        const conversation = await database.migrator.query<{ conversation_id: string }>({
          text: "INSERT INTO lcm.conversations (project_id, session_id) VALUES ($1, $2) RETURNING conversation_id",
          values: [project.rows[0].project_id, "private-session"],
        }, context);
        await database.migrator.query({
          text: "INSERT INTO lcm.messages (project_id, conversation_id, seq, role, content, token_count) VALUES ($1, $2, 0, 'user', 'PRIVATE-DIAGNOSTIC-CANARY', 100)",
          values: [project.rows[0].project_id, conversation.rows[0].conversation_id],
        }, context);
        await database.migrator.query({
          text: "INSERT INTO lcm.summaries (project_id, conversation_id, kind, depth, content, token_count) VALUES ($1, $2, 'leaf', 1, 'PRIVATE-SUMMARY-CANARY', 25)",
          values: [project.rows[0].project_id, conversation.rows[0].conversation_id],
        }, context);
        const memory = await database.migrator.query<{ memory_id: string }>({
          text: "INSERT INTO lcm.promoted_memories (project_id, content) VALUES ($1, 'PRIVATE-MEMORY-CANARY') RETURNING memory_id",
          values: [project.rows[0].project_id],
        }, context);
        await database.migrator.query({
          text: "INSERT INTO lcm.promoted_memory_tags (project_id, memory_id, ordinal, tag) VALUES ($1, $2, 0, 'signal:memory_used'), ($1, $2, 1, 'memory_id:shared-private-reference')",
          values: [project.rows[0].project_id, memory.rows[0].memory_id],
        }, context);
        await database.migrator.query({
          text: "INSERT INTO lcm.recall_surfacing (project_id, memory_id) VALUES ($1, 'shared-private-reference'), ($1, 'shared-private-reference')",
          values: [project.rows[0].project_id],
        }, context);
        await database.migrator.query({
          text: "INSERT INTO lcm.redaction_counters (project_id, category, count) VALUES ($1, 'built_in', 3)",
          values: [project.rows[0].project_id],
        }, context);
      }
      // Deliberately no writer or lease privileges: project-scoped runtime
      // metadata would enter writer admission and this probe would fail.
      await database.migrator.query({
        text: `GRANT SELECT ON lcm.projects, lcm.conversations, lcm.messages,
          lcm.summaries, lcm.promoted_memories, lcm.promoted_memory_tags,
          lcm.redaction_counters, lcm.recall_surfacing TO lcm_test_runtime`,
      }, context);
      const before = await database.migrator.query({
        text: "SELECT (SELECT pg_catalog.count(*) FROM lcm.projects) AS projects, (SELECT pg_catalog.count(*) FROM lcm.messages) AS messages",
      }, context);
      const all = await readPostgreSqlDiagnosticMetrics(database.runtime, new AbortController().signal);
      expect(all).toMatchObject({ projects: 2, conversations: 2, messages: 2, summaries: 2, rawTokens: 200, summaryTokens: 50, ratio: 4, promotedCount: 2, redactionCounts: { builtIn: 6 }, recallStats: { memoriesSurfaced: 2, memoriesActedUpon: 2, recallPrecision: 100 } });
      const selected = await readPostgreSqlDiagnosticMetrics(database.runtime, undefined, projectIds[0]);
      expect(selected).toMatchObject({ projects: 1, conversations: 1, messages: 1, summaries: 1, rawTokens: 100, summaryTokens: 25, promotedCount: 1, recallStats: { memoriesSurfaced: 1, memoriesActedUpon: 1, recallPrecision: 100 } });
      expect(JSON.stringify(all)).not.toMatch(/PRIVATE|private-session|diagnostic-private/u);
      const after = await database.migrator.query({
        text: "SELECT (SELECT pg_catalog.count(*) FROM lcm.projects) AS projects, (SELECT pg_catalog.count(*) FROM lcm.messages) AS messages",
      }, context);
      expect(after.rows).toEqual(before.rows);
      // The common collector uses real health, schema and metric probes. Only
      // local authenticated publication observation is injected for this DB fixture.
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        for (const part of ["readiness", "identity", "conversation", "summary-context", "memory", "search", "coordination", "transcript"]) {
          const sql = readFileSync(join(process.cwd(), `src/storage/postgresql/reference/postgresql-runtime-${part}-grants.sql`), "utf8")
            .split("\n").filter(line => !line.startsWith("\\")).join("\n")
            .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
          await administrator.query({ text: sql }, context);
        }
      } finally { await administrator.close(); }
      const config = parseDaemonConfig("{}");
      config.storage = { backend: "postgresql", postgresql: { ...settings(database.runtimeUrl), migrationRole: "lcm_test_migrator" } };
      const observation = { config, witness: "stable-fixture", machineId: "019ce627-88da-7000-8000-000000000001",
        mapContent: JSON.stringify({ ["a".repeat(64)]: { canonical: "/diagnostic-fixture", aliases: [], remoteProjectId: projectIds[0] } }),
      };
      const options = { cwd: "/diagnostic-fixture", _dependencies: { observePublication: () => observation } };
      const healthy = await collectBackendDiagnostics(options);
      expect(healthy).toMatchObject({ classification: "healthy", schema: "ready", metrics: { messages: 1 } });
      await database.migrator.query({ text: "REVOKE SELECT ON lcm.messages FROM lcm_test_runtime" }, context);
      const snapshot = await collectBackendDiagnostics(options);
      expect(snapshot.classification).toBe("permission-denied");
      expect(snapshot.metrics).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toMatch(/42501|lcm_test_runtime|lcm\.messages|PRIVATE/u);
      const denied = await readPostgreSqlDiagnosticMetrics(database.runtime).catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(PostgreSqlStorageOperationError);
      expect(denied).toMatchObject({ sqlState: "42501" });
      const classified = backendDiagnosticFailure(denied, "postgresql");
      expect(classified.classification).toBe("permission-denied");
      expect(JSON.stringify(classified)).not.toMatch(/42501|lcm_test_runtime|lcm\.messages|PRIVATE/u);
    });
  });
});
