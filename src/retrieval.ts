import type {
  ConversationStore,
  MessageRecord,
  MessageSearchResult,
} from "./store/conversation-store.js";
import type {
  SummaryStore,
  SummaryRecord,
  SummarySearchResult,
  LargeFileRecord,
} from "./store/summary-store.js";
import type { ProjectRepositories } from "./storage/contracts.js";

type RetrievalConversationStore = Pick<
  ConversationStore,
  "getMessageById" | "searchMessages"
>;
type RetrievalSummaryStore = Pick<
  SummaryStore,
  | "getLargeFile"
  | "getSummary"
  | "getSummaryChildren"
  | "getSummaryMessages"
  | "getSummaryParents"
  | "getSummarySubtree"
  | "searchSummaries"
>;

/** Canonical memory layers exposed by search operations. */
export const CANONICAL_SEARCH_LAYERS = Object.freeze(["episodic", "promoted"] as const);
export type SearchLayer = (typeof CANONICAL_SEARCH_LAYERS)[number];
/** Deprecated, non-advertised boundary alias; normalizes to promoted, whose canonical key is returned. */
export type SearchLayerInput = SearchLayer | "semantic";
export const DEFAULT_SEARCH_LAYERS = CANONICAL_SEARCH_LAYERS;

/** Canonical conversation-history scopes exposed by grep operations. */
export const CANONICAL_GREP_SCOPES = Object.freeze(["messages", "summaries", "both"] as const);
export type GrepScope = (typeof CANONICAL_GREP_SCOPES)[number];
/** Deprecated, non-advertised boundary alias accepted for compatibility. */
export type GrepScopeInput = GrepScope | "all";
export const DEFAULT_GREP_SCOPE: GrepScope = "both";

/** Canonical search modes exposed by grep operations. */
export const CANONICAL_GREP_MODES = Object.freeze(["full_text", "regex"] as const);
export type GrepMode = (typeof CANONICAL_GREP_MODES)[number];
export const DEFAULT_GREP_MODE: GrepMode = "full_text";

/** Normalize grep mode at input boundaries; only omitted mode defaults. */
export function normalizeGrepMode(input: unknown): GrepMode | null {
  if (input === undefined) return DEFAULT_GREP_MODE;
  if (typeof input !== "string") return null;
  return CANONICAL_GREP_MODES.includes(input as GrepMode) ? (input as GrepMode) : null;
}

/** Normalize search layers, rejecting malformed values before storage access. */
export function normalizeSearchLayers(input: unknown): SearchLayer[] | null {
  if (input === undefined) {
    return [...DEFAULT_SEARCH_LAYERS];
  }
  if (!Array.isArray(input)) {
    return null;
  }

  const normalized: SearchLayer[] = [];
  for (const layer of input) {
    if (typeof layer !== "string") {
      return null;
    }
    const canonical = layer === "semantic" ? "promoted" : layer;
    if (!CANONICAL_SEARCH_LAYERS.includes(canonical as SearchLayer)) {
      return null;
    }
    if (!normalized.includes(canonical as SearchLayer)) {
      normalized.push(canonical as SearchLayer);
    }
  }
  return normalized;
}

/** Normalize grep scope, rejecting malformed values before storage access. */
export function normalizeGrepScope(input: unknown): GrepScope | null {
  if (input === undefined) {
    return DEFAULT_GREP_SCOPE;
  }
  if (typeof input !== "string") {
    return null;
  }
  if (input === "all") {
    return "both";
  }
  return CANONICAL_GREP_SCOPES.includes(input as GrepScope) ? (input as GrepScope) : null;
}

// ── Public interfaces ────────────────────────────────────────────────────────

export interface DescribeResult {
  id: string;
  type: "summary" | "file";
  /** Summary-specific fields */
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
    createdAt: Date;
  };
  /** File-specific fields */
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
  };
}

export interface GrepInput {
  query: string;
  mode: GrepMode;
  scope: GrepScope;
  conversationId?: number;
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface GrepResult {
  messages: MessageSearchResult[];
  summaries: SummarySearchResult[];
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  /** Max traversal depth (default 1) */
  depth?: number;
  /** Include raw source messages at leaf level */
  includeMessages?: boolean;
  /** Max tokens to return before truncating */
  tokenCap?: number;
}

export interface ExpandResult {
  /** Child summaries found */
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;
  /** Source messages (only if includeMessages=true and hitting leaf summaries) */
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;
  /** Total estimated tokens in result */
  estimatedTokens: number;
  /** Whether result was truncated due to tokenCap */
  truncated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ── RetrievalEngine ──────────────────────────────────────────────────────────

export class RetrievalEngine {
  constructor(
    private conversationStore: RetrievalConversationStore,
    private summaryStore: RetrievalSummaryStore,
  ) {}

  // ── describe ─────────────────────────────────────────────────────────────

  /**
   * Describe an LCM item by ID.
   *
   * - IDs starting with "sum_" are looked up as summaries (with lineage).
   * - IDs starting with "file_" are looked up as large files.
   * - Returns null if the item is not found.
   */
  async describe(id: string): Promise<DescribeResult | null> {
    if (id.startsWith("sum_")) {
      return this.describeSummary(id);
    }
    if (id.startsWith("file_")) {
      return this.describeFile(id);
    }
    return null;
  }

