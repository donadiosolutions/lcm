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
  type Dir,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { estimateTokens, readTranscriptFileText } from "./transcript.js";
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
  const raw = readTranscriptFileText(transcriptPath);
  if (raw === undefined) return [];

  return parseCodexTranscriptText(raw);
}

/**
 * Where the history a Codex rollout inherited from its parent ends.
 *
 * - `ordinal`: a forked subagent. Records persisted before `start` (by their
 *   top-level ordinal) are the parent's inherited context.
 * - `copied-fork` with `startRecord`: a user fork that copied its parent's
 *   rollout. Records before the first thread_settings_applied event of the
 *   fork's own thread (by native source ordinal) are the parent's.
 * - `copied-fork` with `pending`: a user fork that has not written that event
 *   yet. Every record is still the parent's.
 */
export type CodexInheritedBoundary =
  | {
    readonly kind: "ordinal";
    readonly start: number;
    /** Only a paginated rollout reliably stamps every persisted record with an ordinal. */
    readonly paginated: boolean;
  }
  | { readonly kind: "copied-fork"; readonly startRecord: number; readonly pending?: undefined }
  | { readonly kind: "copied-fork"; readonly pending: true; readonly startRecord?: undefined };

/**
 * The ordinal boundary as callers passed it before boundaries had a kind; it
 * is still accepted and means the `ordinal` variant.
 */
export interface CodexOrdinalBoundaryWithoutKind {
  readonly kind?: undefined;
  readonly start: number;
  readonly paginated: boolean;
}

/** What the native transcript options accept as an inherited-history boundary. */
export type CodexInheritedBoundaryInput = CodexInheritedBoundary | CodexOrdinalBoundaryWithoutKind;

function isCodexOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the inherited-history boundary from already-bound transcript bytes.
 * Codex writes a subagent's own session_meta as the first record, so only the
 * first non-blank record is consulted; a later session_meta is ignored.
 */
export function readCodexInheritedBoundary(raw: string): CodexInheritedBoundary | undefined {
  const payload = firstSessionMetaPayload(raw);
  const start = payload?.subagent_history_start_ordinal;
  // A valid subagent ordinal wins; anything else falls through to a copied fork.
  if (payload !== undefined && isCodexOrdinal(start)) {
    return { kind: "ordinal", start, paginated: payload.history_mode === "paginated" };
  }
  return readCopiedForkBoundary(raw);
}

/**
 * Largest line the native transcript reader accepts. It still counts a longer
 * line as a record, so this number only matters for blank lines of that size.
 */
const NATIVE_RECORD_BYTE_LIMIT = 10 * 1024 * 1024;

/**
 * The physical lines the native transcript reader counts, with the position it
 * gives each one (its sourceOrdinal). A line counts unless every byte is a tab,
 * a carriage return or a space; malformed, non-container, duplicate-key and
 * oversized lines all count. This is deliberately not String.trim(), which also
 * treats VT, FF, NBSP and other Unicode spaces as blank.
 */
function* nativeSourceLines(raw: string): Generator<{ position: number; line: string; oversized: boolean }> {
  let position = 0;
  for (const line of raw.split("\n")) {
    const oversized = line.length * 3 > NATIVE_RECORD_BYTE_LIMIT
      && Buffer.byteLength(line, "utf8") > NATIVE_RECORD_BYTE_LIMIT;
    if (!oversized && /^[\t\r ]*$/u.test(line)) continue;
    yield { position, line, oversized };
    position += 1;
  }
}

/** One counted line as JSON, or undefined when the native reader could not use it. */
function parseNativeSourceLine(line: string, oversized: boolean): unknown {
  if (oversized) return undefined;
  try {
    // The native decoder drops a byte order mark before parsing each record.
    return JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
  } catch {
    return undefined;
  }
}

/**
 * The boundary of a user fork that copied its parent's rollout. Positions are
 * native source ordinals so the stored messages and the native links of one
 * fork always agree on which records are inherited. Anything uncertain returns
 * undefined, which keeps today's full parse.
 */
