import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeLcmConnection,
  getLcmConnection,
  getPoolStats,
  invalidateLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";
import { getLcmDbFeatures } from "../../src/db/features.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { sqliteStorageCapabilities } from "../../src/storage/capabilities.js";
import { SqliteProjectStorage } from "../../src/storage/sqlite/project-storage.js";
import { sqliteExecutorFor, type SqliteOperationAdmission } from "../../src/storage/sqlite/executor.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import * as publication from "../../src/storage/backend-publication.js";
import {
  createMachineIdentity,
  ensurePendingMachineIdentity,
  readMachineIdentity,
  recoverMachineIdentity,
} from "../../src/machine-identity.js";
import { getMigrationReceiptEpoch } from "../../src/migration/receipts.js";
import * as identityApi from "../../src/machine-identity.js";
import { LocalHookEventSequenceAllocator } from "../../src/storage/local-hook-event-sequence.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

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

  it("requires exact live authority for the internal enrollment identity", async () => {
    const context = fixture();
    const other = fixture();
    const pending = ensurePendingMachineIdentity("Enrollment", context.homeDir).identity;
    const intended = createMachineIdentity(
      pending,
      "018f0b5d-1234-7abc-8def-1234567890ab",
      "Enrollment",
    );
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      _migrationEnrollmentIdentity: intended,
    });
    const invalidFactory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      _migrationEnrollmentIdentity: {
        ...intended,
        displayName: ` ${intended.displayName} `,
      },
    });
    try {
      await expect(factory.openProject(context.identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
      const revoked = await publication.withBackendPublicationConsumerLockAsync(
        context.homeDir,
        token => token,
      );
      await expect(factory.openProject(context.identity, revoked)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
      await publication.withBackendPublicationConsumerLockAsync(other.homeDir, async token => {
        await expect(factory.openProject(context.identity, token)).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
        });
      });
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        await expect(invalidFactory.openProject(context.identity, token)).rejects.toMatchObject({
          code: "STORAGE_INITIALIZATION_FAILED",
        });
      });
      expect(readMachineIdentity(context.homeDir)?.machineId).toBeNull();
    } finally {
      await factory.close();
      await invalidFactory.close();
      await context.factory.close();
      await other.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
      rmSync(other.homeDir, { recursive: true, force: true });
    }
  });

  it.each(["preparation", "adoption"])("refuses machine replacement before epoch %s", async phase => {
    const context = fixture();
    const machine = {
      version: 1 as const, identityKey: `machine:${"d".repeat(64)}`,
      machineId: "018f0b5d-1234-7abc-8def-1234567890ab", displayName: "Factory test",
    };
    recoverMachineIdentity(machine, { homeDir: context.homeDir });
    const replace = () => recoverMachineIdentity({ ...machine,
      machineId: "118f0b5d-1234-7abc-8def-1234567890ab",
    }, { homeDir: context.homeDir, force: true });
    if (phase === "preparation") {
      const original = identityApi.readMachineIdentity;
      vi.spyOn(identityApi, "readMachineIdentity").mockImplementationOnce(home => {
        const observed = original(home);
        replace();
        return observed;
      });
    } else {
      const original = LocalHookEventSequenceAllocator.prototype.peekNextSequence;
      vi.spyOn(LocalHookEventSequenceAllocator.prototype, "peekNextSequence").mockImplementationOnce(function () {
        const next = original.call(this);
        replace();
        return next;
      });
    }
    try {
      await expect(context.factory.openProject(context.identity)).rejects.toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
      });
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
      const source = new DatabaseSync(context.dbPath);
      try {
        expect(getMigrationReceiptEpoch(source, context.identity.id, machine.machineId)).toBeNull();
      } finally { source.close(); }
    } finally {
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it.each(["version", "machineId"])("rejects an enrollment identity whose normalized %s differs", async field => {
    const context = fixture();
    const pending = ensurePendingMachineIdentity("Enrollment", context.homeDir).identity;
    const intended = createMachineIdentity(pending, "018f0b5d-1234-7abc-8def-1234567890ab", "Enrollment");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      _migrationEnrollmentIdentity: field === "version"
        ? { ...intended, version: 2 as 1 }
        : { ...intended, machineId: intended.machineId.toUpperCase() },
    });
    try {
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        await expect(factory.openProject(context.identity, token)).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      });
      expect(readMachineIdentity(context.homeDir)?.machineId).toBeNull();
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      await factory.close();
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("aggregates independent project release failures and retries all owners", async () => {
    const context = fixture();
    const first = await context.factory.openProject(context.identity);
    const second = await context.factory.openProject(context.identity);
    const firstError = new Error("first physical owner failed");
    const secondError = new Error("second physical owner failed");
    const firstClose = vi.spyOn(first, "close").mockRejectedValueOnce(firstError);
    const secondClose = vi.spyOn(second, "close").mockRejectedValueOnce(secondError);
    try {
      const error = await context.factory.close().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([firstError, secondError]);
      expect(getPoolStats().connections.find(connection => connection.path === context.dbPath)?.refs).toBe(2);
      await context.factory.close();
      expect(firstClose).toHaveBeenCalledTimes(2);
      expect(secondClose).toHaveBeenCalledTimes(2);
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      firstClose.mockRestore(); secondClose.mockRestore();
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "key", "machine"])("refuses intended enrollment against a %s machine authority", async change => {
    const context = fixture();
    const pending = ensurePendingMachineIdentity("Enrollment", context.homeDir).identity;
    const intended = createMachineIdentity(pending, "018f0b5d-1234-7abc-8def-1234567890ab", "Enrollment");
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      _migrationEnrollmentIdentity: intended,
    });
    if (change === "missing") rmSync(join(context.homeDir, ".lcm", "machine.json"));
    else recoverMachineIdentity({ ...intended,
      ...(change === "key" ? { identityKey: `machine:${"e".repeat(64)}` }
        : { machineId: "118f0b5d-1234-7abc-8def-1234567890ab" }),
    }, { homeDir: context.homeDir, force: true });
    try {
      await publication.withBackendPublicationConsumerLockAsync(context.homeDir, async token => {
        await expect(factory.openProject(context.identity, token)).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      });
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      await factory.close(); await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("does not retain a raw owner after physical release commits but lock cleanup fails", async () => {
    const context = fixture();
    let releases = 0;
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      detectFeatures: () => { throw new Error("feature detection failed"); },
      _appendBarrierOptions: {
        _appendLockObserver: event => {
          if (event === "before-main-lock-release-read") {
            releases += 1;
            throw new Error("postcommit cleanup failed");
          }
        },
      },
    });
    try {
      await expect(factory.openProject(context.identity)).rejects.toMatchObject({ code: "STORAGE_INITIALIZATION_FAILED" });
      expect(releases).toBe(1);
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
      await factory.close();
      expect(releases).toBe(1);
    } finally {
      await factory.close(); await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("uses current operation admission for project close", async () => {
    const context = fixture();
    let closePromise: Promise<void> | undefined;
    try {
      const project = await context.factory.openProject(context.identity) as SqliteProjectStorage;
      const outcome = await publication.withBackendPublicationConsumerLockAsync(
        context.homeDir,
        token => project.withPublicationAdmission(token, async () => {
          closePromise = project.close();
          return Promise.race([
            closePromise.then(() => "closed" as const, () => "rejected" as const),
            new Promise<"timed-out">(resolve => setTimeout(() => resolve("timed-out"), 5)),
          ]);
        }),
      );
      await closePromise;
      expect(outcome).toBe("closed");
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
      expect(await project.health()).toMatchObject({ status: "closed" });
    } finally {
      await closePromise?.catch(() => undefined);
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it("preserves an open failure while retaining raw cleanup for factory retry", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-raw-open-cleanup-"));
    const projectId = "e".repeat(64);
    const projectDirectory = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const dbPath = join(projectDirectory, "db.sqlite");
    let now = 0;
    let refuseCleanup = true;
    const FactoryWithCleanupSeam = SqliteStorageBackendFactory as unknown as new (
      options: Readonly<{
        resolveProject: () => { id: string; dbPath: string };
        detectFeatures: () => never;
        _appendBarrierOptions: Readonly<{
          contentionWaitMs: number;
          retryDelayMs: number;
          _now: () => number;
          _wait: (milliseconds: number) => Promise<void>;
          _appendLockObserver: (event: string) => void;
        }>;
      }>,
    ) => SqliteStorageBackendFactory;
    const factory = new FactoryWithCleanupSeam({
      resolveProject: () => ({ id: projectId, dbPath }),
      detectFeatures: () => { throw new Error("primary feature detection failed"); },
      _appendBarrierOptions: {
        contentionWaitMs: 1,
        retryDelayMs: 1,
        _now: () => now,
        _wait: async milliseconds => { now += milliseconds; },
        _appendLockObserver: (event) => {
          if (refuseCleanup && event === "before-main-lock-publish") {
            refuseCleanup = false;
            throw new PrivateMutationLockContentionError("raw cleanup busy");
          }
        },
      },
    });
    try {
      const error = await factory.openProject({ id: projectId, canonical: homeDir })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "STORAGE_INITIALIZATION_FAILED",
        operation: "openProject",
      });
      expect(JSON.stringify(error)).not.toContain("raw cleanup busy");
      expect(getPoolStats().connections.find(connection => connection.path === dbPath)?.refs)
        .toBe(1);

      await expect(factory.close()).resolves.toBeUndefined();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      await factory.close().catch(() => undefined);
      closeLcmConnection(dbPath);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([1, 2])("retains %s failed raw owners across concurrent reopen cleanup attempts", async count => {
    const context = fixture();
    let refuse = true;
    const factory = new SqliteStorageBackendFactory({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      detectFeatures: () => { throw new Error("migration setup failure"); },
      _appendBarrierOptions: {
        contentionWaitMs: 0,
        _appendLockObserver: event => {
          if (refuse && event === "before-main-lock-publish") {
            throw new PrivateMutationLockContentionError("raw owner still busy");
          }
        },
      },
    });
    try {
      const opens = await Promise.allSettled(Array.from({ length: count }, () => factory.openProject(context.identity)));
      expect(opens.every(outcome => outcome.status === "rejected")).toBe(true);
      expect(getPoolStats().connections.find(connection => connection.path === context.dbPath)?.refs).toBe(count);
      const reopens = await Promise.allSettled([
        factory.openProject(context.identity), factory.openProject(context.identity),
      ]);
      expect(reopens.every(outcome => outcome.status === "rejected")).toBe(true);
      expect(getPoolStats().connections.find(connection => connection.path === context.dbPath)?.refs).toBe(count);
      await expect(factory.close()).rejects.toBeDefined();
      expect(getPoolStats().connections.find(connection => connection.path === context.dbPath)?.refs).toBe(count);
      refuse = false;
      // Zero-budget close releases one owner; a queued sibling remains owned
      // until the next explicit retry.
      for (let attempt = 0; attempt < count; attempt += 1) {
        await factory.close().catch(() => undefined);
      }
      await factory.close();
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      refuse = false;
      for (let attempt = 0; attempt <= count; attempt += 1) {
        await factory.close().catch(() => undefined);
      }
      await context.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("reports idle health cleanup failure and retains the raw release (probe=%s)", async probeFails => {
    const context = fixture();
    let now = 0;
    let refuseCleanup = false;
    const FactoryWithCleanupSeam = SqliteStorageBackendFactory as unknown as new (
      options: Readonly<{
        resolveProject: () => { id: string; dbPath: string };
        _appendBarrierOptions: Readonly<{
          contentionWaitMs: number;
          retryDelayMs: number;
          _now: () => number;
          _wait: (milliseconds: number) => Promise<void>;
          _appendLockObserver: (event: string) => void;
        }>;
      }>,
    ) => SqliteStorageBackendFactory;
    const factory = new FactoryWithCleanupSeam({
      resolveProject: () => ({ id: context.identity.id, dbPath: context.dbPath }),
      _appendBarrierOptions: {
        contentionWaitMs: 1,
        retryDelayMs: 1,
        _now: () => now,
        _wait: async milliseconds => { now += milliseconds; },
        _appendLockObserver: (event) => {
          if (refuseCleanup && event === "before-main-lock-publish") {
            refuseCleanup = false;
            throw new PrivateMutationLockContentionError("idle cleanup busy");
          }
        },
      },
    });
    try {
      const project = await factory.openProject(context.identity);
      await project.close();
      refuseCleanup = true;
      const originalExec = DatabaseSync.prototype.exec;
      const probe = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
        if (probeFails && sql.startsWith('CREATE TABLE main."__lcm_storage_health_probe_')) {
          throw new Error("primary health probe failed");
        }
        return originalExec.call(this, sql);
      });

      await expect(factory.health()).resolves.toMatchObject({ status: "unavailable" });
      expect(getPoolStats().connections.find(connection => connection.path === context.dbPath)?.refs)
        .toBe(1);

      probe.mockRestore();
      await expect(factory.close()).resolves.toBeUndefined();
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      await factory.close().catch(() => undefined);
      closeLcmConnection(context.dbPath);
      rmSync(context.homeDir, { recursive: true, force: true });
    }
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

describe("SQLite factory same-home health admission", () => {
  async function fixture(homeIndexes: number[] = [0, 0]) {
    const directory = mkdtempSync(join(tmpdir(), "lcm-factory-health-queue-"));
    const entries = homeIndexes.map((homeIndex, index) => {
      const homeDir = join(directory, `home-${homeIndex}`);
      const id = (index + 1).toString(16).padStart(64, "0");
      const projectDirectory = join(homeDir, ".lcm", "projects", id);
      mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
      const dbPath = join(projectDirectory, "db.sqlite");
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      db.close();
      return { homeDir, dbPath, identity: { id, canonical: homeDir } };
    });
    const factory = new SqliteStorageBackendFactory({ resolveProject: identity => {
      const entry = entries.find(entry => entry.identity.id === identity.id)!;
      return { id: identity.id, dbPath: entry.dbPath };
    } });
    const projects: SqliteProjectStorage[] = [];
    for (const entry of entries) {
      projects.push(await publication.withBackendPublicationConsumerLockAsync(entry.homeDir,
        token => factory.openProject(entry.identity, token)) as SqliteProjectStorage);
    }
    return { directory, entries, projects, factory };
  }

  async function cleanup(context: Awaited<ReturnType<typeof fixture>>) {
    await context.factory.close();
    rmSync(context.directory, { recursive: true, force: true });
  }

  function expectNoProbeTables(dbPath: string) {
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(inspection.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '__lcm_storage_health_probe_%'",
      ).get()).toEqual({ count: 0 });
    } finally { inspection.close(); }
  }

  it.each(["retained", "idle", "mixed"] as const)(
    "keeps %s same-home projects healthy across overlapping sweeps", async state => {
      const context = await fixture(state === "mixed" ? [0, 0, 0, 0] : [0, 0]);
      try {
        if (state !== "retained") {
          for (const project of state === "idle" ? context.projects : context.projects.slice(2)) {
            await project.close();
          }
        }
        expect(await context.factory.health()).toEqual({ status: "healthy", backend: "sqlite" });
        expect(await Promise.all([context.factory.health(), context.factory.health()])).toEqual([
          { status: "healthy", backend: "sqlite" },
          { status: "healthy", backend: "sqlite" },
        ]);
        expect(await context.factory.health()).toEqual({ status: "healthy", backend: "sqlite" });
        for (const entry of context.entries) expectNoProbeTables(entry.dbPath);
      } finally { await cleanup(context); }
    },
  );

  it("lets another home finish while same-home probes wait", async () => {
    const context = await fixture([0, 0, 1]);
    const entered = deferred();
    const release = deferred();
    const otherCompleted = deferred();
    const first = context.projects[0]!;
    const next = context.projects[1]!;
    const other = context.projects[2]!;
    const originalFirst = first.healthWithFreshAdmission.bind(first);
    const originalOther = other.healthWithFreshAdmission.bind(other);
    const nextProbe = vi.spyOn(next, "healthWithFreshAdmission");
    vi.spyOn(first, "healthWithFreshAdmission").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return originalFirst();
    });
    vi.spyOn(other, "healthWithFreshAdmission").mockImplementationOnce(async () => {
      const result = await originalOther();
      expect(result.status).toBe("healthy");
      otherCompleted.resolve();
      return result;
    });
    const health = context.factory.health();
    try {
      await entered.promise;
      await otherCompleted.promise;
      expect(nextProbe).not.toHaveBeenCalled();
      await expectPending(health);
      release.resolve();
      expect(await health).toEqual({ status: "healthy", backend: "sqlite" });
      expect(nextProbe).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([health]);
      await cleanup(context);
    }
  });

  it("preserves unexpected rejection and recovers later queued sweeps", async () => {
    const context = await fixture([0]);
    const entered = deferred();
    const release = deferred();
    const failure = new Error("injected probe rejection");
    vi.spyOn(context.projects[0]!, "healthWithFreshAdmission").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    const rejected = expect(context.factory.health()).rejects.toBe(failure);
    await entered.promise;
    const recovery = context.factory.health();
    try {
      release.resolve();
      await rejected;
      expect(await recovery).toEqual({ status: "healthy", backend: "sqlite" });
      expect(await context.factory.health()).toEqual({ status: "healthy", backend: "sqlite" });
    } finally {
      release.resolve();
      await Promise.allSettled([rejected, recovery]);
      await cleanup(context);
    }
  });

  it.each(["retained", "idle"] as const)(
    "drains overlapping queued %s home probes before closing", async state => {
      const context = await fixture();
      const firstEntry = context.entries[0]!;
      const retainedDb = getLcmConnection(firstEntry.dbPath);
      if (state === "idle") for (const project of context.projects) await project.close();
      const executor = sqliteExecutorFor(retainedDb, firstEntry.identity.id, () => undefined);
      const entered = deferred();
      const release = deferred();
      const events: string[] = [];
      const transaction = executor.transaction(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const originalPrepare = DatabaseSync.prototype.prepare;
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync, sql: string,
      ) {
        if (sql === "PRAGMA quick_check(1)") events.push("probe");
        return originalPrepare.call(this, sql);
      });
      const health = context.factory.health();
      const overlapping = context.factory.health();
      // A full event-loop turn lets both snapshots enqueue without releasing the transaction.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual([]);
      const closing = context.factory.close().then(() => { events.push("closed"); });
      try {
        await expectPending(closing);
        await expectPending(health);
        await expectPending(overlapping);
        release.resolve();
        const [first, second] = await Promise.all([health, overlapping, closing, transaction]);
        expect(first).toEqual({ status: "closed", backend: "sqlite" });
        expect(second).toEqual({ status: "closed", backend: "sqlite" });
        expect(events).toEqual(["probe", "probe", "probe", "probe", "closed"]);
        expect(getPoolStats().connections.find(entry => entry.path === firstEntry.dbPath))
          .toMatchObject({ refs: 1 });
        expect(getPoolStats().connections.some(entry => entry.path === context.entries[1]!.dbPath)).toBe(false);
        closeLcmConnection(firstEntry.dbPath, retainedDb);
        expect(getPoolStats().connections.some(entry => entry.path === firstEntry.dbPath)).toBe(false);
        for (const entry of context.entries) expectNoProbeTables(entry.dbPath);
      } finally {
        release.resolve();
        await Promise.allSettled([health, overlapping, transaction, closing]);
        prepareSpy.mockRestore();
        closeLcmConnection(firstEntry.dbPath, retainedDb);
        await cleanup(context);
      }
    },
  );

  it("keeps a handle opened while its idle probe is queued usable", async () => {
    const context = await fixture();
    const firstEntry = context.entries[0]!;
    const secondEntry = context.entries[1]!;
    const retainedDb = getLcmConnection(firstEntry.dbPath);
    for (const project of context.projects) await project.close();
    const entered = deferred();
    const release = deferred();
    const executor = sqliteExecutorFor(retainedDb, firstEntry.identity.id, () => undefined);
    const transaction = executor.transaction(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const health = context.factory.health();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(getPoolStats().connections.find(entry => entry.path === firstEntry.dbPath))
        .toMatchObject({ refs: 2 });
      const active = await publication.withBackendPublicationConsumerLockAsync(secondEntry.homeDir,
        token => context.factory.openProject(secondEntry.identity, token)) as SqliteProjectStorage;
      release.resolve();
      await transaction;
      expect(await health).toEqual({ status: "healthy", backend: "sqlite" });
      expect(getPoolStats().connections.find(entry => entry.path === secondEntry.dbPath))
        .toMatchObject({ refs: 1 });
      await publication.withBackendPublicationConsumerLockAsync(secondEntry.homeDir, token =>
        active.withPublicationAdmission(token, async () => {
          const conversation = await active.conversations.getOrCreateConversation("after-idle-probe");
          expect(await active.conversations.getMessageCount(conversation.conversationId)).toBe(0);
        }));
      expectNoProbeTables(secondEntry.dbPath);
    } finally {
      release.resolve();
      await Promise.allSettled([health, transaction]);
      closeLcmConnection(firstEntry.dbPath, retainedDb);
      await cleanup(context);
    }
  });

  it.each(["retained", "idle"] as const)(
    "preserves real publication contention and maintenance refusal for %s projects", async state => {
      const context = await fixture();
      const homeDir = context.entries[0]!.homeDir;
      try {
        if (state === "idle") for (const project of context.projects) await project.close();
        await publication.withBackendPublicationConsumerLockAsync(homeDir, async () => {
          const health = await context.factory.health();
          expect(health).toMatchObject({ status: "unavailable", backend: "sqlite",
            error: { code: "STORAGE_OPERATION_FAILED", domain: "factory", operation: "health" } });
          expect(JSON.stringify(health)).not.toContain(homeDir);
        });
        expect(await context.factory.health()).toEqual({ status: "healthy", backend: "sqlite" });
        const unexpected = async (): Promise<never> => { throw new Error("unexpected driver"); };
        const coordinator = new publication.BackendPublicationCoordinator({ homeDir, driver: {
          observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
          restoreConfig: unexpected, restoreProjectMap: unexpected,
        } });
        await coordinator.enterMaintenance({
          publicationId: "health-queue-maintenance", generationId: "health-queue-generation",
          sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
          roster: [{ machineId: "018f0b5d-1234-4abc-8def-1234567890ab",
            queueCutoff: null, evidenceSha256: "c".repeat(64) }],
        });
        const before = context.entries.map(entry => readFileSync(entry.dbPath));
        expect(await context.factory.health()).toMatchObject({ status: "unavailable", backend: "sqlite" });
        expect(context.entries.map(entry => readFileSync(entry.dbPath))).toEqual(before);
      } finally { await cleanup(context); }
    },
  );

  it("reports an idle failure while probing the next project and releasing every reference", async () => {
    const context = await fixture();
    for (const project of context.projects) await project.close();
    const originalPrepare = DatabaseSync.prototype.prepare;
    let probes = 0;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync, sql: string,
    ) {
      if (sql === "PRAGMA quick_check(1)" && ++probes === 1) {
        return { all: () => [{ quick_check: "private-readiness-failure" }] } as never;
      }
      return originalPrepare.call(this, sql);
    });
    try {
      const result = await context.factory.health();
      expect(result).toMatchObject({ status: "unavailable", backend: "sqlite" });
      expect(JSON.stringify(result)).not.toContain("private-readiness-failure");
      expect(probes).toBe(2);
      for (const entry of context.entries) {
        expect(getPoolStats().connections.some(connection => connection.path === entry.dbPath)).toBe(false);
        expectNoProbeTables(entry.dbPath);
      }
      expect(await context.factory.health()).toEqual({ status: "healthy", backend: "sqlite" });
    } finally {
      prepareSpy.mockRestore();
      await cleanup(context);
    }
  });

});

describe("SqliteProjectStorage project health lifecycle", () => {
  it("uses per-operation admission without a canonical home", async () => {
    const fixture = createFixture();
    try {
      const result = await fixture.storage.withPublicationAdmission({},
        () => fixture.storage.conversations.getOrCreateConversation("noncanonical"));
      expect(result.conversationId).toBeDefined();
      await fixture.storage.close();
    } finally { cleanupFixture(fixture); }
  });

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

  it("does not repeat a committed pool release when close notification fails", async () => {
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
      expect(await fixture.storage.health()).toEqual({
        status: "closed",
        backend: "sqlite",
        projectId: "sqlite-health-project",
      });
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);

      const retryClose = fixture.storage.close();
      const duplicateRetry = fixture.storage.close();
      expect(retryClose).toBe(firstClose);
      expect(duplicateRetry).toBe(firstClose);
      await expect(retryClose).rejects.toThrow(privateSentinel);
      expect(closeCalls).toBe(1);
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("preserves an undefined close notification rejection after commit", async () => {
    let calls = 0;
    const fixture = createFixture(() => {
      calls += 1;
      throw undefined;
    });
    try {
      const first = fixture.storage.close();
      let rejected = false;
      await first.then(
        () => undefined,
        (error: unknown) => {
          rejected = true;
          expect(error).toBeUndefined();
        },
      );
      expect(rejected).toBe(true);
      expect(calls).toBe(1);
      expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
      expect(fixture.storage.close()).toBe(first);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([false, true])("notifies close once after committed cleanup failure (notification=%s)", async notificationFails => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-project-post-commit-"));
    const projectId = "f".repeat(64);
    const projectDirectory = join(homeDir, ".lcm", "projects", projectId);
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const dbPath = join(projectDirectory, "db.sqlite");
    const db = getLcmConnection(dbPath);
    const features = getLcmDbFeatures(db);
    runLcmMigrations(db, features);
    const executor = sqliteExecutorFor(db, projectId, () => undefined);
    const cleanupFailure = new Error("project append cleanup failed");
    let onCloseCalls = 0;
    let reentrantClose: Promise<void> | undefined;
    const notificationError = new Error("notification failed");
    const admission = {
      homeDir,
      _appendBarrierOptions: {
        _appendLockObserver: (event: string) => {
          if (event === "before-main-lock-release-read") throw cleanupFailure;
        },
      },
    } as unknown as SqliteOperationAdmission;
    const storage = new SqliteProjectStorage(
      projectId,
      dbPath,
      db,
      executor,
      sqliteStorageCapabilities(features.fts5Available),
      () => {
        onCloseCalls += 1;
        reentrantClose = storage.close();
        if (notificationFails) throw notificationError;
      },
      admission,
    );
    try {
      const first = storage.close();
      const error = await first.catch((caught: unknown) => caught);
      const primary = notificationFails ? (error as AggregateError).errors[0] : error;
      expect(primary).toMatchObject({ code: "STORAGE_OPERATION_FAILED", retryable: false });
      if (notificationFails) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([primary, notificationError]);
        expect((error as AggregateError).cause).toBe(primary);
      }
      expect(onCloseCalls).toBe(1);
      expect(reentrantClose).toBe(first);
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
      await expect(storage.health()).resolves.toMatchObject({ status: "closed" });

      const repeated = storage.close();
      expect(repeated).toBe(first);
      await expect(repeated).rejects.toBe(error);
      expect(onCloseCalls).toBe(1);
      expect(reentrantClose).toBe(first);
    } finally {
      closeLcmConnection(dbPath, db);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("retries project close after pre-release admission fails", async () => {
    const makeCanonical = () => {
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-project-close-retry-"));
      const projectId = "d".repeat(64);
      const projectDirectory = join(homeDir, ".lcm", "projects", projectId);
      mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
      const dbPath = join(projectDirectory, "db.sqlite");
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      db.close();
      chmodSync(dbPath, 0o644);
      const factory = new SqliteStorageBackendFactory({
        resolveProject: () => ({ id: projectId, dbPath }),
      });
      return { homeDir, dbPath, factory, identity: { id: projectId, canonical: homeDir } };
    };
    const context = makeCanonical();
    const other = makeCanonical();
    try {
      const project = await context.factory.openProject(context.identity);
      await expect(publication.withBackendPublicationAppendBarrierAsync(other.homeDir, token =>
        project.close(token))).rejects.toMatchObject({
        code: "STORAGE_OPERATION_FAILED",
        retryable: true,
      });
      expect(await project.health()).toMatchObject({ status: "healthy" });
      expect(isLcmConnectionOpen(context.dbPath)).toBe(true);

      await expect(project.close()).resolves.toBeUndefined();
      expect(isLcmConnectionOpen(context.dbPath)).toBe(false);
    } finally {
      await context.factory.close();
      await other.factory.close();
      rmSync(context.homeDir, { recursive: true, force: true });
      rmSync(other.homeDir, { recursive: true, force: true });
    }
  });
});
