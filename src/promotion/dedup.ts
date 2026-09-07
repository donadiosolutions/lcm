import type {
  LexicalSearchRepository,
  ProjectStorage,
  PromotedMemoryRepository,
  TransactionRepositories,
} from "../storage/contracts.js";

type DedupThresholds = {
  dedupBm25Threshold: number;
  dedupCandidateLimit: number;
};

export interface DedupRepositories {
  transaction: ProjectStorage["transaction"];
}

export type DedupInsertInput = Readonly<{
  content: string;
  tags: string[];
  sourceProjectId?: string;
  /** Search across the bound owner's provenance on PostgreSQL only. */
  candidateScope?: "source" | "owner";
  backend?: ProjectStorage["backend"];
  sessionId?: string;
  depth: number;
  confidence: number;
  newEntryConfidence?: number;
  thresholds: DedupThresholds;
}>;

/** Structural bridge for bespoke SQLite callers deferred to #224. */
export interface LegacyDedupStore {
  search(query: string, limit: number, filterTags?: string[], projectId?: string): Awaited<ReturnType<LexicalSearchRepository["searchPromoted"]>>;
  insert(input: Parameters<PromotedMemoryRepository["insert"]>[0] & { projectId: string }): string;
  update(id: string, fields: Parameters<PromotedMemoryRepository["update"]>[1]): void;
  archive(id: string): void;
  transaction(callback: () => void): void;
}

type DedupParams = {
  content: string;
  tags: string[];
  sessionId?: string;
  depth: number;
  confidence: number;
  newEntryConfidence?: number;
  thresholds: DedupThresholds;
} & ((DedupRepositories & {
  sourceProjectId?: string;
  repositories?: TransactionRepositories;
  /** Search across the bound owner's provenance on PostgreSQL only. */
  candidateScope?: "source" | "owner";
  backend?: ProjectStorage["backend"];
}) | { store: LegacyDedupStore; projectId: string });

function isDuplicateCandidate(
  candidate: { content: string; rank: number },
  content: string,
  bm25Threshold: number,
): boolean {
  // Exact byte-for-byte content identity always deduplicates, regardless of
  // rank sign. Nonidentical candidates must clear the negative BM25 threshold.
  if (candidate.content === content) return true;
  return candidate.rank < 0 && candidate.rank <= -bm25Threshold;
}

export async function deduplicateAndInsert(params: DedupParams): Promise<string> {
  const {
    content,
    tags,
    sessionId,
    depth,
    confidence,
    newEntryConfidence,
    thresholds,
  } = params;
  const insertConfidence = newEntryConfidence ?? confidence;

  if (!("store" in params)) {
    // Search and mutation share one backend transaction so two concurrent
    // promotions cannot both observe an empty candidate set and insert.
    const run = (repositories: TransactionRepositories) => deduplicateAndInsertInRepositories(repositories, {
      content,
      tags,
      sourceProjectId: params.sourceProjectId,
      candidateScope: params.candidateScope,
      backend: params.backend,
      sessionId,
      depth,
      confidence,
      newEntryConfidence,
      thresholds,
    });
    return params.repositories === undefined
      ? params.transaction(run)
      : run(params.repositories);
  }

  // The legacy SQLite bridge remains synchronous until bespoke callers move in #224.
  const candidates = params.store.search(
    content,
    thresholds.dedupCandidateLimit,
    undefined,
    params.projectId,
  );

  // Exact identity is authoritative; only nonidentical ranked matches need the BM25 threshold.
  const duplicates = candidates.filter(
    (candidate) => isDuplicateCandidate(candidate, content, thresholds.dedupBm25Threshold),
  );

  if (duplicates.length === 0) {
    const input = { content, tags, sessionId, depth, confidence: insertConfidence };
    return params.store.insert({ ...input, projectId: params.projectId });
  }

  // Structural convergence: use the backend's first ordered duplicate as canonical.
  const canonical = duplicates[0];
  // Use max confidence across all matched duplicates + incoming to avoid losing strong signals
  const refreshedConfidence = Math.max(confidence, ...duplicates.map((d) => d.confidence));
  // Merge tags from canonical, all matched duplicates, and incoming to avoid losing tag signals
  const mergedTags = Array.from(
    new Set([...canonical.tags, ...duplicates.slice(1).flatMap((d) => d.tags), ...tags]),
  );

  params.store.transaction(() => {
    params.store.update(canonical.id, { confidence: refreshedConfidence, tags: mergedTags });
    for (let index = 1; index < duplicates.length; index++) {
      params.store.archive(duplicates[index].id);
    }
  });

  return canonical.id;
}

/**
 * Run dedup inside a caller-owned transaction. The caller records any receipt
 * in that same transaction alongside these promoted-memory changes.
 */
export async function deduplicateAndInsertInRepositories(
  repositories: TransactionRepositories,
  input: DedupInsertInput,
): Promise<string> {
  const candidateSourceProjectId = input.candidateScope === "owner"
    && input.backend === "postgresql"
    ? undefined
    : input.sourceProjectId;
  const candidates = await repositories.lexicalSearch.searchPromoted(
    input.content,
    input.thresholds.dedupCandidateLimit,
    undefined,
    candidateSourceProjectId,
  );
  const duplicates = candidates.filter(
    (candidate) => isDuplicateCandidate(candidate, input.content, input.thresholds.dedupBm25Threshold),
  );
  if (duplicates.length === 0) {
    return repositories.promotedMemory.insert({
      content: input.content,
      tags: input.tags,
      sourceProjectId: input.sourceProjectId,
      sessionId: input.sessionId,
      depth: input.depth,
      confidence: input.newEntryConfidence ?? input.confidence,
    });
  }
  const canonical = duplicates[0];
  const refreshedConfidence = Math.max(
    input.confidence,
    ...duplicates.map((duplicate) => duplicate.confidence),
  );
  const mergedTags = Array.from(new Set([
    ...canonical.tags,
    ...duplicates.slice(1).flatMap((duplicate) => duplicate.tags),
    ...input.tags,
  ]));
  await repositories.promotedMemory.update(canonical.id, {
    confidence: refreshedConfidence,
    tags: mergedTags,
  });
  for (let index = 1; index < duplicates.length; index++) {
    await repositories.promotedMemory.archive(duplicates[index].id);
  }
  return canonical.id;
}
