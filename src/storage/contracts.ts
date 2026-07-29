import type { ProjectIdentity } from "../project-map.js";
import type {
  AppendMessageInput,
  ConversationId,
  ConversationRecord,
  CreateConversationInput,
  CreateMessageInput,
  CreateMessagePartInput,
  MessageId,
  MessagePartRecord,
  MessageRecord,
  MessageRole,
  MessageSearchInput,
  MessageSearchResult,
} from "../store/conversation-store.js";
import type {
  ContextItemRecord,
  CreateLargeFileInput,
  CreateSummaryInput,
  LargeFileRecord,
  SummaryRecord,
  SummarySearchInput,
  SummarySearchResult,
  SummarySubtreeNodeRecord,
} from "../store/summary-store.js";
import type { RecallFeedback, RecallStats } from "../db/recall.js";

export type StorageBackendName = "sqlite" | "postgresql";
export const NATIVE_TRANSCRIPT_MAX_JSON_DEPTH = 100;

export type StorageDomain =
  | "factory"
  | "identity"
  | "conversations"
  | "native-transcripts"
  | "summaries"
  | "context"
  | "large-files"
  | "promoted-memory"
  | "recall"
  | "redaction-admin"
  | "lexical-search"
  | "coordination"
  | "passive-events"
  | "transaction";

export interface StorageCapabilities {
  readonly transactions: boolean;
  readonly lexicalSearch: boolean;
  readonly regexSearch: boolean;
  /** Native backend full-text indexing; lexical search remains available through a fallback. */
  readonly nativeFullTextSearch: "available" | "unavailable" | "unknown";
  readonly coordination: "local" | "distributed";
}

export interface StorageHealth {
  readonly status: "healthy" | "degraded" | "unavailable" | "closed";
  readonly backend: StorageBackendName;
  readonly projectId?: string;
  readonly error?: import("./errors.js").StorageOperationError;
}

export interface ConversationRepository {
  /**
   * Conversation-domain text inputs reject embedded U+0000 before database
   * access so SQLite and PostgreSQL expose the same text contract.
   */
  createConversation(input: CreateConversationInput): Promise<ConversationRecord>;
  getConversation(conversationId: ConversationId): Promise<ConversationRecord | null>;
  getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null>;
  getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord>;
  markConversationBootstrapped(conversationId: ConversationId): Promise<void>;
  listConversations(): Promise<ConversationRecord[]>;
  /**
   * Create one explicit sequence value for replay/import.
   *
   * Callers must not run explicit-sequence writes concurrently with
   * appendMessages for the same conversation.
   */
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  /**
   * Atomically create explicit sequence values for replay/import.
   *
   * Callers must not run explicit-sequence writes concurrently with
   * appendMessages for the same conversation.
   */
  createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]>;
  /**
   * Atomically allocate and insert the next contiguous sequence range.
   *
   * Concurrent appendMessages calls are serialized per conversation. Callers
   * must not concurrently mix this allocator with explicit-sequence writes
   * for the same conversation.
   */
  appendMessages(
    conversationId: ConversationId,
    inputs: AppendMessageInput[],
  ): Promise<MessageRecord[]>;
  /**
   * Read messages after an exclusive sequence checkpoint.
   *
   * An undefined limit or any negative safe integer is unlimited, zero returns
   * no rows, and a positive safe integer bounds the result.
   */
  getMessages(conversationId: ConversationId, options?: { afterSeq?: number; limit?: number }): Promise<MessageRecord[]>;
  getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null>;
  hasMessage(conversationId: ConversationId, role: MessageRole, content: string): Promise<boolean>;
  countMessagesByIdentity(conversationId: ConversationId, role: MessageRole, content: string): Promise<number>;
  getMessageById(messageId: MessageId): Promise<MessageRecord | null>;
  createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void>;
  getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]>;
  getMessageCount(conversationId: ConversationId): Promise<number>;
  getMessageCountBySessionId(sessionId: string): Promise<number>;
  /**
   * Return the highest sequence, preserving the legacy value 0 when empty.
   *
   * Because a non-empty conversation whose first message has seq 0 also
   * returns 0, use getMessageCount when testing whether a conversation is
   * empty.
   */
  getMaxSeq(conversationId: ConversationId): Promise<number>;
  deleteMessages(messageIds: MessageId[]): Promise<number>;
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface NativeTranscriptMessageLinkRecord {
  readonly transcriptId: string;
  readonly conversationId: number;
  readonly messageId: number;
  readonly sourceOrdinal: number;
}

