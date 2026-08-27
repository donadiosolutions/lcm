import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";
import { createAbortError, isAbortError } from "../../src/daemon/cancellation.js";

type SpawnFn = typeof import("node:child_process").spawn;

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(exitCode = 0, output = "summary text", stderr = ""): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.write(output);
    child.stdout.end();
    if (stderr) child.stderr.end(stderr);
    child.emit("close", exitCode);
  });
  return child;
}

function makeHangingChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => { throw new Error("already exited"); });
  return child;
}

function makeErrorChild(error: unknown): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("error", error));
  return child;
}

describe("createClaudeProcessSummarizer", () => {
  it("constructs with default process dependencies", () => {
    expect(createClaudeProcessSummarizer()).toBeTypeOf("function");
  });

  it("does not spawn for a pre-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn() as unknown as SpawnFn;
    const summarizer = createClaudeProcessSummarizer({ spawn });

    await expect(summarizer("text", false, { signal: controller.signal }))
      .rejects.toSatisfy(error => isAbortError(error));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("tears down an owned child on mid-request cancellation before rejecting", async () => {
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 4312;
    const controller = new AbortController();
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const killProcess = vi.fn();
    const isProcessGroupAlive = vi.fn(() => false);
    const summarizer = createClaudeProcessSummarizer({
      spawn,
      killProcess,
      processGroupId: 4312,
      daemonProcessGroupId: 9999,
      processBirthTime: () => "birth-4312",
      isProcessGroupAlive,
    } as never);

    const pending = summarizer("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();
    child.emit("close", null);

    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
    expect(killProcess).toHaveBeenCalledWith(-4312, "SIGTERM");
    expect(killProcess).not.toHaveBeenCalledWith(0, expect.anything());
  });

  it("escalates Claude cancellation from the owned group TERM to KILL and clears timers", async () => {
    vi.useFakeTimers();
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 4512;
    const controller = new AbortController();
    let groupAlive = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") groupAlive = false;
    });
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const summarizer = createClaudeProcessSummarizer({
      spawn,
      timeoutMs: 60_000,
      killProcess,
      processGroupId: 4512,
      daemonProcessGroupId: 4511,
      processBirthTime: () => "birth-4512",
      isProcessGroupAlive: () => groupAlive,
    } as never);

    try {
      const pending = summarizer("text", false, { signal: controller.signal });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      controller.abort();
      await vi.runAllTicks();
      expect(killProcess).toHaveBeenNthCalledWith(1, -4512, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(killProcess).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(killProcess).toHaveBeenNthCalledWith(2, -4512, "SIGKILL");
      child.emit("close", null);
      await expect(pending).rejects.toSatisfy(error => isAbortError(error));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a close through the owned group before resolving", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      (child as FakeChild & { pid: number }).pid = 4613;
      let groupAlive = true;
      const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") groupAlive = false;
      });
      const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
      const summarizer = createClaudeProcessSummarizer({
        spawn,
        timeoutMs: 60_000,
        killProcess,
        processGroupId: 4613,
        daemonProcessGroupId: 4612,
        processBirthTime: () => "birth-4613",
        isProcessGroupAlive: () => groupAlive,
      } as never);

      const pending = summarizer("text", false);
      const observed = pending.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.stdout.write("summary text");
      child.emit("close", 0);
      await vi.runAllTicks();
      expect(killProcess).toHaveBeenNthCalledWith(1, -4613, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1_999);
      expect(killProcess).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(killProcess).toHaveBeenNthCalledWith(2, -4613, "SIGKILL");
      await expect(observed).resolves.toEqual({ value: "summary text" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps close and abort on one teardown flight", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      (child as FakeChild & { pid: number }).pid = 4614;
      let groupAlive = true;
      const controller = new AbortController();
      const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") groupAlive = false;
      });
      const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
      const summarizer = createClaudeProcessSummarizer({
        spawn,
        timeoutMs: 60_000,
        killProcess,
        processGroupId: 4614,
        daemonProcessGroupId: 4613,
        processBirthTime: () => "birth-4614",
        isProcessGroupAlive: () => groupAlive,
      } as never);

      const pending = summarizer("text", false, { signal: controller.signal });
      const observed = pending.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.emit("close", 0);
      controller.abort();
      await vi.runAllTicks();
      expect(killProcess).toHaveBeenCalledTimes(1);
      expect(killProcess).toHaveBeenCalledWith(-4614, "SIGTERM");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(isAbortError((await observed).error)).toBe(true);
      expect(killProcess).toHaveBeenCalledWith(-4614, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes asynchronous Claude stdin errors through teardown", async () => {
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 4615;
    const killProcess = vi.fn();
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const summarizer = createClaudeProcessSummarizer({
      spawn,
      killProcess,
      processGroupId: 4615,
      daemonProcessGroupId: 4613,
      processBirthTime: () => "birth-4615",
      isProcessGroupAlive: () => false,
    } as never);

    const pending = summarizer("private transcript", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdin.emit("error", Object.assign(new Error("write EPIPE secret-body"), { code: "EPIPE" }));
    await expect(pending).rejects.toThrow(/stdin/i);
    expect(killProcess).toHaveBeenCalledWith(-4615, "SIGTERM");

    child.stdin.emit("error", new Error("late stdin error"));
    child.emit("error", new Error("late child error"));
    child.emit("close", 0);
  });

  it("normalizes teardown construction failures", async () => {
    const child = makeHangingChild();
    child.once = vi.fn(() => { throw new Error("teardown setup failed"); }) as never;
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("teardown setup failed");
  });

  it("rejects after retaining a witness when witness removal fails", async () => {
    const child = makeChild(0, "summary text");
    (child as FakeChild & { pid: number }).pid = 4616;
    const removalError = new Error("witness remove failed");
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw removalError; }),
      path: "/tmp/daemon-runtime.json",
    };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
      platform: "win32",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      witnessStore,
      processBirthTime: () => "birth-4616",
    } as never);
    await expect(summarizer("text", false)).rejects.toThrow("witness remove failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
  });

  it("fails closed after the bounded Claude KILL settlement deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      (child as FakeChild & { pid: number }).pid = 4617;
      const killProcess = vi.fn();
      const controller = new AbortController();
      const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
      const summarizer = createClaudeProcessSummarizer({
        spawn,
        timeoutMs: 60_000,
        killProcess,
        processGroupId: 4617,
        daemonProcessGroupId: 4611,
        processBirthTime: () => "birth-4617",
        isProcessGroupAlive: () => true,
      } as never);
      const pending = summarizer("text", false, { signal: controller.signal });
      const observed = pending.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await observed;
      expect(result.error).toMatchObject({ message: "The operation was aborted" });
      expect(killProcess).toHaveBeenNthCalledWith(1, -4617, "SIGTERM");
      expect(killProcess).toHaveBeenNthCalledWith(2, -4617, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a normal close when the owned group never disappears", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      (child as FakeChild & { pid: number }).pid = 4618;
      const killProcess = vi.fn();
      const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
      const summarizer = createClaudeProcessSummarizer({
        spawn,
        killProcess,
        processGroupId: 4618,
        daemonProcessGroupId: 4611,
        processBirthTime: () => "birth-4618",
        isProcessGroupAlive: () => true,
      } as never);
      const pending = summarizer("text", false);
      const observed = pending.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.stdout.write("summary text");
      child.emit("close", 0);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await observed).error).toMatchObject({ message: "claude process teardown did not settle" });
      expect(killProcess).toHaveBeenNthCalledWith(1, -4618, "SIGTERM");
      expect(killProcess).toHaveBeenNthCalledWith(2, -4618, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects after witness publication fails and still tears down the child", async () => {
    const child = makeChild(0, "summary text");
    (child as FakeChild & { pid: number }).pid = 4619;
    const witnessError = new Error("witness add failed");
    const witnessStore = {
      add: vi.fn(() => { throw witnessError; }),
      remove: vi.fn(),
      path: "/tmp/daemon-runtime.json",
    };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
      platform: "win32",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      witnessStore,
      processBirthTime: () => "birth-4619",
    } as never);
    await expect(summarizer("text", false)).rejects.toThrow("witness add failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
  });

  it("routes an ordinary synchronous Claude stdin failure through teardown", async () => {
    const child = makeHangingChild();
    child.stdin.write = () => { throw new Error("synchronous stdin failed"); };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    });
    const pending = summarizer("text", false);
    child.emit("close", null);
    await expect(pending).rejects.toThrow("synchronous stdin failed");
  });

  it("handles an intentional synchronous Claude stdin abort", async () => {
    const child = makeHangingChild();
    child.stdin.write = () => { throw createAbortError(); };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    });
    const pending = summarizer("text", false);
    child.emit("close", null);
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("publishes and removes a secret-free Claude process witness after close", async () => {
    const child = makeChild(0, "witness summary");
    (child as FakeChild & { pid: number }).pid = 4612;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const summarizer = createClaudeProcessSummarizer({
      spawn,
      platform: "win32",
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      witnessStore,
      processBirthTime: () => "birth-4612",
    } as never);

    await expect(summarizer("text", false)).resolves.toBe("witness summary");
    expect(witnessStore.add).toHaveBeenCalledWith({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      providerId: "claude-process",
      pid: 4612,
      pgid: null,
      processStartTime: "birth-4612",
    });
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });
  it("projects a staged OAuth token into the Claude child environment without argv exposure", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-claude-credentials-"));
    const runtimeRoot = join(root, "runtime");
    const credentialsParent = join(runtimeRoot, "credentials");
    const directory = join(credentialsParent, "lcm-claude.service");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(runtimeRoot, 0o700);
    const tokenPath = join(directory, "CLAUDE_CODE_OAUTH_TOKEN");
    writeFileSync(tokenPath, "staged-token\n", { mode: 0o400 });
    chmodSync(tokenPath, 0o400);
    chmodSync(directory, 0o500);
    const spawn = vi.fn().mockReturnValue(makeChild());
    try {
      const summarizer = createClaudeProcessSummarizer({
        spawn: spawn as unknown as SpawnFn,
        environment: {
          CREDENTIALS_DIRECTORY: directory,
          XDG_RUNTIME_DIR: runtimeRoot,
          LCM_SYSTEMD_CRED_IDS: "CLAUDE_CODE_OAUTH_TOKEN",
          CLAUDE_CODE_OAUTH_TOKEN: "ambient-token",
        },
      });
      await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");
      const options = spawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("staged-token");
      expect((spawn.mock.calls[0][1] as string[]).join(" ")).not.toContain("staged-token");
    } finally {
      chmodSync(directory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not project unrelated launchd credentials into the Claude child environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-claude-launchd-credentials-"));
    const directory = join(root, "credentials");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const credentialValues = {
      CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
      OPENAI_API_KEY: "unrelated-openai-token",
      LCM_POSTGRES_URL: "postgresql://unrelated-database-secret",
    };
    const environment: Record<string, string> = { LCM_CREDENTIAL_DIRECTORY: directory };
    for (const [name, value] of Object.entries(credentialValues)) {
      const path = join(directory, name);
      writeFileSync(path, `${value}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      environment[`LCM_CREDENTIAL_${name}_FILE`] = path;
    }
    const spawn = vi.fn().mockReturnValue(makeChild());
    try {
      const summarizer = createClaudeProcessSummarizer({
        spawn: spawn as unknown as SpawnFn,
        environment,
      });
      await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");
      const childEnvironment = (spawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }).env;
      expect(childEnvironment?.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token");
      expect(childEnvironment?.OPENAI_API_KEY).toBeUndefined();
      expect(childEnvironment?.LCM_POSTGRES_URL).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("passes the configured model to the Claude CLI", async () => {
    const spawn = vi.fn().mockReturnValue(makeChild());
    const summarizer = createClaudeProcessSummarizer({
      model: "claude-sonnet-4-20250514",
      spawn: spawn as unknown as SpawnFn,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toBe("claude");
    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-20250514");
  });

  it.each([undefined, "", "   "])("uses the Haiku fallback for an empty model: %j", async (model) => {
    const spawn = vi.fn().mockReturnValue(makeChild());
    const summarizer = createClaudeProcessSummarizer({ model, spawn: spawn as unknown as SpawnFn });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--settings");
  });

  it("passes max reasoning and enabled fast mode as process-local CLI settings", async () => {
    const spawn = vi.fn().mockReturnValue(makeChild());
    const summarizer = createClaudeProcessSummarizer({
      model: "claude-opus-test",
      reasoningEffort: "max",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    expect(spawn.mock.calls[0][1]).toEqual([
      "--print",
      "--model", "claude-opus-test",
      "--no-session-persistence",
      "--system-prompt", expect.any(String),
      "--tools", "",
      "--disable-slash-commands",
      "--effort", "max",
      "--settings", JSON.stringify({ fastMode: true, fastModePerSessionOptIn: false }),
    ]);
  });

  it("explicitly disables fast mode in process-local CLI settings", async () => {
    const spawn = vi.fn().mockReturnValue(makeChild());
    const summarizer = createClaudeProcessSummarizer({
      fastMode: false,
      spawn: spawn as unknown as SpawnFn,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    const args = spawn.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf("--settings"))).toEqual([
      "--settings", JSON.stringify({ fastMode: false }),
    ]);
  });

  it("returns a friendly ENOENT error when Claude is missing", async () => {
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => {
        const error = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }) as unknown as SpawnFn,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      "Claude CLI is not installed or not on PATH",
    );
  });

  it("reports empty output separately from a CLI rejection after exit 0", async () => {
    const spawn = vi.fn().mockReturnValue(makeChild(0, "   "));
    const summarizer = createClaudeProcessSummarizer({ spawn: spawn as unknown as SpawnFn });

    const error = await summarizer("Conversation text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).toBe("claude output was empty");
    expect(error.message).not.toContain("CLI rejected");
  });

  it("reports bounded controls without exposing CLI diagnostics", async () => {
    const secret = "super-secret-provider-token";
    const child = makeChild(1, "", `Bearer ${secret}\nprompt and provider response body`);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createClaudeProcessSummarizer({
      model: `claude-${"x".repeat(400)}`,
      reasoningEffort: "max",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
    });

    const error = await summarizer("Conversation text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).toContain("provider claude-process");
    expect(error.message).toContain('model "claude-');
    expect(error.message).toContain("...[truncated]");
    expect(error.message).toContain('reasoning effort "max"');
    expect(error.message).toContain("fast mode true");
    expect(error.message).toContain("diagnostic output omitted");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("provider response body");
    expect(error.message.length).toBeLessThan(600);
  });

  it("rejects cleanly when killing a timed-out process throws", async () => {
    const spawn = vi.fn().mockReturnValue(makeHangingChild());
    const summarizer = createClaudeProcessSummarizer({
      spawn: spawn as unknown as SpawnFn,
      timeoutMs: 1,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      "claude process timed out after 0s",
    );
  });

  it("kills a timed-out process and ignores a later close", async () => {
    const child = makeHangingChild();
    child.kill.mockImplementation(() => true);
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
      timeoutMs: 1,
    });
    await expect(summarizer("text", false)).rejects.toThrow("timed out");
    child.emit("close", 0);
    expect(child.kill).toHaveBeenCalled();
  });

  it("normalizes asynchronous spawn failures and ignores later events", async () => {
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    const child = makeErrorChild(enoent);
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("Claude CLI is not installed");
    child.emit("error", new Error("late"));
  });

  it("normalizes non-Error synchronous failures", async () => {
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => { throw "plain failure"; }) as unknown as SpawnFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("plain failure");
  });

  it("preserves ordinary Error failures", async () => {
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => { throw new Error("ordinary failure"); }) as unknown as SpawnFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("ordinary failure");
  });

  it("builds an aggressive leaf prompt and a default-depth condensed prompt", async () => {
    const first = makeChild();
    const spawn = vi.fn().mockReturnValueOnce(first);
    const summarize = createClaudeProcessSummarizer({ spawn: spawn as unknown as SpawnFn });
    await summarize("text", true, { isCondensed: false });
    spawn.mockReturnValueOnce(makeChild());
    await summarize("text", false, { isCondensed: true });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("ignores a timeout callback after completion", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const summarize = createClaudeProcessSummarizer({
        spawn: vi.fn().mockReturnValue(makeChild()) as unknown as SpawnFn,
        timeoutMs: 10,
      });
      const result = summarize("text", false);
      await vi.runAllTicks();
      await expect(result).resolves.toBe("summary text");
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("builds a condensed aggressive prompt with explicit target and depth", async () => {
    const child = makeChild();
    let stdin = "";
    child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    });
    await summarizer("text", true, { isCondensed: true, targetTokens: 40, depth: 2 });
    expect(stdin).toContain("40");
  });
});
