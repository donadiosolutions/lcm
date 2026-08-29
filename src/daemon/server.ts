import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import {
  daemonConfigSnapshotWitnessEqual,
  parseDaemonConfig,
  readDaemonConfigSnapshot,
  resolveDaemonConfigEnv,
  type DaemonConfig,
  type DaemonConfigSnapshotWitness,
} from "./config.js";
import { sanitizeError } from "./safe-error.js";
import { stagedPostgreSqlUnavailablePayload } from "./staged-postgresql.js";
import { readAuthToken } from "./auth.js";
import type { ProxyManager } from "./proxy-manager.js";
import { createCompactHandler } from "./routes/compact.js";
import { createPromoteHandler } from "./routes/promote.js";
import { createRestoreHandler } from "./routes/restore.js";
import { createGrepHandler } from "./routes/grep.js";
import { createSearchHandler } from "./routes/search.js";
import { createExpandHandler } from "./routes/expand.js";
import { createDescribeHandler } from "./routes/describe.js";
import { createStoreHandler } from "./routes/store.js";
import { createRecentHandler } from "./routes/recent.js";
import { createIngestHandler } from "./routes/ingest.js";
import { createPromptSearchHandler } from "./routes/prompt-search.js";
import { createStatusHandler } from "./routes/status.js";
import { createSessionCompleteHandler } from "./routes/session-complete.js";
import { createPromoteAllEventsHandler, createPromoteEventsHandler } from "./routes/promote-events.js";
import {
  createPromoteEventsNotifyHandler,
  PASSIVE_EVENT_PROCESSOR_DEFAULTS,
  PassiveEventProcessor,
  type BackgroundPublicationAdmission,
} from "./passive-event-processor.js";
import { createStatsHandler } from "./routes/stats.js";
import { createPoolStatsHandler } from "./routes/pool-stats.js";
import { createReviewStaleHandler } from "./routes/review-stale.js";
import { createInvocationControlHandler } from "./routes/invocation-control.js";
import { throwIfAborted } from "./cancellation.js";
import {
  createInvocationCoordinator,
  type InvocationCoordinator,
} from "./invocation-coordinator.js";
import { PKG_VERSION, RUNTIME_DIGEST } from "./version.js";
import { normalizeDaemonPort, normalizeIdleTimeoutMs } from "./http-url.js";
import {
  type DaemonLifecycleTestIdentity,
  isDaemonLifecycleTestIdentity,
  isVitestWorkerEntrypoint,
} from "./lifecycle-scope.js";
import { configPath as defaultConfigPath, projectsDir as lcmProjectsDir } from "../runtime-paths.js";
import { projectMapPathsForHash, watchProjectMap } from "../project-map.js";
import { createStorageBackendFactory, type StorageBackendFactory } from "../storage/index.js";
import { assertStorageBackendPublication } from "../storage/backend.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFile,
} from "../security-files.js";
import {
  assertBackendPublicationConfigAccess,
  assertBackendPublicationConfigReadAccess,
  BackendPublicationJournalError,
  backendPublicationHomeForConfigPath,
  openBackendPublicationReadRoot,
  type BackendPublicationLockToken,
  withBackendPublicationConsumerLockAsync,
} from "../storage/backend-publication.js";
export { PKG_VERSION };

export type RoutePublicationAdmission = <T>(
  operation: (publicationLockToken: BackendPublicationLockToken) => Promise<T> | T,
) => Promise<T>;

