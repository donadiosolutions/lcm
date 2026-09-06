import { serialize } from "node:v8";
import { fork, type ChildProcess } from "node:child_process";
import { packageAsset, packageRootFor } from "../runtime-root.js";
import type { DiagnosticSqliteRequest, DiagnosticSqliteResponse } from "./diagnostic-sqlite-worker.js";

export const DIAGNOSTIC_SQLITE_DEADLINE_MS = 2000;

export interface ReadDiagnosticSqliteOptions extends DiagnosticSqliteRequest {
  signal?: AbortSignal;
  /** May shorten the bound for owned callers and deterministic fixtures. */
  timeoutMs?: number;
}

function failure(code: string): Error {
  return Object.assign(new Error("SQLite diagnostic unavailable"), { code });
}

/**
 * Native SQLite stepping cannot be interrupted by Worker.terminate(). Use one
 * owned process so cancellation kills the native query as well as its JS work.
 * No callback, parent descriptor, pool, or process outside this child is closed.
 */
export function readDiagnosticSqlite(options: ReadDiagnosticSqliteOptions): Promise<unknown[]> {
  const { signal, timeoutMs = DIAGNOSTIC_SQLITE_DEADLINE_MS, ...request } = options;
  if (signal?.aborted) return Promise.reject(failure("DIAGNOSTIC_SQLITE_ABORTED"));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(failure("DIAGNOSTIC_SQLITE_TIMEOUT"));
  const session = signal === undefined ? undefined : sessions.get(signal);
  if (session !== undefined) return session.read(request, timeoutMs);
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (error?: Error, rows?: unknown[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (child) {
        child.removeListener("message", message);
        // Do not await exit: a delayed reap must not change the caller's bound.
        // Keep the error listener to consume failures delivered after teardown.
        try { child.kill("SIGKILL"); } catch { /* Preserve the classified outcome. */ }
        child.unref();
      }
      if (error) reject(error);
      else resolve(rows!);
    };
    const abort = (): void => finish(failure("DIAGNOSTIC_SQLITE_ABORTED"));
    const message = (response: DiagnosticSqliteResponse | "ready"): void => {
      if (response === "ready") return;
      if (response.ok) finish(undefined, response.rows);
      else finish(failure([
        "EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY",
        "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE", "DIAGNOSTIC_SQLITE_QUERY",
      ].includes(response.code) ? response.code : "DIAGNOSTIC_SQLITE_WORKER"));
    };
    const timer = setTimeout(() => finish(failure("DIAGNOSTIC_SQLITE_TIMEOUT")), Math.min(timeoutMs, DIAGNOSTIC_SQLITE_DEADLINE_MS));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const root = packageRootFor(import.meta.url, 3);
      const workerPath = packageAsset(import.meta.url, root,
        "dist/src/db/diagnostic-sqlite-worker.js", "src/db/diagnostic-sqlite-worker.ts");
      const parents = request.parents ?? [];
      child = fork(workerPath, ["--lcm-diagnostic-sqlite-worker"], {
        execPath: process.execPath, execArgv: [], env: {}, serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc", ...parents.map(parent => parent.fd)],
      });
      child.on("error", () => finish(failure("DIAGNOSTIC_SQLITE_WORKER")));
      child.once("exit", () => finish(failure("DIAGNOSTIC_SQLITE_WORKER")));
      child.on("message", message);
      child.send({ ...request, parents: parents.map((parent, index) => ({ ...parent, fd: index + 4 })) },
        error => { if (error) finish(failure("DIAGNOSTIC_SQLITE_WORKER")); });
      if (signal?.aborted) abort();
    } catch {
      finish(failure("DIAGNOSTIC_SQLITE_WORKER"));
    }
  });
}

