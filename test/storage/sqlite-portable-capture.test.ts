import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCapturedSqliteAuthority, openCapturedSqliteDatabase } from "../../src/storage/sqlite/portable-capture.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
const dirs: string[] = [];
function fixture(data: Uint8Array = Buffer.alloc(128 * 1024, 42)) {
  const dir = fs.mkdtempSync(join(tmpdir(), "lcm-capture-"));
  dirs.push(dir);
  const path = join(dir, "capture # ? % ü.db");
  fs.writeFileSync(path, data, { mode: 0o600 });
  const expected = createHash("sha256").update(data).digest("hex");
  return { dir, path, expected, authority: () => createCapturedSqliteAuthority(path, expected) };
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("immutable SQLite captures", () => {
  it("reads a checkpointed WAL-header database without changing files or directory entries", () => {
    const f = fixture(Buffer.alloc(0));
    const writer = new DatabaseSync(f.path);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value); INSERT INTO evidence VALUES('preserved'); PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close();
    const bytes = fs.readFileSync(f.path);
    expect(bytes[18]).toBe(2);
    const entries = fs.readdirSync(f.dir);
    const stat = fs.statSync(f.path, { bigint: true });
    const db = openCapturedSqliteDatabase(f.path);
    try {
      expect(db.prepare("SELECT value FROM evidence").get()?.value).toBe("preserved");
      expect(() => db.exec("INSERT INTO evidence VALUES('denied')")).toThrow();
    } finally { db.close(); }
    expect(fs.readdirSync(f.dir)).toEqual(entries);
    expect(fs.readFileSync(f.path)).toEqual(bytes);
    expect(fs.statSync(f.path, { bigint: true }).mtimeNs).toBe(stat.mtimeNs);
    expect(fs.statSync(f.path, { bigint: true }).ctimeNs).toBe(stat.ctimeNs);
  });

  it.each(["-wal", "-shm"])("rejects even empty %s sidecars without touching them", suffix => {
    const f = fixture();
    fs.writeFileSync(`${f.path}${suffix}`, "");
    expect(() => f.authority()).toThrow(expect.objectContaining({ code: "source-changed" }));
    expect(() => openCapturedSqliteDatabase(f.path)).toThrow(expect.objectContaining({ code: "source-changed" }));
    expect(fs.readFileSync(`${f.path}${suffix}`)).toHaveLength(0);
  });

  it("rejects dangling sidecar symlinks and nonexistent databases", () => {
    const f = fixture();
    fs.symlinkSync(join(f.dir, "absent"), `${f.path}-wal`);
    expect(() => f.authority()).toThrow(expect.objectContaining({ code: "source-changed" }));
    expect(() => openCapturedSqliteDatabase(join(f.dir, "missing"))).toThrow();
    expect(fs.existsSync(join(f.dir, "missing"))).toBe(false);
  });
});

