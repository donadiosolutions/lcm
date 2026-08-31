import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeLcmConnection,
  getLcmConnection,
  invalidateLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";
import { getLcmDbFeatures } from "../../src/db/features.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { sqliteStorageCapabilities } from "../../src/storage/capabilities.js";
import { SqliteProjectStorage } from "../../src/storage/sqlite/project-storage.js";
import { sqliteExecutorFor } from "../../src/storage/sqlite/executor.js";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type Fixture = {
  directory: string;
  dbPath: string;
  db: DatabaseSync;
  storage: SqliteProjectStorage;
  events: string[];
};

function createFixture(onClose?: (storage: SqliteProjectStorage) => void): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "lcm-sqlite-project-health-"));
  const dbPath = join(directory, "project.db");
  const db = getLcmConnection(dbPath);
  const features = getLcmDbFeatures(db);
  runLcmMigrations(db, features);
  const events: string[] = [];
  const projectId = "sqlite-health-project";
  const executor = sqliteExecutorFor(db, projectId, () => {
    events.push("poison");
    const evicted = invalidateLcmConnection(dbPath, db);
    if (evicted) events.push("eviction");
  });
  const storage = new SqliteProjectStorage(
    projectId,
    dbPath,
    db,
    executor,
    sqliteStorageCapabilities(features.fts5Available),
    (closed) => {
      events.push("onClose");
      onClose?.(closed);
    },
  );
  return { directory, dbPath, db, storage, events };
}

