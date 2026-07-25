import type { DatabaseSync } from "node:sqlite";
import { PromotedStore, parsePromotedTags, type PromotedRow } from "../../db/promoted.js";
import { RecallStore } from "../../db/recall.js";
import { upsertRedactionCounts } from "../../db/redaction-stats.js";
import {
  ConversationStore,
  getConversationStoreAtomicCore,
  type ConversationStoreAtomicCore,
  validateConversationAppendBatch,
  validateConversationMessageBatch,
  validateConversationPartBatch,
} from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import type {
  ProjectRepositories,
  PromotedMemoryRecord,
  StorageDomain,
} from "../contracts.js";
import { normalizeStorageError } from "../errors.js";

export type RepositoryInvoker = <T>(
  domain: StorageDomain,
  operation: string,
  callback: () => T | Promise<T>,
  atomic?: boolean,
) => Promise<T>;

export interface SqliteRepositoryStores {
  db: DatabaseSync;
  conversations: ConversationStore;
  conversationAtomic: ConversationStoreAtomicCore;
  summaries: SummaryStore;
  promoted: PromotedStore;
  recall: RecallStore;
}

export function createSqliteRepositoryStores(
  db: DatabaseSync,
  options?: { fts5Available?: boolean },
): SqliteRepositoryStores {
  const conversations = new ConversationStore(db, options);
  return {
    db,
    conversations,
    conversationAtomic: getConversationStoreAtomicCore(conversations),
    summaries: new SummaryStore(db, options),
    promoted: new PromotedStore(db, options?.fts5Available),
    recall: new RecallStore(db),
  };
}

