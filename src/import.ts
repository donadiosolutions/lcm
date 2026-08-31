import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { DaemonClient } from "./daemon/client.js";
import { formatNumber, formatRatio } from "./stats.js";
import type { ProgressState } from "./cli/progress-state.js";
import type { TranscriptClient } from "./transcript-provider.js";
import { configPath, lcmHomeDir } from "./runtime-paths.js";
import { loadDaemonConfig } from "./daemon/config.js";
import { selectStorageBackendForConfig } from "./storage/backend.js";
import { projectId } from "./daemon/project.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  readProjectMapSnapshot,
  resolveProjectIdentity,
} from "./project-map.js";
import { resolveCodexSessions } from "./codex-project-resolution.js";
import { findAllCodexTranscripts } from "./codex-transcript.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { ensureWorktreeProjectReconciled } from "./worktree-reconciliation.js";

export type ImportProvider = "claude" | "codex" | "all";

interface ImportOptions {
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  replay?: boolean;
  /** Which transcript provider to import from (default: "claude") */
  provider?: ImportProvider;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
  /** Override ~/.lcm path — used in tests only */
  _lcmDir?: string;
  /** Override ~/.codex path — used in tests only */
  _codexDir?: string;
}

export interface ImportResult {
  imported: number;
  skippedEmpty: number;
  failed: number;
  totalMessages: number;
  totalTokens: number;
  tokensAfter: number;
  reconciled?: number;
  unresolved?: number;
  ambiguous?: number;
}

export function cwdToProjectHash(cwd: string): string {
  // Claude Code uses the cwd with slashes replaced by dashes, keeping the leading dash
  // e.g. /Users/pedro/Developer/project → -Users-pedro-Developer-project
  return cwd.replace(/\//g, '-');
}

function buildProjectMap(lcmDir?: string): Map<string, string> {
  const lcmProjectsDir = join(lcmDir ?? lcmHomeDir(), 'projects');
  const map = new Map<string, string>();
  if (!existsSync(lcmProjectsDir)) return map;
  for (const entry of readdirSync(lcmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(lcmProjectsDir, entry.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.cwd) {
        const hash = cwdToProjectHash(meta.cwd);
        map.set(hash, meta.cwd);
      }
    } catch {}
  }
  return map;
}

export function findSessionFiles(projectDir: string): { path: string; sessionId: string; mtime: number }[] {
  const files: { path: string; sessionId: string; mtime: number }[] = [];
  if (!existsSync(projectDir)) return files;

  // Track which session IDs have a flat (project-root) transcript so we can
  // deduplicate when the same session also has a nested copy.
  const flatSessionIds = new Set<string>();

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    // Layout B (flat): <projectDir>/<session-id>.jsonl
    if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl')) {
      try {
        const filePath = join(projectDir, entry.name);
        const st = lstatSync(filePath);
        if (st.isSymbolicLink()) continue; // skip symlinks
        const sessionId = basename(entry.name, '.jsonl');
        files.push({
          path: filePath,
          sessionId,
          mtime: st.mtimeMs,
        });
        flatSessionIds.add(sessionId);
      } catch {
        // Skip entries that can't be stat'd (file deleted or permissions issue)
        continue;
      }
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      // Layout A (nested): <projectDir>/<session-id>/<session-id>.jsonl
      const nestedTranscript = join(projectDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nestedTranscript)) {
        try {
          const nestedStat = lstatSync(nestedTranscript);
          if (nestedStat.isSymbolicLink()) {
            // skip symlinks
          } else if (nestedStat.isFile()) {
            files.push({
              path: nestedTranscript,
              sessionId: entry.name,
              mtime: nestedStat.mtimeMs,
            });
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }

      // Subagent transcripts: <projectDir>/<session-id>/subagents/<agent-id>.jsonl
      const subagentsDir = join(projectDir, entry.name, 'subagents');
      if (existsSync(subagentsDir)) {
        for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
          if (sub.isFile() && !sub.isSymbolicLink() && sub.name.endsWith('.jsonl')) {
            try {
              const subPath = join(subagentsDir, sub.name);
              const subSt = lstatSync(subPath);
              if (subSt.isSymbolicLink()) continue; // skip symlinks
              files.push({
                path: subPath,
                sessionId: basename(sub.name, '.jsonl'),
                mtime: subSt.mtimeMs,
              });
            } catch {
              // Skip entries that can't be stat'd
              continue;
            }
          }
        }
      }
    }
  }

  // Deduplicate: when a session has both a flat and nested transcript,
  // keep only the flat file (the canonical source in newer Claude Code versions).
  // Subagent files (inside subagents/) are kept unconditionally because their
  // paths never match the nested transcript pattern below.
  const deduped = files.filter(f => {
    const isNested = f.path === join(projectDir, f.sessionId, `${f.sessionId}.jsonl`);
    return !isNested || !flatSessionIds.has(f.sessionId);
  });

  return deduped.sort((a, b) => {
    const mtimeDiff = a.mtime - b.mtime;
    if (mtimeDiff !== 0) return mtimeDiff;
    const sessionIdDiff = a.sessionId.localeCompare(b.sessionId);
    if (sessionIdDiff !== 0) return sessionIdDiff;
    return a.path.localeCompare(b.path);
  });
}

