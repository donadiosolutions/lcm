/**
 * Extended connection pool tests covering the untested `isLcmConnectionOpen` export.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  getExistingLcmConnection,
  getLcmConnection,
  getPoolStats,
  closeLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isLcmConnectionOpen", () => {
  it("opens existing databases read/write without creating missing state", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-existing-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "existing # project.sqlite");
    const missingPath = join(tempDir, "missing", "project.sqlite");

    expect(getExistingLcmConnection(":memory:")).toBeNull();
    expect(getExistingLcmConnection(missingPath)).toBeNull();
    expect(isLcmConnectionOpen(missingPath)).toBe(false);

    const created = getLcmConnection(dbPath);
    created.exec("CREATE TABLE durable (value TEXT)");
    closeLcmConnection(dbPath);

    const existing = getExistingLcmConnection(dbPath);
    expect(existing).not.toBeNull();
    existing?.prepare("INSERT INTO durable (value) VALUES (?)").run("available");
    expect(existing?.prepare("SELECT value FROM durable").get()).toEqual({ value: "available" });
  });

  it("shares an already-pooled database with non-creating opens", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-existing-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pooled.sqlite");
    const created = getLcmConnection(dbPath);

    expect(getExistingLcmConnection(dbPath)).toBe(created);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 2 }]);
  });

  it("does not reuse a pooled database after its expected path is rotated away", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-rotated-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pooled.sqlite");
    const rotatedPath = join(tempDir, "pooled.sqlite.rotated");
    const pooled = getLcmConnection(dbPath);
    pooled.exec("CREATE TABLE durable (value TEXT)");
    renameSync(dbPath, rotatedPath);

    expect(getExistingLcmConnection(dbPath)).toBeNull();
    expect(() => getLcmConnection(dbPath)).toThrow("pooled database path no longer matches");
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    expect(pooled.prepare("SELECT COUNT(*) AS count FROM durable").get()).toEqual({ count: 0 });
  });

  it("validates replacement leaves before reusing a pooled database", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-replaced-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pooled.sqlite");
    const rotatedPath = join(tempDir, "pooled.sqlite.rotated");
    getLcmConnection(dbPath);
    renameSync(dbPath, rotatedPath);

    mkdirSync(dbPath);
    expect(() => getExistingLcmConnection(dbPath)).toThrow("not a regular file");
    expect(() => getLcmConnection(dbPath)).toThrow("not a regular file");
    rmSync(dbPath, { recursive: true });
    symlinkSync(rotatedPath, dbPath);
    expect(() => getExistingLcmConnection(dbPath)).toThrow("symlink database path");
    expect(() => getLcmConnection(dbPath)).toThrow("symlink database path");
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
  });

  it("does not reuse a pooled handle after a regular-file replacement", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-replaced-file-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pooled.sqlite");
    const rotatedPath = join(tempDir, "pooled.sqlite.rotated");
    const pooled = getLcmConnection(dbPath);
    pooled.exec("CREATE TABLE original_data (value TEXT)");
    renameSync(dbPath, rotatedPath);
    const replacement = new DatabaseSync(dbPath);
    replacement.exec("CREATE TABLE replacement_data (value TEXT)");
    replacement.close();

    expect(getExistingLcmConnection(dbPath)).toBeNull();
    expect(() => getLcmConnection(dbPath)).toThrow("pooled database path no longer matches");
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    expect(pooled.prepare("SELECT COUNT(*) AS count FROM original_data").get()).toEqual({ count: 0 });
  });

  it.each([
    ["non-creating", getExistingLcmConnection],
    ["create-capable", getLcmConnection],
  ])("rejects a path identity swap during an unpooled %s open", (_label, open) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-swap-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "expected.sqlite");
    const originalPath = join(tempDir, "original.sqlite");
    const replacementPath = join(tempDir, "replacement.sqlite");
    const expected = new DatabaseSync(dbPath);
    expected.exec("CREATE TABLE expected_data (value TEXT)");
    expected.close();
    const replacement = new DatabaseSync(replacementPath);
    replacement.exec("CREATE TABLE replacement_data (value TEXT)");
    replacement.close();
    const originalExec = DatabaseSync.prototype.exec;
    let swapped = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      if (!swapped && sql === "PRAGMA journal_mode = WAL") {
        swapped = true;
        renameSync(dbPath, originalPath);
        renameSync(replacementPath, dbPath);
      }
      return result;
    });

    try {
      expect(() => open(dbPath)).toThrow("database path changed while opening");
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

  it("opens SQLite's in-memory target without filesystem permission work", () => {
    const db = getLcmConnection(":memory:");

    db.exec("CREATE TABLE memory_only (value TEXT)");
    db.prepare("INSERT INTO memory_only (value) VALUES (?)").run("available");
    expect(db.prepare("SELECT value FROM memory_only").get()).toEqual({ value: "available" });
    expect(isLcmConnectionOpen(":memory:")).toBe(true);
  });

  it("creates WAL and shared-memory sidecars with private permissions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-sidecar-mode-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "private.sqlite");
    const previousUmask = process.umask(0o022);
    try {
      const db = getLcmConnection(dbPath);
      db.exec("CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('secret')");

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("evicts and replaces an unhealthy pooled handle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-unhealthy-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");
    const first = getLcmConnection(dbPath);
    first.close();

    const replacement = getLcmConnection(dbPath);
    expect(replacement.prepare("SELECT 1").get()).toBeDefined();
  });

  it("closes an unpooled handle when SQLite initialization fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-init-failure-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "corrupt.sqlite");
    writeFileSync(dbPath, "not a sqlite database");
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    try {
      expect(() => getLcmConnection(dbPath)).toThrow();
      expect(close).toHaveBeenCalledOnce();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      close.mockRestore();
    }
  });

  it("closes an unpooled handle when its path disappears during initialization", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-disappearing-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "disappearing.sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      if (sql === "PRAGMA foreign_keys = ON") rmSync(dbPath, { force: true });
      return result;
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    try {
      expect(() => getLcmConnection(dbPath)).toThrow("database path disappeared while opening");
      expect(close).toHaveBeenCalledOnce();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      exec.mockRestore();
      close.mockRestore();
    }
  });

  it("rejects database symlink leaves without modifying their targets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-symlink-test-"));
    tempDirs.push(tempDir);
    const victim = join(tempDir, "victim.sqlite");
    const dbPath = join(tempDir, "linked.sqlite");
    writeFileSync(victim, "preserve");
    symlinkSync(victim, dbPath);

    expect(() => getLcmConnection(dbPath)).toThrow("symlink database path");
    expect(readFileSync(victim, "utf-8")).toBe("preserve");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("rejects an existing non-regular database leaf", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-nonregular-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "directory.sqlite");
    mkdirSync(dbPath);

    expect(() => getLcmConnection(dbPath)).toThrow("not a regular file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("ignores a path-specific close for an unknown connection", () => {
    expect(() => closeLcmConnection("/tmp/lcm-never-opened.sqlite")).not.toThrow();
  });

  it("returns false when no connection has been opened for the path", () => {
    const fakePath = "/tmp/this/path/was/never/opened.sqlite";
    expect(isLcmConnectionOpen(fakePath)).toBe(false);
  });

  it("returns true after a connection is opened", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);

    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it("returns false after the connection is fully closed (refs reach 0)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath); // open once, refs = 1
    closeLcmConnection(dbPath); // close once, refs = 0 → removed

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("remains open while refs > 0 after partial close", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-open-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath); // refs = 1
    getLcmConnection(dbPath); // refs = 2
    closeLcmConnection(dbPath); // refs = 1 — still open

    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });
});
