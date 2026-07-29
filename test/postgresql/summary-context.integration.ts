import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  derivePostgreSqlAdvisoryLockName,
  PostgreSqlLeaseFenceError,
} from "../../src/storage/postgresql/coordination.js";
import {
  PostgreSqlConversationRepository,
} from "../../src/storage/postgresql/conversation-repository.js";
import {
  PostgreSqlCoordinationRepository,
} from "../../src/storage/postgresql/memory-repositories.js";
import {
  PostgreSqlContextRepository,
  PostgreSqlLargeFileRepository,
  PostgreSqlSummaryContextConflictError,
  PostgreSqlSummaryContextDataError,
  PostgreSqlSummaryContextNotFoundError,
  type PostgreSqlSummaryContextRepositoryOptions,
  PostgreSqlSummaryRepository,
} from "../../src/storage/postgresql/summary-context-repositories.js";
import {
  PostgreSqlRuntime,
} from "../../src/storage/postgresql/runtime.js";
import {
  exerciseSummaryContextRepositoryConformance,
} from "../storage/summary-context-conformance.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

const SUMMARY_CONTEXT_TABLES = [
  "context_items",
  "conversations",
  "large_files",
  "messages",
  "summaries",
  "summary_large_files",
  "summary_messages",
  "summary_parents",
] as const;

interface RepositorySet {
  readonly conversations: PostgreSqlConversationRepository;
  readonly summaries: PostgreSqlSummaryRepository;
  readonly context: PostgreSqlContextRepository;
  readonly largeFiles: PostgreSqlLargeFileRepository;
}

async function applyRuntimeGrant(
  database: PostgreSqlTestDatabase,
  fileName: string,
  operation: string,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", fileName),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "summaries",
    operation,
  });
}

async function grantSummaryContextRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  await applyRuntimeGrant(
    database,
    "postgresql-runtime-summary-context-grants.sql",
    "grantSummaryContextRuntimePrivileges",
  );
}

async function grantConversationRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  await applyRuntimeGrant(
    database,
    "postgresql-runtime-conversation-grants.sql",
    "grantSummaryContextConversationPrivileges",
  );
}

async function grantCoordinationRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  await applyRuntimeGrant(
    database,
    "postgresql-runtime-coordination-grants.sql",
    "grantSummaryContextCoordinationPrivileges",
  );
}

async function grantRepositoryRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  await grantConversationRuntimePrivileges(database);
  await grantSummaryContextRuntimePrivileges(database);
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
  }, { domain: "identity", operation: "createSummaryContextTestProject" });
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
  }, { domain: "identity", operation: "createSummaryContextTestMachine" });
  return result.rows[0].machine_id;
}

async function createConversationAsMigrator(
  database: PostgreSqlTestDatabase,
  projectId: string,
  sessionId: string,
): Promise<number> {
  const result = await database.migrator.query<{ conversation_id: string }>({
    text: `INSERT INTO lcm.conversations (project_id, session_id, title)
           VALUES ($1, $2, $3)
           RETURNING conversation_id::pg_catalog.text`,
    values: [projectId, sessionId, sessionId],
  }, { domain: "conversations", operation: "seedSummaryContextConversation" });
  return Number(result.rows[0].conversation_id);
}

async function createMessageAsMigrator(
  database: PostgreSqlTestDatabase,
  projectId: string,
  conversationId: number,
  seq: number,
): Promise<number> {
  const result = await database.migrator.query<{ message_id: string }>({
    text: `INSERT INTO lcm.messages (
             project_id, conversation_id, seq, role, content, token_count
           )
           VALUES ($1, $2, $3, 'user', $4, $5)
           RETURNING message_id::pg_catalog.text`,
    values: [projectId, conversationId, seq, `message ${seq}`, seq + 1],
  }, { domain: "conversations", operation: "seedSummaryContextMessage" });
  return Number(result.rows[0].message_id);
}

function repositories(
  database: PostgreSqlTestDatabase,
  projectId: string,
  options: PostgreSqlSummaryContextRepositoryOptions = {},
  runtime = database.runtime,
): RepositorySet {
  return {
    conversations: new PostgreSqlConversationRepository(runtime, projectId),
    summaries: new PostgreSqlSummaryRepository(runtime, projectId, options),
    context: new PostgreSqlContextRepository(runtime, projectId, options),
    largeFiles: new PostgreSqlLargeFileRepository(runtime, projectId, options),
  };
}

async function createSummary(
  repository: PostgreSqlSummaryRepository,
  conversationId: number,
  summaryId: string,
  depth = 1,
): Promise<void> {
  await repository.insertSummary({
    conversationId,
    summaryId,
    kind: depth === 0 ? "leaf" : "condensed",
    depth,
    content: `${summaryId} content`,
    tokenCount: depth + 1,
  });
}

async function expectLeaseFenceFailure(
  promise: Promise<unknown>,
  input: {
    readonly projectId: string;
    readonly machineId: string;
    readonly fencingToken: bigint;
  },
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PostgreSqlLeaseFenceError);
  expect(error).toMatchObject({
    name: "PostgreSqlLeaseFenceError",
    backend: "postgresql",
    projectId: input.projectId,
    domain: "coordination",
    operation: "assertLeaseFence",
    machineId: input.machineId,
    fencingToken: input.fencingToken,
  });
}