describe("cached capture authentication", () => {
  it("hashes in bounded chunks only on first or forced checks across many batches", async () => {
    const f = fixture();
    const authority = f.authority();
    const read = vi.spyOn(fs, "readSync");
    authority.checkSync();
    expect(read).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 100; index++) { authority.checkSync(); await authority.check(); }
    expect(read).toHaveBeenCalledTimes(3);
    authority.checkSync(true);
    expect(read).toHaveBeenCalledTimes(6);
    expect(read.mock.calls.every(call => (call[2] as number) === 0 && (call[3] as number) === 64 * 1024)).toBe(true);
    const open = vi.spyOn(promises, "open");
    await authority.check(undefined, true);
    expect(open).toHaveBeenCalledTimes(1);
    await authority.check();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("rehashes changed metadata and rejects same-size content mutation with restored mtime", async () => {
    const f = fixture();
    const authority = f.authority();
    await authority.check();
    const before = fs.statSync(f.path);
    fs.writeFileSync(f.path, Buffer.alloc(before.size, 43));
    fs.utimesSync(f.path, before.atime, before.mtime);
    expect(() => authority.checkSync()).toThrow(expect.objectContaining({ code: "source-changed" }));
    await expect(authority.check()).rejects.toMatchObject({ code: "source-changed" });
  });

  it("reauthenticates unchanged bytes after metadata drift", () => {
    const f = fixture(); const authority = f.authority(); authority.checkSync();
    const read = vi.spyOn(fs, "readSync");
    fs.utimesSync(f.path, 10, 20);
    authority.checkSync();
    expect(read).toHaveBeenCalledTimes(3);
    authority.checkSync();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["sync", "async"])("rejects digest mismatch through the %s seam", async mode => {
    const f = fixture(); const authority = createCapturedSqliteAuthority(f.path, "a".repeat(64));
    if (mode === "sync") expect(() => authority.checkSync()).toThrow(expect.objectContaining({ code: "source-changed" }));
    else await expect(authority.check()).rejects.toMatchObject({ code: "source-changed" });
  });

  it("rejects inode replacement even when contents and permissions match", async () => {
    const f = fixture(); const authority = f.authority(); await authority.check();
    fs.renameSync(f.path, `${f.path}.old`);
    fs.copyFileSync(`${f.path}.old`, f.path); fs.chmodSync(f.path, 0o600);
    await expect(authority.check()).rejects.toMatchObject({ code: "source-changed" });
  });

  it("allows caller-owned scratch directories beside the authenticated capture", async () => {
    const f = fixture(); const authority = f.authority(); await authority.check();
    fs.mkdirSync(join(f.dir, "scratch"), { mode: 0o700 });
    authority.checkSync();
    await authority.check(undefined, true);
    fs.rmdirSync(join(f.dir, "scratch"));
    authority.checkSync();
  });

  it("rejects a replaced parent directory even when the original file is retained", () => {
    const f = fixture(); const authority = f.authority(); authority.checkSync();
    const old = `${f.dir}-old`; dirs.push(old);
    fs.renameSync(f.dir, old); fs.mkdirSync(f.dir, { mode: 0o700 });
    fs.renameSync(join(old, "capture # ? % ü.db"), f.path);
    expect(() => authority.checkSync()).toThrow(expect.objectContaining({ code: "source-changed" }));
  });

  it("checks permission, owner, path and sidecar drift even on cached checks", () => {
    const f = fixture(); const authority = f.authority(); authority.checkSync();
    fs.chmodSync(f.path, 0o644);
    expect(() => authority.checkSync()).toThrow(); fs.chmodSync(f.path, 0o600);
    fs.chmodSync(f.dir, 0o755);
    expect(() => authority.checkSync()).toThrow(); fs.chmodSync(f.dir, 0o700);
    fs.writeFileSync(`${f.path}-shm`, "");
    expect(() => authority.checkSync()).toThrow();
  });

  it("rejects invalid hashes, relative paths, symlink captures and non-files", () => {
    const f = fixture();
    expect(() => createCapturedSqliteAuthority(f.path, "bad")).toThrow();
    expect(() => createCapturedSqliteAuthority("relative", f.expected)).toThrow();
    expect(() => createCapturedSqliteAuthority(f.dir, f.expected)).toThrow();
    const link = join(f.dir, "link"); fs.symlinkSync(f.path, link);
    expect(() => createCapturedSqliteAuthority(link, f.expected)).toThrow();
    const directoryLink = `${f.dir}-link`; dirs.push(directoryLink); fs.symlinkSync(f.dir, directoryLink);
    expect(() => createCapturedSqliteAuthority(join(directoryLink, "capture # ? % ü.db"), f.expected)).toThrow();
  });

  it("preserves cancellation without losing a valid cached authority", async () => {
    const f = fixture(); const authority = f.authority();
    await expect(authority.check(AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
    await authority.check();
    await expect(authority.check(AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
    authority.checkSync();
  });
});


describe("capture authentication races and failure cleanup", () => {
  it("sanitizes failed sidecar inspection", () => {
    const f = fixture(); const original = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (String(path).endsWith("-wal")) throw Object.assign(new Error("private path canary"), { code: "EACCES" });
      return original(path, options as never);
    }) as typeof fs.lstatSync);
    expect(() => f.authority()).toThrow(expect.objectContaining({ code: "source-changed", message: expect.not.stringContaining("canary") }));
  });

  it("rejects a replaced file between sync inspection and opening the descriptor", () => {
    const f = fixture(); const authority = f.authority(); const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      fs.renameSync(f.path, `${f.path}.old`);
      fs.copyFileSync(`${f.path}.old`, f.path);
      return original(...args);
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(() => authority.checkSync()).toThrow(expect.objectContaining({ code: "source-changed" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a replaced file between async inspection and opening the descriptor", async () => {
    const f = fixture(); const authority = f.authority(); const original = promises.open;
    let closed = false;
    vi.spyOn(promises, "open").mockImplementationOnce(async (...args) => {
      fs.renameSync(f.path, `${f.path}.old`);
      fs.copyFileSync(`${f.path}.old`, f.path);
      const file = await original(...args);
      const close = file.close.bind(file);
      file.close = async () => { await close(); closed = true; };
      return file;
    });
    await expect(authority.check()).rejects.toMatchObject({ code: "source-changed" });
    expect(closed).toBe(true);
  });

  it("rejects source changes during hashing and closes the descriptor", () => {
    const f = fixture(); const authority = f.authority(); const original = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const read = original(...args);
      fs.utimesSync(f.path, 10, 20);
      return read;
    }) as typeof fs.readSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => authority.checkSync()).toThrow(expect.objectContaining({ code: "source-changed" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("observes cancellation during chunked async hashing and closes the descriptor", async () => {
    const f = fixture(); const authority = f.authority(); const original = promises.open;
    const controller = new AbortController(); let closed = false;
    vi.spyOn(promises, "open").mockImplementationOnce(async (...args) => {
      const file = await original(...args);
      const read = file.read.bind(file); const close = file.close.bind(file);
      file.read = (async (...readArgs: Parameters<typeof file.read>) => {
        const result = await read(...readArgs); controller.abort(); return result;
      }) as typeof file.read;
      file.close = async () => { await close(); closed = true; };
      return file;
    });
    await expect(authority.check(controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(closed).toBe(true);
    await authority.check();
  });
});