function cleanupFixture(fixture: Fixture): void {
  closeLcmConnection(fixture.dbPath, fixture.db);
  rmSync(fixture.directory, { recursive: true, force: true });
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

afterEach(() => {
  closeLcmConnection();
});

describe("SqliteProjectStorage project health lifecycle", () => {
  it("returns the exact healthy result before close", async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.storage.health()).resolves.toEqual({
        status: "healthy",
        backend: "sqlite",
        projectId: "sqlite-health-project",
      });
      await fixture.storage.close();
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fences a deferred healthy probe behind concurrent close", async () => {
    const fixture = createFixture();
    const transactionEntered = deferred();
    const transactionHold = deferred();
    let quickChecks = 0;
    let transaction: Promise<unknown> | undefined;
    let health: Promise<unknown> | undefined;
    let close: Promise<void> | undefined;
    let restorePrepare: (() => void) | undefined;
    try {
      transaction = fixture.storage.transaction(async () => {
        transactionEntered.resolve();
        await transactionHold.promise;
        fixture.events.push("transaction-complete");
      });
      await transactionEntered.promise;

      const originalPrepare = fixture.db.prepare;
      const prepareSpy = vi.spyOn(fixture.db as unknown as { prepare: typeof fixture.db.prepare }, "prepare");
      prepareSpy.mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.trim() === "PRAGMA quick_check(1)") {
          quickChecks += 1;
          fixture.events.push("probe");
        }
        return originalPrepare.call(this, sql);
      });
      restorePrepare = () => prepareSpy.mockRestore();

      health = fixture.storage.health();
      close = fixture.storage.close();
      expect(fixture.storage.close()).toBe(close);
      expect(fixture.events).not.toContain("probe");
      expect(fixture.events).not.toContain("onClose");
      expect(quickChecks).toBe(0);
      await expectPending(close);

      transactionHold.resolve();
      await transaction;
      const [healthResult] = await Promise.all([health, close]);
      expect(healthResult).toEqual({
        status: "closed",
        backend: "sqlite",
        projectId: "sqlite-health-project",
      });
      expect(quickChecks).toBe(1);
      expect(fixture.events.indexOf("transaction-complete")).toBeLessThan(
        fixture.events.indexOf("probe"),
      );
      expect(fixture.events.indexOf("probe")).toBeLessThan(fixture.events.indexOf("onClose"));
      expect(fixture.events.filter((event) => event === "onClose")).toHaveLength(1);
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    } finally {
      transactionHold.resolve();
      await Promise.allSettled([transaction, health, close]);
      restorePrepare?.();
      cleanupFixture(fixture);
    }
  });

  it("fences a deferred unavailable probe and sanitizes rollback failure details", async () => {
    const fixture = createFixture();
    const transactionEntered = deferred();
    const transactionHold = deferred();
    const privateSentinel = "sqlite-private-rollback-sentinel";
    let quickChecks = 0;
    let transaction: Promise<unknown> | undefined;
    let health: Promise<unknown> | undefined;
    let close: Promise<void> | undefined;
    let restorePrepare: (() => void) | undefined;
    let restoreExec: (() => void) | undefined;
    try {
      transaction = fixture.storage.transaction(async () => {
        transactionEntered.resolve();
        await transactionHold.promise;
        fixture.events.push("transaction-complete");
      });
      await transactionEntered.promise;

      const originalPrepare = fixture.db.prepare;
      const prepareSpy = vi.spyOn(fixture.db as unknown as { prepare: typeof fixture.db.prepare }, "prepare");
      prepareSpy.mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.trim() === "PRAGMA quick_check(1)") {
          quickChecks += 1;
          fixture.events.push("probe");
        }
        return originalPrepare.call(this, sql);
      });
      restorePrepare = () => prepareSpy.mockRestore();

      const originalExec = fixture.db.exec;
      let failRollback = true;
      const execSpy = vi.spyOn(fixture.db as unknown as { exec: typeof fixture.db.exec }, "exec");
      execSpy.mockImplementation(function (this: DatabaseSync, sql: string) {
        if (failRollback && sql === "ROLLBACK") {
          failRollback = false;
          originalExec.call(this, sql);
          fixture.events.push("rollback");
          throw new Error(privateSentinel);
        }
        return originalExec.call(this, sql);
      });
      restoreExec = () => execSpy.mockRestore();

      health = fixture.storage.health();
      close = fixture.storage.close();
      expect(fixture.events).not.toContain("probe");
      expect(fixture.events).not.toContain("onClose");
      expect(quickChecks).toBe(0);
      await expectPending(close);

      transactionHold.resolve();
      await transaction;
      const [healthResult] = await Promise.all([health, close]);
      expect(healthResult).toEqual({
        status: "closed",
        backend: "sqlite",
        projectId: "sqlite-health-project",
      });
      expect(quickChecks).toBe(1);
      expect(JSON.stringify(healthResult)).not.toContain(privateSentinel);
      expect(fixture.events.indexOf("transaction-complete")).toBeLessThan(
        fixture.events.indexOf("probe"),
      );
      expect(fixture.events.indexOf("probe")).toBeLessThan(fixture.events.indexOf("poison"));
      expect(fixture.events.indexOf("poison")).toBeLessThan(fixture.events.indexOf("eviction"));
      expect(fixture.events.indexOf("eviction")).toBeLessThan(fixture.events.indexOf("onClose"));
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    } finally {
      transactionHold.resolve();
      await Promise.allSettled([transaction, health, close]);
      restoreExec?.();
      restorePrepare?.();
      cleanupFixture(fixture);
    }
  });

  it("recovers after a failed close and permits a successful retry", async () => {
    const privateSentinel = "sqlite-private-close-sentinel";
    let closeCalls = 0;
    const fixture = createFixture(() => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error(privateSentinel);
    });
    try {
      const firstClose = fixture.storage.close();
      const duplicateClose = fixture.storage.close();
      expect(duplicateClose).toBe(firstClose);
      const firstError = await firstClose.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toBe(privateSentinel);
      const unavailable = await fixture.storage.health();
      expect(unavailable.status).toBe("unavailable");
      expect(unavailable.status).not.toBe("closed");
      expect(JSON.stringify(unavailable)).not.toContain(privateSentinel);
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);

      const retryClose = fixture.storage.close();
      const duplicateRetry = fixture.storage.close();
      expect(retryClose).not.toBe(firstClose);
      expect(duplicateRetry).toBe(retryClose);
      await expect(retryClose).resolves.toBeUndefined();
      expect(closeCalls).toBe(2);
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
