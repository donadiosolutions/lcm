import { admittedProjectIdentity } from "./storage-lifecycle.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
  CODEX_NATIVE_TRANSCRIPT_FORMAT,
  createExactNativeTranscriptMessageResolver,
  createFileNativeTranscriptSource,
  inheritedNativeSourceOrdinals,
  runNativeTranscriptBackfill,
  NativeTranscriptSourceChangedError,
  type NativeTranscriptSourceSnapshot,
} from "../../storage/native-transcript-ingest.js";
import { openLocalTranscriptQuarantine } from "../../storage/local-transcript-quarantine.js";
import type { DaemonConfig } from "../config.js";
import {
  MAX_PROJECT_METADATA_BYTES,
  projectPathsForIdentity,
  ensureProjectDirForIdentity,
  isSafeTranscriptPath,
} from "../project.js";
import {
  atomicWritePrivateFile,
  openPrivateDirectory,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
} from "../../security-files.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { ParsedMessage } from "../../transcript.js";
import { normalizeTranscriptClient, parseTranscriptTextForClient, type TranscriptClient } from "../../transcript-provider.js";
import {
  parseCodexCopiedForkMessages,
  parseCodexTranscriptText,
  readCodexInheritedBoundary,
  readCodexSessionParent,
  type CodexInheritedBoundary,
} from "../../codex-transcript.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { ProjectStorage, StorageBackendFactory, TransactionRepositories } from "../../storage/index.js";
import { encodeTranscriptSlotMarker, type NativeTranscriptProvenanceRepository } from "../../storage/contracts.js";
import { createCommitCloseBarrier, storageRouteFailureResponse, withProjectStorage } from "./storage-lifecycle.js";
import { isAbortError, throwIfAborted } from "../cancellation.js";
import { BackendPublicationJournalError } from "../../storage/backend-publication.js";

/** Which parse of a forked Codex subagent's rollout the stored conversation follows. */
type SubagentHistory = "filtered" | "unfiltered" | "mismatch";

/**
 * Pick which parse of a forked Codex subagent's rollout the stored conversation
 * follows: the first of [filtered, unfiltered] of which the already-stored
 * (scrubbed) messages are an exact prefix. Because the stored rows are always a
 * prefix of the chosen list, appending its remaining items and numbering native
 * links by its order stay consistent from one snapshot to the next.
 *
 * When both lists extend the stored rows and differ, text alone cannot tell
 * whether the rows came from the inherited-history reading, so native links
 * that already exist decide: a stored link on a record the current bytes
 * classify as inherited means the conversation follows the unfiltered list.
 */
async function chooseSubagentHistory(
  stored: readonly { readonly role: string; readonly content: string }[],
  filtered: readonly ParsedMessage[],
  unfiltered: readonly ParsedMessage[],
  scrubber: ScrubEngine | undefined,
  hasLinkedInheritedRecord: () => Promise<boolean>,
): Promise<SubagentHistory> {
  const extendsStored = (messages: readonly ParsedMessage[]): boolean =>
    storedIsPrefix(stored, messages, scrubber!);
  const unfilteredExtends = extendsStored(unfiltered);
  if (!extendsStored(filtered)) return unfilteredExtends ? "unfiltered" : "mismatch";
  return stored.length > 0 && unfilteredExtends && filtered.length !== unfiltered.length
    && await hasLinkedInheritedRecord()
    ? "unfiltered"
    : "filtered";
}

/** True when the stored (scrubbed) rows are an exact prefix of the messages, scrubbed the same way. */
function storedIsPrefix(
  stored: readonly { readonly role: string; readonly content: string }[],
  messages: readonly ParsedMessage[],
  scrubber: ScrubEngine,
): boolean {
  return stored.length <= messages.length && stored.every((row, index) => (
    row.role === messages[index]!.role && row.content === scrubber.scrub(messages[index]!.content)
  ));
}

