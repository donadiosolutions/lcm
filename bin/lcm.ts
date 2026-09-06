#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { argv, exit, kill as processKill, stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { packageRootFor } from "../src/runtime-root.js";
import {
  DaemonClient,
  type DaemonHealth,
  type DaemonRequestOptions,
  type InvocationControlRequest,
  type InvocationControlResponse,
} from "../src/daemon/client.js";
import {
  ConfigValidationError,
  DEFAULT_LLM_MAX_CONCURRENCY,
  daemonConfigSnapshotWitnessEqual,
  LLM_REASONING_EFFORTS,
  readDaemonConfigSnapshot,
  reasoningEffortsForProvider,
  resolveLlmRequestPolicy,
  MAX_LLM_MAX_CONCURRENCY,
  supportsFastMode,
  supportsRequestTimeout,
  type DaemonConfig,
  type LlmInvocationRequestPolicy,
  type LlmProvider,
  type LlmRequestPolicyConfig,
  type LlmReasoningEffort,
} from "../src/daemon/config.js";
import {
  configPath as defaultConfigPath,
  BootstrapLockContentionError,
  daemonPidPath,
  daemonTokenPath,
  lcmHomeDir,
  migrateLegacyHomeIfNeeded,
  projectsDir as lcmProjectsDir,
} from "../src/runtime-paths.js";
import type { ProgressState } from "../src/cli/progress-state.js";
import { StorageBackendUnavailableError } from "../src/storage/backend.js";
import { PrivateMutationLockContentionError } from "../src/private-mutation-lock.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";
import { BACKEND_PUBLICATION_ADMISSION_DIAGNOSTIC } from "../src/hooks/publication-fence.js";
import { sanitizeTerminalText } from "../src/terminal-sanitize.js";
import { isDaemonTransportFailure } from "../src/daemon/http-url.js";
import {
  clearDaemonRemediation,
  isDaemonRefusalReason,
  mapDaemonRefusalToRemediation,
  type DaemonRefusalReason,
} from "../src/daemon/remediation.js";
import {
  DAEMON_TEST_ENTRYPOINT_OPTION,
  DAEMON_TEST_OWNER_OPTION,
  type DaemonLifecycleTestIdentity,
  daemonEntrypointMatches,
  isCanonicalLifecycleTestDirectory,
  isCanonicalLifecycleTestRegularFile,
  isCanonicalOrMissingLifecycleTestStateFile,
  isDaemonLifecycleTestIdentity,
} from "../src/daemon/lifecycle-scope.js";
import {
  PACKAGED_RUNTIME_ENTRYPOINT,
  PKG_VERSION,
  RUNTIME_DIGEST,
} from "../src/daemon/version.js";
import type {
  LocalHookEventRow,
  LocalHookOutboxRepository,
} from "../src/storage/local-hook-outbox.js";
import type {
  PostgreSqlPassiveEventRecord,
  PostgreSqlPassiveEventRepository,
} from "../src/storage/postgresql/passive-event-repository.js";
import { CONNECTOR_TRANSPORTS } from "../src/connectors/types.js";
import { createAbortError, isAbortError, throwIfAborted } from "../src/daemon/cancellation.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, 5000);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); }
    });
  });
}

export function withHookOverrides(
  stdinText: string,
  client: unknown,
  reasoningEffort: LlmReasoningEffort | undefined,
  requestPolicy?: LlmInvocationRequestPolicy,
  fastMode?: boolean,
): string {
  try {
    const parsed = JSON.parse(stdinText || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return stdinText;
    return JSON.stringify({
      ...parsed,
      ...(client === "claude" || client === "codex" ? { client } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fast_mode: fastMode } : {}),
      ...(requestPolicy ? {
        request_timeout_ms: requestPolicy.requestTimeoutMs,
        ...(requestPolicy.retry ? { retry: {
          max_attempts: requestPolicy.retry.maxAttempts,
          initial_delay_ms: requestPolicy.retry.initialDelayMs,
          max_delay_ms: requestPolicy.retry.maxDelayMs,
          multiplier: requestPolicy.retry.multiplier,
        } } : {}),
      } : {}),
    });
  } catch {
    return stdinText;
  }
}

type CompactRequestPolicyOptions = {
  timeoutMs?: string;
  retryMaxAttempts?: string;
  retryInitialDelayMs?: string;
  retryMaxDelayMs?: string;
  retryMultiplier?: string;
};

type CompactOptions = CompactRequestPolicyOptions & {
  all?: boolean;
  dryRun?: boolean;
  replay?: boolean;
  promote?: boolean;
  reasoningEffort?: LlmReasoningEffort;
  fastMode?: boolean;
  verbose?: boolean;
  hook?: boolean;
  client?: unknown;
  help?: boolean;
  maxConcurrency?: string;
};

export type CompactInvocationClient = Readonly<{
  health?: (options?: DaemonRequestOptions) => Promise<DaemonHealth | null>;
  startInvocation: (
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ) => Promise<InvocationControlResponse>;
  heartbeatInvocation: (
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ) => Promise<InvocationControlResponse>;
  cancelInvocation: (
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ) => Promise<InvocationControlResponse>;
  finishInvocation: (
    input: InvocationControlRequest,
    options?: DaemonRequestOptions,
  ) => Promise<InvocationControlResponse>;
}>;

export type CompactInvocationLifecycleOptions = Readonly<{
  client: CompactInvocationClient;
  daemonInstanceId: string;
  invocationId?: string;
  signal?: AbortSignal;
  /** Bounds the ordinary start control transport without using command abort. */
  startTimeoutMs?: number;
  /** Injectable clock used to bound uncertain start outcomes. */
  now?: () => number;
  heartbeatMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onHeartbeatError?: (error: unknown) => void;
}>;

export type CompactInvocationLifecycle = Readonly<{
  invocationId: string;
  target: InvocationControlRequest;
  signal: AbortSignal;
  started: () => boolean;
  /** True once the start request was sent, even if its response was lost. */
  possiblyRegistered: () => boolean;
  /** Registration state, including an uncertain start transport outcome. */
  startState?: () => "unsent" | "sent" | "confirmed" | "response-lost";
  /** Absolute deadline after which an unconfirmed start may be reconciled. */
  uncertaintyDeadline?: () => number | undefined;
  start: () => Promise<InvocationControlResponse>;
  stopHeartbeat: () => void;
  /** Stop and await every heartbeat request already in flight. */
  settleHeartbeat: () => Promise<void>;
  heartbeat: () => Promise<InvocationControlResponse | undefined>;
  cancel: () => Promise<InvocationControlResponse | undefined>;
  finish: () => Promise<InvocationControlResponse | undefined>;
}>;

/**
 * Verify a daemon invocation snapshot is bound to the requested target and
 * carries all three independent zero-work counters.  `activeCount` alone is
 * not a sufficient ownership proof: older or malformed responses may omit a
 * work/commit counter while still claiming zero active work.
 */
export function isStrictInvocationControlSnapshot(
  value: unknown,
  target: InvocationControlRequest,
  state: "cancelled" | "finished",
): value is InvocationControlResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<InvocationControlResponse>;
  return snapshot.invocationId === target.invocationId
    && snapshot.command === target.command
    && snapshot.daemonInstanceId === target.daemonInstanceId
    && snapshot.state === state
    && snapshot.activeCount === 0
    && snapshot.workCount === 0
    && snapshot.commitCount === 0;
}

function isStrictTerminalInvocationControlSnapshot(
  value: unknown,
  target: InvocationControlRequest,
): value is InvocationControlResponse {
  return isStrictInvocationControlSnapshot(value, target, "cancelled")
    || isStrictInvocationControlSnapshot(value, target, "finished");
}

function isInvocationTargetResponse(
  value: unknown,
  target: InvocationControlRequest,
  state: "active" | "cancelling" | "cancelled" | "finished",
): value is InvocationControlResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<InvocationControlResponse>;
  return snapshot.invocationId === target.invocationId
    && snapshot.command === target.command
    && snapshot.daemonInstanceId === target.daemonInstanceId
    && snapshot.state === state
    && typeof snapshot.activeCount === "number"
    && Number.isSafeInteger(snapshot.activeCount)
    && typeof snapshot.workCount === "number"
    && Number.isSafeInteger(snapshot.workCount)
    && typeof snapshot.commitCount === "number"
    && Number.isSafeInteger(snapshot.commitCount);
}

/**
 * Own one daemon invocation's start, lease heartbeats, and terminal control.
 * The caller remains responsible for command-signal and drain orchestration.
 */
export function createCompactInvocationLifecycle(
  options: CompactInvocationLifecycleOptions,
): CompactInvocationLifecycle {
  const invocationId = options.invocationId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(invocationId)) {
    throw new Error("compact invocation ID must be a canonical UUID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.daemonInstanceId)) {
    throw new Error("daemon instance ID must be a canonical UUID");
  }
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= 30_000) {
    throw new RangeError("compact heartbeat interval must be between 0 and 30000 ms");
  }
  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0) {
    throw new RangeError("compact invocation start timeout must be positive");
  }
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? Date.now;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const target: InvocationControlRequest = {
    invocationId,
    command: "compact",
    daemonInstanceId: options.daemonInstanceId,
  };
  let started = false;
  let possiblyRegistered = false;
  let startState: "unsent" | "sent" | "confirmed" | "response-lost" = "unsent";
  let startSentAt: number | undefined;
  let uncertaintyDeadline: number | undefined;
  const startController = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatPromise: Promise<InvocationControlResponse> | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer === undefined) return;
    clearTimer(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const heartbeat = async (): Promise<InvocationControlResponse | undefined> => {
    if (!started || signal.aborted) return undefined;
    if (heartbeatPromise !== undefined) return await heartbeatPromise;
    // Heartbeats must carry their own transport deadline.  Cleanup awaits the
    // in-flight request, so relying only on the command signal could leave
    // finish/cancel blocked forever when the daemon stops responding.
    const pending = options.client.heartbeatInvocation(target, {
      signal,
      timeoutMs: startTimeoutMs,
    });
    heartbeatPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (!isAbortError(error)) options.onHeartbeatError?.(error);
      throw error;
    } finally {
      if (heartbeatPromise === pending) heartbeatPromise = undefined;
    }
  };

  const scheduleHeartbeat = (): void => {
    heartbeatTimer = setTimer(() => {
      void heartbeat().catch(() => undefined);
    }, heartbeatMs);
  };

  const start = async (): Promise<InvocationControlResponse> => {
    if (started) {
      return await options.client.heartbeatInvocation(target, {
        signal,
        timeoutMs: startTimeoutMs,
      });
    }
    throwIfAborted(signal);
    // The request is now an owned side effect.  Keep this marker latched if
    // transport rejects or loses its response so the caller must cancel the
    // target before it can leave the command.
    possiblyRegistered = true;
    startState = "sent";
    startSentAt = now();
    uncertaintyDeadline = startSentAt + startTimeoutMs + 30_000;
    try {
      const result = await options.client.startInvocation(target, {
        signal: startController.signal,
        timeoutMs: startTimeoutMs,
      });
      if (!isInvocationTargetResponse(result, target, "active")) {
        startState = "response-lost";
        throw new Error("compact invocation start returned an invalid snapshot");
      }
      startState = "confirmed";
      started = true;
      scheduleHeartbeat();
      return result;
    } catch (error) {
      if (startState !== "confirmed") startState = "response-lost";
      throw error;
    }
  };

  const settleHeartbeat = async (): Promise<void> => {
    stopHeartbeat();
    if (heartbeatPromise !== undefined) await Promise.allSettled([heartbeatPromise]);
  };

  const cancel = async (): Promise<InvocationControlResponse | undefined> => {
    await settleHeartbeat();
    if (!started && !possiblyRegistered) return undefined;
    return await options.client.cancelInvocation(target, { signal });
  };

  const finish = async (): Promise<InvocationControlResponse | undefined> => {
    await settleHeartbeat();
    if (!started) return undefined;
    const result = await options.client.finishInvocation(target, {
      signal,
      timeoutMs: startTimeoutMs,
    });
    if (!isStrictInvocationControlSnapshot(result, target, "finished")) {
      throw new Error("compact invocation finish returned an invalid terminal snapshot");
    }
    return result;
  };

  return {
    invocationId,
    target,
    signal,
    started: () => started,
    possiblyRegistered: () => possiblyRegistered,
    startState: () => startState,
    uncertaintyDeadline: () => startState === "response-lost" ? uncertaintyDeadline : undefined,
    start,
    stopHeartbeat,
    settleHeartbeat,
    heartbeat,
    cancel,
    finish,
  };
}

type CompactSignalProcessLike = Readonly<{
  on: (event: "SIGINT" | "SIGTERM", handler: () => void) => unknown;
  removeListener: (event: "SIGINT" | "SIGTERM", handler: () => void) => unknown;
}>;

export type CompactSignalHandlers = Readonly<{
  readonly signal: AbortSignal;
  readonly status: 130 | 143 | undefined;
  readonly draining: boolean;
  readonly drainPromise: Promise<void> | undefined;
  bindRenderer: (state: Pick<ProgressState, "aborted">) => void;
  beginDrain: (reason?: string) => void;
  cleanup: () => void;
}>;

export type CompactSignalHandlerOptions = Readonly<{
  processLike?: CompactSignalProcessLike;
  onFirstSignal?: (status: 130 | 143, signal: "SIGINT" | "SIGTERM") => Promise<void> | void;
  onDrain?: (reason?: string) => Promise<void> | void;
  onRepeatSignal?: (status: 130 | 143, signal: "SIGINT" | "SIGTERM") => void;
}>;

/** Install non-exiting compact signal handlers and expose their drain state. */
export function installCompactSignalHandlers(
  options: CompactSignalHandlerOptions = {},
): CompactSignalHandlers {
  const processLike = options.processLike ?? process;
  const controller = new AbortController();
  let status: 130 | 143 | undefined;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let rendererState: Pick<ProgressState, "aborted"> | undefined;
  let cleaned = false;

  const beginDrain = (reason?: string, signal?: "SIGINT" | "SIGTERM"): void => {
    const nextStatus = signal === undefined ? undefined : signal === "SIGINT" ? 130 : 143;
    if (draining) {
      return;
    }
    draining = true;
    if (nextStatus !== undefined) status = nextStatus;
    if (rendererState !== undefined) rendererState.aborted = true;
    controller.abort(createAbortError(reason ?? signal ?? "compact drain requested"));
    try {
      drainPromise = signal === undefined
        ? Promise.resolve(options.onDrain?.(reason))
        : Promise.resolve(options.onFirstSignal?.(signal === "SIGINT" ? 130 : 143, signal));
    } catch (error) {
      drainPromise = Promise.reject(error);
    }
    void drainPromise.catch(() => undefined);
  };
  const receive = (signal: "SIGINT" | "SIGTERM"): void => {
    if (draining) {
      // Automatic drains begin without an exit status.  A late user signal
      // must still latch its status, while subsequent signals retain the
      // first latched status and can never bypass the drain.
      if (status === undefined) status = signal === "SIGINT" ? 130 : 143;
      options.onRepeatSignal?.(status, signal);
      return;
    }
    beginDrain(undefined, signal);
  };
  const sigintHandler = (): void => receive("SIGINT");
  const sigtermHandler = (): void => receive("SIGTERM");
  processLike.on("SIGINT", sigintHandler);
  processLike.on("SIGTERM", sigtermHandler);

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    processLike.removeListener("SIGINT", sigintHandler);
    processLike.removeListener("SIGTERM", sigtermHandler);
  };
  return {
    signal: controller.signal,
    get status() { return status; },
    get draining() { return draining; },
    get drainPromise() { return drainPromise; },
    bindRenderer: (state): void => {
      rendererState = state;
      if (status !== undefined) state.aborted = true;
    },
    beginDrain: (reason?: string): void => beginDrain(reason),
    cleanup,
  };
}

export type CompactDrainResult = Readonly<{
  daemonZero: boolean;
  localSettled: boolean;
  restartAttempted?: boolean;
  replacementVerified?: boolean;
  diagnostic?: string;
}>;

export type CompactManagedRestartResult = Readonly<{
  connected: boolean;
  restarted?: boolean;
  stoppedPid?: number;
  pid?: number;
  refusalReason?: unknown;
  warning?: string;
}>;

/** Prove the original daemon PID gone without requiring this restart to stop it. */
export function proveOriginalDaemonGone(
  originalPid: number | undefined,
  restart: CompactManagedRestartResult,
  killProcess: (pid: number, signal: 0) => void = processKill,
): boolean {
  if (originalPid === undefined) return false;
  if (restart.restarted === true && restart.stoppedPid === originalPid) return true;
  try {
    killProcess(originalPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
  }
}

export type CompactDrainOptions = Readonly<{
  lifecycle: CompactInvocationLifecycle;
  createFreshClient: () => CompactInvocationClient;
  awaitLocalWork?: () => Promise<void>;
  /** True once the command has dispatched any local compact work. */
  localWorkDispatched?: () => boolean;
  originalHealth?: DaemonHealth | null;
  health?: (client: CompactInvocationClient, options?: DaemonRequestOptions) => Promise<DaemonHealth | null>;
  timeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
  expectedRuntimeDigest?: string;
  expectedStorageBackend?: DaemonHealth["storageBackend"];
  restart?: (input: Readonly<{ originalHealth?: DaemonHealth; signal: AbortSignal }>) => Promise<CompactManagedRestartResult>;
  proveOldInstanceGone?: (input: Readonly<{ originalHealth?: DaemonHealth; restart: CompactManagedRestartResult }>) => Promise<boolean> | boolean;
  proveProviderWitnessGone?: (input: Readonly<{ daemonInstanceId?: string; invocationId?: string }>) => Promise<boolean> | boolean;
  /** Mutable state shared by one automatic drain retry session. */
  session?: CompactDrainSession;
  onDiagnostic?: (message: string) => void;
}>;

function isUnknownInvocationCancellation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (candidate.statusCode === 404) return true;
  if (candidate.code === "unknown-invocation" || candidate.code === "UNKNOWN_INVOCATION") return true;
  return typeof candidate.message === "string"
    && /(?:unknown invocation|invocation not found|http\s*404)/iu.test(candidate.message);
}

