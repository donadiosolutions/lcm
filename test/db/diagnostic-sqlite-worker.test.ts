import {
  chmodSync, closeSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), fstatSync: vi.fn(actual.fstatSync) };
});
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: vi.fn(function (...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      return new actual.DatabaseSync(...args);
    }),
  };
});

import {
  diagnosticSqliteResponse, queryDiagnosticSqlite, type DiagnosticSqliteRequest,
} from "../../src/db/diagnostic-sqlite-worker.js";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualSqlite = await vi.importActual<typeof import("node:sqlite")>("node:sqlite");
let directory: string;
let request: DiagnosticSqliteRequest;
let parentFd: number;

beforeEach(() => {
  vi.mocked(lstatSync).mockReset().mockImplementation(actualFs.lstatSync);
  vi.mocked(fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
  vi.mocked(DatabaseSync).mockReset().mockImplementation(function (...args) {
    return new actualSqlite.DatabaseSync(...args);
  });
  directory = mkdtempSync(join(tmpdir(), "lcm-diagnostic-sqlite-worker-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "store.db");
  const database = new actualSqlite.DatabaseSync(path);
  database.exec("CREATE TABLE counts (value INTEGER); INSERT INTO counts VALUES (7), (11)");
  database.close();
  const leaf = actualFs.lstatSync(path, { bigint: true });
  const parent = actualFs.lstatSync(directory, { bigint: true });
  parentFd = openSync(directory, "r");
  request = {
    path,
    expected: { device: leaf.dev, inode: leaf.ino },
    parents: [{ path: directory, fd: parentFd, device: parent.dev, inode: parent.ino }],
    statements: [{ sql: "SELECT SUM(value) AS total FROM counts", mode: "get" }],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  closeSync(parentFd);
  rmSync(directory, { recursive: true, force: true });
});

describe("queryDiagnosticSqlite", () => {
  it("returns get/all numeric rows with default and explicit parameters through read-only mode", () => {
    request.statements.push({ sql: "SELECT value FROM counts WHERE value > ?", params: [8], mode: "all" });
    const before = readFileSync(request.path);
    expect(queryDiagnosticSqlite(request)).toEqual([{ total: 18 }, [{ value: 11 }]]);
    expect(DatabaseSync).toHaveBeenCalledWith(expect.any(URL), { readOnly: true });
    const [url] = vi.mocked(DatabaseSync).mock.calls[0];
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).searchParams.get("mode")).toBe("ro");
    expect((url as URL).searchParams.has("immutable")).toBe(false);
    expect(readFileSync(request.path)).toEqual(before);
  });

  it.each(["DELETE FROM counts", "CREATE TABLE unexpected (value INTEGER)"])(
    "refuses writes and preserves schema and rows: %s", (sql) => {
      const before = readFileSync(request.path);
      request.statements = [{ sql, mode: "all" }];
      expect(() => queryDiagnosticSqlite(request)).toThrow(/readonly/i);
      expect(readFileSync(request.path)).toEqual(before);
      request.statements = [{ sql: "SELECT SUM(value) AS total FROM counts", mode: "get" }];
      expect(queryDiagnosticSqlite(request)).toEqual([{ total: 18 }]);
    },
  );

  it("observes committed WAL rows without checkpointing the main database", () => {
    const writer = new actualSqlite.DatabaseSync(request.path);
    try {
      writer.exec("PRAGMA journal_mode=WAL; INSERT INTO counts VALUES (23)");
      const before = readFileSync(request.path);
      expect(queryDiagnosticSqlite(request)).toEqual([{ total: 41 }]);
      expect(readFileSync(request.path)).toEqual(before);
    } finally { writer.close(); }
  });

  it("allows an already admitted leaf when no parent witnesses are supplied", () => {
    delete request.parents;
    expect(queryDiagnosticSqlite(request)).toEqual([{ total: 18 }]);
  });

  it("checks directory identity without Unix ownership on platforms lacking getuid", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try { expect(queryDiagnosticSqlite(request)).toEqual([{ total: 18 }]); }
    finally { Object.defineProperty(process, "getuid", descriptor); }
  });

  it.each(["directory", "device", "inode", "symlink"])("rejects changed leaf %s before open", (kind) => {
    if (kind === "directory") request.path = directory;
    if (kind === "device") request.expected.device += 1n;
    if (kind === "inode") request.expected.inode += 1n;
    if (kind === "symlink") {
      const link = join(directory, "link.db");
      symlinkSync(request.path, link);
      request.path = link;
    }
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_IDENTITY" });
    expect(DatabaseSync).not.toHaveBeenCalled();
  });

  it.each(["file", "device", "inode", "owner", "mode"])("rejects changed parent %s", (kind) => {
    const parent = request.parents![0];
    if (kind === "file") parent.path = request.path;
    if (kind === "device") parent.device += 1n;
    if (kind === "inode") parent.inode += 1n;
    if (kind === "mode") chmodSync(directory, 0o755);
    if (kind === "owner") {
      const stat = actualFs.lstatSync(directory, { bigint: true });
      vi.mocked(fstatSync).mockReturnValueOnce(Object.assign(stat, { uid: stat.uid + 1n }));
    }
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_IDENTITY" });
    expect(DatabaseSync).not.toHaveBeenCalled();
  });

  it("rejects a replaced retained descriptor even when the parent path is unchanged", () => {
    const stat = actualFs.lstatSync(directory, { bigint: true });
    vi.mocked(fstatSync).mockReturnValueOnce(Object.assign(stat, { ino: stat.ino + 1n }));
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_IDENTITY" });
    expect(DatabaseSync).not.toHaveBeenCalled();
  });

  it("rechecks leaf identity after opening and closes the opened handle on refusal", () => {
    const close = vi.spyOn(actualSqlite.DatabaseSync.prototype, "close");
    vi.mocked(DatabaseSync).mockImplementationOnce(function (...args) {
      const database = new actualSqlite.DatabaseSync(...args);
      renameSync(request.path, `${request.path}.original`);
      symlinkSync(`${request.path}.original`, request.path);
      return database;
    });
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_IDENTITY" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("discards rows when the parent identity changes during the queries", () => {
    const prepare = actualSqlite.DatabaseSync.prototype.prepare;
    vi.spyOn(actualSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
      chmodSync(directory, 0o755);
      return prepare.call(this, sql);
    });
    const close = vi.spyOn(actualSqlite.DatabaseSync.prototype, "close");
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_IDENTITY" });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves the query outcome when close throws (query failure: %s)", (failQuery) => {
    const close = actualSqlite.DatabaseSync.prototype.close;
    vi.spyOn(actualSqlite.DatabaseSync.prototype, "close").mockImplementation(function () {
      close.call(this);
      throw new Error("sensitive close error");
    });
    if (failQuery) request.statements[0].sql = "SELECT nonexistent FROM counts";
    expect(diagnosticSqliteResponse(request)).toEqual(failQuery
      ? { ok: false, code: "DIAGNOSTIC_SQLITE_QUERY" }
      : { ok: true, rows: [{ total: 18 }] });
  });
});

describe("diagnosticSqliteResponse", () => {
  it("returns bounded rows", () => {
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: true, rows: [{ total: 18 }] });
  });

  it("refuses an oversized serialized result", () => {
    request.statements = [{ sql: "SELECT zeroblob(1048576) AS payload", mode: "get" }];
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_RESULT_TOO_LARGE" });
  });

  it("reports an absent leaf without creating a database", () => {
    request.path = join(directory, "missing.db");
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "ENOENT" });
    expect(actualFs.existsSync(request.path)).toBe(false);
  });

  it.each(["EACCES", "EPERM", "ENOENT", "ELOOP", "DIAGNOSTIC_SQLITE_IDENTITY"])(
    "preserves only the allowlisted filesystem code %s", (code) => {
      vi.mocked(lstatSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("secret path/role/SQL"), { code, path: "/secret" });
      });
      expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code });
    },
  );

  it.each([null, undefined, "private error", { code: 13 }, { code: "SECRET_CODE" }, new Error("private SQL")])(
    "sanitizes opaque database construction failure %#", (error) => {
      vi.mocked(DatabaseSync).mockImplementationOnce(function () { throw error; });
      expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_QUERY" });
    },
  );

  it("sanitizes retained descriptor failures", () => {
    vi.mocked(fstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("secret descriptor"), { code: "EBADF" });
    });
    expect(diagnosticSqliteResponse(request)).toEqual({ ok: false, code: "DIAGNOSTIC_SQLITE_QUERY" });
  });
});

