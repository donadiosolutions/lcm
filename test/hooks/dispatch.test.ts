import { afterEach, describe, it, expect, vi } from "vitest";
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
vi.mock("../../src/hooks/terminal-snapshot.js", () => ({
  handleTerminalSnapshot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/post-tool.js", () => ({
  handlePostToolUse: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/pre-tool.js", () => ({
  handlePreToolUse: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock("../../src/hooks/config.js", () => ({
  loadHookConfig: vi.fn().mockReturnValue({ daemonPort: 3737, storage: { backend: "sqlite" }, security: { sensitivePatterns: [] } }),
}));
vi.mock("../../src/hooks/hook-errors.js", () => ({
  safeLogError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/bootstrap.js", () => ({
  ensureBootstrapped: vi.fn().mockResolvedValue(true),
  ensureCoreEndpoint: vi.fn().mockResolvedValue({ connected: true, port: 3737 }),
}));

import { validateAndFixHooks } from "../../src/hooks/auto-heal.js";
import { dispatchHook, isHookCommand } from "../../src/hooks/dispatch.js";
import { ensureBootstrapped, ensureCoreEndpoint } from "../../src/bootstrap.js";
import { safeLogError } from "../../src/hooks/hook-errors.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { hookAdmissionRetry } from "../../src/hooks/publication-fence.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

describe("HOOK_COMMANDS", () => {
  it("has an entry for every REQUIRED_HOOKS event", () => {
    const commandToEvent: Record<string, string> = {
      "compact": "PreCompact",
      "post-tool": "PostToolUse",
      "pre-tool": "PreToolUse",
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
import { handlePreToolUse } from "../../src/hooks/pre-tool.js";
import { handleTerminalSnapshot } from "../../src/hooks/terminal-snapshot.js";
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
      expect.any(Function),
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
      expect(handler).toHaveBeenCalledWith(
        '{"test":true}',
        expect.anything(),
        expect.any(Number),
        sqliteStorage,
        expect.any(Function),
      );
    }

    vi.mocked(handleUserPromptSubmit).mockClear();
    await dispatchHook("user-prompt", '{"test":true}');
    expect(handleUserPromptSubmit).toHaveBeenCalledTimes(1);
    expect(handleUserPromptSubmit).toHaveBeenCalledWith('{"test":true}');

    // session-snapshot takes only (stdinText, deps?) — no client/port
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", '{"test":true}');
    expect(handleSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(handleSessionSnapshot).toHaveBeenCalledWith('{"test":true}', { admissionRetry: expect.any(Function) });
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
          expect.any(Function),
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
    expect(handlePreCompact).toHaveBeenCalledWith("{}", expect.anything(), 9999, sqliteStorage, expect.any(Function));
    // Reset to default
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
  });

  it("calls ensureBootstrapped with session_id before dispatching non-compact hooks", async () => {
    vi.mocked(handleSessionStart).mockResolvedValue({ exitCode: 0, stdout: "" });
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("restore", JSON.stringify({ session_id: "test-sess-123" }));
    expect(ensureBootstrapped).toHaveBeenCalledWith("test-sess-123", undefined, expect.any(Function));
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

  it("hands a terminal snapshot straight to its handler without bootstrap, repair or Stop-hook work", async () => {
    vi.mocked(ensureBootstrapped).mockClear();
    vi.mocked(ensureCoreEndpoint).mockClear();
    vi.mocked(validateAndFixHooks).mockClear();
    vi.mocked(handleSessionSnapshot).mockClear();
    vi.mocked(loadHookConfig).mockClear();
    const terminal = { deadline: { openPhase: vi.fn(), outcomeBudgetMs: vi.fn() } };
    const stdin = JSON.stringify({ session_id: "s1", hook_event_name: "Interrupt" });

    await expect(dispatchHook("session-snapshot", stdin, { terminal })).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(handleTerminalSnapshot).toHaveBeenCalledWith(stdin, terminal);
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(validateAndFixHooks).not.toHaveBeenCalled();
    expect(handleSessionSnapshot).not.toHaveBeenCalled();
    expect(loadHookConfig).not.toHaveBeenCalled();
  });

  it("reverifies snapshot identity even when the session was already bootstrapped", async () => {
    vi.mocked(ensureBootstrapped).mockClear();
    vi.mocked(ensureCoreEndpoint).mockClear();
    await dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }));
    expect(ensureCoreEndpoint).toHaveBeenCalledOnce();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("verifies the endpoint for a Codex child snapshot that lacks the tree session_id", async () => {
    vi.mocked(ensureCoreEndpoint).mockClear();
    vi.mocked(ensureCoreEndpoint).mockResolvedValueOnce({ connected: true, port: 4242 });
    vi.mocked(handleSessionSnapshot).mockClear();
    const stdin = JSON.stringify({ client: "codex", agent_id: "child-thread" });
    await dispatchHook("session-snapshot", stdin);
    expect(ensureCoreEndpoint).toHaveBeenCalledOnce();
    expect(handleSessionSnapshot).toHaveBeenCalledWith(stdin, { verifiedPort: 4242, admissionRetry: expect.any(Function) });
  });

  it("binds snapshot dispatch to the verified port when configuration changes afterward", async () => {
    vi.mocked(ensureCoreEndpoint).mockResolvedValueOnce({ connected: true, port: 3737 });
    vi.mocked(loadHookConfig).mockClear();
    vi.mocked(loadHookConfig).mockReturnValueOnce(configWithDaemon({ port: 9999 }));
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", JSON.stringify({ session_id: "s1" }));
    expect(handleSessionSnapshot).toHaveBeenCalledWith(expect.any(String), { verifiedPort: 3737, admissionRetry: expect.any(Function) });
    // The unused queued value must not leak into later tests.
    expect(loadHookConfig).not.toHaveBeenCalled();
    vi.mocked(loadHookConfig).mockReset();
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
  });

  it("dispatches session-snapshot without loading the publication-locked config", async () => {
    vi.mocked(loadHookConfig).mockClear();
    vi.mocked(loadHookConfig).mockImplementationOnce(() => {
      throw new PrivateMutationLockContentionError("publication lock is busy");
    });
    vi.mocked(handleSessionSnapshot).mockClear();
    try {
      await expect(dispatchHook("session-snapshot", "{}")).resolves.toEqual({ exitCode: 0, stdout: "" });
      expect(loadHookConfig).not.toHaveBeenCalled();
      expect(handleSessionSnapshot).toHaveBeenCalledWith("{}", { admissionRetry: expect.any(Function) });
    } finally {
      vi.mocked(loadHookConfig).mockReset();
      vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
    }
  });

  it("still repairs non-Codex hook settings before dispatching session-snapshot", async () => {
    const callOrder: string[] = [];
    vi.mocked(validateAndFixHooks).mockImplementation(() => { callOrder.push("heal"); });
    vi.mocked(handleSessionSnapshot).mockImplementation(async () => { callOrder.push("handler"); return { exitCode: 0, stdout: "" }; });
    try {
      await dispatchHook("session-snapshot", "{}");
      expect(callOrder).toEqual(["heal", "handler"]);
    } finally {
      vi.mocked(validateAndFixHooks).mockReset();
      vi.mocked(handleSessionSnapshot).mockReset();
      vi.mocked(handleSessionSnapshot).mockResolvedValue({ exitCode: 0, stdout: "" });
    }
  });

  describe("publication-lock contention while loading the hook config", () => {
    const handlers = [
      ["compact", "PreCompact", handlePreCompact],
      ["restore", "SessionStart", handleSessionStart],
      ["session-end", "SessionEnd", handleSessionEnd],
    ] as const;

    it.each(handlers)("returns a best-effort exit 0 for %s without calling its handler", async (cmd, event, handler) => {
      const contention = new PrivateMutationLockContentionError("publication lock is busy");
      vi.mocked(loadHookConfig).mockImplementationOnce(() => { throw contention; });
      vi.mocked(handler).mockClear();
      vi.mocked(safeLogError).mockClear();

      await expect(dispatchHook(cmd, "{}")).resolves.toEqual({ exitCode: 0, stdout: "" });

      expect(handler).not.toHaveBeenCalled();
      expect(safeLogError).toHaveBeenCalledWith(event, contention, {});
    });

    it.each(handlers)("awaits the contention log before returning for %s", async (cmd) => {
      let logged = false;
      vi.mocked(loadHookConfig).mockImplementationOnce(() => {
        throw new PrivateMutationLockContentionError("publication lock is busy");
      });
      vi.mocked(safeLogError).mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        logged = true;
      });

      await dispatchHook(cmd, "{}");

      expect(logged).toBe(true);
    });

    it.each(handlers)("propagates a publication journal error for %s", async (cmd, _event, handler) => {
      const journal = new BackendPublicationJournalError("malformed-journal", "evidence is malformed");
      vi.mocked(loadHookConfig).mockImplementationOnce(() => { throw journal; });
      vi.mocked(handler).mockClear();
      vi.mocked(safeLogError).mockClear();

      await expect(dispatchHook(cmd, "{}")).rejects.toBe(journal);

      expect(handler).not.toHaveBeenCalled();
      expect(safeLogError).not.toHaveBeenCalled();
    });

    it.each(handlers)("propagates an unrelated config error for %s", async (cmd, _event, handler) => {
      const failure = new Error("config unreadable");
      vi.mocked(loadHookConfig).mockImplementationOnce(() => { throw failure; });
      vi.mocked(handler).mockClear();
      vi.mocked(safeLogError).mockClear();

      await expect(dispatchHook(cmd, "{}")).rejects.toBe(failure);

      expect(handler).not.toHaveBeenCalled();
      expect(safeLogError).not.toHaveBeenCalled();
    });
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

  it("routes pre-tool straight to its handler without bootstrap, repair or config load", async () => {
    const payload = JSON.stringify({ session_id: "test", client: "codex", tool_name: "Bash" });
    vi.mocked(handlePreToolUse).mockClear();
    vi.mocked(ensureBootstrapped).mockClear();
    vi.mocked(ensureCoreEndpoint).mockClear();
    vi.mocked(validateAndFixHooks).mockClear();
    vi.mocked(loadHookConfig).mockClear();

    const result = await dispatchHook("pre-tool", payload);

    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(handlePreToolUse).toHaveBeenCalledTimes(1);
    expect(handlePreToolUse).toHaveBeenCalledWith(payload);
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
    expect(validateAndFixHooks).not.toHaveBeenCalled();
    expect(loadHookConfig).not.toHaveBeenCalled();
  });

  it("recognizes pre-tool as a valid hook command", () => {
    expect(isHookCommand("pre-tool")).toBe(true);
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
    expect(handleSessionStart).toHaveBeenCalledWith("", expect.anything(), 3737, sqliteStorage, expect.any(Function));
    await dispatchHook("post-tool", "");
    expect(handlePostToolUse).toHaveBeenCalled();
    vi.mocked(loadHookConfig).mockReturnValueOnce({} as unknown as HookConfig);
    await dispatchHook("post-tool", "{}");
    expect(handlePostToolUse).toHaveBeenCalledWith("{}");
  });
});

describe("LCM_ENABLED=false", () => {
  const handlers = {
    compact: handlePreCompact,
    "post-tool": handlePostToolUse,
    "pre-tool": handlePreToolUse,
    restore: handleSessionStart,
    "session-end": handleSessionEnd,
    "session-snapshot": handleSessionSnapshot,
    "user-prompt": handleUserPromptSubmit,
  } satisfies Record<HookCommand, unknown>;
  const payload = JSON.stringify({ session_id: "disabled-session", prompt: "remember this" });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(HOOK_COMMANDS)("makes %s a no-op without side effects", async (command) => {
    vi.clearAllMocks();
    vi.stubEnv("LCM_ENABLED", "false");

    await expect(dispatchHook(command, payload)).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(handlers[command]).not.toHaveBeenCalled();
    expect(validateAndFixHooks).not.toHaveBeenCalled();
    expect(loadHookConfig).not.toHaveBeenCalled();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
  });

  it("makes MCP-transport user prompts and Codex snapshots no-ops", async () => {
    vi.clearAllMocks();
    vi.stubEnv("LCM_ENABLED", "false");

    await expect(dispatchHook("user-prompt", payload, { transport: "mcp" })).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(
      dispatchHook("session-snapshot", JSON.stringify({ session_id: "disabled-session", client: "codex" })),
    ).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(handleUserPromptSubmit).not.toHaveBeenCalled();
    expect(handleSessionSnapshot).not.toHaveBeenCalled();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
    expect(loadHookConfig).not.toHaveBeenCalled();
  });

  it("makes Codex subagent restore and snapshot hooks no-ops", async () => {
    vi.clearAllMocks();
    vi.stubEnv("LCM_ENABLED", "false");
    const subagent = JSON.stringify({
      session_id: "tree-root",
      agent_id: "child-thread",
      agent_transcript_path: "/rollouts/child.jsonl",
      client: "codex",
    });

    await expect(dispatchHook("restore", subagent)).resolves.toEqual({ exitCode: 0, stdout: "" });
    await expect(dispatchHook("session-snapshot", subagent)).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(handleSessionStart).not.toHaveBeenCalled();
    expect(handleSessionSnapshot).not.toHaveBeenCalled();
    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(ensureCoreEndpoint).not.toHaveBeenCalled();
    expect(loadHookConfig).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "False"])("keeps hooks enabled when LCM_ENABLED is %j", async (value) => {
    vi.clearAllMocks();
    if (value === undefined) vi.stubEnv("LCM_ENABLED", undefined);
    else vi.stubEnv("LCM_ENABLED", value);

    await dispatchHook("restore", payload);

    expect(ensureBootstrapped).toHaveBeenCalledWith("disabled-session", undefined, expect.any(Function));
    expect(handleSessionStart).toHaveBeenCalledOnce();
  });
});

describe("dispatchHook waiting for a live publication-lock owner", () => {
  const liveContention = (): PrivateMutationLockContentionError => new PrivateMutationLockContentionError(
    "publication lock is busy",
    {
      contendedLock: {
        path: "/lcm/publication.lock",
        owner: { version: 1, pid: process.pid + 1, processStartTime: null, nonce: "owner" },
      },
    },
  );
  const noPause = async (): Promise<void> => undefined;
  const restoreInput = JSON.stringify({ session_id: "waiting-session" });

  afterEach(() => {
    vi.mocked(loadHookConfig).mockReset();
    vi.mocked(loadHookConfig).mockReturnValue(configWithDaemon({ port: 3737 }));
    vi.mocked(ensureBootstrapped).mockReset();
    vi.mocked(ensureBootstrapped).mockResolvedValue(true);
    vi.mocked(handleSessionStart).mockClear();
    vi.mocked(handleSessionSnapshot).mockClear();
  });

  it.each([
    ["compact", handlePreCompact],
    ["restore", handleSessionStart],
  ] as const)("loads the %s config after the owner releases the lock", async (cmd, handler) => {
    vi.mocked(handler).mockClear();
    vi.mocked(loadHookConfig).mockClear();
    vi.mocked(loadHookConfig)
      .mockImplementationOnce(() => { throw liveContention(); })
      .mockImplementationOnce(() => { throw liveContention(); });
    const admissionRetry = hookAdmissionRetry({ _wait: noPause });

    await dispatchHook(cmd, restoreInput, { admissionRetry });

    expect(loadHookConfig).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler).mock.calls[0]?.[4]).toBe(admissionRetry);
  });

  it("falls back to the best-effort skip once the allowance is spent", async () => {
    const contention = liveContention();
    vi.mocked(loadHookConfig).mockImplementation(() => { throw contention; });
    vi.mocked(safeLogError).mockClear();

    await expect(dispatchHook("restore", restoreInput, {
      admissionRetry: hookAdmissionRetry({ totalMs: 100, _wait: noPause }),
    })).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(loadHookConfig).toHaveBeenCalledTimes(3);
    expect(handleSessionStart).not.toHaveBeenCalled();
    expect(safeLogError).toHaveBeenCalledWith("SessionStart", contention, {});
  });

  it("shares one allowance between bootstrap and the config load", async () => {
    let bootstrapAttempts = 0;
    vi.mocked(ensureBootstrapped).mockImplementation(async (_sessionId, _deps, retry) => {
      await retry!(() => {
        bootstrapAttempts += 1;
        if (bootstrapAttempts <= 2) throw liveContention();
      });
      return true;
    });
    vi.mocked(loadHookConfig).mockImplementation(() => { throw liveContention(); });

    await dispatchHook("restore", restoreInput, {
      admissionRetry: hookAdmissionRetry({ totalMs: 150, _wait: noPause }),
    });

    // Two waits went to bootstrap, so only one is left for the config load.
    expect(bootstrapAttempts).toBe(3);
    expect(loadHookConfig).toHaveBeenCalledTimes(2);
    expect(handleSessionStart).not.toHaveBeenCalled();
  });

  it("creates the default allowance for a snapshot and hands it to the endpoint check", async () => {
    vi.mocked(ensureCoreEndpoint).mockClear();

    await dispatchHook("session-snapshot", restoreInput);

    expect(vi.mocked(ensureCoreEndpoint).mock.calls[0]?.[0]).toBeUndefined();
    const retry = vi.mocked(ensureCoreEndpoint).mock.calls[0]?.[1];
    expect(retry).toEqual(expect.any(Function));
    expect(vi.mocked(handleSessionSnapshot).mock.calls[0]?.[1]).toMatchObject({ admissionRetry: retry });
  });

  it("gives session-end a much smaller allowance than the 5 second default", async () => {
    vi.mocked(handleSessionEnd).mockClear();
    vi.mocked(loadHookConfig).mockImplementation(() => { throw liveContention(); });
    const waits: number[] = [];
    // Real wait budget, recorded waits: the default allowance is created by dispatch itself.
    const publicationFence = await import("../../src/hooks/publication-fence.js");
    expect(publicationFence.HOOK_SESSION_END_CONTENTION_WAIT_MS).toBeLessThan(publicationFence.HOOK_CONTENTION_WAIT_MS / 10);

    await expect(dispatchHook("session-end", restoreInput, {
      admissionRetry: hookAdmissionRetry({
        totalMs: publicationFence.HOOK_SESSION_END_CONTENTION_WAIT_MS,
        _wait: async (milliseconds) => { waits.push(milliseconds); },
      }),
    })).resolves.toEqual({ exitCode: 0, stdout: "" });

    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(300);
    expect(handleSessionEnd).not.toHaveBeenCalled();
  });

  it("creates its own allowance when the caller supplies none", async () => {
    vi.mocked(handleSessionEnd).mockClear();
    await dispatchHook("session-end", restoreInput);
    expect(vi.mocked(handleSessionEnd).mock.calls[0]?.[4]).toEqual(expect.any(Function));
  });
});