function readCopiedForkBoundary(raw: string): CodexInheritedBoundary | undefined {
  let threadId: string | undefined;
  for (const { position, line, oversized } of nativeSourceLines(raw)) {
    const record = parseNativeSourceLine(line, oversized);
    if (position === 0) {
      // Only the first counted line may be the fork's session_meta; no scanning ahead.
      const meta = isRecord(record) && record.type === "session_meta" && isRecord(record.payload)
        ? record.payload
        : undefined;
      if (meta === undefined) return undefined;
      const { id, forked_from_id: forkedFromId, history_base: historyBase } = meta;
      if (
        typeof id !== "string" || id === ""
        || typeof forkedFromId !== "string" || forkedFromId === "" || forkedFromId === id
        // A referenced fork keeps its history elsewhere, so nothing is copied.
        || (historyBase !== undefined && historyBase !== null)
      ) return undefined;
      threadId = id;
      continue;
    }
    if (!isRecord(record) || record.type !== "event_msg" || !isRecord(record.payload)
      || record.payload.type !== "thread_settings_applied") continue;
    const settingsThreadId = record.payload.thread_id;
    // A settings event that does not name its thread cannot be attributed.
    if (typeof settingsThreadId !== "string" || settingsThreadId === "") return undefined;
    if (settingsThreadId === threadId) return { kind: "copied-fork", startRecord: position };
  }
  return threadId === undefined ? undefined : { kind: "copied-fork", pending: true };
}

/** A Codex rollout's first session_meta identifies the rollout and its immediate parent. */
export interface CodexSessionParent {
  readonly id: string;
  readonly parentThreadId: string;
}

/**
 * Read the rollout's own id and immediate parent thread from already-bound
 * bytes. Independent of the inherited-history boundary: only the first
 * non-blank record is consulted, and both fields must be strings.
 */
export function readCodexSessionParent(raw: string): CodexSessionParent | undefined {
  const payload = firstSessionMetaPayload(raw);
  if (payload === undefined) return undefined;
  const { id, parent_thread_id: parentThreadId } = payload;
  return typeof id === "string" && typeof parentThreadId === "string"
    ? { id, parentThreadId }
    : undefined;
}

function firstSessionMetaPayload(raw: string): Record<string, unknown> | undefined {
  let offset = 0;
  while (offset <= raw.length) {
    const newline = raw.indexOf("\n", offset);
    const end = newline === -1 ? raw.length : newline;
    const trimmed = raw.slice(offset, end).trim();
    offset = end + 1;
    if (!trimmed) continue;
    let first: unknown;
    try {
      first = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isRecord(first) || first.type !== "session_meta" || !isRecord(first.payload)) return undefined;
    return first.payload;
  }
  return undefined;
}

function isInheritedByOrdinal(
  record: unknown,
  boundary: Extract<CodexInheritedBoundary, { kind: "ordinal" }>,
): boolean {
  const ordinal = isRecord(record) ? record.ordinal : undefined;
  return isCodexOrdinal(ordinal) ? ordinal < boundary.start : boundary.paginated;
}

/**
 * True when a parsed record belongs to the parent history a rollout inherited.
 * A subagent's boundary ordinal itself is its first own record and only numeric
 * fields are consulted, so scrubbing cannot change the outcome. A copied fork
 * is classified by `position`, the record's native source ordinal, and ignores
 * the record's own ordinal.
 */
export function isInheritedSubagentRecord(
  record: unknown,
  boundary: CodexInheritedBoundary | undefined,
  position: number,
): boolean {
  if (boundary === undefined) return false;
  if (boundary.kind === "ordinal") return isInheritedByOrdinal(record, boundary);
  return boundary.pending === true || position < boundary.startRecord;
}

export interface CodexParseOptions {
  /** Drop the parent history a forked subagent inherited. */
  readonly excludeInheritedSubagentHistory?: boolean;
}