function isParsedMessage(value: unknown): value is ParsedMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  return (
    typeof message.role === "string" &&
    ["user", "assistant", "system", "tool"].includes(message.role) &&
    typeof message.content === "string" &&
    typeof message.tokenCount === "number"
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Store the part of a session's cumulative transcript list that is not stored
 * yet, inside the caller's transaction.
 *
 * The list holds transcript messages only, so its coordinate is session-wide:
 * stored transcript rows plus the compaction events that took one list index
 * (consumed slot markers). Events written before markers existed are adopted
 * here with the legacy rule, consumed when a transcript row follows them in
 * session order, and never re-evaluated. New rows go to the newest
 * conversation.
 *
 * getOrCreateConversation runs first on the transaction's repositories: on
 * PostgreSQL its advisory transaction lock serializes every writer of the
 * session until commit, and SQLite's immediate transaction does the same.
 */
export async function prepareSessionTranscript(
  conversations: TransactionRepositories["conversations"],
  sessionId: string,
): Promise<{
  conversation: Awaited<ReturnType<TransactionRepositories["conversations"]["getOrCreateConversation"]>>;
  transcriptCount: number;
  consumedCount: number;
  eventMessageIds: ReadonlySet<number>;
}> {
  const conversation = await conversations.getOrCreateConversation(sessionId);
  const snapshot = await conversations.getTranscriptSlotSnapshot(sessionId);
  let consumedCount = 0;
  for (const event of snapshot.events) {
    const markers = new Set(event.slotMarkers);
    if (markers.size > 1) throw new Error("conflicting transcript slot markers");
    const consumed = markers.size === 1 ? markers.has(true) : event.followedByTranscript;
    if (markers.size === 0) {
      await conversations.createMessageParts(event.messageId, [{
        sessionId,
        partType: "snapshot",
        ordinal: event.nextOrdinal,
        metadata: encodeTranscriptSlotMarker(consumed),
      }]);
    }
    if (consumed) consumedCount += 1;
  }
  return {
    conversation,
    transcriptCount: snapshot.transcriptCount,
    consumedCount,
    eventMessageIds: new Set(snapshot.events.map((event) => event.messageId)),
  };
}

/** Scrub and append transcript messages to a conversation inside the caller's transaction. */
async function appendTranscriptMessages(
  repositories: Pick<TransactionRepositories, "conversations" | "redactionAdmin" | "context">,
  conversationId: number,
  newMessages: readonly ParsedMessage[],
  scrubber: ScrubEngine,
): Promise<{
  conversationId: number;
  records: Awaited<ReturnType<TransactionRepositories["conversations"]["appendMessages"]>>;
  totalCounts: { gitleaks: number; builtIn: number; global: number; project: number };
} | null> {
  if (newMessages.length === 0) return null;
  const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
  const inputs = newMessages.map((m) => {
    const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project: projectCount } = scrubber.scrubWithCounts(m.content);
    totalCounts.gitleaks += gitleaks;
    totalCounts.builtIn += builtIn;
    totalCounts.global += globalCount;
    totalCounts.project += projectCount;
    return {
      role: m.role as "user" | "assistant" | "system" | "tool",
      content: scrubbedContent,
      tokenCount: m.tokenCount,
    };
  });
  const records = await repositories.conversations.appendMessages(conversationId, inputs);
  await repositories.redactionAdmin.upsertCounts(totalCounts);
  await repositories.context.appendContextMessages(
    conversationId,
    records.map((record) => record.messageId),
  );
  return { conversationId, records, totalCounts };
}

export async function appendSessionTranscript(
  repositories: Pick<TransactionRepositories, "conversations" | "redactionAdmin" | "context">,
  sessionId: string,
  parsed: readonly ParsedMessage[],
  scrubber: ScrubEngine,
) {
  const slot = await prepareSessionTranscript(repositories.conversations, sessionId);
  return appendTranscriptMessages(
    repositories,
    slot.conversation.conversationId,
    parsed.slice(slot.transcriptCount + slot.consumedCount),
    scrubber,
  );
}

/** Metadata key of the session-scoped lineage marker on a Codex session's first transcript row. */
export const CODEX_LINEAGE_METADATA_KEY = "lcmCodexLineage";

/**
 * Which reading of a Codex session its stored rows follow: "boundary" holds
 * only the messages a copied fork wrote itself, "array" holds whatever message
 * lists clients sent.
 */
export type CodexLineageMode = "boundary" | "array";

export function encodeCodexLineageMarker(mode: CodexLineageMode): string {
  return JSON.stringify({ [CODEX_LINEAGE_METADATA_KEY]: { version: 1, mode } });
}

/**
 * Read a lineage marker from part metadata: null when the metadata is not a
 * marker at all, "malformed" when it carries the marker key with an unknown
 * shape.
 */
