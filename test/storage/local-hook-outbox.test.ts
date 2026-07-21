import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { isLcmConnectionOpen } from "../../src/db/connection.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";

describe("SQLiteLocalHookOutboxFactory", () => {
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
    });

    await repository.markProcessed([]);
    await repository.markProcessed([secondSession]);
    const raw = new DatabaseSync(path);
    raw.exec(`
      UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${secondSession};
      UPDATE events SET created_at = datetime('now', '-31 days') WHERE event_id = ${firstSession};
      UPDATE error_log SET created_at = datetime('now', '-31 days');
    `);
    raw.close();

    expect(await repository.pruneProcessed(7)).toBe(1);
    expect(await repository.pruneUnprocessed(10, 30)).toEqual({ pruned: 1 });
    expect(await repository.pruneErrorLog()).toBe(2);

    await repository.close();
    await repository.close();
    expect(isLcmConnectionOpen(path)).toBe(false);
    await factory.close();
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
    await expect(factory.open(pathFor("late"))).rejects.toThrow("local hook outbox factory is closed");
  });
});
