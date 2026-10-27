import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDaemonConfig } from "../../src/daemon/config.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { backendDiagnosticFailure, collectBackendDiagnostics } from "../../src/storage/diagnostics.js";
import { readPostgreSqlDiagnosticMetrics } from "../../src/storage/postgresql/diagnostics.js";
import { readPostgreSqlMigrationLedger, readPostgreSqlQueueHealth } from "../../src/storage/postgresql/runtime-health.js";
import { migrationTelemetry, serverQueueReads } from "../../src/storage/runtime-health.js";
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


describe("PostgreSQL runtime health telemetry", () => {
  async function applyRuntimeGrants(database: Parameters<Parameters<typeof withPostgreSqlTestDatabase>[1]>[0]): Promise<void> {
    const context = { domain: "factory", operation: "runtimeHealthGrants" } as const;
    const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
    try {
      // The shipped grant scripts only: the runtime role gains nothing for this probe.
      for (const part of ["readiness", "identity", "conversation", "summary-context", "memory", "search", "coordination", "transcript"]) {
        const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference/postgresql-runtime-" + part + "-grants.sql"), "utf8")
          .split("\n").filter(line => !line.startsWith("\\")).join("\n")
          .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
        await administrator.query({ text: sql }, context);
      }
    } finally { await administrator.close(); }
  }

  it("observes the ledger, extensions, pool and queue with the unchanged restricted runtime and never writes", async () => {
    await withPostgreSqlTestDatabase("runtime-health", async (database) => {
      const context = { domain: "factory", operation: "runtimeHealthFixture" } as const;
      await applyRuntimeGrants(database);
      const migrator = database.migrator;
      const project = async (label: string): Promise<string> => (await migrator.query<{ project_id: string }>({
        text: "INSERT INTO lcm.projects (identity_key, display_name) VALUES ($1, $2) RETURNING project_id",
        values: [createHash("sha256").update(label).digest("hex"), label],
      }, context)).rows[0]!.project_id;
      const [projectA, projectB, projectC, projectH, projectD] = [await project("health-a"), await project("health-b"), await project("health-c"), await project("health-h"), await project("health-d")] as [string, string, string, string, string];
      const machineId = (await migrator.query<{ machine_id: string }>({
        text: "INSERT INTO lcm.machines (identity_key) VALUES ($1) RETURNING machine_id",
        values: ["machine:" + "c".repeat(64)],
      }, context)).rows[0]!.machine_id;
      let sequence = 0;
      const seed = async (projectId: string, status: string, count: number, columns: string, values: string): Promise<void> => {
        await migrator.query({
          text: "INSERT INTO lcm.passive_event_inbox (project_id, machine_id, event_id, event_version, machine_sequence, event_type, payload, status" + columns + ") " +
            "SELECT $1::pg_catalog.uuid, $2::pg_catalog.uuid, gen_random_uuid(), 1, $3::pg_catalog.int8 + g, 'private-event-type', '{\"private\":\"PRIVATE-PAYLOAD\"}'::jsonb, $4::pg_catalog.text" + values +
            " FROM generate_series(1, $5::pg_catalog.int4) AS g",
          values: [projectId, machineId, sequence, status, count],
        }, context);
        sequence += count;
      };
      await seed(projectA, "pending", 1, ", received_at, next_attempt_at", ", now() - interval '3 hours', now() - interval '2 hours'");
      await seed(projectA, "claimed", 1, ", received_at, claimed_at, claimed_by", ", now() - interval '1 hour', now(), 'private-worker'");
      await seed(projectA, "quarantined", 1, ", received_at, quarantined_at, quarantine_reason", ", now() - interval '1 hour', now(), 'private-reason'");
      await seed(projectB, "retry", 1, ", attempt_count, received_at, next_attempt_at", ", 1, now() - interval '1 hour', now() + interval '1 hour'");
      await seed(projectB, "quarantined", 2, ", received_at, quarantined_at, quarantine_reason", ", now() - interval '1 hour', now(), 'private-reason'");
      await seed(projectB, "applied", 1, ", received_at, applied_at", ", now() - interval '1 hour', now()");
      const state = async (): Promise<unknown> => (await migrator.query({
        text: "SELECT (SELECT pg_catalog.json_agg(counts ORDER BY status) FROM (SELECT status, pg_catalog.count(*) AS n FROM lcm.passive_event_inbox GROUP BY status) AS counts) AS inbox, (SELECT pg_catalog.json_agg(m ORDER BY id) FROM lcm.schema_migrations AS m) AS ledger",
      }, context)).rows;

      const signal = new AbortController().signal;
      const iterations = 5;
      const samples: Record<string, number[]> = {};
      // Repeats the work to report spread; the result of the last run is returned.
      const timed = async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
        let result: T | undefined;
        for (let run = 0; run < iterations; run += 1) {
          const started = performance.now();
          try { result = await work(); } finally { (samples[name] ??= []).push(performance.now() - started); }
        }
        return result as T;
      };
      const ledger = await timed("migrationProbeMs", () => readPostgreSqlMigrationLedger(database.runtime, signal));
      expect(migrationTelemetry(ledger, 1)).toMatchObject({ status: "observed", health: "healthy", historyStatus: "current", appliedCount: ledger.expected.length });
      const aggregate = await timed("queueProbeAggregateMs", () => readPostgreSqlQueueHealth(database.runtime, signal));
      expect(serverQueueReads(aggregate)).toMatchObject({ inboxClaimed: { value: 1 }, inboxQuarantined: { value: 3 } });
      expect((serverQueueReads(aggregate).replayLagSeconds as { value: number }).value).toBeGreaterThan(7000);
      const selectedA = await timed("queueProbeSelectedMs", () => readPostgreSqlQueueHealth(database.runtime, signal, projectA));
      expect(serverQueueReads(selectedA)).toMatchObject({ inboxClaimed: { value: 1 }, inboxQuarantined: { value: 1 } });
      expect((serverQueueReads(selectedA).replayLagSeconds as { value: number }).value).toBeGreaterThan(7000);
      expect(serverQueueReads(await readPostgreSqlQueueHealth(database.runtime, signal, projectB))).toEqual({
        inboxClaimed: { value: 0 }, inboxQuarantined: { value: 2 }, replayLagSeconds: { reason: "no-entry" },
      });

      const config = parseDaemonConfig("{}");
      config.storage = { backend: "postgresql", postgresql: { ...settings(database.runtimeUrl), migrationRole: "lcm_test_migrator" } };
      const observationFor = (projectId: string, hash: string) => ({
        config, witness: "stable-fixture", machineId: "019ce627-88da-7000-8000-000000000001",
        mapContent: JSON.stringify({ [hash]: { canonical: "/diagnostic-fixture", aliases: [], remoteProjectId: projectId } }),
      });
      const collect = (projectId: string, hash: string) => collectBackendDiagnostics({
        cwd: "/diagnostic-fixture", _dependencies: { observePublication: () => observationFor(projectId, hash) },
      });

      const healthy = await timed("healthySnapshotMs", () => collect(projectH, "e".repeat(64)));
      expect(healthy.classification).toBe("healthy");
      expect(healthy.telemetry.pool).toMatchObject({ status: "observed", health: "healthy" });
      expect(healthy.telemetry.migration).toMatchObject({ status: "observed", health: "healthy", historyStatus: "current" });
      expect(healthy.telemetry.extensions).toMatchObject({ status: "observed", health: "healthy" });
      expect((healthy.telemetry.extensions as { entries: Array<{ installedVersion: string }> }).entries.every(entry => /^[0-9]+(\.[0-9]+){0,2}$/u.test(entry.installedVersion))).toBe(true);
      expect(healthy.telemetry.queue).toMatchObject({ status: "observed", health: "healthy", inboxClaimed: 0, inboxQuarantined: 0 });

      const degraded = await collect(projectA, "a".repeat(64));
      expect(degraded.classification).toBe("degraded");
      expect(degraded.telemetry.queue).toMatchObject({ status: "observed", health: "degraded", inboxClaimed: 1, inboxQuarantined: 1 });
      expect(JSON.stringify(degraded)).not.toMatch(/PRIVATE|private-|machine:/u);
      const aggregateSnapshot = await collectBackendDiagnostics({ _dependencies: { observePublication: () => observationFor(projectA, "a".repeat(64)) } });
      expect(aggregateSnapshot.telemetry.queue).toMatchObject({ health: "degraded", inboxQuarantined: 3 });

      // A cap row count beyond the candidate limit hides exact totals instead of sampling them.
      await seed(projectC, "pending", 4100, ", received_at, next_attempt_at", ", now() - interval '3 hours', now() - interval '2 hours'");
      const capped = await timed("queueProbeCappedMs", () => readPostgreSqlQueueHealth(database.runtime, signal));
      expect(capped.capReached).toBe(true);
      const cappedSnapshot = await collectBackendDiagnostics({ _dependencies: { observePublication: () => observationFor(projectA, "a".repeat(64)) } });
      expect(cappedSnapshot.telemetry.queue).toMatchObject({ status: "partial", health: "unavailable" });
      expect(cappedSnapshot.telemetry.queue).not.toHaveProperty("inboxQuarantined");
      expect((await readPostgreSqlQueueHealth(database.runtime, signal, projectA)).capReached).toBe(false);

      // Applied history never consumes the candidate cap: it is seeded first, so it would fill the
      // first rows by inbox_id and hide the small active queue if it were not excluded by status.
      await seed(projectD, "applied", 4100, ", received_at, applied_at", ", now() - interval '1 hour', now()");
      await seed(projectD, "pending", 1, ", received_at, next_attempt_at", ", now() - interval '3 hours', now() - interval '2 hours'");
      await seed(projectD, "claimed", 1, ", received_at, claimed_at, claimed_by", ", now() - interval '1 hour', now(), 'private-worker'");
      await seed(projectD, "quarantined", 2, ", received_at, quarantined_at, quarantine_reason", ", now() - interval '1 hour', now(), 'private-reason'");
      const withHistory = await readPostgreSqlQueueHealth(database.runtime, signal, projectD);
      expect(withHistory.capReached).toBe(false);
      expect(serverQueueReads(withHistory)).toMatchObject({ inboxClaimed: { value: 1 }, inboxQuarantined: { value: 2 } });
      expect((serverQueueReads(withHistory).replayLagSeconds as { value: number }).value).toBeGreaterThan(7000);

      // Collection is read-only: ledger and inbox rows are unchanged by every read above and below.
      const beforeReads = await state();
      await collect(projectA, "a".repeat(64));
      await collectBackendDiagnostics({ _dependencies: { observePublication: () => observationFor(projectA, "a".repeat(64)) } });
      await readPostgreSqlQueueHealth(database.runtime, signal);
      await readPostgreSqlMigrationLedger(database.runtime, signal);
      expect(await state()).toEqual(beforeReads);

      // Ledger findings stay visible next to the existing readiness failure.
      const original = (await migrator.query<{ id: string; checksum_sha256: string }>({
        text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id DESC LIMIT 1",
      }, context)).rows[0]!;
      await migrator.query({ text: "UPDATE lcm.schema_migrations SET checksum_sha256 = pg_catalog.repeat('0', 64) WHERE id = $1", values: [original.id] }, context);
      const tampered = await collect(projectH, "e".repeat(64));
      expect(tampered.classification).toBe("unavailable");
      expect(tampered.telemetry.migration).toMatchObject({ health: "degraded", historyStatus: "checksum-mismatch" });
      await migrator.query({ text: "UPDATE lcm.schema_migrations SET checksum_sha256 = $2 WHERE id = $1", values: [original.id, original.checksum_sha256] }, context);
      await migrator.query({ text: "INSERT INTO lcm.schema_migrations (id, checksum_sha256) VALUES ('9999_future', pg_catalog.repeat('1', 64))" }, context);
      const ahead = await collect(projectH, "e".repeat(64));
      expect(ahead.telemetry.migration).toMatchObject({ status: "partial", health: "degraded", historyStatus: "ahead" });
      expect(ahead.telemetry.migration).not.toHaveProperty("appliedCount");
      await migrator.query({ text: "DELETE FROM lcm.schema_migrations WHERE id = '9999_future'" }, context);
      await migrator.query({ text: "DELETE FROM lcm.schema_migrations WHERE id = $1", values: [original.id] }, context);
      const behind = await collect(projectH, "e".repeat(64));
      expect(behind.telemetry.migration).toMatchObject({ status: "observed", health: "degraded", historyStatus: "behind" });
      await migrator.query({ text: "INSERT INTO lcm.schema_migrations (id, checksum_sha256) VALUES ($1, $2)", values: [original.id, original.checksum_sha256] }, context);

      // Denials are classified without text, and the runtime's grants are never widened.
      await migrator.query({ text: "REVOKE SELECT ON lcm.passive_event_inbox FROM lcm_test_runtime" }, context);
      const noQueue = await collect(projectH, "e".repeat(64));
      // Readiness covers the inbox grant, so the queue read is never launched and the family mirrors that failure.
      expect(noQueue.classification).toBe("unavailable");
      expect(noQueue.telemetry.queue).toMatchObject({ status: "unavailable", health: "unavailable" });
      expect(noQueue.telemetry.migration).toMatchObject({ status: "observed", health: "healthy" });
      expect(JSON.stringify(noQueue)).not.toMatch(/42501|lcm_test_runtime|passive_event_inbox/u);
      const deniedQueue = await readPostgreSqlQueueHealth(database.runtime, signal).catch((error: unknown) => error);
      expect(deniedQueue).toMatchObject({ sqlState: "42501" });
      expect(backendDiagnosticFailure(deniedQueue, "postgresql").classification).toBe("permission-denied");
      await migrator.query({ text: "GRANT SELECT ON lcm.passive_event_inbox TO lcm_test_runtime" }, context);
      await migrator.query({ text: "REVOKE SELECT ON lcm.projects FROM lcm_test_runtime" }, context);
      const failure = await timed("failureSnapshotMs", () => collect(projectH, "e".repeat(64)));
      expect(failure.classification).toBe("permission-denied");
      expect(failure.telemetry.migration).toMatchObject({ status: "observed" });
      expect(failure.telemetry.queue).toMatchObject({ status: "permission-denied", health: "unavailable" });
      await migrator.query({ text: "GRANT SELECT ON lcm.projects TO lcm_test_runtime" }, context);

      const rounded = (value: number): number => Math.round(value * 10) / 10;
      const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
        const sorted = [...values].sort((left, right) => left - right);
        return [name, { min: rounded(sorted[0]!), median: rounded(sorted[Math.floor(sorted.length / 2)]!), max: rounded(sorted[sorted.length - 1]!) }];
      }));
      process.stdout.write("LCM_638_RUNTIME_HEALTH_TIMINGS_MS " + JSON.stringify({ iterations, ...summary }) + "\n");
    });
  });
});
