import { request, type IncomingMessage } from "node:http";
import { Buffer } from "node:buffer";
import {
  createAbortError,
  isAbortError,
  throwIfAborted,
} from "./cancellation.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const DAEMON_PATHS = new Set([
  "/compact",
  "/describe",
  "/expand",
  "/grep",
  "/health",
  "/ingest",
  "/invocation-control",
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
  signal?: AbortSignal;
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

/**
 * Keep exception inspection finite: an arbitrary AggregateError/cause graph
 * is input, not authority.  The caps preserve useful nested transport codes
 * while preventing a malformed graph from turning remediation into an
 * unbounded walk.
 */
const DAEMON_TRANSPORT_ERROR_MAX_DEPTH = 8;
const DAEMON_TRANSPORT_ERROR_MAX_NODES = 32;
const DAEMON_TRANSPORT_TYPE_ERROR_MAX_MESSAGE_CHARS = 256;
const DAEMON_TRANSPORT_TYPE_ERROR_MESSAGES = new Set([
  "fetch failed",
  "failed to fetch",
  "network error",
  "network request failed",
  "load failed",
]);
const DAEMON_TRANSPORT_TYPE_ERROR_SUFFIXES = new Set([
  "econnaborted",
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "etimedout",
  "connection aborted",
  "connection closed",
  "connection failed",
  "connection refused",
  "connection reset",
  "connection timed out",
  "connection timeout",
  "network error",
  "network request failed",
  "socket closed",
  "socket error",
  "socket failed",
  "socket hang up",
  "socket reset",
]);

function isKnownDaemonTransportTypeErrorMessage(message: unknown): boolean {
  if (typeof message !== "string" || message.length > DAEMON_TRANSPORT_TYPE_ERROR_MAX_MESSAGE_CHARS) {
    return false;
  }
  const normalized = message.toLowerCase();
  const separator = normalized.indexOf(": ");
  const base = separator < 0 ? normalized : normalized.slice(0, separator);
  if (!DAEMON_TRANSPORT_TYPE_ERROR_MESSAGES.has(base)) return false;
  if (separator < 0) return true;
  const suffix = normalized.slice(separator + 2);
  return DAEMON_TRANSPORT_TYPE_ERROR_SUFFIXES.has(suffix);
}

