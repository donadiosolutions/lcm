import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.js";
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
} from "./passive-event-processor.js";
import { createStatsHandler } from "./routes/stats.js";
import { createPoolStatsHandler } from "./routes/pool-stats.js";
import { createReviewStaleHandler } from "./routes/review-stale.js";
import { PKG_VERSION } from "./version.js";
import { normalizeDaemonPort, normalizeIdleTimeoutMs } from "./http-url.js";
import { projectsDir as lcmProjectsDir } from "../runtime-paths.js";
import { projectMapPathsForHash, watchProjectMap } from "../project-map.js";
import { createStorageBackendFactory } from "../storage/index.js";
export { PKG_VERSION };

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;
export type DaemonInstance = { address: () => AddressInfo; stop: () => Promise<void>; registerRoute: (method: string, path: string, handler: RouteHandler) => void; idleTriggered: boolean };
export type DaemonOptions = {
  proxyManager?: ProxyManager;
  onIdle?: () => void;
  tokenPath?: string;
  /** @internal Deterministic idle-timer seams for lifecycle tests. */
  _setTimeout?: typeof setTimeout;
  /** @internal Deterministic idle-timer seams for lifecycle tests. */
  _clearTimeout?: typeof clearTimeout;
  /** @internal Deterministic periodic-ingest seam for lifecycle tests. */
  _scanForTranscripts?: () => Promise<void>;
};

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

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

function clearIdleTimer(timer: ReturnType<typeof setTimeout> | null, clearTimer: typeof clearTimeout): null {
  if (timer) clearTimer(timer);
  return null;
}

