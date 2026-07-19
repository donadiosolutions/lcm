import { describe, it, expect, vi, beforeEach } from "vitest";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import {
  handleSessionStart,
  sessionLockPathForTesting,
  tryAcquireSessionLockForTesting,
} from "../../src/hooks/restore.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

vi.mock("../../src/hooks/events-db.js", () => ({
  EventsDb: vi.fn().mockImplementation(function () {
    return {
      pruneProcessed: vi.fn(),
      pruneUnprocessed: vi.fn().mockReturnValue({ pruned: 0 }),
      pruneErrorLog: vi.fn().mockReturnValue(0),
      getUnprocessed: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    };
  }),
}));

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn().mockReturnValue("/tmp/test-events.db"),
}));

vi.mock("../../src/hooks/session-end.js", () => ({
  firePromoteEventsRequest: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);

describe("handleSessionStart", () => {
  beforeEach(() => {
    // Clear session locks between tests to prevent cross-test bleed
    for (const id of ["s1", "s2", "s3", "s4", "dedup-guard-test-abc123", "dead-pid-test-session", "invalid-pid", "request-failure"]) {
      rmSync(sessionLockPathForTesting(id), { force: true });
    }
  });

  it("outputs context and exits 0 on success", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "<memory-orientation>\nMemory active\n</memory-orientation>" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "SessionStart" }), client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
  });

  it("exits 0 with empty output when daemon down", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleSessionStart("{}", client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("accepts empty stdin", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    expect(await handleSessionStart("", { post: vi.fn() })).toEqual({ exitCode: 0, stdout: "" });
  });

  it("includes learned-insights block when insights returned from daemon", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({
        context: "<memory-orientation>\nMemory active\n</memory-orientation>",
        insights: [
          { content: "Always use async/await for DB calls", confidence: 0.8, tags: ["source:passive-capture", "type:pattern"] },
          { content: "Prefer PromotedStore over raw SQL", confidence: 0.6, tags: ["source:passive-capture"] },
        ],
      }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj" }), client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
    expect(result.stdout).toContain('<learned-insights source="passive-capture">');
    expect(result.stdout).toContain("Always use async/await for DB calls");
    expect(result.stdout).toContain("confidence: 0.8");
    expect(result.stdout).toContain("</learned-insights>");
  });

  it("omits learned-insights block when daemon returns no insights", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "some context" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s2", cwd: "/proj" }), client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("<learned-insights");
  });

  it("omits learned-insights block when insights array is empty", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "some context", insights: [] }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s3", cwd: "/proj" }), client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("<learned-insights");
  });

  it("returns empty output without contacting daemon on duplicate session_id", async () => {
    const sessionId = "dedup-guard-test-abc123";
    const lockPath = sessionLockPathForTesting(sessionId);
    rmSync(lockPath, { force: true });

    mockEnsureDaemon.mockClear();
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "ctx" }),
    };
    const stdin = JSON.stringify({ session_id: sessionId, cwd: "/proj" });

    // First call proceeds normally
    await handleSessionStart(stdin, client);
    expect(mockEnsureDaemon).toHaveBeenCalledTimes(1);

    // Second call with same session_id returns empty, daemon not called again
    const second = await handleSessionStart(stdin, client);
    expect(second).toEqual({ exitCode: 0, stdout: "" });
    expect(mockEnsureDaemon).toHaveBeenCalledTimes(1); // still 1, not 2

    rmSync(lockPath, { force: true });
  });

  it("proceeds normally when lock file exists but owner process is dead", async () => {
    const sessionId = "dead-pid-test-session";
    const lockPath = sessionLockPathForTesting(sessionId);
    mkdirSync(dirname(lockPath), { recursive: true });
    // Write a lock file with a PID that is guaranteed dead (PID 0 is invalid, large PID unlikely to exist)
    writeFileSync(lockPath, "9999999");

    mockEnsureDaemon.mockClear();
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "ctx from dead pid test" }),
    };
    const stdin = JSON.stringify({ session_id: sessionId, cwd: "/proj" });

    // Should NOT be blocked by the stale lock — should proceed and call daemon
    const result = await handleSessionStart(stdin, client);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ctx from dead pid test");
    expect(mockEnsureDaemon).toHaveBeenCalledTimes(1);
  });

  it("triggers promote-events when unprocessed events exist", async () => {
    const { EventsDb } = await import("../../src/hooks/events-db.js");
    const { firePromoteEventsRequest } = await import("../../src/hooks/session-end.js");
    const mockFirePromote = vi.mocked(firePromoteEventsRequest);
    mockFirePromote.mockClear();

    vi.mocked(EventsDb).mockImplementationOnce(function () {
      return {
        pruneProcessed: vi.fn(),
        pruneUnprocessed: vi.fn().mockReturnValue({ pruned: 0 }),
        pruneErrorLog: vi.fn().mockReturnValue(0),
        getUnprocessed: vi.fn().mockReturnValue([{ event_id: 1 }]),
        close: vi.fn(),
      } as any;
    });

    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "" }),
    };
    await handleSessionStart(JSON.stringify({ session_id: "s4", cwd: "/proj" }), client);
    expect(mockFirePromote).toHaveBeenCalledWith(3737, { cwd: "/proj" });
  });

  it("fails closed when an existing lock has an invalid owner pid", async () => {
    const lockPath = sessionLockPathForTesting("invalid-pid");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "not-a-pid");
    mockEnsureDaemon.mockClear();
    const result = await handleSessionStart(
      JSON.stringify({ session_id: "invalid-pid" }),
      { post: vi.fn() },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(mockEnsureDaemon).not.toHaveBeenCalled();
  });

  it("hashes attacker-controlled session ids into a private lock directory", async () => {
    const sessionId = "../../outside/lock-name";
    const lockPath = sessionLockPathForTesting(sessionId);
    expect(lockPath).toMatch(/[/\\]\.lcm[/\\]tmp[/\\]restore-[a-f0-9]{64}\.lock$/);

    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    await handleSessionStart(JSON.stringify({ session_id: sessionId }), { post: vi.fn() });

    expect(statSync(dirname(lockPath)).mode & 0o777).toBe(0o700);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
  });

  it("does not follow a symlink planted at a stale lock path", async () => {
    const lockPath = sessionLockPathForTesting("symlink-lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    const victim = join(dirname(lockPath), "victim.txt");
    writeFileSync(victim, "preserve me");
    symlinkSync(victim, lockPath);
    mockEnsureDaemon.mockClear();

    const result = await handleSessionStart(
      JSON.stringify({ session_id: "symlink-lock" }),
      { post: vi.fn() },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(readFileSync(victim, "utf-8")).toBe("preserve me");
    expect(mockEnsureDaemon).not.toHaveBeenCalled();
    rmSync(lockPath, { force: true });
    rmSync(victim, { force: true });
  });

  it("fails closed on lock creation and initialization errors without leaving partial locks", () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const baseDeps = {
      open: vi.fn(() => { throw eacces; }),
      write: vi.fn(),
      close: vi.fn(),
      read: vi.fn(() => "9999999"),
      delete: vi.fn(() => true),
      isProcessAlive: vi.fn(() => false),
    };
    expect(tryAcquireSessionLockForTesting("creation-error", baseDeps as never)).toBe(false);

    const partialDeps = {
      ...baseDeps,
      open: vi.fn(() => 17),
      write: vi.fn(() => { throw new Error("write failed"); }),
      close: vi.fn(),
      delete: vi.fn(() => true),
    };
    expect(tryAcquireSessionLockForTesting("partial-lock", partialDeps as never)).toBe(false);
    expect(partialDeps.close).toHaveBeenCalledWith(17);
    expect(partialDeps.delete).toHaveBeenCalledWith(sessionLockPathForTesting("partial-lock"));
  });

  it("serializes stale-lock reclamation with an exclusive guard", () => {
    const exists = Object.assign(new Error("exists"), { code: "EEXIST" });
    const lockPath = sessionLockPathForTesting("stale-lock");
    const guardedDeps = {
      open: vi.fn()
        .mockImplementationOnce(() => { throw exists; })
        .mockReturnValueOnce(18)
        .mockReturnValueOnce(19),
      write: vi.fn(),
      close: vi.fn(),
      read: vi.fn(() => "9999999"),
      delete: vi.fn(() => true),
      isProcessAlive: vi.fn(() => false),
    };

    expect(tryAcquireSessionLockForTesting("stale-lock", guardedDeps as never)).toBe(true);
    expect(guardedDeps.open.mock.calls.map(([path]) => path)).toEqual([
      lockPath,
      `${lockPath}.reclaim`,
      lockPath,
    ]);
    expect(guardedDeps.delete).toHaveBeenCalledWith(lockPath);
    expect(guardedDeps.delete).toHaveBeenCalledWith(`${lockPath}.reclaim`);
  });

  it("fails closed when another process owns the reclamation guard", () => {
    const exists = Object.assign(new Error("exists"), { code: "EEXIST" });
    const guardedDeps = {
      open: vi.fn(() => { throw exists; }),
      write: vi.fn(),
      close: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
      isProcessAlive: vi.fn(),
    };
    expect(tryAcquireSessionLockForTesting("guarded-lock", guardedDeps as never)).toBe(false);
    expect(guardedDeps.open).toHaveBeenCalledTimes(2);
    expect(guardedDeps.read).not.toHaveBeenCalled();
  });

  it("releases the reclamation guard when replacement loses a race", () => {
    const exists = Object.assign(new Error("exists"), { code: "EEXIST" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const lockPath = sessionLockPathForTesting("lost-reclaim-race");
    const deps = {
      open: vi.fn()
        .mockImplementationOnce(() => { throw exists; })
        .mockReturnValueOnce(20)
        .mockImplementationOnce(() => { throw denied; }),
      write: vi.fn(),
      close: vi.fn(),
      read: vi.fn(() => "9999999"),
      delete: vi.fn(() => true),
      isProcessAlive: vi.fn(() => false),
    };

    expect(tryAcquireSessionLockForTesting("lost-reclaim-race", deps as never)).toBe(false);
    expect(deps.delete).toHaveBeenCalledWith(lockPath);
    expect(deps.delete).toHaveBeenCalledWith(`${lockPath}.reclaim`);
  });

  it("fails open when restore request rejects", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const result = await handleSessionStart(
      JSON.stringify({ session_id: "request-failure" }),
      { post: vi.fn().mockRejectedValue(new Error("failed")) },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "" });
  });
});
