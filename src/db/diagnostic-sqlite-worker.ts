// Keep this entrypoint builtin-only: source checkouts run it with Node's type
// stripping, while installed Node 22 runtimes use the compiled package asset.
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";

export interface DiagnosticSqliteRequest {
  path: string;
  expected: { device: bigint; inode: bigint };
  statements: Array<{ sql: string; params?: Array<string | number | null>; mode: "get" | "all" }>;
  /** Caller retains descriptors: one-shot forks remap them; sessions reopen their own. */
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
    return diagnosticSqliteFailure(error);
  }
}

function diagnosticSqliteFailure(error: unknown): DiagnosticSqliteResponse {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return { ok: false, code: typeof code === "string" && [
    "EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY",
  ].includes(code) ? code : "DIAGNOSTIC_SQLITE_QUERY" };
}

// Reserve space for the numeric id and request/response envelope within each 1 MiB IPC frame.
const SESSION_PAYLOAD_LIMIT = 1024 * 1024 - 128;

/** A reused worker owns its directory handles; caller descriptors are not inherited. */
export function diagnosticSqliteSessionResponse(request: DiagnosticSqliteRequest): DiagnosticSqliteResponse {
  const parents: NonNullable<DiagnosticSqliteRequest["parents"]> = [];
  try {
    if (serialize(request).byteLength > SESSION_PAYLOAD_LIMIT) {
      return { ok: false, code: "DIAGNOSTIC_SQLITE_REQUEST_TOO_LARGE" };
    }
    for (const parent of request.parents ?? []) {
      const fd = openSync(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      parents.push({ ...parent, fd });
    }
    const response = diagnosticSqliteResponse({ ...request, parents });
    if (response.ok && serialize(response.rows).byteLength > SESSION_PAYLOAD_LIMIT) {
      return { ok: false, code: "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE" };
    }
    return response;
  } catch (error) {
    return diagnosticSqliteFailure(error);
  } finally {
    for (const parent of parents) {
      try { closeSync(parent.fd); } catch { /* Preserve the query or admission outcome. */ }
    }
  }
}

if (process.argv.includes("--lcm-diagnostic-sqlite-session") && process.send) {
  process.on("message", ({ id, request }: { id: number; request: DiagnosticSqliteRequest }) => {
    process.send!({ id, ...diagnosticSqliteSessionResponse(request) });
  });
  process.send("ready");
}

if (process.argv.includes("--lcm-diagnostic-sqlite-worker") && process.send) {
  process.once("message", (request: DiagnosticSqliteRequest) => {
    process.send!("ready");
    process.send!(diagnosticSqliteResponse(request));
    process.disconnect!();
  });
}
