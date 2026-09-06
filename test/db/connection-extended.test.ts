/**
 * Extended connection pool tests covering the untested `isLcmConnectionOpen` export.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
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
  invalidateLcmConnection,
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
  it.each([
    ["non-creating", getExistingLcmConnection],
    ["create-capable", getLcmConnection],
  ])("rejects a symlink database parent during a %s open without mutation", (_label, open) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-symlink-test-"));
    tempDirs.push(tempDir);
    const target = join(tempDir, "target");
    const linkedParent = join(tempDir, "linked-parent");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    writeFileSync(join(target, "preserve"), "unchanged");
    symlinkSync(target, linkedParent);
    const dbPath = join(linkedParent, "events.sqlite");

    expect(() => open(dbPath)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(target, "preserve"), "utf8")).toBe("unchanged");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it.each([
    ["non-creating", getExistingLcmConnection],
    ["create-capable", getLcmConnection],
  ])("rejects a non-directory database parent during a %s open", (_label, open) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-file-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    writeFileSync(parent, "preserve");
    const dbPath = join(parent, "events.sqlite");

    expect(() => open(dbPath)).toThrow();
    expect(readFileSync(parent, "utf8")).toBe("preserve");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it.each([
    ["non-creating", getExistingLcmConnection],
    ["create-capable", getLcmConnection],
  ])("rejects a database parent owned by another user during a %s open", (_label, open) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-owner-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    new DatabaseSync(dbPath).close();

    expect(() => open(dbPath, {
      _databaseParentForTesting: {
        expectedUid: statSync(tempDir).uid + 1,
      },
    })).toThrow("owner is not trusted");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("creates missing database-parent components privately", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-create-test-"));
    tempDirs.push(tempDir);
    const first = join(tempDir, "first");
    const second = join(first, "second");
    const dbPath = join(second, "events.sqlite");

    const db = getLcmConnection(dbPath);
    try {
      expect(statSync(first).mode & 0o777).toBe(0o700);
      expect(statSync(second).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      closeLcmConnection(dbPath, db);
    }
  });

  it("keeps generic existing-only parent admission read-only", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-existing-mode-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    new DatabaseSync(dbPath).close();
    chmodSync(tempDir, 0o755);

    const db = getExistingLcmConnection(dbPath);
    try {
      expect(db).not.toBeNull();
      expect(statSync(tempDir).mode & 0o777).toBe(0o755);
    } finally {
      if (db) closeLcmConnection(dbPath, db);
    }
  });

  it("uses the kernel-resolved parent and database for create-capable paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-dotdot-create-test-"));
    tempDirs.push(tempDir);
    const lexicalParent = join(tempDir, "lexical-parent");
    const actualParent = join(tempDir, "actual-parent");
    const actualNested = join(actualParent, "nested");
    mkdirSync(lexicalParent, { mode: 0o755 });
    mkdirSync(actualNested, { recursive: true, mode: 0o755 });
    chmodSync(lexicalParent, 0o755);
    chmodSync(actualParent, 0o755);
    symlinkSync(actualNested, join(lexicalParent, "alias"));

    const lexicalDbPath = join(lexicalParent, "events.sqlite");
    const actualDbPath = join(actualParent, "events.sqlite");
    const lexical = new DatabaseSync(lexicalDbPath);
    lexical.exec("CREATE TABLE identity (value TEXT); INSERT INTO identity VALUES ('lexical')");
    lexical.close();
    const actual = new DatabaseSync(actualDbPath);
    actual.exec("CREATE TABLE identity (value TEXT); INSERT INTO identity VALUES ('actual')");
    actual.close();
    const requestedPath = `${join(lexicalParent, "alias")}/../events.sqlite`;

    const db = getLcmConnection(requestedPath);
    expect(db.prepare("SELECT value FROM identity").get()).toEqual({ value: "actual" });
    expect(statSync(actualParent).mode & 0o777).toBe(0o700);
    expect(statSync(lexicalParent).mode & 0o777).toBe(0o755);

    const originalActualParent = join(tempDir, "original-actual-parent");
    renameSync(actualParent, originalActualParent);
    mkdirSync(actualNested, { recursive: true, mode: 0o755 });
    chmodSync(actualParent, 0o755);
    linkSync(join(originalActualParent, "events.sqlite"), actualDbPath);

    expect(() => getLcmConnection(requestedPath)).toThrow("parent");
    expect(statSync(actualParent).mode & 0o777).toBe(0o755);
    expect(getPoolStats().connections).toMatchObject([{ path: requestedPath, refs: 1 }]);
  });

  it("uses the kernel-resolved database for existing-only paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-dotdot-existing-test-"));
    tempDirs.push(tempDir);
    const lexicalParent = join(tempDir, "lexical-parent");
    const actualParent = join(tempDir, "actual-parent");
    const actualNested = join(actualParent, "nested");
    mkdirSync(lexicalParent, { mode: 0o755 });
    mkdirSync(actualNested, { recursive: true, mode: 0o755 });
    chmodSync(lexicalParent, 0o755);
    chmodSync(actualParent, 0o755);
    symlinkSync(actualNested, join(lexicalParent, "alias"));

    const lexicalDbPath = join(lexicalParent, "events.sqlite");
    const actualDbPath = join(actualParent, "events.sqlite");
    const lexical = new DatabaseSync(lexicalDbPath);
    lexical.exec("CREATE TABLE identity (value TEXT); INSERT INTO identity VALUES ('lexical')");
    lexical.close();
    const actual = new DatabaseSync(actualDbPath);
    actual.exec("CREATE TABLE identity (value TEXT); INSERT INTO identity VALUES ('actual')");
    actual.close();
    const requestedPath = `${join(lexicalParent, "alias")}/../events.sqlite`;

    const db = getExistingLcmConnection(requestedPath);
    expect(db?.prepare("SELECT value FROM identity").get()).toEqual({ value: "actual" });
    expect(statSync(actualParent).mode & 0o777).toBe(0o755);
    expect(statSync(lexicalParent).mode & 0o777).toBe(0o755);
  });

  it("rejects a pooled parent replacement before increasing its ref-count", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-replaced-pool-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const original = join(tempDir, "original-parent");
    mkdirSync(parent, { mode: 0o700 });
    const dbPath = join(parent, "events.sqlite");
    const pooled = getLcmConnection(dbPath);
    pooled.exec("CREATE TABLE original_data (value TEXT)");
    renameSync(parent, original);
    mkdirSync(parent, { mode: 0o777 });
    chmodSync(parent, 0o777);
    linkSync(join(original, "events.sqlite"), dbPath);

    expect(() => getLcmConnection(dbPath)).toThrow("parent");
    expect(statSync(parent).mode & 0o777).toBe(0o777);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    expect(pooled.prepare("SELECT COUNT(*) AS count FROM original_data").get())
      .toEqual({ count: 0 });
  });

  it("rejects a pooled parent symlink even when it resolves to the original directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-rebound-pool-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const original = join(tempDir, "original-parent");
    mkdirSync(parent, { mode: 0o700 });
    const dbPath = join(parent, "events.sqlite");
    const pooled = getLcmConnection(dbPath);
    renameSync(parent, original);
    symlinkSync(original, parent);

    expect(() => getExistingLcmConnection(dbPath)).toThrow();
    expect(() => getLcmConnection(dbPath)).toThrow();
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    expect(pooled.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("rejects parent loss after pooling instead of recreating it", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-lost-pool-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const original = join(tempDir, "original-parent");
    mkdirSync(parent, { mode: 0o700 });
    const dbPath = join(parent, "events.sqlite");
    getLcmConnection(dbPath);
    renameSync(parent, original);

    expect(() => getExistingLcmConnection(dbPath)).toThrow("parent");
    expect(() => getLcmConnection(dbPath)).toThrow("parent");
    expect(existsSync(parent)).toBe(false);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
  });

  it("fails before tightening when the admitted parent entry is replaced", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-before-tighten-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const original = join(tempDir, "original-parent");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const dbPath = join(parent, "events.sqlite");

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        beforeTighten: () => {
          renameSync(parent, original);
          mkdirSync(parent, { mode: 0o777 });
          chmodSync(parent, 0o777);
        },
      },
    })).toThrow("topology");
    expect(statSync(original).mode & 0o777).toBe(0o755);
    expect(statSync(parent).mode & 0o777).toBe(0o777);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("does not fall back to pathname chmod when opening the parent fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-open-failure-test-"));
    tempDirs.push(tempDir);
    chmodSync(tempDir, 0o755);
    const dbPath = join(tempDir, "events.sqlite");
    const error = Object.assign(new Error("injected descriptor exhaustion"), { code: "EMFILE" });

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: { open: () => { throw error; } },
    })).toThrow("injected descriptor exhaustion");
    expect(statSync(tempDir).mode & 0o777).toBe(0o755);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("preserves a descriptor tightening failure when cleanup also fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-fchmod-failure-test-"));
    tempDirs.push(tempDir);
    chmodSync(tempDir, 0o755);
    const dbPath = join(tempDir, "events.sqlite");

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        fchmod: () => { throw new Error("injected descriptor chmod failure"); },
        close: (fd) => {
          closeSync(fd);
          throw new Error("injected cleanup failure");
        },
      },
    })).toThrow("injected descriptor chmod failure");
    expect(statSync(tempDir).mode & 0o777).toBe(0o755);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("does not publish a connection when parent descriptor close fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-close-failure-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        close: (fd) => {
          closeSync(fd);
          throw new Error("injected parent close failure");
        },
      },
    })).toThrow("injected parent close failure");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("preserves SQLite initialization failure when parent cleanup also fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-primary-failure-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA journal_mode = WAL") {
        throw new Error("injected primary SQLite failure");
      }
      return originalExec.call(this, sql);
    });

    try {
      expect(() => getLcmConnection(dbPath, {
        _databaseParentForTesting: {
          close: (fd) => {
            closeSync(fd);
            throw new Error("injected secondary parent close failure");
          },
        },
      })).toThrow("injected primary SQLite failure");
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

  it("repairs a newly created component despite an owner-execute-masking umask", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-umask-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const dbPath = join(parent, "events.sqlite");
    const previousUmask = process.umask(0o100);
    try {
      const db = getLcmConnection(dbPath);
      closeLcmConnection(dbPath, db);
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  it("admits a safe competing creator for a missing component", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-eexist-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const dbPath = join(parent, "events.sqlite");

    const db = getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        beforeCreateComponent: (component, index) => {
          if (index === 0) {
            mkdirSync(component, { mode: 0o755 });
            chmodSync(component, 0o755);
          }
        },
      },
    });
    closeLcmConnection(dbPath, db);

    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  it("rejects substitution of a retained newly created component", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-component-swap-test-"));
    tempDirs.push(tempDir);
    const first = join(tempDir, "first");
    const original = join(tempDir, "original-first");
    const second = join(first, "second");
    const dbPath = join(second, "events.sqlite");

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        beforeCreateComponent: (_component, index) => {
          if (index === 1) {
            renameSync(first, original);
            mkdirSync(first, { mode: 0o700 });
          }
        },
      },
    })).toThrow("topology");
    expect(existsSync(second)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("closes both retained descriptors when intermediate cleanup fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-component-close-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "first", "second", "events.sqlite");
    let closes = 0;

    expect(() => getLcmConnection(dbPath, {
      _databaseParentForTesting: {
        close: (fd) => {
          closeSync(fd);
          closes += 1;
          if (closes === 1) throw new Error("injected intermediate close failure");
        },
      },
    })).toThrow("injected intermediate close failure");
    expect(closes).toBe(2);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("preserves a pre-existing symlink ancestor while creating the final parent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-alias-ancestor-test-"));
    tempDirs.push(tempDir);
    const target = join(tempDir, "target");
    const alias = join(tempDir, "alias");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, alias);
    const parent = join(alias, "nested", "events");
    const dbPath = join(parent, "events.sqlite");

    const db = getLcmConnection(dbPath);
    closeLcmConnection(dbPath, db);

    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "nested", "events")).mode & 0o777).toBe(0o700);
  });

  it("refuses an unreadable parent without pathname repair fallback", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-unreadable-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o000);
    const dbPath = join(parent, "events.sqlite");

    try {
      expect(() => getLcmConnection(dbPath)).toThrow();
      expect(statSync(parent).mode & 0o777).toBe(0o000);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("rejects parent replacement during SQLite initialization", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-init-swap-test-"));
    tempDirs.push(tempDir);
    const parent = join(tempDir, "parent");
    const original = join(tempDir, "original-parent");
    mkdirSync(parent, { mode: 0o700 });
    const dbPath = join(parent, "events.sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    let swapped = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      if (!swapped && sql === "PRAGMA journal_mode = WAL") {
        swapped = true;
        renameSync(parent, original);
        mkdirSync(parent, { mode: 0o700 });
      }
      return result;
    });

    try {
      expect(() => getLcmConnection(dbPath)).toThrow("topology");
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

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

  it("rejects replacement of a newly created leaf during initialization", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-created-leaf-swap-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    const openedPath = join(tempDir, "created.sqlite.opened");
    const replacementPath = join(tempDir, "created.sqlite.replacement");
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
      if (!swapped && sql === "PRAGMA foreign_keys = ON") {
        swapped = true;
        renameSync(dbPath, openedPath);
        renameSync(replacementPath, dbPath);
      }
      return result;
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    try {
      expect(() => getLcmConnection(dbPath)).toThrow("database path changed while opening");
      expect(close).toHaveBeenCalledOnce();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
      const rejectedReplacement = new DatabaseSync(dbPath);
      expect(rejectedReplacement.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
        .toContainEqual({ name: "replacement_data" });
      rejectedReplacement.close();
    } finally {
      exec.mockRestore();
      close.mockRestore();
    }
  });

  it("opens SQLite's in-memory target without filesystem permission work", () => {
    const db = getLcmConnection(":memory:", {
      _databaseParentForTesting: {
        open: () => { throw new Error("memory must bypass parent admission"); },
      },
    });

    db.exec("CREATE TABLE memory_only (value TEXT)");
    db.prepare("INSERT INTO memory_only (value) VALUES (?)").run("available");
    expect(db.prepare("SELECT value FROM memory_only").get()).toEqual({ value: "available" });
    expect(getLcmConnection(":memory:")).toBe(db);
    expect(isLcmConnectionOpen(":memory:")).toBe(true);
  });

  it("replaces an unhealthy pooled in-memory handle", () => {
    const first = getLcmConnection(":memory:");
    first.close();

    const replacement = getLcmConnection(":memory:");
    expect(replacement === first).toBe(false);
    expect(replacement.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("closes an in-memory handle when SQLite initialization fails", () => {
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA journal_mode = WAL") {
        throw new Error("injected memory initialization failure");
      }
      return originalExec.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    try {
      expect(() => getLcmConnection(":memory:")).toThrow(
        "injected memory initialization failure",
      );
      expect(close).toHaveBeenCalledOnce();
      expect(isLcmConnectionOpen(":memory:")).toBe(false);
    } finally {
      exec.mockRestore();
      close.mockRestore();
    }
  });

  it("surfaces a parent close failure for an absent existing-only database", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-parent-existing-close-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "missing.sqlite");

    expect(() => getExistingLcmConnection(dbPath, {
      _databaseParentForTesting: {
        close: (fd) => {
          closeSync(fd);
          throw new Error("injected absent-parent close failure");
        },
      },
    })).toThrow("injected absent-parent close failure");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
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

  it("returns null when an existing-only path disappears during initialization", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-existing-disappearing-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "disappearing.sqlite");
    new DatabaseSync(dbPath).close();
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
      expect(getExistingLcmConnection(dbPath)).toBeNull();
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

  it("invalidates only the expected pooled generation and ignores stale releases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-invalidate-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");
    const first = getLcmConnection(dbPath);
    const shared = getLcmConnection(dbPath);
    const unrelated = new DatabaseSync(":memory:");

    expect(invalidateLcmConnection(join(tempDir, "missing.sqlite"), first)).toBe(false);
    expect(invalidateLcmConnection(dbPath, unrelated)).toBe(false);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 2 }]);
    unrelated.close();

    expect(invalidateLcmConnection(dbPath, first)).toBe(true);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(() => first.prepare("SELECT 1")).toThrow();
    expect(() => shared.prepare("SELECT 1")).toThrow();
    expect(invalidateLcmConnection(dbPath, first)).toBe(false);

    const replacement = getLcmConnection(dbPath);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    closeLcmConnection(dbPath, first);
    closeLcmConnection(dbPath, shared);
    expect(getPoolStats().connections).toMatchObject([{ path: dbPath, refs: 1 }]);
    expect(replacement.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    closeLcmConnection(dbPath, replacement);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
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
