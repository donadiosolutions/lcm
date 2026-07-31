import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryConfig, QueryResultRow } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlLexicalSearchRepository,
  type PostgreSqlLexicalSearchScopedExecutor,
} from "../../src/storage/postgresql/lexical-search-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  exerciseLexicalSearchRepositoryConformance,
  type LexicalSearchConformanceFixtures,
} from "../storage/lexical-search-conformance.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantSearchRuntimePrivileges(
  database: PostgreSqlTestDatabase,
  grantingRuntime: PostgreSqlRuntime = database.migrator
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-search-grants.sql"),
    "utf8"
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await grantingRuntime.query(
    { text: sql },
    {
      domain: "lexical-search",
      operation: "grantSearchRuntimePrivileges",
    }
  );
}

async function createProject(
  database: PostgreSqlTestDatabase,
  label: string
): Promise<string> {
  const result = await database.migrator.query<{ project_id: string }>(
    {
      text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
      values: [createHash("sha256").update(label).digest("hex"), label],
    },
    { domain: "identity", operation: "createSearchTestProject" }
  );
  return result.rows[0].project_id;
}

async function createConversation(
  database: PostgreSqlTestDatabase,
  projectId: string,
  sessionId: string
): Promise<number> {
  const result = await database.migrator.query<{
    conversation_id: string;
  }>(
    {
      text: `INSERT INTO lcm.conversations (
             project_id, session_id, title
           )
           VALUES ($1, $2, $3)
           RETURNING conversation_id::pg_catalog.text`,
      values: [projectId, sessionId, sessionId],
    },
    { domain: "conversations", operation: "seedSearchConversation" }
  );
  return Number(result.rows[0].conversation_id);
}

async function seedMessage(
  database: PostgreSqlTestDatabase,
  projectId: string,
  conversationId: number,
  input: {
    readonly seq: number;
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
  }
): Promise<{ readonly id: number; readonly createdAt: Date }> {
  const result = await database.migrator.query<{
    message_id: string;
    created_at: Date;
  }>(
    {
      text: `INSERT INTO lcm.messages (
             project_id, conversation_id, seq, role, content, token_count
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING message_id::pg_catalog.text, created_at`,
      values: [
        projectId,
        conversationId,
        input.seq,
        input.role,
        input.content,
        input.content.split(/\s+/u).length,
      ],
    },
    { domain: "conversations", operation: "seedSearchMessage" }
  );
  return {
    id: Number(result.rows[0].message_id),
    createdAt: result.rows[0].created_at,
  };
}

