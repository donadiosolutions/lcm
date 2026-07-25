import type { QueryResultRow } from "pg";
import type {
  AppendMessageInput,
  ConversationId,
  ConversationRecord,
  CreateConversationInput,
  CreateMessageInput,
  CreateMessagePartInput,
  MessageId,
  MessagePartRecord,
  MessagePartType,
  MessageRecord,
  MessageRole,
} from "../../store/conversation-store.js";
import type { ConversationRepository } from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
} from "./contracts.js";
import {
  PostgreSqlCommitOutcomeUnknownError,
  PostgreSqlStorageOperationError,
} from "./errors.js";

const MAX_SHORT_TRANSACTION_ATTEMPTS = 3;
const SHORT_TRANSACTION_RETRY_SQLSTATES = new Set(["40001", "40P01"]);

const CONVERSATION_COLUMNS =
  "conversation_id, session_id, title, bootstrapped_at, created_at, updated_at";
const MESSAGE_COLUMNS =
  "message_id, conversation_id, seq, role, content, token_count, created_at";
const MESSAGE_PART_COLUMNS =
  "part_id, message_id, session_id, part_type, ordinal, text_content, " +
  "tool_call_id, tool_name, tool_input, tool_output, metadata";

type PostgreSqlConversationTransactionContext = PostgreSqlOperationContext & {
  readonly domain: "conversations";
  readonly projectId: string;
  readonly signal?: AbortSignal;
};

export interface PostgreSqlConversationExecutor extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    options: PostgreSqlConversationTransactionContext,
  ): Promise<T>;
}

type ConversationRow = QueryResultRow & {
  conversation_id: string | number | bigint;
  session_id: string;
  title: string | null;
  bootstrapped_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = QueryResultRow & {
  message_id: string | number | bigint;
  conversation_id: string | number | bigint;
  seq: string | number | bigint;
  role: MessageRole;
  content: string;
  token_count: string | number | bigint;
  created_at: Date | string;
};

type MessagePartRow = QueryResultRow & {
  part_id: string;
  message_id: string | number | bigint;
  session_id: string;
  part_type: MessagePartType;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
};

type CountRow = QueryResultRow & {
  count: string | number | bigint;
};

type MaxSeqRow = QueryResultRow & {
  max_seq: string | number | bigint | null;
};

export class PostgreSqlConversationDataError extends StorageOperationError {
  constructor(
    projectId: string,
    operation: string,
    readonly field: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "conversations",
      operation,
    );
    this.name = "PostgreSqlConversationDataError";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), field: this.field };
  }
}

function safeInteger(
  value: string | number | bigint,
  projectId: string,
  operation: string,
  field: string,
): number {
  let candidate: number;
  if (typeof value === "number") {
    candidate = value;
  } else if (typeof value === "bigint") {
    candidate = Number(value);
  } else if (/^-?\d+$/u.test(value)) {
    candidate = Number(value);
  } else {
    throw new PostgreSqlConversationDataError(projectId, operation, field);
  }
  if (!Number.isSafeInteger(candidate)) {
    throw new PostgreSqlConversationDataError(projectId, operation, field);
  }
  return candidate;
}

