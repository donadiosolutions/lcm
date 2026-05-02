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

export function daemonHttpUrl(portValue: unknown, path: string): string {
  const port = normalizeDaemonPort(portValue);
  const routePath = normalizeDaemonPath(path);
  return `http://127.0.0.1:${port}${routePath}`;
}
