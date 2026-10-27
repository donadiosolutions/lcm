import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotDeps } from "../../src/hooks/session-snapshot.js";
import { assertHookPublicationFence } from "../../src/hooks/publication-fence.js";
import {
  createLockContentionWaitBudget,
  PrivateMutationLockContentionError,
  retryWhileLiveLockContended,
} from "../../src/private-mutation-lock.js";

vi.mock("../../src/hooks/publication-fence.js", () => ({
  assertHookPublicationFence: vi.fn(),
  assertHookRootEstablished: vi.fn(),
  isBackendPublicationJournalError: () => false,
  NO_HOOK_ADMISSION_RETRY: async <T>(step: () => T | Promise<T>): Promise<T> => await step(),
}));

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    statSync: vi.fn().mockReturnValue(null),
    writeFileSync: vi.fn(),
    snapshotIntervalSec: 60,
    post: vi.fn().mockResolvedValue({ ingested: 5 }),
    ...overrides,
  };
}

describe("handleSessionSnapshot", () => {
  it("ingests and writes the normal cursor when no cursor file exists", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: "abc-123",
      cwd: "/tmp/test",
      transcript_path: "/tmp/session.jsonl",
      client: "claude",
    });
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("snap-abc-123.json"),
      expect.stringContaining("\"ts\":"),
    );
  });

  it("skips when throttled (cursor mtime < interval)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 10_000 }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("ingests PreCompact snapshots even when cursor mtime is within interval", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 10_000 }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({
        session_id: "abc-123",
        cwd: "/tmp/test",
        transcript_path: "/tmp/session.jsonl",
        hook_event_name: "PreCompact",
        client: "codex",
      }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: "abc-123",
      cwd: "/tmp/test",
      transcript_path: "/tmp/session.jsonl",
      client: "codex",
    });
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("ingests when cursor mtime exceeds interval", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 120_000 }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalled();
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("snap-abc-123.json"),
      expect.stringContaining("\"ts\":"),
    );
  });

  it("no-ops incomplete PreCompact payloads", async () => {
    const deps = makeDeps();
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", hook_event_name: "PreCompact", client: "codex" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("passes Codex client through when invoked by Codex hooks", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const previous = process.env.LCM_CLIENT;
    process.env.LCM_CLIENT = "codex";
    try {
      await handleSessionSnapshot(
        JSON.stringify({ session_id: "codex-123", cwd: "/tmp/test", transcript_path: "/tmp/codex.jsonl" }),
        deps,
      );
    } finally {
      if (previous === undefined) delete process.env.LCM_CLIENT;
      else process.env.LCM_CLIENT = previous;
    }
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: "codex-123",
      cwd: "/tmp/test",
      transcript_path: "/tmp/codex.jsonl",
      client: "codex",
    });
  });

  it("returns exitCode 0 on error (never blocks Claude)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
      post: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
  });

  describe("waiting for a live publication-lock owner", () => {
    const liveContention = (): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
      "publication lock is busy",
      {
        contendedLock: {
          path: "/lcm/publication.lock",
          owner: { version: 1, pid: process.pid + 1, processStartTime: null, nonce: "owner" },
        },
      },
    );
    const admissionRetry = (totalMs: number): SnapshotDeps["admissionRetry"] => {
      const budget = createLockContentionWaitBudget(totalMs);
      return (step) => retryWhileLiveLockContended(step, { budget, _wait: async () => undefined });
    };
    const input = JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" });

    beforeEach(() => {
      vi.mocked(assertHookPublicationFence).mockReset();
    });
    afterEach(() => {
      vi.mocked(assertHookPublicationFence).mockReset();
    });

    it("ingests once the owner releases the lock", async () => {
      vi.mocked(assertHookPublicationFence)
        .mockImplementationOnce(() => { throw liveContention(); })
        .mockImplementationOnce(() => { throw liveContention(); });
      const deps = makeDeps({ admissionRetry: admissionRetry(1000) });
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");

      await handleSessionSnapshot(input, deps);

      expect(assertHookPublicationFence).toHaveBeenCalledTimes(3);
      expect(deps.post).toHaveBeenCalledTimes(1);
    });

    it("keeps the silent skip once the owner outlasts the allowance", async () => {
      vi.mocked(assertHookPublicationFence).mockImplementation(() => { throw liveContention(); });
      const deps = makeDeps({ admissionRetry: admissionRetry(100) });
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");

      await expect(handleSessionSnapshot(input, deps)).resolves.toEqual({ exitCode: 0, stdout: "" });

      expect(assertHookPublicationFence).toHaveBeenCalledTimes(3);
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.writeFileSync).not.toHaveBeenCalled();
    });

    it("tries the fence once when no allowance was supplied", async () => {
      vi.mocked(assertHookPublicationFence).mockImplementation(() => { throw liveContention(); });
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");

      await handleSessionSnapshot(input, deps);

      expect(assertHookPublicationFence).toHaveBeenCalledTimes(1);
      expect(deps.post).not.toHaveBeenCalled();
    });
  });

  describe("Codex subagents", () => {
    const child = {
      client: "codex",
      session_id: "tree-root",
      agent_id: "child-thread",
      cwd: "/tmp/test",
      transcript_path: "/tmp/child.jsonl",
    };

    it("forces a SubagentStop ingest of the child rollout without touching any cursor", async () => {
      const deps = makeDeps({ statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 1_000 }) });
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      const result = await handleSessionSnapshot(JSON.stringify({
        ...child,
        hook_event_name: "SubagentStop",
        transcript_path: "/tmp/parent.jsonl",
        agent_transcript_path: "/tmp/child.jsonl",
      }), deps);
      expect(result).toEqual({ exitCode: 0, stdout: "" });
      expect(deps.post).toHaveBeenCalledTimes(1);
      expect(deps.post).toHaveBeenCalledWith("/ingest", {
        session_id: "child-thread",
        cwd: "/tmp/test",
        transcript_path: "/tmp/child.jsonl",
        client: "codex",
      });
      expect(deps.writeFileSync).not.toHaveBeenCalled();
    });

    it("ingests a SubagentStop whose parent transcript_path is null", async () => {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(JSON.stringify({
        ...child, hook_event_name: "SubagentStop", transcript_path: null, agent_transcript_path: "/tmp/child.jsonl",
      }), deps);
      expect(deps.post).toHaveBeenCalledWith("/ingest", expect.objectContaining({ session_id: "child-thread" }));
    });

    it("no-ops a SubagentStop without its own rollout, never falling back to the parent's", async () => {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      for (const agent_transcript_path of [undefined, null, ""]) {
        await handleSessionSnapshot(JSON.stringify({
          ...child, hook_event_name: "SubagentStop", transcript_path: "/tmp/parent.jsonl", agent_transcript_path,
        }), deps);
      }
      expect(deps.post).not.toHaveBeenCalled();
    });

    it("keys a child PreCompact and its cursor by agent_id, leaving the parent's cursor alone", async () => {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(JSON.stringify({ ...child, hook_event_name: "PreCompact" }), deps);
      expect(deps.post).toHaveBeenCalledWith("/ingest", expect.objectContaining({
        session_id: "child-thread", transcript_path: "/tmp/child.jsonl",
      }));
      expect(deps.writeFileSync).not.toHaveBeenCalled();

      await handleSessionSnapshot(JSON.stringify({ ...child, agent_id: "grandchild-thread", hook_event_name: "Stop" }), deps);
      expect(deps.post).toHaveBeenLastCalledWith("/ingest", expect.objectContaining({ session_id: "grandchild-thread" }));
      expect(deps.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("snap-grandchild-thread.json"),
        expect.any(String),
      );
      expect(deps.writeFileSync).not.toHaveBeenCalledWith(expect.stringContaining("snap-tree-root"), expect.anything());
    });

    it("scopes a child by agent_id when the tree session_id is not a string", async () => {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(JSON.stringify({ ...child, session_id: 42 }), deps);
      expect(deps.post).toHaveBeenCalledWith("/ingest", expect.objectContaining({ session_id: "child-thread" }));
      deps.post = vi.fn();
      await handleSessionSnapshot(JSON.stringify({ ...child, client: "claude", session_id: 42 }), deps);
      expect(deps.post).not.toHaveBeenCalled();
    });

    it("leaves a non-Codex payload carrying agent_id on its session_id", async () => {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(JSON.stringify({ ...child, client: "claude" }), deps);
      expect(deps.post).toHaveBeenCalledWith("/ingest", expect.objectContaining({ session_id: "tree-root", client: "claude" }));
    });
  });
});