export type CompactDrainSession = {
  restartAttempted: boolean;
  restartPromise?: Promise<CompactManagedRestartResult>;
  restart?: CompactManagedRestartResult;
  oldInstanceGone?: boolean;
  providerWitnessGone?: boolean;
};

type CompactProviderWitnessSnapshot = Readonly<{
  available: boolean;
  providers: readonly unknown[];
}>;

export function proveCompactProviderWitnessGone(
  input: Readonly<{ daemonInstanceId: string; invocationId?: string }>,
  readers: Readonly<{
    read: (input: Readonly<{ daemonInstanceId: string; invocationId?: string }>) => CompactProviderWitnessSnapshot;
    reconcile: (input: Readonly<{ daemonInstanceId: string; invocationId?: string }>) => CompactProviderWitnessSnapshot;
  }>,
): boolean {
  const target = {
    daemonInstanceId: input.daemonInstanceId,
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
  };
  const observed = readers.read(target);
  const snapshot = observed.available && observed.providers.length > 0
    ? readers.reconcile(target)
    : observed;
  return snapshot.available && snapshot.providers.length === 0;
}

/** Cancel one invocation with a fresh client and await local owned work. */
export async function cancelAndDrainCompactInvocation(
  options: CompactDrainOptions,
): Promise<CompactDrainResult> {
  const possiblyRegistered = options.lifecycle.started()
    || options.lifecycle.possiblyRegistered?.() === true;
  if (!possiblyRegistered) return { daemonZero: true, localSettled: true };
  if (options.lifecycle.settleHeartbeat !== undefined) {
    await options.lifecycle.settleHeartbeat();
  } else {
    options.lifecycle.stopHeartbeat();
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("compact cancellation timeout must be positive");
  }
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const now = options.now ?? Date.now;
  const startState = options.lifecycle.startState?.();
  const uncertaintyDeadline = options.lifecycle.uncertaintyDeadline?.();
  const localWorkDispatched = options.localWorkDispatched?.() === true;
  const deadline = now() + timeoutMs;
  type BoundedResult<T> = Readonly<{
    settled: boolean;
    value?: T;
    error?: unknown;
    timedOut: boolean;
    pending?: Promise<T>;
  }>;
  const bounded = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    operationDeadline = deadline,
  ): Promise<BoundedResult<T>> => {
    const controller = new AbortController();
    const remaining = Math.max(0, operationDeadline - now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTimeout!: () => void;
    const timeout = new Promise<void>(resolve => {
      resolveTimeout = resolve;
      timer = setTimer(resolve, remaining);
    });
    const pending = Promise.resolve().then(() => operation(controller.signal));
    const outcome = await Promise.race([
      pending.then(value => ({ settled: true, value, timedOut: false } as const), error => ({ settled: true, error, timedOut: false } as const)),
      timeout.then(() => ({ settled: false, timedOut: true } as const)),
    ]);
    if (timer !== undefined) clearTimer(timer);
    resolveTimeout();
    if (outcome.timedOut) {
      controller.abort(createAbortError("compact cancellation deadline exceeded"));
      return { settled: false, timedOut: true, pending };
    }
    return { ...outcome, pending };
  };
  let daemonZero = false;
  let restartAttempted = false;
  let replacementVerified = false;
  let diagnostic: string | undefined;
  let originalReachable = false;
  const session = options.session;
  const firstClient = options.createFreshClient();
  const firstCancel = await bounded(signal => firstClient.cancelInvocation(
    options.lifecycle.target,
    { signal },
  ));
  const providerProof = options.proveProviderWitnessGone === undefined
    ? { settled: true, value: false, timedOut: false }
    : await bounded(async () => await options.proveProviderWitnessGone!({
      daemonInstanceId: options.originalHealth?.daemonInstanceId
        ?? options.lifecycle.target.daemonInstanceId,
      invocationId: options.lifecycle.target.invocationId,
    }));
  const strictCancel = firstCancel.settled
    && firstCancel.error === undefined
    && firstCancel.value !== undefined
    && isStrictTerminalInvocationControlSnapshot(firstCancel.value, options.lifecycle.target);
  const providerGone = providerProof.settled
    && providerProof.error === undefined
    && providerProof.value === true;
  daemonZero = strictCancel && providerGone;
  if (!daemonZero && firstCancel.settled && firstCancel.error === undefined && firstCancel.value !== undefined) {
    diagnostic = strictCancel
      ? "provider process witness is unavailable or still reports owned work"
      : "daemon cancellation response did not prove targeted zero-owned work";
  } else if (firstCancel.settled && firstCancel.error !== undefined) {
    diagnostic = firstCancel.error instanceof Error ? firstCancel.error.message : "daemon cancellation request failed";
  } else {
    diagnostic = "daemon cancellation deadline exceeded";
  }

  const localResult = await bounded(async () => {
    await options.awaitLocalWork?.();
  });
  const localSettled = localResult.settled && !localResult.timedOut && localResult.error === undefined;

  const health = options.health ?? ((client: CompactInvocationClient, requestOptions?: DaemonRequestOptions) =>
    client.health === undefined ? Promise.resolve(null) : client.health(requestOptions));
  const uncertainStart = startState === "response-lost"
    && !localWorkDispatched
    && uncertaintyDeadline !== undefined
    && options.originalHealth?.daemonInstanceId !== undefined;
  const unknownFirstCancel = firstCancel.settled
    && firstCancel.error !== undefined
    && isUnknownInvocationCancellation(firstCancel.error);
  if ((!daemonZero || !localSettled)
    && (now() <= deadline || (uncertainStart && unknownFirstCancel))) {
    const healthDeadline = now() <= deadline ? deadline : now() + timeoutMs;
    const healthResult = await bounded(signal => health(options.createFreshClient(), { signal }), healthDeadline);
    const observed = healthResult.value;
    const sameInstance = observed !== null
      && observed !== undefined
      && options.originalHealth?.daemonInstanceId !== undefined
      && observed.daemonInstanceId === options.originalHealth.daemonInstanceId
      && (observed.status === "ok" || observed.status === "healthy");
    if (sameInstance) {
      originalReachable = true;
      const retry = await bounded(signal => options.createFreshClient().cancelInvocation(
        options.lifecycle.target,
        { signal },
      ), healthDeadline);
      const retryProviderProof = options.proveProviderWitnessGone === undefined
        ? { settled: true, value: false, timedOut: false }
        : await bounded(async () => await options.proveProviderWitnessGone!({
          daemonInstanceId: options.originalHealth!.daemonInstanceId!,
          invocationId: options.lifecycle.target.invocationId,
        }), healthDeadline);
      const strictRetry = retry.settled
        && retry.error === undefined
        && retry.value !== undefined
        && isStrictTerminalInvocationControlSnapshot(retry.value, options.lifecycle.target);
      const retryProviderGone = retryProviderProof.settled
        && retryProviderProof.error === undefined
        && retryProviderProof.value === true;
      daemonZero = strictRetry && retryProviderGone;
      if (!daemonZero
        && uncertainStart
        && now() >= uncertaintyDeadline!
        && unknownFirstCancel
        && isUnknownInvocationCancellation(retry.error)
        && retryProviderGone) {
        daemonZero = true;
      }
      if (!daemonZero) diagnostic = strictRetry
        ? "provider process witness is unavailable or still reports owned work after cancellation retry"
        : "daemon cancellation response did not prove targeted zero-owned work after retry";
    } else if (observed !== null && observed !== undefined) {
      diagnostic = "daemon instance changed while cancellation was in progress";
    }
  }

  let restartDeadline: number | undefined;
  let replacementProofDiagnostic: string | undefined;
  const boundedRestart = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<BoundedResult<T>> => {
    restartDeadline ??= now() + timeoutMs;
    return await bounded(operation, restartDeadline);
  };

  const proveReplacement = async (restart: CompactManagedRestartResult): Promise<boolean> => {
    type BooleanBoundedResult = BoundedResult<boolean>;
    const oldGoneResult: BooleanBoundedResult = options.proveOldInstanceGone === undefined
      ? { settled: true, value: restart.restarted === true && restart.stoppedPid !== undefined, timedOut: false }
      : await boundedRestart(async () => await options.proveOldInstanceGone!({
        originalHealth: options.originalHealth ?? undefined,
        restart,
      }));
    const providersGoneResult: BooleanBoundedResult = options.proveProviderWitnessGone === undefined
      ? { settled: true, value: false, timedOut: false }
      : await boundedRestart(async () => await options.proveProviderWitnessGone!({
        daemonInstanceId: options.originalHealth?.daemonInstanceId
          ?? options.lifecycle.target.daemonInstanceId,
      }));
    const oldGone = oldGoneResult.settled && oldGoneResult.error === undefined && oldGoneResult.value === true;
    const providersGone = providersGoneResult.settled
      && providersGoneResult.error === undefined
      && providersGoneResult.value === true;
    if (session !== undefined) {
      session.oldInstanceGone = oldGone;
      session.providerWitnessGone = providersGone;
    }
    if (!oldGone || !providersGone) return false;
    const replacementResult = await boundedRestart(signal => health(options.createFreshClient(), { signal }));
    const replacement = replacementResult.value;
    const replacementIdentityWithoutRuntime = replacementResult.settled
      && replacementResult.error === undefined
      && replacement !== null
      && replacement !== undefined
      && replacement.daemonInstanceId !== undefined
      && replacement.daemonInstanceId !== options.originalHealth?.daemonInstanceId
      && (options.expectedStorageBackend === undefined || replacement.storageBackend === options.expectedStorageBackend)
      && (replacement.status === "ok" || replacement.status === "healthy");
    const expectedRuntimeDigest = options.expectedRuntimeDigest;
    const expectedRuntimeDigestAvailable = typeof expectedRuntimeDigest === "string"
      && expectedRuntimeDigest.length > 0;
    if (replacementIdentityWithoutRuntime) {
      if (!expectedRuntimeDigestAvailable) {
        replacementProofDiagnostic = "expected runtime digest is unavailable; cannot verify replacement identity";
      } else if (replacement.runtimeDigest !== expectedRuntimeDigest) {
        replacementProofDiagnostic = "replacement daemon runtime digest does not match the invoking CLI";
      }
    }
    replacementVerified = replacementIdentityWithoutRuntime
      && expectedRuntimeDigestAvailable
      && replacement.runtimeDigest === expectedRuntimeDigest;
    return replacementVerified;
  };

  if ((!daemonZero || !localSettled) && session?.restartAttempted === true) {
    restartAttempted = true;
    if (session.restart !== undefined) {
      if (await proveReplacement(session.restart)) daemonZero = true;
      else if (replacementProofDiagnostic !== undefined) diagnostic = replacementProofDiagnostic;
    } else if (session.restartPromise !== undefined) {
      const pendingRestart = await boundedRestart(async () => await session.restartPromise!);
      if (pendingRestart.settled
        && pendingRestart.error === undefined
        && pendingRestart.value !== undefined) {
        session.restart = pendingRestart.value;
        session.restartPromise = undefined;
        if (await proveReplacement(pendingRestart.value)) daemonZero = true;
        else if (replacementProofDiagnostic !== undefined) diagnostic = replacementProofDiagnostic;
      } else if (pendingRestart.settled) {
        // A terminally failed attempt no longer owns restart admission. Permit
        // a later drain iteration to start one fresh managed restart.
        session.restartAttempted = false;
        session.restartPromise = undefined;
        diagnostic = pendingRestart.error instanceof Error
          ? pendingRestart.error.message
          : "managed daemon restart was not verified";
      }
    }
  } else if ((!daemonZero || !localSettled)
    && options.restart !== undefined
    && !originalReachable
    && (session === undefined || !session.restartAttempted)) {
    restartAttempted = true;
    if (session !== undefined) session.restartAttempted = true;
    try {
      const restartResult = await boundedRestart(signal => options.restart!({
        originalHealth: options.originalHealth ?? undefined,
        signal,
      }));
      if (session !== undefined) session.restartPromise = restartResult.pending;
      if (!restartResult.settled || restartResult.error !== undefined || restartResult.value === undefined) {
        if (session !== undefined && restartResult.settled) {
          session.restartAttempted = false;
          session.restartPromise = undefined;
        }
        throw restartResult.error ?? new Error("managed daemon restart did not settle before cancellation deadline");
      }
      const restart = restartResult.value;
      if (session !== undefined) {
        session.restart = restart;
        session.restartPromise = undefined;
      }
      if (await proveReplacement(restart)) daemonZero = true;
      if (!replacementVerified) {
        diagnostic = replacementProofDiagnostic
          ?? restart.warning
          ?? "managed daemon restart did not prove replacement identity";
      }
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : "managed daemon restart was not verified";
    }
  }
  if (!daemonZero || !localSettled) {
    // Every non-early path above assigns a diagnostic from cancellation,
    // retry, or managed-restart outcomes before reaching this block.
    const rawDiagnostic = diagnostic!;
    const boundedDiagnostic = sanitizeTerminalText(rawDiagnostic).slice(0, 256);
    options.onDiagnostic?.(boundedDiagnostic);
  }
  return {
    daemonZero,
    localSettled,
    restartAttempted,
    replacementVerified,
    diagnostic: diagnostic!,
  };
}

export type CompactDrainUntilProvedOptions = CompactDrainOptions & Readonly<{
  /** Delay between fresh cancellation/proof attempts. */
  retryDelayMs?: number;
  /** Injectable retry delay seam used by deterministic lifecycle tests. */
  waitForRetry?: (delayMs: number) => Promise<void>;
}>;

/** Keep retrying fresh cancellation and ownership proof until both settle. */
export async function drainCompactInvocationUntilProved(
  options: CompactDrainUntilProvedOptions,
): Promise<CompactDrainResult> {
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new RangeError("compact drain retry delay must be positive");
  }
  const waitForRetry = options.waitForRetry ?? ((delayMs: number): Promise<void> =>
    new Promise<void>(resolve => { setTimeout(resolve, delayMs); }));
  const session: CompactDrainSession = options.session ?? { restartAttempted: false };
  while (true) {
    const result = await cancelAndDrainCompactInvocation({ ...options, session });
    if (result.daemonZero && result.localSettled) return result;
    await waitForRetry(retryDelayMs);
  }
}

/** Parse the canonical unsigned decimal form accepted by --max-concurrency. */
export function parseCompactConcurrency(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ConfigValidationError(
      "compact.maxConcurrency",
      "--max-concurrency requires canonical unsigned decimal text",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < DEFAULT_LLM_MAX_CONCURRENCY || parsed > MAX_LLM_MAX_CONCURRENCY) {
    throw new ConfigValidationError(
      "compact.maxConcurrency",
      `--max-concurrency must be an integer between ${DEFAULT_LLM_MAX_CONCURRENCY} and ${MAX_LLM_MAX_CONCURRENCY}`,
    );
  }
  return parsed;
}

/** Resolve one compact invocation's effective worker concurrency. */
export function resolveCompactConcurrency(
  config: Pick<DaemonConfig, "llm">,
  options: { maxConcurrency?: string; replay?: boolean } = {},
): number {
  const explicit = options.maxConcurrency === undefined
    ? undefined
    : parseCompactConcurrency(options.maxConcurrency);
  if (options.replay === true && explicit !== undefined && explicit > 1) {
    throw new ConfigValidationError(
      "compact.maxConcurrency",
      "--max-concurrency values above 1 are not supported with --replay",
    );
  }
  if (explicit !== undefined) return explicit;
  if (options.replay === true) return 1;
  const stored = config.llm.maxConcurrency ?? DEFAULT_LLM_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(stored) || stored < DEFAULT_LLM_MAX_CONCURRENCY || stored > MAX_LLM_MAX_CONCURRENCY) {
    throw new ConfigValidationError(
      "llm.maxConcurrency",
      `must be an integer between ${DEFAULT_LLM_MAX_CONCURRENCY} and ${MAX_LLM_MAX_CONCURRENCY}`,
    );
  }
  return stored;
}

function numericOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return Number.NaN;
  return Number(value);
}

function hasCompactRequestPolicyOverride(options: CompactRequestPolicyOptions): boolean {
  return options.timeoutMs !== undefined
    || options.retryMaxAttempts !== undefined
    || options.retryInitialDelayMs !== undefined
    || options.retryMaxDelayMs !== undefined
    || options.retryMultiplier !== undefined;
}

