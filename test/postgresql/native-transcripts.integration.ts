import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { NativeTranscriptBatchInput } from "../../src/storage/contracts.js";
import {
  PostgreSqlNativeTranscriptConflictError,
  PostgreSqlNativeTranscriptRepository,
} from "../../src/storage/postgresql/native-transcript-repository.js";
import { runPostgreSqlMigrations } from "../../src/storage/postgresql/migrations.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantTranscriptRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-transcript-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "native-transcripts",
    operation: "grantTranscriptRuntimePrivileges",
  });
}

async function createScope(
  database: PostgreSqlTestDatabase,
  label: string,
): Promise<{
  projectId: string;
  machineId: string;
  conversationId: number;
  messageId: number;
}> {
  const machine = await database.migrator.query<{ machine_id: string }>({
    text: `INSERT INTO lcm.machines (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING machine_id`,
    values: [`machine:${createHash("sha256").update(label).digest("hex")}`, label],
  }, { domain: "identity", operation: "createTranscriptTestMachine" });
  const project = await database.migrator.query<{ project_id: string }>({
    text: `INSERT INTO lcm.projects (identity_key, display_name)
           VALUES ($1, $2)
           RETURNING project_id`,
    values: [createHash("sha256").update(`project:${label}`).digest("hex"), label],
  }, { domain: "identity", operation: "createTranscriptTestProject" });
  const conversation = await database.migrator.query<{
    conversation_id: string;
  }>({
    text: `INSERT INTO lcm.conversations (project_id, session_id)
           VALUES ($1, $2)
           RETURNING conversation_id`,
    values: [project.rows[0].project_id, `session:${label}`],
  }, { domain: "conversations", operation: "createTranscriptTestConversation" });
  const message = await database.migrator.query<{ message_id: string }>({
    text: `INSERT INTO lcm.messages (
             project_id, conversation_id, seq, role, content, token_count
           )
           VALUES ($1, $2, 0, 'user', $3, 1)
           RETURNING message_id`,
    values: [
      project.rows[0].project_id,
      conversation.rows[0].conversation_id,
      `message:${label}`,
    ],
  }, { domain: "conversations", operation: "createTranscriptTestMessage" });
  return {
    projectId: project.rows[0].project_id,
    machineId: machine.rows[0].machine_id,
    conversationId: Number(conversation.rows[0].conversation_id),
    messageId: Number(message.rows[0].message_id),
  };
}

function input(
  scope: Awaited<ReturnType<typeof createScope>>,
  sourceLocator: string,
  ingestKeySeed: string,
): NativeTranscriptBatchInput {
  const payload = {
    type: "message",
    role: "user",
    content: `sanitized:${ingestKeySeed}`,
  };
  return {
    machineId: scope.machineId,
    clientName: "codex",
    sourceLocator,
    expectedCheckpoint: null,
    records: [{
      formatName: "codex-jsonl",
      formatVersion: "v1",
      nativeSessionId: "native-session",
      sourceOrdinal: 4,
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
      scrubberVersion: "scrubber-v1",
      contentSha256: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      ingestKey: createHash("sha256").update(ingestKeySeed).digest("hex"),
      nativePayload: payload,
      messageLinks: [{
        conversationId: scope.conversationId,
        messageId: scope.messageId,
        sourceOrdinal: 0,
      }],
    }],
    checkpoint: {
      lastSourceOrdinal: 4,
      checkpoint: {
        byteOffset: 128,
        prefixSha256: createHash("sha256").update(sourceLocator).digest("hex"),
      },
    },
    quarantinedCount: 1,
  };
}

