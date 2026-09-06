import type { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";
import { validateRegex } from "./regex-safety.js";

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
};

export type AppendMessageInput = Omit<CreateMessageInput, "conversationId" | "seq">;

class ConversationInputError extends RangeError {
  readonly field: string;

  constructor(field: string) {
    super("conversation text input contains an unsupported NUL character");
    this.name = "ConversationInputError";
    this.field = field;
  }

  toJSON(): Record<string, string> {
    return { name: this.name, field: this.field, message: this.message };
  }
}

function validateConversationText(
  value: string | null | undefined,
  field: string,
): void {
  if (value?.includes("\0")) {
    throw new ConversationInputError(field);
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function validateMessageInputs(inputs: readonly CreateMessageInput[]): void {
  for (const input of inputs) {
    validateNonNegativeSafeInteger(input.seq, "message seq");
    validateNonNegativeSafeInteger(input.tokenCount, "message tokenCount");
    validateConversationText(input.content, "content");
  }
}

function validateAppendTokenCounts(inputs: readonly AppendMessageInput[]): void {
  for (const input of inputs) {
    validateNonNegativeSafeInteger(input.tokenCount, "message tokenCount");
    validateConversationText(input.content, "content");
  }
}

function validateMessageParts(parts: readonly CreateMessagePartInput[]): void {
  for (const part of parts) {
    validateNonNegativeSafeInteger(part.ordinal, "message part ordinal");
    validateConversationText(part.sessionId, "session_id");
    validateConversationText(part.textContent, "text_content");
    validateConversationText(part.toolCallId, "tool_call_id");
    validateConversationText(part.toolName, "tool_name");
    validateConversationText(part.toolInput, "tool_input");
    validateConversationText(part.toolOutput, "tool_output");
    validateConversationText(part.metadata, "metadata");
  }
}

/** @internal SQLite repository preflight; callers must still use the atomic core for writes. */
export function validateConversationMessageBatch(
  inputs: readonly CreateMessageInput[],
): void {
  validateMessageInputs(inputs);
}

/** @internal SQLite repository preflight; callers must still use the atomic core for writes. */
export function validateConversationAppendBatch(
  inputs: readonly AppendMessageInput[],
): void {
  validateAppendTokenCounts(inputs);
}

/** @internal SQLite repository preflight; callers must still use the atomic core for writes. */
export function validateConversationPartBatch(
  parts: readonly CreateMessagePartInput[],
): void {
  validateMessageParts(parts);
}

function validateConversationInput(input: CreateConversationInput): void {
  validateConversationText(input.sessionId, "session_id");
  validateConversationText(input.title, "title");
}

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
};

export type CreateMessagePartInput = {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
};

export type MessagePartRecord = {
  partId: string;
  messageId: MessageId;
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: string | null;
};

export type CreateConversationInput = {
  sessionId: string;
  title?: string;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  bootstrapped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MessagePartRow {
  part_id: string;
  message_id: number;
  session_id: string;
  part_type: MessagePartType;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

const transactionQueues = new WeakMap<DatabaseSync, Promise<void>>();
const failedDirectDatabases = new WeakSet<DatabaseSync>();
const activeDirectTransactions = new Set<symbol>();
const failedDirectTransactions = new Set<symbol>();
type DirectTransactionContext = {
  db: DatabaseSync;
  token: symbol;
  atomicOrdinal: number;
};
const directTransactionContext = new AsyncLocalStorage<DirectTransactionContext>();
const directAtomicContext = new AsyncLocalStorage<DirectTransactionContext>();
const directAtomicTails = new Map<symbol, Promise<void>>();

/** @internal SQLite repository seam; not exported from the public store module. */
export interface ConversationStoreAtomicCore {
  createMessagesBulk(inputs: CreateMessageInput[]): MessageRecord[];
  appendMessages(
    conversationId: ConversationId,
    inputs: AppendMessageInput[],
  ): MessageRecord[];
  createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): void;
  deleteMessages(messageIds: MessageId[]): number;
}

const conversationStoreAtomicCores =
  new WeakMap<ConversationStore, ConversationStoreAtomicCore>();

/** @internal Used only when an outer SQLite executor already owns atomicity. */
export function getConversationStoreAtomicCore(
  store: ConversationStore,
): ConversationStoreAtomicCore {
  const core = conversationStoreAtomicCores.get(store);
  if (!core) throw new Error("conversation store atomic core is unavailable");
  return core;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function parseStoredTimestamp(value: string): Date {
  // SQLite's CURRENT_TIMESTAMP is UTC but omits a timezone designator. Parse
  // that storage form explicitly as UTC so local DST gaps cannot normalize it
  // to a different wall-clock value. Preserve already-qualified ISO inputs.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized);
}

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    title: row.title,
    bootstrappedAt: row.bootstrapped_at ? new Date(row.bootstrapped_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: parseStoredTimestamp(row.created_at),
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: parseStoredTimestamp(row.created_at),
    rank: row.rank,
  };
}

function toMessagePartRecord(row: MessagePartRow): MessagePartRecord {
  return {
    partId: row.part_id,
    messageId: row.message_id,
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

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fts5Available: boolean;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
    conversationStoreAtomicCores.set(this, {
      createMessagesBulk: (inputs) => this.createMessagesBulkCore(inputs),
      appendMessages: (conversationId, inputs) =>
        this.appendMessagesCore(conversationId, inputs),
      createMessageParts: (messageId, parts) =>
        this.createMessagePartsCore(messageId, parts),
      deleteMessages: (messageIds) => this.deleteMessagesCore(messageIds),
    });
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertDirectTransactionUsable();
    const active = directTransactionContext.getStore();
    if (
      active?.db === this.db
      && activeDirectTransactions.has(active.token)
    ) {
      return operation();
    }
    const previous = transactionQueues.get(this.db) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    transactionQueues.set(this.db, queued);
    await previous;
    const token = Symbol("conversation-store-transaction");
    try {
      this.assertDirectTransactionUsable();
      this.db.exec("BEGIN IMMEDIATE");
      activeDirectTransactions.add(token);
      try {
        const result = await directTransactionContext.run(
          { db: this.db, token, atomicOrdinal: 0 },
          operation,
        );
        await this.drainDirectAtomicOperations(token);
        if (failedDirectTransactions.has(token)) {
          throw new Error("conversation transaction savepoint recovery failed");
        }
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        await this.drainDirectAtomicOperations(token);
        this.recoverDirectTransaction();
        throw error;
      }
    } finally {
      activeDirectTransactions.delete(token);
      failedDirectTransactions.delete(token);
      release();
      if (transactionQueues.get(this.db) === queued) transactionQueues.delete(this.db);
    }
  }

  private async drainDirectAtomicOperations(token: symbol): Promise<void> {
    let pendingAtomic = directAtomicTails.get(token);
    while (pendingAtomic) {
      await pendingAtomic;
      pendingAtomic = directAtomicTails.get(token);
    }
  }

  private assertDirectTransactionUsable(): void {
    if (failedDirectDatabases.has(this.db)) {
      throw new Error("conversation store transaction state is unavailable");
    }
  }

  private recoverDirectTransaction(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.db.exec("ROLLBACK");
        return;
      } catch {
        if (this.db.isTransaction === false) return;
      }
    }
    failedDirectDatabases.add(this.db);
  }

  private async withAtomicOperation<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const active = directTransactionContext.getStore();
    if (
      active?.db !== this.db
      || !activeDirectTransactions.has(active.token)
    ) {
      return this.withTransaction(operation);
    }
    const nested = directAtomicContext.getStore();
    if (nested?.db === this.db && nested.token === active.token) {
      throw new Error("nested atomic conversation operation is not supported");
    }

    const previous = directAtomicTails.get(active.token) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    directAtomicTails.set(active.token, queued);
    await previous;
    try {
      return await this.runDirectAtomic(active, operation);
    } finally {
      release();
      if (directAtomicTails.get(active.token) === queued) {
        directAtomicTails.delete(active.token);
      }
    }
  }

  private async runDirectAtomic<T>(
    active: DirectTransactionContext,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (
      !Number.isSafeInteger(active.atomicOrdinal)
      || active.atomicOrdinal < 0
      || active.atomicOrdinal >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("conversation transaction savepoint ordinal is unavailable");
    }
    const savepoint = `lcm_conversation_atomic_${active.atomicOrdinal++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await directAtomicContext.run(active, operation);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        rolledBack = true;
      } catch {
        failedDirectTransactions.add(active.token);
      }
      if (rolledBack) {
        try {
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // ROLLBACK TO restored the operation boundary. The outer
          // transaction can discard the remaining savepoint bookkeeping.
        }
      }
      throw error;
    }
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    this.assertDirectTransactionUsable();
    validateConversationInput(input);
    const result = this.db
      .prepare(`INSERT INTO conversations (session_id, title) VALUES (?, ?)`)
      .run(input.sessionId, input.title ?? null);

    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    this.assertDirectTransactionUsable();
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    this.assertDirectTransactionUsable();
    validateConversationText(sessionId, "session_id");
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
       ORDER BY created_at DESC, conversation_id DESC
       LIMIT 1`,
      )
      .get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord> {
    this.assertDirectTransactionUsable();
    validateConversationInput({ sessionId, title });
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      return existing;
    }
    return this.createConversation({ sessionId, title });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    this.assertDirectTransactionUsable();
    this.db
      .prepare(
        `UPDATE conversations
       SET bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    this.assertDirectTransactionUsable();
    const rows = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       ORDER BY created_at, conversation_id`,
      )
      .all() as unknown as ConversationRow[];
    return rows.map(toConversationRecord);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    this.assertDirectTransactionUsable();
    validateMessageInputs([input]);
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.conversationId, input.seq, input.role, input.content, input.tokenCount);

    const messageId = Number(result.lastInsertRowid);

    this.indexMessageForFullText(messageId, input.content);

    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow;

    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    this.assertDirectTransactionUsable();
    if (inputs.length === 0) {
      return [];
    }
    validateMessageInputs(inputs);
    return this.withAtomicOperation(() => this.createMessagesBulkCore(inputs));
  }

  private createMessagesBulkCore(inputs: CreateMessageInput[]): MessageRecord[] {
    this.assertDirectTransactionUsable();
    if (inputs.length === 0) return [];
    validateMessageInputs(inputs);
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const selectStmt = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
    );

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      const result = insertStmt.run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
      );

      const messageId = Number(result.lastInsertRowid);
      this.indexMessageForFullText(messageId, input.content);
      const row = selectStmt.get(messageId) as unknown as MessageRow;
      records.push(toMessageRecord(row));
    }

    return records;
  }

  async appendMessages(
    conversationId: ConversationId,
    inputs: AppendMessageInput[],
  ): Promise<MessageRecord[]> {
    this.assertDirectTransactionUsable();
    if (inputs.length === 0) {
      return [];
    }
    validateAppendTokenCounts(inputs);
    return this.withAtomicOperation(() =>
      this.appendMessagesCore(conversationId, inputs));
  }

  private appendMessagesCore(
    conversationId: ConversationId,
    inputs: AppendMessageInput[],
  ): MessageRecord[] {
    this.assertDirectTransactionUsable();
    if (inputs.length === 0) return [];
    validateAppendTokenCounts(inputs);
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS max_seq
         FROM messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as { max_seq: number | null } | undefined;
    const nextSeq = (row?.max_seq ?? -1) + 1;
    return this.createMessagesBulkCore(inputs.map((input, offset) => ({
      ...input,
      conversationId,
      seq: nextSeq + offset,
    })));
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    this.assertDirectTransactionUsable();
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = this.db
        .prepare(
          `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
        )
        .all(conversationId, afterSeq, limit) as unknown as MessageRow[];
      return rows.map(toMessageRecord);
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    this.assertDirectTransactionUsable();
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as unknown as MessageRow | undefined;

    return row ? toMessageRecord(row) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    this.assertDirectTransactionUsable();
    validateConversationText(content, "content");
    const row = this.db
      .prepare(
        `SELECT 1 AS count
       FROM messages
       WHERE conversation_id = ? AND role = ? AND content = ?
       LIMIT 1`,
      )
      .get(conversationId, role, content) as unknown as CountRow | undefined;

    return row?.count === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    this.assertDirectTransactionUsable();
    validateConversationText(content, "content");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND role = ? AND content = ?`,
      )
      .get(conversationId, role, content) as unknown as CountRow | undefined;

    return row?.count ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    this.assertDirectTransactionUsable();
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async createMessageParts(
    messageId: MessageId,
    parts: CreateMessagePartInput[],
  ): Promise<void> {
    this.assertDirectTransactionUsable();
    if (parts.length === 0) {
      return;
    }
    validateMessageParts(parts);
    return this.withAtomicOperation(() =>
      this.createMessagePartsCore(messageId, parts));
  }

  private createMessagePartsCore(
    messageId: MessageId,
    parts: CreateMessagePartInput[],
  ): void {
    this.assertDirectTransactionUsable();
    if (parts.length === 0) return;
    validateMessageParts(parts);
    const stmt = this.db.prepare(
      `INSERT INTO message_parts (
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const part of parts) {
      stmt.run(
        randomUUID(),
        messageId,
        part.sessionId,
        part.partType,
        part.ordinal,
        part.textContent ?? null,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput ?? null,
        part.toolOutput ?? null,
        part.metadata ?? null,
      );
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    this.assertDirectTransactionUsable();
    const rows = this.db
      .prepare(
        `SELECT
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       FROM message_parts
       WHERE message_id = ?
       ORDER BY ordinal`,
      )
      .all(messageId) as unknown as MessagePartRow[];

    return rows.map(toMessagePartRecord);
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    this.assertDirectTransactionUsable();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMessageCountBySessionId(sessionId: string): Promise<number> {
    this.assertDirectTransactionUsable();
    validateConversationText(sessionId, "session_id");
    const row = this.db
      .prepare(
        `SELECT COUNT(m.message_id) AS count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.conversation_id
         WHERE c.session_id = ?`,
      )
      .get(sessionId) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    this.assertDirectTransactionUsable();
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxSeqRow;
    return row?.max_seq ?? 0;
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  /**
   * Delete messages and their associated records (context_items, FTS, message_parts).
   *
   * Skips messages referenced in summary_messages (already compacted) to avoid
   * breaking the summary DAG. Returns the count of actually deleted messages.
   */
  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    this.assertDirectTransactionUsable();
    if (messageIds.length === 0) {
      return 0;
    }
    return this.withAtomicOperation(() => this.deleteMessagesCore(messageIds));
  }

  private deleteMessagesCore(messageIds: MessageId[]): number {
    this.assertDirectTransactionUsable();
    if (messageIds.length === 0) return 0;
    let deleted = 0;
    for (const messageId of messageIds) {
      // Skip if referenced by a summary (ON DELETE RESTRICT would fail anyway)
      const refRow = this.db
        .prepare(`SELECT 1 AS found FROM summary_messages WHERE message_id = ? LIMIT 1`)
        .get(messageId) as unknown as { found: number } | undefined;
      if (refRow) {
        continue;
      }

      // Remove from context_items first (RESTRICT constraint)
      this.db
        .prepare(`DELETE FROM context_items WHERE item_type = 'message' AND message_id = ?`)
        .run(messageId);

      this.deleteMessageFromFullText(messageId);

      // Delete the message (message_parts cascade via ON DELETE CASCADE)
      this.db.prepare(`DELETE FROM messages WHERE message_id = ?`).run(messageId);

      deleted += 1;
    }

    return deleted;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    this.assertDirectTransactionUsable();
    validateConversationText(input.query, "query");
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      if (this.fts5Available) {
        try {
          return this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        }
      }
      return this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  private indexMessageForFullText(messageId: MessageId, content: string): void {
    if (!this.fts5Available) {
      return;
    }
    try {
      this.db
        .prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`)
        .run(messageId, content);
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private deleteMessageFromFullText(messageId: MessageId): void {
    if (!this.fts5Available) {
      return;
    }
    try {
      this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId);
    } catch {
      // Ignore FTS cleanup failures; the source row deletion is authoritative.
    }
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(m.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(m.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         rank,
         m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as MessageSearchRow[];
    return rows.map(toSearchResult);
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    // A non-empty search plan always contributes at least one predicate.
    const whereClause = `WHERE ${where.join(" AND ")}`;
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseStoredTimestamp(row.created_at),
      rank: 0,
    }));
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    const re = validateRegex(pattern);

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as MessageRow[];

    const results: MessageSearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          createdAt: parseStoredTimestamp(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }
}
