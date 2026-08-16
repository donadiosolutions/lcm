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
vi.mock("../../src/hooks/config.js", () => ({
  loadHookConfig: vi.fn().mockReturnValue({ daemonPort: 3737, storage: { backend: "sqlite" }, security: { sensitivePatterns: [] } }),
}));
vi.mock("../../src/bootstrap.js", () => ({
  ensureBootstrapped: vi.fn().mockResolvedValue(true),
  ensureCoreEndpoint: vi.fn().mockResolvedValue({ connected: true, port: 3737 }),
}));

import { validateAndFixHooks } from "../../src/hooks/auto-heal.js";
import { dispatchHook, isHookCommand } from "../../src/hooks/dispatch.js";
import { ensureBootstrapped, ensureCoreEndpoint } from "../../src/bootstrap.js";

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
import { loadHookConfig, type HookConfig } from "../../src/hooks/config.js";
import type { StorageBackendSelection } from "../../src/storage/backend.js";

const sqliteStorage: StorageBackendSelection = { backend: "sqlite" };

function configWithDaemon(
  daemon: { port?: number },
  storage: StorageBackendSelection = sqliteStorage,
): HookConfig {
  return {
    daemonPort: daemon.port ?? 3737,
    storage,
    security: { sensitivePatterns: [] },
  };
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

  it("does not repair hook settings before UserPromptSubmit owns durable enqueue", async () => {
    vi.mocked(validateAndFixHooks).mockClear();
    vi.mocked(handleUserPromptSubmit).mockResolvedValue({ exitCode: 0, stdout: "" });

    await dispatchHook("user-prompt", JSON.stringify({
      session_id: "test-session",
      prompt: "remember this",
    }));

    expect(validateAndFixHooks).not.toHaveBeenCalled();
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
      sqliteStorage,
    );
  });

  it("dispatches each command to its correct handler", async () => {
    const mapping = [
      ["compact", handlePreCompact],
      ["restore", handleSessionStart],
      ["session-end", handleSessionEnd],
    ] as const;
    for (const [cmd, handler] of mapping) {
      vi.mocked(handler).mockClear();
      await dispatchHook(cmd, '{"test":true}');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('{"test":true}', expect.anything(), expect.any(Number), sqliteStorage);
    }

    vi.mocked(handleUserPromptSubmit).mockClear();
    await dispatchHook("user-prompt", '{"test":true}');
    expect(handleUserPromptSubmit).toHaveBeenCalledTimes(1);
    expect(handleUserPromptSubmit).toHaveBeenCalledWith('{"test":true}');

    // session-snapshot takes only (stdinText, deps?) — no client/port
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", '{"test":true}');
    expect(handleSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(handleSessionSnapshot).toHaveBeenCalledWith('{"test":true}');
  });

  it("passes the trusted transport to UserPromptSubmit", async () => {
    vi.mocked(handleUserPromptSubmit).mockClear();
    await dispatchHook("user-prompt", '{"prompt":"remember"}', { transport: "cli" });
    expect(handleUserPromptSubmit).toHaveBeenCalledWith(
      '{"prompt":"remember"}',
      undefined,
      undefined,
      undefined,
      "cli",
    );
  });

  it("propagates the configured PostgreSQL backend to every backend-aware handler", async () => {
    const postgresqlStorage: StorageBackendSelection = { backend: "postgresql" };
    const mapping = [
      ["compact", handlePreCompact],
      ["restore", handleSessionStart],
      ["session-end", handleSessionEnd],
    ] as const;
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }, postgresqlStorage));

    try {
      for (const [cmd, handler] of mapping) {
        vi.mocked(handler).mockClear();
        await dispatchHook(cmd, '{"test":true}');
        expect(handler).toHaveBeenCalledWith(
          '{"test":true}',
          expect.anything(),
          3737,
          postgresqlStorage,
        );
      }
      vi.mocked(handleUserPromptSubmit).mockClear();
      await dispatchHook("user-prompt", '{"test":true}');
      expect(handleUserPromptSubmit).toHaveBeenCalledWith('{"test":true}');
    } finally {
      vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
    }
  });

  it("passes configured port to handlers", async () => {
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 9999 }));
    vi.mocked(handlePreCompact).mockClear();
    await dispatchHook("compact", "{}");
    expect(handlePreCompact).toHaveBeenCalledWith("{}", expect.anything(), 9999, sqliteStorage);
    // Reset to default
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
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

  it("lets UserPromptSubmit persist its outbox before daemon bootstrap", async () => {
    vi.mocked(handleUserPromptSubmit).mockResolvedValue({ exitCode: 0, stdout: "" });
    vi.mocked(handleUserPromptSubmit).mockClear();
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("user-prompt", JSON.stringify({ session_id: "test-sess-123", prompt: "remember this" }));
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
    expect(handleUserPromptSubmit).toHaveBeenCalledOnce();
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
    if (mode === "throw") vi.mocked(ensureCoreEndpoint).mockRejectedValueOnce(new Error("bootstrap failed"));
    else vi.mocked(ensureCoreEndpoint).mockResolvedValueOnce({ connected: false, port: 3737 });
    await expect(dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }))).resolves.toEqual({ exitCode: 0, stdout: "" });
    expect(handleSessionSnapshot).not.toHaveBeenCalled();
  });

  it("reverifies snapshot identity even when the session was already bootstrapped", async () => {
    vi.mocked(ensureBootstrapped).mockClear();
    vi.mocked(ensureCoreEndpoint).mockClear();
    await dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }));
    expect(ensureCoreEndpoint).toHaveBeenCalledOnce();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("binds snapshot dispatch to the verified port when configuration changes afterward", async () => {
    vi.mocked(ensureCoreEndpoint).mockResolvedValueOnce({ connected: true, port: 3737 });
    vi.mocked(loadHookConfig).mockReturnValueOnce(configWithDaemon({ port: 9999 }));
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }));
    expect(handleSessionSnapshot).toHaveBeenCalledWith(expect.any(String), { verifiedPort: 3737 });
  });

  it("routes post-tool without calling ensureBootstrapped", async () => {
    vi.mocked(loadHookConfig).mockReturnValueOnce(configWithDaemon({ port: 4545 }));
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

  it("preserves the top-level Codex client for direct post-tool dispatch", async () => {
    const payload = JSON.stringify({
      client: "codex",
      session_id: "test",
      tool_name: "functions.exec",
      tool_input: { command: "git branch capture-test" },
    });
    vi.mocked(handlePostToolUse).mockClear();

    await dispatchHook("post-tool", payload);

    expect(handlePostToolUse).toHaveBeenCalledWith(payload);
  });

  it("ignores daemon_port from post-tool payload without loading config", async () => {
    vi.mocked(handlePostToolUse).mockClear();
    vi.mocked(loadHookConfig).mockClear();

    await dispatchHook("post-tool", JSON.stringify({
      session_id: "test",
      tool_name: "Read",
      daemon_port: 4546,
      tool_input: { file_path: "/test.ts" },
    }));

    expect(handlePostToolUse).toHaveBeenCalledWith(expect.any(String));
    expect(loadHookConfig).not.toHaveBeenCalled();
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
    vi.mocked(loadHookConfig).mockClear();
    await dispatchHook("post-tool", "{}");
    expect(handlePostToolUse).toHaveBeenCalledWith("{}");
    expect(loadHookConfig).not.toHaveBeenCalled();
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
    vi.mocked(loadHookConfig).mockReturnValueOnce(configWithDaemon({}));
    await dispatchHook("restore", "");
    expect(handleSessionStart).toHaveBeenCalledWith("", expect.anything(), 3737, sqliteStorage);
    await dispatchHook("post-tool", "");
    expect(handlePostToolUse).toHaveBeenCalled();
    vi.mocked(loadHookConfig).mockReturnValueOnce({} as unknown as HookConfig);
    await dispatchHook("post-tool", "{}");
    expect(handlePostToolUse).toHaveBeenCalledWith("{}");
  });
});
