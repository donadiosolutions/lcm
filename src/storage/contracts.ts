import type { ProjectIdentity } from "../project-map.js";
import type {
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
export type StorageDomain =
  | "factory"
  | "conversations"
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
  createConversation(input: CreateConversationInput): Promise<ConversationRecord>;
  getConversation(conversationId: ConversationId): Promise<ConversationRecord | null>;
  getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null>;
  getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord>;
  markConversationBootstrapped(conversationId: ConversationId): Promise<void>;
  listConversations(): Promise<ConversationRecord[]>;
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]>;
  getMessages(conversationId: ConversationId, options?: { afterSeq?: number; limit?: number }): Promise<MessageRecord[]>;
  getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null>;
  hasMessage(conversationId: ConversationId, role: MessageRole, content: string): Promise<boolean>;
  countMessagesByIdentity(conversationId: ConversationId, role: MessageRole, content: string): Promise<number>;
  getMessageById(messageId: MessageId): Promise<MessageRecord | null>;
  createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void>;
  getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]>;
  getMessageCount(conversationId: ConversationId): Promise<number>;
  getMessageCountBySessionId(sessionId: string): Promise<number>;
  getMaxSeq(conversationId: ConversationId): Promise<number>;
  deleteMessages(messageIds: MessageId[]): Promise<number>;
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
  sourceSummaryId: string | null;
  projectId: string;
  sessionId: string | null;
  depth: number;
  confidence: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface PromotedMemoryRepository {
  insert(input: { content: string; tags?: string[]; sourceSummaryId?: string; sourceProjectId?: string; sessionId?: string; depth?: number; confidence?: number }): Promise<string>;
  getById(id: string): Promise<PromotedMemoryRecord | null>;
  getAll(options?: { sourceProjectId?: string; since?: string; tags?: string[] }): Promise<PromotedMemoryRecord[]>;
  listContentPrefixes(limit: number): Promise<string[]>;
  archive(id: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  update(id: string, fields: { content?: string; confidence?: number; tags?: string[] }): Promise<void>;
  findStale(options: { staleAfterDays: number; staleSurfacingWithoutUseLimit: number; sourceProjectId?: string }): Promise<Array<PromotedMemoryRecord & { surfacingCount: number; usageCount: number; daysSinceCreated: number }>>;
  revive(id: string): Promise<void>;
}

export interface RecallRepository {
  logSurfacing(memoryIds: string[], sessionId: string | null): Promise<void>;
  getFeedback(memoryIds: string[]): Promise<Map<string, RecallFeedback>>;
  getStats(): Promise<RecallStats>;
}

export interface RedactionAdminRepository {
  upsertCounts(counts: { gitleaks: number; builtIn: number; global: number; project: number }): Promise<void>;
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

export interface StorageBackendFactory {
  readonly backend: StorageBackendName;
  readonly capabilities: StorageCapabilities;
  projectExists(identity: ProjectIdentity): Promise<boolean>;
  /** Open an already-present project without creating backend state. */
  openExistingProject(identity: ProjectIdentity): Promise<ProjectStorage | null>;
  openProject(identity: ProjectIdentity): Promise<ProjectStorage>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
}
