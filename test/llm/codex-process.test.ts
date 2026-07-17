import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCodexProcessSummarizer } from "../../src/llm/codex-process.js";

type SpawnFn = typeof import("node:child_process").spawn;
type MkdtempSyncFn = typeof import("node:fs").mkdtempSync;
type ReadFileSyncFn = typeof import("node:fs").readFileSync;
type RmSyncFn = typeof import("node:fs").rmSync;

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(exitCode = 0, stderr = ""): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stderr) child.stderr.end(stderr);
    child.emit("close", exitCode);
  });
  return child;
}

describe("createCodexProcessSummarizer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns codex exec with read-only sandbox and writes the prompt to stdin", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    let stdin = "";
    child.stdin.on("data", (chunk) => {
      stdin += chunk.toString();
    });
    const mkdtempSyncMock = vi.fn(() => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
      tempDirs.push(dir);
      return dir;
    });
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: mkdtempSyncMock as unknown as MkdtempSyncFn,
      readFileSync: readFileSyncMock as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    const promise = summarizer("Conversation text", false, { isCondensed: false });
    await expect(promise).resolves.toBe("summary text");

    expect(spawn).toHaveBeenCalledOnce();
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("--output-last-message");
    expect(args).not.toContain("--strict-config");
    expect(args).not.toContain("--enable");
    expect(args).not.toContain("--disable");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(stdin).toContain("context-compaction summarization engine");
    expect(stdin).toContain("Conversation text");
  });

  it("passes --model when configured", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      model: "gpt-5.4",
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: readFileSyncMock as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    const promise = summarizer("Conversation text", false, { isCondensed: false });
    await expect(promise).resolves.toBe("summary text");

    expect(spawn.mock.calls[0][1]).toContain("--model");
    expect(spawn.mock.calls[0][1]).toContain("gpt-5.4");
  });

  it("passes reasoning effort and enabled fast mode as process-local strict config", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      model: "gpt-5.4",
      reasoningEffort: "ultra",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: vi.fn(() => "summary text") as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      "exec",
      "--model", "gpt-5.4",
      "--strict-config",
      "-c", 'model_reasoning_effort="ultra"',
      "--enable", "fast_mode",
      "-c", 'service_tier="fast"',
      "-",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-last-message", expect.any(String),
    ]);
  });

  it("explicitly disables fast mode without inheriting global Codex config", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      fastMode: false,
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: vi.fn(() => "summary text") as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("summary text");

    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toContain("--strict-config");
    expect(args.slice(args.indexOf("--disable"), args.indexOf("--disable") + 2)).toEqual([
      "--disable", "fast_mode",
    ]);
    expect(args).not.toContain("service_tier=\"fast\"");
  });

  it("returns a friendly ENOENT error when codex is missing", async () => {
    const summarizer = createCodexProcessSummarizer({
      spawn: vi.fn(() => {
        const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }) as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => mkdtempSync(join(tmpdir(), "lcm-codex-"))) as unknown as MkdtempSyncFn,
      readFileSync: vi.fn() as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
      tmpdir: () => tmpdir(),
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      "Codex CLI is not installed or not on PATH",
    );
  });

  it("rejects on non-zero exit", async () => {
    const child = makeChild(1, "boom");
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "summary text");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: readFileSyncMock as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow(
      /Codex CLI rejected.*provider codex-process.*reasoning effort "default\/omitted".*fast mode default\/omitted.*Upgrade the Codex CLI/s,
    );
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("reports bounded controls without exposing CLI diagnostics", async () => {
    const secret = "super-secret-provider-token";
    const child = makeChild(2, `Bearer ${secret}\nprompt and provider response body`);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      model: `gpt-${"x".repeat(400)}`,
      reasoningEffort: "ultra",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: vi.fn() as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    const error = await summarizer("Conversation text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('model "gpt-');
    expect(error.message).toContain("...[truncated]");
    expect(error.message).toContain('reasoning effort "ultra"');
    expect(error.message).toContain("fast mode true");
    expect(error.message).toContain("diagnostic output omitted");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("provider response body");
    expect(error.message.length).toBeLessThan(600);
  });

  it("rejects when the output file is empty", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const readFileSyncMock = vi.fn(() => "");
    const summarizer = createCodexProcessSummarizer({
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => {
        const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
        tempDirs.push(dir);
        return dir;
      }) as unknown as MkdtempSyncFn,
      readFileSync: readFileSyncMock as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });

    await expect(summarizer("Conversation text", false)).rejects.toThrow("codex output was empty");
  });
});
