import { mkdtempSync, lstatSync, readFileSync, rmSync, openSync, closeSync, fstatSync } from "node:fs";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const children = vi.hoisted(() => [] as ChildProcess[]);
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: (...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args);
    children.push(child);
    return child;
  } };
});
import { readDiagnosticSqlite } from "../../src/db/diagnostic-sqlite.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-sqlite-"));
  roots.push(root);
  const path = join(root, "database.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE counts (value INTEGER); INSERT INTO counts VALUES (42)");
  db.close();
  const stat = lstatSync(path, { bigint: true });
  return { path, expected: { device: stat.dev, inode: stat.ino } };
}
afterEach(() => {
  children.splice(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded diagnostic SQLite", () => {
  it("reads a batch without changing database bytes", async () => {
    const request = fixture();
    const before = readFileSync(request.path);
    expect(await readDiagnosticSqlite({ ...request, statements: [
      { sql: "SELECT value FROM counts WHERE value = ?", params: [42], mode: "get" },
      { sql: "SELECT value FROM counts", mode: "all" },
    ] })).toEqual([{ value: 42 }, [{ value: 42 }]]);
    expect(readFileSync(request.path)).toEqual(before);
  });

  it("returns at its deadline even while native SQLite is running an infinite CTE", async () => {
    const request = fixture();
    const start = performance.now();
    const read = readDiagnosticSqlite({ ...request, timeoutMs: 500, statements: [{
      sql: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x",
      mode: "get",
    }] });
    const child = children.at(-1)!;
    const exit = once(child, "exit");
    const rejected = expect(read).rejects.toMatchObject({ code: "DIAGNOSTIC_SQLITE_TIMEOUT" });
    expect(await once(child, "message")).toEqual(["ready", undefined]);
    await rejected;
    expect(performance.now() - start).toBeLessThan(1500);
    expect(await exit).toEqual([null, "SIGKILL"]);
  });

  it("kills an already executing native query on cancellation", async () => {
    const controller = new AbortController();
    const read = readDiagnosticSqlite({ ...fixture(), signal: controller.signal, statements: [{
      sql: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x", mode: "get",
    }] });
    const child = children.at(-1)!;
    const exit = once(child, "exit");
    const rejected = expect(read).rejects.toMatchObject({ code: "DIAGNOSTIC_SQLITE_ABORTED" });
    await once(child, "message");
    const start = performance.now();
    controller.abort();
    await rejected;
    expect(await exit).toEqual([null, "SIGKILL"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("inherits authenticated parent descriptors without closing the caller's fd", async () => {
    const request = fixture();
    const path = roots.at(-1)!;
    const fd = openSync(path, "r");
    const stat = fstatSync(fd, { bigint: true });
    try {
      expect(await readDiagnosticSqlite({ ...request, parents: [
        { path, fd, device: stat.dev, inode: stat.ino },
      ], statements: [{ sql: "SELECT count(*) AS count FROM counts", mode: "get" }] })).toEqual([{ count: 1 }]);
      expect(fstatSync(fd, { bigint: true }).ino).toBe(stat.ino);
    } finally { closeSync(fd); }
  });

  it("sanitizes real worker query failures and rejects mismatched leaves", async () => {
    const request = fixture();
    await expect(readDiagnosticSqlite({ ...request, statements: [{ sql: "SELECT 'secret' FROM absent_table", mode: "get" }] }))
      .rejects.toMatchObject({ code: "DIAGNOSTIC_SQLITE_QUERY", message: "SQLite diagnostic unavailable" });
    await expect(readDiagnosticSqlite({ ...request, expected: { ...request.expected, inode: -1n }, statements: [] }))
      .rejects.toMatchObject({ code: "DIAGNOSTIC_SQLITE_IDENTITY" });
  });
});
