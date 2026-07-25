import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PostgreSqlConversationExecutor,
  PostgreSqlConversationRepository,
} from "../../src/storage/postgresql/conversation-repository.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";
import { exerciseConversationRepositoryConformance } from "../storage/conversation-conformance.js";

beforeAll(assertHarnessReady);

async function grantConversationRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-conversation-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "conversations",
    operation: "grantConversationRuntimePrivileges",
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
  }, { domain: "identity", operation: "createConversationTestProject" });
  return result.rows[0].project_id;
}

describe("PostgreSQL 18 conversation repository", () => {
  it("requires the reviewed grants and preserves their least-privilege boundary", async () => {
    await withPostgreSqlTestDatabase("conversation-grants", async (database) => {
      const projectId = await createProject(database, "Conversation grants");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      await expect(repository.createConversation({ sessionId: "denied-secret" }))
        .rejects.toMatchObject({
          backend: "postgresql",
          domain: "conversations",
          operation: "createConversation",
          projectId,
        });

      await grantConversationRuntimePrivileges(database);
      await expect(repository.createConversation({ sessionId: "granted" }))
        .resolves.toMatchObject({ sessionId: "granted" });

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        conversations_select: boolean;
        conversations_insert: boolean;
        conversations_title_insert: boolean;
        conversations_title_update: boolean;
        conversations_sequence_usage: boolean;
        conversations_sequence_select: boolean;
        messages_select: boolean;
        messages_delete: boolean;
        messages_insert: boolean;
        messages_content_insert: boolean;
        messages_content_update: boolean;
        messages_sequence_usage: boolean;
        parts_select: boolean;
        parts_insert: boolean;
        parts_metadata_insert: boolean;
        parts_delete: boolean;
        summaries_select: boolean;
        summaries_delete: boolean;
        context_select: boolean;
        context_delete: boolean;
        context_update: boolean;
        normalize_execute: boolean;
        normalize_public_execute: boolean;
        normalize_grant_option: boolean;
        normalize_foreign_grantor: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'USAGE') AS schema_usage,
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'CREATE') AS schema_create,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'SELECT') AS conversations_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.conversations', 'INSERT') AS conversations_insert,
                 has_column_privilege('lcm_test_runtime', 'lcm.conversations', 'title', 'INSERT') AS conversations_title_insert,
                 has_column_privilege('lcm_test_runtime', 'lcm.conversations', 'title', 'UPDATE') AS conversations_title_update,
                 has_sequence_privilege('lcm_test_runtime', 'lcm.conversations_conversation_id_seq', 'USAGE') AS conversations_sequence_usage,
                 has_sequence_privilege('lcm_test_runtime', 'lcm.conversations_conversation_id_seq', 'SELECT') AS conversations_sequence_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.messages', 'SELECT') AS messages_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.messages', 'DELETE') AS messages_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.messages', 'INSERT') AS messages_insert,
                 has_column_privilege('lcm_test_runtime', 'lcm.messages', 'content', 'INSERT') AS messages_content_insert,
                 has_column_privilege('lcm_test_runtime', 'lcm.messages', 'content', 'UPDATE') AS messages_content_update,
                 has_sequence_privilege('lcm_test_runtime', 'lcm.messages_message_id_seq', 'USAGE') AS messages_sequence_usage,
                 has_table_privilege('lcm_test_runtime', 'lcm.message_parts', 'SELECT') AS parts_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.message_parts', 'INSERT') AS parts_insert,
                 has_column_privilege('lcm_test_runtime', 'lcm.message_parts', 'metadata', 'INSERT') AS parts_metadata_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.message_parts', 'DELETE') AS parts_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.summary_messages', 'SELECT') AS summaries_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.summary_messages', 'DELETE') AS summaries_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.context_items', 'SELECT') AS context_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.context_items', 'DELETE') AS context_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.context_items', 'UPDATE') AS context_update,
                 has_function_privilege(
                   'lcm_test_runtime',
                   'lcm.normalize_search_text(text)',
                   'EXECUTE'
                 ) AS normalize_execute,
                 has_function_privilege(
                   'public',
                   'lcm.normalize_search_text(text)',
                   'EXECUTE'
                 ) AS normalize_public_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
                   WHERE procedure.oid = 'lcm.normalize_search_text(text)'::pg_catalog.regprocedure
                     AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.is_grantable
                 ) AS normalize_grant_option,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
                   WHERE procedure.oid = 'lcm.normalize_search_text(text)'::pg_catalog.regprocedure
                     AND privilege.grantee = 'lcm_test_runtime'::pg_catalog.regrole
                     AND privilege.grantor <> procedure.proowner
                 ) AS normalize_foreign_grantor`,
      }, { domain: "conversations", operation: "inspectConversationRuntimePrivileges" });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        conversations_select: true,
        conversations_insert: false,
        conversations_title_insert: true,
        conversations_title_update: false,
        conversations_sequence_usage: true,
        conversations_sequence_select: false,
        messages_select: true,
        messages_delete: true,
        messages_insert: false,
        messages_content_insert: true,
        messages_content_update: false,
        messages_sequence_usage: true,
        parts_select: true,
        parts_insert: false,
        parts_metadata_insert: true,
        parts_delete: false,
        summaries_select: true,
        summaries_delete: false,
        context_select: true,
        context_delete: true,
        context_update: false,
        normalize_execute: true,
        normalize_public_execute: false,
        normalize_grant_option: false,
        normalize_foreign_grantor: false,
      });
    });
  });

  it("passes the shared conversation repository contract and cascades eligible deletion", async () => {
    await withPostgreSqlTestDatabase("conversation-round-trip", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation round trip");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const { messages, third } =
        await exerciseConversationRepositoryConformance(repository);

      expect(await repository.deleteMessages([messages[0].messageId, third.messageId])).toBe(2);
      expect(await repository.deleteMessages([])).toBe(0);
      expect(await repository.getMessageById(messages[0].messageId)).toBeNull();
      expect(await repository.getMessageParts(messages[0].messageId)).toEqual([]);
    });
  });

  it("isolates every lookup and mutation by project", async () => {
    await withPostgreSqlTestDatabase("conversation-projects", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const firstProject = await createProject(database, "Conversation project A");
      const secondProject = await createProject(database, "Conversation project B");
      const first = new PostgreSqlConversationRepository(database.runtime, firstProject);
      const second = new PostgreSqlConversationRepository(database.runtime, secondProject);
      const firstConversation = await first.createConversation({ sessionId: "shared-session" });
      const secondConversation = await second.createConversation({ sessionId: "shared-session" });
      const firstMessage = await first.createMessage({
        conversationId: firstConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first project",
        tokenCount: 2,
      });
      const secondMessage = await second.createMessage({
        conversationId: secondConversation.conversationId,
        seq: 0,
        role: "user",
        content: "second project",
        tokenCount: 2,
      });

      expect((await first.getConversationBySessionId("shared-session"))?.conversationId)
        .toBe(firstConversation.conversationId);
      expect((await second.getConversationBySessionId("shared-session"))?.conversationId)
        .toBe(secondConversation.conversationId);
      expect(await first.getConversation(secondConversation.conversationId)).toBeNull();
      expect(await first.getMessageById(secondMessage.messageId)).toBeNull();
      expect(await first.getMessageCountBySessionId("shared-session")).toBe(1);
      expect(await first.deleteMessages([secondMessage.messageId])).toBe(0);
      expect(await second.getMessageById(secondMessage.messageId)).not.toBeNull();
      expect(await first.getMessageById(firstMessage.messageId)).not.toBeNull();
    });
  });

  it("uses the exact session residual and stable newest-segment tie ordering", async () => {
    await withPostgreSqlTestDatabase("conversation-session-order", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation session ordering");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const older = await repository.createConversation({ sessionId: "tie-session", title: "older" });
      const newer = await repository.createConversation({ sessionId: "tie-session", title: "newer" });
      await database.migrator.query({
        text: `UPDATE lcm.conversations
               SET created_at = '2026-01-01T00:00:00.000Z',
                   updated_at = '2026-01-01T00:00:00.000Z'
               WHERE project_id = $1 AND conversation_id = ANY($2::bigint[])`,
        values: [projectId, [older.conversationId, newer.conversationId]],
      }, { domain: "conversations", operation: "forceConversationTimestampTie" });
      expect((await repository.getConversationBySessionId("tie-session"))?.conversationId)
        .toBe(newer.conversationId);
      expect((await repository.getOrCreateConversation("tie-session"))?.conversationId)
        .toBe(newer.conversationId);

      const target = await repository.createConversation({ sessionId: "exact-target" });
      const collision = await repository.createConversation({ sessionId: "hash-collision-decoy" });
      await database.migrator.query({
        text: `ALTER TABLE lcm.conversations
               ALTER COLUMN session_id_sha256 DROP EXPRESSION`,
      }, { domain: "conversations", operation: "allowConversationHashCollisionFixture" });
      await database.migrator.query({
        text: `UPDATE lcm.conversations AS decoy
               SET session_id_sha256 = target.session_id_sha256,
                   created_at = target.created_at + interval '1 second',
                   updated_at = target.updated_at + interval '1 second'
               FROM lcm.conversations AS target
               WHERE decoy.project_id = $1
                 AND decoy.conversation_id = $2
                 AND target.project_id = $1
                 AND target.conversation_id = $3`,
        values: [projectId, collision.conversationId, target.conversationId],
      }, { domain: "conversations", operation: "forceConversationHashCollision" });
      expect((await repository.getConversationBySessionId("exact-target"))?.conversationId)
        .toBe(target.conversationId);
    });
  });

  it("converges lock-waiting get-or-create calls under a REPEATABLE READ default", async () => {
    await withPostgreSqlTestDatabase("conversation-get-or-create-race", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation race");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const configured = await database.runtime.query<{
        default_transaction_isolation: string;
      }>({
        text: "SHOW default_transaction_isolation",
      }, { domain: "conversations", operation: "inspectConversationIsolationDefault" });
      expect(configured.rows[0]?.default_transaction_isolation).toBe("repeatable read");

      let releaseBlocker!: () => void;
      let markBlockerHeld!: () => void;
      const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blockerHeld = new Promise<void>((resolve) => { markBlockerHeld = resolve; });
      const blocker = database.migrator.transaction(async (transaction) => {
        await transaction.query({
          text: `SELECT pg_catalog.pg_advisory_xact_lock(
                          pg_catalog.hashtextextended(
                            $1::pg_catalog.text
                              OPERATOR(pg_catalog.||) ':conversation:'
                              OPERATOR(pg_catalog.||)
                                pg_catalog.encode(
                                  public.digest($2::pg_catalog.text, 'sha256'),
                                  'hex'
                                ),
                            0
                          )
                        )`,
          values: [projectId, "shared-race"],
        }, { domain: "conversations", operation: "holdConversationAdvisoryLock" });
        markBlockerHeld();
        await blockerRelease;
      }, { domain: "transaction", operation: "holdConversationAdvisoryLock" });
      await blockerHeld;

      const pendingRows = Promise.all([
        repository.getOrCreateConversation("shared-race", "candidate-0"),
        repository.getOrCreateConversation("shared-race", "candidate-1"),
      ]);
      let bothBlocked = false;
      try {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const locks = await database.migrator.query<{ count: number }>({
            text: `SELECT pg_catalog.count(*)::integer AS count
                   FROM pg_catalog.pg_locks
                   WHERE locktype = 'advisory'
                     AND database = (
                       SELECT oid
                       FROM pg_catalog.pg_database
                       WHERE datname = pg_catalog.current_database()
                     )
                     AND NOT granted`,
          }, { domain: "conversations", operation: "inspectConversationAdvisoryWaiters" });
          if ((locks.rows[0]?.count ?? 0) >= 2) {
            bothBlocked = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        releaseBlocker();
        await blocker;
      }
      expect(bothBlocked).toBe(true);
      const rows = await pendingRows;

      expect(new Set(rows.map((row) => row.conversationId)).size).toBe(1);
      expect((await repository.listConversations()).filter(
        (row) => row.sessionId === "shared-race",
      )).toHaveLength(1);
    }, { defaultTransactionIsolation: "REPEATABLE READ" });
  });

  it("allocates concurrent append batches contiguously without interleaving", async () => {
    await withPostgreSqlTestDatabase("conversation-append-race", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation append race");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const conversation = await repository.createConversation({ sessionId: "append-race" });
      const batches = await Promise.all(Array.from({ length: 8 }, (_, batch) =>
        repository.appendMessages(conversation.conversationId, [
          { role: "user", content: `${batch}-a`, tokenCount: 1 },
          { role: "assistant", content: `${batch}-b`, tokenCount: 1 },
          { role: "tool", content: `${batch}-c`, tokenCount: 1 },
        ])));

      expect((await repository.getMessages(conversation.conversationId))
        .map((message) => message.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index));
      for (const batch of batches) {
        expect(batch.map((message) => message.seq)).toEqual([
          batch[0].seq,
          batch[0].seq + 1,
          batch[0].seq + 2,
        ]);
      }
    });
  });

  it("protects summarized messages while deleting eligible context and owned parts", async () => {
    await withPostgreSqlTestDatabase("conversation-protected-delete", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation protected deletion");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const conversation = await repository.createConversation({ sessionId: "protected-delete" });
      const [protectedMessage, eligibleMessage] = await repository.appendMessages(
        conversation.conversationId,
        [
          { role: "user", content: "summarized", tokenCount: 1 },
          { role: "assistant", content: "eligible", tokenCount: 1 },
        ],
      );
      await repository.createMessageParts(protectedMessage.messageId, [{
        sessionId: "protected-delete",
        partType: "text",
        ordinal: 0,
        textContent: "protected part",
      }]);
      await repository.createMessageParts(eligibleMessage.messageId, [{
        sessionId: "protected-delete",
        partType: "text",
        ordinal: 0,
        textContent: "eligible part",
      }]);

      const summary = await database.migrator.query<{ summary_key: string }>({
        text: `INSERT INTO lcm.summaries (
                 summary_id, project_id, conversation_id, kind, content, token_count
               )
               VALUES ($1, $2, $3, 'leaf', $4, 1)
               RETURNING summary_key`,
        values: [
          "protected-delete-summary",
          projectId,
          conversation.conversationId,
          "summary",
        ],
      }, { domain: "summaries", operation: "createProtectedDeletionSummaryFixture" });
      await database.migrator.query({
        text: `INSERT INTO lcm.summary_messages (
                 project_id, conversation_id, summary_key, message_id, ordinal
               )
               VALUES ($1, $2, $3, $4, 0)`,
        values: [
          projectId,
          conversation.conversationId,
          summary.rows[0].summary_key,
          protectedMessage.messageId,
        ],
      }, { domain: "summaries", operation: "linkProtectedDeletionSummaryFixture" });
      await database.migrator.query({
        text: `INSERT INTO lcm.context_items (
                 project_id, conversation_id, ordinal, item_type, message_id
               )
               VALUES ($1, $2, 0, 'message', $3)`,
        values: [projectId, conversation.conversationId, eligibleMessage.messageId],
      }, { domain: "context", operation: "createProtectedDeletionContextFixture" });

      expect(await repository.deleteMessages([
        protectedMessage.messageId,
        eligibleMessage.messageId,
      ])).toBe(1);
      expect(await repository.getMessageById(protectedMessage.messageId)).not.toBeNull();
      expect(await repository.getMessageParts(protectedMessage.messageId)).toHaveLength(1);
      expect(await repository.getMessageById(eligibleMessage.messageId)).toBeNull();
      expect(await repository.getMessageParts(eligibleMessage.messageId)).toEqual([]);

      const residuals = await database.migrator.query<{
        protected_link_count: string;
        eligible_context_count: string;
      }>({
        text: `SELECT
                 (
                   SELECT COUNT(*)
                   FROM lcm.summary_messages
                   WHERE project_id = $1 AND message_id = $2
                 ) AS protected_link_count,
                 (
                   SELECT COUNT(*)
                   FROM lcm.context_items
                   WHERE project_id = $1 AND message_id = $3
                 ) AS eligible_context_count`,
        values: [projectId, protectedMessage.messageId, eligibleMessage.messageId],
      }, { domain: "conversations", operation: "inspectProtectedDeletionResiduals" });
      expect(residuals.rows[0]).toEqual({
        protected_link_count: "1",
        eligible_context_count: "0",
      });
    });
  });

  it("keeps bulk, parts, and delete changes inside an existing runtime transaction", async () => {
    await withPostgreSqlTestDatabase("conversation-existing-transaction", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation existing transaction");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const conversation = await repository.createConversation({ sessionId: "existing-transaction" });
      const victim = await repository.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "must survive rollback",
        tokenCount: 1,
      });
      let insertedMessageId: number | undefined;

      await expect(database.runtime.transaction(async (transaction) => {
        // These methods are query-only, single-statement operations. Binding
        // the staged repository to the already-open executor proves they join
        // the caller's transaction without requiring a ProjectStorage adapter.
        const transactionalRepository = new PostgreSqlConversationRepository(
          transaction as PostgreSqlConversationExecutor,
          projectId,
        );
        const inserted = await transactionalRepository.createMessagesBulk([
          {
            conversationId: conversation.conversationId,
            seq: 1,
            role: "assistant",
            content: "must roll back",
            tokenCount: 1,
          },
        ]);
        insertedMessageId = inserted[0].messageId;
        await transactionalRepository.createMessageParts(inserted[0].messageId, [{
          sessionId: "existing-transaction",
          partType: "text",
          ordinal: 0,
          textContent: "must roll back",
        }]);
        expect(await transactionalRepository.deleteMessages([victim.messageId])).toBe(1);
        throw new Error("force caller rollback");
      }, {
        domain: "conversations",
        operation: "rollbackConversationMethods",
        projectId,
      })).rejects.toMatchObject({
        backend: "postgresql",
        domain: "conversations",
        operation: "rollbackConversationMethods",
        projectId,
      });

      expect(insertedMessageId).toBeDefined();
      expect(await repository.getMessageById(insertedMessageId!)).toBeNull();
      expect(await repository.getMessageParts(insertedMessageId!)).toEqual([]);
      expect(await repository.getMessageById(victim.messageId)).not.toBeNull();
    });
  });

  it("rolls back bulk messages, parts, and multi-message deletion on mid-batch failures", async () => {
    await withPostgreSqlTestDatabase("conversation-atomicity", async (database) => {
      await grantConversationRuntimePrivileges(database);
      const projectId = await createProject(database, "Conversation atomicity");
      const repository = new PostgreSqlConversationRepository(database.runtime, projectId);
      const conversation = await repository.createConversation({ sessionId: "atomic" });

      await expect(repository.createMessagesBulk([
        { conversationId: conversation.conversationId, seq: 0, role: "user", content: "first", tokenCount: 1 },
        { conversationId: conversation.conversationId, seq: 0, role: "assistant", content: "duplicate", tokenCount: 1 },
      ])).rejects.toMatchObject({ domain: "conversations" });
      expect(await repository.getMessages(conversation.conversationId)).toEqual([]);

      const [partsMessage, firstDelete, secondDelete] = await repository.appendMessages(
        conversation.conversationId,
        [
          { role: "assistant", content: "parts", tokenCount: 1 },
          { role: "user", content: "first delete", tokenCount: 1 },
          { role: "user", content: "second delete", tokenCount: 1 },
        ],
      );
      await expect(repository.createMessageParts(partsMessage.messageId, [
        { sessionId: "atomic", partType: "text", ordinal: 0, textContent: "first" },
        { sessionId: "atomic", partType: "reasoning", ordinal: 0, textContent: "duplicate" },
      ])).rejects.toMatchObject({ domain: "conversations" });
      expect(await repository.getMessageParts(partsMessage.messageId)).toEqual([]);

      await database.migrator.query({
        text: `CREATE FUNCTION public.fail_selected_message_delete()
               RETURNS trigger
               LANGUAGE plpgsql
               SECURITY DEFINER
               SET search_path = pg_catalog
               AS $function$
               BEGIN
                 IF OLD.message_id = ${secondDelete.messageId} THEN
                   RAISE EXCEPTION 'injected delete failure';
                 END IF;
                 RETURN OLD;
               END
               $function$;
               REVOKE ALL ON FUNCTION public.fail_selected_message_delete() FROM PUBLIC;
               CREATE TRIGGER fail_selected_message_delete
               BEFORE DELETE ON lcm.messages
               FOR EACH ROW EXECUTE FUNCTION public.fail_selected_message_delete()`,
      }, { domain: "conversations", operation: "installDeleteFailureTrigger" });
      await expect(repository.deleteMessages([firstDelete.messageId, secondDelete.messageId]))
        .rejects.toMatchObject({ domain: "conversations" });
      expect(await repository.getMessageById(firstDelete.messageId)).not.toBeNull();
      expect(await repository.getMessageById(secondDelete.messageId)).not.toBeNull();
    });
  });
});
