import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const teardownState = {
  create: undefined as undefined | (() => {
    pid: number | undefined;
    processGroupId: number | undefined;
    terminate: (reason?: "abort" | "timeout" | "close") => Promise<boolean>;
  }),
};

vi.mock("../../src/llm/process-utils.js", () => ({
  createOwnedProcessTeardown: vi.fn(() => {
    if (teardownState.create === undefined) throw new Error("teardown seam");
    return teardownState.create();
  }),
  createProcessCompatibilityError: (options: { cliName: string; providerId: string; code: number | null }) =>
    new Error(`${options.cliName} ${options.providerId} ${options.code ?? "unknown"}`),
  normalizeProcessBirthTime: (value: string | null | undefined) => value ?? null,
}));

const { createClaudeProcessSummarizer } = await import("../../src/llm/claude-process.js");

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function child(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.stdin = new PassThrough();
  value.kill = vi.fn();
  return value;
}

afterEach(() => {
  teardownState.create = undefined;
  vi.restoreAllMocks();
});

describe("Claude process defensive coverage", () => {
  it("normalizes a teardown-construction failure", async () => {
    const processChild = child();
    teardownState.create = () => { throw "teardown failed"; };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => processChild),
      setTimeout: (() => undefined) as never,
    } as never);
    await expect(summarizer("prompt")).rejects.toThrow("teardown failed");
  });

  it("handles an absent witness birth and an undefined timer handle", async () => {
    const processChild = child();
    teardownState.create = () => ({
      pid: 41,
      processGroupId: undefined,
      terminate: async () => true,
    });
    const witnessStore = { add: vi.fn(), remove: vi.fn() };
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => processChild),
      daemonInstanceId: "daemon-a",
      witnessStore,
      processBirthTime: () => undefined,
      setTimeout: (() => undefined) as never,
      clearTimeout: vi.fn(),
    } as never);
    const pending = summarizer("prompt", false, { invocationId: "11111111-1111-4111-8111-111111111111" });
    processChild.stdout.end("summary");
    processChild.emit("close", 0);
    await expect(pending).resolves.toBe("summary");
    processChild.emit("close", 0);
    expect(witnessStore.add).toHaveBeenCalledWith(expect.objectContaining({ processStartTime: null, invocationId: "11111111-1111-4111-8111-111111111111" }));
  });

  it("normalizes a non-Error witness failure", async () => {
    const processChild = child();
    teardownState.create = () => ({ pid: 42, processGroupId: undefined, terminate: async () => true });
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => processChild),
      daemonInstanceId: "daemon-a",
      witnessStore: { add: vi.fn(() => { throw "witness failed"; }), remove: vi.fn() },
      processBirthTime: () => "birth-42",
    } as never);
    await expect(summarizer("prompt")).rejects.toThrow("witness failed");
  });

  it("normalizes a non-Error teardown rejection", async () => {
    const processChild = child();
    teardownState.create = () => ({
      pid: 43,
      processGroupId: undefined,
      terminate: async () => { throw "terminate failed"; },
    });
    const summarizer = createClaudeProcessSummarizer({
      spawn: vi.fn(() => processChild),
      setTimeout: (() => undefined) as never,
    } as never);
    const pending = summarizer("prompt");
    processChild.emit("close", 0);
    await expect(pending).rejects.toThrow("terminate failed");
  });
});
