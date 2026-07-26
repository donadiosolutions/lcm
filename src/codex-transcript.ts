/**
 * Parser for Codex CLI session transcript files.
 *
 * Codex stores active sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * (with an older ~/.codex/sessions/<session-id>/<session-id>.jsonl layout)
 * and archives them in ~/.codex/archived_sessions/<name>.jsonl.
 *
 * Each JSONL line is an event object with a top-level `type` and `payload`:
 *
 *   { type: "session_meta", payload: { id, cwd, ... } }
 *   { type: "response_item", payload: { type: "message", role: "user"|"assistant"|..., content: [...] } }
 *   { type: "event_msg", payload: { ... } }
 *   ...
 *
 * Content blocks for user messages use `type: "input_text"` and for assistant
 * messages use `type: "output_text"` (both carry a `text` string field).
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { estimateTokens } from "./transcript.js";
import type { ParsedMessage } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types matching the Codex JSONL event format
// ---------------------------------------------------------------------------

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexResponseItemPayload {
  type?: string;
  role?: string;
  content?: string | CodexContentBlock[];
}

interface CodexSessionMetaPayload {
  id?: string;
  cwd?: string;
  git?: {
    commit_hash?: string;
    repository_url?: string;
    branch?: string;
  };
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: CodexResponseItemPayload | CodexSessionMetaPayload | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractCodexText(content: string | CodexContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      // Codex uses input_text (user) and output_text (assistant)
      if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
        return b.text;
      }
      // Plain text fallback
      if (b.type === "text" && typeof b.text === "string") {
        return b.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

/**
 * Parse a Codex JSONL transcript file into the standard ParsedMessage format.
 * Returns an empty array on any read or parse error.
 */
export function parseCodexTranscript(transcriptPath: string): ParsedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const messages: ParsedMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: CodexLine;
    try {
      obj = JSON.parse(trimmed) as CodexLine;
    } catch {
      continue;
    }

    // Only response_item lines carry user/assistant messages
    if (obj.type !== "response_item") continue;

    const payload = obj.payload as CodexResponseItemPayload | undefined;
    if (!payload || payload.type !== "message") continue;

    const role = payload.role;
    if (!role || !["user", "assistant"].includes(role)) continue;

    const content = extractCodexText(payload.content);
    if (!content.trim()) continue;

    messages.push({ role, content, tokenCount: estimateTokens(content) });
  }

  return messages;
}

/**
 * Extract the working directory from a Codex session JSONL file.
 * Returns undefined if the session_meta line cannot be found/parsed.
 */
export function extractCodexSessionCwd(transcriptPath: string): string | undefined {
  return extractCodexSessionMeta(transcriptPath)?.cwd;
}

export type CodexSessionMetadata = {
  readonly threadId?: string;
  readonly cwd?: string;
  readonly repositoryUrl?: string;
  readonly commit?: string;
  readonly branch?: string;
};

const MAX_CODEX_SESSION_META_PREFIX_BYTES = 256 * 1024;

/**
 * Read only the bounded transcript prefix needed for session_meta. The record
 * is emitted at session start, so scanning an unbounded conversation is both
 * unnecessary and unsafe for import discovery.
 */