export type RouteExecutionContext = Readonly<{
  publicationLockToken?: BackendPublicationLockToken;
  withPublicationAdmission?: RoutePublicationAdmission;
  signal?: AbortSignal;
  /** Narrow invocation-control seam used by invocation-aware compact routes. */
  invocationCoordinator?: InvocationCoordinator;
}>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  context?: RouteExecutionContext,
) => Promise<void>;
export type RouteAdmission = "read" | "mutating";
type BuiltInRoutePublicationMode = "retained" | "operation-scoped";
type RequestLifecycleEvent = "cancelled" | "settled";
type RegisteredRoute = Readonly<{
  handler: RouteHandler;
  admission: RouteAdmission;
  publicationMode: BuiltInRoutePublicationMode;
}>;
export type DaemonInstance = {
  address: () => AddressInfo;
  /** Stable UUID for this daemon process generation. */
  daemonInstanceId: string;
  /** Coordinator exposed for invocation-aware callers and lifecycle tests. */
  invocationCoordinator: InvocationCoordinator;
  stop: () => Promise<void>;
  /**
   * Runtime overrides inherit a built-in route's admission classification.
   * New routes are short-admitted by default and may opt into retained
   * mutation admission with the optional fourth argument. Existing mutators
   * cannot be downgraded by an override.
   */
  registerRoute: (method: string, path: string, handler: RouteHandler, admission?: RouteAdmission) => void;
  idleTriggered: boolean;
};
export type DaemonOptions = {
  proxyManager?: ProxyManager;
  onIdle?: () => void;
  tokenPath?: string;
  /** @internal Deterministic idle-timer seams for lifecycle tests. */
  _setTimeout?: typeof setTimeout;
  /** @internal Deterministic idle-timer seams for lifecycle tests. */
  _clearTimeout?: typeof clearTimeout;
  /** @internal Deterministic periodic-ingest seam for lifecycle tests. */
  _scanForTranscripts?: (
    withPublicationAdmission: BackgroundPublicationAdmission,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** @internal Deterministic packaged-runtime identity seam for health tests. */
  _runtimeDigest?: string;
  /** @internal Explicit owned daemon identity for lifecycle isolation tests. */
  _testIdentity?: DaemonLifecycleTestIdentity;
  /** @internal Deterministic auth-token read seam for preflight ordering tests. */
  _readAuthToken?: typeof readAuthToken;
  /** @internal Deterministic storage-factory seam for daemon unit tests. */
  _createStorageBackendFactory?: typeof createStorageBackendFactory;
  /** @internal Deterministic config-snapshot seam for daemon read-admission tests. */
  _readDaemonConfigSnapshot?: typeof readDaemonConfigSnapshot;
  /** @internal Deterministic daemon UUID seam for invocation-control tests. */
  _daemonInstanceId?: string;
  /** Canonical daemon config path used for request-time publication admission. */
  publicationConfigPath?: string;
  /** @internal Test-only publication admission seam. */
  _assertBackendPublication?: (
    homeDir: string | undefined,
    backend: DaemonConfig["storage"]["backend"],
  ) => Readonly<{ journalChecksumSha256: string | null }> | void;
  /** @internal Test-only async publication-lock seam. */
  _withBackendPublicationConsumerLockAsync?: typeof withBackendPublicationConsumerLockAsync;
  /** @internal Test-only request lifecycle observer. */
  _onRequestLifecycle?: (event: RequestLifecycleEvent, signal: AbortSignal) => void;
  /** @internal Test-only observer for the closed built-in route registry. */
  _onBuiltInRouteRegistered?: (
    key: string,
    admission: RouteAdmission,
    publicationMode: BuiltInRoutePublicationMode,
  ) => void;
};

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REQUEST_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_RESPONSE_BYTES = MAX_BODY_BYTES;

export function claudeProjectDirName(cwd: string): string {
  const sanitized = cwd
    .replace(/^[A-Za-z]:/, "")
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/:/g, "-")
    .replace(/^-+/, "");
  return sanitized || "root";
}

export function projectTranscriptScanCwds(projectHash: string, metaCwd: string): string[] {
  const candidates = new Set<string>([metaCwd]);
  try {
    for (const mappedPath of projectMapPathsForHash(projectHash)) {
      candidates.add(mappedPath);
    }
  } catch {
    // Fall back to meta.cwd if the user is in the middle of editing map.json.
  }
  return [...candidates];
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Drain and discard remaining data so we can write a response
      req.resume();
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // Sanitize error strings before serializing to prevent stack-trace / path leakage
  const safe =
    data !== null && typeof data === "object" && "error" in data && typeof (data as Record<string, unknown>).error === "string"
      ? { ...(data as Record<string, unknown>), error: sanitizeError((data as Record<string, unknown>).error as string) }
      : data;
  const body = JSON.stringify(safe);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

type BufferedHeaderValue = number | string | string[];
type BufferedHeader = Readonly<{ name: string; value: BufferedHeaderValue }>;

function responseHeadersSentError(): Error & { code: string } {
  return Object.assign(new Error("Cannot set headers after they are sent to the client"), {
    code: "ERR_HTTP_HEADERS_SENT",
  });
}

function responseWriteAfterEndError(): Error & { code: string } {
  return Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
}

/**
 * Admitted handlers must not reach the client until their retained mutation
 * permit or lock-free read witness has passed post-handler revalidation. This
 * bounded response mirrors the response methods used by route handlers while
 * keeping the real transport untouched.
 */
class BufferedServerResponse {
  private readonly headers = new Map<string, BufferedHeader>();
  private readonly chunks: Buffer[] = [];
  private bodyBytes = 0;
  private started = false;
  private ended = false;
  private statusCode = 200;

  public constructor(private readonly actual: ServerResponse) {}

  public setHeader(name: string, value: number | string | readonly string[]): this {
    if (this.started) throw responseHeadersSentError();
    const normalizedValue: BufferedHeaderValue = typeof value === "string" || typeof value === "number"
      ? value
      : [...value];
    this.headers.set(name.toLowerCase(), { name, value: normalizedValue });
    return this;
  }

  public getHeader(name: string): BufferedHeaderValue | undefined {
    return this.headers.get(name.toLowerCase())?.value;
  }

  public removeHeader(name: string): void {
    if (this.started) throw responseHeadersSentError();
    this.headers.delete(name.toLowerCase());
  }

  public writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this {
    if (this.started) throw responseHeadersSentError();
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
      throw new RangeError(`Invalid status code: ${statusCode}`);
    }
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value !== undefined) this.setHeader(name, value);
    }
    this.started = true;
    return this;
  }

  public write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
  ): boolean {
    if (this.ended) throw responseWriteAfterEndError();
    const bufferedChunk = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    if (this.bodyBytes + bufferedChunk.byteLength > MAX_BUFFERED_RESPONSE_BYTES) {
      throw Object.assign(new Error("buffered response exceeds the response size limit"), { statusCode: 500 });
    }
    this.chunks.push(bufferedChunk);
    this.bodyBytes += bufferedChunk.byteLength;
    this.started = true;
    return true;
  }

  public end(chunk?: string | Uint8Array, encoding?: BufferEncoding): this {
    if (this.ended) throw responseWriteAfterEndError();
    if (chunk !== undefined) this.write(chunk, encoding);
    this.started = true;
    this.ended = true;
    return this;
  }

  public discard(): void {
    this.headers.clear();
    this.chunks.length = 0;
    this.bodyBytes = 0;
  }

  public flush(): void {
    const headers: OutgoingHttpHeaders = {};
    for (const { name, value } of this.headers.values()) headers[name] = value;
    this.actual.writeHead(this.statusCode, headers);
    this.actual.end(Buffer.concat(this.chunks));
  }
}