export function parseCodexLineageMarker(metadata: string | null): CodexLineageMode | "malformed" | null {
  if (metadata === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!(CODEX_LINEAGE_METADATA_KEY in parsed)) return null;
  const marker: unknown = (parsed as Record<string, unknown>)[CODEX_LINEAGE_METADATA_KEY];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return "malformed";
  const { version, mode } = marker as Record<string, unknown>;
  return version === 1 && (mode === "boundary" || mode === "array") ? mode : "malformed";
}

/** The marker on a stored row: its mode, null for none, "invalid" for a malformed or contradictory one. */
async function readCodexLineageMarker(
  conversations: TransactionRepositories["conversations"],
  messageId: number,
): Promise<CodexLineageMode | "invalid" | null> {
  const modes = new Set<CodexLineageMode>();
  for (const part of await conversations.getMessageParts(messageId)) {
    const mode = parseCodexLineageMarker(part.metadata);
    if (mode === "malformed") return "invalid";
    if (mode !== null) modes.add(mode);
  }
  if (modes.size > 1) return "invalid";
  return modes.values().next().value ?? null;
}

/**
 * The first transcript row of a session across all its conversations, which is
 * where its lineage marker lives; undefined when none can be found.
 */
async function firstSessionTranscriptRow(
  conversations: TransactionRepositories["conversations"],
  sessionId: string,
  newestConversationId: number,
  eventMessageIds: ReadonlySet<number>,
) {
  // An event row can take at most the first few places of a conversation.
  const firstOf = async (conversationId: number) => (await conversations.getMessages(
    conversationId,
    { limit: eventMessageIds.size + 1 },
  )).find((message) => !eventMessageIds.has(message.messageId));
  if (
    await conversations.getMessageCount(newestConversationId)
      === await conversations.getMessageCountBySessionId(sessionId)
  ) {
    return firstOf(newestConversationId);
  }
  // The session is split: listConversations is already in session order.
  for (const conversation of await conversations.listConversations()) {
    if (conversation.sessionId !== sessionId) continue;
    const first = await firstOf(conversation.conversationId);
    if (first !== undefined) return first;
  }
  return undefined;
}

/** What one Codex ingest or compact presents to the lineage decision. */
export interface CodexLineageRequest {
  /** A message list from the request body, or a rollout file. */
  readonly source: "array" | "file";
  /** Every message of the rollout or list as sent. */
  readonly full: readonly ParsedMessage[];
  /**
   * Set only when the rollout is a copied fork (empty while it has not written
   * its own settings event): the messages after that event.
   */
  readonly child?: readonly ParsedMessage[];
}

/**
 * The whole rollout of a copied fork, read like the child's list so a line that
 * is not a record never fails the parent's part of it either.
 */
const WHOLE_COPIED_FORK = { kind: "copied-fork", startRecord: 0 } as const;

/** Read a Codex rollout's text into the request its lineage is decided from. */
export function codexLineageRequestFromText(raw: string): CodexLineageRequest {
  const boundary = readCodexInheritedBoundary(raw);
  return boundary?.kind === "copied-fork"
    ? {
      source: "file",
      full: parseCodexCopiedForkMessages(raw, WHOLE_COPIED_FORK),
      child: parseCodexCopiedForkMessages(raw, boundary),
    }
    : { source: "file", full: parseCodexTranscriptText(raw) };
}

/** "lineage-mismatch" leaves the session as it is: nothing is appended and nothing is linked. */
export type CodexLineageHistory = "filtered" | "unfiltered" | "lineage-mismatch" | undefined;

/**
 * Store the part of a Codex session's transcript that is not stored yet,
 * inside the caller's transaction, following the reading its first rows chose.
 *
 * A session whose first rows come from a copied fork's own messages ("boundary"
 * marker) or from a message list ("array" marker) stays on that reading. Rows
 * stored without a marker are the legacy full reading and keep following it.
 * The marker is written once, with the session's first transcript rows, never
 * inferred from native links or content, and is read from the session's first
 * row across all its conversations. Whatever contradicts the stored reading, or
 * a marker that cannot be read or found, is a mismatch.
 */
