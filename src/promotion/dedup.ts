import type {
  LexicalSearchRepository,
  ProjectStorage,
  PromotedMemoryRepository,
} from "../storage/contracts.js";

type DedupThresholds = {
  dedupBm25Threshold: number;
  dedupCandidateLimit: number;
};

export interface DedupRepositories {
  transaction: ProjectStorage["transaction"];
}

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
} & ((DedupRepositories & { sourceProjectId?: string }) | { store: LegacyDedupStore; projectId: string });

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
    return params.transaction(async (repositories) => {
      const candidates = await repositories.lexicalSearch.searchPromoted(
        content,
        thresholds.dedupCandidateLimit,
        undefined,
        params.sourceProjectId,
      );
      const duplicates = candidates.filter(
        (candidate) => candidate.rank <= -thresholds.dedupBm25Threshold,
      );

      if (duplicates.length === 0) {
        return repositories.promotedMemory.insert({
          content,
          tags,
          sourceProjectId: params.sourceProjectId,
          sessionId,
          depth,
          confidence: insertConfidence,
        });
      }

      const canonical = duplicates[0];
      const refreshedConfidence = Math.max(confidence, ...duplicates.map((duplicate) => duplicate.confidence));
      const mergedTags = Array.from(
        new Set([...canonical.tags, ...duplicates.slice(1).flatMap((duplicate) => duplicate.tags), ...tags]),
      );
      await repositories.promotedMemory.update(canonical.id, {
        confidence: refreshedConfidence,
        tags: mergedTags,
      });
      for (let index = 1; index < duplicates.length; index++) {
        await repositories.promotedMemory.archive(duplicates[index].id);
      }
      return canonical.id;
    });
  }

  // The legacy SQLite bridge remains synchronous until bespoke callers move in #224.
  const candidates = params.store.search(
    content,
    thresholds.dedupCandidateLimit,
    undefined,
    params.projectId,
  );

  // Filter to entries above BM25 threshold (rank is negative; more negative = better match)
  const duplicates = candidates.filter(
    (c) => c.rank <= -thresholds.dedupBm25Threshold,
  );

  if (duplicates.length === 0) {
    const input = { content, tags, sessionId, depth, confidence: insertConfidence };
    return params.store.insert({ ...input, projectId: params.projectId });
  }

  // Structural convergence: pick best BM25 match as canonical
  // (duplicates is sorted by rank — most negative rank = best match = duplicates[0])
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