function isResponseWritable(res: ServerResponse): boolean {
  return !res.headersSent && !res.writableEnded && !res.destroyed && res.writable !== false;
}

function sendJsonIfWritable(res: ServerResponse, status: number, data: unknown): void {
  if (!isResponseWritable(res)) return;
  sendJson(res, status, data);
}

function requestErrorResponse(err: unknown): Readonly<{ status: number; message: string }> {
  const status = (err as { statusCode?: number })?.statusCode ?? 500;
  return Object.freeze({
    status,
    message: status === 413
      ? "payload too large"
      : sanitizeError(err instanceof Error ? err.message : "internal error"),
  });
}

function clearIdleTimer(timer: ReturnType<typeof setTimeout> | null, clearTimer: typeof clearTimeout): null {
  if (timer) clearTimer(timer);
  return null;
}

type RequestCancellation = Readonly<{
  signal: AbortSignal;
  cleanup: () => void;
}>;

export function requestCancellation(
  req: IncomingMessage,
  res: ServerResponse,
  shutdownSignal: AbortSignal,
  onAbort?: (signal: AbortSignal) => void,
): RequestCancellation {
  const requestController = new AbortController();
  const combinedController = new AbortController();

  const abortRequest = (): void => {
    requestController.abort();
  };
  const abortCombined = (): void => {
    if (combinedController.signal.aborted) return;
    combinedController.abort();
    onAbort?.(combinedController.signal);
  };
  const onRequestAborted = (): void => abortRequest();
  const onRequestClose = (): void => {
    if (!req.complete) abortRequest();
  };
  const onResponseClose = (): void => {
    if (!res.writableEnded && !res.writableFinished) abortRequest();
  };

  requestController.signal.addEventListener("abort", abortCombined, { once: true });
  if (shutdownSignal.aborted) abortCombined();
  else shutdownSignal.addEventListener("abort", abortCombined, { once: true });
  if (typeof req.once === "function") req.once("aborted", onRequestAborted);
  if (typeof req.once === "function") req.once("close", onRequestClose);
  if (typeof res.once === "function") res.once("close", onResponseClose);
  if (req.aborted || (req.destroyed && !req.complete)) abortRequest();
  if (res.destroyed) abortRequest();

  return {
    signal: combinedController.signal,
    cleanup: () => {
      requestController.signal.removeEventListener("abort", abortCombined);
      shutdownSignal.removeEventListener("abort", abortCombined);
      if (typeof req.off === "function") req.off("aborted", onRequestAborted);
      if (typeof req.off === "function") req.off("close", onRequestClose);
      if (typeof res.off === "function") res.off("close", onResponseClose);
    },
  };
}

function stagedPostgreSqlUnavailableHandler(operation: string): RouteHandler {
  return async (_req, res) => {
    sendJson(res, 503, stagedPostgreSqlUnavailablePayload(operation));
  };
}

