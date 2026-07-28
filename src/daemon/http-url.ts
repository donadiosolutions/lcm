import { request } from "node:http";
import { Buffer } from "node:buffer";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const DAEMON_PATHS = new Set([
  "/compact",
  "/describe",
  "/expand",
  "/grep",
  "/health",
  "/ingest",
  "/promote",
  "/promote-events",
  "/promote-events/all",
  "/promote-events/notify",
  "/prompt-search",
  "/recent",
  "/restore",
  "/review-stale",
  "/search",
  "/session-complete",
  "/stats",
  "/stats/pool",
  "/status",
  "/store",
]);

export function normalizeDaemonPort(value: unknown, options: { allowZero?: boolean } = {}): number {
  const n = typeof value === "number" ? value : Number(value);
  const min = options.allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min || n > 65535) {
    throw new Error(`Invalid daemon port: ${String(value)}`);
  }
  return n;
}

export function normalizeIdleTimeoutMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 86_400_000) {
    throw new Error(`Invalid daemon idle timeout: ${String(value)}`);
  }
  return n;
}

export function daemonPortFromLoopbackUrl(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Daemon URL must be an HTTP loopback origin");
  }
  return normalizeDaemonPort(url.port || 80);
}

export function normalizeDaemonPath(path: string): string {
  if (!DAEMON_PATHS.has(path)) {
    throw new Error(`Invalid daemon route: ${path}`);
  }
  return path;
}

export type DaemonJsonRequestOptions = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

export type DaemonJsonResponse<T> = {
  statusCode: number;
  data: T;
};

const DAEMON_TRANSPORT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Restrict managed-daemon recovery to local transport loss. */
export function isDaemonTransportFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      typeof candidate.code === "string"
      && DAEMON_TRANSPORT_ERROR_CODES.has(candidate.code.toUpperCase())
    ) {
      return true;
    }
    if (candidate.message === "Daemon request timed out") return true;
    current = candidate.cause;
  }
  return false;
}

function interruptedDaemonResponse(cause: Error): Error & { code: "ECONNRESET" } {
  return Object.assign(
    new Error("Daemon response interrupted", { cause }),
    { code: "ECONNRESET" as const },
  );
}

export async function daemonJsonResponse<T>(
  portValue: unknown,
  path: string,
  options: DaemonJsonRequestOptions,
): Promise<DaemonJsonResponse<T>> {
  const port = normalizeDaemonPort(portValue);
  const routePath = normalizeDaemonPath(path);
  const json = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers ?? {}) };
  if (json !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(json));
  }

  return await new Promise<DaemonJsonResponse<T>>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: routePath,
      method: options.method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      let responseSettled = false;
      const finishResponse = (transportError?: Error): void => {
        if (responseSettled) return;
        responseSettled = true;
        if (transportError !== undefined) {
          reject(transportError);
          return;
        }
        try {
          const statusCode = res.statusCode ?? 500;
          const raw = Buffer.concat(chunks).toString("utf-8");
          const data = raw ? JSON.parse(raw) as T : undefined as T;
          resolve({ statusCode, data });
        } catch (err) {
          reject(err);
        }
      };
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.once("aborted", () => {
        finishResponse(interruptedDaemonResponse(
          Object.assign(new Error("Daemon response aborted"), { code: "ECONNRESET" }),
        ));
      });
      res.once("error", (error: Error) => {
        finishResponse(interruptedDaemonResponse(error));
      });
      res.once("end", () => finishResponse());
    });
    req.on("error", reject);
    if (options.timeoutMs !== undefined) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error("Daemon request timed out"));
      });
    }
    if (json !== undefined) {
      req.write(json);
    }
    req.end();
  });
}

export async function daemonJsonRequest<T>(
  portValue: unknown,
  path: string,
  options: DaemonJsonRequestOptions,
): Promise<T> {
  const { statusCode, data } = await daemonJsonResponse<T>(portValue, path, options);
  if (statusCode < 200 || statusCode >= 300) {
    const message = data && typeof data === "object" && "error" in data
      && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `HTTP ${statusCode}`;
    throw new Error(message);
  }
  return data;
}
