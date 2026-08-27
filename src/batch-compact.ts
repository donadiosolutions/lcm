import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLcmMigrations } from "./db/migration.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
import {
  progressCurrentSession,
  type ProgressCurrentSession,
  type ProgressPhaseError,
  type ProgressState,
} from "./cli/progress-state.js";
import { DaemonClient } from "./daemon/client.js";
import { isDaemonTransportFailure } from "./daemon/http-url.js";
import { configPath, projectsDir as lcmProjectsDir } from "./runtime-paths.js";
import { normalizeProjectPath, projectMapPathsForHash } from "./project-map.js";
import { loadDaemonConfig, type LlmApiMode, type LlmInvocationRequestPolicy, type LlmReasoningEffort, type LlmRetryPolicy } from "./daemon/config.js";
import { MANUAL_COMPACT_FRESH_TAIL_COUNT } from "./compaction.js";
import { selectStorageBackendForConfig } from "./storage/backend.js";

export interface UncompactedConversation {
  projectDir: string;
  cwd: string;
  conversationId: number;
  sessionId: string;
  messages: number;
  tokens: number;
}

export interface BatchCompactResult {
  compacted: number;
  unchanged: number;
  skipped: number;
  failures: number;
  compactedProjects: string[];
}

export type BatchWorkerCompletion<TItem, TResult> =
  | { readonly index: number; readonly item: TItem; readonly value: TResult }
  | { readonly index: number; readonly item: TItem; readonly error: unknown };

export type BatchWorkerPoolOptions<TItem, TResult> = Readonly<{
  items: readonly TItem[];
  maxConcurrency: number;
  signal?: AbortSignal;
  worker: (item: TItem, index: number) => Promise<TResult> | TResult;
  onClaim?: (item: TItem, index: number) => void;
  onResult?: (result: BatchWorkerCompletion<TItem, TResult>) => void;
}>;

type ReplayContextRow = {
  ordinal: number;
  item_type: "message" | "summary";
  depth: number | null;
  token_count: number;
};

type ProjectScanFailure = {
  target: string;
  message: string;
};

type UncompactedDiscovery = {
  conversations: UncompactedConversation[];
  failures: ProjectScanFailure[];
};

const MANUAL_COMPACT_LEAF_MIN_FANOUT = 3;
const MANUAL_COMPACT_CONDENSED_MIN_FANOUT = 2;
const MANUAL_COMPACT_SUMMARY_CHUNK_TOKENS = 20_000;
const MANUAL_COMPACT_MIN_CONDENSED_TOKENS = 2_000;

/** Run a fixed-size worker pool over immutable discovery indexes. */
export async function runBatchWorkerPool<TItem, TResult>(
  options: BatchWorkerPoolOptions<TItem, TResult>,
): Promise<BatchWorkerCompletion<TItem, TResult>[]> {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive safe integer");
  }

  const completions: BatchWorkerCompletion<TItem, TResult>[] = [];
  const active = new Set<Promise<void>>();
  let nextIndex = 0;
  let callbackError: unknown;
  let callbackErrorSet = false;

  const claim = (): void => {
    while (
      active.size < options.maxConcurrency
      && nextIndex < options.items.length
      && options.signal?.aborted !== true
      && !callbackErrorSet
    ) {
      const index = nextIndex;
      nextIndex += 1;
      const item = options.items[index]!;
      try {
        options.onClaim?.(item, index);
      } catch (error) {
        callbackError = error;
        callbackErrorSet = true;
        return;
      }
      const task = Promise.resolve()
        .then(() => options.worker(item, index))
        .then(value => ({ index, item, value } as BatchWorkerCompletion<TItem, TResult>))
        .catch(error => ({ index, item, error } as BatchWorkerCompletion<TItem, TResult>))
        .then((result) => {
          completions.push(result);
          try {
            options.onResult?.(result);
          } catch (error) {
            if (!callbackErrorSet) {
              callbackError = error;
              callbackErrorSet = true;
            }
          }
        })
        .finally(() => {
          active.delete(task);
        });
      active.add(task);
    }
  };

  claim();
  while (active.size > 0) {
    await Promise.race(active);
    claim();
  }
  if (callbackErrorSet) throw callbackError;
  return completions;
}

