import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";

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