describe("diagnostic SQLite process entrypoint", () => {
  it.each(["import", "no-ipc", "worker"])("only serves messages for an explicit IPC worker: %s", async (mode) => {
    const argv = process.argv;
    const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
    const disconnectDescriptor = Object.getOwnPropertyDescriptor(process, "disconnect");
    const send = vi.fn();
    const disconnect = vi.fn();
    const once = process.once;
    let handleMessage: ((input: DiagnosticSqliteRequest) => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(function (event, listener) {
      if (event === "message") {
        handleMessage = listener;
        return process;
      }
      return once.call(this, event, listener);
    });
    process.argv = mode === "import" ? [argv[0]] : [argv[0], "--lcm-diagnostic-sqlite-worker"];
    Object.defineProperty(process, "send", { configurable: true, value: mode === "no-ipc" ? undefined : send });
    Object.defineProperty(process, "disconnect", { configurable: true, value: disconnect });
    try {
      vi.resetModules();
      await import("../../src/db/diagnostic-sqlite-worker.js");
      expect(handleMessage !== undefined).toBe(mode === "worker");
      if (mode === "worker") {
        handleMessage!(request);
        expect(send.mock.calls).toEqual([["ready"], [{ ok: true, rows: [{ total: 18 }] }]]);
        expect(disconnect).toHaveBeenCalledOnce();
        expect(send.mock.invocationCallOrder[1]).toBeLessThan(disconnect.mock.invocationCallOrder[0]);
      } else {
        expect(send).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
      }
    } finally {
      process.argv = argv;
      if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
      else Reflect.deleteProperty(process, "send");
      if (disconnectDescriptor) Object.defineProperty(process, "disconnect", disconnectDescriptor);
      else Reflect.deleteProperty(process, "disconnect");
    }
  });
});
