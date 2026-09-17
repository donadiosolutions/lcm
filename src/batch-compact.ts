import { resolve } from "node:path";
import { captureExistingLcmSnapshot } from "./db/connection.js";
import {
  progressCurrentSession,
  type ProgressCurrentSession,
  type ProgressPhaseError,
  type ProgressState,
} from "./cli/progress-state.js";
import { DaemonClient } from "./daemon/client.js";
import { isDaemonTransportFailure } from "./daemon/http-url.js";
import { configPath } from "./runtime-paths.js";
import { normalizeProjectPath, resolveExistingProjectIdentity } from "./project-map.js";
import { loadDaemonConfig, type LlmApiMode, type LlmInvocationRequestPolicy, type LlmReasoningEffort, type LlmRetryPolicy } from "./daemon/config.js";
import { MANUAL_COMPACT_FRESH_TAIL_COUNT } from "./compaction.js";
import { assertStorageBackendPublication, selectStorageBackendForConfig } from "./storage/backend.js";
import { withBackendPublicationConsumerLockAsync } from "./storage/backend-publication.js";
import { projectPathsForIdentity } from "./daemon/project.js";
import { CliProjectStorageMissingError, listCliProjects, withCliProjectStorage } from "./cli-storage.js";
import type { ProjectRepositories } from "./storage/contracts.js";
import { createSqliteRepositories, createSqliteRepositoryStores } from "./storage/sqlite/repositories.js";
import {
  RetiredProjectIdentityError,
  assertProjectStorageIdentityActive,
} from "./worktree-reconciliation-fence.js";
import type { ProjectStorage } from "./storage/contracts.js";

export interface UncompactedConversation {
  projectDir: string;
  cwd: string;
  conversationId: number;
  sessionId: string;
  messages: number;
  tokens: number;
  sourceLocator?: string;
}

export type CompactItemOutcome = "done" | "unchanged" | "skipped" | "failed" | "dry-run";

export type CompactItemIdentity = Readonly<{
  project: string;
  sessionId: string;
  conversationId: number;
  sourceLocator?: string;
}>;

export type CompactProgressEvent =
  | Readonly<{ type: "discovery-start"; total: number }>
  | Readonly<{ type: "discovery-item-start"; index: number; total: number; projectId: string; project: string }>
  | Readonly<{ type: "discovery-item-terminal"; index: number; total: number; projectId: string; project: string; outcome: "done" | "failed" }>
  | Readonly<{ type: "discovery-clear" }>
  | Readonly<{ type: "session-start"; identity: CompactItemIdentity; messages: number; tokens: number; startedAt: number }>
  | Readonly<{
    type: "session-terminal";
    identity: CompactItemIdentity;
    outcome: CompactItemOutcome;
    messages: number;
    tokensBefore: number;
    tokensAfter?: number;
    provider?: string;
    message?: string;
    elapsed: number;
  }>
  | Readonly<{ type: "phase-failure"; phase: string; project?: string; message: string }>;

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

