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