/** Revalidate config/publication state before each route or scheduled scan. */
function assertDaemonRequestStorageAdmission(
  startupConfig: DaemonConfig,
  publicationConfigPath: string,
  lockToken?: BackendPublicationLockToken,
): void {
  let content: string;
  let observedContent: string | null;
  try {
    content = readBoundedRegularFile(publicationConfigPath, {
      allowedRoot: dirname(publicationConfigPath),
      maxBytes: MAX_REQUEST_CONFIG_BYTES,
    });
    observedContent = content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "{}";
    observedContent = null;
  }
  const requestConfig = parseDaemonConfig(content, {}, resolveDaemonConfigEnv(process.env));
  if (requestConfig.storage.backend !== startupConfig.storage.backend) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "daemon request backend differs from the authenticated startup backend",
    );
  }
  assertBackendPublicationConfigAccess(
    publicationConfigPath,
    requestConfig.storage.backend,
    observedContent,
    undefined,
    lockToken,
  );
  assertStorageBackendPublication({
    backend: requestConfig.storage.backend,
    homeDir: backendPublicationHomeForConfigPath(publicationConfigPath),
  }, lockToken);
}

/**
 * Admit a read route without taking publication mutation ownership. The
 * bounded snapshot is checked before and after the lock-free publication
 * admission so config replacement cannot authorize a mixed read.
 */
type DaemonReadStorageAdmissionWitness = Readonly<{
  config: DaemonConfigSnapshotWitness | null;
  journalChecksumSha256: string | null;
}>;

function daemonReadStorageAdmissionWitnessEqual(
  left: DaemonReadStorageAdmissionWitness,
  right: DaemonReadStorageAdmissionWitness,
): boolean {
  return left.journalChecksumSha256 === right.journalChecksumSha256
    && (left.config === null
      ? right.config === null
      : right.config !== null && daemonConfigSnapshotWitnessEqual(left.config, right.config));
}

function assertDaemonReadStorageAdmission(
  startupConfig: DaemonConfig,
  publicationConfigPath: string,
  publicationHome: string | undefined,
  assertBackendPublicationOverride?: DaemonOptions["_assertBackendPublication"],
  readSnapshot: typeof readDaemonConfigSnapshot = readDaemonConfigSnapshot,
): DaemonReadStorageAdmissionWitness {
  if (assertBackendPublicationOverride !== undefined) {
    const publicationWitness = assertBackendPublicationOverride(publicationHome, startupConfig.storage.backend);
    return Object.freeze({
      config: null,
      journalChecksumSha256: publicationWitness?.journalChecksumSha256 ?? null,
    });
  }
  const publicationRoot = dirname(publicationConfigPath);
  if (lstatSync(publicationRoot).isSymbolicLink()) {
    throw new Error("private LCM root must not be a symbolic link");
  }
  const privateRoot = publicationHome === undefined
    ? openPrivateDirectory(publicationRoot)
    : openBackendPublicationReadRoot(publicationHome);
  try {
    const assertReadRoot = (): void => {
      if (lstatSync(publicationRoot).isSymbolicLink()) {
        throw new Error("private LCM root must not be a symbolic link");
      }
      if (privateRoot === undefined) return;
      assertPrivateDirectory(privateRoot, publicationRoot, privateRoot.witness);
    };
    assertReadRoot();
    const first = readSnapshot(publicationConfigPath);
    if (first.config.storage.backend !== startupConfig.storage.backend) {
      throw new BackendPublicationJournalError(
        "unexpected-state",
        "daemon request backend differs from the authenticated startup backend",
      );
    }
    const publicationWitness = assertBackendPublicationConfigReadAccess(
      publicationConfigPath,
      first.config.storage.backend,
      first.witness,
    );
    const second = readSnapshot(publicationConfigPath);
    if (
      second.config.storage.backend !== startupConfig.storage.backend
      || !daemonConfigSnapshotWitnessEqual(first.witness, second.witness)
    ) {
      throw new BackendPublicationJournalError(
        "unexpected-state",
        "daemon request config changed during lock-free read admission",
      );
    }
    assertReadRoot();
    return Object.freeze({
      config: second.witness,
      journalChecksumSha256: publicationWitness.journalChecksumSha256,
    });
  } finally {
    privateRoot?.close();
  }
}

async function settleCleanup(callback: () => void | Promise<void>): Promise<void> {
  try {
    await callback();
  } catch {
    // Preserve the primary startup or request-lifecycle result.
  }
}

