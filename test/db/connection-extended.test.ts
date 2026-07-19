/**
 * Extended connection pool tests covering the untested `isLcmConnectionOpen` export.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  getLcmConnection,
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