/** The user or assistant message a response_item line carries, if any. */
function codexMessageOf(obj: CodexLine): ParsedMessage | undefined {
  const payload = obj.payload as CodexResponseItemPayload | undefined;
  if (!payload || payload.type !== "message") return undefined;

  const role = payload.role;
  if (!role || !["user", "assistant"].includes(role)) return undefined;

  const content = extractCodexText(payload.content);
  if (!content.trim()) return undefined;

  return { role, content, tokenCount: estimateTokens(content) };
}

/**
 * The messages a copied fork wrote itself. Lines are counted as the native
 * reader counts them, and a line that is not a record contributes nothing
 * instead of failing the walk.
 */
export function parseCodexCopiedForkMessages(
  raw: string,
  boundary: Extract<CodexInheritedBoundary, { kind: "copied-fork" }>,
): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const { position, line, oversized } of nativeSourceLines(raw)) {
    if (isInheritedSubagentRecord(undefined, boundary, position)) continue;
    const obj = parseNativeSourceLine(line, oversized);
    if (!isRecord(obj) || obj.type !== "response_item") continue;
    const message = codexMessageOf(obj);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/** Parse already-bound transcript bytes without reopening a pathname. */
export function parseCodexTranscriptText(raw: string, options: CodexParseOptions = {}): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const boundary = options.excludeInheritedSubagentHistory === true
    ? readCodexInheritedBoundary(raw)
    : undefined;
  if (boundary?.kind === "copied-fork") return parseCodexCopiedForkMessages(raw, boundary);

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
    if (boundary !== undefined && isInheritedByOrdinal(obj, boundary)) continue;

    const message = codexMessageOf(obj);
    if (message !== undefined) messages.push(message);
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
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
// LCM restoration proof
// ---------------------------------------------------------------------------

/** First line of every Codex SessionStart restoration LCM prints. */
export const LCM_RESTORATION_MARKER = "<!-- lcm-restoration -->";

const MAX_LIVE_RESTORATION_WINDOW_BYTES = 64 * 1024 * 1024;

/** True when the text, after leading whitespace, is the marker alone on its first line. */
function startsWithMarkerLine(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(LCM_RESTORATION_MARKER)) return false;
  const rest = trimmed.slice(LCM_RESTORATION_MARKER.length);
  return rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n");
}

/** Message text from block-array content; any other shape yields "". */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * Decide whether rollout text still holds an LCM restoration that is live in the
 * model context: a developer message starting with the restoration marker that
 * follows the last compaction and the last rollback. Compaction drops hook
 * context and rollback removes trailing turns, so either resets the proof. A
 * line that is not valid JSON may hide either record, so it resets it too.
 * Valid JSON of any other shape is inert: it never throws and never counts as
 * a marker.
 */
export function scanLiveCodexRestoration(raw: string, initialLive = false): boolean {
  let live = initialLive;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      live = false;
      continue;
    }
    if (!isRecord(obj)) continue;
    const payload = isRecord(obj.payload) ? obj.payload : {};
    if (obj.type === "compacted") {
      live = false;
    } else if (obj.type === "event_msg" && payload.type === "thread_rolled_back") {
      live = false;
    } else if (
      obj.type === "response_item"
      && payload.type === "message"
      && payload.role === "developer"
      && startsWithMarkerLine(messageText(payload.content))
    ) {
      live = true;
    }
  }
  return live;
}