async function seedSummary(
  database: PostgreSqlTestDatabase,
  projectId: string,
  conversationId: number,
  input: {
    readonly id: string;
    readonly kind: "leaf" | "condensed";
    readonly content: string;
  }
): Promise<string> {
  await database.migrator.query(
    {
      text: `INSERT INTO lcm.summaries (
             summary_id, project_id, conversation_id, kind,
             depth, content, token_count
           )
           VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      values: [
        input.id,
        projectId,
        conversationId,
        input.kind,
        input.content,
        input.content.split(/\s+/u).length,
      ],
    },
    { domain: "summaries", operation: "seedSearchSummary" }
  );
  return input.id;
}

async function seedMemory(
  database: PostgreSqlTestDatabase,
  projectId: string,
  input: {
    readonly content: string;
    readonly tags: readonly string[];
    readonly sourceProjectId: string | null;
    readonly confidence: number;
  }
): Promise<string> {
  const inserted = await database.migrator.query<{ memory_id: string }>(
    {
      text: `INSERT INTO lcm.promoted_memories (
             project_id, content, source_project_id, confidence
           )
           VALUES ($1, $2, $3, $4)
           RETURNING memory_id`,
      values: [
        projectId,
        input.content,
        input.sourceProjectId,
        input.confidence,
      ],
    },
    { domain: "promoted-memory", operation: "seedSearchMemory" }
  );
  const memoryId = inserted.rows[0].memory_id;
  if (input.tags.length > 0) {
    await database.migrator.query(
      {
        text: `INSERT INTO lcm.promoted_memory_tags (
               project_id, memory_id, ordinal, tag
             )
             SELECT
               $1::pg_catalog.uuid,
               $2::pg_catalog.uuid,
               source.ordinality - 1,
               source.tag
             FROM pg_catalog.unnest($3::pg_catalog.text[])
               WITH ORDINALITY AS source(tag, ordinality)`,
        values: [projectId, memoryId, [...input.tags]],
      },
      { domain: "promoted-memory", operation: "seedSearchMemoryTags" }
    );
  }
  return memoryId;
}

async function seedConformanceFixtures(
  database: PostgreSqlTestDatabase,
  projectId: string
): Promise<LexicalSearchConformanceFixtures> {
  const primaryConversationId = await createConversation(
    database,
    projectId,
    "lexical-primary"
  );
  const secondaryConversationId = await createConversation(
    database,
    projectId,
    "lexical-secondary"
  );
  const accented = await seedMessage(
    database,
    projectId,
    primaryConversationId,
    {
      seq: 0,
      role: "user",
      content: "Café βeta foo_bar() C++ needle accented",
    }
  );
  const regex = await seedMessage(database, projectId, primaryConversationId, {
    seq: 1,
    role: "assistant",
    content: "punctuation [ok] needle-2046",
  });
  const isolated = await seedMessage(
    database,
    projectId,
    secondaryConversationId,
    {
      seq: 0,
      role: "tool",
      content: "isolated needle",
    }
  );
  const accentedSummary = await seedSummary(
    database,
    projectId,
    primaryConversationId,
    {
      id: "lexical-summary-accented",
      kind: "leaf",
      content: "Café summary needle",
    }
  );
  const regexSummary = await seedSummary(
    database,
    projectId,
    primaryConversationId,
    {
      id: "lexical-summary-regex",
      kind: "condensed",
      content: "punctuation summary-2047 needle",
    }
  );
  const isolatedSummary = await seedSummary(
    database,
    projectId,
    secondaryConversationId,
    {
      id: "lexical-summary-isolated",
      kind: "leaf",
      content: "isolated summary needle",
    }
  );
  const sourceProjectId = "source-project-a";
  const isolatedSourceProjectId = "source-project-b";
  const contentMemoryId = await seedMemory(database, projectId, {
    content: "primarydurable durable memory",
    tags: ["architecture"],
    sourceProjectId,
    confidence: 0.8,
  });
  const tagMemoryId = await seedMemory(database, projectId, {
    content: "unrelated recollection",
    tags: ["tagonly", "required"],
    sourceProjectId,
    confidence: 0.7,
  });
  const isolatedMemoryId = await seedMemory(database, projectId, {
    content: "isolateddurable durable memory",
    tags: ["isolated"],
    sourceProjectId: isolatedSourceProjectId,
    confidence: 0.6,
  });
  return {
    primaryConversationId,
    secondaryConversationId,
    messageIds: {
      accented: accented.id,
      regex: regex.id,
      isolated: isolated.id,
    },
    summaryIds: {
      accented: accentedSummary,
      regex: regexSummary,
      isolated: isolatedSummary,
    },
    memoryIds: {
      content: contentMemoryId,
      tagOnly: tagMemoryId,
      isolated: isolatedMemoryId,
    },
    sourceProjectId,
    isolatedSourceProjectId,
    searchTimestamp: accented.createdAt,
  };
}

function planText(value: unknown): string {
  return JSON.stringify(value);
}

type CapturedSearchQuery = {
  readonly text: string;
  readonly values: readonly unknown[];
};

function captureSearchQueryExecutor(
  executor: PostgreSqlQueryExecutor,
  captured: CapturedSearchQuery[]
): PostgreSqlQueryExecutor {
  return {
    async query<
      R extends QueryResultRow = QueryResultRow,
      I extends unknown[] = unknown[]
    >(config: QueryConfig<I>, options: PostgreSqlQueryOptions) {
      if (config.text.includes("FROM combined")) {
        captured.push({
          text: config.text,
          values: [...(config.values ?? [])],
        });
      }
      return executor.query<R, I>(config, options);
    },
  };
}

function captureSearchScopedExecutor(
  executor: PostgreSqlTransactionScopeExecutor,
  captured: CapturedSearchQuery[]
): PostgreSqlLexicalSearchScopedExecutor {
  const direct = captureSearchQueryExecutor(executor, captured);
  return {
    transactionScope: "active",
    query: direct.query,
    savepoint: (callback, options) =>
      executor.savepoint(
        (savepoint) =>
          callback(captureSearchQueryExecutor(savepoint, captured)),
        options
      ),
  };
}

function planNodes(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(planNodes)];
}

function fallbackRelationNodes(
  plan: unknown,
  relationName: string
): ReadonlyArray<Record<string, unknown>> {
  const fallbackPlans = planNodes(plan).filter(
    (node) => node["Subplan Name"] === "CTE fallback_rows"
  );
  expect(fallbackPlans).toHaveLength(1);
  const relationNodes = fallbackPlans
    .flatMap(planNodes)
    .filter((node) => node["Relation Name"] === relationName);
  expect(relationNodes.length).toBeGreaterThan(0);
  return relationNodes;
}

function expectFallbackRelationNeverExecuted(
  plan: unknown,
  relationName: string
): void {
  const relationNodes = fallbackRelationNodes(plan, relationName);
  expect(relationNodes.map((node) => node["Actual Loops"])).toEqual(
    relationNodes.map(() => 0)
  );
}

function expectFallbackRelationExecuted(
  plan: unknown,
  relationName: string
): void {
  const relationNodes = fallbackRelationNodes(plan, relationName);
  expect(
    relationNodes.some(
      (node) =>
        Number(node["Actual Loops"]) > 0 && Number(node["Actual Rows"]) > 0
    )
  ).toBe(true);
}

type SnapshotDomain = "messages" | "summaries" | "promoted";
type SnapshotScope = "root" | "caller";

type SnapshotResult = {
  readonly id: string | number;
  readonly rank: number;
  readonly snippet?: string;
};

const SNAPSHOT_BARRIER_KEYS: Readonly<Record<SnapshotDomain, string>> = {
  messages: "89001",
  summaries: "89002",
  promoted: "89003",
};

async function installSearchSnapshotBarriers(
  database: PostgreSqlTestDatabase
): Promise<void> {
  await database.migrator.query(
    {
      text: `CREATE FUNCTION lcm.test_search_snapshot_barrier(
               barrier_key pg_catalog.int8
             )
             RETURNS pg_catalog.bool
             LANGUAGE plpgsql
             VOLATILE
             PARALLEL UNSAFE
             SECURITY DEFINER
             SET search_path = pg_catalog
             AS $function$
             BEGIN
               PERFORM pg_catalog.pg_advisory_xact_lock(barrier_key);
               RETURN true;
             END
             $function$;
             REVOKE ALL
             ON FUNCTION lcm.test_search_snapshot_barrier(pg_catalog.int8)
             FROM PUBLIC;
             GRANT EXECUTE
             ON FUNCTION lcm.test_search_snapshot_barrier(pg_catalog.int8)
             TO lcm_test_runtime;

             ALTER TABLE lcm.messages ENABLE ROW LEVEL SECURITY;
             CREATE POLICY test_search_snapshot_messages
             ON lcm.messages
             FOR SELECT
             TO lcm_test_runtime
             USING (
               lcm.test_search_snapshot_barrier(
                 89001::pg_catalog.int8
               )
             );

             ALTER TABLE lcm.summaries ENABLE ROW LEVEL SECURITY;
             CREATE POLICY test_search_snapshot_summaries
             ON lcm.summaries
             FOR SELECT
             TO lcm_test_runtime
             USING (
               lcm.test_search_snapshot_barrier(
                 89002::pg_catalog.int8
               )
             );

             ALTER TABLE lcm.promoted_memories ENABLE ROW LEVEL SECURITY;
             CREATE POLICY test_search_snapshot_promoted
             ON lcm.promoted_memories
             FOR SELECT
             TO lcm_test_runtime
             USING (
               lcm.test_search_snapshot_barrier(
                 89003::pg_catalog.int8
               )
             )`,
    },
    {
      domain: "lexical-search",
      operation: "installSearchSnapshotBarriers",
    }
  );
  const installed = await database.migrator.query<{
    protected_tables: string;
    policies: string;
  }>(
    {
      text: `SELECT
               pg_catalog.count(*) FILTER (
                 WHERE table_state.relrowsecurity
               )::pg_catalog.text AS protected_tables,
               (
                 SELECT pg_catalog.count(*)::pg_catalog.text
                 FROM pg_catalog.pg_policy AS policy
                 WHERE policy.polname OPERATOR(pg_catalog.~~)
                   'test_search_snapshot_%'
               ) AS policies
             FROM pg_catalog.pg_class AS table_state
             INNER JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid OPERATOR(pg_catalog.=)
                 table_state.relnamespace
             WHERE namespace.nspname OPERATOR(pg_catalog.=) 'lcm'
               AND table_state.relname OPERATOR(pg_catalog.=)
                 ANY($1::pg_catalog.text[])`,
      values: [["messages", "summaries", "promoted_memories"]],
    },
    {
      domain: "lexical-search",
      operation: "verifySearchSnapshotBarriers",
    }
  );
  expect(installed.rows[0]).toEqual({
    protected_tables: "3",
    policies: "3",
  });
}

async function holdSearchSnapshotBarrier(
  database: PostgreSqlTestDatabase,
  barrierKey: string,
  holder: PostgreSqlRuntime = database.migrator
): Promise<{
  readonly backendPid: number;
  release(): Promise<void>;
}> {
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let backendPid!: number;
  const transaction = holder.transaction(async (scope) => {
    const acquired = await scope.query<{ backend_pid: number }>(
      {
        text: `SELECT
                 pg_catalog.pg_advisory_xact_lock(
                   $1::pg_catalog.int8
                 ),
                 pg_catalog.pg_backend_pid() AS backend_pid`,
        values: [barrierKey],
      },
      {
        domain: "lexical-search",
        operation: "holdSearchSnapshotBarrier",
      }
    );
    backendPid = acquired.rows[0].backend_pid;
    markHeld();
    await released;
  });
  await Promise.race([
    held,
    transaction.then(
      () => {
        throw new Error("search snapshot barrier exited before acquisition");
      },
      (error: unknown) => {
        throw error;
      }
    ),
  ]);
  return {
    backendPid,
    release: async () => {
      release();
      await transaction;
    },
  };
}

async function waitForSearchSnapshotWaiter(
  database: PostgreSqlTestDatabase
): Promise<void> {
  const observer = new PostgreSqlRuntime(settings(database.adminUrl));
  let observed: readonly {
    readonly waiter_pid: number;
    readonly blocking_pids: number[];
  }[] = [];
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await observer.query<{
        waiter_pid: number;
        blocking_pids: number[];
      }>(
        {
          text: `SELECT
                   activity.pid::pg_catalog.int4 AS waiter_pid,
                   pg_catalog.pg_blocking_pids(activity.pid)
                     AS blocking_pids
                 FROM pg_catalog.pg_stat_activity AS activity
                 INNER JOIN pg_catalog.pg_locks AS pending
                   ON pending.pid OPERATOR(pg_catalog.=) activity.pid
                  AND pending.locktype OPERATOR(pg_catalog.=) 'advisory'
                  AND NOT pending.granted
                 WHERE activity.datname OPERATOR(pg_catalog.=)
                     pg_catalog.current_database()
                   AND activity.usename OPERATOR(pg_catalog.=)
                     'lcm_test_runtime'
                   AND activity.state OPERATOR(pg_catalog.=) 'active'
                   AND activity.wait_event_type OPERATOR(pg_catalog.=) 'Lock'
                   AND activity.query OPERATOR(pg_catalog.~~)
                     'WITH input AS MATERIALIZED (%'
                 ORDER BY activity.pid`,
        },
        {
          domain: "lexical-search",
          operation: "waitForSearchSnapshotWaiter",
        }
      );
      observed = result.rows;
      if (
        observed.some(
          (row) =>
            row.waiter_pid > 0 &&
            new Set(row.blocking_pids).size === row.blocking_pids.length &&
            row.blocking_pids.length > 0
        )
      ) {
        return;
      }
    }
  } finally {
    await observer.close();
  }
  throw new Error(
    `expected a server-observed lexical-search advisory waiter; observed ${JSON.stringify(
      observed
    )}`
  );
}

async function searchSnapshotDomain(
  repository: PostgreSqlLexicalSearchRepository,
  domain: SnapshotDomain,
  conversationId: number,
  query: string
): Promise<SnapshotResult[]> {
  if (domain === "messages") {
    return (
      await repository.searchMessages({
        query,
        mode: "full_text",
        conversationId,
        limit: 10,
      })
    ).map((row) => ({
      id: row.messageId,
      rank: row.rank,
      snippet: row.snippet,
    }));
  }
  if (domain === "summaries") {
    return (
      await repository.searchSummaries({
        query,
        mode: "full_text",
        conversationId,
        limit: 10,
      })
    ).map((row) => ({
      id: row.summaryId,
      rank: row.rank,
      snippet: row.snippet,
    }));
  }
  return (await repository.searchPromoted(query, 10)).map((row) => ({
    id: row.id,
    rank: row.rank,
  }));
}

describe("PostgreSQL 18 lexical search", () => {
  it("requires and admits only the reviewed read-only search grants", async () => {
    await withPostgreSqlTestDatabase("search-grants", async (database) => {
      const projectId = await createProject(database, "Search grants");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-grants"
      );
      await seedMessage(database, projectId, conversationId, {
        seq: 0,
        role: "user",
        content: "granted needle",
      });
      await seedMessage(database, projectId, conversationId, {
        seq: 1,
        role: "assistant",
        content: "needel",
      });
      const repository = new PostgreSqlLexicalSearchRepository(
        database.runtime,
        projectId
      );
      const admin = new PostgreSqlRuntime(settings(database.adminUrl));
      try {
        await admin.query(
          {
            text: `REVOKE USAGE ON SCHEMA public FROM PUBLIC;
                   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public
                   FROM PUBLIC`,
          },
          {
            domain: "lexical-search",
            operation: "hardenSearchExtensionPrivileges",
          }
        );
        await expect(
          repository.searchMessages({
            query: "needle",
            mode: "full_text",
          })
        ).rejects.toMatchObject({
          backend: "postgresql",
          domain: "lexical-search",
          operation: "searchMessages",
          projectId,
        });

        await grantSearchRuntimePrivileges(database, admin);
      } finally {
        await admin.close();
      }
      const admitted = await repository.searchMessages({
        query: "needle",
        mode: "full_text",
      });
      expect(admitted).toHaveLength(2);
      expect(admitted[1]).toMatchObject({ snippet: "needel" });
      expect(admitted[1].rank).toBeGreaterThan(0);
      expect(admitted[1].rank).toBeLessThan(1);

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        public_schema_usage: boolean;
        public_schema_direct_usage: boolean;
        public_schema_create: boolean;
        public_schema_grant_option: boolean;
        messages_select: boolean;
        messages_insert: boolean;
        summaries_select: boolean;
        summaries_update: boolean;
        memories_select: boolean;
        memories_delete: boolean;
        tags_select: boolean;
        tags_insert: boolean;
        conversations_select: boolean;
        normalize_execute: boolean;
        normalize_grant_option: boolean;
        similarity_execute: boolean;
        similarity_direct_execute: boolean;
        similarity_grant_option: boolean;
        similarity_op_execute: boolean;
        similarity_op_direct_execute: boolean;
        similarity_op_grant_option: boolean;
        unrelated_trgm_execute: boolean;
      }>(
        {
          text: `SELECT
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'USAGE'
                 ) AS schema_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'CREATE'
                 ) AS schema_create,
                 has_schema_privilege(
                   'lcm_test_runtime', 'public', 'USAGE'
                 ) AS public_schema_usage,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_namespace AS namespace
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     namespace.nspacl
                   ) AS privilege
                   WHERE namespace.oid
                     = 'public'::pg_catalog.regnamespace
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'USAGE'
                 ) AS public_schema_direct_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'public', 'CREATE'
                 ) AS public_schema_create,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_namespace AS namespace
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     namespace.nspacl
                   ) AS privilege
                   WHERE namespace.oid
                     = 'public'::pg_catalog.regnamespace
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'USAGE'
                     AND privilege.is_grantable
                 ) AS public_schema_grant_option,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.messages', 'SELECT'
                 ) AS messages_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.messages', 'INSERT'
                 ) AS messages_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.summaries', 'SELECT'
                 ) AS summaries_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.summaries', 'UPDATE'
                 ) AS summaries_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'SELECT'
                 ) AS memories_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memories', 'DELETE'
                 ) AS memories_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memory_tags', 'SELECT'
                 ) AS tags_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.promoted_memory_tags', 'INSERT'
                 ) AS tags_insert,
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
                 ) AS normalize_grant_option,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'public.similarity(text,text)',
                   'EXECUTE'
                 ) AS similarity_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'public.similarity(text,text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'EXECUTE'
                 ) AS similarity_direct_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'public.similarity(text,text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'EXECUTE'
                     AND privilege.is_grantable
                 ) AS similarity_grant_option,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'public.similarity_op(text,text)',
                   'EXECUTE'
                 ) AS similarity_op_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'public.similarity_op(text,text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'EXECUTE'
                 ) AS similarity_op_direct_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     procedure.proacl
                   ) AS privilege
                   WHERE procedure.oid
                     = 'public.similarity_op(text,text)'::pg_catalog.regprocedure
                     AND privilege.grantee
                       = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.privilege_type
                       OPERATOR(pg_catalog.=) 'EXECUTE'
                     AND privilege.is_grantable
                 ) AS similarity_op_grant_option,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'public.show_trgm(text)',
                   'EXECUTE'
                 ) AS unrelated_trgm_execute`,
        },
        {
          domain: "lexical-search",
          operation: "inspectSearchRuntimePrivileges",
        }
      );
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        public_schema_usage: true,
        public_schema_direct_usage: true,
        public_schema_create: false,
        public_schema_grant_option: false,
        messages_select: true,
        messages_insert: false,
        summaries_select: true,
        summaries_update: false,
        memories_select: true,
        memories_delete: false,
        tags_select: true,
        tags_insert: false,
        conversations_select: false,
        normalize_execute: true,
        normalize_grant_option: false,
        similarity_execute: true,
        similarity_direct_execute: true,
        similarity_grant_option: false,
        similarity_op_execute: true,
        similarity_op_direct_execute: true,
        similarity_op_grant_option: false,
        unrelated_trgm_execute: false,
      });
    });
  });

  it.each(
    (
      [
        ["messages", "root"],
        ["messages", "caller"],
        ["summaries", "root"],
        ["summaries", "caller"],
        ["promoted", "root"],
        ["promoted", "caller"],
      ] as const
    ).map(([domain, scope]) => ({ domain, scope }))
  )(
    "keeps one READ COMMITTED snapshot for $domain in a $scope scope",
    async ({
      domain,
      scope,
    }: {
      domain: SnapshotDomain;
      scope: SnapshotScope;
    }) => {
      await withPostgreSqlTestDatabase(
        `search-snapshot-${domain}-${scope}`,
        async (database) => {
          await grantSearchRuntimePrivileges(database);
          await installSearchSnapshotBarriers(database);
          const projectId = await createProject(
            database,
            `Search snapshot ${domain} ${scope}`
          );
          const conversationId = await createConversation(
            database,
            projectId,
            `search-snapshot-${domain}-${scope}`
          );
          const query = "atomiccafe snapshotterm";
          const baselineContent = "atomiccafe snapshotterm baseline";
          const concurrentContent =
            "atómiccafe snapshotterm atómiccafe snapshotterm";
          let baselineId: string | number;
          let insertConcurrent: () => Promise<string | number>;
          if (domain === "messages") {
            baselineId = (
              await seedMessage(database, projectId, conversationId, {
                seq: 0,
                role: "user",
                content: baselineContent,
              })
            ).id;
            insertConcurrent = async () =>
              (
                await seedMessage(database, projectId, conversationId, {
                  seq: 1,
                  role: "assistant",
                  content: concurrentContent,
                })
              ).id;
          } else if (domain === "summaries") {
            baselineId = await seedSummary(
              database,
              projectId,
              conversationId,
              {
                id: `snapshot-${scope}-baseline`,
                kind: "leaf",
                content: baselineContent,
              }
            );
            insertConcurrent = () =>
              seedSummary(database, projectId, conversationId, {
                id: `snapshot-${scope}-concurrent`,
                kind: "condensed",
                content: concurrentContent,
              });
          } else {
            baselineId = await seedMemory(database, projectId, {
              content: baselineContent,
              tags: [],
              sourceProjectId: "snapshot-source",
              confidence: 0.8,
            });
            insertConcurrent = () =>
              seedMemory(database, projectId, {
                content: concurrentContent,
                tags: [],
                sourceProjectId: "snapshot-source",
                confidence: 0.9,
              });
          }

          const exercise = async (
            repository: PostgreSqlLexicalSearchRepository
          ): Promise<void> => {
            const barrier = await holdSearchSnapshotBarrier(
              database,
              SNAPSHOT_BARRIER_KEYS[domain]
            );
            const pending = searchSnapshotDomain(
              repository,
              domain,
              conversationId,
              query
            );
            const completion = pending.then(
              (rows) => ({ state: "completed" as const, rows }),
              (error: unknown) => ({ state: "failed" as const, error })
            );
            let concurrentId!: string | number;
            try {
              const observation = await Promise.race([
                waitForSearchSnapshotWaiter(database).then(() => ({
                  state: "blocked" as const,
                })),
                completion,
              ]);
              if (observation.state === "failed") {
                throw observation.error;
              }
              if (observation.state === "completed") {
                throw new Error(
                  `lexical ${domain} search completed before its snapshot barrier`
                );
              }
              concurrentId = await insertConcurrent();
            } finally {
              await barrier.release();
            }

            const first = await pending;
            expect(first.map((row) => row.id)).toEqual([baselineId]);
            const next = await searchSnapshotDomain(
              repository,
              domain,
              conversationId,
              query
            );
            expect(next.map((row) => row.id)).toEqual([
              concurrentId,
              baselineId,
            ]);
            if (domain === "promoted") {
              expect(next.every((row) => row.rank < 0)).toBe(true);
            } else {
              expect(next.every((row) => row.rank > 0)).toBe(true);
              expect(next[0].snippet).toContain("atomiccafe");
              expect(next[0].snippet).not.toContain("atómiccafe");
            }
          };

          if (scope === "root") {
            await exercise(
              new PostgreSqlLexicalSearchRepository(database.runtime, projectId)
            );
            const healthy = await database.runtime.query<{
              statement_timeout: string;
              usable: number;
            }>(
              {
                text: `SELECT
                         pg_catalog.current_setting(
                           'statement_timeout'
                         ) AS statement_timeout,
                         1::pg_catalog.int4 AS usable`,
              },
              {
                domain: "lexical-search",
                operation: "verifyRootSnapshotSearchState",
              }
            );
            expect(healthy.rows[0]).toEqual({
              statement_timeout: "5s",
              usable: 1,
            });
            return;
          }

          await database.runtime.transaction(async (transaction) => {
            const prior = await transaction.query<{
              transaction_isolation: string;
              statement_timeout: string;
              prior_io: number;
            }>(
              {
                text: `SELECT
                         pg_catalog.current_setting(
                           'transaction_isolation'
                         ) AS transaction_isolation,
                         pg_catalog.current_setting(
                           'statement_timeout'
                         ) AS statement_timeout,
                         1::pg_catalog.int4 AS prior_io`,
              },
              {
                domain: "lexical-search",
                operation: "verifyCallerSnapshotPrerequisites",
              }
            );
            expect(prior.rows[0]).toEqual({
              transaction_isolation: "read committed",
              statement_timeout: "5s",
              prior_io: 1,
            });
            await transaction.query(
              {
                text: "SET LOCAL statement_timeout = '30s'",
              },
              {
                domain: "lexical-search",
                operation: "setCallerSnapshotTimeout",
              }
            );
            await exercise(
              new PostgreSqlLexicalSearchRepository(transaction, projectId)
            );
            const healthy = await transaction.query<{
              statement_timeout: string;
              usable: number;
            }>(
              {
                text: `SELECT
                         pg_catalog.current_setting(
                           'statement_timeout'
                         ) AS statement_timeout,
                         1::pg_catalog.int4 AS usable`,
              },
              {
                domain: "lexical-search",
                operation: "verifyCallerSnapshotSearchState",
              }
            );
            expect(healthy.rows[0]).toEqual({
              statement_timeout: "30s",
              usable: 1,
            });
          });
        }
      );
    }
  );

  it("executes fallback only for database-normalized eligible queries", async () => {
    await withPostgreSqlTestDatabase(
      "search-fallback-gates",
      async (database) => {
        await grantSearchRuntimePrivileges(database);
        const projectId = await createProject(
          database,
          "Search fallback gates"
        );
        const conversationId = await createConversation(
          database,
          projectId,
          "search-fallback-gates"
        );
        const normalizedExpansion = await database.migrator.query<{
          normalized_query: string;
          normalized_bytes: number;
        }>(
          {
            text: `SELECT
                     lcm.normalize_search_text($1) AS normalized_query,
                     pg_catalog.octet_length(
                       lcm.normalize_search_text($1)
                     ) AS normalized_bytes`,
            values: ["±"],
          },
          {
            domain: "lexical-search",
            operation: "inspectExpandedTrigramGate",
          }
        );
        expect(normalizedExpansion.rows[0]).toEqual({
          normalized_query: "+/-",
          normalized_bytes: 3,
        });

        const primaryMessage = await seedMessage(
          database,
          projectId,
          conversationId,
          {
            seq: 0,
            role: "user",
            content: "± a fullprimary message",
          }
        );
        const laterMessage = await seedMessage(
          database,
          projectId,
          conversationId,
          {
            seq: 1,
            role: "assistant",
            content: "± expansion message",
          }
        );
        const primarySummary = await seedSummary(
          database,
          projectId,
          conversationId,
          {
            id: "fallback-gate-summary-a",
            kind: "leaf",
            content: "± a fullprimary summary",
          }
        );
        const laterSummary = await seedSummary(
          database,
          projectId,
          conversationId,
          {
            id: "fallback-gate-summary-z",
            kind: "condensed",
            content: "± expansion summary",
          }
        );
        const primaryMemory = await seedMemory(database, projectId, {
          content: "± a fullprimary memory",
          tags: [],
          sourceProjectId: "fallback-gate-source",
          confidence: 1,
        });
        const laterMemory = await seedMemory(database, projectId, {
          content: "± expansion memory",
          tags: [],
          sourceProjectId: "fallback-gate-source",
          confidence: 0.9,
        });

        const cases = [
          {
            domain: "messages",
            gate: "expansion",
            query: "±",
            limit: 10,
            relationName: "messages",
            expectedIds: [laterMessage.id, primaryMessage.id],
            executeFallback: true,
          },
          {
            domain: "messages",
            gate: "normalized",
            query: "𝐚",
            limit: 10,
            relationName: "messages",
            expectedIds: [primaryMessage.id],
            executeFallback: false,
          },
          {
            domain: "messages",
            gate: "budget",
            query: "fullprimary",
            limit: 1,
            relationName: "messages",
            expectedIds: [primaryMessage.id],
            executeFallback: false,
          },
          {
            domain: "summaries",
            gate: "expansion",
            query: "±",
            limit: 10,
            relationName: "summaries",
            expectedIds: [laterSummary, primarySummary],
            executeFallback: true,
          },
          {
            domain: "summaries",
            gate: "normalized",
            query: "𝐚",
            limit: 10,
            relationName: "summaries",
            expectedIds: [primarySummary],
            executeFallback: false,
          },
          {
            domain: "summaries",
            gate: "budget",
            query: "fullprimary",
            limit: 1,
            relationName: "summaries",
            expectedIds: [primarySummary],
            executeFallback: false,
          },
          {
            domain: "promoted",
            gate: "expansion",
            query: "±",
            limit: 10,
            relationName: "promoted_memories",
            expectedIds: [laterMemory, primaryMemory],
            executeFallback: true,
          },
          {
            domain: "promoted",
            gate: "normalized",
            query: "𝐚",
            limit: 10,
            relationName: "promoted_memories",
            expectedIds: [primaryMemory],
            executeFallback: false,
          },
          {
            domain: "promoted",
            gate: "budget",
            query: "fullprimary",
            limit: 1,
            relationName: "promoted_memories",
            expectedIds: [primaryMemory],
            executeFallback: false,
          },
        ] as const;

        await database.runtime.transaction(async (transaction) => {
          for (const testCase of cases) {
            const captured: CapturedSearchQuery[] = [];
            const repository = new PostgreSqlLexicalSearchRepository(
              captureSearchScopedExecutor(transaction, captured),
              projectId
            );
            const behavior =
              testCase.domain === "messages"
                ? await repository.searchMessages({
                    query: testCase.query,
                    mode: "full_text",
                    conversationId,
                    limit: testCase.limit,
                  })
                : testCase.domain === "summaries"
                ? await repository.searchSummaries({
                    query: testCase.query,
                    mode: "full_text",
                    conversationId,
                    limit: testCase.limit,
                  })
                : await repository.searchPromoted(
                    testCase.query,
                    testCase.limit
                  );
            const observedIds = behavior.map((row) =>
              "messageId" in row
                ? row.messageId
                : "summaryId" in row
                ? row.summaryId
                : row.id
            );
            expect(
              observedIds,
              `${testCase.domain}/${testCase.gate} production order`
            ).toEqual(testCase.expectedIds);
            if (testCase.executeFallback) {
              expect(behavior.every((row) => row.rank >= 0)).toBe(true);
            }
            expect(captured).toHaveLength(1);
            const explained = await transaction.query<{
              "QUERY PLAN": unknown;
            }>(
              {
                text: `EXPLAIN (ANALYZE, FORMAT JSON) ${captured[0].text}`,
                values: [...captured[0].values],
              },
              {
                domain: "lexical-search",
                operation: `explainFallbackGate-${testCase.domain}-${testCase.gate}`,
                projectId,
              }
            );
            const plan = explained.rows[0]["QUERY PLAN"];
            if (testCase.executeFallback) {
              expectFallbackRelationExecuted(plan, testCase.relationName);
            } else {
              expectFallbackRelationNeverExecuted(plan, testCase.relationName);
            }
          }
        });
      }
    );
  });

  it("passes golden parity, project isolation, and 2046/2047-byte routing", async () => {
    await withPostgreSqlTestDatabase("search-parity", async (database) => {
      await grantSearchRuntimePrivileges(database);
      const projectId = await createProject(database, "Search parity");
      const otherProjectId = await createProject(
        database,
        "Search parity isolated"
      );
      const fixtures = await seedConformanceFixtures(database, projectId);
      const otherConversationId = await createConversation(
        database,
        otherProjectId,
        "isolated-project"
      );
      await seedMessage(database, otherProjectId, otherConversationId, {
        seq: 0,
        role: "system",
        content: "cross-project needle",
      });
      const otherMemory = await seedMemory(database, otherProjectId, {
        content: "cross-project primarydurable",
        tags: ["tagonly"],
        sourceProjectId: fixtures.sourceProjectId,
        confidence: 1,
      });

      const repository = new PostgreSqlLexicalSearchRepository(
        database.runtime,
        projectId
      );
      await exerciseLexicalSearchRepositoryConformance(repository, fixtures, {
        rejectsExplicitNullObjectLimits: true,
      });
      const legacyPrimaryMemory = await seedMemory(database, projectId, {
        content: "legacyprimaryneedle",
        tags: [],
        sourceProjectId: null,
        confidence: 0.8,
      });
      const legacyFallbackMemory = await seedMemory(database, projectId, {
        content: "legacyfallbackspelling",
        tags: [],
        sourceProjectId: null,
        confidence: 0.8,
      });
      const legacyPrimary = await repository.searchPromoted(
        "legacyprimaryneedle",
        10
      );
      expect(legacyPrimary).toMatchObject([
        {
          id: legacyPrimaryMemory,
          projectId,
        },
      ]);
      expect(legacyPrimary[0].rank).toBeLessThan(0);
      const legacyFallback = await repository.searchPromoted(
        "legacyfallbackspeling",
        10
      );
      expect(legacyFallback).toMatchObject([
        {
          id: legacyFallbackMemory,
          projectId,
        },
      ]);
      expect(legacyFallback[0].rank).toBeGreaterThanOrEqual(0);
      await expect(
        repository.searchPromoted(
          "legacyprimaryneedle",
          10,
          undefined,
          projectId
        )
      ).resolves.toEqual([]);
      await expect(
        repository.searchPromoted(
          "legacyfallbackspeling",
          10,
          undefined,
          projectId
        )
      ).resolves.toEqual([]);
      const rankedContentMemory = await seedMemory(database, projectId, {
        content: "rankprobealpha rankprobebeta",
        tags: [],
        sourceProjectId: fixtures.sourceProjectId,
        confidence: 0.8,
      });
      const rankedTagMemory = await seedMemory(database, projectId, {
        content: "unrelated rank ordering memory",
        tags: ["rankprobealpha"],
        sourceProjectId: fixtures.sourceProjectId,
        confidence: 0.8,
      });
      const promotedRanks = (
        await repository.searchPromoted("rankprobealpha OR rankprobebeta", 10)
      ).filter(
        (row) => row.id === rankedContentMemory || row.id === rankedTagMemory
      );
      expect(promotedRanks.map((row) => row.id)).toEqual([
        rankedContentMemory,
        rankedTagMemory,
      ]);
      expect(promotedRanks.every((row) => row.rank < 0)).toBe(true);
      expect(promotedRanks[0].rank).toBeLessThan(promotedRanks[1].rank);
      expect(
        await repository.searchMessages({
          query: "cross-project",
          mode: "full_text",
        })
      ).toEqual([]);
      expect(
        (await repository.searchPromoted("cross-project", 10)).map(
          (row) => row.id
        )
      ).not.toContain(otherMemory);

      const boundaryConversationId = await createConversation(
        database,
        projectId,
        "lexeme-boundary"
      );
      const acceptedLexeme = "a".repeat(2_046);
      const fallbackLexeme = "b".repeat(2_047);
      const accepted = await seedMessage(
        database,
        projectId,
        boundaryConversationId,
        {
          seq: 0,
          role: "user",
          content: acceptedLexeme,
        }
      );
      const fallback = await seedMessage(
        database,
        projectId,
        boundaryConversationId,
        {
          seq: 1,
          role: "assistant",
          content: fallbackLexeme,
        }
      );
      const boundary = await database.migrator.query<{
        normalized_bytes: number;
        full_text_matches: boolean;
      }>(
        {
          text: `SELECT
                 pg_catalog.octet_length(
                   lcm.normalize_search_text($1)
                 ) AS normalized_bytes,
                 pg_catalog.to_tsvector(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 ) OPERATOR(pg_catalog.@@)
                 pg_catalog.websearch_to_tsquery(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 ) AS full_text_matches`,
          values: [acceptedLexeme],
        },
        { domain: "lexical-search", operation: "inspectAcceptedLexeme" }
      );
      expect(boundary.rows[0]).toEqual({
        normalized_bytes: 2_046,
        full_text_matches: true,
      });
      const oversized = await database.migrator.query<{
        normalized_bytes: number;
        vector: string;
      }>(
        {
          text: `SELECT
                 pg_catalog.octet_length(
                   lcm.normalize_search_text($1)
                 ) AS normalized_bytes,
                 pg_catalog.to_tsvector(
                   'lcm.search_v1'::pg_catalog.regconfig,
                   lcm.normalize_search_text($1)
                 )::pg_catalog.text AS vector`,
          values: [fallbackLexeme],
        },
        { domain: "lexical-search", operation: "inspectOversizedLexeme" }
      );
      expect(oversized.rows[0]).toEqual({
        normalized_bytes: 2_047,
        vector: "",
      });
      expect(
        await repository.searchMessages({
          query: acceptedLexeme,
          mode: "full_text",
          conversationId: boundaryConversationId,
          limit: 5,
        })
      ).toMatchObject([{ messageId: accepted.id }]);
      expect(
        await repository.searchMessages({
          query: fallbackLexeme,
          mode: "full_text",
          conversationId: boundaryConversationId,
          limit: 5,
        })
      ).toMatchObject([{ messageId: fallback.id }]);
    });
  });

  it("gates normalized trigram queries and headlines normalized late matches", async () => {
    await withPostgreSqlTestDatabase("search-normalized", async (database) => {
      await grantSearchRuntimePrivileges(database);
      const projectId = await createProject(
        database,
        "Search normalized domain"
      );
      const conversationId = await createConversation(
        database,
        projectId,
        "search-normalized"
      );
      await seedMessage(database, projectId, conversationId, {
        seq: 0,
        role: "user",
        content: "cat",
      });
      const unrelated = Array.from(
        { length: 40 },
        (_, index) => `unrelated${index}`
      ).join(" ");
      const lateContent = `${unrelated} Café late`;
      const lateMessage = await seedMessage(
        database,
        projectId,
        conversationId,
        {
          seq: 1,
          role: "assistant",
          content: lateContent,
        }
      );
      const lateSummaryId = await seedSummary(
        database,
        projectId,
        conversationId,
        {
          id: "normalized-late-summary",
          kind: "leaf",
          content: lateContent,
        }
      );
      await seedMemory(database, projectId, {
        content: "cat",
        tags: ["cat"],
        sourceProjectId: "normalized-source",
        confidence: 1,
      });

      const normalized = await database.migrator.query<{
        normalized_query: string;
        normalized_bytes: number;
      }>(
        {
          text: `SELECT
                   lcm.normalize_search_text($1) AS normalized_query,
                   pg_catalog.octet_length(
                     lcm.normalize_search_text($1)
                   ) AS normalized_bytes`,
          values: ["𝐚"],
        },
        {
          domain: "lexical-search",
          operation: "inspectNormalizedTrigramGate",
        }
      );
      expect(normalized.rows[0]).toEqual({
        normalized_query: "a",
        normalized_bytes: 1,
      });

      const repository = new PostgreSqlLexicalSearchRepository(
        database.runtime,
        projectId
      );
      expect(
        await repository.searchMessages({
          query: "𝐚",
          mode: "full_text",
          conversationId,
        })
      ).toEqual([]);
      expect(
        await repository.searchSummaries({
          query: "𝐚",
          mode: "full_text",
          conversationId,
        })
      ).toEqual([]);
      expect(await repository.searchPromoted("𝐚", 10)).toEqual([]);

      const messageResults = await repository.searchMessages({
        query: "cafe",
        mode: "full_text",
        conversationId,
        limit: 1,
      });
      expect(messageResults).toHaveLength(1);
      expect(messageResults[0].messageId).toBe(lateMessage.id);
      expect(messageResults[0].snippet).toContain("cafe");
      expect(messageResults[0].snippet).not.toContain("Café");
      expect(messageResults[0].snippet).not.toContain("unrelated0");
      expect(messageResults[0].snippet).not.toMatch(/<\/?(?:b|mark)>/iu);
      expect(messageResults[0].snippet.length).toBeLessThanOrEqual(512);

      const summaryResults = await repository.searchSummaries({
        query: "cafe",
        mode: "full_text",
        conversationId,
        limit: 1,
      });
      expect(summaryResults).toHaveLength(1);
      expect(summaryResults[0].summaryId).toBe(lateSummaryId);
      expect(summaryResults[0].snippet).toContain("cafe");
      expect(summaryResults[0].snippet).not.toContain("Café");
      expect(summaryResults[0].snippet).not.toContain("unrelated0");
      expect(summaryResults[0].snippet).not.toMatch(/<\/?(?:b|mark)>/iu);
      expect(summaryResults[0].snippet.length).toBeLessThanOrEqual(512);
    });
  });

  it("contains cancellation and restores caller and pooled statement timeouts", async () => {
    await withPostgreSqlTestDatabase("search-timeout", async (database) => {
      await grantSearchRuntimePrivileges(database);
      const projectId = await createProject(database, "Search timeout");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-timeout"
      );
      await installSearchSnapshotBarriers(database);
      await database.migrator.query(
        {
          text: `INSERT INTO lcm.messages (
                 project_id, conversation_id, seq, role, content, token_count
               )
               SELECT
                 $1,
                 $2,
                 source.ordinal,
                 'user',
                 CASE
                   WHEN source.ordinal OPERATOR(pg_catalog.=) 1
                     THEN 'atomiccafe timeoutbarrier'
                   ELSE pg_catalog.repeat('a', 4000)
                     OPERATOR(pg_catalog.||)
                     source.ordinal::pg_catalog.text
                 END,
                 1
               FROM pg_catalog.generate_series(1, 1000) AS source(ordinal)`,
          values: [projectId, conversationId],
        },
        { domain: "lexical-search", operation: "seedTimeoutCorpus" }
      );

      const barrierHolderRuntime = new PostgreSqlRuntime(
        settings(database.migratorUrl, {
          poolMax: 1,
          statementTimeoutMs: 30_000,
        })
      );
      let barrierHolderPid = 0;
      try {
        const lowTimeoutRuntime = new PostgreSqlRuntime(
          settings(database.runtimeUrl, {
            poolMax: 1,
            statementTimeoutMs: 30_000,
          })
        );
        try {
          const lowTimeoutRepository = new PostgreSqlLexicalSearchRepository(
            lowTimeoutRuntime,
            projectId
          );
          const originalBackend = await lowTimeoutRuntime.query<{
            timeout: string;
            backend_pid: number;
          }>(
            {
              text: `SELECT
                     pg_catalog.current_setting(
                       'statement_timeout'
                     ) AS timeout,
                     pg_catalog.pg_backend_pid() AS backend_pid`,
            },
            {
              domain: "lexical-search",
              operation: "capturePooledSearchBackend",
            }
          );
          expect(originalBackend.rows[0]).toMatchObject({ timeout: "30s" });

          const barrier = await holdSearchSnapshotBarrier(
            database,
            SNAPSHOT_BARRIER_KEYS.messages,
            barrierHolderRuntime
          );
          barrierHolderPid = barrier.backendPid;
          const pending = lowTimeoutRepository.searchMessages({
            query: "atomiccafe timeoutbarrier",
            mode: "full_text",
            limit: 50,
          });
          const completion = pending.then(
            (rows) => ({ state: "completed" as const, rows }),
            (error: unknown) => ({ state: "failed" as const, error })
          );
          try {
            const observation = await Promise.race([
              waitForSearchSnapshotWaiter(database).then(() => ({
                state: "blocked" as const,
              })),
              completion,
            ]);
            if (observation.state === "completed") {
              throw new Error(
                "pooled lexical search completed before its timeout barrier"
              );
            }
            if (observation.state === "failed") throw observation.error;
            const timedOut = await completion;
            expect(timedOut.state).toBe("failed");
            if (timedOut.state === "completed") {
              throw new Error("pooled lexical search did not time out");
            }
            expect(timedOut.error).toMatchObject({
              domain: "lexical-search",
              operation: "searchMessages",
              sqlState: "57014",
              retryable: false,
            });
          } finally {
            await barrier.release();
          }

          const healthy = await lowTimeoutRuntime.query<{
            timeout: string;
            backend_pid: number;
            usable: number;
          }>(
            {
              text: `SELECT
                     pg_catalog.current_setting(
                       'statement_timeout'
                     ) AS timeout,
                     pg_catalog.pg_backend_pid() AS backend_pid,
                     1::pg_catalog.int4 AS usable`,
            },
            {
              domain: "lexical-search",
              operation: "verifyPoolAfterTimeout",
            }
          );
          expect(healthy.rows[0]).toEqual({
            timeout: "30s",
            backend_pid: originalBackend.rows[0].backend_pid,
            usable: 1,
          });
        } finally {
          await lowTimeoutRuntime.close();
        }
      } finally {
        await barrierHolderRuntime.close();
      }
      expect(barrierHolderPid).toBeGreaterThan(0);
      const holderClosed = await database.migrator.query<{
        active: boolean;
      }>(
        {
          text: `SELECT EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_stat_activity AS activity
                   WHERE activity.pid OPERATOR(pg_catalog.=)
                     $1::pg_catalog.int4
                 ) AS active`,
          values: [barrierHolderPid],
        },
        {
          domain: "lexical-search",
          operation: "verifySearchBarrierHolderClosed",
        }
      );
      expect(holderClosed.rows[0]).toEqual({ active: false });

      let regexDialectError: unknown;
      let regexDialectState:
        | { readonly timeout: string; readonly usable: number }
        | undefined;
      await database.runtime.transaction(async (transaction) => {
        await transaction.query(
          {
            text: "SET LOCAL statement_timeout = '1ms'",
          },
          { domain: "lexical-search", operation: "setCallerTimeout" }
        );
        const scoped = new PostgreSqlLexicalSearchRepository(
          transaction,
          projectId
        );
        await expect(
          scoped.searchMessages({
            query: "z$",
            mode: "regex",
            limit: 50,
          })
        ).rejects.toMatchObject({ sqlState: "57014" });
        const restored = await transaction.query<{ timeout: string }>(
          {
            text: `SELECT pg_catalog.current_setting(
                   'statement_timeout'
                 ) AS timeout`,
          },
          { domain: "lexical-search", operation: "verifyCallerTimeout" }
        );
        expect(restored.rows[0].timeout).toBe("1ms");
        await transaction.query(
          {
            text: "SET LOCAL statement_timeout = '5s'",
          },
          { domain: "lexical-search", operation: "restoreCallerBudget" }
        );
        await expect(
          transaction.query(
            {
              text: "SELECT 1",
            },
            { domain: "lexical-search", operation: "verifyCallerUsable" }
          )
        ).resolves.toMatchObject({ rowCount: 1 });

        await transaction.query(
          {
            text: "SET LOCAL statement_timeout = '30s'",
          },
          {
            domain: "lexical-search",
            operation: "setCallerRegexDialectTimeout",
          }
        );
        try {
          // ECMAScript named captures are valid and pass safe-regex, while
          // PostgreSQL 18's ARE dialect rejects this syntax with SQLSTATE 2201B.
          await scoped.searchMessages({
            query: "(?<name>a)",
            mode: "regex",
            limit: 50,
          });
        } catch (error) {
          regexDialectError = error;
        }
        const dialectFailure = await transaction.query<{
          timeout: string;
          usable: number;
        }>(
          {
            text: `SELECT
                   pg_catalog.current_setting('statement_timeout') AS timeout,
                   1::pg_catalog.int4 AS usable`,
          },
          {
            domain: "lexical-search",
            operation: "verifyCallerAfterRegexDialectFailure",
          }
        );
        regexDialectState = dialectFailure.rows[0];
      });
      expect(regexDialectError).toMatchObject({
        domain: "lexical-search",
        operation: "searchMessages",
        sqlState: "2201B",
        retryable: false,
      });
      expect(regexDialectState).toEqual({ timeout: "30s", usable: 1 });

      const pooled = await database.runtime.query<{
        timeout: string;
        usable: number;
      }>(
        {
          text: `SELECT
                 pg_catalog.current_setting('statement_timeout') AS timeout,
                 1::pg_catalog.int4 AS usable`,
        },
        { domain: "lexical-search", operation: "verifyDefaultPool" }
      );
      expect(pooled.rows[0]).toEqual({ timeout: "5s", usable: 1 });
    });
  });

  it("uses all eight shipped GIN indexes with the default planner", async () => {
    await withPostgreSqlTestDatabase("search-plans", async (database) => {
      const projectId = await createProject(database, "Search plans");
      const conversationId = await createConversation(
        database,
        projectId,
        "search-plans"
      );
      const corpusSize = 4_000;
      await database.migrator.transaction(
        async (transaction) => {
          const context = {
            domain: "lexical-search",
            operation: "seedPlannerCorpus",
          } as const;
          await transaction.query(
            {
              text: "SET LOCAL statement_timeout = '30s'",
            },
            context
          );
          const seeds = [
            {
              text: `INSERT INTO lcm.messages (
                     project_id, conversation_id, seq, role,
                     content, token_count
                   )
                   SELECT
                     $1,
                     $2,
                     source.ordinal,
                     'user',
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $3
                         THEN 'planner_needle message'
                       ELSE 'message filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     1
                   FROM pg_catalog.generate_series(
                     1,
                     $3
                   ) AS source(ordinal)`,
              values: [projectId, conversationId, corpusSize],
            },
            {
              text: `INSERT INTO lcm.summaries (
                     summary_id, project_id, conversation_id, kind,
                     depth, content, token_count
                   )
                   SELECT
                     'planner-summary-'
                       OPERATOR(pg_catalog.||)
                       source.ordinal::pg_catalog.text,
                     $1,
                     $2,
                     'leaf',
                     0,
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $3
                         THEN 'planner_needle summary'
                       ELSE 'summary filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     1
                   FROM pg_catalog.generate_series(
                     1,
                     $3
                   ) AS source(ordinal)`,
              values: [projectId, conversationId, corpusSize],
            },
            {
              text: `INSERT INTO lcm.promoted_memories (
                     project_id, content, source_project_id
                   )
                   SELECT
                     $1,
                     CASE
                       WHEN source.ordinal OPERATOR(pg_catalog.=) $2
                         THEN 'planner_needle memory'
                       ELSE 'memory filler '
                         OPERATOR(pg_catalog.||)
                         source.ordinal::pg_catalog.text
                     END,
                     'planner-source'
                   FROM pg_catalog.generate_series(
                     1,
                     $2
                   ) AS source(ordinal)`,
              values: [projectId, corpusSize],
            },
            {
              text: `WITH ranked AS (
                     SELECT
                       memory.project_id,
                       memory.memory_id,
                       pg_catalog.row_number() OVER (
                         ORDER BY memory.memory_id
                       ) AS ordinal
                     FROM lcm.promoted_memories AS memory
                     WHERE memory.project_id
                       OPERATOR(pg_catalog.=) $1
                   )
                   INSERT INTO lcm.promoted_memory_tags (
                     project_id, memory_id, ordinal, tag
                   )
                   SELECT
                     ranked.project_id,
                     ranked.memory_id,
                     0,
                     CASE
                       WHEN ranked.ordinal OPERATOR(pg_catalog.=) $2
                         THEN 'planner_needle tag'
                       ELSE 'tag filler '
                         OPERATOR(pg_catalog.||)
                         ranked.ordinal::pg_catalog.text
                     END
                   FROM ranked`,
              values: [projectId, corpusSize],
            },
          ];
          for (const seed of seeds) {
            await transaction.query(seed, context);
          }
          for (const table of [
            "messages",
            "summaries",
            "promoted_memories",
            "promoted_memory_tags",
          ]) {
            await transaction.query(
              {
                text: `ANALYZE lcm.${table}`,
              },
              context
            );
          }
        },
        { domain: "lexical-search", operation: "seedPlannerCorpus" }
      );
      for (const table of [
        "messages",
        "summaries",
        "promoted_memories",
        "promoted_memory_tags",
      ]) {
        await database.migrator.query(
          {
            text: `VACUUM (ANALYZE) lcm.${table}`,
          },
          {
            domain: "lexical-search",
            operation: "flushSearchGinPendingList",
          }
        );
      }

      const plans = [
        [
          "messages_search_document_idx",
          `SELECT message_id
          FROM lcm.messages
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "messages_content_trgm_idx",
          `SELECT message_id
          FROM lcm.messages
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "summaries_search_document_idx",
          `SELECT summary_id
          FROM lcm.summaries
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "summaries_content_trgm_idx",
          `SELECT summary_id
          FROM lcm.summaries
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "promoted_memories_search_document_idx",
          `SELECT memory_id
          FROM lcm.promoted_memories
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "promoted_memories_content_trgm_idx",
          `SELECT memory_id
          FROM lcm.promoted_memories
          WHERE lcm.normalize_search_text(content)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
        [
          "promoted_memory_tags_search_document_idx",
          `SELECT memory_id
          FROM lcm.promoted_memory_tags
          WHERE search_document OPERATOR(pg_catalog.@@)
            pg_catalog.websearch_to_tsquery(
              'lcm.search_v1'::pg_catalog.regconfig,
              'planner_needle'
            )`,
        ],
        [
          "promoted_memory_tags_tag_trgm_idx",
          `SELECT memory_id
          FROM lcm.promoted_memory_tags
          WHERE lcm.normalize_search_text(tag)
            OPERATOR(pg_catalog.~~) '%planner_needle%'`,
        ],
      ] as const;
      const evidence: Record<string, unknown> = {};
      for (const [indexName, query] of plans) {
        const explained = await database.migrator.query<{
          "QUERY PLAN": unknown;
        }>(
          {
            text: `EXPLAIN (
                   ANALYZE,
                   BUFFERS,
                   COSTS,
                   FORMAT JSON,
                   TIMING FALSE
                 ) ${query}`,
          },
          { domain: "lexical-search", operation: "explainSearchIndex" }
        );
        const plan = explained.rows[0]["QUERY PLAN"];
        expect(planText(plan)).toContain(indexName);
        evidence[indexName] = plan;
      }
      process.stdout.write(
        `PostgreSQL lexical benchmark evidence: ${JSON.stringify({
          corpusSize,
          plans: evidence,
        })}\n`
      );
    });
  });
});