/** Validate and resolve one-invocation timeout/retry flags over loaded config. */
export function resolveCompactRequestPolicyOverride(
  config: LlmRequestPolicyConfig,
  options: CompactRequestPolicyOptions,
): LlmInvocationRequestPolicy | undefined {
  const requestTimeoutMs = numericOption(options.timeoutMs);
  const retry = {
    maxAttempts: numericOption(options.retryMaxAttempts),
    initialDelayMs: numericOption(options.retryInitialDelayMs),
    maxDelayMs: numericOption(options.retryMaxDelayMs),
    multiplier: numericOption(options.retryMultiplier),
  };
  const hasRetryOverride = Object.values(retry).some((value) => value !== undefined);
  const hasOverride = requestTimeoutMs !== undefined || hasRetryOverride;
  if (!hasOverride) return undefined;
  if (requestTimeoutMs !== undefined && !supportsRequestTimeout(config.llm.provider)) {
    throw new ConfigValidationError(
      "compact",
      "timeout overrides require llm.provider=\"auto\", \"openai\", \"claude-process\", or \"codex-process\"",
    );
  }
  if (hasRetryOverride && config.llm.provider !== "openai") {
    throw new ConfigValidationError(
      "compact",
      "retry overrides require llm.provider=\"openai\"",
    );
  }
  const effectivePolicy = resolveLlmRequestPolicy(
    { requestTimeoutMs: config.llm.requestTimeoutMs, retry: config.llm.retry },
    {
      requestTimeoutMs,
      retry: hasRetryOverride ? retry : undefined,
    },
    "compact",
  );
  return config.llm.provider === "openai"
    ? effectivePolicy
    : { requestTimeoutMs: effectivePolicy.requestTimeoutMs };
}

export function compactFailureExitCode(failures: number): 1 | undefined {
  return failures > 0 ? 1 : undefined;
}

/** Manual batch requests identify as Claude, so auto resolves to its process provider. */
export function resolveManualCompactProvider(provider: LlmProvider): LlmProvider {
  return provider === "auto" ? "claude-process" : provider;
}

function withHookClient(stdinText: string, client: unknown): string {
  return withHookOverrides(stdinText, client, undefined);
}

async function withCustomHelp(cmd: Command, commandName: string): Promise<never> {
  const { printHelp } = await import("../src/cli-help.js");
  printHelp(commandName);
  exit(0);
}

type DaemonStartOptions = {
  help?: boolean;
  detach?: boolean;
  foreground?: boolean;
  internalLcmTestDaemonOwner?: string;
  internalLcmTestDaemonEntrypoint?: string;
};

type DaemonRootOptions = {
  help?: boolean;
};

const ROOT_BOOTSTRAP_RETRY_ATTEMPTS = 20;
const ROOT_BOOTSTRAP_RETRY_DELAY_MS = 50;

export type RootBootstrapRetrySeams = {
  readonly migrate: () => unknown;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly attempt?: (attempt: number) => void;
};

const DEFAULT_ROOT_BOOTSTRAP_RETRY_SEAMS: Omit<RootBootstrapRetrySeams, "migrate"> = {
  sleep: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
};

export async function migrateLegacyHomeWithRetry(
  seams: RootBootstrapRetrySeams,
): Promise<void> {
  for (let attempt = 1; attempt <= ROOT_BOOTSTRAP_RETRY_ATTEMPTS; attempt += 1) {
    seams.attempt?.(attempt);
    try {
      seams.migrate();
      return;
    } catch (error) {
      if (!(error instanceof BootstrapLockContentionError)
        || attempt === ROOT_BOOTSTRAP_RETRY_ATTEMPTS) {
        throw error;
      }
      await seams.sleep(ROOT_BOOTSTRAP_RETRY_DELAY_MS);
    }
  }
}

/** @internal Verifies that Commander preserved the preflighted hidden identity. */
export function assertParsedInternalDaemonTestIdentity(
  opts: Pick<
    DaemonStartOptions,
    "internalLcmTestDaemonOwner" | "internalLcmTestDaemonEntrypoint"
  >,
  identity: DaemonLifecycleTestIdentity | undefined,
): void {
  if (
    opts.internalLcmTestDaemonOwner !== identity?.ownerId
    || opts.internalLcmTestDaemonEntrypoint !== identity?.entrypoint
  ) {
    throw new Error("Internal daemon test identity did not survive CLI parsing intact");
  }
}

export function shouldRunMain(invokedPath: string | undefined, currentFilePath: string): boolean {
  if (!invokedPath) return false;

  try {
    return realpathSync(invokedPath) === realpathSync(currentFilePath);
  } catch {
    return invokedPath === currentFilePath;
  }
}

type CustomHelpRequest = {
  command?: string;
};

function strictlyContainsPath(parent: string, candidate: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(candidate)) return false;
  const rel = relative(resolve(parent), resolve(candidate));
  return isStrictContainedRelativePath(rel);
}

/** @internal Cross-platform guard for path.relative containment results. */
export function isStrictContainedRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && !relativePath.startsWith("..")
    && !isAbsolute(relativePath);
}

function internalOptionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === option) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Incomplete internal daemon test identity: ${option} requires a value`);
      }
      values.push(value);
      index++;
    } else if (arg.startsWith(`${option}=`)) {
      const value = arg.slice(option.length + 1);
      if (value.length === 0) {
        throw new Error(`Incomplete internal daemon test identity: ${option} requires a value`);
      }
      values.push(value);
    }
  }
  return values;
}

function resolveInternalDaemonTestIdentity(
  cliArgv: readonly string[],
): DaemonLifecycleTestIdentity | undefined {
  const args = cliArgv.slice(2);
  const terminatorIndex = args.indexOf("--");
  const effectiveArgs = terminatorIndex === -1
    ? args
    : args.slice(0, terminatorIndex);
  const owners = internalOptionValues(args, DAEMON_TEST_OWNER_OPTION);
  const entrypoints = internalOptionValues(args, DAEMON_TEST_ENTRYPOINT_OPTION);
  if (owners.length === 0 && entrypoints.length === 0) return undefined;
  if (owners.length !== 1 || entrypoints.length !== 1) {
    throw new Error("Internal daemon test identity must provide one complete owner and entrypoint pair");
  }
  if (
    internalOptionValues(effectiveArgs, DAEMON_TEST_OWNER_OPTION).length !== owners.length
    || internalOptionValues(effectiveArgs, DAEMON_TEST_ENTRYPOINT_OPTION).length !== entrypoints.length
    || effectiveArgs[0] !== "daemon"
    || effectiveArgs[1] !== "start"
    || !effectiveArgs.includes("--foreground")
  ) {
    throw new Error("Internal daemon test identity is restricted to foreground daemon startup");
  }
  const identity = { ownerId: owners[0]!, entrypoint: entrypoints[0]! };
  if (!isDaemonLifecycleTestIdentity(identity)) {
    throw new Error("Internal daemon test identity is malformed");
  }
  const homeDir = process.env.HOME;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (
    process.env.LCM_DAEMON_OWNER_ID !== identity.ownerId
    || homeDir === undefined
    || runtimeDir === undefined
    || resolve(homeDir) === resolve("/")
    || !strictlyContainsPath(homeDir, runtimeDir)
    || !strictlyContainsPath(homeDir, identity.entrypoint)
  ) {
    throw new Error("Internal daemon test identity is not confined to an isolated lifecycle environment");
  }
  const lcDir = lcmHomeDir();
  const pidPath = daemonPidPath();
  const tokenPath = daemonTokenPath();
  if (
    !strictlyContainsPath(homeDir, lcDir)
    || !strictlyContainsPath(lcDir, pidPath)
    || !strictlyContainsPath(lcDir, tokenPath)
  ) {
    throw new Error("Internal daemon test state is not confined to the isolated lifecycle home");
  }
  if (
    !isCanonicalLifecycleTestDirectory(homeDir)
    || !isCanonicalLifecycleTestDirectory(runtimeDir)
    || !isCanonicalLifecycleTestDirectory(lcDir)
    || !isCanonicalLifecycleTestRegularFile(identity.entrypoint)
    || !isCanonicalOrMissingLifecycleTestStateFile(
      pidPath,
      join(lcDir, "daemon.pid"),
    )
    || !isCanonicalOrMissingLifecycleTestStateFile(
      tokenPath,
      join(lcDir, "daemon.token"),
    )
  ) {
    throw new Error("Internal daemon test filesystem is not canonical owned state");
  }
  return identity;
}

/** Resolve custom help before Commander can dispatch a nested command action. */
function resolveCustomHelpRequest(cliArgv: string[]): CustomHelpRequest | undefined {
  const args = cliArgv.slice(2);
  if (args.length === 0) return {};
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) return {};
  const terminator = args.indexOf("--");
  const optionArgs = terminator === -1 ? args : args.slice(0, terminator);
  if (!optionArgs.includes("-h") && !optionArgs.includes("--help")) return undefined;

  const [command] = optionArgs;
  if (command === "help") {
    const topic = optionArgs[1];
    return topic === undefined || topic === "-h" || topic === "--help"
      ? {}
      : { command: topic };
  }
  return { command };
}

type PublicationAdmissionRunner = <T>(run: () => T | Promise<T>) => Promise<T>;

function isNestedUnderRoot(actionCommand: Command, parentName: string, actionName?: string): boolean {
  const parent = actionCommand.parent;
  return parent?.name() === parentName
    && parent.parent?.name() === "lcm"
    && (actionName === undefined || actionCommand.name() === actionName);
}

function shouldRunRootBootstrapMigration(actionCommand: Command): boolean {
  const action = actionCommand.name();
  const topLevel = actionCommand.parent?.name() === "lcm";
  if (topLevel && (
    action === "search"
    || action === "grep"
    || action === "describe"
    || action === "expand"
  )) return false;
  if (topLevel && action === "post-tool") return false;
  if (topLevel && action === "status") return false;
  if (topLevel && action === "stats") return actionCommand.opts<Record<string, unknown>>().pool !== true;
  if (topLevel && (action === "diagnose" || action === "help")) return false;
  if ((action === "list" || action === "doctor") && actionCommand.parent?.name() === "connectors") return false;
  if (topLevel && ["daemon", "config", "machine", "project", "postgres", "events", "connectors"].includes(action)) return false;
  return true;
}

function shouldUsePublicationConvergence(actionCommand: Command): boolean {
  const action = actionCommand.name();
  const topLevel = actionCommand.parent?.name() === "lcm";
  if (topLevel && (action === "install" || action === "doctor")) return true;
  if (topLevel && action === "stats") return actionCommand.opts<Record<string, unknown>>().pool !== true;
  if (topLevel && action === "export") return true;
  if (isNestedUnderRoot(actionCommand, "machine", "show")) return true;
  if (isNestedUnderRoot(actionCommand, "project", "list")
    || isNestedUnderRoot(actionCommand, "project", "show")) return true;
  if (isNestedUnderRoot(actionCommand, "config", "get")) return true;
  if (isNestedUnderRoot(actionCommand, "events", "status")
    || isNestedUnderRoot(actionCommand, "events", "validate")
    || isNestedUnderRoot(actionCommand, "events", "quarantine")) return true;
  if (topLevel && action === "sensitive") {
    const processed = actionCommand.processedArgs[0] as unknown;
    return Array.isArray(processed) && (processed[0] === "list" || processed[0] === "test");
  }
  return false;
}

type DaemonClientOptions = {
  /** Temporary guard for the SQLite-only pool diagnostic. */
  requireSqlite?: boolean;
  readonly preflightStorage?: boolean;
  readonly rootBootstrapComplete?: boolean;
};

type DaemonClientProvider = (options?: DaemonClientOptions) => Promise<DaemonClient>;

export function registerMemoryCommands(
  program: Command,
  daemonClient: DaemonClientProvider = createDaemonClientOrExit,
): void {
  program
    .command("search <query>")
    .description("Search memory across episodic and promoted layers")
    .option("--limit <n>", "Max results per layer", "5")
    .option("--layer <name>", "Layer to search: episodic or promoted (repeatable)", collectRepeatedOption, [])
    .option("--tag <tag>", "Filter promoted entries by all specified tags; episodic history remains unfiltered (repeatable)", collectRepeatedOption, [])
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      const layers = normalizeStringList(opts.layer);
      const tags = normalizeStringList(opts.tag) ?? [];
      ensureAllowedValues(layers, ["episodic", "promoted"], "--layer");

      const client = await daemonClient();
      const result = await client.post("/search", {
        cwd: process.cwd(),
        query,
        limit: parsePositiveInteger(String(opts.limit ?? "5"), "--limit"),
        layers,
        tags,
      });
      printJson(result);
    });

  program
    .command("grep <query>")
    .description("Search raw messages and summaries by keyword or regex")
    .option("--mode <mode>", "Search mode: full_text or regex", "full_text")
    .option("--scope <scope>", "Scope: messages, summaries, or both", "both")
    .option("--since <iso>", "Inclusive lower bound: YYYY-MM-DDTHH:mm:ss[.S{1,3}](Z|+/-HH:mm); invalid values return HTTP 400")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (query: string, opts) => {
      const mode = ensureAllowedValue(opts.mode, ["full_text", "regex"], "--mode");
      const scope = ensureAllowedValue(opts.scope, ["messages", "summaries", "both"], "--scope");

      const client = await daemonClient();
      const result = await client.post("/grep", {
        cwd: process.cwd(),
        query,
        mode,
        scope,
        since: typeof opts.since === "string" ? opts.since : undefined,
      });
      printJson(result);
    });

  program
    .command("describe <nodeId>")
    .description("Inspect metadata for a summary or stored memory node")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("describe"); exit(0);
      }

      const client = await daemonClient();
      const result = await client.post("/describe", { cwd: process.cwd(), nodeId });
      printJson(result);
    });

  program
    .command("expand <nodeId>")
    .description("Expand a summary node back into source detail")
    .option("--depth <n>", "Traversal depth", "1")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (nodeId: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("expand"); exit(0);
      }

      const client = await daemonClient();
      const result = await client.post("/expand", {
        cwd: process.cwd(),
        nodeId,
        depth: parsePositiveInteger(String(opts.depth ?? "1"), "--depth"),
      });
      printJson(result);
    });

  program
    .command("store <text>")
    .description("Store a durable memory entry for the current project")
    .option(
      "--tag, --tags <tag>",
      "Attach a tag to the stored memory (repeatable)",
      collectRepeatedOption,
      [],
    )
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (text: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("store"); exit(0);
      }

      const client = await daemonClient({ rootBootstrapComplete: true });
      const result = await client.post("/store", {
        cwd: process.cwd(),
        text,
        tags: normalizeStringList(opts.tags) ?? [],
        metadata: {},
      });
      printJson(result);
    });
}

async function loadIdentityStorageConfig() {
  const { loadDaemonConfig } = await import("../src/daemon/config.js");
  return loadDaemonConfig(defaultConfigPath()).storage;
}

interface PassiveEventOperatorSession {
  readonly local: LocalHookOutboxRepository;
  readonly remote: PostgreSqlPassiveEventRepository;
  close(): Promise<void>;
}

async function openPassiveEventOperatorSession(): Promise<PassiveEventOperatorSession> {
  const storage = await loadIdentityStorageConfig();
  if (storage.backend !== "postgresql") {
    throw new Error(
      "remote passive-event commands require storage.backend \"postgresql\"",
    );
  }
  const [{ resolveProjectIdentity }, { ensureWorktreeProjectReconciled }, { requireMachineIdentity }, runtimeModule, repositoryModule, outboxModule, pathModule] =
    await Promise.all([
      import("../src/project-map.js"),
      import("../src/worktree-reconciliation.js"),
      import("../src/machine-identity.js"),
      import("../src/storage/postgresql/runtime.js"),
      import("../src/storage/postgresql/passive-event-repository.js"),
      import("../src/storage/local-hook-outbox.js"),
      import("../src/db/events-path.js"),
    ]);
  ensureWorktreeProjectReconciled(process.cwd());
  const project = resolveProjectIdentity(process.cwd());
  if (!project.remoteProjectId) {
    throw new Error(
      "local project has no PostgreSQL binding; run `lcm project create` or `lcm project link <project-id>`",
    );
  }
  const machine = requireMachineIdentity();
  const runtime = new runtimeModule.PostgreSqlRuntime(storage.postgresql);
  const outboxFactory = new outboxModule.SQLiteLocalHookOutboxFactory();
  let local: LocalHookOutboxRepository | undefined;
  try {
    const health = await runtime.health();
    if (health.status !== "healthy") {
      throw health.error ?? new Error("PostgreSQL passive-event storage is unavailable");
    }
    local = await outboxFactory.open(pathModule.eventsDbPath(process.cwd()));
    return {
      local,
      remote: new repositoryModule.PostgreSqlPassiveEventRepository(
        runtime,
        project.remoteProjectId,
        machine.machineId,
      ),
      close: async () => {
        await Promise.all([
          outboxFactory.close(),
          runtime.close(),
        ]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      outboxFactory.close(),
      runtime.close(),
    ]);
    throw error;
  }
}

async function withPassiveEventOperatorSession<T>(
  operation: (session: PassiveEventOperatorSession) => Promise<T>,
): Promise<T> {
  const session = await openPassiveEventOperatorSession();
  try {
    return await operation(session);
  } finally {
    await session.close();
  }
}

function passiveEventReadbackMatches(
  local: LocalHookEventRow,
  remote: PostgreSqlPassiveEventRecord,
): boolean {
  const payload = remote.payload as Record<string, unknown>;
  return local.machine_id === remote.machineId
    && local.event_uuid === remote.eventId
    && local.event_version === remote.eventVersion
    && BigInt(local.machine_sequence) === remote.machineSequence
    && local.type === remote.eventType
    && payload.sessionId === local.session_id
    && payload.sessionSequence === local.seq
    && payload.category === local.category
    && payload.data === local.data
    && payload.priority === local.priority
    && payload.sourceHook === local.source_hook
    && payload.previousEventId === local.prev_event_id
    && payload.createdAt === local.created_at;
}

function serializablePassiveEvent(record: PostgreSqlPassiveEventRecord): Record<string, unknown> {
  return {
    ...record,
    inboxId: record.inboxId.toString(),
    machineSequence: record.machineSequence.toString(),
  };
}

function serializableCoordinationDiagnostics(
  diagnostics: Awaited<ReturnType<PostgreSqlPassiveEventRepository["getDiagnostics"]>>,
): Record<string, unknown> {
  return {
    leases: {
      ...diagnostics.leases,
      active: diagnostics.leases.active.toString(),
      expired: diagnostics.leases.expired.toString(),
      released: diagnostics.leases.released.toString(),
    },
    queue: {
      ...diagnostics.queue,
      pending: diagnostics.queue.pending.toString(),
      claimed: diagnostics.queue.claimed.toString(),
      retry: diagnostics.queue.retry.toString(),
      applied: diagnostics.queue.applied.toString(),
      quarantined: diagnostics.queue.quarantined.toString(),
    },
  };
}

export function registerProjectCommand(
  program: Command,
  publicationRetry?: PublicationAdmissionRunner,
): void {
  type ProjectOptions = {
    help?: boolean;
    json?: boolean;
    name?: string;
    allowExistingData?: boolean;
    dryRun?: boolean;
  };

  const projectError = (err: unknown, opts: { json?: boolean } = {}): never => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      printJson({ error: message });
    } else {
      console.error(`Error: ${message}`);
    }
    exit(1);
  };

  const projectCmd = new Command("project").description("Manage local and PostgreSQL project identities");
  projectCmd.helpOption(false).option("-h, --help", "Show help");
  const projectHelpRequested = (opts: ProjectOptions): boolean =>
    opts.help === true || projectCmd.opts<ProjectOptions>().help === true;
  projectCmd.action(async (opts: ProjectOptions) => {
    if (projectHelpRequested(opts)) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("project"); exit(0);
    }
    console.error("Usage: lcm project <create|link|unlink|list|show|reconcile-worktrees> [options]");
    exit(1);
  });

  projectCmd
    .command("reconcile-worktrees [path]")
    .description("Preview or reconcile local state from linked and deleted Codex worktrees")
    .option("--dry-run", "Preview without changing local state")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { reconcileWorktrees } = await import("../src/worktree-reconciliation.js");
        const result = reconcileWorktrees(path ?? process.cwd(), { dryRun: opts.dryRun });
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`worktree reconciliation: ${result.status}`);
        console.log(`  canonical: ${sanitizeTerminalText(result.canonical)}`);
        console.log(`  project: ${result.targetHash}`);
        console.log(`  sources: ${result.sourceHashes.length}`);
        if (result.journalPath) {
          console.log(`  journal: ${sanitizeTerminalText(result.journalPath)}`);
        }
        for (const backup of result.backupPaths) {
          console.log(`  backup: ${sanitizeTerminalText(backup)}`);
        }
        if (result.reason) console.log(`  reason: ${sanitizeTerminalText(result.reason)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("list")
    .description("List local projects and configured PostgreSQL identities")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { listProjects } = await import("../src/identity-service.js");
        const read = async () => listProjects(await loadIdentityStorageConfig());
        const result = publicationRetry === undefined ? await read() : await publicationRetry(read);
        if (opts.json) {
          printJson(result);
          return;
        }
        for (const entry of result.local) {
          console.log(entry.hash);
          console.log(`  canonical: ${sanitizeTerminalText(entry.canonical)}`);
          if (entry.remoteProjectId) console.log(`  PostgreSQL project: ${entry.remoteProjectId}`);
          for (const alias of entry.aliases) {
            console.log(`  alias: ${sanitizeTerminalText(alias)}`);
          }
        }
        if (result.remote) {
          console.log("PostgreSQL projects:");
          for (const remote of result.remote) {
            console.log(`  ${remote.projectId}  ${sanitizeTerminalText(remote.displayName)}`);
            for (const alias of remote.aliases) {
              console.log(`    ${alias.machineId}: ${sanitizeTerminalText(alias.path)}`);
            }
          }
        }
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("show [target]")
    .description("Show one local project and its PostgreSQL identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (target: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { showProject } = await import("../src/identity-service.js");
        const read = async () => showProject(await loadIdentityStorageConfig(), target);
        const shown = publicationRetry === undefined ? await read() : await publicationRetry(read);
        if (opts.json) {
          printJson(shown);
          return;
        }
        console.log(shown.hash);
        console.log(`  canonical: ${sanitizeTerminalText(shown.entry.canonical)}`);
        if (shown.entry.remoteProjectId) {
          console.log(`  PostgreSQL project: ${shown.entry.remoteProjectId}`);
        }
        for (const alias of shown.entry.aliases) {
          console.log(`  alias: ${sanitizeTerminalText(alias)}`);
        }
        if (shown.remote) console.log(`  name: ${sanitizeTerminalText(shown.remote.displayName)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("link [target] [path]")
    .description("Link a path to a PostgreSQL UUID or local project target")
    .option("--allow-existing-data", "Acknowledge rebinding a data-bearing local project")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (target: string | undefined, path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        if (!target) throw new Error("missing required argument 'target'");
        const { linkProject } = await import("../src/identity-service.js");
        const result = await linkProject(
          await loadIdentityStorageConfig(),
          target,
          path,
          { allowExistingData: opts.allowExistingData },
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`Linked ${sanitizeTerminalText(result.local.canonical)}`);
        console.log(`  local hash: ${result.local.id}`);
        if (result.local.remoteProjectId) {
          console.log(`  PostgreSQL project: ${result.local.remoteProjectId}`);
        }
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("unlink [path]")
    .description("Remove a local alias or PostgreSQL project binding")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { unlinkProject } = await import("../src/identity-service.js");
        const result = await unlinkProject(await loadIdentityStorageConfig(), path);
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(
          `${result.aliasRemoved ? "Removed project alias from" : "Unbound PostgreSQL project from"} ${result.hash}`,
        );
      } catch (err) {
        projectError(err, opts);
      }
    });

  projectCmd
    .command("create [path]")
    .description("Create a PostgreSQL project and bind a local path")
    .option("--name <display-name>", "Human-readable project name")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (path: string | undefined, opts: ProjectOptions) => {
      if (projectHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("project"); exit(0);
      }
      try {
        const { createProject } = await import("../src/identity-service.js");
        const result = await createProject(
          await loadIdentityStorageConfig(),
          path,
          { displayName: opts.name },
        );
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(`Created PostgreSQL project ${result.remote.projectId}`);
        console.log(`  local hash: ${result.local.id}`);
        console.log(`  path: ${sanitizeTerminalText(result.local.canonical)}`);
      } catch (err) {
        projectError(err, opts);
      }
    });

  program.addCommand(projectCmd);
}

export function registerMachineCommand(program: Command): void {
  type MachineOptions = {
    help?: boolean;
    json?: boolean;
    name?: string;
    force?: boolean;
  };
  const machineError = (err: unknown, opts: MachineOptions): never => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) printJson({ error: message });
    else console.error(`Error: ${message}`);
    exit(1);
  };
  const machineCmd = new Command("machine").description("Manage this machine's PostgreSQL identity");
  machineCmd.helpOption(false).option("-h, --help", "Show help");
  const machineHelpRequested = (opts: MachineOptions): boolean =>
    opts.help === true || machineCmd.opts<MachineOptions>().help === true;
  machineCmd.action(async (opts: MachineOptions) => {
    if (machineHelpRequested(opts)) {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp("machine"); exit(0);
    }
    console.error("Usage: lcm machine <register|show|recover> [options]");
    exit(1);
  });

  machineCmd
    .command("register")
    .description("Register or refresh this machine in PostgreSQL")
    .option("--name <display-name>", "Human-readable machine name")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        const { registerMachine } = await import("../src/identity-service.js");
        const result = await registerMachine(
          await loadIdentityStorageConfig(),
          { displayName: opts.name },
        );
        const output = {
          registered: true,
          created: result.created,
          machineId: result.identity.machineId,
          displayName: result.identity.displayName,
          version: result.identity.version,
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(`${result.created ? "Registered" : "Refreshed"} machine ${output.machineId}`);
        console.log(`  name: ${output.displayName}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  machineCmd
    .command("show")
    .description("Show this machine's local identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        const { showMachine } = await import("../src/identity-service.js");
        const shown = showMachine();
        if (!shown) throw new Error("machine identity is not registered; run `lcm machine register`");
        const output = {
          version: shown.version,
          status: shown.machineId === null ? "pending" : "registered",
          machineId: shown.machineId,
          displayName: shown.displayName,
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(output.machineId ?? "pending");
        console.log(`  status: ${output.status}`);
        console.log(`  name: ${output.displayName}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  machineCmd
    .command("recover [machine-id]")
    .description("Recover a machine identity by its PostgreSQL UUID")
    .option("--force", "Replace and privately back up a conflicting local identity")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (machineId: string | undefined, opts: MachineOptions) => {
      if (machineHelpRequested(opts)) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("machine"); exit(0);
      }
      try {
        if (!machineId) throw new Error("missing required argument 'machine-id'");
        const { recoverMachine } = await import("../src/identity-service.js");
        const result = await recoverMachine(
          await loadIdentityStorageConfig(),
          machineId,
          { force: opts.force },
        );
        const output = {
          recovered: true,
          machineId: result.identity.machineId,
          displayName: result.identity.displayName,
          ...(result.backupPath ? { backupPath: result.backupPath } : {}),
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        console.log(`Recovered machine ${output.machineId}`);
        console.log(`  name: ${output.displayName}`);
        if (output.backupPath) console.log(`  backup: ${output.backupPath}`);
      } catch (err) {
        machineError(err, opts);
      }
    });

  program.addCommand(machineCmd);
}

export function registerPostgreSqlCommand(program: Command): void {
  type PostgreSqlOptions = {
    help?: boolean;
    json?: boolean;
  };
  const postgresCmd = new Command("postgres")
    .description("Provision and maintain PostgreSQL storage");
  postgresCmd.helpOption(false).option("-h, --help", "Show help");
  postgresCmd.action(async () => {
    console.error("Usage: lcm postgres migrate [--json]");
    exit(1);
  });

  postgresCmd
    .command("migrate")
    .description("Apply packaged PostgreSQL schema migrations")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: PostgreSqlOptions) => {
      try {
        const { provisionPostgreSql } = await import(
          "../src/storage/postgresql/provisioning.js"
        );
        const result = await provisionPostgreSql(await loadIdentityStorageConfig());
        const output = {
          backend: "postgresql",
          applied: [...result.applied],
          current: [...result.current],
        };
        if (opts.json) {
          printJson(output);
          return;
        }
        if (output.applied.length === 0) {
          console.log("PostgreSQL schema is current.");
        } else {
          console.log(
            `Applied ${output.applied.length} PostgreSQL migration${output.applied.length === 1 ? "" : "s"}: ${output.applied.join(", ")}`,
          );
        }
        console.log(`  current migrations: ${output.current.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) printJson({ error: message });
        else console.error(`Error: ${message}`);
        exit(1);
      }
    });

  program.addCommand(postgresCmd);
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.error(`Invalid ${optionName}: ${value}`);
    exit(1);
  }
  return parsed;
}

function parsePositiveIntegerOrAll(value: string, optionName: string): number {
  if (value === "all" || value === "unlimited") return Number.MAX_SAFE_INTEGER;
  return parsePositiveInteger(value, optionName);
}

function ensureAllowedValues(values: string[] | undefined, allowed: readonly string[], optionName: string): void {
  if (!values) return;
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) {
    console.error(`Invalid ${optionName}: ${invalid.join(", ")}`);
    exit(1);
  }
}