export async function createDaemon(config: DaemonConfig, options?: DaemonOptions): Promise<DaemonInstance> {
  const hasSetTimeoutOverride = options?._setTimeout !== undefined;
  const hasClearTimeoutOverride = options?._clearTimeout !== undefined;
  if (hasSetTimeoutOverride !== hasClearTimeoutOverride) {
    throw new Error("Daemon idle timer overrides must provide both _setTimeout and _clearTimeout");
  }
  const startTime = Date.now();
  const proxyManager = options?.proxyManager;
  const setIdleTimeout = options?._setTimeout ?? setTimeout;
  const clearIdleTimeout = options?._clearTimeout ?? clearTimeout;
  const listenPort = normalizeDaemonPort(config.daemon.port, { allowZero: true });
  const idleTimeoutMs = normalizeIdleTimeoutMs(config.daemon.idleTimeoutMs);
  const runtimeDigest = options?._runtimeDigest ?? RUNTIME_DIGEST;
  const shutdownController = new AbortController();
  const hasTestIdentity = Object.prototype.hasOwnProperty.call(options ?? {}, "_testIdentity");
  if (hasTestIdentity && !isDaemonLifecycleTestIdentity(options?._testIdentity)) {
    throw new Error("Daemon test identity is incomplete or malformed");
  }
  const daemonEntrypoint = options?._testIdentity?.entrypoint ?? process.argv[1];
  const daemonOwnerId = options?._testIdentity?.ownerId;
  if (options?.tokenPath && isVitestWorkerEntrypoint(daemonEntrypoint)) {
    throw new Error("Refusing to authenticate a Vitest worker as a daemon entrypoint");
  }
  const serverToken = options?.tokenPath
    ? (options._readAuthToken ?? readAuthToken)(options.tokenPath)
    : null;
  if (options?.tokenPath && serverToken === null) {
    throw new Error(`Auth token file specified but could not be read: ${options.tokenPath}`);
  }
  const publicationConfigPath = options?.publicationConfigPath ?? defaultConfigPath();
  const publicationHome = backendPublicationHomeForConfigPath(publicationConfigPath);
  const withConsumerPublicationLockAsync = options?._withBackendPublicationConsumerLockAsync
    ?? withBackendPublicationConsumerLockAsync;
  const assertDaemonNotShuttingDown = (): void => {
    if (!shutdownController.signal.aborted) return;
    throw Object.assign(new Error("daemon is shutting down"), { name: "AbortError" });
  };
  const assertRequestAdmission = (lockToken?: BackendPublicationLockToken): void => {
    if (options?._assertBackendPublication !== undefined) {
      options._assertBackendPublication(publicationHome, config.storage.backend);
      return;
    }
    assertDaemonRequestStorageAdmission(config, publicationConfigPath, lockToken);
  };
  const withBackgroundPublicationAdmission: BackgroundPublicationAdmission = async operation => {
    assertDaemonNotShuttingDown();
    return withConsumerPublicationLockAsync(publicationHome, async publicationLockToken => {
      assertDaemonNotShuttingDown();
      assertRequestAdmission(publicationLockToken);
      assertDaemonNotShuttingDown();
      return operation(publicationLockToken);
    });
  };
  const withRequestPublicationAdmission = (
    retainedToken: BackendPublicationLockToken,
  ): RoutePublicationAdmission => async operation => {
    assertDaemonNotShuttingDown();
    return withConsumerPublicationLockAsync(
      publicationHome,
      async publicationLockToken => {
        assertDaemonNotShuttingDown();
        assertRequestAdmission(publicationLockToken);
        assertDaemonNotShuttingDown();
        return operation(publicationLockToken);
      },
      { lockToken: retainedToken },
    );
  };
  const invocationCoordinator = createInvocationCoordinator({
    daemonInstanceId: options?._daemonInstanceId,
  });
  const createFactory = options?._createStorageBackendFactory ?? createStorageBackendFactory;
  let storageFactory: StorageBackendFactory;
  try {
    storageFactory = await createFactory(
      config.storage,
      publicationHome,
      options?._assertBackendPublication === undefined
        ? undefined
        : ({ homeDir, backend }) => options._assertBackendPublication!(homeDir, backend),
    );
  } catch (error) {
    shutdownController.abort();
    await settleCleanup(() => invocationCoordinator.shutdown());
    throw error;
  }
  const sqliteStorage = config.storage.backend === "sqlite";
  let constructedProcessor: PassiveEventProcessor | undefined;
  let constructedWatcher: ReturnType<typeof watchProjectMap> | undefined;
  let constructedIngestInterval: ReturnType<typeof setInterval> | undefined;
  let constructedIngestScan: Promise<void> | undefined;
  let startupCleanupStarted = false;
  let storageFactoryClosed = false;
  const closeStorageFactory = async (): Promise<void> => {
    if (storageFactoryClosed) return;
    storageFactoryClosed = true;
    await storageFactory.close();
  };
  try {
  const routes = new Map<string, RegisteredRoute>();

  const registerBuiltInRoute = (
    method: string,
    path: string,
    handler: RouteHandler,
    admission: RouteAdmission,
    publicationMode: BuiltInRoutePublicationMode = "retained",
  ): void => {
    const key = `${method} ${path}`;
    routes.set(key, { handler, admission, publicationMode });
    options?._onBuiltInRouteRegistered?.(key, admission, publicationMode);
  };

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTriggered = false;
  const onIdle = options?.onIdle ?? (() => {
    console.log("[lcm] idle timeout — shutting down");
    process.exit(0);
  });

  function resetIdleTimer() {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearIdleTimeout(idleTimer);
    idleTimer = setIdleTimeout(() => {
      idleTriggered = true;
      onIdle();
    }, idleTimeoutMs);
  }

  registerBuiltInRoute("GET", "/health", async (req, res) => {
    if (serverToken && req.headers.authorization === undefined) {
      sendJson(res, 200, {
        status: "ok",
        version: PKG_VERSION,
        storageBackend: config.storage.backend,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        pid: process.pid,
        ...(daemonOwnerId ? { ownerId: daemonOwnerId } : {}),
      });
      return;
    }
    const storageHealth = await storageFactory.health();
    const healthy = storageHealth.status === "healthy";
    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? "ok" : "unavailable",
      version: PKG_VERSION,
      storageBackend: config.storage.backend,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
      entrypoint: daemonEntrypoint,
      ...(daemonOwnerId ? { ownerId: daemonOwnerId } : {}),
      ...(serverToken && req.headers.authorization !== undefined
        ? { daemonInstanceId: invocationCoordinator.daemonInstanceId }
        : {}),
      ...(serverToken && req.headers.authorization !== undefined && runtimeDigest
        ? { runtimeDigest }
        : {}),
      ...(healthy ? {} : {
        storage: {
          status: storageHealth.status,
          ...(storageHealth.error ? { error: storageHealth.error.toJSON() } : {}),
        },
      }),
    });
  }, "read");
  registerBuiltInRoute(
    "POST",
    "/compact",
    createCompactHandler(config, storageFactory, {
      daemonInstanceId: invocationCoordinator.daemonInstanceId,
    }),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute(
    "POST",
    "/promote",
    createPromoteHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute(
    "POST",
    "/restore",
    createRestoreHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute("POST", "/grep", createGrepHandler(config, storageFactory), "read");
  registerBuiltInRoute("POST", "/search", createSearchHandler(config, storageFactory), "read");
  registerBuiltInRoute("POST", "/expand", createExpandHandler(config, storageFactory), "read");
  registerBuiltInRoute("POST", "/describe", createDescribeHandler(config, storageFactory), "read");
  registerBuiltInRoute(
    "POST",
    "/store",
    createStoreHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute("POST", "/recent", createRecentHandler(config, storageFactory), "read");
  registerBuiltInRoute(
    "POST",
    "/ingest",
    createIngestHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute("POST", "/prompt-search", createPromptSearchHandler(config, storageFactory), "read");
  registerBuiltInRoute(
    "POST",
    "/session-complete",
    createSessionCompleteHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  const passiveEventProcessor = new PassiveEventProcessor(
    config,
    PASSIVE_EVENT_PROCESSOR_DEFAULTS,
    {
      storageFactory,
      withPublicationAdmission: withBackgroundPublicationAdmission,
      signal: shutdownController.signal,
    },
  );
  constructedProcessor = passiveEventProcessor;
  registerBuiltInRoute(
    "POST",
    "/promote-events",
    createPromoteEventsHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute(
    "POST",
    "/promote-events/all",
    createPromoteAllEventsHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute(
    "POST",
    "/promote-events/notify",
    createPromoteEventsNotifyHandler(passiveEventProcessor),
    "read",
  );
  registerBuiltInRoute(
    "GET",
    "/stats",
    sqliteStorage ? createStatsHandler() : stagedPostgreSqlUnavailableHandler("stats"),
    "read",
  );
  registerBuiltInRoute(
    "GET",
    "/stats/pool",
    sqliteStorage ? createPoolStatsHandler() : stagedPostgreSqlUnavailableHandler("pool stats"),
    "read",
  );
  registerBuiltInRoute(
    "POST",
    "/review-stale",
    createReviewStaleHandler(config, storageFactory),
    "mutating",
    "operation-scoped",
  );
  registerBuiltInRoute(
    "POST",
    "/invocation-control",
    createInvocationControlHandler(invocationCoordinator),
    "read",
  );
  // Status handler is registered after listen() when we know the actual port
  const projectMapWatcher = watchProjectMap();
  constructedWatcher = projectMapWatcher;

  // Periodic transcript ingestion scan
  const INGEST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const ingestHandler = createIngestHandler(config, storageFactory);

  const scanForTranscripts = async (
    withPublicationAdmission: BackgroundPublicationAdmission,
    signal: AbortSignal = shutdownController.signal,
  ) => {
    try {
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const projectsDir = lcmProjectsDir();
      if (!existsSync(projectsDir)) return;

      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metaPath = join(projectsDir, entry.name, "meta.json");
        if (!existsSync(metaPath)) continue;

        let meta: { cwd?: string; lastCompact?: string } = {};
        try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { continue; }
        if (!meta.cwd) continue;

        // Find Claude Code session files for this project's canonical cwd and aliases.
        const scanCwds = projectTranscriptScanCwds(entry.name, meta.cwd);

        for (const scanCwd of scanCwds) {
          const sessionsDir = join(homedir(), ".claude", "projects", claudeProjectDirName(scanCwd));
          if (!existsSync(sessionsDir)) continue;

          for (const file of readdirSync(sessionsDir)) {
            if (!file.endsWith(".jsonl")) continue;
            const sessionId = file.replace(".jsonl", "");
            const transcriptPath = join(sessionsDir, file);

            // Use the ingest route logic directly
            const mockReq = {} as unknown as IncomingMessage;
            const response = { statusCode: 200, body: "" };
            const mockRes = {
              writeHead: (code: number) => { response.statusCode = code; },
              end: (data: string) => { response.body = data; },
            } as unknown as ServerResponse;

            await ingestHandler(mockReq, mockRes, JSON.stringify({
              session_id: sessionId,
              cwd: scanCwd,
              transcript_path: transcriptPath,
            }), { withPublicationAdmission, signal });
          }
        }
      }
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) throw error;
      // non-fatal: periodic scan failure shouldn't crash daemon
    }
  };

  let activeIngestScan: Promise<void> | undefined;
  const runScheduledTranscriptScan = (): Promise<void> => {
    if (activeIngestScan) return activeIngestScan;
    const scan = Promise.resolve()
      .then(() => {
        return (options?._scanForTranscripts ?? scanForTranscripts)(
          withBackgroundPublicationAdmission,
          shutdownController.signal,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof BackendPublicationJournalError) {
          console.warn("[lcm] periodic transcript scan blocked by backend publication admission");
        }
        return undefined;
      })
      .finally(() => {
        activeIngestScan = undefined;
        constructedIngestScan = undefined;
      });
    activeIngestScan = scan;
    constructedIngestScan = scan;
    return scan;
  };

  const ingestInterval = setInterval(runScheduledTranscriptScan, INGEST_INTERVAL_MS);
  constructedIngestInterval = ingestInterval;
  ingestInterval?.unref(); // don't prevent process exit

  const server: Server = createServer(async (req, res) => {
    resetIdleTimer();
    const cancellation = requestCancellation(
      req,
      res,
      shutdownController.signal,
      signal => options?._onRequestLifecycle?.("cancelled", signal),
    );
    const requestSignal = cancellation.signal;
    let bufferedResponse: BufferedServerResponse | undefined;
    try {
      const key = `${req.method} ${req.url?.split("?")[0]}`;
      const route = routes.get(key);
      if (!route) {
        sendJsonIfWritable(res, 404, { error: "not found" });
        return;
      }
      // Public health is intentionally storage-free. Supplying credentials opts
      // into authenticated diagnostics and therefore must fail closed.
      const rawAuth = req.headers["authorization"];
      const publicHealth = serverToken !== null && key === "GET /health" && rawAuth === undefined;
      if (key === "POST /invocation-control" && serverToken === null) {
        sendJsonIfWritable(res, 401, { error: "unauthorized" });
        return;
      }
      if (serverToken) {
        const authHeader = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "";
        if (!publicHealth && authHeader.trim() !== `Bearer ${serverToken}`) {
          sendJsonIfWritable(res, 401, { error: "unauthorized" });
          return;
        }
      }

      assertDaemonNotShuttingDown();
      const body = req.method !== "GET" ? await readBody(req) : "";
      if (route.admission === "mutating") {
        if (route.publicationMode === "operation-scoped") {
          assertDaemonNotShuttingDown();
          assertRequestAdmission();
          await route.handler(req, res, body, {
            withPublicationAdmission: withBackgroundPublicationAdmission,
            signal: requestSignal,
            invocationCoordinator,
          });
          return;
        }
        bufferedResponse = new BufferedServerResponse(res);
        await withConsumerPublicationLockAsync(publicationHome, async (lockToken) => {
          assertDaemonNotShuttingDown();
          assertRequestAdmission(lockToken);
          await route.handler(req, bufferedResponse as unknown as ServerResponse, body, {
            publicationLockToken: lockToken,
            withPublicationAdmission: withRequestPublicationAdmission(lockToken),
            signal: requestSignal,
            invocationCoordinator,
          });
        });
        throwIfAborted(requestSignal);
        bufferedResponse.flush();
        bufferedResponse = undefined;
      } else {
        if (publicHealth) {
          await route.handler(req, res, body, { signal: requestSignal, invocationCoordinator });
        } else {
          bufferedResponse = new BufferedServerResponse(res);
          const admissionWitness = assertDaemonReadStorageAdmission(
            config,
            publicationConfigPath,
            publicationHome,
            options?._assertBackendPublication,
            options?._readDaemonConfigSnapshot,
          );
          await route.handler(req, bufferedResponse as unknown as ServerResponse, body, {
            signal: requestSignal,
            invocationCoordinator,
          });
          const finalWitness = assertDaemonReadStorageAdmission(
            config,
            publicationConfigPath,
            publicationHome,
            options?._assertBackendPublication,
            options?._readDaemonConfigSnapshot,
          );
          if (!daemonReadStorageAdmissionWitnessEqual(admissionWitness, finalWitness)) {
            throw new BackendPublicationJournalError(
              "unexpected-state",
              "daemon read storage admission changed during request execution",
            );
          }
          throwIfAborted(requestSignal);
          bufferedResponse.flush();
          bufferedResponse = undefined;
        }
      }
    } catch (err: unknown) {
      if (bufferedResponse !== undefined) {
        bufferedResponse.discard();
        if (err instanceof BackendPublicationJournalError) {
          sendJsonIfWritable(res, 503, {
            status: "blocked",
            error: "backend publication admission blocked",
          });
          return;
        }
        const { status, message } = requestErrorResponse(err);
        sendJsonIfWritable(res, status, { error: message });
        return;
      }
      if (err instanceof BackendPublicationJournalError) {
        sendJsonIfWritable(res, 503, {
          status: "blocked",
          error: "backend publication admission blocked",
        });
        return;
      }
      const { status, message } = requestErrorResponse(err);
      sendJsonIfWritable(res, status, { error: message });
    } finally {
      cancellation.cleanup();
      options?._onRequestLifecycle?.("settled", requestSignal);
    }
  });

  // Start proxy manager if provided (non-fatal on failure)
  if (proxyManager) {
    try {
      await proxyManager.start();
    } catch (err) {
      console.warn(`[lcm] claude-server proxy failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  const cleanupStartupFailure = async (): Promise<void> => {
    startupCleanupStarted = true;
    shutdownController.abort();
    await settleCleanup(() => invocationCoordinator.shutdown());
    await settleCleanup(() => clearInterval(ingestInterval));
    await settleCleanup(() => activeIngestScan);
    await settleCleanup(() => projectMapWatcher.close());
    await settleCleanup(() => passiveEventProcessor.stopAndWait());
    await settleCleanup(() => { idleTimer = clearIdleTimer(idleTimer, clearIdleTimeout); });
    if (proxyManager) {
      await settleCleanup(() => proxyManager.stop());
    }
    await settleCleanup(closeStorageFactory);
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    const rejectStartup = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupStartupFailure()
        .then(() => reject(err));
    };

    server.once("error", rejectStartup);
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off("error", rejectStartup);
      resetIdleTimer();
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;

      // Now that we know the actual port, register the status handler
      registerBuiltInRoute(
        "POST",
        "/status",
        sqliteStorage
          ? createStatusHandler(config, startTime, actualPort)
          : stagedPostgreSqlUnavailableHandler("status"),
        "read",
      );
      passiveEventProcessor.start();

      resolve({
        address: () => addr,
        daemonInstanceId: invocationCoordinator.daemonInstanceId,
        invocationCoordinator,
        stop: async () => {
          shutdownController.abort();
          await settleCleanup(() => invocationCoordinator.shutdown());
          const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
          await settleCleanup(() => clearInterval(ingestInterval));
          await settleCleanup(() => activeIngestScan);
          await settleCleanup(() => projectMapWatcher.close());
          await settleCleanup(() => passiveEventProcessor.stopAndWait());
          await settleCleanup(() => { idleTimer = clearIdleTimer(idleTimer, clearIdleTimeout); });
          if (proxyManager) {
            await settleCleanup(() => proxyManager.stop());
          }
          await settleCleanup(() => serverClosed);
          await settleCleanup(closeStorageFactory);
        },
        registerRoute: (method, path, handler, requestedAdmission) => {
          const key = `${method} ${path}`;
          const existing = routes.get(key);
          const inheritedAdmission = existing?.admission ?? "read";
          const admission = existing?.admission === "mutating"
            ? "mutating"
            : requestedAdmission ?? inheritedAdmission;
          routes.set(key, { handler, admission, publicationMode: "retained" });
        },
        get idleTriggered() { return idleTriggered; },
      });
    };
    try {
      server.listen(listenPort, "127.0.0.1", onListening);
    } catch (error) {
      rejectStartup(error instanceof Error ? error : new Error("daemon listen failed"));
    }
  });
  } catch (error) {
    if (startupCleanupStarted) throw error;
    shutdownController.abort();
    await settleCleanup(() => invocationCoordinator.shutdown());
    if (constructedIngestInterval) {
      const ingestInterval = constructedIngestInterval;
      await settleCleanup(() => clearInterval(ingestInterval));
    }
    await settleCleanup(() => constructedIngestScan);
    if (constructedWatcher) {
      const watcher = constructedWatcher;
      await settleCleanup(() => watcher.close());
    }
    if (constructedProcessor) {
      const processor = constructedProcessor;
      await settleCleanup(() => processor.stopAndWait());
    }
    await settleCleanup(closeStorageFactory);
    throw error;
  }
}
