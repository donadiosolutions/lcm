import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getPoolStats, isLcmConnectionOpen } from "../../src/db/connection.js";
import { eventSequenceDbPath } from "../../src/db/events-path.js";
import {
  type LocalHookOutboxRepository,
  SQLiteLocalHookOutboxFactory,
} from "../../src/storage/local-hook-outbox.js";
import {
  BackendPublicationCoordinator,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

describe("SQLiteLocalHookOutboxFactory", () => {
  const machineId = "0195d250-0000-7000-8000-000000000091";
  const eventUuid = "0195d250-0000-7000-8000-000000000092";
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function pathFor(name: string): string {
    const directory = mkdtempSync(join(tmpdir(), "lcm-local-outbox-"));
    directories.push(directory);
    return join(directory, `${name}.db`);
  }

  function localPathFor(name: string): { homeDir: string; dbPath: string } {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-local-outbox-home-"));
    directories.push(homeDir);
    const eventsDirectory = join(homeDir, ".lcm", "events");
    mkdirSync(eventsDirectory, { recursive: true, mode: 0o700 });
    return { homeDir, dbPath: join(eventsDirectory, `${name}.db`) };
  }

  function retainedOperations(
    repository: LocalHookOutboxRepository,
  ): Array<{ operation: string; run: () => Promise<unknown> }> {
    return [
      {
        operation: "insertEvent",
        run: () => repository.insertEvent(
          "closed-session",
          { type: "choice", category: "decision", data: "secret", priority: 1 },
          "PostToolUse",
        ),
      },
      { operation: "getUnprocessed", run: () => repository.getUnprocessed() },
      { operation: "markProcessed", run: () => repository.markProcessed([1]) },
      {
        operation: "observeMissingCwd",
        run: () => repository.observeMissingCwd(0, 1, 3),
      },
      { operation: "clearMissingCwd", run: () => repository.clearMissingCwd() },
      { operation: "pruneProcessed", run: () => repository.pruneProcessed(7) },
      { operation: "setPrevEventId", run: () => repository.setPrevEventId(2, 1) },
      {
        operation: "getPatternReinforcement",
        run: () => repository.getPatternReinforcement("choice", "decision", "secret"),
      },
      {
        operation: "logHookError",
        run: () => repository.logHookError("PostToolUse", new Error("secret")),
      },
      { operation: "getHealthStats", run: () => repository.getHealthStats() },
      { operation: "getRecentErrors", run: () => repository.getRecentErrors() },
      { operation: "pruneUnprocessed", run: () => repository.pruneUnprocessed() },
      { operation: "pruneErrorLog", run: () => repository.pruneErrorLog() },
      {
        operation: "claimDeliveries",
        run: () => repository.claimDeliveries({
          machineId,
          claimOwner: "closed-owner",
          limit: 1,
          staleClaimMs: 1,
        }),
      },
      {
        operation: "markReplicated",
        run: () => repository.markReplicated(eventUuid, "closed-owner", 1n),
      },
      {
        operation: "markDeliveryRetry",
        run: () => repository.markDeliveryRetry(
          eventUuid,
          "closed-owner",
          "closed",
          "2026-01-01T00:00:00.000Z",
        ),
      },
      {
        operation: "markDeliveryQuarantined",
        run: () => repository.markDeliveryQuarantined(
          eventUuid,
          "closed-owner",
          "unsupported",
        ),
      },
      { operation: "listAwaitingRemote", run: () => repository.listAwaitingRemote() },
      { operation: "listQuarantined", run: () => repository.listQuarantined() },
      {
        operation: "markAcknowledged",
        run: () => repository.markAcknowledged(eventUuid, 1n),
      },
      {
        operation: "markQuarantined",
        run: () => repository.markQuarantined(eventUuid, 1n, "closed"),
      },
      {
        operation: "replayQuarantined",
        run: () => repository.replayQuarantined(eventUuid),
      },
      {
        operation: "listAcknowledgedForRemotePrune",
        run: () => repository.listAcknowledgedForRemotePrune(),
      },
      {
        operation: "markRemotePruned",
        run: () => repository.markRemotePruned(eventUuid),
      },
      {
        operation: "getDeliveryDiagnostics",
        run: () => repository.getDeliveryDiagnostics(),
      },
    ];
  }

  async function expectRetainedOperationsClosed(repository: LocalHookOutboxRepository): Promise<void> {
    for (const { operation, run } of retainedOperations(repository)) {
      await expect(run()).rejects.toMatchObject({
        name: "StorageOperationError",
        code: "STORAGE_CLOSED",
        backend: "sqlite",
        projectId: undefined,
        domain: "passive-events",
        operation,
        retryable: false,
        message: "sqlite storage is closed",
      });
    }
  }

  it("adapts every outbox operation while preserving ordering and maintenance semantics", async () => {
    const path = pathFor("operations");
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(path, { busyTimeoutMs: 250 });

    const secondSession = await repository.insertEvent(
      "session-b",
      { type: "choice", category: "decision", data: "SQLite", priority: 1 },
      "UserPromptSubmit",
    );
    const firstSession = await repository.insertEvent(
      "session-a",
      { type: "choice", category: "decision", data: "SQLite", priority: 1 },
      "PostToolUse",
    );
    const firstSessionNext = await repository.insertEvent(
      "session-a",
      { type: "file", category: "file", data: "src/a.ts", priority: 3 },
      "PostToolUse",
    );

    expect((await repository.getUnprocessed(2)).map((event) => event.event_id)).toEqual([
      firstSession,
      firstSessionNext,
    ]);
    await repository.setPrevEventId(firstSessionNext, firstSession);
    expect((await repository.getUnprocessed()).find((event) => event.event_id === firstSessionNext)?.prev_event_id)
      .toBe(firstSession);
    expect(await repository.getPatternReinforcement("choice", "decision", "SQLite", 90)).toEqual({
      totalCount: 2,
      distinctSessions: 2,
    });

    await repository.logHookError("PostToolUse", new Error("visible"), "session-a");
    await repository.logHookError("maintenance:test", "hidden");
    expect(await repository.getRecentErrors()).toEqual([
      expect.objectContaining({ hook: "PostToolUse", error: "visible", session_id: "session-a" }),
    ]);
    expect(await repository.getRecentErrors({ includeMaintenance: true, limit: 10 })).toHaveLength(2);
    expect(await repository.getHealthStats()).toMatchObject({
      totalEvents: 3,
      unprocessed: 3,
      errors: 1,
      deliveryPending: 3,
      deliveryAcknowledged: 0,
      deliveryAwaitingRemotePrune: 0,
    });

    await repository.markProcessed([]);
    await repository.markProcessed([secondSession]);
    expect(await repository.observeMissingCwd(0, 5 * 60 * 1000, 3)).toEqual({
      parked: false,
      observations: 1,
      retryAfterMs: 5 * 60 * 1000,
    });
    await repository.clearMissingCwd();
    expect(await repository.observeMissingCwd(5 * 60 * 1000, 5 * 60 * 1000, 3)).toMatchObject({
      parked: false,
      observations: 1,
    });
    const activeMachineId = (await repository.getUnprocessed())[0]?.machine_id
      ?? machineId;
    const claimed = await repository.claimDeliveries({
      machineId: activeMachineId,
      claimOwner: "test-owner",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].event_id).toBe(secondSession);
    expect(await repository.markReplicated(
      claimed[0].event_uuid,
      "wrong-owner",
      9n,
    )).toBe(false);
    expect(await repository.markReplicated(
      claimed[0].event_uuid,
      "test-owner",
      9n,
    )).toBe(true);
    expect(await repository.markAcknowledged(claimed[0].event_uuid, 9n)).toBe(true);
    expect(await repository.markRemotePruned(claimed[0].event_uuid)).toBe(true);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${secondSession};
      UPDATE events SET created_at = datetime('now', '-31 days') WHERE event_id = ${firstSession};
      UPDATE error_log SET created_at = datetime('now', '-31 days');
    `);
    raw.close();

    expect(await repository.pruneProcessed(7)).toBe(1);
    expect(await repository.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
    expect(await repository.getUnprocessed()).toHaveLength(2);
    expect(await repository.pruneErrorLog()).toBe(2);

    await repository.close();
    await repository.close();
    expect(isLcmConnectionOpen(path)).toBe(false);
    await factory.close();
    await factory.close();
  });

  it("forwards delivery quarantine lifecycle operations through the local repository", async () => {
    const path = pathFor("delivery-lifecycle");
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(path);
    const first = await repository.insertEvent(
      "delivery-session",
      { type: "choice", category: "decision", data: "first", priority: 1 },
      "PostToolUse",
    );
    const second = await repository.insertEvent(
      "delivery-session",
      { type: "choice", category: "decision", data: "second", priority: 1 },
      "PostToolUse",
    );
    const [firstClaim] = await repository.claimDeliveries({
      machineId: (await repository.getUnprocessed())[0].machine_id ?? machineId,
      claimOwner: "owner-a",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(firstClaim.event_id).toBe(first);
    expect(await repository.markDeliveryRetry(
      firstClaim.event_uuid,
      "owner-a",
      "temporary failure",
      "2000-01-01T00:00:00.000Z",
    )).toBe(true);

    const [reclaimed] = await repository.claimDeliveries({
      machineId: firstClaim.machine_id ?? machineId,
      claimOwner: "owner-b",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(reclaimed.event_id).toBe(first);
    expect(await repository.markDeliveryQuarantined(
      reclaimed.event_uuid,
      "owner-b",
      "poisoned payload",
    )).toBe(true);
    expect((await repository.listQuarantined()).map((event) => event.event_id)).toEqual([first]);

    const [secondClaim] = await repository.claimDeliveries({
      machineId: firstClaim.machine_id ?? machineId,
      claimOwner: "owner-c",
      limit: 1,
      staleClaimMs: 1_000,
    });
    expect(secondClaim.event_id).toBe(second);
    expect(await repository.markReplicated(secondClaim.event_uuid, "owner-c", 41n)).toBe(true);
    expect((await repository.listAwaitingRemote()).map((event) => event.event_id)).toEqual([second]);
    expect(await repository.markQuarantined(secondClaim.event_uuid, 41n, "remote poison")).toBe(true);
    expect(await repository.listAwaitingRemote()).toEqual([]);
    expect((await repository.listAwaitingRemote(undefined, true)).map((event) => event.event_id)).toEqual([second]);
    expect((await repository.listQuarantined()).map((event) => event.event_id)).toEqual([first, second]);
    expect(await repository.replayQuarantined(reclaimed.event_uuid)).toBe(true);
    expect(await repository.replayQuarantined(secondClaim.event_uuid)).toBe(true);
    expect(await repository.markAcknowledged(secondClaim.event_uuid, 41n)).toBe(true);
    expect((await repository.listAcknowledgedForRemotePrune()).map((event) => event.event_id)).toEqual([second]);

    await repository.close();
    await factory.close();
  });

  it("opens an existing local outbox while migration maintenance is held", async () => {
    const { homeDir, dbPath } = localPathFor("maintenance-held");
    const seedFactory = new SQLiteLocalHookOutboxFactory();
    const seed = await seedFactory.open(dbPath);
    await seed.insertEvent(
      "maintenance-session",
      { type: "choice", category: "decision", data: "held", priority: 1 },
      "PostToolUse",
    );
    await seedFactory.close();

    const unexpected: BackendPublicationDriver["observeLocalState"] = async () => {
      throw new Error("publication driver must not run");
    };
    const driver: BackendPublicationDriver = {
      observeLocalState: unexpected,
      publishProjectMap: async () => { throw new Error("publication driver must not run"); },
      publishConfig: async () => { throw new Error("publication driver must not run"); },
      restoreConfig: async () => { throw new Error("publication driver must not run"); },
      restoreProjectMap: async () => { throw new Error("publication driver must not run"); },
    };
    const coordinator = new BackendPublicationCoordinator({ homeDir, driver });
    await coordinator.enterMaintenance({
      publicationId: "local-outbox-publication",
      generationId: "local-outbox-generation",
      sourceSelectionSha256: "a".repeat(64),
      queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    });

    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.openExisting(dbPath);
    expect(repository).not.toBeNull();
    await repository?.close();
    await factory.close();

  });

  it("opens only an existing local outbox without creating missing path state", async () => {
    const existingPath = pathFor("existing-only");
    const missingParent = join(dirname(existingPath), "missing");
    const missingPath = join(missingParent, "outbox.db");
    const factory = new SQLiteLocalHookOutboxFactory();

    await expect(factory.openExisting(missingPath)).resolves.toBeNull();
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(missingParent)).toBe(false);

    const created = await factory.open(existingPath);
    await created.close();
    const existing = await factory.openExisting(existingPath);
    expect(existing).not.toBeNull();
    await existing?.close();
    await factory.close();
  });

  it("closes every open repository and rejects new work after factory close", async () => {
    const firstPath = pathFor("first");
    const secondPath = pathFor("second");
    const factory = new SQLiteLocalHookOutboxFactory();
    await factory.open(firstPath);
    await factory.open(secondPath);

    await factory.close();
    expect(isLcmConnectionOpen(firstPath)).toBe(false);
    expect(isLcmConnectionOpen(secondPath)).toBe(false);
    await factory.close();
    await expect(factory.open(pathFor("late"))).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      backend: "sqlite",
      domain: "passive-events",
      operation: "open",
    });
    await expect(factory.openExisting(pathFor("late-existing"))).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      backend: "sqlite",
      domain: "passive-events",
      operation: "openExisting",
    });
  });

  it("rejects every operation through a retained reference after repository close", async () => {
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(pathFor("repository-close"));

    await repository.close();
    await repository.close();

    await expectRetainedOperationsClosed(repository);
    await factory.close();
  });

  it("rejects every operation through a retained reference after factory close", async () => {
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(pathFor("factory-close"));

    await factory.close();
    await factory.close();

    await expectRetainedOperationsClosed(repository);
  });

  it("retries factory close after pre-release admission fails", async () => {
    const local = localPathFor("retry-close");
    const other = localPathFor("other-home");
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(local.dbPath);

    await expect(withBackendPublicationAppendBarrierAsync(other.homeDir, token =>
      factory.close(token))).rejects.toMatchObject({ reason: "permit-mismatch" });
    await expect(repository.getHealthStats()).resolves.toMatchObject({ unprocessed: 0 });
    expect(isLcmConnectionOpen(local.dbPath)).toBe(true);
    await expect(factory.open(localPathFor("late-after-failure").dbPath)).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
      operation: "open",
    });

    await expect(factory.close()).resolves.toBeUndefined();
    expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
    await expectRetainedOperationsClosed(repository);
  });

  it("shares one in-flight repository close while waiting for append admission", async () => {
    const local = localPathFor("shared-close");
    const factory = new SQLiteLocalHookOutboxFactory();
    const repository = await factory.open(local.dbPath);
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const entered = new Promise<void>(resolve => { ownerEntered = resolve; });
    const owner = withBackendPublicationAppendBarrierAsync(local.homeDir, async () => {
      ownerEntered();
      await new Promise<void>(resolve => { releaseOwner = resolve; });
    });
    await entered;

    const first = repository.close();
    const duplicate = repository.close();
    const samePromise = duplicate === first;
    releaseOwner();
    await owner;
    await first;

    expect(samePromise).toBe(true);
    await expect(duplicate).resolves.toBeUndefined();
    await factory.close();
  });

  it("keeps a committed repository closed after append-lock cleanup fails", async () => {
    const local = localPathFor("committed-cleanup");
    const cleanupFailure = new Error("outbox append cleanup failed");
    let armed = false;
    const ControlledFactory = SQLiteLocalHookOutboxFactory as unknown as new (
      dependencies: Readonly<{
        appendBarrierOptions: Readonly<{
          _appendLockObserver: (event: string) => void;
        }>;
      }>,
    ) => SQLiteLocalHookOutboxFactory;
    const factory = new ControlledFactory({
      appendBarrierOptions: {
        _appendLockObserver: (event) => {
          if (armed && event === "before-main-lock-release-read") throw cleanupFailure;
        },
      },
    });
    const repository = await factory.open(local.dbPath);
    const sequencePath = eventSequenceDbPath(local.homeDir);
    armed = true;

    const first = factory.close();
    await expect(first).rejects.toBe(cleanupFailure);
    expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
    expect(isLcmConnectionOpen(sequencePath)).toBe(false);
    await expectRetainedOperationsClosed(repository);

    armed = false;
    await expect(factory.close()).resolves.toBeUndefined();
    expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
  });

  it.each([false, true])("keeps committed outbox ownership released when notification fails (cleanup=%s)", async cleanupFails => {
    const local = localPathFor("notification-failure");
    const cleanupError = new Error("append cleanup failure");
    const notificationError = new Error("owner notification failure");
    let armed = false;
    const factory = new SQLiteLocalHookOutboxFactory({ appendBarrierOptions: {
      _appendLockObserver: event => {
        if (armed && cleanupFails && event === "before-main-lock-release-read") throw cleanupError;
      },
    } });
    const repository = await factory.open(local.dbPath);
    const originalDelete = Set.prototype.delete;
    let notifications = 0;
    let reentrantClose: Promise<void> | undefined;
    const deletion = vi.spyOn(Set.prototype, "delete").mockImplementation(function (value) {
      const deleted = originalDelete.call(this, value);
      if (value === repository) {
        notifications += 1;
        reentrantClose = repository.close();
        throw notificationError;
      }
      return deleted;
    });
    try {
      armed = true;
      const close = repository.close();
      const error = await close.catch((caught: unknown) => caught);
      if (cleanupFails) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([cleanupError, notificationError]);
        expect((error as AggregateError).cause).toBe(cleanupError);
      } else expect(error).toBe(notificationError);
      expect(repository.close()).toBe(close);
      expect(reentrantClose).toBe(close);
      expect(notifications).toBe(1);
      expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
      await expectRetainedOperationsClosed(repository);
    } finally {
      deletion.mockRestore();
      armed = false;
      await factory.close();
    }
  });

  it("preserves an undefined post-commit cleanup rejection", async () => {
    const local = localPathFor("undefined-cleanup");
    let armed = false;
    const factory = new SQLiteLocalHookOutboxFactory({
      appendBarrierOptions: {
        _appendLockObserver: (event) => {
          if (armed && event === "before-main-lock-release-read") throw undefined;
        },
      },
    });
    const repository = await factory.open(local.dbPath);
    armed = true;

    let rejected = false;
    await factory.close().then(
      () => undefined,
      (error: unknown) => {
        rejected = true;
        expect(error).toBeUndefined();
      },
    );
    expect(rejected).toBe(true);
    expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
    await expectRetainedOperationsClosed(repository);
  });

  it("reports multiple uncommitted close failures in repository order", async () => {
    const first = localPathFor("aggregate-first");
    const second = localPathFor("aggregate-second");
    let now = 0;
    let armed = false;
    const factory = new SQLiteLocalHookOutboxFactory({
      appendBarrierOptions: {
        contentionWaitMs: 1,
        retryDelayMs: 1,
        _now: () => now,
        _wait: async milliseconds => { now += milliseconds; },
        _appendLockObserver: (event, path) => {
          if (armed && event === "before-main-lock-publish") {
            throw new PrivateMutationLockContentionError(path.includes(first.homeDir)
              ? "first close busy"
              : "second close busy");
          }
        },
      },
    });
    await factory.open(first.dbPath);
    await factory.open(second.dbPath);
    armed = true;

    const error = await factory.close().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((failure: Error) => failure.cause?.message))
      .toEqual(["first close busy", "second close busy"]);
    expect(isLcmConnectionOpen(first.dbPath)).toBe(true);
    expect(isLcmConnectionOpen(second.dbPath)).toBe(true);
  });

  it("orders only the final outbox pool release behind append admission", async () => {
    const local = localPathFor("pooled-close");
    const factory = new SQLiteLocalHookOutboxFactory();
    const first = await factory.open(local.dbPath);
    const second = await factory.open(local.dbPath);
    expect(getPoolStats().connections.find(connection => connection.path === local.dbPath)?.refs)
      .toBe(2);

    await first.close();
    expect(getPoolStats().connections.find(connection => connection.path === local.dbPath)?.refs)
      .toBe(1);
    await second.close();
    expect(isLcmConnectionOpen(local.dbPath)).toBe(false);
    await factory.close();
  });
});
