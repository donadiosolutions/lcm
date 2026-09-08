import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventsDbPath } from "../../src/db/events-path.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { handleSessionStart, sessionLockPathForTesting } from "../../src/hooks/restore.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(async () => ({ connected: true, port: 3737, spawned: false })),
}));

vi.mock("../../src/hooks/session-end.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/session-end.js")>();
  return { ...actual, firePromoteEventsRequest: vi.fn() };
});

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  closeLcmConnection();
  vi.clearAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionStart canonical outbox scavenge", () => {
  it("prunes through real append admission and promotes a retained pending event", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-session-start-canonical-"));
    roots.push(homeDir);
    process.env.HOME = homeDir;
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    execFileSync("git", ["init", "-q", cwd]);

    const dbPath = eventsDbPath(cwd);
    const seedFactory = new SQLiteLocalHookOutboxFactory();
    const outbox = await seedFactory.open(dbPath);
    const processed = await outbox.insertEvent("processed", {
      type: "decision", category: "decision", data: "processed", priority: 1,
    }, "SessionStart");
    const pending = await outbox.insertEvent("pending", {
      type: "decision", category: "decision", data: "pending", priority: 1,
    }, "SessionStart");
    await outbox.markProcessed([processed]);
    await outbox.logHookError("SessionStart", new Error("old error"));
    await seedFactory.close();

    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        UPDATE events SET
          processed_at = datetime('now', '-8 days'),
          delivery_state = 'acknowledged',
          remote_inbox_id = '1',
          acknowledged_at = datetime('now', '-8 days'),
          remote_pruned_at = datetime('now', '-8 days')
          WHERE event_id = ${processed};
        UPDATE events SET created_at = datetime('now', '-31 days')
          WHERE event_id = ${pending};
        UPDATE error_log SET created_at = datetime('now', '-31 days');
      `);
    } finally {
      seed.close();
    }

    const sessionId = "canonical-scavenge";
    const client = { post: vi.fn(async () => ({ context: "restored" })) };
    const { firePromoteEventsRequest } = await import("../../src/hooks/session-end.js");
    await expect(handleSessionStart(JSON.stringify({ session_id: sessionId, cwd }), client))
      .resolves.toEqual({ exitCode: 0, stdout: "restored" });

    const inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT event_id FROM events ORDER BY event_id").all())
        .toEqual([{ event_id: pending }]);
      expect(inspect.prepare(
        "SELECT hook FROM error_log ORDER BY id",
      ).all()).toEqual([{ hook: "maintenance:pruneUnprocessed" }]);
    } finally {
      inspect.close();
    }
    expect(firePromoteEventsRequest).toHaveBeenCalledWith(3737, { cwd });
    expect(client.post).toHaveBeenCalledWith("/restore", { session_id: sessionId, cwd });
    rmSync(sessionLockPathForTesting(sessionId), { force: true });
  });
});
