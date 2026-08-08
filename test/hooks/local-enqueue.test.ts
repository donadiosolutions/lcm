import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import * as securityFiles from "../../src/security-files.js";

describe("appendLocalHookEvents", () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-local-enqueue-home-"));
    cwd = mkdtempSync(join(tmpdir(), "lcm-local-enqueue-project-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const input = () => ({
    cwd,
    sessionId: "session-1",
    events: [{ type: "decision", category: "decision", data: "durable choice", priority: 1 }],
    sourceHook: "PostToolUse",
  });

  it("durably enqueues before any publication or daemon admission", async () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });

    await expect(appendLocalHookEvents(input())).resolves.toEqual({ inserted: 1, pendingCount: 1 });

    const db = new EventsDb(eventsDbPath(cwd));
    try {
      expect(db.getUnprocessed()[0]).toEqual(expect.objectContaining({
        session_id: "session-1",
        data: "durable choice",
        source_hook: "PostToolUse",
      }));
    } finally {
      db.close();
    }
  });

  it("remains durable across a fresh outbox open", async () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    await appendLocalHookEvents(input());

    const reopened = new EventsDb(eventsDbPath(cwd));
    try {
      expect(reopened.getHealthStats().unprocessed).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("fails before a missing root can be created", async () => {
    await expect(appendLocalHookEvents(input())).rejects.toThrow();
    expect(existsSync(join(home, ".lcm"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "events"))).toBe(false);
  });

  it("fails closed when the retained root is replaced during the outbox operation", async () => {
    const root = join(home, ".lcm");
    const oldRoot = join(home, ".lcm.old");
    mkdirSync(root, { mode: 0o700 });
    const open = vi.spyOn(SQLiteLocalHookOutboxFactory.prototype, "open").mockResolvedValue({
      insertEvent: vi.fn().mockResolvedValue(1),
      getHealthStats: vi.fn().mockImplementation(async () => {
        renameSync(root, oldRoot);
        mkdirSync(root, { mode: 0o700 });
        return { unprocessed: 1 };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    try {
      await expect(appendLocalHookEvents(input())).rejects.toThrow(/private directory/);
    } finally {
      open.mockRestore();
      rmSync(root, { recursive: true, force: true });
      renameSync(oldRoot, root);
    }
  });

  it("fails closed when the retained witness changes", async () => {
    const root = join(home, ".lcm");
    mkdirSync(root, { mode: 0o700 });
    const originalAssert = securityFiles.assertPrivateDirectory;
    let calls = 0;
    const assert = vi.spyOn(securityFiles, "assertPrivateDirectory").mockImplementation((handle, path, expected) => {
      const actual = originalAssert(handle, path, expected);
      calls += 1;
      return calls === 2 ? { ...actual, ino: `${actual.ino}-changed` } : actual;
    });
    try {
      await expect(appendLocalHookEvents(input())).rejects.toThrow("private directory witness changed");
    } finally {
      assert.mockRestore();
    }
  });
});