function isUnder(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`);
}

function isCodexRolloutPath(real: string, codexHome: string): boolean {
  return ["sessions", "archived_sessions"].some((name) => {
    try {
      return isUnder(realpathSync(join(codexHome, name)), real);
    } catch {
      return false;
    }
  });
}

/** A rollout file opened through the safety checks of readLiveCodexRestoration. */
interface OpenRollout {
  readonly fd: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Open a rollout once (a symlink leaf fails to open), then require the
 * descriptor to be a regular file whose identity matches the path's realpath
 * under CODEX_HOME sessions or archived_sessions. The caller closes the
 * descriptor of a returned file; any failure closes it here.
 */
function openRollout(path: string, codexHome: string): OpenRollout | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const real = stat.isFile() ? realpathSync(path) : undefined;
    if (real !== undefined && isCodexRolloutPath(real, codexHome)) {
      const current = statSync(real);
      if (current.dev === stat.dev && current.ino === stat.ino) {
        return { fd, size: stat.size, dev: stat.dev, ino: stat.ino };
      }
    }
  } catch {
    // Fall through to close the descriptor and report no file.
  }
  if (fd !== undefined) closeSync(fd);
  return undefined;
}

/**
 * Most rollout files one referenced history may span, the fork included. A
 * longer chain is cut at its oldest reachable file and the rest is unknown.
 */
const MAX_REFERENCED_HISTORY_FILES = 4;

/** Directory entries one lookup may visit across all ancestors of a fork. */
const MAX_ROLLOUT_DIRECTORY_ENTRIES = 20_000;

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_ID = new RegExp(`^${UUID_SOURCE}$`, "iu");
/** Canonical Codex rollout basename: rollout-<timestamp>-<thread-id>[_<rollout-id>].jsonl */
const ROLLOUT_FILE_NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID_SOURCE})(?:_(${UUID_SOURCE}))?\\.jsonl$`,
  "iu",
);
/** Directory names of the sessions/YYYY/MM/DD layout, by depth below the root. */
const ROLLOUT_DATE_DIRECTORIES = [/^\d{4}$/u, /^\d{2}$/u, /^\d{2}$/u];

/** What a fork's session_meta says about the history it references. */
type HistoryBaseRead =
  | { readonly kind: "none" }
  | { readonly kind: "headless" }
  | { readonly kind: "invalid" }
  | {
    readonly kind: "base";
    readonly rolloutId: string;
    readonly endOrdinal: number;
    readonly endByte: number;
  };

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read session_meta.history_base from the bounded head of an open rollout. The
 * first line must be complete inside the bound. A base is valid only with a
 * UUID rollout id and positive safe integer cutoffs (Codex never writes an
 * ordinal of 0 because the prefix always holds the parent's session_meta).
 */
function readHistoryBase(file: OpenRollout): HistoryBaseRead {
  const length = Math.min(file.size, MAX_CODEX_SESSION_META_PREFIX_BYTES);
  const buffer = Buffer.alloc(length);
  const read = readSync(file.fd, buffer, 0, length, 0);
  const meta = firstSessionMetaPayload(buffer.subarray(0, read).toString("utf8"));
  if (meta === undefined) return { kind: "headless" };
  const base = meta.history_base;
  if (base === undefined || base === null) return { kind: "none" };
  if (!isRecord(base)) return { kind: "invalid" };
  const { thread_id: rolloutId, end_ordinal_exclusive: endOrdinal, end_byte_offset: endByte } = base;
  if (
    typeof rolloutId !== "string" || !ROLLOUT_ID.test(rolloutId)
    || !isPositiveSafeInteger(endOrdinal) || !isPositiveSafeInteger(endByte)
  ) return { kind: "invalid" };
  return { kind: "base", rolloutId: rolloutId.toLowerCase(), endOrdinal, endByte };
}

/** The rollout id a canonical rollout basename carries, lower-cased. */
function rolloutIdOfFileName(name: string): string | undefined {
  const match = ROLLOUT_FILE_NAME.exec(name);
  if (match === null) return undefined;
  const [, threadId = "", rolloutId = threadId] = match;
  return rolloutId.toLowerCase();
}

interface RolloutSearch {
  remaining: number;
  exhausted: boolean;
  readonly matches: string[];
}

/**
 * Collect plain rollout files named for one rollout id below a root, walking
 * only the root and its YYYY/MM/DD directories and never following symlinks.
 * Entries are counted as they are read, and the walk stops once a second match
 * proves ambiguity, the entry budget is spent or a directory cannot be read.
 */
function searchRolloutDirectory(directory: string, level: number, rolloutId: string, search: RolloutSearch): void {
  let handle: Dir | undefined;
  try {
    handle = opendirSync(directory);
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (search.matches.length > 1 || search.exhausted) return;
      if (search.remaining === 0) {
        search.exhausted = true;
        return;
      }
      search.remaining -= 1;
      if (entry.isDirectory()) {
        if (ROLLOUT_DATE_DIRECTORIES[level]?.test(entry.name)) {
          searchRolloutDirectory(join(directory, entry.name), level + 1, rolloutId, search);
        }
      } else if (entry.isFile() && rolloutIdOfFileName(entry.name) === rolloutId) {
        search.matches.push(join(directory, entry.name));
      }
    }
  } catch {
    search.exhausted = true;
  } finally {
    handle?.closeSync();
  }
}