export function formatLlmDiagnostic(input: {
  providerLabel?: string;
  apiMode?: LlmApiMode;
  reasoningEffort?: LlmReasoningEffort | null;
  fastMode?: boolean | null;
  requestTimeoutMs?: number | null;
  retry?: LlmRetryPolicy | null;
}): string | undefined {
  if (!input.providerLabel) return undefined;
  const parts = [input.providerLabel];
  if (input.apiMode) parts.push(input.apiMode);
  if (input.apiMode === "responses" || typeof input.fastMode === "boolean") {
    parts.push(`reasoning=${input.reasoningEffort ?? "default"}`);
  }
  if (typeof input.fastMode === "boolean") parts.push(`fast=${input.fastMode ? "on" : "off"}`);
  if (typeof input.requestTimeoutMs === "number") {
    parts.push(`timeout=${input.requestTimeoutMs}ms`);
  }
  if (input.retry) {
    parts.push(
      `retry=${input.retry.maxAttempts} attempts `
      + `(${input.retry.initialDelayMs}-${input.retry.maxDelayMs}ms ×${input.retry.multiplier})`,
    );
  }
  return parts.join(" · ");
}

/** Find conversations eligible for compaction, above the token threshold. */
function projectMatchesCwdFilter(projectHash: string, cwd: string, cwdFilter?: string): boolean {
  if (!cwdFilter) return true;
  const lexicalFilter = resolve(cwdFilter);
  if (resolve(cwd) === lexicalFilter) return true;
  try {
    if (projectMapPathsForHash(projectHash).includes(lexicalFilter)) return true;
  } catch {
    // Fall back to the metadata cwd while map.json is being edited.
  }
  const normalizedFilter = normalizeProjectPath(cwdFilter);
  if (normalizeProjectPath(cwd) === normalizedFilter) return true;
  return false;
}

function metadataFailureMatchesCwdFilter(projectHash: string, cwdFilter?: string): boolean {
  if (!cwdFilter) return true;
  try {
    return projectMapPathsForHash(projectHash).includes(resolve(cwdFilter));
  } catch {
    return false;
  }
}

function hasReplayCondensationCandidate(db: ReturnType<typeof getLcmConnection>, conversationId: number): boolean {
  const items = db.prepare(`
    SELECT
      ci.ordinal,
      ci.item_type,
      s.depth,
      CASE
        WHEN s.token_count > 0 THEN s.token_count
        ELSE CAST((COALESCE(length(s.content), 0) + 3) / 4 AS INTEGER)
      END AS token_count
    FROM context_items ci
    LEFT JOIN summaries s ON s.summary_id = ci.summary_id
    WHERE ci.conversation_id = ?
    ORDER BY ci.ordinal
  `).all(conversationId) as unknown as ReplayContextRow[];
  const rawOrdinals = items
    .filter((item) => item.item_type === "message")
    .map((item) => item.ordinal);
  const freshTailOrdinal = rawOrdinals.length === 0
    ? Infinity
    : rawOrdinals[Math.max(0, rawOrdinals.length - MANUAL_COMPACT_FRESH_TAIL_COUNT)]!;
  const depths = [...new Set(items
    .filter((item) => item.ordinal < freshTailOrdinal && item.item_type === "summary" && item.depth !== null)
    .map((item) => item.depth!))].sort((a, b) => a - b);

  for (const depth of depths) {
    let count = 0;
    let tokens = 0;
    let started = false;
    for (const item of items) {
      if (item.ordinal >= freshTailOrdinal) break;
      if (item.item_type !== "summary" || item.depth !== depth) {
        if (started) break;
        continue;
      }
      const tokenCount = item.token_count;
      if (started && tokens + tokenCount > MANUAL_COMPACT_SUMMARY_CHUNK_TOKENS) break;
      started = true;
      count++;
      tokens += tokenCount;
      if (tokens >= MANUAL_COMPACT_SUMMARY_CHUNK_TOKENS) break;
    }
    const fanout = depth === 0
      ? MANUAL_COMPACT_LEAF_MIN_FANOUT
      : MANUAL_COMPACT_CONDENSED_MIN_FANOUT;
    if (count >= fanout && tokens >= MANUAL_COMPACT_MIN_CONDENSED_TOKENS) return true;
  }
  return false;
}

