import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";
import { backendDiagnosticFailure } from "../../src/storage/diagnostics.js";
import {
  PostgreSqlConversationRepository,
  QUERY_GET_MESSAGE_COUNT,
} from "../../src/storage/postgresql/conversation-repository.js";
import { PostgreSqlPromotedMemoryRepository } from "../../src/storage/postgresql/memory-repositories.js";
import {
  PostgreSqlContextRepository,
  PostgreSqlSummaryRepository,
} from "../../src/storage/postgresql/summary-context-repositories.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  createPostgreSqlQueryStatisticsCollector,
  type QueryStatisticsFamily,
} from "../../src/storage/postgresql/query-statistics.js";
import { QUERY_OPERATION_IDS } from "../../src/storage/postgresql/query-operations.js";
import {
  assertHarnessReady,
  settings,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const context = { domain: "factory", operation: "queryStatisticsFixture" } as const;

async function applyGrant(database: PostgreSqlTestDatabase, name: string): Promise<void> {
  const template = readFileSync(join(
    process.cwd(), "src/storage/postgresql/reference", name,
  ), "utf8");
  const sql = template.split("\n").filter(line => !line.startsWith("\\"))
    .join("\n").replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, context);
}

async function prepareRepositories(
  database: PostgreSqlTestDatabase,
  runtime: PostgreSqlRuntime = database.runtime,
) {
  for (const grant of [
    "postgresql-runtime-conversation-grants.sql",
    "postgresql-runtime-summary-context-grants.sql",
    "postgresql-runtime-memory-grants.sql",
  ]) await applyGrant(database, grant);
  const project = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, 'query statistics fixture') RETURNING project_id`,
    values: [createHash("sha256").update("query-statistics").digest("hex")],
  }, context);
  const projectId = project.rows[0].project_id;
  return {
    projectId,
    conversations: new PostgreSqlConversationRepository(runtime, projectId),
    summaries: new PostgreSqlSummaryRepository(runtime, projectId),
    context: new PostgreSqlContextRepository(runtime, projectId),
    promoted: new PostgreSqlPromotedMemoryRepository(runtime, projectId),
  };
}

function callCount(family: QueryStatisticsFamily, operation: string): number {
  return family.operations?.find(record => record.operation === operation)
    ?.values.queryCallsTotal ?? 0;
}

async function runtimeQueryIdentity(
  database: PostgreSqlTestDatabase,
): Promise<{ userid: string; dbid: string; queryid: string }> {
  const plan = await database.runtime.query<{ "QUERY PLAN": unknown }>({
    text: `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${QUERY_GET_MESSAGE_COUNT}`,
    types: { getTypeParser: () => (value: string) => value },
  }, context);
  const raw = plan.rows[0]?.["QUERY PLAN"];
  expect(raw).toBeTypeOf("string");
  const queryid = /"Query Identifier"\s*:\s*(-?[0-9]+)/u.exec(String(raw))?.[1];
  expect(queryid).toMatch(/^-?[0-9]+$/u);
  const result = await database.migrator.query<{ userid: string; dbid: string }>({
    text: `SELECT role.oid::pg_catalog.text AS userid,
                  database.oid::pg_catalog.text AS dbid
           FROM pg_catalog.pg_roles AS role
           CROSS JOIN pg_catalog.pg_database AS database
           WHERE role.rolname OPERATOR(pg_catalog.=) 'lcm_test_runtime'
             AND database.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`,
  }, context);
  expect(result.rows).toHaveLength(1);
  return { ...result.rows[0]!, queryid: queryid! };
}

async function resetRuntimeQuery(
  database: PostgreSqlTestDatabase,
  identity: { userid: string; dbid: string; queryid: string },
  minmaxOnly: boolean,
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    await administrator.query({
      text: `SELECT public.pg_stat_statements_reset(
               $1::pg_catalog.oid,
               $2::pg_catalog.oid,
               $3::pg_catalog.int8,
               $4::pg_catalog.bool
             )`,
      values: [identity.userid, identity.dbid, identity.queryid, minmaxOnly],
    }, context);
  } finally { await administrator.close(); }
}

async function administer(
  database: PostgreSqlTestDatabase,
  text: string,
): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try { await administrator.query({ text }, context); }
  finally { await administrator.close(); }
}

function encodedForms(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("hex"),
  ];
}

async function captureProcessStreams<T>(
  action: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const value = await action();
    return { value, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("PostgreSQL 18 query statistics", () => {
  it("maps every packaged template through real repository executions", async () => {
    await withPostgreSqlTestDatabase("query-statistics-map", async database => {
      const applicationName = "application-name-canary";
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      try {
        const repositories = await prepareRepositories(database, runtime);
        const conversation = await repositories.conversations.createConversation({
          sessionId: "session-parameter-canary",
        });
        const collector = createPostgreSqlQueryStatisticsCollector();
        const observe = async (): Promise<QueryStatisticsFamily> => {
          const result = await collector.collect(runtime, {
            publicationWitness: "integration-witness",
          });
          result.commit();
          return result.family;
        };
        let previous = await observe();
        const baselineDealloc = previous.statementsDeallocTotal;
        const drive = async (expected: readonly string[], action: () => Promise<unknown>) => {
          await action();
          const next = await observe();
          for (const operation of expected) {
            expect(callCount(next, operation), operation).toBeGreaterThan(
              callCount(previous, operation),
            );
          }
          previous = next;
        };

        await drive(["conversations.getConversationBySessionId"], () =>
          repositories.conversations.getConversationBySessionId("missing-session"));
        await drive([
          "conversations.lockConversationForAppend",
          "conversations.getMaxSeqForAppend",
        ], () => repositories.conversations.appendMessages(conversation.conversationId, [{
          role: "user", content: "message-literal-canary", tokenCount: 1,
        }]));
        await drive(["conversations.getMaxSeq"], () =>
          repositories.conversations.getMaxSeq(conversation.conversationId));
        await drive(["conversations.getMessages"], () =>
          repositories.conversations.getMessages(conversation.conversationId));
        await drive(["conversations.getMessages"], () =>
          repositories.conversations.getMessages(conversation.conversationId, { limit: 1 }));
        await drive(["conversations.getLastMessage"], () =>
          repositories.conversations.getLastMessage(conversation.conversationId));
        await drive(["conversations.getMessageCount"], () =>
          repositories.conversations.getMessageCount(conversation.conversationId));
        await drive(["conversations.markConversationBootstrapped"], () =>
          repositories.conversations.markConversationBootstrapped(conversation.conversationId));
        await drive(["conversations.listConversations"], () =>
          repositories.conversations.listConversations());
        await drive(["summaries.getSummary"], () =>
          repositories.summaries.getSummary("summary-parameter-canary"));
        await drive(["context.getContextItems"], () =>
          repositories.context.getContextItems(conversation.conversationId));
        await drive(["context.getContextTokenCount"], () =>
          repositories.context.getContextTokenCount(conversation.conversationId));
        await drive(["promoted-memory.getById"], () =>
          repositories.promoted.getById(randomUUID()));

        expect(previous.operations?.map(operation => operation.operation)).toEqual(QUERY_OPERATION_IDS);
        const withoutCalls = (previous.operations ?? [])
          .filter(operation => typeof operation.values.queryCallsTotal !== "number")
          .map(operation => ({
            operation: operation.operation,
            omitted: [...new Set(Object.values(operation.omitted))].sort(),
          }));
        // A missing counter is either a mapping gap or a pg_stat_statements entry
        // deallocated by cluster-wide pressure; report enough to tell them apart.
        expect(withoutCalls, JSON.stringify({
          status: previous.status,
          familyOmitted: previous.omitted,
          statementsDeallocTotal: previous.statementsDeallocTotal,
          statementsDeallocDelta: previous.statementsDeallocTotal === undefined
            || baselineDealloc === undefined
            ? undefined : previous.statementsDeallocTotal - baselineDealloc,
        })).toEqual([]);

        const sensitive = {
          summary: "summary-content-canary",
          memory: "memory-content-canary",
          tag: "tag-content-canary",
          prompt: "prompt-content-canary",
          inference: "inference-content-canary",
          projectPath: "/private/project-path-canary",
          clientKey: "-----BEGIN PRIVATE KEY-----client-key-canary",
          providerKeys: "sk-provider-canary sk-ant-provider-canary ghp_provider_canary",
          utilityLiteral: "utility-literal-canary",
        };
        const message = await database.migrator.query<{ message_id: string }>({
          text: `SELECT message_id::pg_catalog.text AS message_id
                 FROM lcm.messages
                 WHERE project_id OPERATOR(pg_catalog.=) $1::pg_catalog.uuid
                 ORDER BY message_id
                 LIMIT 1`,
          values: [repositories.projectId],
        }, context);
        await database.migrator.query({
          text: `INSERT INTO lcm.summaries
                   (summary_id, project_id, conversation_id, kind, content, token_count)
                 VALUES ($1, $2, $3, 'leaf', $4, 1)`,
          values: ["summary-parameter-canary", repositories.projectId,
            conversation.conversationId, sensitive.summary],
        }, context);
        const memory = await database.migrator.query<{ memory_id: string }>({
          text: `INSERT INTO lcm.promoted_memories (project_id, content, metadata)
                 VALUES ($1, $2, $3::pg_catalog.jsonb)
                 RETURNING memory_id`,
          values: [repositories.projectId, sensitive.memory, JSON.stringify({
            projectPath: sensitive.projectPath,
            clientKey: sensitive.clientKey,
            providerKeys: sensitive.providerKeys,
          })],
        }, context);
        await database.migrator.query({
          text: `INSERT INTO lcm.promoted_memory_tags
                   (project_id, memory_id, ordinal, tag)
                 VALUES ($1, $2, 0, $3)`,
          values: [repositories.projectId, memory.rows[0]!.memory_id, sensitive.tag],
        }, context);
        await database.migrator.query({
          text: `INSERT INTO lcm.message_parts
                   (project_id, conversation_id, message_id, session_id, part_type,
                    ordinal, text_content, subtask_prompt, tool_output, metadata)
                 VALUES ($1, $2, $3, $4, 'subtask', 0, $5, $6, $7, $8)`,
          values: [repositories.projectId, conversation.conversationId,
            message.rows[0]!.message_id, "session-parameter-canary",
            sensitive.inference, sensitive.prompt, sensitive.clientKey,
            sensitive.providerKeys],
        }, context);
        await runtime.query({
          text: `SET application_name = '${applicationName}'`,
        }, context);
        await runtime.query({
          text: `SET application_name = '${sensitive.utilityLiteral}'`,
        }, context);

        const home = mkdtempSync(join(tmpdir(), "lcm-query-statistics-doctor-"));
        mkdirSync(join(home, ".lcm"), { mode: 0o700 });
        writeFileSync(join(home, ".lcm", "config.json"), "{}", { mode: 0o600 });
        try {
          const captured = await captureProcessStreams(async () => {
            const started = performance.now();
            const measured = await collector.collect(runtime, {
              publicationWitness: "integration-witness",
            });
            const elapsed = performance.now() - started;
            expect(measured.family.status).toMatch(/^(observed|partial|reset)$/u);
            expect(elapsed).toBeLessThan(750);

            const snapshot = backendDiagnosticFailure(undefined, "postgresql");
            snapshot.classification = "healthy";
            snapshot.telemetry.statements = measured.family;
            const rendered = renderBackendDiagnostics(snapshot);
            const doctor = await runDoctor({
              homedir: home,
              cwd: home,
              fetch: vi.fn(),
              spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
              collectBackendSnapshot: vi.fn().mockResolvedValue(snapshot),
            });
            const doctorMessage = doctor.find(row => row.name === "query-statistics")!.message;
            return { measured, elapsed, rendered, doctorMessage };
          });
          const { measured, elapsed, rendered, doctorMessage } = captured.value;
          process.stdout.write(
            `QUERY_STATISTICS_ELAPSED_MS=${elapsed.toFixed(1)} `
            + `SNAPSHOT_SHARE_PERCENT=${(elapsed / 2000 * 100).toFixed(1)}\n`,
          );

          const connection = new URL(database.runtimeUrl);
          const caFile = settings(database.runtimeUrl).caFile;
          const canaries = [
            "message-literal-canary", "session-parameter-canary", "summary-parameter-canary",
            ...Object.values(sensitive), applicationName, database.name, "lcm_test_runtime",
            connection.hostname, connection.password, readFileSync(caFile, "utf8"),
          ];
          const surfaces = [JSON.stringify(measured.family), rendered, doctorMessage,
            captured.stdout, captured.stderr].join("\n");
          for (const canary of canaries) {
            for (const form of encodedForms(canary)) expect(surfaces).not.toContain(form);
          }
          expect(surfaces).not.toMatch(/queryid|Query Identifier/u);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      } finally {
        await runtime.close();
      }
    });
  });

  it("captures writes emitted while an observation is running", async () => {
    const canary = "stream-capture-canary";
    const captured = await captureProcessStreams(async () => {
      process.stdout.write(canary);
      process.stderr.write(canary);
      return true;
    });
    expect(captured).toEqual({ value: true, stdout: canary, stderr: canary });
  });

  it("reports a fresh database as observed with all operations no-entry", async () => {
    await withPostgreSqlTestDatabase("query-statistics-empty", async database => {
      await administer(database, `ALTER ROLE lcm_test_runtime IN DATABASE ${database.name}
        SET pg_stat_statements.track_planning = 'off'`);
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      try {
        await prepareRepositories(database, runtime);
        const observation = await createPostgreSqlQueryStatisticsCollector().collect(runtime, {
          publicationWitness: "empty-witness",
        });
        expect(observation.family.status).toBe("observed");
        expect(observation.family.operations).toHaveLength(QUERY_OPERATION_IDS.length);
        expect(observation.family.operations?.every(operation =>
          Object.values(operation.omitted).every(reason => reason === "no-entry"))).toBe(true);
      } finally { await runtime.close(); }
    });
  });

  it("keeps a forced mapping failure local and leaves the runtime connection usable", async () => {
    await withPostgreSqlTestDatabase("query-statistics-probe-failure", async database => {
      await prepareRepositories(database);
      await administer(database, "REVOKE SELECT ON lcm.summaries FROM lcm_test_runtime");
      const partial = await createPostgreSqlQueryStatisticsCollector().collect(database.runtime, {
        publicationWitness: "probe-failure-witness",
      });
      expect(partial.family.status).toBe("partial");
      await expect(database.runtime.query({ text: "SELECT 1 AS ok" }, context))
        .resolves.toMatchObject({ rows: [{ ok: 1 }] });
    });
  });

  it("classifies a revoked collector function as permission-denied only", async () => {
    await withPostgreSqlTestDatabase("query-statistics-permission", async database => {
      await prepareRepositories(database);
      await administer(
        database,
        "REVOKE EXECUTE ON FUNCTION public.pg_stat_statements(boolean) FROM PUBLIC",
      );
      const denied = await createPostgreSqlQueryStatisticsCollector().collect(database.runtime, {
        publicationWitness: "permission-witness",
      });
      expect(denied.family.status).toBe("permission-denied");
      await expect(database.runtime.query({ text: "SELECT 1 AS ok" }, context))
        .resolves.toMatchObject({ rows: [{ ok: 1 }] });
    });
  });

  it("reports targeted disappearance once and re-entry in a new epoch as reset", async () => {
    await withPostgreSqlTestDatabase("query-statistics-reset", async database => {
      const repositories = await prepareRepositories(database);
      const conversation = await repositories.conversations.createConversation({ sessionId: "reset-session" });
      await repositories.conversations.getMessageCount(conversation.conversationId);
      const collector = createPostgreSqlQueryStatisticsCollector();
      const first = await collector.collect(database.runtime, { publicationWitness: "reset-witness" });
      expect(first.family.status).toBe("observed");
      expect(first.commit()).toBe(true);
      const identity = await runtimeQueryIdentity(database);
      await resetRuntimeQuery(database, identity, false);
      const missing = await collector.collect(database.runtime, { publicationWitness: "reset-witness" });
      expect(missing.family.status).toBe("partial");
      expect(missing.commit()).toBe(true);
      await repositories.conversations.getMessageCount(conversation.conversationId);
      const reentered = await collector.collect(database.runtime, { publicationWitness: "reset-witness" });
      expect(reentered.family.status).toBe("reset");
    });
  });

  it("requires a post-minmax-reset execution before emitting extrema", async () => {
    await withPostgreSqlTestDatabase("query-statistics-minmax", async database => {
      const repositories = await prepareRepositories(database);
      const conversation = await repositories.conversations.createConversation({ sessionId: "minmax-session" });
      await repositories.conversations.getMessageCount(conversation.conversationId);
      const collector = createPostgreSqlQueryStatisticsCollector();
      const first = await collector.collect(database.runtime, { publicationWitness: "minmax-witness" });
      expect(first.commit()).toBe(true);
      const identity = await runtimeQueryIdentity(database);
      await resetRuntimeQuery(database, identity, true);
      const reset = await collector.collect(database.runtime, { publicationWitness: "minmax-witness" });
      const resetOperation = reset.family.operations?.find(operation =>
        operation.operation === "conversations.getMessageCount");
      expect(resetOperation?.omitted).toMatchObject({
        queryExecTimeMinMs: "no-baseline",
        queryExecTimeMaxMs: "no-baseline",
      });
      expect(reset.commit()).toBe(true);
      await repositories.conversations.getMessageCount(conversation.conversationId);
      const resumed = await collector.collect(database.runtime, { publicationWitness: "minmax-witness" });
      const resumedOperation = resumed.family.operations?.find(operation =>
        operation.operation === "conversations.getMessageCount");
      expect(resumedOperation?.values.queryExecTimeMinMs).toBeTypeOf("number");
      expect(resumedOperation?.values.queryExecTimeMaxMs).toBeTypeOf("number");
    });
  });

  it("observes planning and I/O timing fields with fresh role defaults", async () => {
    await withPostgreSqlTestDatabase("query-statistics-settings", async database => {
      await administer(database, `ALTER ROLE lcm_test_runtime IN DATABASE ${database.name}
        SET pg_stat_statements.track_planning = 'on'`);
      await administer(database, `ALTER ROLE lcm_test_runtime IN DATABASE ${database.name}
        SET track_io_timing = 'on'`);
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      try {
        const repositories = await prepareRepositories(database, runtime);
        const conversation = await repositories.conversations.createConversation({ sessionId: "settings-session" });
        await repositories.conversations.getMessageCount(conversation.conversationId);
        const observation = await createPostgreSqlQueryStatisticsCollector().collect(runtime, {
          publicationWitness: "settings-witness",
        });
        const operation = observation.family.operations?.find(record =>
          record.operation === "conversations.getMessageCount");
        expect(operation?.values.queryPlanTimeTotalMs).toBeTypeOf("number");
        expect(operation?.values.querySharedBlkReadTimeMs).toBeTypeOf("number");
        expect(operation?.values.querySharedBlkWriteTimeMs).toBeTypeOf("number");
      } finally { await runtime.close(); }
    });
  });

  it("uses a fresh runtime after disabling statement tracking", async () => {
    await withPostgreSqlTestDatabase("query-statistics-disabled", async database => {
      await administer(database, `ALTER ROLE lcm_test_runtime IN DATABASE ${database.name}
        SET pg_stat_statements.track = 'none'`);
      const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      try {
        const result = await createPostgreSqlQueryStatisticsCollector().collect(runtime, {
          publicationWitness: "disabled-witness",
        });
        expect(result.family.status).toBe("disabled");
      } finally { await runtime.close(); }
    });
  });
});