function hasReplayCondensationCandidate(items: readonly ReplayContextRow[]): boolean {
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

type CompactRepositories = Pick<ProjectRepositories, "conversations" | "summaries" | "context"> & {
  readonly nativeTranscripts?: ProjectStorage["nativeTranscripts"];
};

async function discoverProject(
  storage: CompactRepositories,
  project: { canonical: string; dir: string },
  minTokens: number,
  replay: boolean,
  sourceLocatorForSession?: (sessionId: string) => Promise<string | undefined>,
): Promise<UncompactedConversation[]> {
  const candidates: UncompactedConversation[] = [];
  for (const conversation of await storage.conversations.listConversations()) {
    const conversationId = conversation.conversationId;
    let messages = 0;
    let tokens = 0;
    let afterSeq: number | undefined;
    // Count through bounded pages; compaction discovery never needs the full
    // transcript resident in memory at once.
    while (true) {
      const page = await storage.conversations.getMessages(conversationId, { afterSeq, limit: 500 });
      messages += page.length;
      tokens += page.reduce((total, message) => total + message.tokenCount, 0);
      if (page.length < 500) break;
      afterSeq = page[page.length - 1]!.seq;
    }
    if (messages === 0 || tokens < minTokens) continue;
    const summaries = await storage.summaries.getSummariesByConversation(conversationId);
    if (!replay && summaries.length > 0) continue;
    const context = await storage.context.getContextItems(conversationId);
    const rawCount = context.filter(item => item.itemType === "message").length;
    if (rawCount <= MANUAL_COMPACT_FRESH_TAIL_COUNT) {
      if (!replay) continue;
      const byId = new Map(summaries.map(summary => [summary.summaryId, summary]));
      const items: ReplayContextRow[] = context.map(item => {
        const summary = item.summaryId === null ? undefined : byId.get(item.summaryId);
        return {
          ordinal: item.ordinal,
          item_type: item.itemType,
          depth: summary?.depth ?? null,
          token_count: summary === undefined ? 0 : summary.tokenCount > 0
            ? summary.tokenCount : Math.ceil([...summary.content].length / 4),
        };
      });
      if (!hasReplayCondensationCandidate(items)) continue;
    }
    let sourceLocator: string | undefined;
    try {
      if (sourceLocatorForSession !== undefined) {
        sourceLocator = await sourceLocatorForSession(conversation.sessionId);
      } else {
        const transcripts = await storage.nativeTranscripts?.repository.listByNativeSession({
          nativeSessionId: conversation.sessionId,
        });
        const locators = [...new Set(transcripts?.map(transcript => transcript.sourceLocator) ?? [])];
        if (locators.length === 1) sourceLocator = locators[0];
      }
    } catch {
      // Optional provenance is omitted when it cannot be read unambiguously.
    }
    candidates.push({
      projectDir: project.dir,
      cwd: project.canonical,
      conversationId,
      sessionId: conversation.sessionId,
      messages,
      tokens,
      ...(sourceLocator === undefined ? {} : { sourceLocator }),
    });
  }
  return candidates.sort((left, right) => right.tokens - left.tokens || left.conversationId - right.conversationId);
}

/** Preview repository composition deliberately bypasses factory migrations. */
async function discoverSqlitePreview(
  project: { id: string; canonical: string },
  minTokens: number,
  replay: boolean,
): Promise<UncompactedConversation[]> {
  const config = loadDaemonConfig(configPath());
  return withBackendPublicationConsumerLockAsync(undefined, async token => {
    if (config.storage.backend !== "sqlite") throw new Error("storage selection changed");
    assertStorageBackendPublication(config.storage, token);
    const identity = resolveExistingProjectIdentity(project.canonical, token);
    if (identity === null || identity.id !== project.id) throw new Error("project binding changed");
    const paths = projectPathsForIdentity(identity);
    assertProjectStorageIdentityActive(paths.dir, identity.id);
    const snapshot = captureExistingLcmSnapshot(paths.dbPath);
    if (snapshot === null) return [];
    const db = snapshot.db;
    try {
      const repositories = createSqliteRepositories(
        createSqliteRepositoryStores(db),
        identity.id,
        async (_domain, _operation, callback) => callback(),
      );
      return await discoverProject(
        repositories,
        paths,
        minTokens,
        replay,
        async (sessionId) => {
          try {
            const rows = db.prepare(
              `SELECT DISTINCT source_locator
                 FROM runtime_native_transcripts
                WHERE project_id = ? AND native_session_id = ?
                ORDER BY source_locator
                LIMIT 2`,
            ).all(identity.id, sessionId) as Array<{ source_locator: unknown }>;
            return rows.length === 1 && typeof rows[0]?.source_locator === "string"
              ? rows[0].source_locator
              : undefined;
          } catch {
            return undefined;
          }
        },
      );
    } finally {
      snapshot.close();
    }
  });
}

async function discoverUncompacted(
  minTokens: number,
  readOnly = false,
  cwdFilter?: string,
  replay = false,
  onEvent?: (event: CompactProgressEvent) => void,
): Promise<UncompactedDiscovery> {
  const conversations: UncompactedConversation[] = [];
  const failures: ProjectScanFailure[] = [];
  let projects: Awaited<ReturnType<typeof listCliProjects>>;
  let filterCanonical: string | undefined;
  try {
    projects = await listCliProjects();
    filterCanonical = cwdFilter === undefined ? undefined
      : resolveExistingProjectIdentity(cwdFilter)?.canonical ?? normalizeProjectPath(cwdFilter);
  } catch {
    onEvent?.({ type: "phase-failure", phase: "Compact", project: cwdFilter, message: "project discovery failed" });
    onEvent?.({ type: "discovery-clear" });
    return { conversations, failures: [{ target: cwdFilter ?? "projects", message: "project discovery failed" }] };
  }
  const selectedProjects = projects.filter(project => cwdFilter === undefined
    || project.canonical === filterCanonical
    || project.aliases.includes(resolve(cwdFilter)));
  onEvent?.({ type: "discovery-start", total: selectedProjects.length });
  try {
    for (const [offset, project] of selectedProjects.entries()) {
      const index = offset + 1;
      onEvent?.({
        type: "discovery-item-start",
        index,
        total: selectedProjects.length,
        projectId: project.id,
        project: project.canonical,
      });
      try {
        const config = loadDaemonConfig(configPath());
        const selected = selectStorageBackendForConfig(configPath(), config.storage);
        const found = readOnly && selected.backend === "sqlite"
          ? await discoverSqlitePreview(project, minTokens, replay)
          : await withCliProjectStorage(project.canonical, {}, async ({ storage, project: opened }) =>
            discoverProject(storage, opened, minTokens, replay));
        conversations.push(...found);
        onEvent?.({
          type: "discovery-item-terminal",
          index,
          total: selectedProjects.length,
          projectId: project.id,
          project: project.canonical,
          outcome: "done",
        });
      } catch (error) {
        if (error instanceof CliProjectStorageMissingError) {
          onEvent?.({
            type: "discovery-item-terminal",
            index,
            total: selectedProjects.length,
            projectId: project.id,
            project: project.canonical,
            outcome: "done",
          });
          continue;
        }
        const message = error instanceof RetiredProjectIdentityError
          ? error.message
          : "project storage discovery failed";
        failures.push({ target: project.canonical, message });
        onEvent?.({
          type: "phase-failure",
          phase: "Compact",
          project: project.canonical,
          message,
        });
        onEvent?.({
          type: "discovery-item-terminal",
          index,
          total: selectedProjects.length,
          projectId: project.id,
          project: project.canonical,
          outcome: "failed",
        });
      }
    }
  } finally {
    onEvent?.({ type: "discovery-clear" });
  }
  return { conversations, failures };
}

/** Find conversations eligible for compaction, above the token threshold. */
export async function findUncompacted(minTokens: number, readOnly = false, cwdFilter?: string, replay = false): Promise<UncompactedConversation[]> {
  const configFile = configPath();
  selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
  return (await discoverUncompacted(minTokens, readOnly, cwdFilter, replay)).conversations;
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
  /** Synchronous identity-preserving discovery and session lifecycle events. */
  onEvent?: (event: CompactProgressEvent) => void;
}): Promise<BatchCompactResult> {
  const configFile = configPath();
  const config = loadDaemonConfig(configFile);
  selectStorageBackendForConfig(configFile, config.storage);
  const maxConcurrency = opts.replay ? 1 : opts.maxConcurrency ?? config.llm.maxConcurrency;
  const discovery = await discoverUncompacted(
    opts.minTokens,
    opts.dryRun,
    opts.cwd,
    opts.replay,
    opts.onEvent,
  );
  const conversations = discovery.conversations;
  const onProgress = opts.onProgress;
  const phaseErrors: ProgressPhaseError[] = discovery.failures.map(failure => ({
    phase: "Compact",
    target: failure.target,
    message: failure.message,
  }));

  if (conversations.length === 0 && phaseErrors.length === 0) {
    console.error("Nothing to compact — no sessions are currently eligible.");
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
  console.error(`Found ${conversations.length} uncompacted conversation${conversations.length > 1 ? "s" : ""} (${(totalTokens / 1000).toFixed(1)}k tokens)\n`);

  let compacted = 0;
  let unchanged = 0;
  let skipped = 0;
  let completedCount = 0;
  let messagesIn = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const progressErrors: ProgressState["errors"] = [];
  const compactedProjectIndexes = new Map<string, number>();
  const activeSessions = new Map<number, ProgressCurrentSession>();
  const claimedAt = new Map<number, number>();
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
    onClaim: (conv, index) => {
        const startedAt = Date.now();
        claimedAt.set(index, startedAt);
        const identity: CompactItemIdentity = {
          project: conv.cwd,
          sessionId: conv.sessionId,
          conversationId: conv.conversationId,
          ...(conv.sourceLocator === undefined ? {} : { sourceLocator: conv.sourceLocator }),
        };
        opts.onEvent?.({
          type: "session-start",
          identity,
          messages: conv.messages,
          tokens: conv.tokens,
          startedAt,
        });
        if (opts.dryRun) return;
        activeSessions.set(index, {
          sessionId: conv.sessionId,
          project: conv.cwd,
          conversationId: conv.conversationId,
          ...(conv.sourceLocator === undefined ? {} : { sourceLocator: conv.sourceLocator }),
          messages: conv.messages,
          tokens: conv.tokens,
          startedAt,
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
      const identity: CompactItemIdentity = {
        project: conv.cwd,
        sessionId: conv.sessionId,
        conversationId: conv.conversationId,
        ...(conv.sourceLocator === undefined ? {} : { sourceLocator: conv.sourceLocator }),
      };
      // claimedAt is set synchronously by onClaim before this index's task is
      // scheduled, so the entry is always present by the time onResult runs.
      const sessionStart = claimedAt.get(result.index)!;
      claimedAt.delete(result.index);
      activeSessions.delete(result.index);
      const activePatch = progressActivePatch();

      if ("error" in result) {
        const errMsg = result.error instanceof Error ? "compaction request failed" : "unknown error";
        if (isDaemonTransportFailure(result.error)) opts.onTransportFailure?.(result.error);
        progressErrors.push({
          project: conv.cwd,
          sessionId: conv.sessionId,
          conversationId: conv.conversationId,
          ...(conv.sourceLocator === undefined ? {} : { sourceLocator: conv.sourceLocator }),
          message: errMsg,
        });
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "failed",
          messages: conv.messages,
          tokensBefore: conv.tokens,
          message: errMsg,
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          errors: [...progressErrors],
          lastResult: {
            ...identity,
            outcome: "failed",
            messages: conv.messages,
            tokensBefore: conv.tokens,
            elapsed: Date.now() - sessionStart,
          },
        });
        return;
      }

      const data = result.value;
      if (!opts.dryRun && !isCompactResponse(data)) {
        const errMsg = "malformed compact response";
        progressErrors.push({
          ...identity,
          message: errMsg,
        });
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "failed",
          messages: conv.messages,
          tokensBefore: conv.tokens,
          message: errMsg,
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          errors: [...progressErrors],
          lastResult: {
            ...identity,
            outcome: "failed",
            messages: conv.messages,
            tokensBefore: conv.tokens,
            elapsed: Date.now() - sessionStart,
          },
        });
        return;
      }
      if (opts.dryRun) {
        completedCount++;
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "dry-run",
          messages: conv.messages,
          tokensBefore: conv.tokens,
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          lastResult: {
            ...identity,
            outcome: "dry-run",
            messages: conv.messages,
            tokensBefore: conv.tokens,
            elapsed: Date.now() - sessionStart,
          },
        });
      } else if (data?.skipped) {
        skipped++;
        completedCount++;
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "skipped",
          messages: conv.messages,
          tokensBefore: conv.tokens,
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          lastResult: {
            ...identity,
            outcome: "skipped",
            messages: conv.messages,
            tokensBefore: conv.tokens,
            elapsed: Date.now() - sessionStart,
          },
        });
      } else if (data?.actionTaken === false) {
        unchanged++;
        completedCount++;
        const tokensBefore = data.tokensBefore ?? conv.tokens;
        const tokensAfter = data.tokensAfter ?? tokensBefore;
        const summary = data.summary?.trim() || "No compaction needed.";
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "unchanged",
          messages: conv.messages,
          tokensBefore,
          tokensAfter,
          provider: formatLlmDiagnostic(data),
          message: summary,
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          lastResult: {
            ...identity,
            outcome: "unchanged",
            messages: conv.messages,
            tokensBefore,
            tokensAfter,
            provider: formatLlmDiagnostic(data),
            elapsed: Date.now() - sessionStart,
          },
        });
      } else {
        const tokensBefore = data.tokensBefore ?? conv.tokens;
        const tokensAfter = data.tokensAfter ?? tokensBefore;
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
        opts.onEvent?.({
          type: "session-terminal",
          identity,
          outcome: "done",
          messages: conv.messages,
          tokensBefore,
          tokensAfter,
          provider: formatLlmDiagnostic(data),
          elapsed: Date.now() - sessionStart,
        });
        onProgress?.({
          ...activePatch,
          completed: completedCount,
          messagesIn,
          tokensIn,
          tokensOut,
          lastResult: {
            ...identity,
            outcome: "done",
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
      console.error(`\nBatch compact complete. ${compacted} session${compacted !== 1 ? "s" : ""} compacted, ${(tokensIn / 1000).toFixed(1)}k → ${(tokensOut / 1000).toFixed(1)}k tokens (${pct}% reduction, ${(freed / 1000).toFixed(1)}k freed)`);
    } else {
      console.error("\nBatch compact complete.");
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