describe("PostgreSQL 18 native transcript repository", () => {
  it("requires exact grants and accepts only the reviewed least-privilege ACLs", async () => {
    await withPostgreSqlTestDatabase("native-transcript-grants", async (database) => {
      const scope = await createScope(database, "Native transcript grants");
      const repository = new PostgreSqlNativeTranscriptRepository(
        database.runtime,
        scope.projectId,
      );
      await expect(repository.ingestBatch(
        input(scope, "grants/session.jsonl", "grants"),
      )).rejects.toMatchObject({
        backend: "postgresql",
        domain: "native-transcripts",
        operation: "ingestBatch",
      });

      await grantTranscriptRuntimePrivileges(database);
      await expect(repository.ingestBatch(
        input(scope, "grants/session.jsonl", "grants"),
      )).resolves.toMatchObject({ importedCount: 1, skippedCount: 0 });
      await expect(runPostgreSqlMigrations(database.migrator))
        .resolves.toMatchObject({ applied: [] });

      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        conversation_select: boolean;
        conversation_session_select: boolean;
        conversation_title_select: boolean;
        message_select: boolean;
        message_content_select: boolean;
        message_token_count_select: boolean;
        transcript_select: boolean;
        transcript_insert: boolean;
        transcript_payload_insert: boolean;
        transcript_ingested_insert: boolean;
        transcript_id_insert: boolean;
        transcript_update: boolean;
        transcript_delete: boolean;
        link_select: boolean;
        link_insert: boolean;
        link_project_insert: boolean;
        link_delete: boolean;
        checkpoint_select: boolean;
        checkpoint_insert: boolean;
        checkpoint_project_insert: boolean;
        checkpoint_payload_update: boolean;
        checkpoint_project_update: boolean;
        checkpoint_delete: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'USAGE')
                   AS schema_usage,
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'CREATE')
                   AS schema_create,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.conversations', 'SELECT'
                 ) AS conversation_select,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.conversations',
                   'session_id', 'SELECT'
                 ) AS conversation_session_select,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.conversations',
                   'title', 'SELECT'
                 ) AS conversation_title_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.messages', 'SELECT'
                 ) AS message_select,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.messages',
                   'content', 'SELECT'
                 ) AS message_content_select,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.messages',
                   'token_count', 'SELECT'
                 ) AS message_token_count_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts', 'SELECT'
                 ) AS transcript_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts', 'INSERT'
                 ) AS transcript_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts',
                   'native_payload', 'INSERT'
                 ) AS transcript_payload_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts',
                   'ingested_at', 'INSERT'
                 ) AS transcript_ingested_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts',
                   'transcript_id', 'INSERT'
                 ) AS transcript_id_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts', 'UPDATE'
                 ) AS transcript_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.native_transcripts', 'DELETE'
                 ) AS transcript_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.transcript_messages', 'SELECT'
                 ) AS link_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.transcript_messages', 'INSERT'
                 ) AS link_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.transcript_messages',
                   'project_id', 'INSERT'
                 ) AS link_project_insert,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.transcript_messages', 'DELETE'
                 ) AS link_delete,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints', 'SELECT'
                 ) AS checkpoint_select,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints', 'INSERT'
                 ) AS checkpoint_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints',
                   'project_id', 'INSERT'
                 ) AS checkpoint_project_insert,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints',
                   'checkpoint', 'UPDATE'
                 ) AS checkpoint_payload_update,
                 has_column_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints',
                   'project_id', 'UPDATE'
                 ) AS checkpoint_project_update,
                 has_table_privilege(
                   'lcm_test_runtime', 'lcm.ingest_checkpoints', 'DELETE'
                 ) AS checkpoint_delete`,
      }, {
        domain: "native-transcripts",
        operation: "inspectTranscriptRuntimePrivileges",
      });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        conversation_select: false,
        conversation_session_select: true,
        conversation_title_select: false,
        message_select: false,
        message_content_select: true,
        message_token_count_select: false,
        transcript_select: true,
        transcript_insert: false,
        transcript_payload_insert: true,
        transcript_ingested_insert: true,
        transcript_id_insert: false,
        transcript_update: false,
        transcript_delete: false,
        link_select: true,
        link_insert: false,
        link_project_insert: true,
        link_delete: false,
        checkpoint_select: true,
        checkpoint_insert: false,
        checkpoint_project_insert: true,
        checkpoint_payload_update: true,
        checkpoint_project_update: false,
        checkpoint_delete: false,
      });

      await database.migrator.query({
        text: "GRANT DELETE ON lcm.native_transcripts TO lcm_test_runtime",
      }, {
        domain: "native-transcripts",
        operation: "grantUnexpectedTranscriptDelete",
      });
      await expect(runPostgreSqlMigrations(database.migrator))
        .rejects.toMatchObject({
          baselineApplied: true,
          driftedDefinitionGroupCount: 1,
          operation: "preflightBaselineDefinitions",
        });
    });
  });

  it("round-trips provenance and skips reordered retry metadata", async () => {
    await withPostgreSqlTestDatabase("native-transcript-round-trip", async (database) => {
      await grantTranscriptRuntimePrivileges(database);
      const scope = await createScope(database, "Native transcript round trip");
      const repository = new PostgreSqlNativeTranscriptRepository(
        database.runtime,
        scope.projectId,
      );
      const base = input(scope, "round-trip/session.jsonl", "round-trip");
      const specialPayload = JSON.parse(`{
        "type": "message",
        "nested": {
          "__proto__": {"polluted": false},
          "constructor": {"name": "safe"},
          "prototype": ["retained"]
        }
      }`) as NativeTranscriptBatchInput["records"][number]["nativePayload"];
      const specialCheckpoint = JSON.parse(`{
        "__proto__": {"checkpoint": true},
        "metadata": {"z": {"second": 2, "first": 1}, "a": true},
        "order": ["z", "a"],
        "byteOffset": 128,
        "prefixSha256": "${"c".repeat(64)}"
      }`) as NativeTranscriptBatchInput["checkpoint"]["checkpoint"];
      const first: NativeTranscriptBatchInput = {
        ...base,
        records: [{
          ...base.records[0],
          contentSha256: createHash("sha256")
            .update(JSON.stringify(specialPayload))
            .digest("hex"),
          nativePayload: specialPayload,
        }],
        checkpoint: {
          ...base.checkpoint,
          checkpoint: specialCheckpoint,
        },
      };
      const firstResult = await repository.ingestBatch(first);
      expect(firstResult).toMatchObject({
        importedCount: 1,
        skippedCount: 0,
      });
      const reorderedPayload = JSON.parse(`{
        "nested": {
          "prototype": ["retained"],
          "constructor": {"name": "safe"},
          "__proto__": {"polluted": false}
        },
        "type": "message"
      }`) as NativeTranscriptBatchInput["records"][number]["nativePayload"];
      const reorderedCheckpoint = JSON.parse(`{
        "prefixSha256": "${"c".repeat(64)}",
        "byteOffset": 128,
        "order": ["z", "a"],
        "metadata": {"a": true, "z": {"first": 1, "second": 2}},
        "__proto__": {"checkpoint": true}
      }`) as NativeTranscriptBatchInput["checkpoint"]["checkpoint"];
      const retry: NativeTranscriptBatchInput = {
        ...first,
        expectedCheckpoint: {
          ...firstResult.checkpoint,
          checkpoint: reorderedCheckpoint,
        },
        records: [{
          ...first.records[0],
          observedAt: new Date("2026-02-01T00:00:00.000Z"),
          scrubberVersion: "scrubber-v2",
          nativePayload: reorderedPayload,
        }],
      };
      const retryResult = await repository.ingestBatch(retry);
      expect(retryResult).toMatchObject({
        importedCount: 0,
        skippedCount: 1,
      });
      const checkpointBeforeShiftedRetry = await repository.getCheckpoint(
        first,
      );
      await expect(repository.ingestBatch({
        ...retry,
        expectedCheckpoint: checkpointBeforeShiftedRetry,
        records: [{
          ...retry.records[0],
          sourceOrdinal: 99,
        }],
      })).rejects.toBeInstanceOf(PostgreSqlNativeTranscriptConflictError);
      await expect(repository.getCheckpoint(first)).resolves.toEqual(
        checkpointBeforeShiftedRetry,
      );
      await expect(repository.listBySource(first)).resolves.toHaveLength(1);

      const stored = await repository.getById(
        (await repository.listBySource(first))[0].transcriptId,
      );
      expect(stored).toMatchObject({
        sourceOrdinal: 4,
        observedAt: new Date("2026-01-01T00:00:00.000Z"),
        ingestedAt: new Date("2026-01-01T00:00:00.000Z"),
        scrubberVersion: "scrubber-v1",
        nativePayload: specialPayload,
        messageLinks: [{
          conversationId: scope.conversationId,
          messageId: scope.messageId,
        }],
      });
      const storedPayload = stored?.nativePayload as Record<string, unknown>;
      const storedNested = storedPayload.nested as Record<string, unknown>;
      expect(Object.getPrototypeOf(storedPayload)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(storedNested)).toBe(Object.prototype);
      expect(Object.hasOwn(storedNested, "__proto__")).toBe(true);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(firstResult.checkpoint.checkpoint).toEqual(specialCheckpoint);
      expect(Object.hasOwn(
        firstResult.checkpoint.checkpoint,
        "__proto__",
      )).toBe(true);
      expect(
        (firstResult.checkpoint.checkpoint.order as unknown[]),
      ).toEqual(["z", "a"]);
      await expect(repository.getNativeTranscriptMessageSnapshot(
        `session:Native transcript round trip`,
      )).resolves.toEqual([expect.objectContaining({
        conversationId: scope.conversationId,
        messageId: scope.messageId,
        messageSequence: 0,
        role: "user",
      })]);
      await expect(repository.listByNativeSession({
        nativeSessionId: "native-session",
      })).resolves.toHaveLength(1);
      await expect(repository.listByMessage({
        conversationId: scope.conversationId,
        messageId: scope.messageId,
      })).resolves.toHaveLength(1);
      const checkpoint = await repository.getCheckpoint(first);
      expect(checkpoint).toMatchObject({
        importedCount: 1,
        skippedCount: 1,
        quarantinedCount: 2,
      });
      const changedPrefix = await repository.ingestBatch({
        ...first,
        expectedCheckpoint: checkpoint!,
        records: [],
        checkpoint: {
          lastSourceOrdinal: 0,
          checkpoint: {
            byteOffset: 0,
            prefixSha256: "0".repeat(64),
          },
        },
        quarantinedCount: 0,
      });
      expect(changedPrefix.checkpoint).toMatchObject({
        lastSourceOrdinal: 0,
        checkpoint: { byteOffset: 0 },
      });

      const collision = {
        ...first,
        expectedCheckpoint: changedPrefix.checkpoint,
        records: [{
          ...first.records[0],
          contentSha256: "f".repeat(64),
          nativePayload: { changed: true },
        }],
      };
      await expect(repository.ingestBatch(collision))
        .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptConflictError);
    });
  });

  it("serializes concurrent retries and rolls failed batches back completely", async () => {
    await withPostgreSqlTestDatabase("native-transcript-atomicity", async (database) => {
      await grantTranscriptRuntimePrivileges(database);
      const scope = await createScope(database, "Native transcript atomicity");
      const first = new PostgreSqlNativeTranscriptRepository(
        database.runtime,
        scope.projectId,
      );
      const second = new PostgreSqlNativeTranscriptRepository(
        database.runtime,
        scope.projectId,
      );
      const concurrent = input(
        scope,
        "atomicity/concurrent.jsonl",
        "concurrent",
      );
      const results = await Promise.allSettled([
        first.ingestBatch(concurrent),
        second.ingestBatch(concurrent),
      ]);
      expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
      const values = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      expect(values).toEqual(expect.arrayContaining([
        expect.objectContaining({ importedCount: 1, skippedCount: 0 }),
        expect.objectContaining({ importedCount: 0, skippedCount: 1 }),
      ]));
      await expect(first.getCheckpoint(concurrent)).resolves.toMatchObject({
        importedCount: 1,
        skippedCount: 1,
        quarantinedCount: 2,
      });

      const divergentA = input(
        scope,
        "atomicity/divergent.jsonl",
        "divergent-a",
      );
      const divergentB: NativeTranscriptBatchInput = {
        ...input(scope, "atomicity/divergent.jsonl", "divergent-b"),
        checkpoint: {
          lastSourceOrdinal: 5,
          checkpoint: {
            byteOffset: 256,
            prefixSha256: createHash("sha256")
              .update("divergent-b-prefix")
              .digest("hex"),
          },
        },
      };
      const divergent = await Promise.allSettled([
        first.ingestBatch(divergentA),
        second.ingestBatch(divergentB),
      ]);
      expect(divergent.filter(({ status }) => status === "fulfilled"))
        .toHaveLength(1);
      expect(divergent.filter(({ status }) => status === "rejected"))
        .toMatchObject([{
          reason: {
            name: "PostgreSqlNativeTranscriptCheckpointConflictError",
          },
        }]);
      await expect(first.listBySource(divergentA)).resolves.toHaveLength(1);

      const checkpointOnly = input(
        scope,
        "atomicity/checkpoint-only.jsonl",
        "checkpoint-only",
      );
      const checkpointOnlyBatch: NativeTranscriptBatchInput = {
        ...checkpointOnly,
        records: [],
      };
      const checkpointOnlyResults = await Promise.all([
        first.ingestBatch(checkpointOnlyBatch),
        second.ingestBatch(checkpointOnlyBatch),
      ]);
      expect(checkpointOnlyResults).toHaveLength(2);
      expect(checkpointOnlyResults).toEqual([
        expect.objectContaining({ importedCount: 0, skippedCount: 0 }),
        expect.objectContaining({ importedCount: 0, skippedCount: 0 }),
      ]);
      await expect(first.getCheckpoint(checkpointOnlyBatch)).resolves
        .toMatchObject({
          importedCount: 0,
          skippedCount: 0,
          quarantinedCount: 2,
        });
      const absent = input(
        scope,
        "atomicity/absent.jsonl",
        "absent-checkpoint",
      );
      const existingCheckpoint = (await first.getCheckpoint(concurrent))!;
      const unexpectedPrior = {
        ...absent,
        expectedCheckpoint: {
          ...existingCheckpoint,
          sourceLocator: absent.sourceLocator,
        },
      };
      await expect(first.ingestBatch(unexpectedPrior)).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptCheckpointConflictError",
      });
      await expect(first.getCheckpoint(absent)).resolves.toBeNull();

      const rollback = input(scope, "atomicity/rollback.jsonl", "rollback-a");
      const invalidMessage = {
        ...rollback,
        records: [
          rollback.records[0],
          {
            ...rollback.records[0],
            ingestKey: createHash("sha256").update("rollback-b").digest("hex"),
            sourceOrdinal: 5,
            messageLinks: [{
              conversationId: scope.conversationId,
              messageId: Number.MAX_SAFE_INTEGER,
              sourceOrdinal: 0,
            }],
          },
        ],
      };
      await expect(first.ingestBatch(invalidMessage)).rejects.toMatchObject({
        domain: "native-transcripts",
        operation: "ingestBatch",
      });
      await expect(first.listBySource(rollback)).resolves.toEqual([]);
      await expect(first.getCheckpoint(rollback)).resolves.toBeNull();
    });
  });

  it("converges identical concurrency when sessions default to repeatable read", async () => {
    await withPostgreSqlTestDatabase(
      "native-transcript-repeatable-default",
      async (database) => {
        await grantTranscriptRuntimePrivileges(database);
        const scope = await createScope(
          database,
          "Native transcript repeatable default",
        );
        await expect(database.runtime.query<{
          transaction_isolation: string;
        }>({
          text: `SELECT pg_catalog.current_setting(
                          'transaction_isolation'
                        ) AS transaction_isolation`,
        }, {
          domain: "native-transcripts",
          operation: "verifyRepeatableDefault",
        })).resolves.toMatchObject({
          rows: [{ transaction_isolation: "repeatable read" }],
        });
        const first = new PostgreSqlNativeTranscriptRepository(
          database.runtime,
          scope.projectId,
        );
        const second = new PostgreSqlNativeTranscriptRepository(
          database.runtime,
          scope.projectId,
        );
        const concurrent = input(
          scope,
          "repeatable/concurrent.jsonl",
          "repeatable-concurrent",
        );
        const results = await Promise.all([
          first.ingestBatch(concurrent),
          second.ingestBatch(concurrent),
        ]);
        expect(results).toEqual(expect.arrayContaining([
          expect.objectContaining({ importedCount: 1, skippedCount: 0 }),
          expect.objectContaining({ importedCount: 0, skippedCount: 1 }),
        ]));
      },
      { defaultTransactionIsolation: "REPEATABLE READ" },
    );
  });

  it("rejects cross-project links without retaining the transcript or checkpoint", async () => {
    await withPostgreSqlTestDatabase("native-transcript-project-scope", async (database) => {
      await grantTranscriptRuntimePrivileges(database);
      const local = await createScope(database, "Native transcript local");
      const remote = await createScope(database, "Native transcript remote");
      const repository = new PostgreSqlNativeTranscriptRepository(
        database.runtime,
        local.projectId,
      );
      const crossProject = input(
        local,
        "scope/cross-project.jsonl",
        "cross-project",
      );
      crossProject.records[0].messageLinks = [{
        conversationId: remote.conversationId,
        messageId: remote.messageId,
        sourceOrdinal: 0,
      }];
      await expect(repository.ingestBatch(crossProject)).rejects.toMatchObject({
        domain: "native-transcripts",
        operation: "ingestBatch",
      });
      await expect(repository.listBySource(crossProject)).resolves.toEqual([]);
      await expect(repository.getCheckpoint(crossProject)).resolves.toBeNull();
    });
  });
});