function discoverUncompacted(minTokens: number, readOnly = false, cwdFilter?: string, replay = false): UncompactedDiscovery {
  const baseDir = lcmProjectsDir();
  if (!existsSync(baseDir)) return { conversations: [], failures: [] };

  const conversations: UncompactedConversation[] = [];
  const failures: ProjectScanFailure[] = [];

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = join(baseDir, entry.name);
    const dbPath = join(projDir, "db.sqlite");
    if (!existsSync(dbPath)) continue;

    const metaPath = join(projDir, "meta.json");
    if (!existsSync(metaPath)) {
      if (metadataFailureMatchesCwdFilter(entry.name, cwdFilter)) {
        failures.push({ target: entry.name, message: "project metadata is missing" });
      }
      continue;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(readFileSync(metaPath, "utf-8")) as unknown;
    } catch {
      if (metadataFailureMatchesCwdFilter(entry.name, cwdFilter)) {
        failures.push({ target: entry.name, message: "project metadata is unreadable or malformed" });
      }
      continue;
    }
    const cwd = Object(metadata).cwd as unknown;
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      if (metadataFailureMatchesCwdFilter(entry.name, cwdFilter)) {
        failures.push({ target: entry.name, message: "project metadata cwd must be a non-empty string" });
      }
      continue;
    }
    if (!projectMatchesCwdFilter(entry.name, cwd, cwdFilter)) continue;

    try {
      const db = getLcmConnection(dbPath);
      try {
        if (!readOnly) runLcmMigrations(db);
        const rows = db.prepare(`
        SELECT
          c.conversation_id,
          c.session_id,
          COALESCE(m.msg_count, 0) as messages,
          COALESCE(m.raw_tokens, 0) as tokens,
          COALESCE(ci.raw_context_count, 0) as raw_context_messages,
          COALESCE(s.sum_count, 0) as summaries
        FROM conversations c
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as msg_count, SUM(token_count) as raw_tokens
          FROM messages GROUP BY conversation_id
        ) m ON m.conversation_id = c.conversation_id
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as raw_context_count
          FROM context_items WHERE item_type = 'message' GROUP BY conversation_id
        ) ci ON ci.conversation_id = c.conversation_id
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as sum_count
          FROM summaries GROUP BY conversation_id
        ) s ON s.conversation_id = c.conversation_id
        WHERE COALESCE(m.msg_count, 0) > 0
          AND (? OR COALESCE(s.sum_count, 0) = 0)
          AND COALESCE(m.raw_tokens, 0) >= ?
        ORDER BY COALESCE(m.raw_tokens, 0) DESC
        `).all(replay ? 1 : 0, minTokens) as { conversation_id: number; session_id: string; messages: number; tokens: number; raw_context_messages: number; summaries: number }[];

        for (const row of rows) {
          const hasRawWork = row.raw_context_messages > MANUAL_COMPACT_FRESH_TAIL_COUNT;
          if (!hasRawWork && !(replay && hasReplayCondensationCandidate(db, row.conversation_id))) continue;
          conversations.push({
            projectDir: projDir,
            cwd,
            conversationId: row.conversation_id,
            sessionId: row.session_id,
            messages: row.messages,
            tokens: row.tokens,
          });
        }
      } finally {
        closeLcmConnection(dbPath, db);
      }
    } catch (error) {
      failures.push({
        target: cwd,
        message: String(error).replace(/^Error:\s*/, ""),
      });
    }
  }

  return { conversations, failures };
}

export function findUncompacted(minTokens: number, readOnly = false, cwdFilter?: string, replay = false): UncompactedConversation[] {
  const configFile = configPath();
  selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
  return discoverUncompacted(minTokens, readOnly, cwdFilter, replay).conversations;
}