export async function persistCodexLineage(
  repositories: Pick<TransactionRepositories, "conversations" | "redactionAdmin" | "context">,
  sessionId: string,
  request: CodexLineageRequest,
  scrubber: ScrubEngine | undefined,
  linkParent: (conversation: { conversationId: number; parentSessionId: string | null } | null) => Promise<void>,
): Promise<{
  persisted: Awaited<ReturnType<typeof appendTranscriptMessages>>;
  history: CodexLineageHistory;
}> {
  const { source, full, child } = request;
  const conversations = repositories.conversations;
  if (full.length === 0) {
    // Nothing can be appended, so no conversation is created just to inspect it.
    const conversation = await conversations.getConversationBySessionId(sessionId);
    await linkParent(conversation);
    const snapshot = conversation === null ? null : await conversations.getTranscriptSlotSnapshot(sessionId);
    const stored = snapshot?.transcriptCount ?? 0;
    if (child !== undefined) return { persisted: null, history: stored === 0 ? "filtered" : "lineage-mismatch" };
    if (stored === 0) return { persisted: null, history: undefined };
    // A file that is not a copied fork must not follow a session whose rows
    // are a copied fork's own messages, and an unreadable marker stops it too.
    const first = await firstSessionTranscriptRow(
      conversations,
      sessionId,
      conversation!.conversationId,
      new Set(snapshot!.events.map((event) => event.messageId)),
    );
    const marker = first === undefined ? "invalid" : await readCodexLineageMarker(conversations, first.messageId);
    return {
      persisted: null,
      history: marker === "invalid" || marker === "boundary" ? "lineage-mismatch" : undefined,
    };
  }

  const slot = await prepareSessionTranscript(conversations, sessionId);
  await linkParent(slot.conversation);
  const conversationId = slot.conversation.conversationId;
  const append = async (list: readonly ParsedMessage[], from: number, mode: CodexLineageMode | undefined) => {
    const persisted = await appendTranscriptMessages(repositories, conversationId, list.slice(from), scrubber!);
    if (persisted !== null && mode !== undefined) {
      await conversations.createMessageParts(persisted.records[0]!.messageId, [{
        sessionId,
        partType: "snapshot",
        ordinal: 0,
        metadata: encodeCodexLineageMarker(mode),
      }]);
    }
    return persisted;
  };
  const mismatch = { persisted: null, history: "lineage-mismatch" } as const;
  const next = slot.transcriptCount + slot.consumedCount;

  if (slot.transcriptCount === 0) {
    // The first rows choose the reading, and only they carry the marker.
    if (child !== undefined) return { persisted: await append(child, 0, "boundary"), history: "filtered" };
    return { persisted: await append(full, next, source === "array" ? "array" : undefined), history: undefined };
  }

  if (child === undefined) {
    // The marker is on the session's first transcript row, wherever the
    // session's conversations put it; without that row nothing is appended.
    const first = await firstSessionTranscriptRow(
      conversations,
      sessionId,
      conversationId,
      slot.eventMessageIds,
    );
    const marker = first === undefined ? "invalid" : await readCodexLineageMarker(conversations, first.messageId);
    return marker === "invalid" || marker === "boundary"
      ? mismatch
      : { persisted: await append(full, next, undefined), history: undefined };
  }
  // A copied fork compares every stored row. A session split across
  // conversations means the newest conversation's rows are not the
  // session-wide prefix: leave it.
  const rows = (await conversations.getMessages(conversationId))
    .filter((message) => !slot.eventMessageIds.has(message.messageId));
  if (rows.length !== slot.transcriptCount) return mismatch;
  const marker = await readCodexLineageMarker(conversations, rows[0]!.messageId);
  if (marker === "invalid" || marker === "array") return mismatch;
  if (marker === "boundary") {
    return slot.consumedCount > 0 || !storedIsPrefix(rows, child, scrubber!)
      ? mismatch
      : { persisted: await append(child, slot.transcriptCount, undefined), history: "filtered" };
  }
  // Rows stored without a marker are the legacy full reading and stay on it,
  // unless an event took a position: then a count cannot show that the full
  // reading still continues them.
  return slot.consumedCount > 0 || !storedIsPrefix(rows, full, scrubber!)
    ? mismatch
    : { persisted: await append(full, next, undefined), history: "unfiltered" };
}

function resolveMessages(input: { client?: unknown; messages?: unknown; provider?: unknown; transcript_path?: string }, cwd: string): { messages: ParsedMessage[]; nativePath?: string; client?: TranscriptClient } {
  if (Array.isArray(input.messages)) {
    return { messages: input.messages.filter(isParsedMessage) };
  }

  if (input.transcript_path) {
    const safePath = isSafeTranscriptPath(input.transcript_path, cwd);
    if (safePath && existsSync(safePath)) {
      const client = normalizeTranscriptClient(input.client ?? input.provider);
      return { messages: [], nativePath: safePath, client };
    }
  }

  return { messages: [] };
}