export function extractCodexSessionMeta(transcriptPath: string): CodexSessionMetadata | undefined {
  let fd: number | undefined;
  let raw: string;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const leaf = fstatSync(fd);
    if (!leaf.isFile()) return undefined;
    const size = Math.min(leaf.size, MAX_CODEX_SESSION_META_PREFIX_BYTES);
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CodexLine;
      if (obj.type === "session_meta") {
        const meta = obj.payload as CodexSessionMetaPayload | undefined;
        if (!meta || typeof meta !== "object") return undefined;
        const result: CodexSessionMetadata = {
          ...(typeof meta.id === "string" && meta.id ? { threadId: meta.id } : {}),
          ...(typeof meta.cwd === "string" && meta.cwd ? { cwd: meta.cwd } : {}),
          ...(typeof meta.git?.repository_url === "string" && meta.git.repository_url
            ? { repositoryUrl: meta.git.repository_url }
            : {}),
          ...(typeof meta.git?.commit_hash === "string" && meta.git.commit_hash
            ? { commit: meta.git.commit_hash }
            : {}),
          ...(typeof meta.git?.branch === "string" && meta.git.branch
            ? { branch: meta.git.branch }
            : {}),
        };
        return Object.keys(result).length > 0 ? result : undefined;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export interface CodexSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
}

function addCodexTranscriptFile(
  files: CodexSessionFile[],
  directory: string,
  name: string,
): void {
  try {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    files.push({
      path,
      sessionId: basename(name, ".jsonl"),
      mtime: stat.mtimeMs,
    });
  } catch {
    // Skip a leaf that disappeared or became unreadable during discovery.
  }
}

function findDatePartitionedCodexSessionFiles(rootDir: string): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  const years = /^\d{4}$/u;
  const monthOrDay = /^\d{2}$/u;

  try {
    for (const year of readdirSync(rootDir, { withFileTypes: true })) {
      if (!year.isDirectory() || year.isSymbolicLink() || !years.test(year.name)) continue;
      const yearDir = join(rootDir, year.name);
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory() || month.isSymbolicLink() || !monthOrDay.test(month.name)) continue;
        const monthDir = join(yearDir, month.name);
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory() || day.isSymbolicLink() || !monthOrDay.test(day.name)) continue;
          const dayDir = join(monthDir, day.name);
          for (const transcript of readdirSync(dayDir, { withFileTypes: true })) {
            if (!/^rollout-.+\.jsonl$/u.test(transcript.name)) continue;
            addCodexTranscriptFile(files, dayDir, transcript.name);
          }
        }
      }
    }
  } catch {
    // Discovery is best-effort; a concurrent removal must not abort import.
  }
  return files;
}

/**
 * Discover Codex transcript files under a root directory.
 *
 * Supported layouts:
 *   - Flat:  <root>/<name>.jsonl         (archived_sessions/)
 *   - Nested: <root>/<id>/<id>.jsonl     (sessions/ layout)
 *   - Date-partitioned: <root>/YYYY/MM/DD/rollout-*.jsonl (active sessions)
 */
export function findCodexSessionFiles(rootDir: string): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  if (!existsSync(rootDir)) return files;

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    // Flat layout: rootDir/<name>.jsonl
    if (entry.name.endsWith(".jsonl")) {
      try {
        addCodexTranscriptFile(files, rootDir, entry.name);
      } catch {
        // skip unreadable entries
      }
      continue;
    }

    // Nested layout: rootDir/<id>/<id>.jsonl
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = join(rootDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nested)) {
        try {
          const st = lstatSync(nested);
          if (st.isSymbolicLink()) {
            // skip symlinks
          } else if (st.isFile()) {
            files.push({
              path: nested,
              sessionId: entry.name,
              mtime: st.mtimeMs,
            });
          }
        } catch {
          // skip
        }
      }
    }
  }

  files.push(...findDatePartitionedCodexSessionFiles(rootDir));
  return files.sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Collect all Codex transcript files from a Codex home directory.
 *
 * Searches:
 *   - <codexDir>/archived_sessions/*.jsonl  (flat layout)
 *   - <codexDir>/sessions/<id>/<id>.jsonl   (nested legacy layout)
 *   - <codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl (active layout)
 *
 * Defaults to ~/.codex when codexDir is omitted.
 */
export function findAllCodexTranscripts(codexDir?: string): CodexSessionFile[] {
  const root = codexDir ?? join(homedir(), ".codex");
  const results: CodexSessionFile[] = [];

  // Archived sessions (flat)
  results.push(...findCodexSessionFiles(join(root, "archived_sessions")));

  // Active sessions (nested)
  results.push(...findCodexSessionFiles(join(root, "sessions")));

  // De-duplicate by sessionId (flat archive wins over sessions/)
  const seen = new Map<string, CodexSessionFile>();
  for (const f of results) {
    if (!seen.has(f.sessionId)) seen.set(f.sessionId, f);
  }

  return [...seen.values()].sort((a, b) => {
    const d = a.mtime - b.mtime;
    if (d !== 0) return d;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