/**
 * Find the one plain rollout file for a rollout id under sessions/ and
 * archived_sessions/. The id is only compared with parsed basenames and never
 * joined into a path. No match, several matches or an exhausted entry budget
 * give no path. Compressed rollouts are not read.
 */
function locateRollout(codexHome: string, rolloutId: string, budget: { remaining: number }): string | undefined {
  const search: RolloutSearch = { remaining: budget.remaining, exhausted: false, matches: [] };
  for (const root of ["sessions", "archived_sessions"]) {
    const directory = join(codexHome, root);
    if (existsSync(directory)) searchRolloutDirectory(directory, 0, rolloutId, search);
  }
  budget.remaining = search.remaining;
  return search.matches.length === 1 && !search.exhausted ? search.matches[0] : undefined;
}

/** One contiguous range of the effective history, read from one rollout file. */
interface HistorySegment {
  readonly file: OpenRollout;
  /** The range is bytes [start, endByte) of the file. */
  readonly start: number;
  readonly endByte: number;
}

const CUTOFF_CHUNK_BYTES = 64 * 1024;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * The top-level ordinal of the last non-blank line that ends at or before
 * endByte, or undefined when that line is not a JSON object with a safe
 * ordinal or is longer than a native record may be. The bytes before endByte
 * need not end with a newline: a cutoff in the middle of a record leaves an
 * incomplete line, which does not parse.
 */