export function createIngestHandler(config: DaemonConfig, storageFactory?: StorageBackendFactory): RouteHandler {
  return async (_req, res, body, context) => {
    const input = JSON.parse(body || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendJson(res, 400, { error: "invalid request body" });
      return;
    }
    const { session_id } = input;

    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    try {
      throwIfAborted(context?.signal);
      // Preserve the route's early identity/configuration rejection while the
      // lifecycle helper re-resolves the identity with its live admission token.
      const storageIdentity = await admittedProjectIdentity(
        cwd,
        config.storage,
        context,
      );
      const localIdentity = {
        id: storageIdentity.localProjectId,
        canonical: storageIdentity.canonical,
        ...(storageIdentity.remoteProjectId === undefined
          ? {}
          : { remoteProjectId: storageIdentity.remoteProjectId }),
      };
      const paths = projectPathsForIdentity(localIdentity);
      const resolved = resolveMessages(input, cwd);
      const resolvedMessages = resolved.messages;
      const importNative = resolved.nativePath;
      if (config.storage.backend === "sqlite" && resolvedMessages.length === 0 && importNative === undefined) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }
      const createScrubber = (messages: ParsedMessage[]) => messages.length > 0
        ? (async () => {
            ensureProjectDirForIdentity(localIdentity);
            return ScrubEngine.forProject(
              config.security?.sensitivePatterns ?? [],
              paths.dir,
            );
          })()
        : undefined;

      const signal = context?.signal ?? new AbortController().signal;
      async function persist(
        project: ProjectStorage,
        messages: ParsedMessage[],
        scrubber: ScrubEngine | undefined,
        filteredMessages: ParsedMessage[] | undefined,
        hasLinkedInheritedRecord: (provenance: NativeTranscriptProvenanceRepository) => Promise<boolean>,
        parentSessionId: string | undefined,
        lineage: Pick<CodexLineageRequest, "source" | "child"> | undefined,
      ) {
        const resolvedMessages = messages;
        return await project.transaction(async (repositories) => {
          // Keep-first parent linkage runs on every attempt, before any early
          // return, and never creates a conversation of its own.
          const linkParent = async (conversation: { conversationId: number; parentSessionId: string | null } | null) => {
            if (parentSessionId === undefined || conversation === null || conversation.parentSessionId !== null) return;
            await repositories.conversations.setParentSessionIdIfNull(conversation.conversationId, parentSessionId);
          };
          if (resolvedMessages.length === 0 && filteredMessages === undefined && lineage === undefined) {
            return { persisted: null, history: undefined };
          }

          if (lineage !== undefined) {
            return await persistCodexLineage(
              repositories,
              session_id,
              { source: lineage.source, full: resolvedMessages, ...(lineage.child === undefined ? {} : { child: lineage.child }) },
              scrubber,
              linkParent,
            );
          }

          if (filteredMessages === undefined) {
            // The session-wide slot index and the session lock come first.
            const slot = await prepareSessionTranscript(repositories.conversations, session_id);
            await linkParent(slot.conversation);
            const persisted = await appendTranscriptMessages(
              repositories,
              slot.conversation.conversationId,
              resolvedMessages.slice(slot.transcriptCount + slot.consumedCount),
              scrubber!,
            );
            return { persisted, history: undefined };
          }

          const chooseHistory = (stored: readonly { readonly role: string; readonly content: string }[]) =>
            chooseSubagentHistory(
              stored,
              filteredMessages,
              resolvedMessages,
              scrubber,
              async () => repositories.nativeProvenance !== undefined
                && await hasLinkedInheritedRecord(repositories.nativeProvenance),
            );
          if (resolvedMessages.length === 0) {
            // Nothing can be appended without messages, so no conversation is
            // created just to inspect an empty subagent.
            const conversation = await repositories.conversations.getConversationBySessionId(session_id);
            await linkParent(conversation);
            let stored: Awaited<ReturnType<typeof repositories.conversations.getMessages>> = [];
            if (conversation !== null) {
              const snapshot = await repositories.conversations.getTranscriptSlotSnapshot(session_id);
              const eventMessageIds = new Set(snapshot.events.map((event) => event.messageId));
              stored = (await repositories.conversations.getMessages(conversation.conversationId))
                .filter((message) => !eventMessageIds.has(message.messageId));
            }
            return { persisted: null, history: await chooseHistory(stored) };
          }

          const slot = await prepareSessionTranscript(repositories.conversations, session_id);
          await linkParent(slot.conversation);
          const stored = (await repositories.conversations.getMessages(slot.conversation.conversationId))
            .filter((message) => !slot.eventMessageIds.has(message.messageId));
          // A consumed slot or a session split across conversations means the
          // newest conversation's rows are not the session-wide prefix: leave it.
          const history: SubagentHistory = slot.consumedCount > 0 || stored.length !== slot.transcriptCount
            ? "mismatch"
            : await chooseHistory(stored);
          if (history === "mismatch") return { persisted: null, history };
          const chosen = history === "filtered" ? filteredMessages : resolvedMessages;
          const persisted = await appendTranscriptMessages(
            repositories,
            slot.conversation.conversationId,
            chosen.slice(slot.transcriptCount),
            scrubber!,
          );
          return { persisted, history };
        });
      }
      type PersistedIngest = NonNullable<Awaited<ReturnType<typeof persist>>["persisted"]>;
      let accumulated: PersistedIngest | null = null;
      let ingest: (PersistedIngest & { totalTokens: number }) | null = null;
      let sourceWitness: { byteLength: number; sha256: string } | undefined;
      let retryFailure: NativeTranscriptSourceChangedError | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(signal);
        let parentSessionId: string | undefined;
        let snapshot: NativeTranscriptSourceSnapshot | undefined;
        let closeSnapshot: (() => Promise<void>) | undefined;
        let sourceClosed = false;
        let attemptFailed = false;
        let retryableFailure: NativeTranscriptSourceChangedError | undefined;
        const closeSource = async () => {
          if (sourceClosed) return;
          sourceClosed = true;
          try { await closeSnapshot?.(); } catch (error) {
            if (retryableFailure !== undefined) {
              throw new AggregateError([retryableFailure, error], "Native ingest source cleanup failed", { cause: retryableFailure });
            }
            if (!attemptFailed) throw error;
          }
        };
        try {
          let messages = resolvedMessages;
          let inheritedBoundary: CodexInheritedBoundary | undefined;
          let filteredMessages: ParsedMessage[] | undefined;
          // Only Codex message lists and rollouts have a lineage; a subagent's
          // own ordinal boundary keeps the filtered/unfiltered choice instead.
          let lineage: Pick<CodexLineageRequest, "source" | "child"> | undefined = importNative === undefined
            && normalizeTranscriptClient(input.client ?? input.provider) === "codex"
            ? { source: "array" }
            : undefined;
          let rolloutBytes: Buffer | undefined;
          if (importNative !== undefined) {
            snapshot = await createFileNativeTranscriptSource(dirname(importNative), basename(importNative)).openSnapshot();
            closeSnapshot = snapshot.close.bind(snapshot);
            // The route owns cleanup, including failures before backfill.
            const bound = snapshot;
            snapshot = {
              metadata: bound.metadata,
              stream: bound.stream.bind(bound),
              digestPrefix: bound.digestPrefix.bind(bound),
              assertUnchanged: bound.assertUnchanged.bind(bound),
              assertByteRangesUnchanged: bound.assertByteRangesUnchanged.bind(bound),
              close: async () => undefined,
            };
            if (sourceWitness !== undefined && (
              snapshot.metadata.sizeBytes < sourceWitness.byteLength
              || await snapshot.digestPrefix(sourceWitness.byteLength) !== sourceWitness.sha256
            )) throw retryFailure;
            const chunks: Buffer[] = [];
            for await (const chunk of snapshot.stream()) chunks.push(Buffer.from(chunk));
            await snapshot.assertUnchanged();
            const bytes = Buffer.concat(chunks);
            rolloutBytes = bytes;
            sourceWitness = { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
            const raw = bytes.toString("utf8");
            // The boundary is read from the same bound bytes as the parse.
            inheritedBoundary = resolved.client === "codex" ? readCodexInheritedBoundary(raw) : undefined;
            messages = inheritedBoundary?.kind === "copied-fork"
              ? parseCodexCopiedForkMessages(raw, WHOLE_COPIED_FORK)
              : parseTranscriptTextForClient(raw, resolved.client!);
            if (resolved.client === "codex") {
              if (inheritedBoundary?.kind === "ordinal") {
                filteredMessages = parseTranscriptTextForClient(raw, "codex", { excludeInheritedSubagentHistory: true });
              } else {
                lineage = {
                  source: "file",
                  ...(inheritedBoundary === undefined
                    ? {}
                    : { child: parseCodexCopiedForkMessages(raw, inheritedBoundary) }),
                };
              }
              // The immediate parent comes from the same bound bytes; only the
              // rollout whose own id is the child key may name one.
              const meta = readCodexSessionParent(raw);
              if (
                meta !== undefined && meta.id === session_id && meta.parentThreadId !== ""
                && meta.parentThreadId !== session_id && !meta.parentThreadId.includes("\0")
              ) parentSessionId = meta.parentThreadId;
            }
          }
          throwIfAborted(signal);
          const scrubber = await createScrubber(messages);
          throwIfAborted(signal);
          const lifetime = createCommitCloseBarrier();
          ingest = await withProjectStorage(
            {
              config, cwd, factory: storageFactory, context, mode: "create",
              expectedIdentity: storageIdentity, beforeClose: lifetime.waitForZero,
            },
            async (project, signal) => {
              const permit = lifetime.acquire(() => ({ release: () => undefined }));
              try {
                throwIfAborted(signal);
                if (resolvedMessages.length === 0 && importNative === undefined) return null;
                if (importNative !== undefined && project.nativeTranscripts === undefined) {
                  throw new Error("native transcript storage unavailable");
                }
                await snapshot?.assertUnchanged();
                throwIfAborted(signal);
                const { persisted, history } = await persist(
                  project,
                  messages,
                  scrubber,
                  filteredMessages,
                  // Only a tie between the two readings asks this: does a
                  // committed native link already sit on inherited history?
                  async (provenance: NativeTranscriptProvenanceRepository) => {
                    const linked = await provenance.listLinkedSourceOrdinals({
                      machineId: project.nativeTranscripts!.machineId,
                      clientName: CODEX_NATIVE_TRANSCRIPT_FORMAT.clientName,
                      sourceLocator: createHash("sha256").update(importNative!).digest("hex"),
                      nativeSessionId: session_id,
                    });
                    if (linked.length === 0) return false;
                    const inherited = await inheritedNativeSourceOrdinals(rolloutBytes!, inheritedBoundary!);
                    return linked.some((ordinal) => inherited.has(ordinal));
                  },
                  parentSessionId,
                  lineage,
                );
                if (persisted) {
                  accumulated = accumulated === null ? persisted : {
                    conversationId: persisted.conversationId,
                    records: [...accumulated.records, ...persisted.records],
                    totalCounts: {
                      gitleaks: accumulated.totalCounts.gitleaks + persisted.totalCounts.gitleaks,
                      builtIn: accumulated.totalCounts.builtIn + persisted.totalCounts.builtIn,
                      global: accumulated.totalCounts.global + persisted.totalCounts.global,
                      project: accumulated.totalCounts.project + persisted.totalCounts.project,
                    },
                  };
                }
                throwIfAborted(signal);
                if (history === "mismatch" || history === "lineage-mismatch") {
                  // The stored rows follow a reading this transcript no longer
                  // offers, so appending or linking could misnumber the session.
                  // Leave it as is.
                  await safeLogError(
                    "ingest",
                    new Error(history === "mismatch"
                      ? "subagent transcript matches neither the filtered nor the unfiltered stored history"
                      : "codex transcript does not continue the reading its stored history follows"),
                    { cwd, sessionId: session_id },
                  );
                } else if (importNative !== undefined) {
                  const native = project.nativeTranscripts!;
                  const format = resolved.client === "codex"
                    ? CODEX_NATIVE_TRANSCRIPT_FORMAT
                    : CLAUDE_NATIVE_TRANSCRIPT_FORMAT;
                  const projectPatterns = await ScrubEngine.loadProjectPatterns(join(paths.dir, "sensitive-patterns.txt"));
                  const quarantine = openLocalTranscriptQuarantine(project.projectId, format.clientName);
                  let backfillFailed = false;
                  let backfillRetryFailure: NativeTranscriptSourceChangedError | undefined;
                  try {
                    await runNativeTranscriptBackfill({
                      repository: native.repository,
                      messageResolver: createExactNativeTranscriptMessageResolver(native.repository),
                      machineId: native.machineId,
                      format,
                      nativeSessionId: session_id,
                      sourceLocator: createHash("sha256").update(importNative).digest("hex"),
                      source: { openSnapshot: async () => snapshot! },
                      globalPatterns: config.security?.sensitivePatterns ?? [],
                      projectPatterns,
                      quarantine,
                      ...(history === "filtered" && inheritedBoundary !== undefined
                        ? { codexInheritedBoundary: inheritedBoundary }
                        : {}),
                    });
                  } catch (error) {
                    backfillFailed = true;
                    if (error instanceof NativeTranscriptSourceChangedError && attempt === 0 && !signal.aborted) {
                      backfillRetryFailure = error;
                    }
                    throw error;
                  } finally {
                    try { await quarantine.close(); } catch (error) {
                      if (backfillRetryFailure !== undefined) {
                        throw new AggregateError([backfillRetryFailure, error], "Native ingest quarantine cleanup failed", { cause: backfillRetryFailure });
                      }
                      if (!backfillFailed) throw error;
                    }
                  }
                }

                throwIfAborted(signal);
                if (!accumulated) return null;
                const totalTokens = await project.context.getContextTokenCount(accumulated.conversationId);
                throwIfAborted(signal);
                return { ...accumulated, totalTokens };
              } catch (error) {
                attemptFailed = true;
                if (error instanceof NativeTranscriptSourceChangedError && attempt === 0 && !signal.aborted) {
                  retryableFailure = error;
                }
                throw error;
              } finally {
                try { await closeSource(); } finally { permit.release(); }
              }
            },
          );
          break;
        } catch (error) {
          attemptFailed = true;
          if (!(error instanceof NativeTranscriptSourceChangedError) || attempt === 1) throw error;
          throwIfAborted(signal);
          if (sourceWitness === undefined) throw error;
          retryFailure = error;
          retryableFailure = error;
        } finally {
          await closeSource();
        }
      }

      throwIfAborted(context?.signal);
      if (!ingest) {
        sendJson(res, 200, { ingested: 0, totalTokens: 0 });
        return;
      }

      // Update meta.json with lastIngest timestamp
      try {
        const metaPath = paths.metaPath;
        const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        let meta: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(readBoundedRegularFile(metaPath, {
            allowedRoot: paths.dir,
            maxBytes: MAX_PROJECT_METADATA_BYTES,
            expectedUid,
            requireSingleLink: true,
          }));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("invalid project metadata");
          }
          meta = parsed as Record<string, unknown>;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        meta.cwd = paths.canonical;
        meta.lastIngest = new Date().toISOString();
        const serialized = JSON.stringify(meta, null, 2) + "\n";
        if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_METADATA_BYTES) {
          throw new Error("project metadata exceeds size limit");
        }
        const parent: PrivateDirectoryHandle = openPrivateDirectory(paths.dir, { expectedUid });
        let primaryError: unknown;
        let hasPrimaryError = false;
        try {
          atomicWritePrivateFile(metaPath, serialized, {}, parent);
        } catch (error) {
          hasPrimaryError = true;
          primaryError = error;
        } finally {
          try {
            parent.close();
          } catch (error) {
            if (hasPrimaryError) {
              throw new AggregateError(
                [primaryError, error],
                "project metadata publication and directory cleanup failed",
                { cause: primaryError },
              );
            }
            throw error;
          }
        }
        if (hasPrimaryError) throw primaryError;
      } catch {
        // non-fatal: meta.json update failure shouldn't fail the ingest
      }

      const { records, totalCounts, totalTokens } = ingest;
      const totalRedacted = totalCounts.gitleaks + totalCounts.builtIn + totalCounts.global + totalCounts.project;
      const redactionCategories: string[] = [];
      if (totalCounts.gitleaks > 0) redactionCategories.push("gitleaks");
      if (totalCounts.builtIn > 0) redactionCategories.push("built_in");
      if (totalCounts.global > 0) redactionCategories.push("global");
      if (totalCounts.project > 0) redactionCategories.push("project");
      sendJson(res, 200, {
        ingested: records.length,
        totalTokens,
        ...(totalRedacted > 0 ? { redacted: totalRedacted, redactedCategories: redactionCategories } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed && res.writable !== false) {
          sendJson(res, 499, { status: "cancelled", error: "ingest cancelled" });
        }
        return;
      }
      if (err instanceof BackendPublicationJournalError) {
        sendJson(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      await safeLogError("ingest", err, { cwd, sessionId: session_id });
      const storageFailure = storageRouteFailureResponse(config.storage.backend, err, "ingest", storageFactory);
      if (storageFailure) {
        sendJson(res, storageFailure.status, storageFailure.body);
        return;
      }
      sendJson(res, 500, { error: "ingest failed", code: "INGEST_FAILED" });
    }
  };
}
