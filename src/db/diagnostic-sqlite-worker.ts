// Keep this entrypoint builtin-only: source checkouts run it with Node's type
// stripping, while installed Node 22 runtimes use the compiled package asset.
import { fstatSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";

export interface DiagnosticSqliteRequest {
  path: string;
  expected: { device: bigint; inode: bigint };
  statements: Array<{ sql: string; params?: Array<string | number | null>; mode: "get" | "all" }>;
  /** Descriptors are borrowed, retained by the caller, and remapped on fork. */
  parents?: Array<{ path: string; fd: number; device: bigint; inode: bigint }>;
}

function assertIdentity(request: DiagnosticSqliteRequest): void {
  const leaf = lstatSync(request.path, { bigint: true });
  if (!leaf.isFile() || leaf.dev !== request.expected.device || leaf.ino !== request.expected.inode) {
    throw Object.assign(new Error("SQLite diagnostic identity changed"), { code: "DIAGNOSTIC_SQLITE_IDENTITY" });
  }
  const uid = process.getuid?.();
  for (const parent of request.parents ?? []) {
    const path = lstatSync(parent.path, { bigint: true });
    const retained = fstatSync(parent.fd, { bigint: true });
    for (const current of [path, retained]) {
      if (!current.isDirectory() || current.dev !== parent.device || current.ino !== parent.inode
          || (uid !== undefined && (current.uid !== BigInt(uid) || (current.mode & 0o777n) !== 0o700n))) {
        throw Object.assign(new Error("SQLite diagnostic identity changed"), { code: "DIAGNOSTIC_SQLITE_IDENTITY" });
      }
    }
  }
}

/** Synchronous query seam, used only inside the disposable diagnostic process. */
export function queryDiagnosticSqlite(request: DiagnosticSqliteRequest): unknown[] {
  assertIdentity(request);
  const url = pathToFileURL(request.path);
  url.searchParams.set("mode", "ro");
  const database = new DatabaseSync(url, { readOnly: true });
  try {
    assertIdentity(request);
    const rows = request.statements.map(({ sql, params = [], mode }) => {
      const statement = database.prepare(sql);
      return mode === "get" ? statement.get(...params) : statement.all(...params);
    });
    assertIdentity(request);
    return rows;
  } finally {
    // Preserve query/identity outcomes if the disposable handle cannot close.
    try { database.close(); } catch { /* Process teardown owns final cleanup. */ }
  }
}

export type DiagnosticSqliteResponse = { ok: true; rows: unknown[] } | { ok: false; code: string };

/** Never send error messages, paths, SQL, stack traces, or driver objects. */
export function diagnosticSqliteResponse(request: DiagnosticSqliteRequest): DiagnosticSqliteResponse {
  try {
    const rows = queryDiagnosticSqlite(request);
    // Bound the IPC frame before it reaches the parent parser. Large query work
    // and serialization remain inside the process covered by the deadline.
    if (serialize(rows).byteLength > 1024 * 1024) {
      return { ok: false, code: "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE" };
    }
    return { ok: true, rows };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, code: typeof code === "string" && [
      "EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY",
    ].includes(code) ? code : "DIAGNOSTIC_SQLITE_QUERY" };
  }
}

if (process.argv.includes("--lcm-diagnostic-sqlite-worker") && process.send) {
  process.once("message", (request: DiagnosticSqliteRequest) => {
    process.send!("ready");
    process.send!(diagnosticSqliteResponse(request));
    process.disconnect!();
  });
}
