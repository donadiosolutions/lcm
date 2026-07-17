import { EventEmitter } from "node:events";
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

describe("createClaudeProcessSummarizer", () => {
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

  it("reports requested controls and sanitizes bounded CLI diagnostics", async () => {
    const child = makeChild(1, "", `\u001b[31munsupported\u001b[0m\ncontrol\u0000${"x".repeat(400)}`);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createClaudeProcessSummarizer({
      model: "claude-test",
      reasoningEffort: "max",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
    });

    const error = await summarizer("Conversation text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).toContain("provider claude-process");
    expect(error.message).toContain('model "claude-test"');
    expect(error.message).toContain('reasoning effort "max"');
    expect(error.message).toContain("fast mode true");
    expect(error.message).toContain("unsupported control");
    expect(error.message).not.toContain("\u001b");
    expect(error.message).not.toContain("\u0000");
    expect(error.message.length).toBeLessThan(600);
  });
});
