import { normalizeUuidV7 } from "../../machine-identity.js";
import { StorageOperationError } from "../errors.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";

/** Numeric diagnostic data; no conversation content, connection or identity metadata. */
export interface PostgreSqlDiagnosticMetrics {
  readonly projects: number;
  readonly conversations: number;
  readonly compactedConversations: number;
  readonly messages: number;
  readonly summaries: number;
  readonly maxDepth: number;
  readonly rawTokens: number;
  readonly summaryTokens: number;
  readonly ratio: number;
  readonly promotedCount: number;
  readonly redactionCounts: { readonly builtIn: number; readonly global: number; readonly project: number; readonly total: number };
  readonly recallStats: { readonly memoriesSurfaced: number; readonly memoriesActedUpon: number; readonly recallPrecision: number | null };
}

function invalidMetrics(): never {
  throw new StorageOperationError("STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "diagnosticMetrics");
}

function counter(value: unknown): number {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) return invalidMetrics();
  return parsed;
}

/**
 * This deliberately uses projectless execution: operation project metadata would
 * enter the runtime's writer admission transaction. Scope stays in bound SQL.
 */
export async function readPostgreSqlDiagnosticMetrics(
  executor: PostgreSqlQueryExecutor,
  signal?: AbortSignal,
  projectId?: string,
): Promise<PostgreSqlDiagnosticMetrics> {
  if (signal?.aborted) return invalidMetrics();
  const selected = projectId === undefined ? undefined : normalizeUuidV7(projectId);
  if (selected === null) return invalidMetrics();
  const admission = await executor.query<{ project_id: unknown }>({
    text: "SELECT project_id FROM lcm.projects ORDER BY project_id",
  }, { domain: "factory", operation: "diagnosticProjects", signal });
  const projectIds = admission.rows.map((row) => {
    const id = typeof row.project_id === "string" ? normalizeUuidV7(row.project_id) : null;
    if (id === null) return invalidMetrics();
    return id;
  });
  if (new Set(projectIds).size !== projectIds.length) return invalidMetrics();
  if (selected !== undefined && !projectIds.includes(selected)) return invalidMetrics();
  if (signal?.aborted) return invalidMetrics();
  const scope = selected === undefined ? projectIds : [selected];
  const result = await executor.query({
    text: `WITH message_counts AS (
             SELECT project_id, conversation_id, pg_catalog.count(*) AS messages,
                    COALESCE(pg_catalog.sum(token_count), 0) AS raw_tokens
             FROM lcm.messages WHERE project_id = ANY($1::pg_catalog.uuid[])
             GROUP BY project_id, conversation_id
           ), summary_counts AS (
             SELECT project_id, conversation_id, pg_catalog.count(*) AS summaries,
                    COALESCE(pg_catalog.sum(token_count), 0) AS summary_tokens,
                    pg_catalog.max(depth) AS max_depth
             FROM lcm.summaries WHERE project_id = ANY($1::pg_catalog.uuid[])
             GROUP BY project_id, conversation_id
           ), usage_counts AS (
             SELECT signal.project_id, pg_catalog.substr(reference.tag, 11) AS memory_id
             FROM lcm.promoted_memories AS signal
             INNER JOIN LATERAL (
               SELECT candidate.tag FROM lcm.promoted_memory_tags AS candidate
               WHERE candidate.project_id = signal.project_id AND candidate.memory_id = signal.memory_id
                 AND pg_catalog.substr(candidate.tag, 1, 10) = 'memory_id:'
               ORDER BY candidate.ordinal LIMIT 1
             ) AS reference ON TRUE
             WHERE signal.project_id = ANY($1::pg_catalog.uuid[])
               AND signal.archived_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM lcm.promoted_memory_tags AS marker
                 WHERE marker.project_id = signal.project_id AND marker.memory_id = signal.memory_id
                   AND marker.tag = 'signal:memory_used'
               )
             GROUP BY signal.project_id, pg_catalog.substr(reference.tag, 11)
           )
           SELECT pg_catalog.count(*) AS conversations,
                  pg_catalog.count(summary_counts.conversation_id) AS compacted_conversations,
                  COALESCE(pg_catalog.sum(message_counts.messages), 0) AS messages,
                  COALESCE(pg_catalog.sum(summary_counts.summaries), 0) AS summaries,
                  COALESCE(pg_catalog.max(summary_counts.max_depth), 0) AS max_depth,
                  COALESCE(pg_catalog.sum(message_counts.raw_tokens)
                    FILTER (WHERE summary_counts.conversation_id IS NOT NULL), 0) AS raw_tokens,
                  COALESCE(pg_catalog.sum(summary_counts.summary_tokens), 0) AS summary_tokens,
                  (SELECT pg_catalog.count(*) FROM lcm.promoted_memories
                    WHERE project_id = ANY($1::pg_catalog.uuid[])) AS promoted_count,
                  (SELECT COALESCE(pg_catalog.sum(count), 0) FROM lcm.redaction_counters
                    WHERE project_id = ANY($1::pg_catalog.uuid[]) AND category = 'built_in') AS built_in,
                  (SELECT COALESCE(pg_catalog.sum(count), 0) FROM lcm.redaction_counters
                    WHERE project_id = ANY($1::pg_catalog.uuid[]) AND category = 'global') AS global,
                  (SELECT COALESCE(pg_catalog.sum(count), 0) FROM lcm.redaction_counters
                    WHERE project_id = ANY($1::pg_catalog.uuid[]) AND category = 'project') AS project,
                  (SELECT pg_catalog.count(DISTINCT (project_id, memory_id)) FROM lcm.recall_surfacing
                    WHERE project_id = ANY($1::pg_catalog.uuid[])) AS memories_surfaced,
                  (SELECT pg_catalog.count(*) FROM usage_counts) AS memories_acted_upon
           FROM lcm.conversations AS conversation
           LEFT JOIN message_counts USING (project_id, conversation_id)
           LEFT JOIN summary_counts USING (project_id, conversation_id)
           WHERE conversation.project_id = ANY($1::pg_catalog.uuid[])`,
    values: [scope],
  }, { domain: "factory", operation: "diagnosticMetrics", signal });
  if (signal?.aborted) return invalidMetrics();
  const row = result.rows[0];
  if (result.rows.length !== 1) return invalidMetrics();
  const rawTokens = counter(row.raw_tokens);
  const summaryTokens = counter(row.summary_tokens);
  const builtIn = counter(row.built_in);
  const global = counter(row.global);
  const project = counter(row.project);
  const memoriesSurfaced = counter(row.memories_surfaced);
  const memoriesActedUpon = counter(row.memories_acted_upon);
  return {
    projects: scope.length,
    conversations: counter(row.conversations),
    compactedConversations: counter(row.compacted_conversations),
    messages: counter(row.messages),
    summaries: counter(row.summaries),
    maxDepth: counter(row.max_depth),
    rawTokens,
    summaryTokens,
    ratio: rawTokens > 0 && summaryTokens > 0 ? rawTokens / summaryTokens : 0,
    promotedCount: counter(row.promoted_count),
    redactionCounts: { builtIn, global, project, total: counter(builtIn + global + project) },
    recallStats: {
      memoriesSurfaced, memoriesActedUpon,
      recallPrecision: memoriesSurfaced > 0 ? Math.min(100, memoriesActedUpon / memoriesSurfaced * 100) : null,
    },
  };
}