function promotedRecord(row: PromotedRow): PromotedMemoryRecord {
  return {
    id: row.id,
    content: row.content,
    tags: parsePromotedTags(row.tags),
    sourceSummaryId: row.source_summary_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    depth: row.depth,
    confidence: row.confidence,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export function createSqliteRepositories(
  stores: SqliteRepositoryStores,
  projectId: string,
  invoke: RepositoryInvoker,
): ProjectRepositories {
  const conversations = stores.conversations;
  const conversationAtomic = stores.conversationAtomic;
  const summaries = stores.summaries;
  const promoted = stores.promoted;
  const recall = stores.recall;
  const db = stores.db;
  const prevalidatedConversationOperation = <T>(
    operation: string,
    validate: () => void,
    invokeValidated: () => Promise<T>,
  ): Promise<T> => {
    try {
      validate();
    } catch (error) {
      return Promise.reject(normalizeStorageError(error, {
        backend: "sqlite",
        projectId,
        domain: "conversations",
        operation,
      }));
    }
    return invokeValidated();
  };

  const repositories: ProjectRepositories = {
    conversations: {
      createConversation: (input) => invoke("conversations", "createConversation", () => conversations.createConversation(input)),
      getConversation: (id) => invoke("conversations", "getConversation", () => conversations.getConversation(id)),
      getConversationBySessionId: (sessionId) => invoke("conversations", "getConversationBySessionId", () => conversations.getConversationBySessionId(sessionId)),
      getOrCreateConversation: (sessionId, title) => invoke("conversations", "getOrCreateConversation", () => conversations.getOrCreateConversation(sessionId, title)),
      markConversationBootstrapped: (id) => invoke("conversations", "markConversationBootstrapped", () => conversations.markConversationBootstrapped(id)),
      listConversations: () => invoke("conversations", "listConversations", () => conversations.listConversations()),
      createMessage: (input) => invoke("conversations", "createMessage", () => conversations.createMessage(input)),
      createMessagesBulk: (inputs) => inputs.length === 0
        ? Promise.resolve([])
        : prevalidatedConversationOperation(
            "createMessagesBulk",
            () => validateConversationMessageBatch(inputs),
            () => invoke("conversations", "createMessagesBulk", () => conversationAtomic.createMessagesBulk(inputs), true),
          ),
      appendMessages: (id, inputs) => inputs.length === 0
        ? Promise.resolve([])
        : prevalidatedConversationOperation(
            "appendMessages",
            () => validateConversationAppendBatch(inputs),
            () => invoke("conversations", "appendMessages", () => conversationAtomic.appendMessages(id, inputs), true),
          ),
      getMessages: (id, options) => invoke("conversations", "getMessages", () => conversations.getMessages(id, options)),
      getLastMessage: (id) => invoke("conversations", "getLastMessage", () => conversations.getLastMessage(id)),
      hasMessage: (id, role, content) => invoke("conversations", "hasMessage", () => conversations.hasMessage(id, role, content)),
      countMessagesByIdentity: (id, role, content) => invoke("conversations", "countMessagesByIdentity", () => conversations.countMessagesByIdentity(id, role, content)),
      getMessageById: (id) => invoke("conversations", "getMessageById", () => conversations.getMessageById(id)),
      createMessageParts: (id, parts) => parts.length === 0
        ? Promise.resolve()
        : prevalidatedConversationOperation(
            "createMessageParts",
            () => validateConversationPartBatch(parts),
            () => invoke("conversations", "createMessageParts", () => conversationAtomic.createMessageParts(id, parts), true),
          ),
      getMessageParts: (id) => invoke("conversations", "getMessageParts", () => conversations.getMessageParts(id)),
      getMessageCount: (id) => invoke("conversations", "getMessageCount", () => conversations.getMessageCount(id)),
      getMessageCountBySessionId: (sessionId) => invoke("conversations", "getMessageCountBySessionId", () => conversations.getMessageCountBySessionId(sessionId)),
      getMaxSeq: (id) => invoke("conversations", "getMaxSeq", () => conversations.getMaxSeq(id)),
      deleteMessages: (ids) => ids.length === 0
        ? Promise.resolve(0)
        : invoke("conversations", "deleteMessages", () => conversationAtomic.deleteMessages(ids), true),
    },
    summaries: {
      insertSummary: (input) => invoke("summaries", "insertSummary", () => summaries.insertSummary(input)),
      getSummary: (id) => invoke("summaries", "getSummary", () => summaries.getSummary(id)),
      getSummariesByConversation: (id) => invoke("summaries", "getSummariesByConversation", () => summaries.getSummariesByConversation(id)),
      listRecentSummaries: (limit) => invoke("summaries", "listRecentSummaries", () => summaries.listRecentSummaries(limit)),
      listRecentSummariesForSession: (sessionId, limit) => invoke("summaries", "listRecentSummariesForSession", () => summaries.listRecentSummariesForSession(sessionId, limit)),
      linkSummaryToMessages: (id, messageIds) => invoke("summaries", "linkSummaryToMessages", () => summaries.linkSummaryToMessages(id, messageIds)),
      linkSummaryToParents: (id, parentIds) => invoke("summaries", "linkSummaryToParents", () => summaries.linkSummaryToParents(id, parentIds)),
      getSummaryMessages: (id) => invoke("summaries", "getSummaryMessages", () => summaries.getSummaryMessages(id)),
      getSummaryChildren: (id) => invoke("summaries", "getSummaryChildren", () => summaries.getSummaryChildren(id)),
      getSummaryParents: (id) => invoke("summaries", "getSummaryParents", () => summaries.getSummaryParents(id)),
      getSummarySubtree: (id) => invoke("summaries", "getSummarySubtree", () => summaries.getSummarySubtree(id)),
    },
    context: {
      getContextItems: (id) => invoke("context", "getContextItems", () => summaries.getContextItems(id)),
      getDistinctDepthsInContext: (id, options) => invoke("context", "getDistinctDepthsInContext", () => summaries.getDistinctDepthsInContext(id, options)),
      appendContextMessage: (id, messageId) => invoke("context", "appendContextMessage", () => summaries.appendContextMessage(id, messageId)),
      appendContextMessages: (id, messageIds) => invoke("context", "appendContextMessages", () => summaries.appendContextMessages(id, messageIds)),
      appendContextSummary: (id, summaryId) => invoke("context", "appendContextSummary", () => summaries.appendContextSummary(id, summaryId)),
      replaceContextRangeWithSummary: (input) => invoke("context", "replaceContextRangeWithSummary", () => summaries.replaceContextRangeWithSummary(input)),
      getContextTokenCount: (id) => invoke("context", "getContextTokenCount", () => summaries.getContextTokenCount(id)),
    },
    largeFiles: {
      insertLargeFile: (input) => invoke("large-files", "insertLargeFile", () => summaries.insertLargeFile(input)),
      getLargeFile: (id) => invoke("large-files", "getLargeFile", () => summaries.getLargeFile(id)),
      getLargeFilesByConversation: (id) => invoke("large-files", "getLargeFilesByConversation", () => summaries.getLargeFilesByConversation(id)),
    },
    promotedMemory: {
      insert: ({ sourceProjectId, ...input }) => invoke("promoted-memory", "insert", () => promoted.insert({
        ...input,
        projectId: sourceProjectId ?? projectId,
      })),
      getById: (id) => invoke("promoted-memory", "getById", () => {
        const row = promoted.getById(id);
        return row ? promotedRecord(row) : null;
      }),
      getAll: (options) => invoke("promoted-memory", "getAll", () => {
        const { sourceProjectId, ...filters } = options ?? {};
        return promoted.getAll({ ...filters, projectId: sourceProjectId }).map(promotedRecord);
      }),
      listContentPrefixes: (limit) => invoke("promoted-memory", "listContentPrefixes", () => promoted.listContentPrefixes(limit)),
      archive: (id) => invoke("promoted-memory", "archive", () => promoted.archive(id)),
      deleteById: (id) => invoke("promoted-memory", "deleteById", () => promoted.deleteById(id)),
      update: (id, fields) => invoke("promoted-memory", "update", () => promoted.update(id, fields)),
      findStale: ({ sourceProjectId, ...options }) => invoke("promoted-memory", "findStale", () =>
        promoted.findStale({ ...options, projectId: sourceProjectId }).map((row) => ({
          ...promotedRecord(row),
          surfacingCount: row.surfacingCount,
          usageCount: row.usageCount,
          daysSinceCreated: row.daysSinceCreated,
        }))),
      revive: (id) => invoke("promoted-memory", "revive", () => promoted.revive(id)),
    },
    recall: {
      logSurfacing: (ids, sessionId) => invoke("recall", "logSurfacing", () => recall.logSurfacing(ids, sessionId)),
      getFeedback: (ids) => invoke("recall", "getFeedback", () => recall.getFeedback(ids)),
      getStats: () => invoke("recall", "getStats", () => recall.getStats()),
    },
    redactionAdmin: {
      upsertCounts: (counts) => invoke("redaction-admin", "upsertCounts", () => upsertRedactionCounts(db, projectId, counts)),
    },
    lexicalSearch: {
      searchMessages: (input) => invoke("lexical-search", "searchMessages", () => conversations.searchMessages(input)),
      searchSummaries: (input) => invoke("lexical-search", "searchSummaries", () => summaries.searchSummaries(input)),
      searchPromoted: (query, limit, filterTags, sourceProjectId) => invoke("lexical-search", "searchPromoted", () =>
        promoted.search(query, limit, filterTags, sourceProjectId)),
    },
    coordination: {
      getSessionIngest: (sessionId) => invoke("coordination", "getSessionIngest", () => {
        const row = db.prepare(
          "SELECT session_id, message_count, completed_at FROM session_ingest_log WHERE session_id = ?",
        ).get(sessionId) as { session_id: string; message_count: number; completed_at: string } | undefined;
        return row ? { sessionId: row.session_id, messageCount: row.message_count, completedAt: row.completed_at } : null;
      }),
      recordSessionIngest: (sessionId, messageCount) => invoke("coordination", "recordSessionIngest", () => {
        db.prepare(
          "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, completed_at = datetime('now')",
        ).run(sessionId, messageCount);
      }),
      getSessionInstructions: (id, fallbackLegacyId) => invoke("coordination", "getSessionInstructions", () => {
        const select = (rowId: number): { id: number; content: string; content_hash: string; updated_at: string } | undefined =>
          db.prepare(
            "SELECT id, content, content_hash, updated_at FROM session_instruction_cache WHERE id = ?",
          ).get(rowId) as { id: number; content: string; content_hash: string; updated_at: string } | undefined;
        const row = select(id) ?? (fallbackLegacyId === undefined ? undefined : select(fallbackLegacyId));
        return row ? {
          id: row.id,
          content: row.content,
          contentHash: row.content_hash,
          updatedAt: row.updated_at,
        } : null;
      }),
      upsertSessionInstructions: (id, content, contentHash) => invoke("coordination", "upsertSessionInstructions", () => {
        db.prepare(
          `INSERT INTO session_instruction_cache (id, content, content_hash, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
        ).run(id, content, contentHash);
      }),
      deleteSessionInstructions: (id) => invoke("coordination", "deleteSessionInstructions", () => {
        db.prepare("DELETE FROM session_instruction_cache WHERE id = ?").run(id);
      }),
    },
  };
  return Object.freeze(repositories);
}
