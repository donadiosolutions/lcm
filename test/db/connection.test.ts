import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  getLcmConnection,
  getExistingLcmConnection,
  invalidateLcmConnection,
  isLcmConnectionOpen,
  inspectExistingLcmDatabasePath,
  closeLcmConnection,
  getPoolStats,
  withLcmConnectionLock,
  withYieldingLcmConnectionLock,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];

function makeTempDbPath(prefix: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  return join(tempDir, "test.sqlite");
}

afterEach(() => {
  // Close all connections and clean up
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getPoolStats", () => {
  it("returns empty pool when no connections are open", () => {
    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(0);
    expect(stats.activeConnections).toBe(0);
    expect(stats.idleConnections).toBe(0);
    expect(stats.connections).toHaveLength(0);
  });

  it("reports an active connection when refs > 0", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);
    expect(stats.idleConnections).toBe(0);
    expect(stats.connections[0].path).toBe(dbPath);
    expect(stats.connections[0].refs).toBe(1);
    expect(stats.connections[0].status).toBe("active");
  });

  it("increments refs for repeated opens of the same path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);
    getLcmConnection(dbPath);

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(1);
    expect(stats.activeConnections).toBe(1);
    expect(stats.connections[0].refs).toBe(2);
  });

  it("tracks multiple distinct connections", () => {
    const tempDir1 = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    const tempDir2 = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir1, tempDir2);

    getLcmConnection(join(tempDir1, "db.sqlite"));
    getLcmConnection(join(tempDir2, "db.sqlite"));

    const stats = getPoolStats();
    expect(stats.totalConnections).toBe(2);
    expect(stats.activeConnections).toBe(2);
    expect(stats.idleConnections).toBe(0);
  });

  it("reduces refs after close and marks idle at refs=0", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.sqlite");

    getLcmConnection(dbPath);
    getLcmConnection(dbPath); // refs = 2

    closeLcmConnection(dbPath); // refs = 1

    const stats = getPoolStats();
    // refs=1 still means active
    expect(stats.connections[0].refs).toBe(1);
    expect(stats.connections[0].status).toBe("active");

    closeLcmConnection(dbPath); // refs = 0 → removed from pool

    const stats2 = getPoolStats();
    expect(stats2.totalConnections).toBe(0);
  });

  it("returns correct shape with all required fields", () => {
    const stats = getPoolStats();
    expect(stats).toHaveProperty("totalConnections");
    expect(stats).toHaveProperty("activeConnections");
    expect(stats).toHaveProperty("idleConnections");
    expect(stats).toHaveProperty("connections");
    expect(Array.isArray(stats.connections)).toBe(true);
  });
});

describe("withLcmConnectionLock", () => {
  it("serializes the same database while allowing another database to proceed", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withLcmConnectionLock("one", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withLcmConnectionLock("one", () => { order.push("second"); });
    await withLcmConnectionLock("two", () => { order.push("other"); });
    expect(order).toEqual(["first-start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("lets queued database work proceed while a slow operation is yielded", async () => {
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const first = withYieldingLcmConnectionLock("one", async (lock) => {
      order.push("first-db");
      await lock.yieldWhile(async () => {
        order.push("slow-start");
        await slowGate;
        order.push("slow-end");
      });
      order.push("first-resumed");
    });
    await Promise.resolve();
    const queued = withLcmConnectionLock("one", () => { order.push("queued-db"); });
    await queued;
    expect(order).toEqual(["first-db", "slow-start", "queued-db"]);
    releaseSlow();
    await first;
    expect(order).toEqual(["first-db", "slow-start", "queued-db", "slow-end", "first-resumed"]);
  });

  it("reacquires the database lock before propagating a yielded failure", async () => {
    const failure = new Error("summarizer failed");
    const order: string[] = [];
    const first = withYieldingLcmConnectionLock("one", async (lock) => {
      await lock.yieldWhile(async () => { throw failure; });
    });
    const queued = withLcmConnectionLock("one", () => { order.push("queued"); });
    await expect(first).rejects.toBe(failure);
    await queued;
    await withLcmConnectionLock("one", () => { order.push("after"); });
    expect(order).toEqual(["queued", "after"]);
  });
});

describe("in-memory connection pooling", () => {
  it("reuses a healthy pooled in-memory connection and increments refs", () => {
    const first = getLcmConnection(":memory:");
    const second = getLcmConnection(":memory:");
    expect(second).toBe(first);
    expect(isLcmConnectionOpen(":memory:")).toBe(true);
    expect(getPoolStats().connections.find((entry) => entry.path === ":memory:")?.refs).toBe(2);
    expect(() => first.exec("CREATE TABLE probe(value TEXT)")).not.toThrow();
  });


  it("surfaces a PRAGMA setup failure for a fresh in-memory connection and does not pool it", () => {
    const failure = new Error("injected in-memory PRAGMA failure");
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => getLcmConnection(":memory:")).toThrow(failure);
    } finally {
      spy.mockRestore();
    }
    expect(isLcmConnectionOpen(":memory:")).toBe(false);
  });
});

