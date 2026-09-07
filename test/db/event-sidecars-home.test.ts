import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectEventSidecars } from "../../src/db/event-sidecars.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { SQLiteLocalHookOutboxFactory, type LocalHookOutboxRepository } from "../../src/storage/local-hook-outbox.js";

const directoryHooks = vi.hoisted(() => ({
  path: "", phase: "", error: undefined as unknown,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === directoryHooks.path && directoryHooks.phase === "open") throw directoryHooks.error;
      return actual.openSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (args[0] === directoryHooks.path && directoryHooks.phase === "authenticate") throw directoryHooks.error;
      return actual.lstatSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (args[0] === directoryHooks.path && directoryHooks.phase === "enumerate") throw directoryHooks.error;
      return actual.readdirSync(...args);
    },
  };
});

const diagnosticHooks = vi.hoisted(() => ({
  beforeRead: undefined as (() => void) | undefined,
  error: undefined as Error | undefined,
}));
vi.mock("../../src/db/diagnostic-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/diagnostic-sqlite.js")>();
  return {
    ...actual,
    readDiagnosticSqlite: async (...args: Parameters<typeof actual.readDiagnosticSqlite>) => {
      diagnosticHooks.beforeRead?.();
      if (diagnosticHooks.error) throw diagnosticHooks.error;
      return actual.readDiagnosticSqlite(...args);
    },
  };
});

const projectId = "a".repeat(64);
const otherId = "b".repeat(64);
const thirdId = "c".repeat(64);