  private async describeSummary(id: string): Promise<DescribeResult | null> {
    const summary = await this.summaryStore.getSummary(id);
    if (!summary) {
      return null;
    }

    // Fetch lineage in parallel
    const [parents, children, messageIds, subtree] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
      this.summaryStore.getSummarySubtree(id),
    ]);

    return {
      id,
      type: "summary",
      summary: {
        conversationId: summary.conversationId,
        kind: summary.kind,
        content: summary.content,
        depth: summary.depth,
        tokenCount: summary.tokenCount,
        descendantCount: summary.descendantCount,
        descendantTokenCount: summary.descendantTokenCount,
        sourceMessageTokenCount: summary.sourceMessageTokenCount,
        fileIds: summary.fileIds,
        parentIds: parents.map((p) => p.summaryId),
        childIds: children.map((c) => c.summaryId),
        messageIds,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        subtree: subtree.map((node) => ({
          summaryId: node.summaryId,
          parentSummaryId: node.parentSummaryId,
          depthFromRoot: node.depthFromRoot,
          kind: node.kind,
          depth: node.depth,
          tokenCount: node.tokenCount,
          descendantCount: node.descendantCount,
          descendantTokenCount: node.descendantTokenCount,
          sourceMessageTokenCount: node.sourceMessageTokenCount,
          earliestAt: node.earliestAt,
          latestAt: node.latestAt,
          childCount: node.childCount,
          path: node.path,
        })),
        createdAt: summary.createdAt,
      },
    };
  }

  private async describeFile(id: string): Promise<DescribeResult | null> {
    const file = await this.summaryStore.getLargeFile(id);
    if (!file) {
      return null;
    }

    return {
      id,
      type: "file",
      file: {
        conversationId: file.conversationId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        storageUri: file.storageUri,
        explorationSummary: file.explorationSummary,
        createdAt: file.createdAt,
      },
    };
  }

  // ── grep ─────────────────────────────────────────────────────────────────

  /**
   * Search compacted history using regex or full-text search.
   *
   * Depending on `scope`, searches messages, summaries, or both (in parallel).
   */
  async grep(input: GrepInput): Promise<GrepResult> {
    const { query, mode, scope, conversationId, since, before, limit } = input;

    if (!CANONICAL_GREP_MODES.includes(mode as GrepMode)) {
      throw new Error("Invalid grep mode");
    }
    if (!CANONICAL_GREP_SCOPES.includes(scope as GrepScope)) {
      throw new Error("Invalid grep scope");
    }

    const searchInput = { query, mode, conversationId, since, before, limit };

    let messages: MessageSearchResult[] = [];
    let summaries: SummarySearchResult[] = [];

    if (scope === "messages") {
      messages = await this.conversationStore.searchMessages(searchInput);
    } else if (scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(searchInput);
    } else {
      // Scope validation above makes the remaining canonical value "both".
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(searchInput),
        this.summaryStore.searchSummaries(searchInput),
      ]);
    }

    messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      messages,
      summaries,
      totalMatches: messages.length + summaries.length,
    };
  }

  // ── expand ───────────────────────────────────────────────────────────────

  /**
   * Expand a summary to its children and/or source messages.
   *
   * - Condensed summaries: returns child summaries, recursing up to `depth`.
   * - Leaf summaries with `includeMessages`: fetches the source messages.
   * - Respects `tokenCap` and sets `truncated` when the cap is exceeded.
   */
  async expand(input: ExpandInput): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Infinity;

    const result: ExpandResult = {
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);

    return result;
  }

  private async expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: ExpandResult,
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return;
    }

    if (summary.kind === "condensed") {
      const children = await this.summaryStore.getSummaryChildren(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }

        // Check if adding this child would exceed the token cap
        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result.estimatedTokens += child.tokenCount;

        // Recurse into children if depth allows
        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      // Leaf summary — fetch source messages
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);

      for (const msgId of messageIds) {
        const msg = await this.conversationStore.getMessageById(msgId);
        if (!msg) {
          continue;
        }

        const tokenCount = msg.tokenCount || estimateTokens(msg.content);

        if (result.estimatedTokens + tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          tokenCount,
        });
        result.estimatedTokens += tokenCount;
      }
    }
  }
}

/** Compose the split backend-neutral repositories into the legacy retrieval engine. */
export function createRetrievalEngine(repositories: ProjectRepositories): RetrievalEngine {
  return new RetrievalEngine(
    {
      getMessageById: (id) => repositories.conversations.getMessageById(id),
      searchMessages: (input) => repositories.lexicalSearch.searchMessages(input),
    },
    {
      getLargeFile: (id) => repositories.largeFiles.getLargeFile(id),
      getSummary: (id) => repositories.summaries.getSummary(id),
      getSummaryChildren: (id) => repositories.summaries.getSummaryChildren(id),
      getSummaryMessages: (id) => repositories.summaries.getSummaryMessages(id),
      getSummaryParents: (id) => repositories.summaries.getSummaryParents(id),
      getSummarySubtree: (id) => repositories.summaries.getSummarySubtree(id),
      searchSummaries: (input) => repositories.lexicalSearch.searchSummaries(input),
    },
  );
}