function safeInputInteger(
  value: number,
  projectId: string,
  operation: string,
  field: string,
): number {
  return safeInteger(value, projectId, operation, field);
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function conversationFromRow(
  row: ConversationRow,
  projectId: string,
  operation: string,
): ConversationRecord {
  return {
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      operation,
      "conversation_id",
    ),
    sessionId: row.session_id,
    title: row.title,
    bootstrappedAt: row.bootstrapped_at === null ? null : date(row.bootstrapped_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function messageFromRow(
  row: MessageRow,
  projectId: string,
  operation: string,
): MessageRecord {
  return {
    messageId: safeInteger(row.message_id, projectId, operation, "message_id"),
    conversationId: safeInteger(
      row.conversation_id,
      projectId,
      operation,
      "conversation_id",
    ),
    seq: safeInteger(row.seq, projectId, operation, "seq"),
    role: row.role,
    content: row.content,
    tokenCount: safeInteger(row.token_count, projectId, operation, "token_count"),
    createdAt: date(row.created_at),
  };
}

function messagePartFromRow(
  row: MessagePartRow,
  projectId: string,
  operation: string,
): MessagePartRecord {
  return {
    partId: row.part_id,
    messageId: safeInteger(row.message_id, projectId, operation, "message_id"),
    sessionId: row.session_id,
    partType: row.part_type,
    ordinal: row.ordinal,
    textContent: row.text_content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    metadata: row.metadata,
  };
}

function sqlState(error: unknown): string | null {
  if (error instanceof PostgreSqlStorageOperationError) return error.sqlState;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

function messageInputJson(inputs: readonly CreateMessageInput[]): string {
  return JSON.stringify(inputs.map((input) => ({
    conversation_id: input.conversationId,
    seq: input.seq,
    role: input.role,
    content: input.content,
    token_count: input.tokenCount,
  })));
}

function messagePartInputJson(parts: readonly CreateMessagePartInput[]): string {
  return JSON.stringify(parts.map((part) => ({
    session_id: part.sessionId,
    part_type: part.partType,
    ordinal: part.ordinal,
    text_content: part.textContent ?? null,
    tool_call_id: part.toolCallId ?? null,
    tool_name: part.toolName ?? null,
    tool_input: part.toolInput ?? null,
    tool_output: part.toolOutput ?? null,
    metadata: part.metadata ?? null,
  })));
}

export class PostgreSqlConversationRepository implements ConversationRepository {
  constructor(
    private readonly executor: PostgreSqlConversationExecutor,
    readonly projectId: string,
  ) {}

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const operation = "createConversation";
    return this.mappedWrite(operation, (transaction) =>
      this.createConversationWith(transaction, input, operation));
  }

  async getConversation(
    conversationId: ConversationId,
  ): Promise<ConversationRecord | null> {
    return this.getConversationWith(
      this.executor,
      conversationId,
      "getConversation",
    );
  }

  async getConversationBySessionId(
    sessionId: string,
  ): Promise<ConversationRecord | null> {
    return this.getConversationBySessionIdWith(
      this.executor,
      sessionId,
      "getConversationBySessionId",
    );
  }

  async getOrCreateConversation(
    sessionId: string,
    title?: string,
  ): Promise<ConversationRecord> {
    return this.shortTransaction("getOrCreateConversation", async (transaction) => {
      await transaction.query({
        text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      }, this.context("getOrCreateConversation"));
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
        values: [this.projectId, sessionId],
      }, this.context("getOrCreateConversation"));
      const existing = await this.getConversationBySessionIdWith(
        transaction,
        sessionId,
        "getOrCreateConversation",
      );
      return existing ?? this.createConversationWith(
        transaction,
        { sessionId, title },
        "getOrCreateConversation",
      );
    });
  }

  async markConversationBootstrapped(
    conversationId: ConversationId,
  ): Promise<void> {
    safeInputInteger(
      conversationId,
      this.projectId,
      "markConversationBootstrapped",
      "conversation_id",
    );
    await this.executor.query({
      text: `UPDATE lcm.conversations
             SET bootstrapped_at = COALESCE(
                   bootstrapped_at,
                   pg_catalog.statement_timestamp()
                 ),
                 updated_at = GREATEST(
                   updated_at,
                   pg_catalog.statement_timestamp()
                 )
             WHERE project_id = $1
               AND conversation_id = $2`,
      values: [this.projectId, conversationId],
    }, this.context("markConversationBootstrapped"));
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const operation = "listConversations";
    const result = await this.executor.query<ConversationRow>({
      text: `SELECT ${CONVERSATION_COLUMNS}
             FROM lcm.conversations
             WHERE project_id = $1
             ORDER BY created_at, conversation_id`,
      values: [this.projectId],
    }, this.context(operation));
    return result.rows.map((row) =>
      conversationFromRow(row, this.projectId, operation));
  }

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const operation = "createMessage";
    return this.mappedWrite(operation, (transaction) =>
      this.createMessageWith(transaction, input, operation));
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) return [];
    const operation = "createMessagesBulk";
    return this.mappedWrite(operation, (transaction) =>
      this.createMessagesBulkWith(transaction, inputs, operation));
  }

  /**
   * Allocate a contiguous range under the owning conversation's row lock.
   *
   * The lock serializes concurrent appendMessages calls. Explicit-sequence
   * createMessage/createMessagesBulk calls intentionally remain available for
   * replay and import, but callers must not run those operations concurrently
   * with appendMessages for this same conversation.
   */
  async appendMessages(
    conversationId: ConversationId,
    inputs: AppendMessageInput[],
  ): Promise<MessageRecord[]> {
    const operation = "appendMessages";
    if (inputs.length === 0) return [];
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    for (const input of inputs) {
      safeInputInteger(input.tokenCount, this.projectId, operation, "token_count");
    }
    return this.shortTransaction(operation, async (transaction) => {
      await transaction.query({
        text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      }, this.context(operation));
      await transaction.query({
        text: `SELECT conversation_id
               FROM lcm.conversations
               WHERE project_id = $1
                 AND conversation_id = $2
               FOR UPDATE`,
        values: [this.projectId, conversationId],
      }, this.context(operation));
      const maximum = await transaction.query<MaxSeqRow>({
        text: `SELECT MAX(seq) AS max_seq
               FROM lcm.messages
               WHERE project_id = $1
                 AND conversation_id = $2`,
        values: [this.projectId, conversationId],
      }, this.context(operation));
      const rawMaximum = maximum.rows[0]?.max_seq ?? null;
      const nextSeq = rawMaximum === null
        ? 0
        : safeInteger(rawMaximum, this.projectId, operation, "max_seq") + 1;
      if (!Number.isSafeInteger(nextSeq + inputs.length - 1)) {
        throw new PostgreSqlConversationDataError(
          this.projectId,
          operation,
          "seq",
        );
      }
      return this.createMessagesBulkWith(
        transaction,
        inputs.map((input, offset) => ({
          ...input,
          conversationId,
          seq: nextSeq + offset,
        })),
        operation,
      );
    });
  }

  async getMessages(
    conversationId: ConversationId,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const operation = "getMessages";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const afterSeq = options?.afterSeq ?? -1;
    safeInputInteger(afterSeq, this.projectId, operation, "after_seq");
    if (options?.limit !== undefined) {
      safeInputInteger(options.limit, this.projectId, operation, "limit");
    }
    const values: unknown[] = [this.projectId, conversationId, afterSeq];
    const hasBoundedLimit = options?.limit !== undefined && options.limit >= 0;
    const limit = hasBoundedLimit ? " LIMIT $4" : "";
    if (hasBoundedLimit) values.push(options.limit);
    const result = await this.executor.query<MessageRow>({
      text: `SELECT ${MESSAGE_COLUMNS}
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2
               AND seq > $3
             ORDER BY seq, message_id${limit}`,
      values,
    }, this.context(operation));
    return result.rows.map((row) => messageFromRow(row, this.projectId, operation));
  }

  async getLastMessage(
    conversationId: ConversationId,
  ): Promise<MessageRecord | null> {
    const operation = "getLastMessage";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await this.executor.query<MessageRow>({
      text: `SELECT ${MESSAGE_COLUMNS}
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2
             ORDER BY seq DESC, message_id DESC
             LIMIT 1`,
      values: [this.projectId, conversationId],
    }, this.context(operation));
    const row = result.rows[0];
    return row ? messageFromRow(row, this.projectId, operation) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const operation = "hasMessage";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await this.executor.query({
      text: `SELECT 1
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2
               AND role = $3
               AND content = $4
             LIMIT 1`,
      values: [this.projectId, conversationId, role, content],
    }, this.context(operation));
    return result.rowCount === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    const operation = "countMessagesByIdentity";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await this.executor.query<CountRow>({
      text: `SELECT COUNT(*) AS count
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2
               AND role = $3
               AND content = $4`,
      values: [this.projectId, conversationId, role, content],
    }, this.context(operation));
    return this.count(result.rows[0], operation);
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const operation = "getMessageById";
    safeInputInteger(messageId, this.projectId, operation, "message_id");
    const result = await this.executor.query<MessageRow>({
      text: `SELECT ${MESSAGE_COLUMNS}
             FROM lcm.messages
             WHERE project_id = $1
               AND message_id = $2`,
      values: [this.projectId, messageId],
    }, this.context(operation));
    const row = result.rows[0];
    return row ? messageFromRow(row, this.projectId, operation) : null;
  }

  async createMessageParts(
    messageId: MessageId,
    parts: CreateMessagePartInput[],
  ): Promise<void> {
    const operation = "createMessageParts";
    if (parts.length === 0) return;
    safeInputInteger(messageId, this.projectId, operation, "message_id");
    for (const part of parts) {
      safeInputInteger(part.ordinal, this.projectId, operation, "ordinal");
    }
    await this.executor.query({
      text: `WITH input AS (
               SELECT element.input_ordinal,
                      element.payload ->> 'session_id' AS session_id,
                      element.payload ->> 'part_type' AS part_type,
                      (element.payload ->> 'ordinal')::pg_catalog.int4 AS ordinal,
                      element.payload ->> 'text_content' AS text_content,
                      element.payload ->> 'tool_call_id' AS tool_call_id,
                      element.payload ->> 'tool_name' AS tool_name,
                      element.payload ->> 'tool_input' AS tool_input,
                      element.payload ->> 'tool_output' AS tool_output,
                      element.payload ->> 'metadata' AS metadata
               FROM pg_catalog.jsonb_array_elements(
                 $3::pg_catalog.jsonb
               ) WITH ORDINALITY AS element(payload, input_ordinal)
             )
             INSERT INTO lcm.message_parts (
               project_id, conversation_id, message_id, session_id, part_type,
               ordinal, text_content, tool_call_id, tool_name, tool_input,
               tool_output, metadata
             )
             SELECT $1,
                    (
                      SELECT conversation_id
                      FROM lcm.messages
                      WHERE project_id = $1
                        AND message_id = $2
                    ),
                    $2, input.session_id, input.part_type, input.ordinal,
                    input.text_content, input.tool_call_id, input.tool_name,
                    input.tool_input, input.tool_output, input.metadata
             FROM input
             ORDER BY input.input_ordinal`,
      values: [this.projectId, messageId, messagePartInputJson(parts)],
    }, this.context(operation));
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const operation = "getMessageParts";
    safeInputInteger(messageId, this.projectId, operation, "message_id");
    const result = await this.executor.query<MessagePartRow>({
      text: `SELECT ${MESSAGE_PART_COLUMNS}
             FROM lcm.message_parts
             WHERE project_id = $1
               AND message_id = $2
             ORDER BY ordinal, part_id`,
      values: [this.projectId, messageId],
    }, this.context(operation));
    return result.rows.map((row) =>
      messagePartFromRow(row, this.projectId, operation));
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const operation = "getMessageCount";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await this.executor.query<CountRow>({
      text: `SELECT COUNT(*) AS count
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2`,
      values: [this.projectId, conversationId],
    }, this.context(operation));
    return this.count(result.rows[0], operation);
  }

  async getMessageCountBySessionId(sessionId: string): Promise<number> {
    const operation = "getMessageCountBySessionId";
    const result = await this.executor.query<CountRow>({
      text: `SELECT COUNT(message.message_id) AS count
             FROM lcm.conversations AS conversation
             LEFT JOIN lcm.messages AS message
               ON message.project_id = conversation.project_id
              AND message.conversation_id = conversation.conversation_id
             WHERE conversation.project_id = $1
               AND conversation.session_id_sha256 = public.digest($2, 'sha256')
               AND conversation.session_id = $2`,
      values: [this.projectId, sessionId],
    }, this.context(operation));
    return this.count(result.rows[0], operation);
  }

  /**
   * Preserve SQLite's legacy 0 for both an empty conversation and a maximum
   * sequence of 0. Callers that need an emptiness test must use
   * getMessageCount instead.
   */
  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const operation = "getMaxSeq";
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await this.executor.query<MaxSeqRow>({
      text: `SELECT COALESCE(MAX(seq), 0) AS max_seq
             FROM lcm.messages
             WHERE project_id = $1
               AND conversation_id = $2`,
      values: [this.projectId, conversationId],
    }, this.context(operation));
    const value = result.rows[0]?.max_seq ?? 0;
    return safeInteger(value, this.projectId, operation, "max_seq");
  }

  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    const operation = "deleteMessages";
    if (messageIds.length === 0) return 0;
    for (const messageId of messageIds) {
      safeInputInteger(messageId, this.projectId, operation, "message_id");
    }
    const result = await this.executor.query<CountRow>({
      text: `WITH requested AS (
               SELECT requested.message_id, requested.input_ordinal
               FROM pg_catalog.unnest(
                 $2::pg_catalog.int8[]
               ) WITH ORDINALITY AS requested(message_id, input_ordinal)
             ),
             deletable AS (
               SELECT message.message_id
               FROM lcm.messages AS message
               INNER JOIN requested
                 ON requested.message_id = message.message_id
               WHERE message.project_id = $1
                 AND NOT EXISTS (
                   SELECT 1
                   FROM lcm.summary_messages AS summary_message
                   WHERE summary_message.project_id = $1
                     AND summary_message.message_id = message.message_id
                 )
             ),
             deleted_context AS (
               DELETE FROM lcm.context_items AS context_item
               USING deletable
               WHERE context_item.project_id = $1
                 AND context_item.item_type = 'message'
                 AND context_item.message_id = deletable.message_id
               RETURNING context_item.message_id
             ),
             deleted_messages AS (
               DELETE FROM lcm.messages AS message
               USING deletable
               WHERE message.project_id = $1
                 AND message.message_id = deletable.message_id
                 AND (
                   /* Data dependency: delete context rows before their messages. */
                   SELECT COUNT(*) FROM deleted_context
                 ) >= 0
               RETURNING message.message_id
             )
             SELECT COUNT(*) AS count
             FROM deleted_messages`,
      values: [this.projectId, messageIds],
    }, this.context(operation));
    return this.count(result.rows[0], operation);
  }

  private context(operation: string): PostgreSqlConversationTransactionContext {
    return {
      domain: "conversations",
      operation,
      projectId: this.projectId,
    };
  }

  private count(row: CountRow | undefined, operation: string): number {
    return safeInteger(row?.count ?? 0, this.projectId, operation, "count");
  }

  private validateMessageInput(input: CreateMessageInput, operation: string): void {
    safeInputInteger(
      input.conversationId,
      this.projectId,
      operation,
      "conversation_id",
    );
    safeInputInteger(input.seq, this.projectId, operation, "seq");
    safeInputInteger(input.tokenCount, this.projectId, operation, "token_count");
  }

  private async createConversationWith(
    executor: PostgreSqlQueryExecutor,
    input: CreateConversationInput,
    operation: string,
  ): Promise<ConversationRecord> {
    const result = await executor.query<ConversationRow>({
      text: `INSERT INTO lcm.conversations (project_id, session_id, title)
             VALUES ($1, $2, $3)
             RETURNING ${CONVERSATION_COLUMNS}`,
      values: [this.projectId, input.sessionId, input.title ?? null],
    }, this.context(operation));
    const row = result.rows[0];
    if (!row) throw new PostgreSqlConversationDataError(
      this.projectId,
      operation,
      "conversation",
    );
    return conversationFromRow(row, this.projectId, operation);
  }

  private async getConversationWith(
    executor: PostgreSqlQueryExecutor,
    conversationId: ConversationId,
    operation: string,
  ): Promise<ConversationRecord | null> {
    safeInputInteger(conversationId, this.projectId, operation, "conversation_id");
    const result = await executor.query<ConversationRow>({
      text: `SELECT ${CONVERSATION_COLUMNS}
             FROM lcm.conversations
             WHERE project_id = $1
               AND conversation_id = $2`,
      values: [this.projectId, conversationId],
    }, this.context(operation));
    const row = result.rows[0];
    return row ? conversationFromRow(row, this.projectId, operation) : null;
  }

  private async createMessageWith(
    executor: PostgreSqlQueryExecutor,
    input: CreateMessageInput,
    operation: string,
  ): Promise<MessageRecord> {
    this.validateMessageInput(input, operation);
    const result = await executor.query<MessageRow>({
      text: `INSERT INTO lcm.messages (
               project_id, conversation_id, seq, role, content, token_count
             )
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${MESSAGE_COLUMNS}`,
      values: [
        this.projectId,
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
      ],
    }, this.context(operation));
    const row = result.rows[0];
    if (!row) throw new PostgreSqlConversationDataError(
      this.projectId,
      operation,
      "message",
    );
    return messageFromRow(row, this.projectId, operation);
  }

  private async getConversationBySessionIdWith(
    executor: PostgreSqlQueryExecutor,
    sessionId: string,
    operation: string,
  ): Promise<ConversationRecord | null> {
    const result = await executor.query<ConversationRow>({
      text: `SELECT ${CONVERSATION_COLUMNS}
             FROM lcm.conversations
             WHERE project_id = $1
               AND session_id_sha256 = public.digest($2, 'sha256')
               AND session_id = $2
             ORDER BY created_at DESC, conversation_id DESC
             LIMIT 1`,
      values: [this.projectId, sessionId],
    }, this.context(operation));
    const row = result.rows[0];
    return row ? conversationFromRow(row, this.projectId, operation) : null;
  }

  private async createMessagesBulkWith(
    executor: PostgreSqlQueryExecutor,
    inputs: CreateMessageInput[],
    operation: string,
  ): Promise<MessageRecord[]> {
    for (const input of inputs) this.validateMessageInput(input, operation);
    const result = await executor.query<MessageRow>({
      text: `WITH input AS (
               SELECT element.input_ordinal,
                      (element.payload ->> 'conversation_id')::pg_catalog.int8
                        AS conversation_id,
                      (element.payload ->> 'seq')::pg_catalog.int8 AS seq,
                      element.payload ->> 'role' AS role,
                      element.payload ->> 'content' AS content,
                      (element.payload ->> 'token_count')::pg_catalog.int8
                        AS token_count
               FROM pg_catalog.jsonb_array_elements(
                 $2::pg_catalog.jsonb
               ) WITH ORDINALITY AS element(payload, input_ordinal)
             ),
             inserted AS (
               INSERT INTO lcm.messages (
                 project_id, conversation_id, seq, role, content, token_count
               )
               SELECT $1, input.conversation_id, input.seq, input.role,
                      input.content, input.token_count
               FROM input
               ORDER BY input.input_ordinal
               RETURNING ${MESSAGE_COLUMNS}
             )
             SELECT ${MESSAGE_COLUMNS.split(", ").map((column) =>
               `inserted.${column}`).join(", ")}
             FROM inserted
             INNER JOIN input
               ON input.conversation_id = inserted.conversation_id
               AND input.seq = inserted.seq
             ORDER BY input.input_ordinal`,
      values: [this.projectId, messageInputJson(inputs)],
    }, this.context(operation));
    return result.rows.map((row) => messageFromRow(row, this.projectId, operation));
  }

  private mappedWrite<T>(
    operation: string,
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    return typeof this.executor.transaction === "function"
      ? this.executor.transaction(callback, this.context(operation))
      : callback(this.executor);
  }

  private async shortTransaction<T>(
    operation: string,
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    let attempt = 1;
    while (true) {
      try {
        return await this.executor.transaction(
          callback,
          this.context(operation),
        );
      } catch (error) {
        if (error instanceof PostgreSqlCommitOutcomeUnknownError) throw error;
        if (
          attempt === MAX_SHORT_TRANSACTION_ATTEMPTS
          || !SHORT_TRANSACTION_RETRY_SQLSTATES.has(sqlState(error) ?? "")
        ) {
          throw error;
        }
        attempt += 1;
      }
    }
  }
}
