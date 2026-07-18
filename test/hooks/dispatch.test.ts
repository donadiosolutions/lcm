import { describe, it, expect, vi } from "vitest";
import { HOOK_COMMANDS, type HookCommand } from "../../src/hooks/dispatch.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock auto-heal to verify it's called
vi.mock("../../src/hooks/auto-heal.js", () => ({
  validateAndFixHooks: vi.fn(),
}));

// Mock all handler modules to avoid real daemon connections
vi.mock("../../src/hooks/compact.js", () => ({
  handlePreCompact: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/restore.js", () => ({
  handleSessionStart: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/session-end.js", () => ({
  handleSessionEnd: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/user-prompt.js", () => ({
  handleUserPromptSubmit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/session-snapshot.js", () => ({
  handleSessionSnapshot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/post-tool.js", () => ({
  handlePostToolUse: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ daemon: { port: 3737 } }),
}));
vi.mock("../../src/bootstrap.js", () => ({
  ensureBootstrapped: vi.fn().mockResolvedValue(true),
  ensureCore: vi.fn().mockResolvedValue(true),
}));

import { validateAndFixHooks } from "../../src/hooks/auto-heal.js";
import { dispatchHook, isHookCommand } from "../../src/hooks/dispatch.js";
import { ensureBootstrapped, ensureCore } from "../../src/bootstrap.js";

describe("HOOK_COMMANDS", () => {
  it("has an entry for every REQUIRED_HOOKS event", () => {
    const commandToEvent: Record<string, string> = {
      "compact": "PreCompact",
      "post-tool": "PostToolUse",
      "restore": "SessionStart",
      "session-end": "SessionEnd",
      "session-snapshot": "Stop",
      "user-prompt": "UserPromptSubmit",
    };
    for (const cmd of HOOK_COMMANDS) {
      expect(commandToEvent[cmd]).toBeDefined();
    }
    for (const { event } of REQUIRED_HOOKS) {
      const cmd = Object.entries(commandToEvent).find(([, e]) => e === event)?.[0];
      expect(HOOK_COMMANDS).toContain(cmd);
    }
  });
});

import { handlePreCompact } from "../../src/hooks/compact.js";
import { handleSessionStart } from "../../src/hooks/restore.js";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";
import { handleSessionSnapshot } from "../../src/hooks/session-snapshot.js";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

function configWithDaemon(daemon: { port?: number }): ReturnType<typeof loadDaemonConfig> {
  // Dispatch only reads daemon.port; the typed fixture intentionally omits unrelated config sections.
  return { daemon } as unknown as ReturnType<typeof loadDaemonConfig>;
}