function readCutoffOrdinal(file: OpenRollout, endByte: number): number | undefined {
  let tail = Buffer.alloc(0);
  let position = endByte;
  for (;;) {
    let end = tail.length;
    while (end > 0 && isJsonWhitespace(tail[end - 1] as number)) end -= 1;
    const lineStart = end === 0 ? -1 : tail.lastIndexOf(0x0a, end - 1);
    if (lineStart !== -1 || position === 0) {
      if (end === 0) return undefined;
      try {
        const record: unknown = JSON.parse(tail.subarray(lineStart + 1, end).toString("utf8"));
        return isRecord(record) && isCodexOrdinal(record.ordinal) ? record.ordinal : undefined;
      } catch {
        return undefined;
      }
    }
    if (tail.length > NATIVE_RECORD_BYTE_LIMIT) return undefined;
    const length = Math.min(CUTOFF_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    readSync(file.fd, chunk, 0, length, position);
    tail = Buffer.concat([chunk, tail]);
  }
}

/**
 * The ranges of a rollout's effective history, oldest first and ending with
 * the rollout itself. The walk goes backward from the rollout and gives the
 * byte budget to the newest history first, so the ranges form one contiguous
 * newest suffix; the oldest range may start part way through its file.
 *
 * Every ancestor link must hold: the parent is located uniquely and opened
 * safely, is not a repeat, is at least as long as the cutoff, has a
 * session_meta, and its last record before end_byte_offset carries the ordinal
 * just before end_ordinal_exclusive. The first link that fails (or the byte
 * budget running out) stops the walk. The history older than the ranges
 * already kept is unexamined, and the scan enters their oldest range with no
 * proof.
 */
function resolveHistorySegments(
  own: OpenRollout,
  codexHome: string,
  maxBytes: number,
  maxDirectoryEntries: number,
  owned: OpenRollout[],
): HistorySegment[] {
  const segments: HistorySegment[] = [];
  let remaining = maxBytes;
  const keep = (file: OpenRollout, endByte: number): void => {
    const take = Math.min(endByte, remaining);
    segments.unshift({ file, start: endByte - take, endByte });
    remaining -= take;
  };
  keep(own, own.size);
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>([`${own.dev}:${own.ino}`]);
  const budget = { remaining: maxDirectoryEntries };
  let read = readHistoryBase(own);
  while (
    read.kind === "base" && remaining > 0
    && segments.length < MAX_REFERENCED_HISTORY_FILES && !seenIds.has(read.rolloutId)
  ) {
    const { rolloutId, endOrdinal, endByte } = read;
    seenIds.add(rolloutId);
    const path = locateRollout(codexHome, rolloutId, budget);
    const parent = path === undefined ? undefined : openRollout(path, codexHome);
    if (parent === undefined) break;
    owned.push(parent);
    const key = `${parent.dev}:${parent.ino}`;
    const parentRead = readHistoryBase(parent);
    if (
      seenFiles.has(key) || endByte > parent.size || parentRead.kind === "headless"
      || readCutoffOrdinal(parent, endByte) !== endOrdinal - 1
    ) break;
    seenFiles.add(key);
    keep(parent, endByte);
    read = parentRead;
  }
  return segments;
}

/** Scan the segments oldest to newest, carrying the live state between them. */
function scanHistorySegments(segments: readonly HistorySegment[]): boolean {
  let live = false;
  for (const segment of segments) {
    const length = segment.endByte - segment.start;
    const buffer = Buffer.alloc(length);
    const read = readSync(segment.file.fd, buffer, 0, length, segment.start);
    let raw = buffer.subarray(0, read).toString("utf8");
    if (segment.start > 0) {
      const newline = raw.indexOf("\n");
      raw = newline === -1 ? "" : raw.slice(newline + 1);
    }
    live = scanLiveCodexRestoration(raw, live);
  }
  return live;
}

/**
 * Prove from a session's rollout that a live LCM restoration exists. Opens the
 * given path once (a symlink leaf fails to open), then requires the descriptor
 * to be a regular file whose identity matches the path's realpath under
 * CODEX_HOME (default ~/.codex) sessions or archived_sessions.
 *
 * A referenced (paginated-history) fork holds only a pointer to its parent's
 * history in session_meta.history_base: the parent rollout's bytes before
 * end_byte_offset are part of the fork's history. The parent is found by
 * rollout id among the canonical rollout basenames and read with the same
 * safety checks, then its parent in turn, up to four files. The effective
 * history is the ancestors' prefixes followed by the fork's own records.
 *
 * At most the newest 64 MiB of the effective history is read; when that cuts
 * the history short, the scan starts with no proof at the first complete
 * record. The first ancestor that cannot be found, is ambiguous, is compressed
 * or disagrees with its recorded cutoff ends the walk: the history older than
 * the ranges already validated is a gap, and only a marker inside those ranges
 * can prove. Any other failure or mismatch yields false.
 */
export function readLiveCodexRestoration(
  transcriptPath: unknown,
  options: { codexHome?: string; maxBytes?: number; maxDirectoryEntries?: number } = {},
): boolean {
  if (typeof transcriptPath !== "string" || !transcriptPath) return false;
  const codexHome = options.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  const maxBytes = options.maxBytes ?? MAX_LIVE_RESTORATION_WINDOW_BYTES;
  const maxDirectoryEntries = options.maxDirectoryEntries ?? MAX_ROLLOUT_DIRECTORY_ENTRIES;
  const owned: OpenRollout[] = [];
  try {
    const own = openRollout(transcriptPath, codexHome);
    if (own === undefined) return false;
    owned.push(own);
    return scanHistorySegments(resolveHistorySegments(own, codexHome, maxBytes, maxDirectoryEntries, owned));
  } catch {
    return false;
  } finally {
    for (const file of owned) closeSync(file.fd);
  }
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
