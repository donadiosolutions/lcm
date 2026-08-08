import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotDeps } from "../../src/hooks/session-snapshot.js";

vi.mock("../../src/hooks/publication-fence.js", () => ({
  assertHookPublicationFence: vi.fn(),
  assertHookRootEstablished: vi.fn(),
  isBackendPublicationJournalError: () => false,
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
});