function stagedPostgreSqlUnavailableHandler(operation: string): RouteHandler {
  return async (_req, res) => {
    sendJson(res, 503, stagedPostgreSqlUnavailablePayload(operation));
  };
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
  const serverToken = options?.tokenPath ? readAuthToken(options.tokenPath) : null;
  if (options?.tokenPath && serverToken === null) {
    throw new Error(`Auth token file specified but could not be read: ${options.tokenPath}`);
  }
  const storageFactory = createStorageBackendFactory(config.storage);
  const sqliteStorage = config.storage.backend === "sqlite";
  let constructedProcessor: PassiveEventProcessor | undefined;
  let constructedWatcher: ReturnType<typeof watchProjectMap> | undefined;
  let constructedIngestInterval: ReturnType<typeof setInterval> | undefined;
  let constructedIngestScan: Promise<void> | undefined;
  let startupCleanupStarted = false;
  try {
  const routes = new Map<string, RouteHandler>();

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

  routes.set("GET /health", async (_req, res) => {
    const storageHealth = await storageFactory.health();
    const healthy = storageHealth.status === "healthy";
    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? "ok" : "unavailable",
      version: PKG_VERSION,
      storageBackend: config.storage.backend,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
      entrypoint: process.argv[1],
      ...(healthy ? {} : {
        storage: {
          status: storageHealth.status,
          ...(storageHealth.error ? { error: storageHealth.error.toJSON() } : {}),
        },
      }),
    });
  });
  routes.set("POST /compact", createCompactHandler(config, storageFactory));
  routes.set("POST /promote", createPromoteHandler(config, storageFactory));
  routes.set("POST /restore", createRestoreHandler(config, storageFactory));
  routes.set("POST /grep", createGrepHandler(config, storageFactory));
  routes.set("POST /search", createSearchHandler(config, storageFactory));
  routes.set("POST /expand", createExpandHandler(config, storageFactory));
  routes.set("POST /describe", createDescribeHandler(config, storageFactory));
  routes.set("POST /store", createStoreHandler(config, storageFactory));
  routes.set("POST /recent", createRecentHandler(config, storageFactory));
  routes.set("POST /ingest", createIngestHandler(config, storageFactory));
  routes.set("POST /prompt-search", createPromptSearchHandler(config, storageFactory));
  routes.set("POST /session-complete", createSessionCompleteHandler(config, storageFactory));
  const passiveEventProcessor = new PassiveEventProcessor(
    config,
    PASSIVE_EVENT_PROCESSOR_DEFAULTS,
    { storageFactory },
  );
  constructedProcessor = passiveEventProcessor;
  routes.set("POST /promote-events", createPromoteEventsHandler(config, storageFactory));
  routes.set("POST /promote-events/all", createPromoteAllEventsHandler(config, storageFactory));
  routes.set(
    "POST /promote-events/notify",
    sqliteStorage
      ? createPromoteEventsNotifyHandler(passiveEventProcessor)
      : stagedPostgreSqlUnavailableHandler("promote-events-notify"),
  );
  routes.set(
    "GET /stats",
    sqliteStorage ? createStatsHandler() : stagedPostgreSqlUnavailableHandler("stats"),
  );
  routes.set(
    "GET /stats/pool",
    sqliteStorage ? createPoolStatsHandler() : stagedPostgreSqlUnavailableHandler("pool stats"),
  );
  routes.set("POST /review-stale", createReviewStaleHandler(config, storageFactory));
  // Status handler is registered after listen() when we know the actual port
  const projectMapWatcher = watchProjectMap();
  constructedWatcher = projectMapWatcher;

  // Periodic transcript ingestion scan
  const INGEST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const ingestHandler = createIngestHandler(config, storageFactory);

  const scanForTranscripts = async () => {
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
            }));
          }
        }
      }
    } catch {
      // non-fatal: periodic scan failure shouldn't crash daemon
    }
  };

  let activeIngestScan: Promise<void> | undefined;
  const runTranscriptScan = (): Promise<void> => {
    if (activeIngestScan) return activeIngestScan;
    const scan = Promise.resolve()
      .then(() => (options?._scanForTranscripts ?? scanForTranscripts)())
      .catch(() => undefined)
      .finally(() => {
        activeIngestScan = undefined;
        constructedIngestScan = undefined;
      });
    activeIngestScan = scan;
    constructedIngestScan = scan;
    return scan;
  };

  const ingestInterval = sqliteStorage
    ? setInterval(runTranscriptScan, INGEST_INTERVAL_MS)
    : undefined;
  constructedIngestInterval = ingestInterval;
  ingestInterval?.unref(); // don't prevent process exit

  const server: Server = createServer(async (req, res) => {
    resetIdleTimer();
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const handler = routes.get(key);
    if (!handler) { sendJson(res, 404, { error: "not found" }); return; }
    // Auth: skip for GET /health, require Bearer token for everything else
    if (serverToken && key !== "GET /health") {
      const rawAuth = req.headers["authorization"];
      const authHeader = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "";
      if (authHeader.trim() !== `Bearer ${serverToken}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }
    try {
      await handler(req, res, req.method !== "GET" ? await readBody(req) : "");
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = status === 413 ? "payload too large" : sanitizeError(err instanceof Error ? err.message : "internal error");
      sendJson(res, status, { error: message });
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
    if (ingestInterval) await settleCleanup(() => clearInterval(ingestInterval));
    await settleCleanup(() => activeIngestScan);
    await settleCleanup(() => projectMapWatcher.close());
    await settleCleanup(() => passiveEventProcessor.stopAndWait());
    await settleCleanup(() => { idleTimer = clearIdleTimer(idleTimer, clearIdleTimeout); });
    if (proxyManager) {
      await settleCleanup(() => proxyManager.stop());
    }
    await settleCleanup(() => storageFactory.close());
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
      routes.set(
        "POST /status",
        sqliteStorage
          ? createStatusHandler(config, startTime, actualPort)
          : stagedPostgreSqlUnavailableHandler("status"),
      );
      if (sqliteStorage) passiveEventProcessor.start();
      else passiveEventProcessor.stop();

      resolve({
        address: () => addr,
        stop: async () => {
          if (ingestInterval) await settleCleanup(() => clearInterval(ingestInterval));
          await settleCleanup(() => activeIngestScan);
          await settleCleanup(() => projectMapWatcher.close());
          await settleCleanup(() => passiveEventProcessor.stopAndWait());
          await settleCleanup(() => { idleTimer = clearIdleTimer(idleTimer, clearIdleTimeout); });
          if (proxyManager) {
            await settleCleanup(() => proxyManager.stop());
          }
          await settleCleanup(() => new Promise<void>((r) => server.close(() => r())));
          await storageFactory.close();
        },
        registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
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
    await settleCleanup(() => storageFactory.close());
    throw error;
  }
}