export interface NativeTranscriptRecord {
  readonly transcriptId: string;
  readonly projectId: string;
  readonly machineId: string;
  readonly clientName: string;
  readonly formatName: string;
  readonly formatVersion: string;
  readonly nativeSessionId: string;
  readonly sourceLocator: string;
  readonly sourceOrdinal: number;
  readonly observedAt: Date;
  readonly ingestedAt: Date;
  readonly scrubberVersion: string;
  readonly contentSha256: string;
  readonly ingestKey: string;
  readonly nativePayload: JsonObject | JsonValue[];
  readonly messageLinks: readonly NativeTranscriptMessageLinkRecord[];
}

export interface CreateNativeTranscriptMessageLinkInput {
  readonly conversationId: number;
  readonly messageId: number;
  readonly sourceOrdinal: number;
}

export interface CreateNativeTranscriptInput {
  readonly formatName: string;
  readonly formatVersion: string;
  readonly nativeSessionId: string;
  readonly sourceOrdinal: number;
  readonly observedAt: Date;
  readonly scrubberVersion: string;
  readonly contentSha256: string;
  readonly ingestKey: string;
  readonly nativePayload: JsonObject | JsonValue[];
  readonly messageLinks?: readonly CreateNativeTranscriptMessageLinkInput[];
}

export interface NativeTranscriptCheckpointKey {
  readonly machineId: string;
  readonly clientName: string;
  readonly sourceLocator: string;
}

export interface NativeTranscriptCheckpointRecord
  extends NativeTranscriptCheckpointKey {
  readonly projectId: string;
  readonly revision: number;
  readonly lastSourceOrdinal: number;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly quarantinedCount: number;
  readonly checkpoint: JsonObject;
  readonly updatedAt: Date;
}

export interface NativeTranscriptBatchInput
  extends NativeTranscriptCheckpointKey {
  readonly expectedCheckpoint: NativeTranscriptCheckpointRecord | null;
  readonly records: readonly CreateNativeTranscriptInput[];
  readonly checkpoint: {
    readonly lastSourceOrdinal: number;
    readonly checkpoint: JsonObject;
  };
  readonly quarantinedCount: number;
}

export interface NativeTranscriptBatchResult {
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly quarantinedCount: number;
  readonly checkpoint: NativeTranscriptCheckpointRecord;
}

export interface NativeTranscriptSessionMessageRecord {
  readonly conversationId: number;
  readonly messageId: number;
  readonly messageSequence: number;
  readonly role: MessageRole;
  readonly content: string;
}

/**
 * Narrow #86 destination-link snapshot seam.
 *
 * Backends must filter by the exact native session server-side and return the
 * complete ordered result from one database statement or transaction snapshot.
 */
export interface NativeTranscriptMessageSnapshotRepository {
  getNativeTranscriptMessageSnapshot(
    nativeSessionId: string,
  ): Promise<readonly NativeTranscriptSessionMessageRecord[]>;
}

export interface NativeTranscriptRepository {
  ingestBatch(
    input: NativeTranscriptBatchInput,
  ): Promise<NativeTranscriptBatchResult>;
  getById(transcriptId: string): Promise<NativeTranscriptRecord | null>;
  listByNativeSession(input: {
    readonly nativeSessionId: string;
  }): Promise<NativeTranscriptRecord[]>;
  listBySource(input: NativeTranscriptCheckpointKey): Promise<NativeTranscriptRecord[]>;
  listByMessage(input: {
    readonly conversationId: number;
    readonly messageId: number;
  }): Promise<NativeTranscriptRecord[]>;
  getCheckpoint(
    input: NativeTranscriptCheckpointKey,
  ): Promise<NativeTranscriptCheckpointRecord | null>;
}

export interface SummaryRepository {
  insertSummary(input: CreateSummaryInput): Promise<SummaryRecord>;
  getSummary(summaryId: string): Promise<SummaryRecord | null>;
  getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]>;
  listRecentSummaries(limit: number): Promise<SummaryRecord[]>;
  listRecentSummariesForSession(sessionId: string, limit: number): Promise<SummaryRecord[]>;
  linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void>;
  linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void>;
  getSummaryMessages(summaryId: string): Promise<number[]>;
  getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]>;
  getSummaryParents(summaryId: string): Promise<SummaryRecord[]>;
  getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]>;
}

export interface ContextRepository {
  getContextItems(conversationId: number): Promise<ContextItemRecord[]>;
  getDistinctDepthsInContext(conversationId: number, options?: { maxOrdinalExclusive?: number }): Promise<number[]>;
  appendContextMessage(conversationId: number, messageId: number): Promise<void>;
  appendContextMessages(conversationId: number, messageIds: number[]): Promise<void>;
  appendContextSummary(conversationId: number, summaryId: string): Promise<void>;
  replaceContextRangeWithSummary(input: { conversationId: number; startOrdinal: number; endOrdinal: number; summaryId: string }): Promise<void>;
  getContextTokenCount(conversationId: number): Promise<number>;
}

