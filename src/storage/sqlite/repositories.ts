import type { DatabaseSync } from "node:sqlite";
import {
  PromotedStore,
  parsePromotedMetadata,
  parsePromotedTags,
  type PromotedRow,
} from "../../db/promoted.js";
import { RecallStore } from "../../db/recall.js";
import {
  getRedactionCounts,
  upsertRedactionCounts,
  validateRedactionCounts,
} from "../../db/redaction-stats.js";
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
import { sessionInstructionsScopeHash } from "../session-instructions.js";

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
    metadata: parsePromotedMetadata(row.metadata),
    sourceSummaryId: row.source_summary_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    depth: row.depth,
    confidence: row.confidence,
    createdAt: canonicalUtcTimestamp(row.created_at),
    archivedAt: row.archived_at === null
      ? null
      : canonicalUtcTimestamp(row.archived_at),
  };
}

function canonicalUtcTimestamp(value: string): string {
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u
    .test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = new Date(sqliteUtc);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("stored timestamp is malformed");
  }
  return timestamp.toISOString();
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
        const since = filters.since === undefined
          ? undefined
          : canonicalUtcTimestamp(filters.since);
        return promoted.getAll({
          ...filters,
          since,
          projectId: sourceProjectId,
        }).map(promotedRecord);
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
      getFeedback: (ids) => invoke("recall", "getFeedback", () => {
        const feedback = recall.getFeedback(ids);
        return new Map([...feedback].map(([id, value]) => [
          id,
          {
            ...value,
            lastSurfacedAt: value.lastSurfacedAt === null
              ? null
              : canonicalUtcTimestamp(value.lastSurfacedAt),
          },
        ]));
      }),
      getStats: () => invoke("recall", "getStats", () => recall.getStats()),
    },
    redactionAdmin: {
      upsertCounts: (counts) => {
        let normalized;
        try {
          normalized = validateRedactionCounts(counts);
        } catch (error) {
          return Promise.reject(normalizeStorageError(error, {
            backend: "sqlite",
            projectId,
            domain: "redaction-admin",
            operation: "upsertCounts",
          }));
        }
        return invoke(
          "redaction-admin",
          "upsertCounts",
          () => upsertRedactionCounts(db, projectId, normalized),
          true,
        );
      },
      getCounts: () => invoke(
        "redaction-admin",
        "getCounts",
        () => getRedactionCounts(db, projectId),
      ),
      purgeProjectState: () => invoke("redaction-admin", "purgeProjectState", () => {
        const promotedRows = db.prepare("SELECT tags FROM promoted").all() as Array<{
          tags: string;
        }>;
        const promotedTags = promotedRows.reduce(
          (total, row) => total + parsePromotedTags(row.tags).length,
          0,
        );
        const hasPromotedFts = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promoted_fts'",
        ).get() !== undefined;
        if (hasPromotedFts) db.prepare("DELETE FROM promoted_fts").run();
        const recallSurfacings = Number(
          db.prepare("DELETE FROM recall_surfacing").run().changes,
        );
        const promotedMemories = Number(
          db.prepare("DELETE FROM promoted").run().changes,
        );
        const redactionCounters = Number(db.prepare(
          "DELETE FROM redaction_stats WHERE project_id = ?",
        ).run(projectId).changes);
        const sessionIngestLogs = Number(
          db.prepare("DELETE FROM session_ingest_log").run().changes,
        );
        const sessionInstructions = Number(
          db.prepare("DELETE FROM session_instruction_cache").run().changes,
        );
        return {
          promotedMemories,
          promotedTags,
          recallSurfacings,
          redactionCounters,
          sessionIngestLogs,
          sessionInstructions,
        };
      }, true),
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
        return row ? {
          sessionId: row.session_id,
          messageCount: row.message_count,
          completedAt: canonicalUtcTimestamp(row.completed_at),
        } : null;
      }),
      recordSessionIngest: (sessionId, messageCount) => invoke("coordination", "recordSessionIngest", () => {
        db.prepare(
          "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, completed_at = datetime('now')",
        ).run(sessionId, messageCount);
      }),
      getSessionInstructions: (scope) => invoke("coordination", "getSessionInstructions", () => {
        const scopeHash = sessionInstructionsScopeHash(scope);
        const row = db.prepare(
          `SELECT client_name, session_id, worktree_path, cwd_path,
                  content, content_hash, updated_at
             FROM session_instruction_cache
             WHERE project_id = ?
               AND scope_hash = ?
               AND client_name = ?
               AND session_id = ?
               AND worktree_path = ?
               AND cwd_path = ?`,
        ).get(
          projectId,
          scopeHash,
          scope.clientName,
          scope.sessionId,
          scope.worktreePath,
          scope.cwdPath,
        ) as {
          client_name: "claude" | "codex";
          session_id: string;
          worktree_path: string;
          cwd_path: string;
          content: string;
          content_hash: string;
          updated_at: string;
        } | undefined;
        return row ? {
          clientName: row.client_name,
          sessionId: row.session_id,
          worktreePath: row.worktree_path,
          cwdPath: row.cwd_path,
          content: row.content,
          contentHash: row.content_hash,
          updatedAt: canonicalUtcTimestamp(row.updated_at),
        } : null;
      }),
      upsertSessionInstructions: (scope, content, contentHash) => invoke("coordination", "upsertSessionInstructions", () => {
        const scopeHash = sessionInstructionsScopeHash(scope);
        const result = db.prepare(
          `INSERT INTO session_instruction_cache (
             project_id, scope_hash, client_name, session_id,
             worktree_path, cwd_path, content, content_hash, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(project_id, scope_hash) DO UPDATE SET
             content = excluded.content,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at
           WHERE session_instruction_cache.client_name = excluded.client_name
             AND session_instruction_cache.session_id = excluded.session_id
             AND session_instruction_cache.worktree_path = excluded.worktree_path
             AND session_instruction_cache.cwd_path = excluded.cwd_path`,
        ).run(
          projectId,
          scopeHash,
          scope.clientName,
          scope.sessionId,
          scope.worktreePath,
          scope.cwdPath,
          content,
          contentHash,
        );
        if (result.changes !== 1) {
          throw new Error("instruction-cache scope hash collision");
        }
      }),
      deleteSessionInstructions: (scope) => invoke("coordination", "deleteSessionInstructions", () => {
        const scopeHash = sessionInstructionsScopeHash(scope);
        db.prepare(
          `DELETE FROM session_instruction_cache
           WHERE project_id = ?
             AND scope_hash = ?
             AND client_name = ?
             AND session_id = ?
             AND worktree_path = ?
             AND cwd_path = ?`,
        ).run(
          projectId,
          scopeHash,
          scope.clientName,
          scope.sessionId,
          scope.worktreePath,
          scope.cwdPath,
        );
      }),
    },
  };
  return Object.freeze(repositories);
}