function ensureAllowedValue(value: unknown, allowed: readonly string[], optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    console.error(`Invalid ${optionName}: ${String(value)}`);
    exit(1);
  }
  return value;
}

function printJson(value: unknown): void {
  stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** @internal Output seams used by the executable's Commander configuration. */
export function writeCliOutput(value: string): void {
  stdout.write(value);
}

/** @internal Output seams used by the executable's Commander configuration. */
export function writeCliError(value: string): void {
  process.stderr.write(value);
}

type LifecycleResultWithRefusal = Readonly<{
  connected?: boolean;
  refusalReason?: unknown;
}>;

function daemonRefusalReason(
  result: LifecycleResultWithRefusal | undefined,
  fallback: DaemonRefusalReason = "ambiguous",
): DaemonRefusalReason {
  return isDaemonRefusalReason(result?.refusalReason) ? result.refusalReason : fallback;
}

function daemonRemediationScope(): Readonly<{ scope: string; stateRoot: string }> {
  const root = lcmHomeDir(homedir());
  try {
    const canonical = realpathSync(root);
    return { scope: canonical, stateRoot: canonical };
  } catch {
    const lexical = resolve(root);
    return { scope: lexical, stateRoot: lexical };
  }
}

function daemonUnavailableMessage(
  result: LifecycleResultWithRefusal | undefined,
  fallback: DaemonRefusalReason,
): string {
  return mapDaemonRefusalToRemediation(daemonRefusalReason(result, fallback)).message;
}

function clearDaemonRemediationMarker(): void {
  clearDaemonRemediation(daemonRemediationScope());
}

type DaemonClientWithConfig = Readonly<{
  client: DaemonClient;
  config: DaemonConfig;
  health?: DaemonHealth;
}>;

async function createDaemonClientOrExitWithConfig(
  options: DaemonClientOptions = {},
): Promise<DaemonClientWithConfig> {
  const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
  const { loadDaemonConfig } = await import("../src/daemon/config.js");
  const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");

  const configFile = defaultConfigPath();
  const config = loadDaemonConfig(configFile);
  if (options.requireSqlite && config.storage.backend === "postgresql") throw new StorageBackendUnavailableError("postgresql");
  if (options.preflightStorage !== false) selectStorageBackendForConfig(configFile, config.storage);
  const port = config.daemon?.port ?? 3737;
  const pidFilePath = daemonPidPath();
  const tokenPath = daemonTokenPath();
  let result: LifecycleResultWithRefusal & { connected: boolean };
  try {
    result = await ensureDaemon({
      port,
      pidFilePath,
      spawnTimeoutMs: 5000,
      expectedStorageBackend: config.storage.backend,
      enforceUserManagerParent: true,
    });
  } catch {
    console.error(`  ${daemonUnavailableMessage(undefined, "ambiguous")}`);
    exit(1);
  }

  if (!result.connected) {
    console.error(`  ${daemonUnavailableMessage(result, "not-running")}`);
    exit(1);
  }
  clearDaemonRemediationMarker();

  return {
    client: new DaemonClient(`http://127.0.0.1:${port}`, tokenPath),
    config,
  };
}

async function createDaemonClientOrExit(
  options: DaemonClientOptions = {},
): Promise<DaemonClient> {
  return (await createDaemonClientOrExitWithConfig(options)).client;
}

async function createDaemonReadClientOrExit(
  preflightSeams?: RootBootstrapRetrySeams,
  options: DaemonClientOptions = {},
): Promise<DaemonClientWithConfig> {
  const configPath = defaultConfigPath();
  try {
    const first = readDaemonConfigSnapshot(configPath);
    if (options.requireSqlite && first.config.storage.backend === "postgresql") throw new StorageBackendUnavailableError("postgresql");
    const tokenPath = daemonTokenPath();
    const { readAuthToken } = await import("../src/daemon/auth.js");
    const token = readAuthToken(tokenPath);
    if (typeof token === "string" && token.length > 0) {
      const port = first.config.daemon.port;
      const client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
      const health = await client.health();
      if (
        (health?.status === "ok" || health?.status === "healthy")
        && typeof PKG_VERSION === "string"
        && health.version === PKG_VERSION
        && health.storageBackend === first.config.storage.backend
        && typeof health.entrypoint === "string"
        && health.entrypoint.length > 0
        && PACKAGED_RUNTIME_ENTRYPOINT !== undefined
        && daemonEntrypointMatches(
          health.entrypoint,
          PACKAGED_RUNTIME_ENTRYPOINT,
          process.platform,
        )
        && typeof health.runtimeDigest === "string"
        && health.runtimeDigest.length > 0
        && RUNTIME_DIGEST !== undefined
        && health.runtimeDigest === RUNTIME_DIGEST
      ) {
        const second = readDaemonConfigSnapshot(configPath);
        if (
          second.config.storage.backend === first.config.storage.backend
          && daemonConfigSnapshotWitnessEqual(first.witness, second.witness)
        ) {
          return { client, config: second.config, health };
        }
      }
    }
  } catch (error) {
    if (error instanceof StorageBackendUnavailableError) throw error;
    // Any snapshot, token, health, or witness failure falls back to the
    // existing authenticated migration and lifecycle path below.
  }

  if (options.rootBootstrapComplete !== true) {
    await migrateLegacyHomeWithRetry({
      migrate: preflightSeams?.migrate ?? migrateLegacyHomeIfNeeded,
      sleep: preflightSeams?.sleep ?? DEFAULT_ROOT_BOOTSTRAP_RETRY_SEAMS.sleep,
      attempt: preflightSeams?.attempt,
    });
  }
  return createDaemonClientOrExitWithConfig(options);
}

/** @internal CLI entry seam; defaults preserve the published executable behavior. */
export async function runCli(
  cliArgv: string[] = process.argv,
  preflightSeams?: RootBootstrapRetrySeams,
): Promise<void> {
  const customHelp = resolveCustomHelpRequest(cliArgv);
  if (customHelp && cliArgv.slice(2).length > 0) {
    const cliHelp = await import("../src/cli-help.js");
    const hasCommandHelp = Object.prototype.hasOwnProperty.call(cliHelp, "hasCommandHelp")
      ? (cliHelp as { hasCommandHelp?: unknown }).hasCommandHelp
      : undefined;
    if (customHelp.command === undefined
      || (typeof hasCommandHelp === "function" && hasCommandHelp(customHelp.command))) {
      cliHelp.printHelp(customHelp.command);
      exit(0);
    }
  }

  const internalDaemonTestIdentity = resolveInternalDaemonTestIdentity(cliArgv);
  const migrate = preflightSeams?.migrate ?? migrateLegacyHomeIfNeeded;
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const pkgPath = join(packageRootFor(import.meta.url, 2), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  const program = new Command();
  let publicationConvergence: import("../src/storage/publication-convergence.js").PublicationConvergence | undefined;
  let publicationAdmissionRetry: PublicationAdmissionRunner | undefined;
  const runWithPublicationRetry: PublicationAdmissionRunner = async <T>(run: () => T | Promise<T>) =>
    publicationAdmissionRetry === undefined
      ? await run()
      : await publicationAdmissionRetry(run);
  program
    .name("lcm")
    .description("Long Context Manager for coding agents")
    .version(pkg.version, "-V, --version")
    .helpCommand(false)
    .addHelpCommand(false)
    .configureOutput({
      writeOut: writeCliOutput,
      writeErr: writeCliError,
    });

  // Disable Commander's built-in help entirely — we handle it manually below
  program.helpOption(false);

  // ─── help command ──────────────────────────────────────────────────────────
  program
    .command("help [command]")
    .description("Show help for a command")
    .action(async (subcommand?: string) => {
      const { printHelp } = await import("../src/cli-help.js");
      printHelp(subcommand);
      exit(0);
    });

  // ─── daemon ────────────────────────────────────────────────────────────────
  const daemonCmd = new Command("daemon").description("Start the context daemon");
  daemonCmd.helpOption(false).option("-h, --help", "Show help");
  daemonCmd.command("start")
    .description("Start the context daemon")
    .option("--detach", "Run in the background (compatibility alias)")
    .option("--foreground", "Run in the foreground for debugging")
    .addOption(new Option(`${DAEMON_TEST_OWNER_OPTION} <owner>`).hideHelp())
    .addOption(new Option(`${DAEMON_TEST_ENTRYPOINT_OPTION} <path>`).hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts: DaemonStartOptions) => {
      if (opts.help) await withCustomHelp(daemonCmd, "daemon");
      assertParsedInternalDaemonTestIdentity(opts, internalDaemonTestIdentity);
      if (!opts.foreground) {
        const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const config = loadDaemonConfig(defaultConfigPath());
        const port = config.daemon?.port ?? 3737;
        let result: Awaited<ReturnType<typeof ensureDaemon>>;
        try {
          result = await ensureDaemon({
            port,
            pidFilePath: daemonPidPath(),
            spawnTimeoutMs: 10000,
            expectedVersion: typeof pkg.version === "string" ? pkg.version : undefined,
            expectedStorageBackend: config.storage.backend,
            enforceUserManagerParent: true,
          });
        } catch {
          console.error(`  ${daemonUnavailableMessage(undefined, "ambiguous")}`);
          exit(1);
        }
        if (!result.connected) {
          console.error(`  ${daemonUnavailableMessage(result, "not-running")}`);
          exit(1);
        }
        clearDaemonRemediationMarker();
        if (result.warning) console.warn(`Warning: ${result.warning}`);
        if (result.restartedForParent) {
          console.log(`lcm daemon restarted under user systemd on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        } else if (result.spawned) {
          console.log(`lcm daemon started on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        } else {
          console.log(`lcm daemon already running on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
        }
        exit(0);
      }
      const { createDaemon } = await import("../src/daemon/server.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { ensureAuthToken } = await import("../src/daemon/auth.js");
      const { writeFileSync, mkdirSync, readFileSync, unlinkSync } = await import("node:fs");
      const lcDir = lcmHomeDir();
      const tokenPath = join(lcDir, "daemon.token");
      ensureAuthToken(tokenPath);
      const config = loadDaemonConfig(join(lcDir, "config.json"));
      const pidFilePath = daemonPidPath();
      const cleanupPidFile = (): void => {
        try {
          if (readFileSync(pidFilePath, "utf-8").trim() === String(process.pid)) {
            unlinkSync(pidFilePath);
          }
        } catch {
          // Best-effort cleanup; stale PID files are handled by ensureDaemon.
        }
      };
      const daemon = await createDaemon(config, {
        tokenPath,
        publicationConfigPath: join(lcDir, "config.json"),
        ...(internalDaemonTestIdentity
          ? { _testIdentity: internalDaemonTestIdentity }
          : {}),
      });
      mkdirSync(lcDir, { recursive: true });
      writeFileSync(pidFilePath, String(process.pid));
      process.on("exit", cleanupPidFile);
      console.log(`lcm daemon started on port ${daemon.address().port}`);
      let stopping: Promise<void> | undefined;
      const stopForegroundDaemon = (): void => {
        if (stopping === undefined) {
          const stop = (daemon as { stop?: () => Promise<void> | void }).stop;
          if (stop === undefined) {
            exit(0);
            return;
          }
          let result: Promise<void> | void;
          try {
            result = stop.call(daemon);
          } catch {
            void Promise.resolve().then(() => exit(1)).catch(() => undefined);
            return;
          }
          if (result === undefined) {
            exit(0);
            return;
          }
          stopping = Promise.resolve(result);
        }
        void stopping.then(() => exit(0), () => exit(1)).catch(() => undefined);
      };
      process.on("SIGTERM", stopForegroundDaemon);
      process.on("SIGINT", stopForegroundDaemon);
    });
  daemonCmd.command("restart")
    .description("Restart the managed context daemon and reload configuration")
    .option("-h, --help", "Show help")
    .action(async (opts: { help?: boolean }) => {
      if (opts.help) await withCustomHelp(daemonCmd, "daemon");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { restartDaemon } = await import("../src/daemon/lifecycle.js");
      const config = loadDaemonConfig(defaultConfigPath());
      const port = config.daemon?.port ?? 3737;
      let result: Awaited<ReturnType<typeof restartDaemon>>;
      try {
        result = await restartDaemon({
          port,
          pidFilePath: daemonPidPath(),
          spawnTimeoutMs: 10000,
          expectedVersion: typeof pkg.version === "string" ? pkg.version : undefined,
          expectedStorageBackend: config.storage.backend,
          enforceUserManagerParent: true,
          validateBeforeRestart: () => { loadDaemonConfig(defaultConfigPath()); },
        });
      } catch {
        console.error(`  ${daemonUnavailableMessage(undefined, "ambiguous")}`);
        exit(1);
      }
      if (!result.connected) {
        console.error(`  ${daemonUnavailableMessage(result, "startup-failure")}`);
        exit(1);
      }
      clearDaemonRemediationMarker();
      if (result.warning) console.warn(`Warning: ${result.warning}`);
      const action = result.restarted ? "restarted" : result.spawned ? "started" : "already running";
      console.log(`lcm daemon ${action} on port ${port}${result.pid ? ` (PID ${result.pid})` : ""}`);
      exit(0);
    });
  daemonCmd.action(async (opts: DaemonRootOptions) => {
    if (opts.help) await withCustomHelp(daemonCmd, "daemon");
  });
  program.addCommand(daemonCmd);

  // ─── config ────────────────────────────────────────────────────────────────
  const configCmd = new Command("config").description("Inspect or update validated local configuration");
  configCmd.helpOption(false).option("-h, --help", "Show help");
  configCmd.command("get")
    .description("Read a configuration value")
    .argument("<path>", "Dotted JSON configuration path")
    .option("--effective", "Include defaults and environment-variable overrides")
    .option("-h, --help", "Show help")
    .action(async (path: string, opts: { effective?: boolean; help?: boolean }) => {
      if (opts.help) await withCustomHelp(configCmd, "config");
      try {
        const { formatConfigValue, getConfigValue } = await import("../src/config-manager.js");
        const text = await runWithPublicationRetry(() => formatConfigValue(getConfigValue({
          configPath: defaultConfigPath(),
          path,
          effective: opts.effective ?? false,
        })));
        console.log(text);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Unable to read configuration");
        exit(1);
      }
    });
  configCmd.command("set")
    .description("Write a validated configuration value")
    .argument("<path>", "Dotted JSON configuration path")
    .argument("<value>", "String value, or JSON when --json is supplied")
    .option("--json", "Parse value as JSON")
    .option("-h, --help", "Show help")
    .action(async (path: string, value: string, opts: { json?: boolean; help?: boolean }) => {
      if (opts.help) await withCustomHelp(configCmd, "config");
      try {
        const { formatConfigValue, normalizeConfigPath, setConfigValue } = await import("../src/config-manager.js");
        const stored = setConfigValue({
          configPath: defaultConfigPath(),
          path,
          value,
          json: opts.json ?? false,
        });
        console.log(`Updated ${normalizeConfigPath(path)} = ${formatConfigValue(stored)}`);
        console.log("Restart the daemon to apply this change: lcm daemon restart");
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Unable to update configuration");
        exit(1);
      }
    });
  configCmd.action(async () => {
    await withCustomHelp(configCmd, "config");
  });
  program.addCommand(configCmd);

  // ─── compact ───────────────────────────────────────────────────────────────
  program
    .command("compact")
    .description("Compact conversation context into DAG summary nodes")
    .option("--all", "Compact all tracked projects")
    .option("--dry-run", "Show what would be compacted without writing")
    .option("--replay", "Compact sequentially with threaded context")
    .option("--no-promote", "Skip the automatic promote step")
    .addOption(new Option("--reasoning-effort <value>", "Override provider reasoning effort for this invocation")
      .choices([...LLM_REASONING_EFFORTS]))
    .option("--fast-mode", "Enable provider fast mode for this invocation")
    .option("--no-fast-mode", "Disable provider fast mode for this invocation")
    .option("--timeout-ms <ms>", "Override OpenAI-compatible request timeout for this invocation")
    .option("--retry-max-attempts <n>", "Override OpenAI-compatible maximum attempts for this invocation")
    .option("--retry-initial-delay-ms <ms>", "Override OpenAI-compatible initial retry delay")
    .option("--retry-max-delay-ms <ms>", "Override OpenAI-compatible maximum retry delay")
    .option("--retry-multiplier <n>", "Override OpenAI-compatible retry multiplier")
    .option("--max-concurrency <n>", "Limit concurrent compaction requests (1-32)")
    .option("-v, --verbose", "Show per-session token details")
    .addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp())
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts: CompactOptions) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("compact"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const replay: boolean = opts.replay ?? false;
      const reasoningEffort = opts.reasoningEffort;
      const fastMode = opts.fastMode;
      // Hook dispatch only when --hook is explicit; all other invocations go to batch.
      const hook: boolean = opts.hook ?? false;
      if (!hook) {
        let invocationLifecycle: CompactInvocationLifecycle | undefined;
        let localWorkPromise: Promise<void> | undefined;
        let compactPort = 3737;
        let compactTokenPath: string | undefined;
        let compactPidFilePath: string | undefined;
        let compactStorageBackend: DaemonHealth["storageBackend"] | undefined;
        let compactRuntimeDigest: string | undefined;
        let compactExpectedVersion: string | undefined;
        let originalDaemonHealth: DaemonHealth | undefined;
        let drainResult: CompactDrainResult | undefined;
        let invocationControlFailures = 0;
        let resolveWorkReady!: () => void;
        const workReady = new Promise<void>(resolve => { resolveWorkReady = resolve; });
        const proveProviderProcessesGone = async (
          daemonInstanceId: string,
          invocationId?: string,
        ): Promise<boolean> => {
          try {
            const { readProviderProcessWitnesses, reconcileProviderProcessWitnesses } = await import("../src/llm/process-utils.js");
            return proveCompactProviderWitnessGone({ daemonInstanceId, invocationId }, {
              read: readProviderProcessWitnesses,
              reconcile: reconcileProviderProcessWitnesses,
            });
          } catch {
            return false;
          }
        };
        const drainInvocation = async (): Promise<void> => {
          await workReady;
          if (invocationLifecycle === undefined) {
            drainResult = { daemonZero: true, localSettled: true };
            return;
          }
          const drained = await drainCompactInvocationUntilProved({
            lifecycle: invocationLifecycle,
            createFreshClient: () => new DaemonClient(`http://127.0.0.1:${compactPort}`, compactTokenPath),
            awaitLocalWork: async () => { await localWorkPromise?.catch(() => undefined); },
            localWorkDispatched: () => localWorkPromise !== undefined,
            originalHealth: originalDaemonHealth,
            expectedRuntimeDigest: compactRuntimeDigest,
            expectedStorageBackend: compactStorageBackend,
            restart: async ({ signal }) => {
              const { restartDaemon } = await import("../src/daemon/lifecycle.js");
              return await restartDaemon({
                port: compactPort,
                pidFilePath: compactPidFilePath!,
                spawnTimeoutMs: 10_000,
                expectedVersion: compactExpectedVersion,
                expectedStorageBackend: compactStorageBackend,
                expectedRuntimeDigest: compactRuntimeDigest,
                enforceUserManagerParent: true,
                _abortSignal: signal,
              });
            },
            proveOldInstanceGone: async ({ originalHealth: old, restart }) =>
              proveOriginalDaemonGone(old?.pid, restart),
            proveProviderWitnessGone: async ({ daemonInstanceId, invocationId }) =>
              daemonInstanceId !== undefined
                && await proveProviderProcessesGone(daemonInstanceId, invocationId),
            onDiagnostic: message => console.error(`  compact is still draining: ${message}`),
          });
          drainResult = drained;
        };
        const signalHandlers = installCompactSignalHandlers({
          onRepeatSignal: (status) => {
            console.error(`  compact is already draining (exit ${status}); waiting for local work to settle`);
          },
          onFirstSignal: drainInvocation,
          onDrain: drainInvocation,
        });
        const completePreRegistrationDrain = async (): Promise<void> => {
          resolveWorkReady();
          // This helper is called only after beginDrain latched the promise.
          await Promise.allSettled([signalHandlers.drainPromise!]);
          // drainCompactInvocationUntilProved resolves only after both proofs
          // settle; an automatic pre-registration drain has no other exit.
          process.exitCode = signalHandlers.status ?? 1;
        };
        try {
        const { batchCompact } = await import("../src/batch-compact.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
        const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
        const configFile = defaultConfigPath();
        const config = loadDaemonConfig(configFile);
        selectStorageBackendForConfig(configFile, config.storage);
        compactStorageBackend = config.storage.backend;
        compactRuntimeDigest = RUNTIME_DIGEST;
        compactExpectedVersion = typeof pkg.version === "string" ? pkg.version : undefined;
        const requestPolicy = resolveCompactRequestPolicyOverride(config, opts);
        const effectiveProvider = resolveManualCompactProvider(config.llm.provider);
        const supportedEfforts = reasoningEffortsForProvider(effectiveProvider, config.llm.apiMode);
        if (reasoningEffort && !supportedEfforts.includes(reasoningEffort)) {
          console.error(`  --reasoning-effort ${reasoningEffort} is not supported by the effective provider "${effectiveProvider}"${effectiveProvider === "openai" ? ` with llm.apiMode="${config.llm.apiMode}"` : ""}; supported values: ${supportedEfforts.join(", ") || "none"}`);
          exit(1);
        }
        if (fastMode !== undefined && !supportsFastMode(effectiveProvider)) {
          console.error(`  --${fastMode ? "fast-mode" : "no-fast-mode"} requires llm.provider="auto", "claude-process", or "codex-process"`);
          exit(1);
        }
        const maxConcurrency = resolveCompactConcurrency(config, { maxConcurrency: opts.maxConcurrency, replay });
        const port = config.daemon?.port ?? 3737;
        compactPort = port;
        const pidFilePath = daemonPidPath();
        compactPidFilePath = pidFilePath;
        if (!dryRun && !signalHandlers.draining) {
          let daemonResult: Awaited<ReturnType<typeof ensureDaemon>>;
          try {
            daemonResult = await ensureDaemon({
              port,
              pidFilePath,
              spawnTimeoutMs: 10000,
              expectedStorageBackend: config.storage.backend,
              enforceUserManagerParent: true,
              _abortSignal: signalHandlers.signal,
            });
          } catch (error) {
            if (signalHandlers.draining) {
              await completePreRegistrationDrain();
              return;
            }
            throw error;
          }
          if (!daemonResult.connected) {
            if (signalHandlers.draining) {
              process.exitCode = signalHandlers.status;
              return;
            }
            console.error(`Could not connect to daemon: ${daemonUnavailableMessage(daemonResult, "not-running")}`);
            exit(1);
          }
          clearDaemonRemediationMarker();
        }
        const noPromote: boolean = !opts.promote;
        const minTokens = config.compaction.autoCompactMinTokens;
        const cwd = all ? undefined : process.cwd();
        const tokenPath = daemonTokenPath();
        compactTokenPath = tokenPath;
        let client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);

        const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
        const { makeProgressState } = await import("../src/cli/progress-state.js");
        const isTTY = process.stderr.isTTY ?? false;
        const renderOpts = { isTTY, width: process.stderr.columns ?? 80, color: isTTY, verbose };
        const compactState = makeProgressState({ phases: [
          { name: "Compact", status: "active" },
          ...(!noPromote ? [{ name: "Promote", status: "pending" } as const] : []),
        ], dryRun });
        const compactRenderer = new NinjaRenderer({ state: compactState, renderOpts, handleSignals: false, output: process.stderr });
        signalHandlers.bindRenderer(compactState);
        compactRenderer.start();
        try {
          if (!dryRun && !signalHandlers.draining) {
          let daemonHealth: DaemonHealth | null;
          try {
            daemonHealth = await client.health({ signal: signalHandlers.signal });
          } catch (error) {
            if (signalHandlers.draining && invocationLifecycle === undefined) {
              await completePreRegistrationDrain();
              return;
            }
            throw error;
          }
          if (signalHandlers.draining) {
            await completePreRegistrationDrain();
            return;
          }
          const supportsInvocationControl = typeof client.startInvocation === "function"
            && typeof client.heartbeatInvocation === "function"
            && typeof client.cancelInvocation === "function"
            && typeof client.finishInvocation === "function";
          const hasInvocationIdentity = daemonHealth !== null
            && typeof daemonHealth === "object"
            && typeof daemonHealth.daemonInstanceId === "string";
          if (!supportsInvocationControl || !hasInvocationIdentity) {
            // Structural fakes and direct legacy callers may omit invocation
            // control entirely; a real DaemonClient must fail closed when its
            // authenticated health response cannot bind this command.
            const legacyClient = (daemonHealth as unknown) === true;
            if (!legacyClient) {
              throw new Error("manual compact requires authenticated daemon invocation identity and control support");
            }
          } else {
            originalDaemonHealth = daemonHealth as DaemonHealth;
            invocationLifecycle = createCompactInvocationLifecycle({
              client,
              daemonInstanceId: (daemonHealth as { daemonInstanceId: string }).daemonInstanceId,
              signal: signalHandlers.signal,
              onHeartbeatError: (error) => {
                invocationControlFailures += 1;
                const message = error instanceof Error ? error.message : "request failed";
                console.error(`  compact heartbeat failed: ${sanitizeTerminalText(message)}`);
                signalHandlers.beginDrain("daemon heartbeat failed");
              },
            });
            try {
              await invocationLifecycle.start();
            } catch (error) {
              // start() latches possiblyRegistered before issuing the request;
              // any rejection therefore requires the same bounded drain path.
              invocationControlFailures += 1;
              signalHandlers.beginDrain("daemon invocation start failed");
              await completePreRegistrationDrain();
              return;
            }
          }
          }

        let totalFailures = 0;
        let totalPromoted = 0;
        const runCompactWork = async (): Promise<void> => {
          const { compacted, failures, compactedProjects } = await batchCompact({
            minTokens, dryRun, port, cwd, replay, verbose, tokenPath, reasoningEffort, fastMode, requestPolicy, maxConcurrency,
            ...(invocationLifecycle ? { invocationId: invocationLifecycle.invocationId } : {}),
            signal: signalHandlers.signal,
            onTransportFailure: (error: unknown): void => {
              const message = error instanceof Error ? error.message : "request failed";
              console.error(`  compact transport disconnected: ${sanitizeTerminalText(message)}`);
              signalHandlers.beginDrain("daemon transport disconnected");
            },
            onProgress: (patch: Partial<ProgressState>): void => {
              Object.assign(compactState, patch);
              if (patch.lastResult) compactRenderer.sessionDone();
            },
          });

          compactState.phases[0].status = "done";

          // Auto-promote after a successful compact: new summaries are prime promotion candidates.
          let promotionFailures = 0;
          if (!dryRun && compacted > 0 && !noPromote && !signalHandlers.draining) {
            compactState.phases[1]!.status = "active";
            for (const promoteCwd of compactedProjects) {
              if (signalHandlers.draining) break;
              compactState.currentProject = sanitizeTerminalText(promoteCwd);
              if (!isTTY || verbose) console.error(`  promoting: ${sanitizeTerminalText(promoteCwd)}...`);
              try {
                const promotionBody = {
                  cwd: promoteCwd,
                  dry_run: dryRun,
                  ...(invocationLifecycle ? { invocation_id: invocationLifecycle.invocationId } : {}),
                };
                let result: { processed: number; promoted: number };
                try {
                  result = invocationLifecycle
                    ? await client.post("/promote", promotionBody, { signal: signalHandlers.signal })
                    : await client.post("/promote", promotionBody);
                } catch (error) {
                  if (signalHandlers.draining || !isDaemonTransportFailure(error)) throw error;
                  if (invocationLifecycle !== undefined) {
                    signalHandlers.beginDrain("daemon transport disconnected");
                    throw error;
                  }
                  const recovery = await ensureDaemon({
                    port,
                    pidFilePath,
                    spawnTimeoutMs: 10000,
                    expectedStorageBackend: config.storage.backend,
                    enforceUserManagerParent: true,
                  });
                  if (!recovery.connected) {
                    throw new Error(daemonUnavailableMessage(recovery, "live-no-response"));
                  }
                  clearDaemonRemediationMarker();
                  client = new DaemonClient(`http://127.0.0.1:${port}`, tokenPath);
                  // The invocation-aware branch above throws before recovery;
                  // reaching this point therefore guarantees a legacy client.
                  result = await client.post("/promote", promotionBody);
                }
                totalPromoted += result.promoted;
              } catch (error) {
                promotionFailures++;
                const message = error instanceof Error ? error.message : "request failed";
                compactState.phaseErrors.push({
                  phase: "Promote",
                  target: sanitizeTerminalText(promoteCwd),
                  message: sanitizeTerminalText(message),
                });
                console.error(
                  `  promotion failed for ${sanitizeTerminalText(promoteCwd)}: ${sanitizeTerminalText(message)}`,
                );
              }
            }
            compactState.currentProject = undefined;
          }
          if (!noPromote) compactState.phases[1]!.status = "done";
          totalFailures = failures + promotionFailures + invocationControlFailures;
        };

        if (signalHandlers.draining) {
          resolveWorkReady();
          await Promise.allSettled([signalHandlers.drainPromise!]);
          // The bounded drain promise resolves only after daemon and local
          // ownership proofs are complete.
          process.exitCode = signalHandlers.status
            ?? compactFailureExitCode(totalFailures + invocationControlFailures);
          return;
        }
        localWorkPromise = runCompactWork();
        resolveWorkReady();
        try {
          await localWorkPromise;
        } catch (error) {
          if (!signalHandlers.draining) throw error;
          totalFailures += 1;
          compactState.phaseErrors.push({
            phase: "Compact",
            message: error instanceof Error ? error.message : "compact work failed",
          });
          const message = error instanceof Error ? error.message : "request failed";
          console.error(`  compact failed while draining: ${sanitizeTerminalText(message)}`);
        }
        if (invocationLifecycle && !signalHandlers.draining) {
          const providersGone = await proveProviderProcessesGone(
            invocationLifecycle.target.daemonInstanceId,
            invocationLifecycle.invocationId,
          );
          if (!providersGone) {
            signalHandlers.beginDrain("provider process witness did not prove targeted zero-owned work");
          } else {
            try {
              await invocationLifecycle.finish();
            } catch (error) {
              if (!signalHandlers.draining) {
                totalFailures += 1;
                signalHandlers.beginDrain("daemon finish control failed");
              }
              if (!isAbortError(error)) {
                compactState.phaseErrors.push({
                  phase: "Compact",
                  message: error instanceof Error ? error.message : "invocation finish failed",
                });
              }
            }
          }
        }
        if (isTTY) compactRenderer.printSummary();
        if (totalPromoted > 0) {
          console.log(`  → ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted`);
        }
        if (signalHandlers.drainPromise !== undefined) {
          await Promise.allSettled([signalHandlers.drainPromise]);
        }
        if (!signalHandlers.draining) {
          process.exitCode = compactFailureExitCode(totalFailures);
        } else {
          // A settled drain promise represents a proved drain by contract.
          process.exitCode = signalHandlers.status ?? compactFailureExitCode(totalFailures);
        }
        return;
        } finally {
          await invocationLifecycle?.settleHeartbeat?.();
          compactRenderer.stop();
        }
        } finally {
          resolveWorkReady();
          signalHandlers.cleanup();
        }
      }
      // Piped stdin — hook dispatch (PreCompact hook invocation)
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      let requestPolicy: LlmInvocationRequestPolicy | undefined;
      if (hasCompactRequestPolicyOverride(opts)) {
        const { loadStoredLlmRequestPolicyConfig } = await import("../src/config-projection.js");
        requestPolicy = resolveCompactRequestPolicyOverride(
          loadStoredLlmRequestPolicyConfig(defaultConfigPath()),
          opts,
        );
      }
      const input = withHookOverrides(await readStdin(), opts.client, reasoningEffort, requestPolicy, fastMode);
      const r = await dispatchHook("compact", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── restore (hook) ────────────────────────────────────────────────────────
  program
    .command("restore")
    .description("Dispatch the restore hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("restore"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("restore", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-end (hook) ────────────────────────────────────────────────────
  program
    .command("session-end")
    .description("Dispatch the session-end hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("session-end"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("session-end", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── user-prompt (hook) ────────────────────────────────────────────────────
  program
    .command("user-prompt")
    .description("Dispatch the user-prompt hook")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .addOption(new Option("--transport <transport>", "Hook transport (internal)").choices(["cli", "mcp"]).hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("user-prompt"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("user-prompt", input, { transport: opts.transport });
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── post-tool (hook) ──────────────────────────────────────────────────────
  program
    .command("post-tool")
    .description("Dispatch the post-tool hook (PostToolUse event)")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("post-tool"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("post-tool", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── session-snapshot (hook) ─────────────────────────────────────────────
  program
    .command("session-snapshot")
    .description("Rolling ingest snapshot (called by Stop hook)")
    .helpOption(false)
    .addOption(new Option("--client <client>", "Hook client identity (internal)").hideHelp())
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("session-snapshot"); exit(0);
      }
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = withHookClient(await readStdin(), opts.client);
      const r = await dispatchHook("session-snapshot", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── mcp ───────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Start the lcm MCP server")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("mcp"); exit(0);
      }
      const { startMcpServer } = await import("../src/mcp/server.js");
      await startMcpServer();
    });

  // ─── install ───────────────────────────────────────────────────────────────
  program
    .command("install")
    .description("Set up lcm: register hooks, configure daemon, connect MCP")
    .option("--dry-run", "Preview all changes without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      const dryRun: boolean = opts.dryRun ?? false;
      const { install } = await import("../installer/install.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm install --dry-run\n");
        await install(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await install(undefined, publicationConvergence);
      }
    });

  // ─── uninstall ─────────────────────────────────────────────────────────────
  program
    .command("uninstall")
    .description("Remove lcm hooks and MCP registration")
    .option("--dry-run", "Preview removals without writing anything")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      const dryRun: boolean = opts.dryRun ?? false;
      const { uninstall } = await import("../installer/uninstall.js");
      if (dryRun) {
        const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
        console.log("\n  lcm uninstall --dry-run\n");
        await uninstall(new DryRunServiceDeps());
        console.log("\n  No changes written.");
      } else {
        await uninstall();
      }
    });

  // ─── status ────────────────────────────────────────────────────────────────
  program
    .command("status")
    .description("Show daemon status and project memory statistics")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("status"); exit(0);
      }
      const jsonFlag: boolean = opts.json ?? false;
      const readClient = await createDaemonReadClientOrExit(preflightSeams, { preflightStorage: false });
      const { client, config } = readClient;

      let daemonStatus = "down";
      let statusData: any = null;

      try {
        const health = readClient.health ?? await client.health();
        daemonStatus = (["down", "up"] as const)[Number(Boolean(health))]!;
        const daemonHealth = health as DaemonHealth | null;
        if (daemonHealth?.status === "unavailable") {
          statusData = {
            daemon: {
              status: "up",
              version: daemonHealth.version,
              uptime: daemonHealth.uptime,
              port: config.daemon.port,
              storageBackend: daemonHealth.storageBackend,
              storageStatus: "unavailable",
            },
          };
        }

        // Also fetch /status endpoint if daemon is up
        if (daemonStatus === "up" && !statusData) {
          statusData = await client.post("/status", { cwd: process.cwd() });
        }
      } catch {}

      if (jsonFlag) {
        const result = {
          daemon: daemonStatus === "up" ? statusData?.daemon : { status: "down" },
          project: statusData?.project,
        };
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const provider = config.llm?.provider ?? "unknown";
        const providerDisplay = provider === "auto"
          ? "auto (Claude->claude-process, Codex->codex-process)"
          : provider;

        if (statusData) {
          console.log(`Daemon: ${daemonStatus}`);
          console.log(`  Version: ${statusData.daemon.version}`);
          console.log(`  Uptime: ${statusData.daemon.uptime}s`);
          console.log(`  Port: ${statusData.daemon.port}`);
          console.log(`  Provider: ${providerDisplay}`);
          if (statusData.daemon.storageBackend) {
            console.log(
              `  Storage: ${statusData.daemon.storageBackend} (${statusData.daemon.storageStatus})`,
            );
          }
          if (statusData.project) {
            console.log();
            console.log("Project:");
            console.log(`  Messages: ${statusData.project.messageCount}`);
            console.log(`  Summaries: ${statusData.project.summaryCount}`);
            console.log(`  Promoted: ${statusData.project.promotedCount}`);
            if (statusData.project.lastIngest) console.log(`  Last Ingest: ${statusData.project.lastIngest}`);
            if (statusData.project.lastCompact) console.log(`  Last Compact: ${statusData.project.lastCompact}`);
            if (statusData.project.lastPromote) console.log(`  Last Promote: ${statusData.project.lastPromote}`);
          }
        } else {
          console.log(`daemon: ${daemonStatus} · provider: ${providerDisplay}`);
        }
      }
    });

  // ─── stats ─────────────────────────────────────────────────────────────────
  program
    .command("stats")
    .description("Show memory inventory and compression ratios")
    .option("-v, --verbose", "Show per-conversation breakdown")
    .option("--pool", "Show connection pool statistics from the daemon")
    .option("--json", "Output structured JSON (use with --pool)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("stats"); exit(0);
      }

      if (opts.pool) {
        const jsonFlag: boolean = opts.json ?? false;
        const { client } = await createDaemonReadClientOrExit(preflightSeams, { requireSqlite: true });

        let poolData: any = null;
        try {
          poolData = await client.get("/stats/pool");
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : "could not load pool stats"}`);
          exit(1);
        }

        if (jsonFlag) {
          stdout.write(JSON.stringify(poolData, null, 2) + "\n");
        } else {
          const dim = "\x1b[2m";
          const cyan = "\x1b[36m";
          const bold = "\x1b[1m";
          const reset = "\x1b[0m";
          console.log();
          console.log(`    ${bold}${cyan}🔌 Connection Pool${reset}`);
          console.log();
          const rows: [string, string][] = [
            ["Total", String(poolData.totalConnections)],
            ["Active", String(poolData.activeConnections)],
            ["Idle", String(poolData.idleConnections)],
          ];
          const labelWidth = Math.max(...rows.map(([l]) => l.length));
          for (const [label, value] of rows) {
            console.log(`    ${dim}${label.padEnd(labelWidth)}${reset}  ${value}`);
          }
          if (poolData.connections && poolData.connections.length > 0) {
            console.log();
            console.log(`    ${dim}Connections:${reset}`);
            for (const conn of poolData.connections) {
              const status = conn.status === "active" ? `${cyan}active${reset}` : `${dim}idle${reset}`;
              console.log(`    ${dim}refs=${conn.refs}${reset}  ${status}  ${conn.path}`);
            }
          }
          console.log();
        }
        return;
      }

      const verbose: boolean = opts.verbose ?? false;
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
      const configFile = defaultConfigPath();
      const { collectStats, printStats } = await import("../src/stats.js");
      const stats = await runWithPublicationRetry(async () => {
        selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
        return collectStats();
      });
      printStats(await stats, verbose);
    });

  // ─── doctor ────────────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Run diagnostics: daemon, hooks, MCP, summarizer")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .option("--verbose", "Show detailed diagnostic output")
    .option("--events-max-dbs <n|all|unlimited>", "Maximum passive-learning sidecar DBs to scan", "50")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("doctor"); exit(0);
      }
      const verbose: boolean = opts.verbose ?? false;
      const eventsMaxDbs = parsePositiveIntegerOrAll(String(opts.eventsMaxDbs ?? "50"), "--events-max-dbs");
      const { runDoctor, printResults } = await import("../src/doctor/doctor.js");
      const results = await runDoctor(undefined, { verbose, eventsMaxDbs });
      printResults(results);
      const failures = results.filter((r: { status: string }) => r.status === "fail");
      exit(failures.length > 0 ? 1 : 0);
    });

  // ─── events ────────────────────────────────────────────────────────────────
  const eventsCmd = new Command("events").description("Manage passive-learning sidecar events");
  eventsCmd.helpOption(false).option("-h, --help", "Show help");
  eventsCmd.action(async () => {
    console.error(
      "Usage: lcm events <promote|status|validate|quarantine|replay> [options]",
    );
    exit(1);
  });

  eventsCmd
    .command("promote")
    .description("Promote queued passive-learning events")
    .option("--all", "Promote events from all metadata-backed sidecars")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      const all: boolean = opts.all ?? false;
      const jsonFlag: boolean = opts.json ?? false;
      const client = await createDaemonClientOrExit();
      const result = all
        ? await client.post<any>("/promote-events/all", {})
        : await client.post<any>("/promote-events", { cwd: process.cwd(), drain: true });
      const failed = all
        ? ((result.errors ?? 0) > 0 || (result.failedProjects ?? 0) > 0)
        : ((result.errors ?? 0) > 0 || result.incomplete === true);

      if (jsonFlag) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
        if (failed) process.exitCode = 1;
        return;
      }

      if (all) {
        console.log(`Promoted ${result.promoted} passive event${result.promoted === 1 ? "" : "s"} from ${result.processedProjects} project${result.processedProjects === 1 ? "" : "s"} (${result.skipped} skipped, ${result.errors} errors).`);
        if (result.orphanedProjects > 0) {
          console.log(`${result.orphanedProjects} sidecar${result.orphanedProjects === 1 ? "" : "s"} could not be promoted because project metadata is missing.`);
        }
      } else {
        console.log(`Promoted ${result.promoted} passive event${result.promoted === 1 ? "" : "s"} (${result.skipped} skipped, ${result.errors} errors).`);
        if (typeof result.batches === "number" && result.batches > 1) {
          console.log(`Drained ${result.batches} batches.`);
        }
        if (result.message) console.log(result.message);
      }
      if (failed) exit(1);
    });

  const passiveOperatorError = (error: unknown, json: boolean): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ error: message });
    else console.error(`Error: ${message}`);
    return exit(1);
  };

  eventsCmd
    .command("status")
    .description("Show staged local and PostgreSQL passive-event delivery status")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("events"); exit(0);
      }
      const jsonFlag: boolean = opts.json ?? false;
      try {
        const output = await runWithPublicationRetry(() => withPassiveEventOperatorSession(async ({ local, remote }) => ({
          local: await local.getDeliveryDiagnostics(),
          remote: serializableCoordinationDiagnostics(await remote.getDiagnostics()),
        })));
        if (jsonFlag) {
          printJson(output);
          return;
        }
        const local = output.local;
        const queue = output.remote.queue as Record<string, string | null>;
        console.log(
          `Local: ${local.pending} pending, ${local.claimed} claimed, ${local.retry} retry, `
          + `${local.replicated} replicated, ${local.acknowledged} acknowledged, `
          + `${local.awaitingRemotePrune} awaiting remote prune, `
          + `${local.quarantined} quarantined.`,
        );
        console.log(
          `PostgreSQL: ${queue.pending} pending, ${queue.claimed} claimed, `
          + `${queue.retry} retry, ${queue.applied} applied, `
          + `${queue.quarantined} quarantined.`,
        );
      } catch (error) {
        passiveOperatorError(error, jsonFlag);
      }
    });

  eventsCmd
    .command("validate")
    .description("Validate staged local-to-PostgreSQL passive-event readback")
    .option("--limit <n>", "Maximum replicated or quarantined events to validate", "100")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("events"); exit(0);
      }
      const jsonFlag: boolean = opts.json ?? false;
      try {
        const limit = parsePositiveInteger(String(opts.limit), "--limit");
        if (limit > 500) throw new Error("--limit must not exceed 500");
        const output = await runWithPublicationRetry(() => withPassiveEventOperatorSession(async ({ local, remote }) => {
          const events = await local.listAwaitingRemote(limit, true);
          const records = events.length === 0
            ? []
            : await remote.readEvents(events.map((event) => ({
              machineId: event.machine_id!,
              eventId: event.event_uuid,
            })));
          const byId = new Map(records.map((record) => [record.eventId, record]));
          const missing: string[] = [];
          const mismatched: string[] = [];
          let matched = 0;
          for (const event of events) {
            const record = byId.get(event.event_uuid);
            if (!record) missing.push(event.event_uuid);
            else if (!passiveEventReadbackMatches(event, record)) {
              mismatched.push(event.event_uuid);
            } else {
              matched += 1;
            }
          }
          return { checked: events.length, matched, missing, mismatched };
        }));
        if (jsonFlag) {
          printJson(output);
        } else {
          console.log(
            `Validated ${output.checked} event${output.checked === 1 ? "" : "s"}: `
            + `${output.matched} matched, ${output.missing.length} missing, `
            + `${output.mismatched.length} mismatched.`,
          );
        }
        if (output.missing.length > 0 || output.mismatched.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        passiveOperatorError(error, jsonFlag);
      }
    });

  eventsCmd
    .command("quarantine")
    .description("Inspect quarantined local and PostgreSQL passive events")
    .option("--limit <n>", "Maximum quarantined events to list", "100")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("events"); exit(0);
      }
      const jsonFlag: boolean = opts.json ?? false;
      try {
        const limit = parsePositiveInteger(String(opts.limit), "--limit");
        if (limit > 500) throw new Error("--limit must not exceed 500");
        const output = await runWithPublicationRetry(() => withPassiveEventOperatorSession(async ({ local, remote }) => ({
          local: await local.listQuarantined(limit),
          remote: (await remote.listQuarantined(limit)).map(serializablePassiveEvent),
        })));
        if (jsonFlag) {
          printJson(output);
          return;
        }
        if (output.local.length === 0 && output.remote.length === 0) {
          console.log("No quarantined local or PostgreSQL passive events.");
          return;
        }
        for (const record of output.local) {
          console.log(
            `${record.event_uuid}  source=local  machine=${record.machine_id ?? "unassigned"}  `
            + `sequence=${BigInt(record.machine_sequence).toString()}  `
            + `reason=${sanitizeTerminalText(record.quarantine_reason ?? "unknown")}`,
          );
        }
        for (const record of output.remote) {
          console.log(
            `${String(record.eventId)}  source=postgresql  machine=${String(record.machineId)}  `
            + `sequence=${String(record.machineSequence)}  `
            + `reason=${sanitizeTerminalText(String(record.quarantineReason ?? "unknown"))}`,
          );
        }
      } catch (error) {
        passiveOperatorError(error, jsonFlag);
      }
    });

  eventsCmd
    .command("replay <event-id>")
    .description("Replay one exact quarantined local or PostgreSQL passive event")
    .option("--machine <machine-id>", "Owning machine UUID; defaults to this machine")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (eventId: string, opts) => {
      if (opts.help || cliArgv.includes("-h") || cliArgv.includes("--help")) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("events"); exit(0);
      }
      const jsonFlag: boolean = opts.json ?? false;
      try {
        const output = await withPassiveEventOperatorSession(async ({ local, remote }) => {
          const key = {
            machineId: typeof opts.machine === "string" ? opts.machine : remote.machineId,
            eventId,
          };
          const existing = await remote.readEvent(key);
          if (existing?.status !== "quarantined") {
            const localReplayed = await local.replayQuarantined(eventId);
            return {
              replayed: localReplayed,
              localReplayed,
              event: localReplayed && existing
                ? serializablePassiveEvent(existing)
                : null,
            };
          }
          // Move the local checkpoint first. If the process dies before or
          // during the remote transition, normal readback reconciliation can
          // restore quarantine or observe the completed remote replay.
          const localReplayed = await local.replayQuarantined(existing.eventId);
          const transitioned = await remote.replayQuarantined(key);
          const record = transitioned ?? await remote.readEvent(key);
          const replayed = record?.status === "pending";
          return {
            replayed,
            localReplayed,
            event: replayed ? serializablePassiveEvent(record) : null,
          };
        });
        if (jsonFlag) {
          printJson(output);
        } else if (output.replayed) {
          console.log(`Replayed passive event ${eventId}.`);
        } else {
          console.log(`Passive event ${eventId} is not quarantined.`);
        }
        if (!output.replayed) process.exitCode = 1;
      } catch (error) {
        passiveOperatorError(error, jsonFlag);
      }
    });

  program.addCommand(eventsCmd);

  registerMachineCommand(program);
  registerProjectCommand(program, runWithPublicationRetry);
  registerPostgreSqlCommand(program);
  registerMemoryCommands(
    program,
    async (options) => (await createDaemonReadClientOrExit(preflightSeams, options)).client,
  );

  // ─── diagnose ──────────────────────────────────────────────────────────────
  program
    .command("diagnose")
    .description("Scan recent sessions for hook failures and issues")
    .option("--all", "Scan all tracked projects")
    .option("--days <n>", "Scan the last N days (default: 7)", "7")
    .option("--verbose", "Include full event details")
    .option("--json", "Output structured JSON")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("diagnose"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const json: boolean = opts.json ?? false;
      const days = Number(opts.days);

      if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
        console.error("Usage: lcm diagnose [--all] [--days N] [--verbose] [--json]");
        exit(1);
      }

      const { diagnose, formatDiagnoseResult } = await import("../src/diagnose.js");
      const result = await diagnose({ all, days, verbose });

      if (json) {
        stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        stdout.write(formatDiagnoseResult(result, { days, verbose }));
      }
    });

  // ─── connectors ────────────────────────────────────────────────────────────
  const connectorsCmd = new Command("connectors").description("Manage connectors for coding agents");
  connectorsCmd.helpOption(false).option("-h, --help", "Show help");
  connectorsCmd.action(async () => {
    console.error("Usage: lcm connectors <list|install|remove|doctor> [options]");
    exit(1);
  });

  connectorsCmd
    .command("list")
    .description("List available agents and installed connectors")
    .option("--format <format>", "Output format: text or json", "text")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const format: string = opts.format ?? "text";
      const { listConnectors, listConnectorInventory } = await import("../src/connectors/installer.js");
      const { AGENTS } = await import("../src/connectors/registry.js");
      const connectorCwd = opts.global ? homedir() : process.cwd();
      const inventory = typeof listConnectorInventory === "function"
        ? listConnectorInventory(connectorCwd)
        : { installed: listConnectors(connectorCwd), codexMcp: { state: "absent" as const } };
      const installed = inventory.installed;
      const installedTransportsFor = (agent: any, installedSurfaces: string[]): string[] => {
        if (agent.id === "codex") {
          return CONNECTOR_TRANSPORTS.filter(transport => transport === "cli"
            ? inventory.codexMcp.state !== "unknown" && installedSurfaces.some(surface => surface !== "mcp")
            : inventory.codexMcp.state === "installed");
        }
        return installedSurfaces.includes("mcp")
          ? ["mcp"]
          : installedSurfaces.length > 0 ? ["cli"] : [];
      };

      if (format === "json") {
        const result = AGENTS.map((a: any) => {
          const agentInstalled = installed.filter((c: any) => c.agentId === a.id);
          const installedSurfaces = agentInstalled.map((c: any) => c.type);
          const supportedTransports = CONNECTOR_TRANSPORTS.filter(
            transport => a.capabilities[transport] !== undefined,
          );
          const installedTransports = installedTransportsFor(a, installedSurfaces);
          const result = {
            id: a.id,
            name: a.name,
            category: a.category,
            defaultTransport: a.defaultTransport,
            supportedTransports,
            installed: installedSurfaces,
            installedTransports,
          };
          return a.id === "codex"
            ? { ...result, mcpInspection: inventory.codexMcp.state }
            : result;
        });
        stdout.write(JSON.stringify({ agents: result }, null, 2) + "\n");
      } else {
        const rows = AGENTS.map((agent: any) => {
          const agentInstalled = installed.filter((c: any) => c.agentId === agent.id);
          const installedSurfaces = agentInstalled.map((c: any) => c.type);
          const installedTransports = installedTransportsFor(agent, installedSurfaces);
          let installedDisplay = installedSurfaces.length > 0 ? installedSurfaces.join(", ") : "-";
          if (agent.id === "codex") {
            installedDisplay = inventory.codexMcp.state === "unknown"
              ? `${installedDisplay} (transport unknown)`
              : installedTransports.length > 0
                ? `${installedDisplay} (${installedTransports.map(transport => transport.toUpperCase()).join(", ")})`
                : installedDisplay;
          }
          return {
            agent: agent.name,
            installed: installedDisplay,
            defaultTransport: agent.defaultTransport,
            supportedTransports: CONNECTOR_TRANSPORTS
              .filter(transport => agent.capabilities[transport] !== undefined)
              .join(", "),
          };
        });
        const agentWidth = Math.max("Agent".length, ...rows.map((row) => row.agent.length));
        const installedWidth = Math.max("Installed".length, ...rows.map((row) => row.installed.length));
        const defaultWidth = Math.max("Default transport".length, ...rows.map((row) => row.defaultTransport.length));

        console.log("\n  Available agents:\n");
        console.log(`  ${"Agent".padEnd(agentWidth)}  ${"Installed".padEnd(installedWidth)}  ${"Default transport".padEnd(defaultWidth)}  Supported transports`);
        console.log("  " + "─".repeat(70));
        for (const row of rows) {
          console.log(`  ${row.agent.padEnd(agentWidth)}  ${row.installed.padEnd(installedWidth)}  ${row.defaultTransport.padEnd(defaultWidth)}  ${row.supportedTransports}`);
        }
        console.log();
      }
    });

  connectorsCmd
    .command("install <agent>")
    .description("Install a connector for an agent")
    .addOption(new Option("--transport <transport>", "Connector transport: cli or mcp").choices(["cli", "mcp"]))
    .option("--global", "Install into the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors install <agent> [--transport cli|mcp] [--global]"); exit(1); }
      const transport: "cli" | "mcp" | undefined = opts.transport;
      const cwd = opts.global ? homedir() : process.cwd();
      const { installConnector } = await import("../src/connectors/installer.js");
      try {
        const result = installConnector(agentName, transport, cwd, {
          persistTransport: transport !== undefined,
          queryCodexMcp: transport === "cli",
        });
        if ((result as any).manual) {
          console.log(`\n  ${(result as any).manual}\n`);
        } else {
          console.log(`\n  ✓ Installed ${transport ?? "default"} connector for ${agentName}`);
          const paths = Array.isArray((result as any).paths) ? (result as any).paths : [(result as any).path];
          for (const path of paths.filter((path: string) => path.length > 0)) {
            console.log(`    Path: ${path}`);
          }
          if ((result as any).requiresRestart) console.log("    Restart the agent to activate.");
          console.log();
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("remove <agent>")
    .description("Remove a connector for an agent")
    .option("--global", "Remove from the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      if (!agentName) { console.error("Usage: lcm connectors remove <agent> [--global]"); exit(1); }
      const cwd = opts.global ? homedir() : process.cwd();
      const { removeConnector } = await import("../src/connectors/installer.js");
      try {
        const result = removeConnector(agentName, cwd, {});
        if (typeof result === "object" && result !== null && !result.success) {
          const failures = Array.isArray(result.failures) ? result.failures : [];
          const detail = failures.length > 0 ? `: ${failures.join("; ")}` : "";
          throw new Error(`Failed to remove connector for ${agentName}${detail}`);
        }
        const removed = typeof result === "boolean" ? result : result.removed;
        if (removed) {
          console.log(`\n  ✓ Removed connector for ${agentName}\n`);
        } else {
          console.log(`\n  No connector found for ${agentName}\n`);
        }
      } catch (err: any) {
        console.error(`  Error: ${err.message}`);
        exit(1);
      }
    });

  connectorsCmd
    .command("doctor [agent]")
    .description("Check connector health")
    .option("--global", "Inspect the global agent config in your home directory")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (agentName: string | undefined, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("connectors"); exit(0);
      }
      const { AGENTS } = await import("../src/connectors/registry.js");
      const { listConnectors, listConnectorInventory } = await import("../src/connectors/installer.js");
      const { readConnectorTransportSnapshot } = await import("../src/config-manager.js");
      const { findAgent } = await import("../src/connectors/registry.js");
      const found = agentName ? findAgent(agentName) : undefined;
      const agents = found ? [found] : agentName ? [] : AGENTS;

      if (agents.length === 0) { console.error(`  Unknown agent: ${agentName}`); exit(1); }

      const connectorCwd = opts.global ? homedir() : process.cwd();
      const inventory = typeof listConnectorInventory === "function"
        ? listConnectorInventory(connectorCwd)
        : { installed: listConnectors(connectorCwd), codexMcp: { state: "absent" as const } };
      const installed = inventory.installed;
      console.log("\n  Connector health:\n");
      let failures = 0;
      for (const agent of agents) {
        const agentConnectors = installed.filter((c: any) => c.agentId === (agent as any).id);
        if ((agentConnectors as any[]).length === 0) {
          console.log(`  ⚠ ${(agent as any).name}: no connectors installed`);
        } else {
          for (const c of agentConnectors as any[]) {
            console.log(`  ✓ ${(agent as any).name}: ${c.type} at ${c.path}`);
          }
        }

        if ((agent as any).id === "codex" && inventory.codexMcp.state === "unknown") {
          console.log(`  ⚠ Codex: native MCP inspection unknown (${inventory.codexMcp.reason ?? "unavailable"})`);
          const installedCodexMcp = (agentConnectors as any[]).some((connector) => connector.type === "mcp");
          const storedCodexMcp = inventory.codexMcp.reason === "unavailable"
            && agentName === undefined
            && !installedCodexMcp
            && readConnectorTransportSnapshot(defaultConfigPath(), "codex") === "mcp";
          if (inventory.codexMcp.reason !== "unavailable"
            || agentName !== undefined
            || installedCodexMcp
            || storedCodexMcp) {
            failures += 1;
          }
        }

        if ((agent as any).id !== "codex" || agentName === undefined) continue;

        const {
          inspectCodexPostToolHook,
          resolveCodexHooksPath,
        } = await import("../src/connectors/codex-hooks.js");
        const { codexPostToolFunctionalCoverage } = await import("../src/hooks/post-tool-normalization.js");
        const inspection = inspectCodexPostToolHook(
          resolveCodexHooksPath(opts.global ? homedir() : process.cwd()),
        );

        if (inspection.state === "installed") {
          console.log("  ✓ Codex: PostToolUse hook installed");
          let functional = false;
          try {
            functional = codexPostToolFunctionalCoverage();
          } catch {
            functional = false;
          }
          if (functional) {
            console.log("  ✓ Codex: native exec capture functional");
          } else {
            console.log("  ✗ Codex: native exec capture functional");
            failures += 1;
          }
        } else {
          console.log(`  ✗ Codex: PostToolUse hook ${inspection.state}`);
          console.log("  Codex: native exec capture functional check skipped");
          failures += 1;
        }
      }
      console.log();
      if (failures > 0) exit(1);
    });

  program.addCommand(connectorsCmd);

  // ─── sensitive ─────────────────────────────────────────────────────────────
  program
    .command("sensitive [args...]")
    .description("Manage sensitive patterns for automatic redaction")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .allowUnknownOption(true)
    .action(async (args: string[], opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("sensitive"); exit(0);
      }
      const { handleSensitive } = await import("../src/sensitive.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const configPath = defaultConfigPath();
      const readSensitive = args[0] === "list" || args[0] === "test";
      const r = await (readSensitive
        ? runWithPublicationRetry(() => handleSensitive(args, process.cwd(), configPath))
        : handleSensitive(args, process.cwd(), configPath));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });

  // ─── import ────────────────────────────────────────────────────────────────
  program
    .command("import")
    .description("Import Claude Code and Codex session transcripts into lossless memory")
    .option("--all", "Import all projects")
    .option("--provider <provider>", "Transcript provider: claude, codex, or all", "claude")
    .option("--codex", "Shorthand for --provider codex")
    .option("--verbose", "Show per-session import detail")
    .option("--dry-run", "Preview without importing")
    .option("--replay", "Replay compaction for each imported session")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;
      const replay: boolean = opts.replay ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
      const { NinjaRenderer } = await import("../src/cli/pipeline-runner.js");
      const { makeProgressState } = await import("../src/cli/progress-state.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { existsSync, readdirSync } = await import("node:fs");
      const { importSessions, cwdToProjectHash, findSessionFiles } = await import("../src/import.js");
      const { findAllCodexTranscripts } = await import("../src/codex-transcript.js");
      type ImportProvider = import("../src/import.js").ImportProvider;

      // --codex is a shorthand for --provider codex
      let provider: ImportProvider = "claude";
      if (opts.codex) {
        provider = "codex";
      } else if (opts.provider) {
        const provVal = opts.provider as string;
        if (provVal === "claude" || provVal === "codex" || provVal === "all") {
          provider = provVal as ImportProvider;
        } else {
          console.error(`  Unknown provider "${provVal}". Use: claude, codex, all`);
          exit(1);
        }
      }

      const configFile = defaultConfigPath();
      const config = loadDaemonConfig(configFile);
      selectStorageBackendForConfig(configFile, config.storage);
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = daemonPidPath();
      const daemonResult = await ensureDaemon({
        port,
        pidFilePath,
        spawnTimeoutMs: 5000,
        expectedStorageBackend: config.storage.backend,
        enforceUserManagerParent: true,
      });
      if (!daemonResult.connected) {
        console.error(`  ${daemonUnavailableMessage(daemonResult, "not-running")}`);
        exit(1);
      }
      clearDaemonRemediationMarker();

      // Pre-scan for session count (enables accurate live progress bar)
      const claudeProjectsDir = join(homedir(), ".claude", "projects");
      let sessionCount = 0;
      if (provider === "claude" || provider === "all") {
        if (all) {
          if (existsSync(claudeProjectsDir)) {
            for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              sessionCount += findSessionFiles(join(claudeProjectsDir, entry.name)).length;
            }
          }
        } else {
          const cwd = process.cwd();
          const hash = cwdToProjectHash(cwd);
          const dir = join(claudeProjectsDir, hash);
          if (existsSync(dir)) sessionCount = findSessionFiles(dir).length;
        }
      }
      if (provider === "codex" || provider === "all") {
        sessionCount += findAllCodexTranscripts().length;
      }

      const isTTY = process.stderr.isTTY ?? false;
      const renderOpts = { isTTY, width: process.stderr.columns ?? 80, color: isTTY, verbose };
      const state = makeProgressState({
        phases: [{ name: "Import", status: "active" }],
        total: sessionCount,
        dryRun,
      });
      const renderer = new NinjaRenderer({ state, renderOpts, output: process.stderr });

      const providerLabel =
        provider === "codex" ? "Codex CLI" :
        provider === "all"   ? "Claude Code + Codex CLI" :
                               "Claude Code";
      console.error(`\n  Importing ${providerLabel} sessions${all ? " (all projects)" : ""}...\n`);
      renderer.start();

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      const result = await importSessions(client, {
        all, verbose, dryRun, replay, provider,
        onProgress: (patch) => {
          Object.assign(state, patch);
          if (patch.lastResult) renderer.sessionDone();
        },
      });

      renderer.stop();

      if (isTTY && !verbose) {
        state.phases[0].status = "done";
        renderer.printSummary();
        const { printCodexResolutionSummary } = await import("../src/import-summary.js");
        printCodexResolutionSummary(result, console.error);
      } else {
        const { printImportSummary } = await import("../src/import-summary.js");
        if (dryRun) console.error("  [dry-run] No changes written.\n");
        printImportSummary(result, { replay, log: console.error });
        console.error();
      }
      if (result.failed > 0) exit(1);
    });

  // ─── promote ───────────────────────────────────────────────────────────────
  program
    .command("promote")
    .description("Scan summaries and promote durable insights to long-term memory")
    .option("--all", "Promote across all tracked projects")
    .option("--verbose", "Show per-project counts")
    .option("--dry-run", "Preview promotions without writing")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("promote"); exit(0);
      }
      const all: boolean = opts.all ?? false;
      const verbose: boolean = opts.verbose ?? false;
      const dryRun: boolean = opts.dryRun ?? false;

      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const configFile = defaultConfigPath();
      const config = loadDaemonConfig(configFile);
      selectStorageBackendForConfig(configFile, config.storage);
      const port = config.daemon?.port ?? 3737;
      const pidFilePath = daemonPidPath();
      const daemonResult = await ensureDaemon({
        port,
        pidFilePath,
        spawnTimeoutMs: 5000,
        expectedStorageBackend: config.storage.backend,
        enforceUserManagerParent: true,
      });
      if (!daemonResult.connected) {
        console.error(`  ${daemonUnavailableMessage(daemonResult, "not-running")}`);
        exit(1);
      }
      clearDaemonRemediationMarker();

      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");

      if (dryRun) console.log("  [dry-run] No changes will be written.\n");

      // Collect project cwds to promote
      const cwds: string[] = [];
      if (all) {
        const projectsDir = lcmProjectsDir();
        if (existsSync(projectsDir)) {
          for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = join(projectsDir, entry.name, "meta.json");
            if (!existsSync(metaPath)) continue;
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.cwd) cwds.push(meta.cwd);
            } catch { /* skip unreadable */ }
          }
        }
      } else {
        cwds.push(process.cwd());
      }

      let totalProcessed = 0;
      let totalPromoted = 0;
      const total = cwds.length;

      for (let i = 0; i < cwds.length; i++) {
        const cwd = cwds[i];
        if (total > 1) {
          process.stdout.write(`\r  scanning project ${i + 1}/${total}...`);
        } else {
          process.stdout.write(`\r  scanning...`);
        }

        try {
          const result = await client.post<{ processed: number; promoted: number; conversations?: number }>("/promote", {
            cwd,
            dry_run: dryRun,
          });

          totalProcessed += result.processed;
          totalPromoted += result.promoted;

          if (verbose) {
            process.stdout.write("\r");
            const convLabel = result.conversations !== undefined ? `, ${result.conversations} conversation${result.conversations !== 1 ? "s" : ""}` : "";
            console.log(
              `  ${sanitizeTerminalText(cwd)}: ${result.processed} scanned${convLabel}, ${result.promoted} promoted`,
            );
          }
        } catch (err) {
          if (verbose) {
            const message = err instanceof Error ? err.message : "request failed";
            console.error(`  promote failed for ${sanitizeTerminalText(cwd)}: ${sanitizeTerminalText(message)}`);
          }
          continue;
        }
      }
      // Clear the progress line
      process.stdout.write("\r  \r");

      if (totalPromoted === 0) {
        console.log("  Nothing to promote — no new insights found.");
      } else {
        console.log(`  ${totalPromoted} insight${totalPromoted !== 1 ? "s" : ""} promoted to long-term memory`);
      }
      if (verbose) console.log(`  (${totalProcessed} summaries scanned across ${cwds.length} project${cwds.length !== 1 ? "s" : ""})`);
      if (dryRun) console.log("  [dry-run] No changes written.");
      console.log();
    });

  // ─── export ────────────────────────────────────────────────────────────────
  program
    .command("export")
    .description("Export promoted knowledge to a portable JSON file")
    .option("--all", "Export all projects (one JSON per project, written to files)")
    .option("--tags <tags>", "Only export entries matching these comma-separated tags")
    .option("--since <date>", "Only export entries created on or after this ISO date (e.g. 2026-01-01)")
    .option("--output <file>", "Write output to file instead of stdout")
    .option("--format <format>", "Output format: json (default)", "json")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("export"); exit(0);
      }

      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
      const configFile = defaultConfigPath();
      await runWithPublicationRetry(() => {
        selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
      });
      const { exportKnowledge } = await import("../src/portable-knowledge.js");
      const { join } = await import("node:path");

      const tags: string[] | undefined = opts.tags
        ? (opts.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean)
        : undefined;
      const since: string | undefined = opts.since;
      const output: string | undefined = opts.output;
      const all: boolean = opts.all ?? false;

      let cwds: string[] = [];
      if (all) {
        if (output !== undefined) {
          console.error("  --all cannot use one --output file; omit --output to write one file per project.");
          exit(1);
        }
        const { listCliProjects } = await import("../src/cli-storage.js");
        cwds = (await runWithPublicationRetry(() => listCliProjects())).map(project => project.canonical);
      } else {
        cwds.push(process.cwd());
      }

      let total = 0;
      let failures = 0;
      for (const cwd of cwds) {
        let outFile: string | undefined = output;
        if (all && output === undefined) {
          // When --all and no --output, generate filenames automatically
          const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(-40);
          const { createHash } = await import("node:crypto");
          const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
          outFile = join(process.cwd(), `lcm-export-${slug}-${suffix}.json`);
        }
        try {
          const exportOptions = {
            tags,
            since,
            output: outFile,
            ...(publicationConvergence === undefined ? {} : { _publicationConvergence: publicationConvergence }),
          };
          const result = await exportKnowledge(cwd, exportOptions);
          total += result.exported;
          if (all) {
            console.error(`  ${cwd}: ${result.exported} entries → ${outFile}`);
          } else if (outFile) {
            console.error(`  Exported ${result.exported} entries to ${outFile}`);
          }
        } catch (err: any) {
          if (err instanceof PrivateMutationLockContentionError || err instanceof BackendPublicationJournalError) throw err;
          failures++;
          process.stderr.write("  Export failed for a selected project. Check its storage binding and retry.\n");
        }
      }

      if (all) console.error(`\n  Total: ${total} entries exported`);
      if (failures > 0) exit(1);
    });

  // ─── import-knowledge ──────────────────────────────────────────────────────
  program
    .command("import-knowledge <file>")
    .description("Import exported knowledge JSON into lossless memory")
    .option("--merge", "Merge with existing entries, deduplicating (default)")
    .option("--dry-run", "Preview import without writing anything")
    .option("--confidence <n>", "Override confidence for all imported entries (0.0–1.0)")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (file: string, opts) => {
      if (opts.help) {
        const { printHelp } = await import("../src/cli-help.js");
        printHelp("import-knowledge"); exit(0);
      }

      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { selectStorageBackendForConfig } = await import("../src/storage/backend.js");
      const configFile = defaultConfigPath();
      selectStorageBackendForConfig(configFile, loadDaemonConfig(configFile).storage);
      const { importKnowledge } = await import("../src/portable-knowledge.js");
      const { readFileSync } = await import("node:fs");

      const dryRun: boolean = opts.dryRun ?? false;
      const confidence: number | undefined = opts.confidence !== undefined
        ? parseFloat(opts.confidence as string)
        : undefined;

      if (confidence !== undefined && (isNaN(confidence) || confidence < 0 || confidence > 1)) {
        console.error("  --confidence must be a number between 0.0 and 1.0");
        exit(1);
      }

      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch (err: any) {
        console.error("  Cannot read the knowledge export file.");
        exit(1);
      }

      let doc: any;
      try {
        doc = JSON.parse(raw);
      } catch {
        console.error("  Invalid JSON in export file");
        exit(1);
      }

      if (!doc || typeof doc.version !== "number" || !Array.isArray(doc.entries)) {
        console.error("  File does not look like an lcm export (missing version or entries)");
        exit(1);
      }

      const cwd = process.cwd();

      try {
        const result = await importKnowledge(cwd, doc, { merge: true, dryRun, confidence });
        if (result.dryRun) {
          console.error(`\n  [dry-run] Would import ${result.total} entries. No changes written.\n`);
        } else {
          console.error(`\n  Imported ${result.imported} entries (${result.skipped} skipped) into ${cwd}\n`);
        }
      } catch (err: any) {
        console.error("  Knowledge import failed. Check the document and selected storage, then retry.");
        exit(1);
      }
    });

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (!shouldRunRootBootstrapMigration(actionCommand)) return;
    const action = actionCommand.name();
    const usePublicationConvergence = shouldUsePublicationConvergence(actionCommand);
    if (usePublicationConvergence) {
      const { createInstallerPublicationConvergence } = await import("../installer/install.js");
      publicationConvergence ??= await createInstallerPublicationConvergence();
      const { withPublicationAdmissionRetry } = await import("../src/storage/publication-convergence.js");
      publicationAdmissionRetry = (run) => withPublicationAdmissionRetry(run, publicationConvergence);
      await withPublicationAdmissionRetry(() => migrateLegacyHomeWithRetry({
        migrate,
        sleep: preflightSeams?.sleep ?? DEFAULT_ROOT_BOOTSTRAP_RETRY_SEAMS.sleep,
        attempt: preflightSeams?.attempt,
      }), publicationConvergence);
      return;
    }
    await migrateLegacyHomeWithRetry({
      migrate,
      sleep: preflightSeams?.sleep ?? DEFAULT_ROOT_BOOTSTRAP_RETRY_SEAMS.sleep,
      attempt: preflightSeams?.attempt,
    });
  });

  // ─── Unknown command fallback ──────────────────────────────────────────────
  let unknownCommandCompletion: Promise<void> | undefined;
  program.on("command:*", (operands: string[]) => {
    unknownCommandCompletion = (async () => {
      process.stderr.write(`lcm: unknown command '${operands[0]}'\n\n`);
      const { printHelp } = await import("../src/cli-help.js");
      printHelp();
      exit(1);
    })();
  });

  if (cliArgv.slice(2).length === 0) {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp(customHelp?.command);
    exit(0);
  }
  await program.parseAsync(cliArgv);
  await unknownCommandCompletion;
}

/** @internal Top-level rejection handler kept separate for deterministic tests. */
export function handleCliError(err: unknown): never {
  console.error(
    err instanceof BackendPublicationJournalError
      ? BACKEND_PUBLICATION_ADMISSION_DIAGNOSTIC
      : err instanceof ConfigValidationError
      || err instanceof StorageBackendUnavailableError
      || err instanceof BootstrapLockContentionError
      || err instanceof PrivateMutationLockContentionError
      ? err.message
      : "LCM command failed. Check the command inputs and selected storage configuration.",
  );
  return exit(1);
}

/** @internal Execute only when this module is the resolved process entrypoint. */
export function runMainIfInvoked(
  invokedPath: string | undefined,
  currentFilePath: string,
  runner: () => Promise<void> = runCli,
  onError: (error: unknown) => unknown = handleCliError,
): void {
  if (shouldRunMain(invokedPath, currentFilePath)) {
    void runner().catch(onError);
  }
}

runMainIfInvoked(argv[1], fileURLToPath(import.meta.url));