export interface LargeFileRepository {
  insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord>;
  getLargeFile(fileId: string): Promise<LargeFileRecord | null>;
  getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]>;
}

export interface PromotedMemoryRecord {
  id: string;
  content: string;
  tags: string[];
  metadata: JsonObject;
  sourceSummaryId: string | null;
  projectId: string;
  sessionId: string | null;
  depth: number;
  confidence: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface PromotedMemoryRepository {
  insert(input: { content: string; tags?: string[]; metadata?: JsonObject; sourceSummaryId?: string; sourceProjectId?: string; sessionId?: string; depth?: number; confidence?: number }): Promise<string>;
  getById(id: string): Promise<PromotedMemoryRecord | null>;
  getAll(options?: { sourceProjectId?: string; since?: string; tags?: string[] }): Promise<PromotedMemoryRecord[]>;
  listContentPrefixes(limit: number): Promise<string[]>;
  archive(id: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  update(id: string, fields: { content?: string; confidence?: number; tags?: string[]; metadata?: JsonObject }): Promise<void>;
  findStale(options: { staleAfterDays: number; staleSurfacingWithoutUseLimit: number; sourceProjectId?: string }): Promise<Array<PromotedMemoryRecord & { surfacingCount: number; usageCount: number; daysSinceCreated: number }>>;
  revive(id: string): Promise<void>;
}

export interface RecallRepository {
  logSurfacing(memoryIds: string[], sessionId: string | null): Promise<void>;
  getFeedback(memoryIds: string[]): Promise<Map<string, RecallFeedback>>;
  getStats(): Promise<RecallStats>;
}

export interface RedactionAdminRepository {
  upsertCounts(counts: RedactionCounts): Promise<void>;
  getCounts(): Promise<RedactionCounts & { total: number }>;
  purgeProjectState(): Promise<RedactionPurgeResult>;
}

export interface RedactionCounts {
  gitleaks: number;
  builtIn: number;
  global: number;
  project: number;
}

export interface RedactionPurgeResult {
  promotedMemories: number;
  promotedTags: number;
  recallSurfacings: number;
  redactionCounters: number;
  sessionIngestLogs: number;
  sessionInstructions: number;
}

export interface LexicalSearchRepository {
  searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]>;
  searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]>;
  searchPromoted(query: string, limit: number, filterTags?: string[], sourceProjectId?: string): Promise<import("../db/promoted.js").SearchResult[]>;
}

export interface SessionIngestRecord {
  sessionId: string;
  messageCount: number;
  completedAt: string;
}

export interface SessionInstructionsRecord {
  id: number;
  content: string;
  contentHash: string;
  updatedAt: string;
}

export interface CoordinationRepository {
  getSessionIngest(sessionId: string): Promise<SessionIngestRecord | null>;
  recordSessionIngest(sessionId: string, messageCount: number): Promise<void>;
  getSessionInstructions(id: number, fallbackLegacyId?: number): Promise<SessionInstructionsRecord | null>;
  upsertSessionInstructions(id: number, content: string, contentHash: string): Promise<void>;
  deleteSessionInstructions(id: number): Promise<void>;
}

export interface ProjectRepositories {
  readonly conversations: ConversationRepository;
  readonly summaries: SummaryRepository;
  readonly context: ContextRepository;
  readonly largeFiles: LargeFileRepository;
  readonly promotedMemory: PromotedMemoryRepository;
  readonly recall: RecallRepository;
  readonly redactionAdmin: RedactionAdminRepository;
  readonly lexicalSearch: LexicalSearchRepository;
  readonly coordination: CoordinationRepository;
}

export type TransactionRepositories = ProjectRepositories;

export interface ProjectStorage extends ProjectRepositories {
  readonly backend: StorageBackendName;
  readonly projectId: string;
  readonly capabilities: StorageCapabilities;
  transaction<T>(callback: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
}

/**
 * Identity carried from local path resolution into a backend factory.
 *
 * SQLite uses `id`/`localProjectId`, while PostgreSQL uses the explicit remote
 * UUID in `id` and additionally requires `machineId`. Optional fields preserve
 * structural compatibility for existing SQLite-only callers.
 */
export interface StorageIdentityContext extends ProjectIdentity {
  readonly localProjectId?: string;
  readonly machineId?: string;
}

export interface StorageBackendFactory {
  readonly backend: StorageBackendName;
  readonly capabilities: StorageCapabilities;
  projectExists(identity: StorageIdentityContext): Promise<boolean>;
  /** Open an already-present project without creating backend state. */
  openExistingProject(identity: StorageIdentityContext): Promise<ProjectStorage | null>;
  openProject(identity: StorageIdentityContext): Promise<ProjectStorage>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
}