describe("openLcmConnection parent and pool admission edge cases", () => {
  it("returns null for an existing-only open when the parent directory itself is missing", () => {
    const missingParentDbPath = join(
      tmpdir(),
      `lcm-conn-missing-parent-${process.pid}-${Date.now()}`,
      "test.sqlite",
    );
    expect(getExistingLcmConnection(missingParentDbPath)).toBeNull();
  });

  it("returns null for an existing-only open on a leaf that does not exist yet", () => {
    const dbPath = makeTempDbPath("lcm-conn-missing-leaf-");
    expect(getExistingLcmConnection(dbPath)).toBeNull();
  });

  it("rethrows a parent close failure instead of a clean null result when the leaf is missing", () => {
    const dbPath = makeTempDbPath("lcm-conn-missing-leaf-close-failure-");
    const boom = new Error("injected parent close failure");
    expect(() => getExistingLcmConnection(dbPath, {
      _databaseParentForTesting: { close: () => { throw boom; } },
    })).toThrow(boom);
  });

  it("swallows a parent close failure once a read-only preflight mismatch already primary-errored", () => {
    const dbPath = makeTempDbPath("lcm-conn-preflight-mismatch-close-failure-");
    new DatabaseSync(dbPath).close();
    const boom = new Error("injected parent close failure that must be swallowed");
    expect(() => getExistingLcmConnection(dbPath, {
      expectedFileIdentity: { device: 999_999, inode: 999_999 },
      _databaseParentForTesting: { close: () => { throw boom; } },
    })).toThrow("database path changed after read-only preflight");
  });

  it("accepts a matching expectedFileIdentity preflight and proceeds normally", () => {
    const dbPath = makeTempDbPath("lcm-conn-preflight-match-");
    getLcmConnection(dbPath);
    closeLcmConnection(dbPath);
    const identity = inspectExistingLcmDatabasePath(dbPath);
    expect(identity).not.toBeNull();
    const reopened = getExistingLcmConnection(dbPath, { expectedFileIdentity: identity! });
    expect(reopened).not.toBeNull();
  });


  it("throws for a create-capable open when a pooled connection's file identity no longer matches", () => {
    const dbPath = makeTempDbPath("lcm-conn-pool-rotation-create-");
    getLcmConnection(dbPath);
    rmSync(dbPath);
    new DatabaseSync(dbPath).close();
    expect(() => getLcmConnection(dbPath)).toThrow(
      "pooled database path no longer matches the requested file",
    );
  });

  it("returns null for an existing-only open when a pooled connection's file identity no longer matches", () => {
    const dbPath = makeTempDbPath("lcm-conn-pool-rotation-existing-");
    getLcmConnection(dbPath);
    rmSync(dbPath);
    new DatabaseSync(dbPath).close();
    expect(getExistingLcmConnection(dbPath)).toBeNull();
  });


  it("rejects a leaf removed after PRAGMA initialization completes, before finalizing the connection", () => {
    const dbPath = makeTempDbPath("lcm-conn-post-pragma-missing-");
    new DatabaseSync(dbPath).close();
    const originalExec = DatabaseSync.prototype.exec;
    let execCount = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      execCount += 1;
      if (execCount === 3) rmSync(dbPath);
      return result;
    });
    try {
      expect(() => getLcmConnection(dbPath)).toThrow("database path disappeared while opening");
    } finally {
      spy.mockRestore();
    }
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("rejects a leaf swapped to a different inode after PRAGMA initialization completes", () => {
    const dbPath = makeTempDbPath("lcm-conn-post-pragma-swapped-");
    new DatabaseSync(dbPath).close();
    const originalExec = DatabaseSync.prototype.exec;
    let execCount = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      execCount += 1;
      if (execCount === 3) {
        rmSync(dbPath);
        new DatabaseSync(dbPath).close();
      }
      return result;
    });
    try {
      expect(() => getLcmConnection(dbPath)).toThrow("database path changed while opening");
    } finally {
      spy.mockRestore();
    }
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });
});

describe("invalidateLcmConnection", () => {
  it("returns false when no pooled connection exists for the path", () => {
    const decoy = new DatabaseSync(":memory:");
    try {
      expect(invalidateLcmConnection("/no/such/path.sqlite", decoy)).toBe(false);
    } finally {
      decoy.close();
    }
  });

  it("returns false when the expected handle no longer matches the pooled connection", () => {
    const dbPath = makeTempDbPath("lcm-conn-invalidate-mismatch-");
    getLcmConnection(dbPath);
    const decoy = new DatabaseSync(":memory:");
    try {
      expect(invalidateLcmConnection(dbPath, decoy)).toBe(false);
      expect(isLcmConnectionOpen(dbPath)).toBe(true);
    } finally {
      decoy.close();
    }
  });

  it("evicts and force-closes the pooled connection when the handle matches", () => {
    const dbPath = makeTempDbPath("lcm-conn-invalidate-match-");
    const db = getLcmConnection(dbPath);
    expect(invalidateLcmConnection(dbPath, db)).toBe(true);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(() => db.prepare("SELECT 1").get()).toThrow();
  });
});

describe("closeLcmConnection direct edge cases", () => {
  it("is a no-op for a path with no pooled connection", () => {
    expect(() => closeLcmConnection("/no/such/path.sqlite")).not.toThrow();
  });

  it("ignores a mismatched expectedDb without decrementing refs", () => {
    const dbPath = makeTempDbPath("lcm-conn-close-mismatch-");
    getLcmConnection(dbPath);
    getLcmConnection(dbPath); // refs = 2
    const decoy = new DatabaseSync(":memory:");
    try {
      closeLcmConnection(dbPath, decoy);
      expect(getPoolStats().connections.find((entry) => entry.path === dbPath)?.refs).toBe(2);
    } finally {
      decoy.close();
    }
  });
});