describe("configured-home sidecar observation", () => {
  let homeDir: string;
  let path: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "sidecar-home-"));
    mkdirSync(join(homeDir, ".lcm", "events"), { recursive: true, mode: 0o700 });
    path = join(homeDir, ".lcm", "events", `${projectId}.db`);
    const db = new EventsDb(path);
    db.close();
  });

  function addSidecar(id: string): string {
    const sidecarPath = join(homeDir, ".lcm", "events", `${id}.db`);
    const db = new EventsDb(sidecarPath);
    db.close();
    return sidecarPath;
  }

  afterEach(() => {
    directoryHooks.phase = "";
    diagnosticHooks.beforeRead = undefined;
    diagnosticHooks.error = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("reports an absent events root as observed empty without creating it", async () => {
    const missingHome = join(homeDir, "absent-home");
    await expect(collectEventSidecars({ homeDir: missingHome, pruneOrphanSidecars: false })).resolves.toEqual([]);
    expect(existsSync(missingHome)).toBe(false);
    expect(await collectEventSidecars({ homeDir: missingHome })).toEqual([]);
  });

  it.each(["open", "enumerate", "authenticate"])("reports diagnostic %s failures without exposing raw errors", async (phase) => {
    directoryHooks.path = join(homeDir, ".lcm", "events");
    directoryHooks.phase = phase;
    for (const code of ["EACCES", "EPERM", "EIO"] as const) {
      directoryHooks.error = Object.assign(new Error("private filesystem canary"), { code, path: "/private/path" });
      await expect(collectEventSidecars({ homeDir, pruneOrphanSidecars: false })).rejects.toMatchObject({
        message: "event sidecar directory unavailable", code: code === "EIO" ? undefined : code,
      });
      await collectEventSidecars({ homeDir, pruneOrphanSidecars: false }).catch((error: Error) => {
        expect(JSON.stringify(error)).not.toContain("private");
        expect(error.cause).toBeUndefined();
      });
      expect(await collectEventSidecars({ homeDir })).toEqual([]);
    }
    directoryHooks.error = null;
    await expect(collectEventSidecars({ homeDir, pruneOrphanSidecars: false }))
      .rejects.toMatchObject({ message: "event sidecar directory unavailable", code: undefined });
  });

  it("reads the configured home and metadata while preserving an empty orphan", async () => {
    const before = { bytes: readFileSync(path), stat: statSync(path) };
    const result = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ projectId, path, captured: 0, metadataMissing: true });
    expect(readFileSync(path)).toEqual(before.bytes);
    expect(statSync(path)).toMatchObject({ ino: before.stat.ino, mtimeMs: before.stat.mtimeMs });
    const projectDir = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd: "/configured/project" }));
    const [withMetadata] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
    expect(withMetadata).toMatchObject({ cwd: "/configured/project", metadataMissing: false });
  });

  it("does not block on FIFO project metadata", async () => {
    const projectDir = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const meta = join(projectDir, "meta.json");
    execFileSync("mkfifo", ["-m", "600", meta]);
    // Release the old blocking implementation so RED fails instead of wedging
    // Vitest. The fixed reader rejects the FIFO before this writer wakes.
    const writer = spawn(process.execPath, ["-e", `
      setTimeout(() => {
        const fs = require('node:fs');
        try {
          const fd = fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
          fs.writeSync(fd, JSON.stringify({cwd:'/private-fifo-canary'}));
          fs.closeSync(fd);
        } catch {}
      }, 1500);
    `, meta], { stdio: "ignore", env: {} });
    const exited = once(writer, "exit");
    try {
      const started = performance.now();
      const [sidecar] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(sidecar).toMatchObject({ metadataMissing: true });
      expect(JSON.stringify(sidecar)).not.toContain("private-fifo-canary");
      expect(statSync(meta).isFIFO()).toBe(true);
    } finally {
      writer.kill("SIGKILL");
      await exited;
    }
  });

  it.each(["symlink", "oversized"])("refuses %s project metadata without disclosing its contents", async kind => {
    const projectDir = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const meta = join(projectDir, "meta.json");
    if (kind === "symlink") {
      const outside = join(homeDir, "private-metadata.json");
      writeFileSync(outside, JSON.stringify({cwd:"/private-metadata-canary"}));
      symlinkSync(outside, meta);
    } else {
      writeFileSync(meta, JSON.stringify({cwd:"/private-metadata-canary",padding:"x".repeat(1024*1024)}));
    }
    const [sidecar] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
    expect(sidecar).toMatchObject({ metadataMissing: true });
    expect(sidecar.cwd).toBeUndefined();
    expect(JSON.stringify(sidecar)).not.toContain("private-metadata-canary");
  });

  it("does not migrate an old sidecar schema during observation", async () => {
    const oldPath = join(homeDir, ".lcm", "events", `${otherId}.db`);
    const old = new DatabaseSync(oldPath);
    old.exec("CREATE TABLE events (event_id INTEGER PRIMARY KEY, created_at TEXT, processed_at TEXT)");
    old.close();
    const before = readFileSync(oldPath);
    const result = await collectEventSidecars({ homeDir, projectId: otherId, pruneOrphanSidecars: false });
    expect(result[0].scanError).toBeTruthy();
    expect(readFileSync(oldPath)).toEqual(before);
  });

  it("limits discovery to the admitted project before applying scan budgets", async () => {
    writeFileSync(join(homeDir, ".lcm", "events", `${otherId}.db`), "corrupt unrelated sidecar");
    expect(await collectEventSidecars({ homeDir, projectId, maxDbs: 1, pruneOrphanSidecars: false }))
      .toMatchObject([{ projectId, captured: 0 }]);
    expect(await collectEventSidecars({ homeDir, projectId: "c".repeat(64), pruneOrphanSidecars: false }))
      .toEqual([]);
  });

  it.each(["../outside", "/raw/path", "", "0195d250-0000-7000-8000-000000000091"])(
    "rejects invalid local project selectors: %s", async (projectId) => {
      await expect(collectEventSidecars({ homeDir, projectId })).rejects.toThrow("invalid sidecar project ID");
      expect(existsSync(path)).toBe(true);
    },
  );

  it("reports cancellation without opening or pruning a sidecar", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private cancellation canary"));
    const result = await collectEventSidecars({ homeDir, signal: controller.signal });
    expect(result).toHaveLength(1);
    expect(result[0].scanSkipped).toContain("cancelled");
    expect(JSON.stringify(result)).not.toContain("private cancellation canary");
    expect(existsSync(path)).toBe(true);
  });

  it.each(["DIAGNOSTIC_SQLITE_TIMEOUT", "DIAGNOSTIC_SQLITE_ABORTED"])("classifies isolated reader %s as a skipped scan", async (code) => {
    diagnosticHooks.error = Object.assign(new Error("private reader canary"), { code });
    const [result] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
    expect(result.scanSkipped).toContain(code === "DIAGNOSTIC_SQLITE_TIMEOUT" ? "timeout" : "cancelled");
    expect(JSON.stringify(result)).not.toContain("private reader canary");
    expect(existsSync(path)).toBe(true);
  });

  it("interrupts an expensive native SQLite scan within its deadline", async () => {
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE events;
      CREATE VIEW events AS
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 3000000
      )
      SELECT NULL AS created_at, NULL AS processed_at, 'pending' AS delivery_state,
        NULL AS remote_inbox_id, NULL AS remote_pruned_at FROM sequence;
    `);
    raw.close();
    const started = performance.now();
    const [result] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false, timeoutMs: 50 });
    expect(result.scanSkipped).toContain("timeout");
    expect(performance.now() - started).toBeLessThan(500);
    expect(existsSync(path)).toBe(true);
  });

  it("reads committed live WAL rows without checkpointing the database", async () => {
    const writer = new EventsDb(path);
    writer.insertEvent("session", { type: "decision", category: "decision", data: "private payload", priority: 1 }, "PostToolUse");
    writer.logHookError("PostToolUse", new Error("diagnostic fixture"));
    const witnesses = [path, `${path}-wal`, `${path}-shm`].map(file => ({
      file, bytes: readFileSync(file), stat: statSync(file),
    }));
    try {
      const [result] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false, includeRecentErrors: true });
      expect(result).toMatchObject({ captured: 1, unprocessed: 1, deliveryPending: 1, errors: 1 });
      expect(JSON.stringify(result)).not.toContain("private payload");
      for (const witness of witnesses) {
        // SQLite may update SHM read marks; durable content and all identities remain stable.
        if (!witness.file.endsWith("-shm")) {
          expect(readFileSync(witness.file)).toEqual(witness.bytes);
          expect(statSync(witness.file).mtimeMs).toBe(witness.stat.mtimeMs);
        }
        expect(statSync(witness.file).ino).toBe(witness.stat.ino);
      }
    } finally { writer.close(); }
  });

  it("closes a read-only connection and refuses a replaced sidecar leaf", async () => {
    diagnosticHooks.beforeRead = () => {
      renameSync(path, `${path}.old`);
      writeFileSync(path, "replacement");
    };
    const [result] = await collectEventSidecars({ homeDir, pruneOrphanSidecars: false });
    expect(result.scanError).toBeTruthy();
    expect(readFileSync(path, "utf8")).toBe("replacement");
    expect(result.pruned).toBeUndefined();
  });

  it.each(["abort", "deadline"] as const)("stops an opener that exhausts its %s before resolving", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const realOpen = SQLiteLocalHookOutboxFactory.prototype.open;
    const openSpy = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockImplementationOnce(async function (path, options) {
      const result = await realOpen.call(this, path, options);
      if (kind === "abort") controller.abort();
      else vi.setSystemTime(Date.now() + 100);
      return result;
    });
    addSidecar(otherId);
    addSidecar(thirdId);
    const result = await collectEventSidecars({ homeDir, timeoutMs: 25, signal: controller.signal });
    expect(result[0].scanSkipped).toContain(kind === "abort" ? "cancelled" : "timeout");
    expect(result[0].scanSkippedCount).toBe(3);
    expect(result).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(true);
  });

  it("retains a count of one for a single-file in-flight stop", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const realOpen = SQLiteLocalHookOutboxFactory.prototype.open;
    const openSpy = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockImplementationOnce(async function (path, options) {
      const result = await realOpen.call(this, path, options);
      controller.abort();
      return result;
    });

    const result = await collectEventSidecars({ homeDir, signal: controller.signal });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ scanSkippedCount: 1 });
    expect(result[0].scanSkipped).toContain("cancelled");
    expect(openSpy).toHaveBeenCalledOnce();
  });

  it("cancels a pending health read and closes without waiting for it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const realOpen = SQLiteLocalHookOutboxFactory.prototype.open;
    let opened: LocalHookOutboxRepository | undefined;
    const openSpy = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockImplementationOnce(async function (path, options) {
      opened = await realOpen.call(this, path, options);
      vi.spyOn(opened, "getHealthStats").mockImplementationOnce(() => new Promise(() => {}));
      return opened;
    });
    addSidecar(otherId);
    addSidecar(thirdId);
    const resultPromise = collectEventSidecars({ homeDir, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("private abort"));
    const result = await resultPromise;
    expect(result[0].scanSkipped).toContain("cancelled");
    expect(result[0].scanSkippedCount).toBe(3);
    expect(result).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledOnce();
    await expect(opened!.getHealthStats()).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it("counts the current file and tail when a middle scan stops", async () => {
    const controller = new AbortController();
    addSidecar(otherId);
    addSidecar(thirdId);
    const realOpen = SQLiteLocalHookOutboxFactory.prototype.open;
    let openCalls = 0;
    vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockImplementation(async function (path, options) {
      const result = await realOpen.call(this, path, options);
      openCalls++;
      if (openCalls === 2) controller.abort();
      return result;
    });

    const result = await collectEventSidecars({ homeDir, signal: controller.signal });

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ scanSkippedCount: 2 });
    expect(result[1].scanSkipped).toContain("cancelled");
    expect(openCalls).toBe(2);
    expect(result.some(({ file }) => file === `${thirdId}.db`)).toBe(false);
  });

  it("bounds a stalled open and closes its late result exactly once", async () => {
    vi.useFakeTimers();
    let finishOpen!: () => void;
    let lateRepository: LocalHookOutboxRepository | undefined;
    const realOpen = SQLiteLocalHookOutboxFactory.prototype.open;
    const openSpy = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockImplementationOnce(async function (path, options) {
      await new Promise<void>(resolve => { finishOpen = resolve; });
      lateRepository = await realOpen.call(this, path, options);
      return lateRepository;
    });
    const close = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "close");
    addSidecar(otherId);
    addSidecar(thirdId);
    const resultPromise = collectEventSidecars({ homeDir, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;
    expect(result[0].scanSkipped).toContain("timeout");
    expect(result[0].scanSkippedCount).toBe(3);
    expect(result).toHaveLength(1);
    expect(openSpy).toHaveBeenCalledOnce();
    finishOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    await expect(lateRepository!.getHealthStats()).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  });
});
