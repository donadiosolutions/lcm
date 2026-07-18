import { describe, it, expect, vi } from "vitest";
import { handlePreCompact } from "../../src/hooks/compact.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);

describe("handlePreCompact", () => {
  it("returns exitCode 0 and summary when daemon healthy", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn().mockResolvedValue({ summary: "Compacted 500 tokens" }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Compacted");
    expect(client.post).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({ client: "claude" }),
    );
  });

  it("emits latestSummaryContent truncated to 2000 chars when present", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const longContent = "x".repeat(3000);
    const client = { health: vi.fn(), post: vi.fn().mockResolvedValue({ summary: "Summary", latestSummaryContent: longContent }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summary");
    expect(result.stdout).toContain("[truncated]");
    expect(result.stdout.length).toBeLessThan(longContent.length);
  });

  it("returns exitCode 0 when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handlePreCompact("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("joins a short latest summary without a primary summary", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { post: vi.fn().mockResolvedValue({ summary: "", latestSummaryContent: "latest" }) };
    const result = await handlePreCompact(JSON.stringify({ client: "codex" }), client as any, 4545);
    expect(result.stdout).toBe("latest");
  });

  it("fails open on malformed input or daemon request errors", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { post: vi.fn().mockRejectedValue(new Error("failed")) };
    await expect(handlePreCompact("not json", client as any)).resolves.toEqual({ exitCode: 0, stdout: "" });
  });

  it("accepts empty stdin and defaults the daemon port", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { post: vi.fn().mockResolvedValue({ summary: "done" }) };
    expect((await handlePreCompact("", client as any)).stdout).toBe("done");
  });
});