/** Restrict managed-daemon recovery to local transport loss. */
export function isDaemonTransportFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  let inspectedNodes = 0;
  while (pending.length > 0 && inspectedNodes < DAEMON_TRANSPORT_ERROR_MAX_NODES) {
    const { value: current, depth } = pending.pop()!;
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    inspectedNodes += 1;
    if (isAbortError(current)) continue;
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (
      typeof candidate.code === "string"
      && DAEMON_TRANSPORT_ERROR_CODES.has(candidate.code.toUpperCase())
    ) {
      return true;
    }
    if (!(current instanceof TypeError) && candidate.message === "Daemon request timed out") return true;
    // A direct TypeError is only a transport signal for the small vocabulary
    // emitted by fetch implementations.  Generic/programming TypeErrors must
    // remain non-transport so MCP can return a sanitized diagnostic instead
    // of suppressing it behind recovery guidance.
    if (current instanceof TypeError && isKnownDaemonTransportTypeErrorMessage(candidate.message)) {
      return true;
    }
    if (depth >= DAEMON_TRANSPORT_ERROR_MAX_DEPTH) continue;
    pending.push({ value: candidate.cause, depth: depth + 1 });
    if (current instanceof AggregateError && Array.isArray(candidate.errors)) {
      for (const nested of candidate.errors.slice(0, DAEMON_TRANSPORT_ERROR_MAX_NODES)) {
        pending.push({ value: nested, depth: depth + 1 });
      }
    }
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
  throwIfAborted(options.signal);
  const json = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers ?? {}) };
  if (json !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(json));
  }

  return await new Promise<DaemonJsonResponse<T>>((resolve, reject) => {
    let req: ReturnType<typeof request> | undefined;
    let response: IncomingMessage | undefined;
    let responseData: Buffer[] = [];
    let settled = false;
    let timeoutConfigured = false;
    const signal = options.signal;

    const removeListener = (
      emitter: object,
      event: string,
      listener: (...args: unknown[]) => void,
    ): void => {
      const value = emitter as {
        off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
        removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
      };
      if (typeof value.off === "function") value.off(event, listener);
      else value.removeListener?.(event, listener);
    };
    const onRequestError = (error: Error): void => settleFailure(error);
    const onResponseData = (chunk: Buffer | string): void => {
      responseData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onResponseAborted = (): void => settleFailure(interruptedDaemonResponse(
      Object.assign(new Error("Daemon response aborted"), { code: "ECONNRESET" }),
    ));
    const onResponseError = (error: Error): void => settleFailure(interruptedDaemonResponse(error));
    const onResponseEnd = (): void => {
      if (settled || response === undefined) return;
      settled = true;
      cleanup();
      try {
        const statusCode = response.statusCode ?? 500;
        const raw = Buffer.concat(responseData).toString("utf-8");
        const data = raw ? JSON.parse(raw) as T : undefined as T;
        resolve({ statusCode, data });
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = (): void => {
      if (timeoutConfigured) {
        // Node clears an active socket timeout when setTimeout receives zero.
        req?.setTimeout(0, () => undefined);
        timeoutConfigured = false;
      }
      if (req !== undefined) removeListener(req, "error", onRequestError as (...args: unknown[]) => void);
      if (response !== undefined) {
        removeListener(response, "data", onResponseData as (...args: unknown[]) => void);
        removeListener(response, "aborted", onResponseAborted as (...args: unknown[]) => void);
        removeListener(response, "error", onResponseError as (...args: unknown[]) => void);
        removeListener(response, "end", onResponseEnd as (...args: unknown[]) => void);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const settleFailure = (error: Error, destroyTransport = false): void => {
      if (settled) return;
      let absorbLateRequestError: (() => void) | undefined;
      let removeLateRequestListeners: (() => void) | undefined;
      settled = true;
      if (destroyTransport) {
        if (req !== undefined) {
          absorbLateRequestError = (): void => undefined;
          removeLateRequestListeners = (): void => {
            removeListener(req!, "error", absorbLateRequestError! as (...args: unknown[]) => void);
            removeListener(req!, "close", removeLateRequestListeners! as (...args: unknown[]) => void);
          };
          req.once("error", absorbLateRequestError);
          req.once("close", removeLateRequestListeners);
        }
        // Destroy without an error argument: the explicit rejection below is
        // authoritative and this avoids a second uncaught socket error.
        req?.destroy();
        response?.destroy();
      }
      cleanup();
      if (response !== undefined) {
        // A settled IncomingMessage may still deliver one queued error event.
        // Absorb only that late event, then release the guard on the next turn
        // so normal response listeners are not retained.
        const absorbLateError = (): void => undefined;
        response.once("error", absorbLateError);
        queueMicrotask(() => removeListener(response!, "error", absorbLateError));
      }
      reject(error);
    };
    const onAbort = (): void => settleFailure(createAbortError(signal?.reason), true);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      req = request({
        hostname: "127.0.0.1",
        port,
        path: routePath,
        method: options.method,
        headers,
      }, (incomingResponse: IncomingMessage) => {
        response = incomingResponse;
        incomingResponse.on("data", onResponseData);
        incomingResponse.once("aborted", onResponseAborted);
        incomingResponse.once("error", onResponseError);
        incomingResponse.once("end", onResponseEnd);
      });
      req.on("error", onRequestError);
      if (settled) return;
      if (options.timeoutMs !== undefined) {
        timeoutConfigured = true;
        req.setTimeout(options.timeoutMs, () => {
          settleFailure(
            Object.assign(new Error("Daemon request timed out"), { code: "ETIMEDOUT" }),
            true,
          );
        });
      }
      if (json !== undefined) req.write(json);
      req.end();
    } catch (error) {
      settleFailure(error instanceof Error ? error : new Error("Daemon request failed"));
    }
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