describe("dispatchHook", () => {
  it("calls validateAndFixHooks before every handler", async () => {
    const callOrder: string[] = [];
    vi.mocked(validateAndFixHooks).mockImplementation(() => { callOrder.push("heal"); });
    vi.mocked(handlePreCompact).mockImplementation(async () => { callOrder.push("handler"); return { exitCode: 0, stdout: "" }; });

    callOrder.length = 0;
    await dispatchHook("compact", "{}");
    expect(callOrder).toEqual(["heal", "handler"]);
  });

  it("skips validateAndFixHooks for Codex hook payloads", async () => {
    vi.mocked(validateAndFixHooks).mockClear();
    vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });

    await dispatchHook("compact", JSON.stringify({ client: "codex" }));

    expect(validateAndFixHooks).not.toHaveBeenCalled();
    expect(handlePreCompact).toHaveBeenCalledWith(
      JSON.stringify({ client: "codex" }),
      expect.anything(),
      expect.any(Number),
    );
  });

  it("dispatches each command to its correct handler", async () => {
    const mapping = [
      ["compact", handlePreCompact],
      ["restore", handleSessionStart],
      ["session-end", handleSessionEnd],
      ["user-prompt", handleUserPromptSubmit],
    ] as const;
    for (const [cmd, handler] of mapping) {
      vi.mocked(handler).mockClear();
      await dispatchHook(cmd, '{"test":true}');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('{"test":true}', expect.anything(), expect.any(Number));
    }

    // session-snapshot takes only (stdinText, deps?) — no client/port
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", '{"test":true}');
    expect(handleSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(handleSessionSnapshot).toHaveBeenCalledWith('{"test":true}');
  });

  it("passes configured port to handlers", async () => {
    vi.mocked(loadDaemonConfig).mockReturnValue(configWithDaemon({ port: 9999 }));
    vi.mocked(handlePreCompact).mockClear();
    await dispatchHook("compact", "{}");
    expect(handlePreCompact).toHaveBeenCalledWith("{}", expect.anything(), 9999);
    // Reset to default
    vi.mocked(loadDaemonConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
  });

  it("calls ensureBootstrapped with session_id before dispatching non-compact hooks", async () => {
    vi.mocked(handleSessionStart).mockResolvedValue({ exitCode: 0, stdout: "" });
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("restore", JSON.stringify({ session_id: "test-sess-123" }));
    expect(ensureBootstrapped).toHaveBeenCalledWith("test-sess-123");
  });

  it("skips ensureBootstrapped for compact (daemon already running at PreCompact time)", async () => {
    vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("compact", JSON.stringify({ session_id: "test-sess-123" }));
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("does not block hooks if ensureBootstrapped throws", async () => {
    vi.mocked(ensureBootstrapped).mockRejectedValueOnce(new Error("bootstrap failed"));
    vi.mocked(handleSessionStart).mockResolvedValue({ exitCode: 0, stdout: "" });
    const result = await dispatchHook("restore", JSON.stringify({ session_id: "s1" }));
    expect(result.exitCode).toBe(0);
  });

  it("retains best-effort dispatch for non-snapshot hooks when bootstrap is unverified", async () => {
    vi.mocked(ensureBootstrapped).mockResolvedValueOnce(false);
    vi.mocked(handleSessionStart).mockClear();
    await dispatchHook("restore", JSON.stringify({ session_id: "s1" }));
    expect(handleSessionStart).toHaveBeenCalledOnce();
  });

  it.each([false, "throw"] as const)("does not dispatch snapshots when bootstrap verification is %s", async (mode) => {
    vi.mocked(handleSessionSnapshot).mockClear();
    if (mode === "throw") vi.mocked(ensureCore).mockRejectedValueOnce(new Error("bootstrap failed"));
    else vi.mocked(ensureCore).mockResolvedValueOnce(false);
    await expect(dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }))).resolves.toEqual({ exitCode: 0, stdout: "" });
    expect(handleSessionSnapshot).not.toHaveBeenCalled();
  });

  it("reverifies snapshot identity even when the session was already bootstrapped", async () => {
    vi.mocked(ensureBootstrapped).mockClear();
    vi.mocked(ensureCore).mockClear();
    await dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }));
    expect(ensureCore).toHaveBeenCalledOnce();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("routes post-tool without calling ensureBootstrapped", async () => {
    vi.mocked(loadDaemonConfig).mockReturnValueOnce(configWithDaemon({ port: 4545 }));
    vi.mocked(handlePostToolUse).mockClear();
    vi.mocked(ensureBootstrapped).mockClear();
    const result = await dispatchHook("post-tool", JSON.stringify({
      session_id: "test",
      tool_name: "Read",
      tool_input: { file_path: "/test.ts" },
    }));
    expect(result.exitCode).toBe(0);
    expect(handlePostToolUse).toHaveBeenCalledTimes(1);
    expect(handlePostToolUse).toHaveBeenCalledWith(expect.any(String));
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("ignores daemon_port from post-tool payload without loading config", async () => {
    vi.mocked(handlePostToolUse).mockClear();
    vi.mocked(loadDaemonConfig).mockClear();

    await dispatchHook("post-tool", JSON.stringify({
      session_id: "test",
      tool_name: "Read",
      daemon_port: 4546,
      tool_input: { file_path: "/test.ts" },
    }));

    expect(handlePostToolUse).toHaveBeenCalledWith(expect.any(String));
    expect(loadDaemonConfig).not.toHaveBeenCalled();
  });

  it("recognizes post-tool as a valid hook command", () => {
    expect(isHookCommand("post-tool")).toBe(true);
    expect(isHookCommand("invalid")).toBe(false);
  });

  it.each([0, 65536, 1.5, "4545"])("rejects invalid payload port %j", async (daemon_port) => {
    vi.mocked(handlePostToolUse).mockClear();
    await dispatchHook("post-tool", JSON.stringify({ daemon_port }));
    expect(handlePostToolUse).toHaveBeenCalledWith(expect.any(String));
  });

  it("uses config fallback for malformed post-tool JSON", async () => {
    await dispatchHook("post-tool", "not json");
    expect(handlePostToolUse).toHaveBeenCalledWith("not json");
  });

  it("does not load daemon config for post-tool dispatch", async () => {
    vi.mocked(loadDaemonConfig).mockClear();
    await dispatchHook("post-tool", "{}");
    expect(handlePostToolUse).toHaveBeenCalledWith("{}");
    expect(loadDaemonConfig).not.toHaveBeenCalled();
  });

  it("skips bootstrap when the payload has no session or malformed JSON", async () => {
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("restore", "{}");
    await dispatchHook("restore", "not json");
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("uses the environment client when the payload client is absent or malformed", async () => {
    const previous = process.env.LCM_CLIENT;
    process.env.LCM_CLIENT = "codex";
    vi.mocked(validateAndFixHooks).mockClear();
    try {
      await dispatchHook("compact", "not json");
      expect(validateAndFixHooks).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.LCM_CLIENT;
      else process.env.LCM_CLIENT = previous;
    }
  });

  it("rejects an impossible hook command defensively", async () => {
    // Deliberately cross the public type boundary to exercise the defensive runtime default.
    const invalidCommand = "invalid" as HookCommand;
    await expect(dispatchHook(invalidCommand, "{}")).rejects.toThrow("Unknown hook command: invalid");
  });

  it("handles empty hook payloads and a config without a daemon port", async () => {
    vi.mocked(loadDaemonConfig).mockReturnValueOnce(configWithDaemon({}));
    await dispatchHook("restore", "");
    expect(handleSessionStart).toHaveBeenCalledWith("", expect.anything(), 3737);
    await dispatchHook("post-tool", "");
    expect(handlePostToolUse).toHaveBeenCalled();
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({} as unknown as ReturnType<typeof loadDaemonConfig>);
    await dispatchHook("post-tool", "{}");
    expect(handlePostToolUse).toHaveBeenCalledWith("{}");
  });
});
