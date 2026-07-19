import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { runLcmMigrations } from "./db/migration.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
import type { ProgressState } from "./cli/progress-state.js";
import { DaemonClient } from "./daemon/client.js";
import { projectsDir as lcmProjectsDir } from "./runtime-paths.js";
import { normalizeProjectPath, projectMapPathsForHash } from "./project-map.js";
import type { LlmApiMode, LlmInvocationRequestPolicy, LlmReasoningEffort, LlmRetryPolicy } from "./daemon/config.js";
import { MANUAL_COMPACT_FRESH_TAIL_COUNT } from "./compaction.js";

export interface UncompactedConversation {
  projectDir: string;
  cwd: string;
  conversationId: number;
  sessionId: string;
  messages: number;
  tokens: number;
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

export function findUncompacted(minTokens: number, readOnly = false, cwdFilter?: string, replay = false): UncompactedConversation[] {
  const baseDir = lcmProjectsDir();
  if (!existsSync(baseDir)) return [];

  const results: UncompactedConversation[] = [];

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = join(baseDir, entry.name);
    const dbPath = join(projDir, "db.sqlite");
    if (!existsSync(dbPath)) continue;

    const metaPath = join(projDir, "meta.json");
    let cwd = "";
    if (existsSync(metaPath)) {
      try {
        cwd = JSON.parse(readFileSync(metaPath, "utf-8")).cwd ?? "";
      } catch { /* skip corrupt meta */ }
    }
    if (!cwd) continue;
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
          AND COALESCE(ci.raw_context_count, 0) > ?
          AND (? OR COALESCE(s.sum_count, 0) = 0)
          AND COALESCE(m.raw_tokens, 0) >= ?
        ORDER BY COALESCE(m.raw_tokens, 0) DESC
        `).all(MANUAL_COMPACT_FRESH_TAIL_COUNT, replay ? 1 : 0, minTokens) as { conversation_id: number; session_id: string; messages: number; tokens: number; summaries: number }[];

        for (const row of rows) {
          results.push({
            projectDir: projDir,
            cwd,
            conversationId: row.conversation_id,
            sessionId: row.session_id,
            messages: row.messages,
            tokens: row.tokens,
          });
        }
      } finally {
        closeLcmConnection(dbPath);
      }
    } catch { /* skip corrupt databases */ }
  }

  return results;
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
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
}): Promise<{ compacted: number; unchanged: number; failures: number; compactedProjects: string[] }> {
  const conversations = findUncompacted(opts.minTokens, opts.dryRun, opts.cwd, opts.replay);
  const onProgress = opts.onProgress;

  if (conversations.length === 0) {
    console.log("Nothing to compact — all sessions are up to date.");
    return { compacted: 0, unchanged: 0, failures: 0, compactedProjects: [] };
  }

  const totalTokens = conversations.reduce((s, c) => s + c.tokens, 0);
  console.log(`Found ${conversations.length} uncompacted conversation${conversations.length > 1 ? "s" : ""} (${(totalTokens / 1000).toFixed(1)}k tokens)\n`);

  // Notify renderer of total so it can show accurate progress
  onProgress?.({ total: conversations.length });

  let compacted = 0;
  let unchanged = 0;
  let doneCount = 0;
  let messagesIn = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const progressErrors: { sessionId: string; message: string }[] = [];
  const compactedProjects = new Set<string>();
  const client = new DaemonClient(`http://127.0.0.1:${opts.port}`, opts.tokenPath);

  for (const conv of conversations) {
    const label = `${conv.cwd} conv #${conv.conversationId} (${conv.messages} msgs, ${(conv.tokens / 1000).toFixed(1)}k tokens)`;

    if (opts.dryRun) {
      console.log(`  [dry-run] would compact: ${label}`);
      doneCount++;
      onProgress?.({ completed: doneCount });
      continue;
    }

    const sessionStart = Date.now();
    onProgress?.({ current: { sessionId: conv.sessionId, messages: conv.messages, tokens: conv.tokens, startedAt: sessionStart } });
    process.stdout.write(`  compacting: ${label}...`);
    try {
      const data = await client.post<{
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
      }>("/compact", {
        session_id: conv.sessionId,
        cwd: conv.cwd,
        skip_ingest: true,
        client: "claude",
        reasoning_effort: opts.reasoningEffort,
        fast_mode: opts.fastMode,
        request_timeout_ms: opts.requestPolicy?.requestTimeoutMs,
        ...(opts.requestPolicy?.retry ? { retry: {
          max_attempts: opts.requestPolicy.retry.maxAttempts,
          initial_delay_ms: opts.requestPolicy.retry.initialDelayMs,
          max_delay_ms: opts.requestPolicy.retry.maxDelayMs,
          multiplier: opts.requestPolicy.retry.multiplier,
        } } : {}),
      });

      doneCount++;
      if (data.skipped) {
        console.log(" skipped (already in progress)");
        onProgress?.({
          completed: doneCount,
          current: undefined,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
        });
      } else if (data.actionTaken === false) {
        unchanged++;
        console.log(" unchanged (no compaction needed)");
        onProgress?.({
          completed: doneCount,
          current: undefined,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, tokensAfter: conv.tokens, provider: formatLlmDiagnostic(data), elapsed: Date.now() - sessionStart },
        });
      } else {
        const tokensBefore = data.tokensBefore ?? conv.tokens;
        const tokensAfter = data.tokensAfter ?? 0;
        if (opts.verbose && tokensBefore > 0) {
          const pct = Math.round((1 - tokensAfter / tokensBefore) * 100);
          console.log(` done  (${(tokensBefore / 1000).toFixed(1)}k → ${(tokensAfter / 1000).toFixed(1)}k tokens, ${pct}% reduction)`);
        } else {
          console.log(" done");
        }
        compacted++;
        compactedProjects.add(normalizeProjectPath(conv.cwd));
        messagesIn += conv.messages;
        tokensIn += tokensBefore;
        tokensOut += tokensAfter;
        onProgress?.({
          completed: doneCount,
          messagesIn,
          tokensIn,
          tokensOut,
          current: undefined,
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
    } catch (err) {
      doneCount++;
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.log(` FAILED (${errMsg})`);
      progressErrors.push({ sessionId: conv.sessionId, message: errMsg });
      onProgress?.({
        completed: doneCount,
        current: undefined,
        errors: progressErrors,
        lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
      });
    }
  }

  if (!opts.dryRun) {
    if (tokensIn > 0) {
      const freed = tokensIn - tokensOut;
      const pct = Math.round((freed / tokensIn) * 100);
      console.log(`\nBatch compact complete. ${compacted} session${compacted !== 1 ? "s" : ""} compacted, ${(tokensIn / 1000).toFixed(1)}k → ${(tokensOut / 1000).toFixed(1)}k tokens (${pct}% reduction, ${(freed / 1000).toFixed(1)}k freed)`);
    } else {
      console.log("\nBatch compact complete.");
    }
  }

  return { compacted, unchanged, failures: progressErrors.length, compactedProjects: [...compactedProjects] };
}
