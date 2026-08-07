import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { isLcmConnectionOpen } from "../../src/db/connection.js";
import {
  type LocalHookOutboxRepository,
  SQLiteLocalHookOutboxFactory,
} from "../../src/storage/local-hook-outbox.js";

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
});
