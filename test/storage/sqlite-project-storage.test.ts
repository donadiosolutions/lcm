import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import * as publication from "../../src/storage/backend-publication.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";

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
  vi.restoreAllMocks();
});

describe("SQLite factory maintenance admission", () => {
  function fixture() {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-factory-maintenance-"));
    const projectId = "a".repeat(64);
    const projectDirectory = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const dbPath = join(projectDirectory, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    db.close();
    chmodSync(dbPath, 0o644);
    const factory = new SqliteStorageBackendFactory({ resolveProject: () => ({ id: projectId, dbPath }) });
    const unexpected = async (): Promise<never> => { throw new Error("unexpected v2 driver"); };
    const coordinator = new publication.BackendPublicationCoordinator({ homeDir, driver: {
      observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
      restoreConfig: unexpected, restoreProjectMap: unexpected,
    } });
    const hold = () => coordinator.enterMaintenance({
      publicationId: "factory-maintenance", generationId: "factory-generation",
      sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
        queueCutoff: null, evidenceSha256: "c".repeat(64) }],
    });
    return { homeDir, dbPath, factory, hold, identity: { id: projectId, canonical: homeDir } };
  }

  it("uses current operation admission without reviving the expired opening token", async () => {
    const context = fixture();
    try {
      const project = await publication.withBackendPublicationConsumerLockAsync(context.homeDir,
        token => context.factory.openProject(context.identity, token)) as SqliteProjectStorage;
      await expect(project.conversations.getOrCreateConversation("expired-opening")).rejects.toThrow();
      expect(await context.factory.health()).toMatchObject({ status: "healthy" });
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        await project.withPublicationAdmission(token, async () => {
          const conversation = await project.conversations.getOrCreateConversation("fresh-operation");
          await project.transaction(async repositories => {
            expect(await repositories.conversations.getMessageCount(conversation.conversationId)).toBe(0);
          });
          expect(await project.health()).toMatchObject({ status: "healthy" });
        });
        // Leaving the operation restores the original, now-expired admission.
        await expect(project.conversations.getOrCreateConversation("outside-scope")).rejects.toThrow();
      });
      await expect(project.conversations.getOrCreateConversation("after-release")).rejects.toThrow();
      await context.hold();
      const bytes = readFileSync(context.dbPath);
      expect(await context.factory.health()).toMatchObject({ status: "unavailable" });
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        expect(() => project.withPublicationAdmission(token,
          () => project.conversations.getOrCreateConversation("held"))).toThrow();
      }, { allowUnresolved: true });
      expect(readFileSync(context.dbPath)).toEqual(bytes);
      await project.close();
    } finally { await context.factory.close(); rmSync(context.homeDir, { recursive: true, force: true }); }
  });

  it("keeps current admission local to one handle and rejects detached work after release", async () => {
    const context = fixture();
    const resume = deferred();
    let detached: Promise<unknown> | undefined;
    try {
      const [project, sibling] = await publication.withBackendPublicationConsumerLockAsync(context.homeDir,
        async token => [
          await context.factory.openProject(context.identity, token) as SqliteProjectStorage,
          await context.factory.openProject(context.identity, token),
        ] as const);
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, token =>
        project.withPublicationAdmission(token, async () => {
          await project.conversations.getOrCreateConversation("admitted-handle");
          await expect(sibling.conversations.getOrCreateConversation("unscoped-handle")).rejects.toThrow();
          detached = resume.promise.then(() => project.conversations.getOrCreateConversation("detached"));
        }));
      const refused = expect(detached).rejects.toThrow();
      resume.resolve();
      await refused;
      await project.close();
      await sibling.close();
    } finally {
      resume.resolve();
      await detached?.catch(() => undefined);
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("rejects wrong-home and revoked operation tokens before using a retained project", async () => {
    const context = fixture();
    const other = fixture();
    try {
      const project = await context.factory.openProject(context.identity) as SqliteProjectStorage;
      const callback = vi.fn(async () => undefined);
      const revoked = await publication.withBackendPublicationConsumerLockAsync(context.homeDir, token => token);
      expect(() => project.withPublicationAdmission(revoked, callback)).toThrow();
      await publication.withBackendPublicationConsumerLockAsync(other.homeDir, token => {
        expect(() => project.withPublicationAdmission(token, callback)).toThrow();
      });
      expect(callback).not.toHaveBeenCalled();
      await project.close();
    } finally {
      await context.factory.close(); await other.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
      rmSync(other.homeDir, { recursive: true, force: true });
    }
  });

  it("fences a retained native transcript writer after maintenance entry", async () => {
    const context = fixture();
    try {
      const project = await context.factory.openProject(context.identity);
      const repository = project.nativeTranscripts!.repository;
      const key = { machineId: "local", clientName: "codex", sourceLocator: "sessions/test.jsonl" };
      expect(await repository.getCheckpoint(key)).toBeNull();
      await context.hold();
      const bytes = readFileSync(context.dbPath);
      await expect(repository.ingestBatch({ ...key, expectedCheckpoint: null, records: [], quarantinedCount: 0,
        checkpoint: { lastSourceOrdinal: 0, checkpoint: {} } })).rejects.toThrow();
      expect(readFileSync(context.dbPath)).toEqual(bytes);
      await project.close();
    } finally { await context.factory.close(); rmSync(context.homeDir, { recursive: true, force: true }); }
  });
  it.each(["openProject", "openExistingProject"] as const)("fences %s before SQLite initialization changes the source", async (operation) => {
    const context = fixture();
    try {
      const bytes = readFileSync(context.dbPath);
      const mode = statSync(context.dbPath).mode;
      await context.hold();
      await expect(context.factory[operation](context.identity)).rejects.toThrow();
      expect(readFileSync(context.dbPath)).toEqual(bytes);
      expect(statSync(context.dbPath).mode).toBe(mode);
      expect(existsSync(`${context.dbPath}-wal`)).toBe(false);
      expect(existsSync(`${context.dbPath}-shm`)).toBe(false);
    } finally {
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("refuses epoch adoption when maintenance enters after factory migrations", async () => {
    const context = fixture();
    recoverMachineIdentity({ version: 1, identityKey: `machine:${"d".repeat(64)}`,
      machineId: "018f0b5d-1234-7abc-8def-1234567890ab", displayName: "Factory test" },
    { homeDir: context.homeDir });
    const originalBarrier = publication.withBackendPublicationAppendBarrierAsync;
    vi.spyOn(publication, "withBackendPublicationAppendBarrierAsync").mockImplementationOnce(async (...args) => {
      await context.hold();
      return originalBarrier(...args);
    });
    try {
      const opened = await context.factory.openProject(context.identity).then(() => true, () => false);
      expect(opened).toBe(false);
      const source = new DatabaseSync(context.dbPath, { readOnly: true });
      expect(source.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'migration_receipt_v1_%'").all()).toEqual([]);
      source.close();
      expect(existsSync(join(context.homeDir, ".lcm", "events", ".machine-sequence.sqlite"))).toBe(false);
    } finally {
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("fences an idle factory health probe before opening SQLite", async () => {
    const context = fixture();
    try {
      const project = await context.factory.openProject(context.identity);
      await project.close();
      expect(await context.factory.health()).toMatchObject({ status: "healthy" });
      const reset = new DatabaseSync(context.dbPath);
      reset.exec("PRAGMA journal_mode = DELETE");
      reset.close();
      chmodSync(context.dbPath, 0o644);
      const bytes = readFileSync(context.dbPath);
      const mode = statSync(context.dbPath).mode;
      await context.hold();
      expect(await context.factory.health()).toMatchObject({ status: "unavailable" });
      expect(readFileSync(context.dbPath)).toEqual(bytes);
      expect(statSync(context.dbPath).mode).toBe(mode);
      expect(existsSync(`${context.dbPath}-wal`)).toBe(false);
      expect(existsSync(`${context.dbPath}-shm`)).toBe(false);
    } finally {
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("opens an existing admitted source and never recreates a missing source on lookup or health", async () => {
    const context = fixture();
    try {
      const existing = await context.factory.openExistingProject(context.identity);
      expect(existing).not.toBeNull();
      await existing!.close();
      rmSync(context.dbPath);
      expect(await context.factory.openExistingProject(context.identity)).toBeNull();
      expect(await context.factory.health()).toMatchObject({ status: "unavailable" });
      expect(existsSync(context.dbPath)).toBe(false);
    } finally {
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });
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
