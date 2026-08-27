import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCodexProcessSummarizer } from "../../src/llm/codex-process.js";

vi.mock("../../src/llm/codex-responses-gateway.js", () => ({
  createCodexResponsesGateway: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:32123/test-capability",
    capabilityPath: "/test-capability",
    requestAccepted: true,
    requestCompleted: true,
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

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
  setImmediate(() => {
    if (stderr) child.stderr.end(stderr);
    child.emit("close", exitCode);
  });
  return child;
}

function makeHangingChild(killThrows = false): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    if (killThrows) throw new Error("already exited");
    return true;
  });
  return child;
}

function makeGateway(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://127.0.0.1:32123/test-capability",
    capabilityPath: "/test-capability",
    requestAccepted: true,
    requestCompleted: true,
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function baseDeps(child: FakeChild, overrides: Record<string, unknown> = {}) {
  return {
    spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
    mkdtempSync: vi.fn(() => mkdtempSync(join(tmpdir(), "lcm-codex-"))) as unknown as MkdtempSyncFn,
    readFileSync: vi.fn(() => "summary") as unknown as ReadFileSyncFn,
    rmSync: vi.fn() as unknown as RmSyncFn,
    ...overrides,
  };
}

describe("createCodexProcessSummarizer", () => {
  const tempDirs: string[] = [];

  it("constructs with default process dependencies", () => {
    expect(createCodexProcessSummarizer()).toBeTypeOf("function");
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns codex exec with read-only sandbox and writes only the bootstrap to stdin", async () => {
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
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--disable");
    expect(args).toContain("hooks");
    expect(args).not.toContain("--strict-config");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(stdin).toBe("LCM compaction bootstrap.\n");
    expect(stdin).not.toContain("Conversation text");
  });

  it("starts one zero-tools gateway, isolates cwd/hooks, and sends only a fixed bootstrap", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    let stdin = "";
    child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const gateway = {
      baseUrl: "http://127.0.0.1:32123/capability",
      capabilityPath: "/capability",
      requestAccepted: true,
      requestCompleted: true,
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createGateway = vi.fn().mockResolvedValue(gateway);
    const mkdtempSyncMock = vi.fn(() => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-codex-"));
      tempDirs.push(dir);
      return dir;
    });
    const summarizer = createCodexProcessSummarizer({
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: true,
      spawn: spawn as unknown as SpawnFn,
      mkdtempSync: mkdtempSyncMock as unknown as MkdtempSyncFn,
      readFileSync: vi.fn(() => "summary text") as unknown as ReadFileSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
      _createGateway: createGateway,
    } as never);

    await expect(summarizer("PRIVATE TRANSCRIPT", false)).resolves.toBe("summary text");
    expect(createGateway).toHaveBeenCalledOnce();
    expect(createGateway.mock.calls[0][0].prompt).toContain("PRIVATE TRANSCRIPT");
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("codex");
    expect(args).toEqual(expect.arrayContaining([
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", 'model_provider="lcm_compaction"',
    ]));
    expect(args.join(" ")).toContain("model_providers.lcm_compaction=");
    expect(args.join(" ")).toContain("wire_api=\"responses\"");
    expect(args.join(" ")).toContain("requires_openai_auth=true");
    expect(args.join(" ")).toContain("request_max_retries=0");
    expect(args.join(" ")).toContain("stream_max_retries=0");
    expect(args.join(" ")).toContain("supports_websockets=false");
    expect(options).toMatchObject({ cwd: expect.stringContaining("lcm-codex-") });
    expect(stdin).toBe("LCM compaction bootstrap.\n");
    expect(stdin).not.toContain("PRIVATE TRANSCRIPT");
    expect(gateway.waitForCompletion).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("rejects an exit-0 child when no authenticated gateway request was accepted", async () => {
    const child = makeChild(0);
    const gateway = makeGateway({ requestAccepted: false, requestCompleted: false });
    const createGateway = vi.fn().mockResolvedValue(gateway);
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: createGateway,
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow(
      "codex responses gateway did not receive an authenticated request",
    );
    expect(gateway.waitForCompletion).not.toHaveBeenCalled();
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("rejects an exit-0 child when the gateway stream is incomplete", async () => {
    const child = makeChild(0);
    const gateway = makeGateway({
      requestCompleted: false,
      waitForCompletion: vi.fn().mockRejectedValue(new Error("codex responses gateway did not complete")),
    });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("codex responses gateway did not complete");
    expect(gateway.waitForCompletion).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("preserves a primary child failure when gateway close also fails", async () => {
    const child = makeChild(2);
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue(new Error("gateway close failed")) });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow(/Codex CLI rejected/);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("fails closed when a successful summary cannot close its gateway", async () => {
    const child = makeChild(0);
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue(new Error("gateway close failed")) });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("gateway close failed");
    expect(gateway.waitForCompletion).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("awaits gateway close on synchronous spawn failure", async () => {
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild()),
      spawn: vi.fn(() => { throw new Error("spawn failed"); }) as unknown as SpawnFn,
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("spawn failed");
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("cleans the temp directory when gateway startup fails", async () => {
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild()),
      rmSync: rmSyncMock,
      _createGateway: vi.fn(async () => { throw "gateway startup failed"; }),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("gateway startup failed");
    expect(rmSyncMock).toHaveBeenCalledOnce();
    const errorSummarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild()),
      _createGateway: vi.fn(async () => { throw new Error("gateway startup error"); }),
    } as never);
    await expect(errorSummarizer("transcript", false)).rejects.toThrow("gateway startup error");
  });

  it("rejects when the gateway reports a resolved but incomplete stream", async () => {
    const child = makeChild(0);
    const gateway = makeGateway({ requestCompleted: false });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("codex responses gateway did not complete");
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("normalizes a non-Error gateway close failure after success", async () => {
    const child = makeChild(0);
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue("gateway close failed") });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("gateway close failed");
  });

  it("closes the gateway when writing the fixed bootstrap fails", async () => {
    const child = makeChild(0);
    child.stdin.write = () => { throw new Error("stdin failed"); };
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("stdin failed");
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("closes the gateway when stdout setup fails", async () => {
    const child = makeChild(0);
    child.stdout.resume = () => { throw new Error("stdout setup failed"); };
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("stdout setup failed");
    expect(gateway.close).toHaveBeenCalledOnce();
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

  it("passes reasoning effort and enabled fast mode without strictly validating user config", async () => {
    const child = makeChild(0);
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      model: "gpt-5.4",
      reasoningEffort: "minimal",
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
    expect(args).toEqual(expect.arrayContaining([
      "exec",
      "--model", "gpt-5.4",
      "-c", 'model_reasoning_effort="minimal"',
      "--enable", "fast_mode",
      "-c", 'service_tier="fast"',
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", 'model_provider="lcm_compaction"',
      "-",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-last-message", expect.any(String),
    ]));
    expect(args.join(" ")).toContain("model_providers.lcm_compaction=");
    expect(args).not.toContain("--strict-config");
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
    expect(args).toEqual(expect.arrayContaining([
      "exec",
      "--disable", "fast_mode",
      "-c", 'service_tier="default"',
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--disable", "hooks",
      "-c", "project_doc_max_bytes=0",
      "-c", 'model_provider="lcm_compaction"',
      "-",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--output-last-message", expect.any(String),
    ]));
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
      reasoningEffort: "minimal",
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
    expect(error.message).toContain('reasoning effort "minimal"');
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

  it("omits a whitespace-only model and builds a condensed prompt", async () => {
    const child = makeChild(0);
    const deps = baseDeps(child);
    let stdin = "";
    child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const summarizer = createCodexProcessSummarizer({
      model: "   ",
      ...deps,
    });
    await summarizer("text", true, { isCondensed: true, targetTokens: 40, depth: 2 });
    expect((deps.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toContain("--model");
    expect(stdin).toBe("LCM compaction bootstrap.\n");
  });

  it("normalizes non-Error synchronous spawn failures and ignores cleanup failure", async () => {
    const summarizer = createCodexProcessSummarizer({
      spawn: vi.fn(() => { throw "plain failure"; }) as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => "/tmp/lcm-codex-fake") as unknown as MkdtempSyncFn,
      readFileSync: vi.fn() as unknown as ReadFileSyncFn,
      rmSync: vi.fn(() => { throw new Error("cleanup failed"); }) as unknown as RmSyncFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("plain failure");
  });

  it.each([false, true])("times out and cleans up when killThrows=%s", async (killThrows) => {
    const child = makeHangingChild(killThrows);
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      timeoutMs: 1,
    });
    await expect(summarizer("text", false)).rejects.toThrow("codex process timed out after 0s");
    child.emit("close", 0);
    expect(child.kill).toHaveBeenCalled();
  });

  it("handles asynchronous ENOENT and ignores a later error", async () => {
    const child = makeHangingChild();
    const summarizer = createCodexProcessSummarizer(baseDeps(child));
    const promise = summarizer("text", false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(promise).rejects.toThrow("Codex CLI is not installed");
    child.emit("error", new Error("late"));
  });

  it("normalizes a non-Error output read failure", async () => {
    const child = makeChild(0);
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      readFileSync: vi.fn(() => { throw "read failed"; }) as unknown as ReadFileSyncFn,
    });
    await expect(summarizer("text", false)).rejects.toThrow("read failed");
  });

  it("preserves ordinary Error spawn failures and builds default prompt variants", async () => {
    const failed = createCodexProcessSummarizer({
      spawn: vi.fn(() => { throw new Error("ordinary failure"); }) as unknown as SpawnFn,
      mkdtempSync: vi.fn(() => "/tmp/lcm-codex-fake") as unknown as MkdtempSyncFn,
      rmSync: vi.fn() as unknown as RmSyncFn,
    });
    await expect(failed("text", false)).rejects.toThrow("ordinary failure");

    const first = makeChild(0);
    const spawn = vi.fn().mockReturnValueOnce(first);
    const summarize = createCodexProcessSummarizer({
      ...baseDeps(first), spawn: spawn as unknown as SpawnFn,
    });
    await summarize("text", true, { isCondensed: false });
    spawn.mockReturnValueOnce(makeChild(0));
    await summarize("text", false, { isCondensed: true });
  });

  it("ignores a timeout callback after completion", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const summarize = createCodexProcessSummarizer({ ...baseDeps(makeChild(0)), timeoutMs: 10 });
      const result = summarize("text", false);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("summary");
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
