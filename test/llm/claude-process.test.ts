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

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.write("summary text");
    child.stdout.end();
    child.emit("close", 0);
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
  });
});