/** Compact all uncompacted conversations above threshold via the daemon. */
export async function batchCompact(opts: {
  minTokens: number;
  dryRun: boolean;
  port: number;
  cwd?: string;
  replay?: boolean;
  verbose?: boolean;
  tokenPath?: string;
  reasoningEffort?: LlmReasoningEffort;
  fastMode?: boolean;
  requestPolicy?: LlmInvocationRequestPolicy;
  /** Effective compact worker count; replay callers should resolve this to one. */
  maxConcurrency?: number;
  /** Invocation identity forwarded to every admitted daemon compact request. */
  invocationId?: string;
  /** Stops future claims while admitted requests are allowed to settle. */
  signal?: AbortSignal;
  /** Reports a daemon transport failure so a command can enter cancellation drain. */
  onTransportFailure?: (error: unknown) => void;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
}): Promise<BatchCompactResult> {
  const configFile = configPath();
  const config = loadDaemonConfig(configFile);
  selectStorageBackendForConfig(configFile, config.storage);
  const maxConcurrency = opts.replay ? 1 : opts.maxConcurrency ?? config.llm.maxConcurrency;
  const discovery = discoverUncompacted(opts.minTokens, opts.dryRun, opts.cwd, opts.replay);
  const conversations = discovery.conversations;
  const onProgress = opts.onProgress;
  const phaseErrors: ProgressPhaseError[] = discovery.failures.map(failure => ({
    phase: "Compact",
    target: failure.target,
    message: failure.message,
  }));

  if (phaseErrors.length > 0) {
    for (const failure of phaseErrors) {
      console.error(`  compact scan failed for ${failure.target}: ${failure.message}`);
    }
  }

  if (conversations.length === 0 && phaseErrors.length === 0) {
    console.log("Nothing to compact — no sessions are currently eligible.");
    return { compacted: 0, unchanged: 0, skipped: 0, failures: 0, compactedProjects: [] };
  }

  onProgress?.(phaseErrors.length > 0
    ? { total: conversations.length, phaseErrors }
    : { total: conversations.length });

  if (conversations.length === 0) {
    console.error("No sessions were compacted because project discovery failed.");
    return {
      compacted: 0,
      unchanged: 0,
      skipped: 0,
      failures: phaseErrors.length,
      compactedProjects: [],
    };
  }

  const totalTokens = conversations.reduce((s, c) => s + c.tokens, 0);
  console.log(`Found ${conversations.length} uncompacted conversation${conversations.length > 1 ? "s" : ""} (${(totalTokens / 1000).toFixed(1)}k tokens)\n`);

  let compacted = 0;
  let unchanged = 0;
  let skipped = 0;
  let completedCount = 0;
  let messagesIn = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const progressErrors: { sessionId: string; message: string }[] = [];
  const compactedProjectIndexes = new Map<string, number>();
  const activeSessions = new Map<number, ProgressCurrentSession>();
  const client = new DaemonClient(`http://127.0.0.1:${opts.port}`, opts.tokenPath);
  type CompactResponse = {
    summary?: string;
    skipped?: boolean;
    actionTaken?: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    providerLabel?: string;
    apiMode?: LlmApiMode;
    reasoningEffort?: LlmReasoningEffort | null;
    fastMode?: boolean | null;
    requestTimeoutMs?: number | null;
    retry?: LlmRetryPolicy | null;
  };

  const isCompactResponse = (value: unknown): value is CompactResponse => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const response = value as Partial<CompactResponse>;
    return response.skipped === true
      || typeof response.actionTaken === "boolean"
      // Successful daemon responses from older versions omit actionTaken but
      // carry the measured token counters; retain that wire compatibility.
      || typeof response.tokensBefore === "number"
      || typeof response.tokensAfter === "number";
  };

  const progressActivePatch = (): Partial<ProgressState> => opts.dryRun
    ? {}
    : {
      activeSessions: [...activeSessions.values()],
      current: progressCurrentSession([...activeSessions.values()]),
    };

  await runBatchWorkerPool<UncompactedConversation, CompactResponse>({
    items: conversations,
    maxConcurrency,
    signal: opts.signal,
    onClaim: opts.dryRun
      ? undefined
      : (conv, index) => {
        activeSessions.set(index, {
          sessionId: conv.sessionId,
          messages: conv.messages,
          tokens: conv.tokens,
          startedAt: Date.now(),
        });
        onProgress?.(progressActivePatch());
      },
    worker: async (conv) => {
      if (opts.dryRun) return {};
      const body = {
        session_id: conv.sessionId,
        cwd: conv.cwd,
        skip_ingest: true,
        client: "claude",
        ...(opts.invocationId === undefined ? {} : { invocation_id: opts.invocationId }),
        reasoning_effort: opts.reasoningEffort,
        fast_mode: opts.fastMode,
        request_timeout_ms: opts.requestPolicy?.requestTimeoutMs,
        ...(opts.requestPolicy?.retry ? { retry: {
          max_attempts: opts.requestPolicy.retry.maxAttempts,
          initial_delay_ms: opts.requestPolicy.retry.initialDelayMs,
          max_delay_ms: opts.requestPolicy.retry.maxDelayMs,
          multiplier: opts.requestPolicy.retry.multiplier,
        } } : {}),
      };
      return opts.signal === undefined
        ? client.post<CompactResponse>("/compact", body)
        : client.post<CompactResponse>("/compact", body, { signal: opts.signal });
    },
    onResult: (result) => {
      const conv = result.item;
      const label = `${conv.cwd} conv #${conv.conversationId} (${conv.messages} msgs, ${(conv.tokens / 1000).toFixed(1)}k tokens)`;
      const sessionStart = activeSessions.get(result.index)?.startedAt ?? Date.now();
      activeSessions.delete(result.index);
      const activePatch = progressActivePatch();

      if ("error" in result) {
        const errMsg = result.error instanceof Error ? result.error.message : "unknown error";
        if (isDaemonTransportFailure(result.error)) opts.onTransportFailure?.(result.error);
        console.log(`${label} FAILED (${errMsg})`);
        progressErrors.push({ sessionId: conv.sessionId, message: errMsg });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          errors: progressErrors,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
        });
        return;
      }

      const data = result.value;
      if (!opts.dryRun && !isCompactResponse(data)) {
        const errMsg = "malformed compact response";
        console.log(`${label} FAILED (${errMsg})`);
        progressErrors.push({ sessionId: conv.sessionId, message: errMsg });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          errors: progressErrors,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
        });
        return;
      }
      if (opts.dryRun) {
        console.log(`  [dry-run] would compact: ${label}`);
        completedCount++;
        onProgress?.({ ...activePatch, completed: completedCount });
      } else if (data?.skipped) {
        skipped++;
        completedCount++;
        console.log(`${label} skipped (already in progress)`);
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
        });
      } else if (data?.actionTaken === false) {
        unchanged++;
        completedCount++;
        const tokensBefore = data.tokensBefore ?? conv.tokens;
        const tokensAfter = data.tokensAfter ?? tokensBefore;
        const summary = data.summary?.trim() || "No compaction needed.";
        console.log(`${label} unchanged (${summary})`);
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore, tokensAfter, provider: formatLlmDiagnostic(data), elapsed: Date.now() - sessionStart },
        });
      } else {
        const tokensBefore = data.tokensBefore ?? conv.tokens;
        const tokensAfter = data.tokensAfter ?? tokensBefore;
        if (opts.verbose && tokensBefore > 0) {
          const pct = Math.round((1 - tokensAfter / tokensBefore) * 100);
          console.log(`${label} done  (${(tokensBefore / 1000).toFixed(1)}k → ${(tokensAfter / 1000).toFixed(1)}k tokens, ${pct}% reduction)`);
        } else {
          console.log(`${label} done`);
        }
        compacted++;
        completedCount++;
        const project = normalizeProjectPath(conv.cwd);
        const earliestIndex = compactedProjectIndexes.get(project);
        if (earliestIndex === undefined || result.index < earliestIndex) {
          compactedProjectIndexes.set(project, result.index);
        }
        messagesIn += conv.messages;
        tokensIn += tokensBefore;
        tokensOut += tokensAfter;
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          messagesIn,
          tokensIn,
          tokensOut,
          lastResult: {
            sessionId: conv.sessionId,
            messages: conv.messages,
            tokensBefore,
            tokensAfter,
            provider: formatLlmDiagnostic(data),
            elapsed: Date.now() - sessionStart,
          },
        });
      }
    },
  });

  if (!opts.dryRun) {
    if (tokensIn > 0) {
      const freed = tokensIn - tokensOut;
      const pct = Math.round((freed / tokensIn) * 100);
      console.log(`\nBatch compact complete. ${compacted} session${compacted !== 1 ? "s" : ""} compacted, ${(tokensIn / 1000).toFixed(1)}k → ${(tokensOut / 1000).toFixed(1)}k tokens (${pct}% reduction, ${(freed / 1000).toFixed(1)}k freed)`);
    } else {
      console.log("\nBatch compact complete.");
    }
  }

  return {
    compacted,
    unchanged,
    skipped,
    failures: phaseErrors.length + progressErrors.length,
    compactedProjects: [...compactedProjectIndexes.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([project]) => project),
  };
}