async function waitForRuntimeLockWaiters(
  database: PostgreSqlTestDatabase,
  queryFragment: string,
  minimum: number,
): Promise<void> {
  let observed: readonly {
    readonly pid: number;
    readonly wait_event: string | null;
    readonly query: string;
  }[] = [];
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = await database.migrator.query<{
      pid: number;
      wait_event: string | null;
      query: string;
    }>({
      text: `SELECT pid, wait_event, query
             FROM pg_catalog.pg_stat_activity
             WHERE datname = pg_catalog.current_database()
               AND usename = 'lcm_test_runtime'
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND query LIKE $1
             ORDER BY pid`,
      values: [`%${queryFragment}%`],
    }, { domain: "summaries", operation: "waitForSummaryContextLockWaiters" });
    observed = result.rows;
    if (observed.length >= minimum) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected ${minimum} runtime lock waiters for ${queryFragment}; observed ${
      JSON.stringify(observed)
    }`,
  );
}

async function waitForSharedAdvisoryLockWaiters(
  database: PostgreSqlTestDatabase,
  minimum: number,
): Promise<void> {
  let observed: readonly {
    readonly classid: number;
    readonly objid: number;
    readonly objsubid: number;
    readonly waiter_count: number;
    readonly blocking_pids: number[];
  }[] = [];
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = await database.migrator.query<{
      classid: number;
      objid: number;
      objsubid: number;
      waiter_pid: number;
      blocking_pids: number[];
    }>({
      text: `SELECT DISTINCT pending.classid,
                             pending.objid,
                             pending.objsubid,
                             activity.pid::pg_catalog.int4 AS waiter_pid,
                             pg_catalog.pg_blocking_pids(activity.pid)
                               AS blocking_pids
             FROM pg_catalog.pg_stat_activity AS activity
             INNER JOIN pg_catalog.pg_locks AS pending
               ON pending.pid = activity.pid
              AND pending.locktype = 'advisory'
              AND NOT pending.granted
             WHERE activity.datname = pg_catalog.current_database()
               AND activity.usename = 'lcm_test_runtime'
               AND activity.state = 'active'
               AND activity.wait_event_type = 'Lock'
             ORDER BY pending.classid, pending.objid, pending.objsubid,
                      waiter_pid`,
    }, { domain: "summaries", operation: "waitForSharedAdvisoryLockWaiters" });
    const byIdentity = new Map<string, {
      classid: number;
      objid: number;
      objsubid: number;
      waiter_pids: number[];
      blocking_pids: number[];
    }>();
    for (const row of result.rows) {
      const identity = `${row.classid}:${row.objid}:${row.objsubid}`;
      const aggregate = byIdentity.get(identity) ?? {
        classid: row.classid,
        objid: row.objid,
        objsubid: row.objsubid,
        waiter_pids: [],
        blocking_pids: [],
      };
      aggregate.waiter_pids.push(row.waiter_pid);
      aggregate.blocking_pids.push(...row.blocking_pids);
      byIdentity.set(identity, aggregate);
    }
    observed = [...byIdentity.values()].map((row) => ({
      classid: row.classid,
      objid: row.objid,
      objsubid: row.objsubid,
      waiter_count: new Set(row.waiter_pids).size,
      blocking_pids: [...new Set(row.blocking_pids)].sort((left, right) => (
        left - right
      )),
    }));
    if (observed.some((row) => (
      row.waiter_count >= minimum
      && new Set(row.blocking_pids).size >= 1
    ))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected ${minimum} waiters for one advisory lock identity; observed ${
      JSON.stringify(observed)
    }`,
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("PostgreSQL 18 summary, context, and large-file repositories", () => {
  it("denies access before grants and admits only the reviewed least-privilege ACLs", async () => {
    await withPostgreSqlTestDatabase("summary-grants", async (database) => {
      const projectId = await createProject(database, "Summary grants");
      const conversationId = await createConversationAsMigrator(
        database,
        projectId,
        "summary-grants-session",
      );
      const messageId = await createMessageAsMigrator(
        database,
        projectId,
        conversationId,
        0,
      );
      const scoped = repositories(database, projectId);

      await expect(scoped.summaries.getSummary("denied-summary"))
        .rejects.toMatchObject({
          backend: "postgresql",
          domain: "summaries",
          operation: "getSummary",
          projectId,
        });
      await expect(scoped.context.getContextItems(conversationId))
        .rejects.toMatchObject({
          backend: "postgresql",
          domain: "context",
          operation: "getContextItems",
          projectId,
        });
      await expect(scoped.largeFiles.getLargeFile("denied-file"))
        .rejects.toMatchObject({
          backend: "postgresql",
          domain: "large-files",
          operation: "getLargeFile",
          projectId,
        });

      await grantSummaryContextRuntimePrivileges(database);

      const tablePrivileges = await database.migrator.query<{
        grant_key: string;
      }>({
        text: `SELECT relation.relname
                        OPERATOR(pg_catalog.||) ':'
                        OPERATOR(pg_catalog.||) privilege.privilege_type
                        OPERATOR(pg_catalog.||) ':'
                        OPERATOR(pg_catalog.||)
                          privilege.is_grantable::pg_catalog.text AS grant_key
               FROM pg_catalog.pg_class AS relation
               INNER JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 COALESCE(
                   relation.relacl,
                   pg_catalog.acldefault('r', relation.relowner)
                 )
               ) AS privilege
               WHERE namespace.nspname = 'lcm'
                 AND relation.relname = ANY($1::pg_catalog.text[])
                 AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
               ORDER BY grant_key`,
        values: [[...SUMMARY_CONTEXT_TABLES]],
      }, { domain: "summaries", operation: "inspectSummaryTablePrivileges" });
      expect(tablePrivileges.rows.map((row) => row.grant_key)).toEqual(sorted([
        ...SUMMARY_CONTEXT_TABLES.map((table) => `${table}:SELECT:false`),
        "context_items:DELETE:false",
      ]));

      const columnPrivileges = await database.migrator.query<{
        grant_key: string;
      }>({
        text: `SELECT relation.relname
                        OPERATOR(pg_catalog.||) '.'
                        OPERATOR(pg_catalog.||) attribute.attname
                        OPERATOR(pg_catalog.||) ':'
                        OPERATOR(pg_catalog.||) privilege.privilege_type
                        OPERATOR(pg_catalog.||) ':'
                        OPERATOR(pg_catalog.||)
                          privilege.is_grantable::pg_catalog.text AS grant_key
               FROM pg_catalog.pg_class AS relation
               INNER JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               INNER JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid = relation.oid
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 attribute.attacl
               ) AS privilege
               WHERE namespace.nspname = 'lcm'
                 AND relation.relname = ANY($1::pg_catalog.text[])
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
                 AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
               ORDER BY grant_key`,
        values: [[...SUMMARY_CONTEXT_TABLES]],
      }, { domain: "summaries", operation: "inspectSummaryColumnPrivileges" });
      expect(columnPrivileges.rows.map((row) => row.grant_key)).toEqual(sorted([
        "summaries.summary_id:INSERT:false",
        "summaries.project_id:INSERT:false",
        "summaries.conversation_id:INSERT:false",
        "summaries.kind:INSERT:false",
        "summaries.depth:INSERT:false",
        "summaries.content:INSERT:false",
        "summaries.token_count:INSERT:false",
        "summaries.earliest_at:INSERT:false",
        "summaries.latest_at:INSERT:false",
        "summaries.descendant_count:INSERT:false",
        "summaries.descendant_token_count:INSERT:false",
        "summaries.source_message_token_count:INSERT:false",
        "summary_messages.project_id:INSERT:false",
        "summary_messages.conversation_id:INSERT:false",
        "summary_messages.summary_key:INSERT:false",
        "summary_messages.message_id:INSERT:false",
        "summary_messages.ordinal:INSERT:false",
        "summary_parents.project_id:INSERT:false",
        "summary_parents.conversation_id:INSERT:false",
        "summary_parents.summary_key:INSERT:false",
        "summary_parents.parent_summary_key:INSERT:false",
        "summary_parents.ordinal:INSERT:false",
        "summary_large_files.project_id:INSERT:false",
        "summary_large_files.conversation_id:INSERT:false",
        "summary_large_files.summary_key:INSERT:false",
        "summary_large_files.file_id:INSERT:false",
        "summary_large_files.ordinal:INSERT:false",
        "context_items.project_id:INSERT:false",
        "context_items.conversation_id:INSERT:false",
        "context_items.ordinal:INSERT:false",
        "context_items.item_type:INSERT:false",
        "context_items.message_id:INSERT:false",
        "context_items.summary_key:INSERT:false",
        "context_items.ordinal:UPDATE:false",
        "large_files.file_id:INSERT:false",
        "large_files.project_id:INSERT:false",
        "large_files.conversation_id:INSERT:false",
        "large_files.file_name:INSERT:false",
        "large_files.mime_type:INSERT:false",
        "large_files.byte_size:INSERT:false",
        "large_files.storage_uri:INSERT:false",
        "large_files.exploration_summary:INSERT:false",
      ]));

      const boundary = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        any_sequence: boolean;
        normalize_execute: boolean;
        normalize_public_execute: boolean;
        cycle_execute: boolean;
        cycle_public_execute: boolean;
        owns_relation: boolean;
        any_truncate: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'USAGE'
                 ) AS schema_usage,
                 has_schema_privilege(
                   'lcm_test_runtime', 'lcm', 'CREATE'
                 ) AS schema_create,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_class AS sequence
                   INNER JOIN pg_catalog.pg_namespace AS namespace
                     ON namespace.oid = sequence.relnamespace
                   WHERE namespace.nspname = 'lcm'
                     AND sequence.relkind = 'S'
                     AND has_sequence_privilege(
                       'lcm_test_runtime', sequence.oid, 'USAGE'
                     )
                 ) AS any_sequence,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'lcm.normalize_search_text(text)',
                   'EXECUTE'
                 ) AS normalize_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     COALESCE(
                       procedure.proacl,
                       pg_catalog.acldefault('f', procedure.proowner)
                     )
                   ) AS privilege
                   WHERE procedure.oid =
                     'lcm.normalize_search_text(text)'::pg_catalog.regprocedure
                     AND privilege.grantee = 0
                     AND privilege.privilege_type = 'EXECUTE'
                 ) AS normalize_public_execute,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'lcm.enforce_summary_parent_dag_integrity()',
                   'EXECUTE'
                 ) AS cycle_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     COALESCE(
                       procedure.proacl,
                       pg_catalog.acldefault('f', procedure.proowner)
                     )
                   ) AS privilege
                   WHERE procedure.oid =
                     'lcm.enforce_summary_parent_dag_integrity()'
                       ::pg_catalog.regprocedure
                     AND privilege.grantee = 0
                     AND privilege.privilege_type = 'EXECUTE'
                 ) AS cycle_public_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_class AS relation
                   INNER JOIN pg_catalog.pg_namespace AS namespace
                     ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname = 'lcm'
                     AND relation.relname = ANY($1::pg_catalog.text[])
                     AND relation.relowner =
                       'lcm_test_runtime'::pg_catalog.regrole
                 ) AS owns_relation,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_class AS relation
                   INNER JOIN pg_catalog.pg_namespace AS namespace
                     ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname = 'lcm'
                     AND relation.relname = ANY($1::pg_catalog.text[])
                     AND has_table_privilege(
                       'lcm_test_runtime', relation.oid, 'TRUNCATE'
                     )
                 ) AS any_truncate`,
        values: [[...SUMMARY_CONTEXT_TABLES]],
      }, { domain: "summaries", operation: "inspectSummaryPrivilegeBoundary" });
      expect(boundary.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        any_sequence: false,
        normalize_execute: true,
        normalize_public_execute: false,
        cycle_execute: false,
        cycle_public_execute: false,
        owns_relation: false,
        any_truncate: false,
      });

      await createSummary(
        scoped.summaries,
        conversationId,
        "granted-summary",
      );
      await expect(scoped.context.appendContextMessage(
        conversationId,
        messageId,
      )).resolves.toBeUndefined();
      await expect(scoped.largeFiles.insertLargeFile({
        fileId: "granted-file",
        conversationId,
        storageUri: "lcm://grants/file",
      })).resolves.toMatchObject({ fileId: "granted-file", conversationId });
    });
  });

  it("passes all three shared conformance adapters", async () => {
    await withPostgreSqlTestDatabase("summary-conform", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      const projectId = await createProject(database, "Summary conformance");
      const result = await exerciseSummaryContextRepositoryConformance(
        repositories(database, projectId),
        "postgresql-summary-context",
      );

      expect(result.summaries.subtree).toHaveLength(13);
      expect(result.context.map((item) => item.ordinal)).toEqual([0, 1, 2, 3]);
      expect(result.largeFiles).toHaveLength(2);
      expect(result.summaries.inserted.root.fileIds).toEqual([
        "postgresql-summary-context:unresolved:alpha?revision=7",
        "  opaque file id with surrounding whitespace  ",
        "postgresql-summary-context:unresolved:alpha?revision=7",
        "postgresql-summary-context:unicode:資料/δ",
      ]);
    });
  });

  it("rolls back the summary when ordered file-reference insertion fails", async () => {
    await withPostgreSqlTestDatabase("summary-ref-rollback", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      const projectId = await createProject(
        database,
        "Summary file-reference rollback",
      );
      const scoped = repositories(database, projectId);
      const conversation = await scoped.conversations.createConversation({
        sessionId: "summary-file-reference-rollback",
      });
      await database.migrator.query({
        text: `REVOKE INSERT (
                 project_id,
                 conversation_id,
                 summary_key,
                 file_id,
                 ordinal
               )
               ON TABLE lcm.summary_large_files
               FROM lcm_test_runtime`,
      }, { domain: "summaries", operation: "denySummaryFileReferenceInsert" });
      try {
        await expect(scoped.summaries.insertSummary({
          conversationId: conversation.conversationId,
          summaryId: "summary-reference-rollback",
          kind: "condensed",
          depth: 2,
          content: "the second statement must fail",
          tokenCount: 5,
          fileIds: [
            "unresolved-reference",
            "unresolved-reference",
            "  opaque reference  ",
          ],
        })).rejects.toMatchObject({
          backend: "postgresql",
          domain: "summaries",
          operation: "insertSummary",
        });
        expect(await scoped.summaries.getSummary(
          "summary-reference-rollback",
        )).toBeNull();
        const residue = await database.migrator.query<{
          summary_count: number;
          reference_count: number;
        }>({
          text: `SELECT
                   (
                     SELECT COUNT(*)::pg_catalog.int4
                     FROM lcm.summaries
                     WHERE project_id = $1
                       AND summary_id = $2
                   ) AS summary_count,
                   (
                     SELECT COUNT(*)::pg_catalog.int4
                     FROM lcm.summary_large_files AS reference
                     INNER JOIN lcm.summaries AS summary
                       ON summary.project_id = reference.project_id
                      AND summary.conversation_id = reference.conversation_id
                      AND summary.summary_key = reference.summary_key
                     WHERE summary.project_id = $1
                       AND summary.summary_id = $2
                   ) AS reference_count`,
          values: [projectId, "summary-reference-rollback"],
        }, { domain: "summaries", operation: "inspectSummaryReferenceRollback" });
        expect(residue.rows[0]).toEqual({
          summary_count: 0,
          reference_count: 0,
        });
      } finally {
        await grantSummaryContextRuntimePrivileges(database);
      }

      const restored = await scoped.summaries.insertSummary({
        conversationId: conversation.conversationId,
        summaryId: "summary-reference-restored",
        kind: "leaf",
        content: "restored grants",
        tokenCount: 2,
        fileIds: ["opaque", "opaque"],
      });
      expect(restored.fileIds).toEqual(["opaque", "opaque"]);
      expect((await scoped.summaries.getSummary(
        "summary-reference-restored",
      ))?.fileIds).toEqual(["opaque", "opaque"]);
    });
  });

  it("rolls back invalid graph batches and rejects self, general, and trigger-detected cycles", async () => {
    await withPostgreSqlTestDatabase("summary-graph", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      const projectId = await createProject(database, "Summary graph");
      const scoped = repositories(database, projectId);
      const primary = await scoped.conversations.createConversation({
        sessionId: "summary-graph-primary",
      });
      const secondary = await scoped.conversations.createConversation({
        sessionId: "summary-graph-secondary",
      });
      const primaryMessages = await scoped.conversations.createMessagesBulk([
        {
          conversationId: primary.conversationId,
          seq: 0,
          role: "user",
          content: "zero",
          tokenCount: 1,
        },
        {
          conversationId: primary.conversationId,
          seq: 1,
          role: "assistant",
          content: "one",
          tokenCount: 2,
        },
      ]);
      const secondaryMessage = await scoped.conversations.createMessage({
        conversationId: secondary.conversationId,
        seq: 0,
        role: "user",
        content: "foreign",
        tokenCount: 1,
      });
      for (const [summaryId, conversationId] of [
        ["graph-a", primary.conversationId],
        ["graph-b", primary.conversationId],
        ["graph-c", primary.conversationId],
        ["graph-d", primary.conversationId],
        ["graph-foreign", secondary.conversationId],
      ] as const) {
        await createSummary(scoped.summaries, conversationId, summaryId);
      }

      await expect(scoped.summaries.linkSummaryToMessages("graph-a", [
        primaryMessages[0].messageId,
        Number.MAX_SAFE_INTEGER,
      ])).rejects.toMatchObject({
        entity: "message",
        operation: "linkSummaryToMessages",
      });
      expect(await scoped.summaries.getSummaryMessages("graph-a")).toEqual([]);

      await expect(scoped.summaries.linkSummaryToMessages("graph-a", [
        primaryMessages[0].messageId,
        secondaryMessage.messageId,
      ])).rejects.toBeInstanceOf(PostgreSqlSummaryContextNotFoundError);
      expect(await scoped.summaries.getSummaryMessages("graph-a")).toEqual([]);

      await expect(scoped.summaries.linkSummaryToMessages("graph-a", [
        primaryMessages[0].messageId,
        primaryMessages[0].messageId,
      ])).rejects.toMatchObject({ conflict: "duplicate" });
      expect(await scoped.summaries.getSummaryMessages("graph-a")).toEqual([]);

      await scoped.summaries.linkSummaryToMessages("graph-a", [
        primaryMessages[0].messageId,
      ]);
      await expect(scoped.summaries.linkSummaryToMessages("graph-a", [
        primaryMessages[1].messageId,
        primaryMessages[0].messageId,
      ])).rejects.toMatchObject({ conflict: "integrity" });
      expect(await scoped.summaries.getSummaryMessages("graph-a")).toEqual([
        primaryMessages[0].messageId,
      ]);

      await expect(scoped.summaries.linkSummaryToParents(
        "graph-c",
        ["graph-b", "missing-parent"],
      )).rejects.toMatchObject({ entity: "summary" });
      expect(await scoped.summaries.getSummaryParents("graph-c")).toEqual([]);

      await expect(scoped.summaries.linkSummaryToParents(
        "graph-c",
        ["graph-b", "graph-foreign"],
      )).rejects.toMatchObject({ conflict: "cross-conversation" });
      expect(await scoped.summaries.getSummaryParents("graph-c")).toEqual([]);
      await expect(scoped.context.appendContextSummary(
        primary.conversationId,
        "graph-foreign",
      )).rejects.toMatchObject({ conflict: "cross-conversation" });
      expect(await scoped.context.getContextItems(primary.conversationId))
        .toEqual([]);

      await expect(scoped.summaries.linkSummaryToParents(
        "graph-c",
        ["graph-b", "graph-b"],
      )).rejects.toMatchObject({ conflict: "duplicate" });
      expect(await scoped.summaries.getSummaryParents("graph-c")).toEqual([]);

      await expect(scoped.summaries.linkSummaryToParents(
        "graph-c",
        ["graph-c"],
      )).rejects.toMatchObject({ conflict: "cycle" });
      expect(await scoped.summaries.getSummaryParents("graph-c")).toEqual([]);

      await scoped.summaries.linkSummaryToParents("graph-b", ["graph-a"]);
      await expect(scoped.summaries.linkSummaryToParents(
        "graph-a",
        ["graph-b"],
      )).rejects.toBeInstanceOf(PostgreSqlSummaryContextConflictError);
      await expect(scoped.summaries.linkSummaryToParents(
        "graph-a",
        ["graph-b"],
      )).rejects.toMatchObject({ conflict: "cycle" });
      expect(await scoped.summaries.getSummaryParents("graph-a")).toEqual([]);

      const keys = await database.migrator.query<{
        summary_id: string;
        summary_key: string;
      }>({
        text: `SELECT summary_id, summary_key
               FROM lcm.summaries
               WHERE project_id = $1
                 AND summary_id IN ('graph-a', 'graph-b')`,
        values: [projectId],
      }, { domain: "summaries", operation: "inspectGraphKeys" });
      const keyById = new Map(
        keys.rows.map((row) => [row.summary_id, row.summary_key]),
      );
      await expect(database.runtime.query({
        text: `INSERT INTO lcm.summary_parents (
                 project_id, conversation_id, summary_key,
                 parent_summary_key, ordinal
               )
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          projectId,
          primary.conversationId,
          keyById.get("graph-a"),
          keyById.get("graph-b"),
        ],
      }, { domain: "summaries", operation: "directCyclicEdge", projectId }))
        .rejects.toMatchObject({ sqlState: "P0001" });
      expect(await scoped.summaries.getSummaryParents("graph-a")).toEqual([]);

      await scoped.summaries.linkSummaryToParents("graph-d", ["graph-a"]);
      await expect(scoped.summaries.linkSummaryToParents(
        "graph-d",
        ["graph-a", "graph-b"],
      )).rejects.toMatchObject({ conflict: "integrity" });
      expect((await scoped.summaries.getSummaryParents("graph-d"))
        .map((summary) => summary.summaryId)).toEqual(["graph-a"]);

      await createSummary(
        scoped.summaries,
        primary.conversationId,
        "race-a",
      );
      await createSummary(
        scoped.summaries,
        primary.conversationId,
        "race-b",
      );
      const raceFirstRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const raceSecondRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      let markBarrierHeld!: () => void;
      const barrierHeld = new Promise<void>((resolve) => {
        markBarrierHeld = resolve;
      });
      let releaseBarrier!: () => void;
      const barrierRelease = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const barrier = database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: `SELECT pg_catalog.pg_advisory_xact_lock(
                          pg_catalog.hashtextextended($1, 0)
                        )`,
          values: [
            derivePostgreSqlAdvisoryLockName(
              projectId,
              "conversation",
              primary.conversationId.toString(),
            ),
          ],
        }, { domain: "summaries", operation: "holdCycleRaceBarrier" });
        markBarrierHeld();
        await barrierRelease;
      }, { domain: "summaries", operation: "cycleRaceBarrier", projectId });
      await barrierHeld;
      try {
        const firstRace = new PostgreSqlSummaryRepository(
          raceFirstRuntime,
          projectId,
        );
        const secondRace = new PostgreSqlSummaryRepository(
          raceSecondRuntime,
          projectId,
        );
        const pendingRace = Promise.allSettled([
          firstRace.linkSummaryToParents("race-a", ["race-b"]),
          secondRace.linkSummaryToParents("race-b", ["race-a"]),
        ]);
        await waitForSharedAdvisoryLockWaiters(database, 2);
        releaseBarrier();
        await barrier;
        const outcomes = await pendingRace;
        const successes = outcomes.filter(
          (outcome) => outcome.status === "fulfilled",
        );
        const failures = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0].reason)
          .toBeInstanceOf(PostgreSqlSummaryContextConflictError);
        expect(failures[0].reason).toMatchObject({ conflict: "cycle" });

        const raceParents = await Promise.all([
          scoped.summaries.getSummaryParents("race-a"),
          scoped.summaries.getSummaryParents("race-b"),
        ]);
        expect(raceParents.flat()).toHaveLength(1);
        const cycleCount = await database.migrator.query<{ count: number }>({
          text: `WITH RECURSIVE parent_walk (
                   origin_summary_key,
                   current_summary_key
                 ) AS (
                   SELECT edge.summary_key, edge.parent_summary_key
                   FROM lcm.summary_parents AS edge
                   WHERE edge.project_id = $1
                     AND edge.conversation_id = $2
                     AND edge.summary_key = ANY($3::pg_catalog.uuid[])
                   UNION
                   SELECT walk.origin_summary_key, edge.parent_summary_key
                   FROM parent_walk AS walk
                   INNER JOIN lcm.summary_parents AS edge
                     ON edge.project_id = $1
                    AND edge.conversation_id = $2
                    AND edge.summary_key = walk.current_summary_key
                 )
                 SELECT COUNT(*)::pg_catalog.int4 AS count
                 FROM parent_walk
                 WHERE origin_summary_key = current_summary_key`,
          values: [
            projectId,
            primary.conversationId,
            (await database.migrator.query<{ summary_key: string }>({
              text: `SELECT summary_key
                     FROM lcm.summaries
                     WHERE project_id = $1
                       AND summary_id IN ('race-a', 'race-b')
                     ORDER BY summary_id`,
              values: [projectId],
            }, { domain: "summaries", operation: "findCycleRaceSummaryKeys" }))
              .rows.map((row) => row.summary_key),
          ],
        }, { domain: "summaries", operation: "inspectCycleRaceAcyclicity" });
        expect(cycleCount.rows[0].count).toBe(0);
      } finally {
        releaseBarrier();
        await Promise.allSettled([
          barrier,
          raceFirstRuntime.close(),
          raceSecondRuntime.close(),
        ]);
      }
    });
  });

  it("serializes concurrent context and graph mutations while invalid ranges roll back", async () => {
    await withPostgreSqlTestDatabase("summary-concur", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      const projectId = await createProject(database, "Summary concurrency");
      const firstRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const secondRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      try {
        const bootstrap = repositories(database, projectId);
        const conversation = await bootstrap.conversations.createConversation({
          sessionId: "summary-concurrency",
        });
        const messages = await bootstrap.conversations.createMessagesBulk(
          Array.from({ length: 8 }, (_, seq) => ({
            conversationId: conversation.conversationId,
            seq,
            role: seq % 2 === 0 ? "user" as const : "assistant" as const,
            content: `concurrent ${seq}`,
            tokenCount: seq + 1,
          })),
        );
        for (const id of [
          "replacement-first",
          "replacement-second",
          "graph-parent",
          "graph-child-a",
          "graph-child-b",
        ]) {
          await createSummary(bootstrap.summaries, conversation.conversationId, id);
        }
        const first = repositories(
          database,
          projectId,
          {},
          firstRuntime,
        );
        const second = repositories(
          database,
          projectId,
          {},
          secondRuntime,
        );

        await Promise.all([
          first.context.appendContextMessages(
            conversation.conversationId,
            messages.slice(0, 4).map((message) => message.messageId),
          ),
          second.context.appendContextMessages(
            conversation.conversationId,
            messages.slice(4).map((message) => message.messageId),
          ),
          first.summaries.linkSummaryToParents(
            "graph-child-a",
            ["graph-parent"],
          ),
          second.summaries.linkSummaryToParents(
            "graph-child-b",
            ["graph-parent"],
          ),
        ]);

        const appended = await bootstrap.context.getContextItems(
          conversation.conversationId,
        );
        expect(appended.map((item) => item.ordinal)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7,
        ]);
        const appendedIds = appended.map((item) => item.messageId);
        expect(new Set(appendedIds)).toEqual(new Set(
          messages.map((message) => message.messageId),
        ));
        const firstBatch = messages.slice(0, 4).map((message) => message.messageId);
        const secondBatch = messages.slice(4).map((message) => message.messageId);
        expect([
          [...firstBatch, ...secondBatch],
          [...secondBatch, ...firstBatch],
        ]).toContainEqual(appendedIds);

        const stableChildren = await bootstrap.summaries.getSummaryChildren(
          "graph-parent",
        );
        expect(await bootstrap.summaries.getSummaryChildren("graph-parent"))
          .toEqual(stableChildren);
        expect(new Set(stableChildren.map((summary) => summary.summaryId)))
          .toEqual(new Set(["graph-child-a", "graph-child-b"]));

        await expect(first.context.appendContextMessages(
          conversation.conversationId,
          [messages[0].messageId, Number.MAX_SAFE_INTEGER],
        )).rejects.toBeInstanceOf(PostgreSqlSummaryContextNotFoundError);
        expect(await bootstrap.context.getContextItems(
          conversation.conversationId,
        )).toEqual(appended);

        await expect(first.context.replaceContextRangeWithSummary({
          conversationId: conversation.conversationId,
          startOrdinal: 6,
          endOrdinal: 9,
          summaryId: "replacement-first",
        })).rejects.toMatchObject({ conflict: "range" });
        expect(await bootstrap.context.getContextItems(
          conversation.conversationId,
        )).toEqual(appended);

        await Promise.all([
          first.context.replaceContextRangeWithSummary({
            conversationId: conversation.conversationId,
            startOrdinal: 1,
            endOrdinal: 1,
            summaryId: "replacement-first",
          }),
          second.context.replaceContextRangeWithSummary({
            conversationId: conversation.conversationId,
            startOrdinal: 1,
            endOrdinal: 1,
            summaryId: "replacement-second",
          }),
        ]);
        const replaced = await bootstrap.context.getContextItems(
          conversation.conversationId,
        );
        expect(replaced.map((item) => item.ordinal)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7,
        ]);
        expect(replaced[1]).toMatchObject({
          itemType: "summary",
          summaryId: expect.stringMatching(
            /^replacement-(?:first|second)$/u,
          ),
        });
        expect(replaced.filter((item) => item.itemType === "summary"))
          .toHaveLength(1);
      } finally {
        await Promise.allSettled([
          firstRuntime.close(),
          secondRuntime.close(),
        ]);
      }
    });
  });

  it("enforces project/exact-ID scope, stable errors, safe integers, and optional final-write fences", async () => {
    await withPostgreSqlTestDatabase("summary-fence", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      await grantCoordinationRuntimePrivileges(database);
      const firstProjectId = await createProject(database, "Summary fence A");
      const secondProjectId = await createProject(database, "Summary fence B");
      const machineId = await createMachine(database, "Summary fence machine");
      const first = repositories(database, firstProjectId);
      const second = repositories(database, secondProjectId);
      const firstConversation = await first.conversations.createConversation({
        sessionId: "shared-exact-session",
      });
      const otherConversation = await first.conversations.createConversation({
        sessionId: "other-fence-session",
      });
      const secondConversation = await second.conversations.createConversation({
        sessionId: "shared-exact-session",
      });

      for (const [repository, conversationId, content] of [
        [first.summaries, firstConversation.conversationId, "first"],
        [second.summaries, secondConversation.conversationId, "second"],
      ] as const) {
        await repository.insertSummary({
          conversationId,
          summaryId: "shared exact summary id",
          kind: "leaf",
          content,
          tokenCount: 1,
        });
        await repository.insertSummary({
          conversationId,
          summaryId: "shared exact summary id ",
          kind: "leaf",
          content: `${content} residual`,
          tokenCount: 1,
        });
      }
      expect((await first.summaries.getSummary(
        "shared exact summary id",
      ))?.content).toBe("first");
      expect((await first.summaries.getSummary(
        "shared exact summary id ",
      ))?.content).toBe("first residual");
      expect((await second.summaries.getSummary(
        "shared exact summary id",
      ))?.content).toBe("second");
      expect(await first.summaries.getSummariesByConversation(
        secondConversation.conversationId,
      )).toEqual([]);

      await first.largeFiles.insertLargeFile({
        fileId: "shared exact file id",
        conversationId: firstConversation.conversationId,
        storageUri: "lcm://first",
      });
      await second.largeFiles.insertLargeFile({
        fileId: "shared exact file id",
        conversationId: secondConversation.conversationId,
        storageUri: "lcm://second",
      });
      expect((await first.largeFiles.getLargeFile(
        "shared exact file id",
      ))?.storageUri).toBe("lcm://first");
      expect((await second.largeFiles.getLargeFile(
        "shared exact file id",
      ))?.storageUri).toBe("lcm://second");

      await expect(first.summaries.listRecentSummaries(
        Number.MAX_SAFE_INTEGER + 1,
      )).rejects.toBeInstanceOf(PostgreSqlSummaryContextDataError);
      await expect(first.summaries.insertSummary({
        conversationId: firstConversation.conversationId,
        summaryId: "invalid\0summary",
        kind: "leaf",
        content: "invalid",
        tokenCount: 1,
      })).rejects.toMatchObject({ field: "summary_id" });
      await expect(first.summaries.insertSummary({
        conversationId: Number.MAX_SAFE_INTEGER,
        summaryId: "missing-conversation",
        kind: "leaf",
        content: "missing",
        tokenCount: 1,
      })).rejects.toBeInstanceOf(PostgreSqlSummaryContextNotFoundError);
      await expect(first.largeFiles.insertLargeFile({
        fileId: "missing-conversation-file",
        conversationId: Number.MAX_SAFE_INTEGER,
        storageUri: "lcm://missing-conversation",
      })).rejects.toMatchObject({
        entity: "conversation",
        operation: "insertLargeFile",
      });
      await expect(first.summaries.insertSummary({
        conversationId: firstConversation.conversationId,
        summaryId: "shared exact summary id",
        kind: "leaf",
        content: "duplicate",
        tokenCount: 1,
      })).rejects.toMatchObject({ conflict: "integrity" });
      await expect(first.summaries.insertSummary({
        conversationId: firstConversation.conversationId,
        summaryId: "invalid-high-\ud800",
        kind: "leaf",
        content: "invalid high surrogate",
        tokenCount: 1,
      })).rejects.toMatchObject({ field: "summary_id" });
      await expect(first.summaries.insertSummary({
        conversationId: firstConversation.conversationId,
        summaryId: "invalid-low",
        kind: "leaf",
        content: "invalid-low-\udc00",
        tokenCount: 1,
      })).rejects.toMatchObject({ field: "content" });
      const pairedSurrogate = await first.summaries.insertSummary({
        conversationId: firstConversation.conversationId,
        summaryId: "valid-pair-\ud83d\ude80",
        kind: "leaf",
        content: "valid pair \ud83d\ude80",
        tokenCount: 1,
        fileIds: ["valid-file-pair-\ud83d\ude80"],
      });
      expect(pairedSurrogate).toMatchObject({
        summaryId: "valid-pair-\ud83d\ude80",
        content: "valid pair \ud83d\ude80",
        fileIds: ["valid-file-pair-\ud83d\ude80"],
      });

      await createSummary(
        first.summaries,
        otherConversation.conversationId,
        "ordinal-exhaustion-existing",
      );
      await createSummary(
        first.summaries,
        otherConversation.conversationId,
        "ordinal-exhaustion-new",
      );
      const exhaustionKey = await database.migrator.query<{
        summary_key: string;
      }>({
        text: `SELECT summary_key
               FROM lcm.summaries
               WHERE project_id = $1
                 AND conversation_id = $2
                 AND summary_id = 'ordinal-exhaustion-existing'`,
        values: [firstProjectId, otherConversation.conversationId],
      }, { domain: "context", operation: "findOrdinalExhaustionSummary" });
      await database.migrator.query({
        text: `INSERT INTO lcm.context_items (
                 project_id, conversation_id, ordinal, item_type, summary_key
               )
               VALUES ($1, $2, 2147483647, 'summary', $3)`,
        values: [
          firstProjectId,
          otherConversation.conversationId,
          exhaustionKey.rows[0].summary_key,
        ],
      }, { domain: "context", operation: "seedContextOrdinalExhaustion" });
      await expect(first.context.appendContextSummary(
        otherConversation.conversationId,
        "ordinal-exhaustion-new",
      )).rejects.toMatchObject({
        name: "PostgreSqlSummaryContextDataError",
        domain: "context",
        operation: "appendContextSummary",
        field: "ordinal",
      });
      await expect(database.migrator.query<{
        count: number;
        minimum: number;
        maximum: number;
      }>({
        text: `SELECT COUNT(*)::pg_catalog.int4 AS count,
                      MIN(ordinal)::pg_catalog.int4 AS minimum,
                      MAX(ordinal)::pg_catalog.int4 AS maximum
               FROM lcm.context_items
               WHERE project_id = $1
                 AND conversation_id = $2`,
        values: [firstProjectId, otherConversation.conversationId],
      }, { domain: "context", operation: "inspectContextOrdinalExhaustion" }))
        .resolves.toMatchObject({
          rows: [{
            count: 1,
            minimum: 2_147_483_647,
            maximum: 2_147_483_647,
          }],
        });

      await database.migrator.query({
        text: `INSERT INTO lcm.large_files (
                 file_id, project_id, conversation_id, byte_size, storage_uri
               )
               VALUES ($1, $2, $3, $4::pg_catalog.int8, $5)`,
        values: [
          "unsafe-bigint-file",
          firstProjectId,
          firstConversation.conversationId,
          "9007199254740992",
          "lcm://unsafe-bigint",
        ],
      }, { domain: "large-files", operation: "seedUnsafeBigintFile" });
      await expect(first.largeFiles.getLargeFile("unsafe-bigint-file"))
        .rejects.toMatchObject({ field: "byte_size" });

      const coordinator = new PostgreSqlCoordinationRepository(
        database.runtime,
        firstProjectId,
        machineId,
      );
      const processId = "summary-context-final-write";
      const operation = "compact";
      await createSummary(
        first.summaries,
        firstConversation.conversationId,
        "fenced-parent",
      );
      await createSummary(
        first.summaries,
        firstConversation.conversationId,
        "fenced-child",
      );
      const fencedMessage = await first.conversations.createMessage({
        conversationId: firstConversation.conversationId,
        seq: 0,
        role: "user",
        content: "fenced context message",
        tokenCount: 3,
      });
      const lease = await coordinator.acquireLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        ttlMs: 60_000,
      });
      expect(lease).not.toBeNull();
      const fencedOptions = {
        fence: {
          machineId,
          processId,
          operation,
          fencingToken: lease!.fencingToken,
        },
      } satisfies PostgreSqlSummaryContextRepositoryOptions;
      const fenced = repositories(database, firstProjectId, fencedOptions);
      await fenced.summaries.linkSummaryToParents(
        "fenced-child",
        ["fenced-parent"],
      );
      expect((await first.summaries.getSummaryParents("fenced-child"))
        .map((summary) => summary.summaryId)).toEqual(["fenced-parent"]);
      await fenced.context.appendContextMessage(
        firstConversation.conversationId,
        fencedMessage.messageId,
      );
      expect(await first.context.getContextItems(
        firstConversation.conversationId,
      )).toMatchObject([{
        ordinal: 0,
        itemType: "message",
        messageId: fencedMessage.messageId,
      }]);

      await expectLeaseFenceFailure(createSummary(
        fenced.summaries,
        otherConversation.conversationId,
        "fenced-wrong-conversation",
      ), {
        projectId: firstProjectId,
        machineId,
        fencingToken: lease!.fencingToken,
      });
      expect(await first.summaries.getSummary("fenced-wrong-conversation"))
        .toBeNull();

      await expect(coordinator.releaseLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        fencingToken: lease!.fencingToken,
      })).resolves.toMatchObject({ releasedAt: expect.any(String) });
      await expectLeaseFenceFailure(createSummary(
        fenced.summaries,
        firstConversation.conversationId,
        "fenced-released",
      ), {
        projectId: firstProjectId,
        machineId,
        fencingToken: lease!.fencingToken,
      });
      expect(await first.summaries.getSummary("fenced-released")).toBeNull();

      const successor = await coordinator.acquireLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        ttlMs: 60_000,
      });
      expect(successor!.fencingToken).toBeGreaterThan(lease!.fencingToken);
      await expectLeaseFenceFailure(createSummary(
        fenced.summaries,
        firstConversation.conversationId,
        "fenced-stale",
      ), {
        projectId: firstProjectId,
        machineId,
        fencingToken: lease!.fencingToken,
      });
      expect(await first.summaries.getSummary("fenced-stale")).toBeNull();

      const successorOptions = {
        fence: {
          machineId,
          processId,
          operation,
          fencingToken: successor!.fencingToken,
        },
      } satisfies PostgreSqlSummaryContextRepositoryOptions;
      const current = repositories(
        database,
        firstProjectId,
        successorOptions,
      );
      await createSummary(
        current.summaries,
        firstConversation.conversationId,
        "fenced-successor",
      );
      expect(await first.summaries.getSummary("fenced-successor")).not.toBeNull();

      await expect(coordinator.releaseLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        fencingToken: successor!.fencingToken,
      })).resolves.toMatchObject({ releasedAt: expect.any(String) });
      const expiring = await coordinator.acquireLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        ttlMs: 1,
      });
      expect(expiring!.fencingToken).toBeGreaterThan(
        successor!.fencingToken,
      );
      await database.migrator.query({
        text: "SELECT pg_catalog.pg_sleep(0.02)",
      }, { domain: "coordination", operation: "waitForSummaryContextLeaseExpiry" });
      const expired = repositories(database, firstProjectId, {
        fence: {
          machineId,
          processId,
          operation,
          fencingToken: expiring!.fencingToken,
        },
      });
      await expectLeaseFenceFailure(createSummary(
        expired.summaries,
        firstConversation.conversationId,
        "fenced-expired",
      ), {
        projectId: firstProjectId,
        machineId,
        fencingToken: expiring!.fencingToken,
      });
      expect(await first.summaries.getSummary("fenced-expired")).toBeNull();

      const finalLease = await coordinator.acquireLease({
        resourceType: "conversation",
        resourceKey: firstConversation.conversationId.toString(),
        processId,
        operation,
        ttlMs: 60_000,
      });
      expect(finalLease!.fencingToken).toBeGreaterThan(
        expiring!.fencingToken,
      );
      const raceMessage = await first.conversations.createMessage({
        conversationId: firstConversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "post-validation fence race",
        tokenCount: 5,
      });
      const writeRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      const releaseRuntime = new PostgreSqlRuntime(settings(database.runtimeUrl));
      let markContextTableLocked!: () => void;
      const contextTableLocked = new Promise<void>((resolve) => {
        markContextTableLocked = resolve;
      });
      let releaseContextTable!: () => void;
      const contextTableRelease = new Promise<void>((resolve) => {
        releaseContextTable = resolve;
      });
      const contextTableBlocker = database.migrator.transaction(
        async (transaction) => {
          await transaction.query({
            text: "LOCK TABLE lcm.context_items IN ACCESS EXCLUSIVE MODE",
          }, { domain: "context", operation: "holdPostFenceContextWrite" });
          markContextTableLocked();
          await contextTableRelease;
        },
        {
          domain: "context",
          operation: "postFenceContextWriteBarrier",
          projectId: firstProjectId,
        },
      );
      await contextTableLocked;
      try {
        const raceFence = {
          machineId,
          processId,
          operation,
          fencingToken: finalLease!.fencingToken,
        };
        const raceContext = new PostgreSqlContextRepository(
          writeRuntime,
          firstProjectId,
          { fence: raceFence },
        );
        const pendingWrite = raceContext.appendContextMessage(
          firstConversation.conversationId,
          raceMessage.messageId,
        );
        await waitForRuntimeLockWaiters(
          database,
          "COALESCE(MAX(ordinal), -1)",
          1,
        );

        const releaseCoordinator = new PostgreSqlCoordinationRepository(
          releaseRuntime,
          firstProjectId,
          machineId,
        );
        const pendingRelease = releaseCoordinator.releaseLease({
          resourceType: "conversation",
          resourceKey: firstConversation.conversationId.toString(),
          processId,
          operation,
          fencingToken: finalLease!.fencingToken,
        });
        await waitForRuntimeLockWaiters(
          database,
          "UPDATE lcm.fenced_leases",
          1,
        );
        releaseContextTable();
        await contextTableBlocker;
        await expect(pendingWrite).resolves.toBeUndefined();
        await expect(pendingRelease).resolves.toMatchObject({
          fencingToken: finalLease!.fencingToken,
          releasedAt: expect.any(String),
        });
        const postRaceContext = await first.context.getContextItems(
          firstConversation.conversationId,
        );
        expect(postRaceContext.at(-1)).toMatchObject({
          itemType: "message",
          messageId: raceMessage.messageId,
        });
      } finally {
        releaseContextTable();
        await Promise.allSettled([
          contextTableBlocker,
          writeRuntime.close(),
          releaseRuntime.close(),
        ]);
      }
    });
  });

  it("uses the exact-ID and recursive-edge indexes for bounded DAG plans", async () => {
    await withPostgreSqlTestDatabase("summary-plans", async (database) => {
      await grantRepositoryRuntimePrivileges(database);
      const projectId = await createProject(database, "Summary plans");
      const scoped = repositories(database, projectId);
      const conversation = await scoped.conversations.createConversation({
        sessionId: "summary-plans-session",
      });
      await createSummary(
        scoped.summaries,
        conversation.conversationId,
        "plan-root",
      );
      for (let index = 0; index < 12; index += 1) {
        const childId = `plan-child-${index.toString().padStart(2, "0")}`;
        await createSummary(
          scoped.summaries,
          conversation.conversationId,
          childId,
          0,
        );
        await scoped.summaries.linkSummaryToParents(childId, ["plan-root"]);
      }
      const root = await database.migrator.query<{ summary_key: string }>({
        text: `SELECT summary_key
               FROM lcm.summaries
               WHERE project_id = $1
                 AND summary_id_sha256 = public.digest($2, 'sha256')
                 AND summary_id = $2`,
        values: [projectId, "plan-root"],
      }, { domain: "summaries", operation: "findPlanRoot" });

      const plans = await database.migrator.transaction(
        async (transaction) => {
          await transaction.query({
            text: "SET LOCAL enable_seqscan = off",
          }, { domain: "summaries", operation: "forceSummaryIndexPlans" });
          const identity = await transaction.query<{ "QUERY PLAN": unknown }>({
            text: `EXPLAIN (FORMAT JSON, COSTS OFF)
                   SELECT summary_key
                   FROM lcm.summaries
                   WHERE project_id = $1
                     AND summary_id_sha256 = public.digest($2, 'sha256')
                     AND summary_id = $2
                   ORDER BY summary_key
                   LIMIT 2`,
            values: [projectId, "plan-root"],
          }, { domain: "summaries", operation: "explainSummaryIdentity" });
          const recursive = await transaction.query<{ "QUERY PLAN": unknown }>({
            text: `EXPLAIN (FORMAT JSON, COSTS OFF)
                   WITH RECURSIVE reachable(summary_key) AS (
                     SELECT $3::pg_catalog.uuid
                     UNION
                     SELECT edge.summary_key
                     FROM lcm.summary_parents AS edge
                     INNER JOIN reachable AS parent
                       ON edge.parent_summary_key = parent.summary_key
                     WHERE edge.project_id = $1
                       AND edge.conversation_id = $2
                   ),
                   reachable_edges AS (
                     SELECT edge.summary_key, edge.parent_summary_key,
                            edge.ordinal
                     FROM lcm.summary_parents AS edge
                     INNER JOIN reachable AS child
                       ON child.summary_key = edge.summary_key
                     INNER JOIN reachable AS parent
                       ON parent.summary_key = edge.parent_summary_key
                     WHERE edge.project_id = $1
                       AND edge.conversation_id = $2
                   )
                   SELECT s.summary_key,
                          s.summary_id, s.conversation_id, s.kind, s.depth,
                          s.content, s.token_count, s.earliest_at, s.latest_at,
                          s.descendant_count, s.descendant_token_count,
                          s.source_message_token_count, s.created_at,
                          COALESCE((
                            SELECT pg_catalog.jsonb_agg(
                              files.file_id ORDER BY files.ordinal
                            )
                            FROM lcm.summary_large_files AS files
                            WHERE files.project_id = s.project_id
                              AND files.conversation_id = s.conversation_id
                              AND files.summary_key = s.summary_key
                          ), '[]'::pg_catalog.jsonb) AS file_ids,
                          edge.parent_summary_key AS edge_parent_summary_key,
                          edge.ordinal AS edge_ordinal
                   FROM reachable
                   INNER JOIN lcm.summaries AS s
                     ON s.project_id = $1
                     AND s.conversation_id = $2
                     AND s.summary_key = reachable.summary_key
                   LEFT JOIN reachable_edges AS edge
                     ON edge.summary_key = s.summary_key
                   ORDER BY s.summary_key, edge.ordinal,
                            edge.parent_summary_key`,
            values: [
              projectId,
              conversation.conversationId,
              root.rows[0].summary_key,
            ],
          }, { domain: "summaries", operation: "explainSummarySubtree" });
          return {
            identity: JSON.stringify(identity.rows[0]["QUERY PLAN"]),
            recursive: JSON.stringify(recursive.rows[0]["QUERY PLAN"]),
          };
        },
        {
          domain: "summaries",
          operation: "explainSummaryPlans",
          projectId,
        },
      );
      expect(plans.identity).toContain("summaries_identity_lookup_idx");
      expect(plans.recursive).toContain("summary_parents_parent_idx");

      const first = await scoped.summaries.getSummarySubtree("plan-root");
      expect(await scoped.summaries.getSummarySubtree("plan-root"))
        .toEqual(first);
      expect(first).toHaveLength(13);
      expect(first.map((node) => node.summaryId)).toEqual([
        "plan-root",
        ...Array.from(
          { length: 12 },
          (_, index) => `plan-child-${index.toString().padStart(2, "0")}`,
        ),
      ]);
      expect(first[0]).toMatchObject({
        summaryId: "plan-root",
        depthFromRoot: 0,
        parentSummaryId: null,
        path: "",
        childCount: 12,
      });
      expect(first.slice(1).map((node) => ({
        summaryId: node.summaryId,
        depthFromRoot: node.depthFromRoot,
        parentSummaryId: node.parentSummaryId,
        path: node.path,
        childCount: node.childCount,
      }))).toEqual(Array.from({ length: 12 }, (_, index) => ({
        summaryId: `plan-child-${index.toString().padStart(2, "0")}`,
        depthFromRoot: 1,
        parentSummaryId: "plan-root",
        path: "0000",
        childCount: 0,
      })));
    });
  });
});
