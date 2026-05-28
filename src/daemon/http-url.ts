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

export async function daemonJsonRequest<T>(
  portValue: unknown,
  path: string,
  options: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const port = normalizeDaemonPort(portValue);
  const routePath = normalizeDaemonPath(path);
  const json = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers ?? {}) };
  if (json !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(json));
  }

  return await new Promise<T>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: routePath,
      method: options.method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        try {
          const statusCode = res.statusCode ?? 500;
          const raw = Buffer.concat(chunks).toString("utf-8");
          const data = raw ? JSON.parse(raw) as T & { error?: string } : undefined as T;
          if (statusCode < 200 || statusCode >= 300) {
            const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `HTTP ${statusCode}`;
            reject(new Error(message));
            return;
          }
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
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