interface SessionRequest {
  id: number;
  request: DiagnosticSqliteRequest;
  resolve(rows: unknown[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface DiagnosticSqliteSession {
  read(request: DiagnosticSqliteRequest, timeoutMs: number): Promise<unknown[]>;
  close(error?: Error): void;
}
// Only the explicit scope below registers an entry. No process survives its
// snapshot and concurrent snapshots never share a signal or child.
const sessions = new WeakMap<AbortSignal, DiagnosticSqliteSession>();

function createSession(signal: AbortSignal): DiagnosticSqliteSession {
  let child: ChildProcess | undefined;
  let closed: Error | undefined;
  let active: SessionRequest | undefined;
  const queue: SessionRequest[] = [];
  let nextId = 0;
  const close = (error = failure("DIAGNOSTIC_SQLITE_ABORTED")): void => {
    if (closed !== undefined) return;
    closed = error;
    clearTimeout(lifetime);
    signal.removeEventListener("abort", abort);
    const pending = active === undefined ? queue.splice(0) : [active, ...queue.splice(0)];
    active = undefined;
    for (const item of pending) { clearTimeout(item.timer); item.reject(error); }
    if (child !== undefined) {
      child.removeListener("message", message);
      try { child.kill("SIGKILL"); } catch { /* Preserve the diagnostic outcome. */ }
      child.unref();
    }
  };
  const abort = (): void => close();
  const dispatch = (): void => {
    if (closed !== undefined || active !== undefined || queue.length === 0) return;
    active = queue.shift()!;
    try {
      if (child === undefined) {
        const root = packageRootFor(import.meta.url, 3);
        const workerPath = packageAsset(import.meta.url, root,
          "dist/src/db/diagnostic-sqlite-worker.js", "src/db/diagnostic-sqlite-worker.ts");
        child = fork(workerPath, ["--lcm-diagnostic-sqlite-session"], {
          execPath: process.execPath, execArgv: [], env: {}, serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child.on("error", () => close(failure("DIAGNOSTIC_SQLITE_WORKER")));
        child.once("exit", () => close(failure("DIAGNOSTIC_SQLITE_WORKER")));
        child.on("message", message);
      }
      child.send({id: active.id, request: active.request}, error => {
        if (error) close(failure("DIAGNOSTIC_SQLITE_WORKER"));
      });
    } catch { close(failure("DIAGNOSTIC_SQLITE_WORKER")); }
  };
  const message = (response: (DiagnosticSqliteResponse & {id: number}) | "ready"): void => {
    if (response === "ready") return;
    // Old/duplicate replies cannot settle another queued request.
    if (active === undefined || response.id !== active.id) {
      close(failure("DIAGNOSTIC_SQLITE_WORKER"));
      return;
    }
    const item = active;
    active = undefined;
    clearTimeout(item.timer);
    if (response.ok) item.resolve(response.rows);
    else item.reject(failure([
      "EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY",
      "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE", "DIAGNOSTIC_SQLITE_REQUEST_TOO_LARGE", "DIAGNOSTIC_SQLITE_QUERY",
    ].includes(response.code) ? response.code : "DIAGNOSTIC_SQLITE_WORKER"));
    dispatch();
  };
  const lifetime = setTimeout(() => close(failure("DIAGNOSTIC_SQLITE_TIMEOUT")), DIAGNOSTIC_SQLITE_DEADLINE_MS);
  signal.addEventListener("abort", abort, {once: true});
  if (signal.aborted) abort();
  return {
    close,
    read(request, timeoutMs) {
      if (closed !== undefined) return Promise.reject(closed);
      if (queue.length >= 32) return Promise.reject(failure("DIAGNOSTIC_SQLITE_WORKER"));
      if (serialize({id: nextId + 1, request}).byteLength > 1024 * 1024) return Promise.reject(failure("DIAGNOSTIC_SQLITE_REQUEST_TOO_LARGE"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(failure("DIAGNOSTIC_SQLITE_TIMEOUT")), Math.min(timeoutMs, DIAGNOSTIC_SQLITE_DEADLINE_MS));
        queue.push({id: ++nextId, request, resolve, reject, timer});
        dispatch();
      });
    },
  };
}

/** Share one killable child only for this whole diagnostic observation. */
export async function withDiagnosticSqliteSession<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (sessions.has(signal)) return operation();
  const session = createSession(signal);
  sessions.set(signal, session);
  try { return await operation(); }
  finally { sessions.delete(signal); session.close(); }
}