// ---------------------------------------------------------------------------
// Shared inner loop — ingests a flat list of { path, sessionId, cwd } entries
// ---------------------------------------------------------------------------

interface SessionEntry {
  path: string;
  sessionId: string;
  cwd: string;
  client: TranscriptClient;
}

async function ingestSessionList(
  client: DaemonClient,
  sessions: SessionEntry[],
  options: ImportOptions,
  result: ImportResult,
): Promise<void> {
  const previousSummaries = new Map<string, string>();
  const total = sessions.length;

  for (const { path, sessionId, cwd, client: clientName } of sessions) {
    if (options.dryRun) {
      if (options.verbose) {
        const replayNote = options.replay ? " (would compact)" : "";
        console.log(`  [dry-run] ${sessionId}${replayNote}`);
      }
      result.imported++;
      options.onProgress?.({ completed: result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
      continue;
    }
    const replayKey = `${clientName}\u0000${projectId(cwd)}`;

    try {
      const res = await client.post<{ ingested: number; totalTokens: number }>('/ingest', {
        session_id: sessionId,
        cwd,
        transcript_path: path,
        client: clientName,
      });
      if (res.ingested === 0 && res.totalTokens === 0) {
        result.skippedEmpty++;
        if (options.verbose) console.log(`  \u23ed\ufe0f ${sessionId}: empty or already ingested`);
      } else {
        result.imported++;
        result.totalMessages += res.ingested;
        // In replay mode, totalTokens is sourced from compact's tokensBefore to avoid
        // double-counting (compact covers already-ingested sessions too).
        if (!options.replay) {
          result.totalTokens += res.totalTokens;
        }
        if (options.verbose) console.log(`  \u2705 ${sessionId}: ${res.ingested} messages (${formatNumber(res.totalTokens)} tokens)`);
      }

      // Replay: compact immediately after every session (even already-ingested ones)
      // so that re-runs are idempotent and the temporal chain stays intact.
      if (options.replay) {
        try {
          const compactRes = await client.post<{
            summary?: string;
            latestSummaryContent?: string;
            skipped?: boolean;
            tokensBefore?: number;
            tokensAfter?: number;
          }>('/compact', {
            session_id: sessionId,
            cwd,
            skip_ingest: true,
            client: clientName,
            ...(previousSummaries.has(replayKey) ? { previous_summary: previousSummaries.get(replayKey) } : {}),
          });
          const hadPrevious = previousSummaries.has(replayKey);
          if (compactRes.latestSummaryContent !== undefined) {
            previousSummaries.set(replayKey, compactRes.latestSummaryContent);
          }
          // Use compact's tokensBefore as the authoritative token count for this session.
          // This avoids under-reporting when /ingest returns totalTokens=0 (already-ingested).
          if (typeof compactRes.tokensBefore === 'number') {
            result.totalTokens += compactRes.tokensBefore;
          }
          if (typeof compactRes.tokensAfter === 'number') {
            result.tokensAfter += compactRes.tokensAfter;
          }
          if (options.verbose) {
            const ctx = hadPrevious ? ' (with prior context)' : '';
            if (typeof compactRes.tokensBefore === 'number' && typeof compactRes.tokensAfter === 'number' && compactRes.tokensAfter < compactRes.tokensBefore) {
              const ratio = formatRatio(compactRes.tokensBefore, compactRes.tokensAfter);
              console.log(`  \ud83e\udde0 ${sessionId}: ${formatNumber(compactRes.tokensBefore)} \u2192 ${formatNumber(compactRes.tokensAfter)}  (${ratio}\u00d7)${ctx}`);
            } else {
              console.log(`  \ud83e\udde0 ${sessionId}: compacted${ctx}`);
            }
          }
        } catch (err) {
          // Non-fatal: import succeeded; compact failure breaks the chain at this link.
          previousSummaries.delete(replayKey);
          // Always warn on chain breakage so users know the DAG is incomplete,
          // regardless of whether --verbose was passed.
          const message = err instanceof Error ? err.message : "unknown error";
          console.error(
            `  \u26a0\ufe0f [replay] compact failed for session ${sanitizeTerminalText(sessionId)}: ${sanitizeTerminalText(message)}`,
          );
          // Fall back to ingest's totalTokens so they aren't silently lost.
          result.totalTokens += res.totalTokens;
        }
      }
      options.onProgress?.({ completed: result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
    } catch (err) {
      result.failed++;
      if (options.replay) previousSummaries.delete(replayKey); // chain broken for this project/client
      if (options.verbose) {
        const message = err instanceof Error ? err.message : "failed";
        console.log(`  \u274c ${sanitizeTerminalText(sessionId)}: ${sanitizeTerminalText(message)}`);
      }
      options.onProgress?.({ completed: result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function importSessions(
  client: DaemonClient,
  options: ImportOptions = {}
): Promise<ImportResult> {
  // Admission precedes transcript discovery, including an empty-catalogue
  // no-op, so unresolved publication state cannot be hidden by a quiet import.
  const configFile = configPath();
  selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
  const provider: ImportProvider = options.provider ?? "claude";
  const result: ImportResult = {
    imported: 0,
    skippedEmpty: 0,
    failed: 0,
    totalMessages: 0,
    totalTokens: 0,
    tokensAfter: 0,
    reconciled: 0,
    unresolved: 0,
    ambiguous: 0,
  };

  // --- Claude Code sessions ---
  if (provider === "claude" || provider === "all") {
    const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), '.claude', 'projects');

    const projectDirs: { dir: string; cwd: string }[] = [];

    if (options.all) {
      if (existsSync(claudeProjectsDir)) {
        const projectMap = buildProjectMap(options._lcmDir);
        for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cwd = projectMap.get(entry.name);
          if (!cwd) continue;
          projectDirs.push({ dir: join(claudeProjectsDir, entry.name), cwd });
        }
      }
    } else {
      const cwd = options.cwd ?? process.cwd();
      const hash = cwdToProjectHash(cwd);
      const dir = join(claudeProjectsDir, hash);
      if (existsSync(dir)) {
        projectDirs.push({ dir, cwd });
      }
    }

    for (const { dir, cwd } of projectDirs) {
      const sessionFiles = findSessionFiles(dir);
      await ingestSessionList(
        client,
        sessionFiles.map(f => ({ ...f, cwd, client: "claude" as const })),
        options,
        result,
      );
    }
  }

  // --- Codex CLI sessions ---
  if (provider === "codex" || provider === "all") {
    // An empty catalogue remains a read-only no-op.
    if (findAllCodexTranscripts(options._codexDir).length === 0) return result;
    const requestedCwd = options.cwd ?? process.cwd();
    const current = options.dryRun
      ? (() => {
        const canonical = normalizeProjectIdentityPath(requestedCwd);
        return { id: hashProjectPath(canonical), canonical };
      })()
      : (() => {
        ensureWorktreeProjectReconciled(requestedCwd, undefined, {
          _codexDir: options._codexDir,
        });
        return resolveProjectIdentity(requestedCwd);
      })();
    // Reconcile and register the current live Git identity before snapshotting
    // the catalogue. Otherwise legacy or first-import identities can be
    // classified against stale map state. Dry runs add the normalized current
    // identity only to their in-memory snapshot.
    const mapSnapshot = readProjectMapSnapshot();
    if (options.dryRun && mapSnapshot[current.id] === undefined) {
      mapSnapshot[current.id] = { canonical: current.canonical, aliases: [] };
    }
    const resolvedCodexSessions = resolveCodexSessions(
      options._codexDir,
      mapSnapshot,
    );
    if (resolvedCodexSessions.length === 0) return result;
    const codexSessions: SessionEntry[] = [];
    for (const session of resolvedCodexSessions) {
      let resolution = session.resolution;
      if (
        resolution.status === "unresolved"
        && session.metadata?.cwd !== undefined
        && normalizeProjectPath(session.metadata.cwd) === normalizeProjectPath(current.canonical)
      ) {
        resolution = {
          status: "resolved",
          canonical: current.canonical,
          projectHash: current.id,
          evidence: "mapped-path",
        };
      }
      if (resolution.status !== "resolved") {
        if (resolution.status === "ambiguous") result.ambiguous! += 1;
        else result.unresolved! += 1;
        if (options.verbose) {
          console.log(`  \u23ed\ufe0f ${session.sessionId}: ${resolution.reason}`);
        }
        continue;
      }
      if (!options.all && resolution.projectHash !== current.id) continue;
      if (
        resolution.evidence === "thread-owner"
        || resolution.evidence === "repository-tombstone"
      ) {
        result.reconciled! += 1;
      }
      codexSessions.push({
        path: session.path,
        sessionId: session.metadata?.threadId ?? session.sessionId,
        cwd: resolution.canonical,
        client: "codex",
      });
    }

    await ingestSessionList(client, codexSessions, options, result);
  }

  return result;
}
