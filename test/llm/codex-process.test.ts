import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createCodexProcessSummarizer } from "../../src/llm/codex-process.js";
import { createAbortError, isAbortError } from "../../src/daemon/cancellation.js";
import { sanitizeError } from "../../src/daemon/safe-error.js";

const processStartTime = vi.hoisted(() => vi.fn((pid: number) => pid === 9517 ? "controlled-birth-9517" : null));

vi.mock("../../src/private-mutation-lock.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/private-mutation-lock.js")>()),
  processStartTime,
}));

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

  it("does not create a gateway or spawn for a pre-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const createGateway = vi.fn();
    const spawn = vi.fn() as unknown as SpawnFn;
    const summarizer = createCodexProcessSummarizer({
      spawn,
      _createGateway: createGateway,
    } as never);

    await expect(summarizer("text", false, { signal: controller.signal }))
      .rejects.toSatisfy(error => isAbortError(error));
    expect(createGateway).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("awaits a late gateway close before abort rejection and temp cleanup", async () => {
    const controller = new AbortController();
    const child = makeHangingChild();
    let resolveGateway: ((gateway: ReturnType<typeof makeGateway>) => void) | undefined;
    const gatewayPromise = new Promise<ReturnType<typeof makeGateway>>(resolve => { resolveGateway = resolve; });
    let releaseClose: (() => void) | undefined;
    const closePromise = new Promise<void>(resolve => { releaseClose = resolve; });
    const gateway = makeGateway({ close: vi.fn(() => closePromise) });
    const createGateway = vi.fn(() => gatewayPromise);
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const mkdtempSyncMock = vi.fn(() => "/tmp/lcm-codex-deferred-gateway");
    const summarizer = createCodexProcessSummarizer({
      spawn: vi.fn().mockReturnValue(child) as unknown as SpawnFn,
      mkdtempSync: mkdtempSyncMock as unknown as MkdtempSyncFn,
      readFileSync: vi.fn(() => "summary") as unknown as ReadFileSyncFn,
      rmSync: rmSyncMock,
      _createGateway: createGateway,
    } as never);

    const pending = summarizer("private transcript", false, { signal: controller.signal });
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(createGateway).toHaveBeenCalledOnce());
    controller.abort();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rmSyncMock).not.toHaveBeenCalled();

    resolveGateway?.(gateway);
    await vi.waitFor(() => expect(gateway.close).toHaveBeenCalledOnce());
    expect(rmSyncMock).not.toHaveBeenCalled();
    releaseClose?.();
    expect(isAbortError((await observed).error)).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("normalizes a non-Error late gateway close while preserving abort", async () => {
    const controller = new AbortController();
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue("late gateway close failed") });
    let resolveGateway: ((gateway: ReturnType<typeof makeGateway>) => void) | undefined;
    const gatewayPromise = new Promise<ReturnType<typeof makeGateway>>(resolve => { resolveGateway = resolve; });
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild(), { rmSync: rmSyncMock }),
      _createGateway: vi.fn(() => gatewayPromise),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(rmSyncMock).not.toHaveBeenCalled());
    controller.abort();
    resolveGateway?.(gateway);
    const result = await observed;
    expect(isAbortError(result.error)).toBe(true);
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("closes an already-created gateway when abort races gateway startup", async () => {
    const controller = new AbortController();
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue(new Error("close failed")) });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild()),
      _createGateway: vi.fn(() => {
        controller.abort();
        return gateway;
      }),
    } as never);
    await expect(summarizer("text", false, { signal: controller.signal })).rejects.toSatisfy(error => isAbortError(error));
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("preserves cancellation when gateway close fails after startup", async () => {
    const controller = new AbortController();
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue(new Error("close failed")) });
    let release!: (value: ReturnType<typeof makeGateway>) => void;
    const gatewayPromise = new Promise<ReturnType<typeof makeGateway>>(resolve => { release = resolve; });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild()),
      _createGateway: vi.fn(() => gatewayPromise),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    release(gateway);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("preserves a non-abort gateway creation failure", async () => {
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(makeHangingChild(), { rmSync: rmSyncMock }),
      _createGateway: vi.fn(async () => { throw "gateway creation failed"; }),
    } as never);
    await expect(summarizer("text", false)).rejects.toThrow("gateway creation failed");
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("waits for child and gateway teardown before rejecting a mid-request abort", async () => {
    const controller = new AbortController();
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 9312;
    const gateway = makeGateway({ close: vi.fn().mockResolvedValue(undefined) });
    const createGateway = vi.fn().mockResolvedValue(gateway);
    let groupAlive = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") groupAlive = false;
    });
    const isProcessGroupAlive = vi.fn(() => groupAlive);
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child, { spawn, rmSync: rmSyncMock }),
      _createGateway: createGateway,
      detachedProcessGroup: false,
      killProcess,
      processGroupId: 9312,
      processGroupIdProbe: () => 9312,
      daemonProcessGroupId: 9311,
      processBirthTime: () => "birth-9312",
      isProcessGroupAlive,
    } as never);

    const pending = summarizer("private transcript", false, { signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();
    child.emit("close", null);

    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
    expect(killProcess).toHaveBeenCalledWith(-9312, "SIGTERM");
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("cancellation wins over deferred gateway completion and cleans every handle", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 9412;
    const gateway = makeGateway({
      waitForCompletion: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    let groupAlive = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") groupAlive = false;
    });
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child, { spawn, rmSync: rmSyncMock }),
      timeoutMs: 60_000,
      _createGateway: vi.fn().mockResolvedValue(gateway),
      killProcess,
      processGroupId: 9412,
      processGroupIdProbe: () => 9412,
      daemonProcessGroupId: 9411,
      processBirthTime: () => "birth-9412",
      isProcessGroupAlive: () => groupAlive,
    } as never);

    try {
      const pending = summarizer("private transcript", false, { signal: controller.signal });
      const observed = pending.catch(error => error);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.emit("close", 0);
      await vi.runAllTicks();
      expect(gateway.waitForCompletion).toHaveBeenCalledOnce();
      controller.abort();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1_999);
      await vi.advanceTimersByTimeAsync(1);
      child.emit("close", null);
      expect(isAbortError(await observed)).toBe(true);
      expect(gateway.close).toHaveBeenCalledOnce();
      expect(rmSyncMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes and removes a secret-free Codex process witness after gateway settlement", async () => {
    const child = makeChild(0);
    (child as FakeChild & { pid: number }).pid = 9512;
    const gateway = makeGateway();
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child, { spawn }),
      _createGateway: vi.fn().mockResolvedValue(gateway),
      platform: "win32",
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      witnessStore,
      processBirthTime: () => "birth-9512",
    } as never);

    await expect(summarizer("text", false, { invocationId: "11111111-1111-4111-8111-111111111111" })).resolves.toBe("summary");
    expect(witnessStore.add).toHaveBeenCalledWith({
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      invocationId: "11111111-1111-4111-8111-111111111111",
      providerId: "codex-process",
      pid: 9512,
      pgid: null,
      processStartTime: "birth-9512",
    });
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("records a null process birth witness when the identity probe is unavailable", async () => {
    const child = makeChild();
    (child as FakeChild & { pid: number }).pid = 9514;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      daemonInstanceId: "daemon-a",
      witnessStore,
      processBirthTime: () => undefined,
    } as never);
    await expect(summarizer("text")).resolves.toBe("summary");
    expect(witnessStore.add).toHaveBeenCalledWith(expect.objectContaining({ processStartTime: null }));
  });

  it("preserves a witness removal failure after successful completion", async () => {
    const child = makeChild();
    (child as FakeChild & { pid: number }).pid = 9515;
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw "witness remove failed"; }),
      path: "/tmp/daemon-runtime.json",
    };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore, processBirthTime: () => "birth-9515",
    } as never);
    await expect(summarizer("text")).rejects.toThrow("witness remove failed");
  });

  it("normalizes an Error witness removal failure", async () => {
    const child = makeChild();
    (child as FakeChild & { pid: number }).pid = 9516;
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw new Error("witness remove error"); }),
      path: "/tmp/daemon-runtime.json",
    };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore, processBirthTime: () => "birth-9516",
    } as never);
    await expect(summarizer("text")).rejects.toThrow("witness remove error");
  });

  it("preserves a primary child failure when witness removal also fails", async () => {
    const child = makeChild(1);
    (child as FakeChild & { pid: number }).pid = 9518;
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw new Error("witness remove after child failure"); }),
      path: "/tmp/daemon-runtime.json",
    };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      daemonInstanceId: "daemon-a",
      witnessStore,
      processBirthTime: () => "birth-9518",
    } as never);
    await expect(summarizer("text")).rejects.toThrow(/rejected the compaction request/i);
  });

  it("uses the default process-start probe when publishing a witness", async () => {
    const child = makeChild(0);
    (child as FakeChild & { pid: number }).pid = 9519;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore,
    } as never);
    await expect(summarizer("text")).resolves.toBe("summary");
    expect(witnessStore.add).toHaveBeenCalledOnce();
  });

  it("records null when the default process-start probe cannot identify the child", async () => {
    const child = makeChild(0);
    (child as FakeChild & { pid: number }).pid = 9521;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore,
      processBirthTime: () => undefined,
    } as never);
    await summarizer("text");
    expect(witnessStore.add).toHaveBeenCalledWith(expect.objectContaining({ processStartTime: null }));
  });

  it("falls back to the default birth probe when the seam is explicitly absent", async () => {
    const child = makeChild(0);
    (child as FakeChild & { pid: number }).pid = 9522;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore,
      processBirthTime: null,
    } as never);
    await expect(summarizer("text")).resolves.toBe("summary");
    expect(witnessStore.add).toHaveBeenCalledOnce();
  });

  it("publishes a witness from the controlled default process birth probe", async () => {
    const child = makeChild();
    (child as FakeChild & { pid: number }).pid = 9517;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/daemon-runtime.json" };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), daemonInstanceId: "daemon-a", witnessStore, platform: "win32",
    } as never);
    await expect(summarizer("text")).resolves.toBe("summary");
    expect(witnessStore.add).toHaveBeenCalledWith(expect.objectContaining({
      pid: 9517,
      pgid: null,
      processStartTime: "controlled-birth-9517",
    }));
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

  it("normalizes a non-Error gateway close failure after a child error", async () => {
    const child = makeChild(2);
    const gateway = makeGateway({ close: vi.fn().mockRejectedValue("gateway close failed") });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow(/Codex CLI rejected/);
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

  it("closes the gateway when witness publication fails", async () => {
    const child = makeHangingChild();
    (child as FakeChild & { pid: number }).pid = 9513;
    const gateway = makeGateway();
    const witnessError = new Error("witness publication failed");
    const witnessStore = {
      path: "/tmp/daemon-runtime.json",
      add: vi.fn(() => { throw witnessError; }),
      remove: vi.fn(),
    };
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      platform: "win32",
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      witnessStore,
      processBirthTime: () => "birth-9513",
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("text", false)).rejects.toThrow("witness publication failed");
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("handles an intentional synchronous Codex stdin abort", async () => {
    const controller = new AbortController();
    const child = makeHangingChild();
    child.stdin.write = () => {
      controller.abort();
      return true;
    };
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    child.emit("close", null);
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("handles a signal that aborts immediately after child spawn", async () => {
    const controller = new AbortController();
    const processChild = makeHangingChild();
    processChild.kill.mockImplementation(() => { processChild.emit("close", null); });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(processChild),
      spawn: vi.fn(() => { controller.abort(); return processChild; }) as unknown as SpawnFn,
    } as never);
    await expect(summarizer("text", false, { signal: controller.signal })).rejects.toSatisfy(error => isAbortError(error));
  });

  it("ignores a late abort after timeout has started teardown", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const processChild = makeHangingChild();
      processChild.kill.mockImplementation(() => { processChild.emit("close", null); });
      const summarizer = createCodexProcessSummarizer({
        ...baseDeps(processChild), timeoutMs: 1,
      } as never);
      const pending = summarizer("text", false, { signal: controller.signal });
      const observed = pending.then(() => undefined, error => error);
      await vi.waitFor(() => expect(processChild.stdin.listenerCount("error")).toBeGreaterThan(0));
      processChild.stderr.emit("data", "usage limit");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await expect(observed).resolves.toMatchObject({ message: expect.stringMatching(/timed out/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes an abort-shaped synchronous stdin failure through cancellation", async () => {
    const processChild = makeHangingChild();
    processChild.stdin.write = vi.fn(() => { throw createAbortError(); }) as typeof processChild.stdin.write;
    processChild.kill.mockImplementation(() => { processChild.emit("close", null); });
    const summarizer = createCodexProcessSummarizer({ ...baseDeps(processChild) } as never);
    await expect(summarizer("text")).rejects.toSatisfy(error => isAbortError(error));
  });

  it("aborts deferred gateway completion when the signal fires", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gateway = makeGateway({
      waitForCompletion: vi.fn(() => new Promise<void>(resolve => { release = resolve; })),
    });
    const processChild = makeChild();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(processChild), _createGateway: vi.fn(async () => gateway),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(processChild.listenerCount("close")).toBeGreaterThan(0));
    processChild.emit("close", 0);
    controller.abort();
    release?.();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
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

  it("normalizes a non-Error stdout setup failure", async () => {
    const child = makeChild(0);
    child.stdout.resume = () => { throw "stdout raw failure"; };
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    await expect(summarizer("transcript", false)).rejects.toThrow("stdout raw failure");
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("routes an asynchronous stdin EPIPE through single-flight cleanup", async () => {
    const child = makeHangingChild();
    const gateway = makeGateway();
    const close = gateway.close;
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      rmSync: rmSyncMock,
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);

    const promise = summarizer("private transcript", false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdin.emit("error", Object.assign(new Error("write EPIPE secret-body"), { code: "EPIPE" }));

    await expect(promise).rejects.toThrow(/stdin/i);
    expect(close).toHaveBeenCalledOnce();
    expect(rmSyncMock).toHaveBeenCalledOnce();

    // Late terminal events, including a second stdin error, are harmless and
    // do not trigger a second close or cleanup operation.
    child.stdin.emit("error", new Error("late stdin error"));
    child.emit("error", new Error("late child error"));
    child.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledOnce();
    expect(rmSyncMock).toHaveBeenCalledOnce();
  });

  it("ignores duplicate stdin errors after teardown has started", async () => {
    const child = makeHangingChild();
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    const pending = summarizer("text");
    await vi.waitFor(() => expect(child.stdin.listenerCount("error")).toBeGreaterThan(0));
    child.stdin.emit("error", new Error("first stdin failure"));
    child.stdin.emit("error", new Error("duplicate stdin failure"));
    child.emit("close", 1);
    await expect(pending).rejects.toThrow(/stdin/i);
  });

  it("rejects a child close callback when the command aborts after close", async () => {
    const controller = new AbortController();
    const child = makeChild(0);
    let release!: () => void;
    const gateway = makeGateway({ waitForCompletion: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) });
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));
    child.emit("close", 0);
    controller.abort();
    release();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("ignores an abort arriving after timeout teardown has started", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = makeHangingChild();
      const gateway = makeGateway();
      const summarizer = createCodexProcessSummarizer({
        ...baseDeps(child), _createGateway: vi.fn().mockResolvedValue(gateway), timeoutMs: 1,
      } as never);
      const pending = summarizer("text", false, { signal: controller.signal });
      const observed = pending.then(() => undefined, error => error);
      await vi.waitFor(() => expect(child.stdin.listenerCount("error")).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      child.emit("close", null);
      await expect(observed).resolves.toMatchObject({ message: expect.stringMatching(/timed out|abort/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a child close observed after an already-aborted signal", async () => {
    const controller = new AbortController();
    const child = makeHangingChild();
    const gateway = makeGateway();
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child), _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never);
    const pending = summarizer("text", false, { signal: controller.signal });
    const observed = pending.then(() => undefined, error => error);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));
    controller.abort();
    child.emit("close", 0);
    await expect(observed).resolves.toSatisfy(error => isAbortError(error));
  });

  it("latches child-close settlement before deferred gateway completion", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      let resolveGateway: (() => void) | undefined;
      const gatewayCompletion = new Promise<void>((resolve) => { resolveGateway = resolve; });
      const gateway = makeGateway({
        waitForCompletion: vi.fn(() => gatewayCompletion),
      });
      const close = gateway.close;
      const rmSyncMock = vi.fn() as unknown as RmSyncFn;
      const spawn = vi.fn().mockReturnValue(child);
      const summarizer = createCodexProcessSummarizer({
        ...baseDeps(child),
        spawn: spawn as unknown as SpawnFn,
        rmSync: rmSyncMock,
        timeoutMs: 20,
        _createGateway: vi.fn().mockResolvedValue(gateway),
      } as never);

      const promise = summarizer("private transcript", false);
      while (spawn.mock.calls.length === 0) await Promise.resolve();
      child.emit("close", 0);
      await vi.runAllTicks();
      expect(gateway.waitForCompletion).toHaveBeenCalledOnce();

      // The accepted child-close path is waiting for the gateway's complete
      // upstream stream, but remains before the request deadline. It must not
      // kill the child or replace the original terminal outcome.
      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).not.toHaveBeenCalled();
      resolveGateway?.();
      await expect(promise).resolves.toBe("summary");
      expect(close).toHaveBeenCalledOnce();
      expect(rmSyncMock).toHaveBeenCalledOnce();

      child.emit("close", 0);
      child.emit("error", new Error("late child error"));
      child.stdin.emit("error", new Error("late stdin error"));
      await vi.runAllTicks();
      expect(close).toHaveBeenCalledOnce();
      expect(rmSyncMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline active after child close and closes a stalled gateway", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      const gateway = makeGateway({
        waitForCompletion: vi.fn(() => new Promise<void>(() => {})),
      });
      const close = gateway.close;
      const rmSyncMock = vi.fn() as unknown as RmSyncFn;
      const spawn = vi.fn().mockReturnValue(child);
      const summarizer = createCodexProcessSummarizer({
        ...baseDeps(child),
        spawn: spawn as unknown as SpawnFn,
        rmSync: rmSyncMock,
        timeoutMs: 20,
        _createGateway: vi.fn().mockResolvedValue(gateway),
      } as never);

      const promise = summarizer("private transcript", false);
      while (spawn.mock.calls.length === 0) await Promise.resolve();
      child.emit("close", 0);
      await vi.runAllTicks();
      expect(gateway.waitForCompletion).toHaveBeenCalledOnce();

      let settled = false;
      const observed = promise.catch((error: unknown) => {
        settled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(20);
      await vi.runAllTicks();
      expect(settled).toBe(true);
      const error = await observed;
      expect(error).toMatchObject({ message: "codex process timed out after 0s" });
      expect(child.kill).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(rmSyncMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the owned process group never settles", async () => {
    vi.useFakeTimers();
    try {
      const processChild = makeHangingChild();
      (processChild as FakeChild & { pid: number }).pid = 9520;
      const gateway = makeGateway();
      const summarizer = createCodexProcessSummarizer({
        ...baseDeps(processChild),
        _createGateway: vi.fn(async () => gateway),
        processGroupId: 9520,
        daemonProcessGroupId: 9519,
        processBirthTime: () => "birth-9520",
        isProcessGroupAlive: () => true,
      } as never);
      const pending = summarizer("text");
      const observed = pending.then(() => undefined, error => error);
      await vi.waitFor(() => expect(processChild.listenerCount("close")).toBeGreaterThan(0));
      processChild.emit("close", 0);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(observed).resolves.toMatchObject({ message: "codex process teardown did not settle" });
    } finally {
      vi.useRealTimers();
    }
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

  it.each([
    ["usage", "You've hit your usage limit for GPT-5.3-Codex-Spark. Try again at 4:27 AM."],
    ["usage", "rate-limit reached"],
    ["usage", "rate limit reached"],
    ["usage", "usage-limit reached"],
    ["authentication", "not logged in"],
    ["authentication", "authentication required"],
    ["authentication", "invalid API key"],
    ["model", "unsupported model"],
    ["model", "the model is not available"],
    ["invalid-request", "unexpected argument: --bogus"],
    ["invalid-request", "unknown flag"],
  ] as const)("classifies %s diagnostics with fixed safe guidance", async (category, diagnostic) => {
    const canary = "GPT-5.3-Codex-Spark 4:27 AM Bearer secret-token";
    const child = makeChild(1, `${diagnostic} ${canary}`);
    const summarizer = createCodexProcessSummarizer(baseDeps(child));
    const error = await summarizer("Conversation text", false).catch((caught: unknown) => caught as Error);

    expect(error.message).toBeDefined();
    expect(error.message).not.toContain("Upgrade the Codex CLI");
    expect(error.message).not.toContain(canary);
    expect(error.message).not.toContain("secret-token");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(sanitizeError(error.message)).toBe(error.message);
    expect(error.message).toContain('reasoning effort "default/omitted"');
    expect(error.message).toContain("fast mode default/omitted");
    if (category === "usage") expect(error.message).toMatch(/usage limit|rate/i);
    if (category === "authentication") expect(error.message).toMatch(/authentication|sign in/i);
    if (category === "model") expect(error.message).toMatch(/model|supported/i);
    if (category === "invalid-request") expect(error.message).toMatch(/invalid|compatibility/i);
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("keeps defined %s controls in classified guidance", async (_label, fastMode) => {
    const child = makeChild(1, "usage limit");
    const error = await createCodexProcessSummarizer({
      ...baseDeps(child),
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode,
    })("text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/^Codex compaction reached a usage limit\./);
    expect(error.message).toContain('model "gpt-5.4"');
    expect(error.message).toContain('reasoning effort "high"');
    expect(error.message).toContain(`fast mode ${fastMode}`);
  });

  it.each([
    "limit", "token", "error", "model", "limitation", "rate limiting", "rate limited",
    "usage limits", "unknown flags", "model is not availables", "not logged into",
  ])("keeps lookalike diagnostic %s on the compatibility fallback", async (diagnostic) => {
    const child = makeChild(1, diagnostic);
    await expect(createCodexProcessSummarizer(baseDeps(child))("text", false))
      .rejects.toThrow("Upgrade the Codex CLI");
  });

  it("uses fixed precedence across the complete stderr window", async () => {
    const diagnostics = [
      "authentication required then usage limit",
      "unsupported model then rate-limit",
      "invalid request then authentication failed",
      "unknown flag then unsupported model",
    ];
    const expected = ["usage limit", "usage limit", "authentication", "model"];
    for (const [index, diagnostic] of diagnostics.entries()) {
      const child = makeChild(1, diagnostic);
      const error = await createCodexProcessSummarizer(baseDeps(child))("text", false)
        .catch((caught: unknown) => caught as Error);
      expect(error.message).toMatch(new RegExp(expected[index]!, "i"));
    }
  });

  it("classifies split multibyte and same-tick stderr while retaining only the terminal byte window", async () => {
    const child = makeHangingChild();
    const spawn = vi.fn().mockReturnValue(child);
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    });
    const pending = summarizer("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const diagnostic = Buffer.from("usage limit — GPT-5.3-Codex-Spark");
    const splitAt = diagnostic.indexOf(0xE2) + 1;
    child.stderr.emit("data", diagnostic.subarray(0, splitAt));
    child.stderr.emit("data", diagnostic.subarray(splitAt));
    child.emit("close", 1);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/usage limit/i);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("accepts string stderr chunks and ignores unsupported diagnostic chunks", async () => {
    const child = makeHangingChild();
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("data", "authentication   required");
    child.stderr.emit("data", `${"x".repeat(20_000)} authentication required`);
    child.stderr.emit("data", "");
    child.stderr.emit("data", { unexpected: true });
    child.emit("close", 1);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/authentication|sign in/i);
  });

  it("trims oversized stderr chunks by bytes and evicts complete ring chunks", async () => {
    const child = makeHangingChild();
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("data", Buffer.alloc(10_000, "x"));
    child.stderr.emit("data", Buffer.alloc(10_010, "x"));
    child.stderr.emit("data", Buffer.alloc(16_384, "x"));
    child.emit("close", 1);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toContain("Upgrade the Codex CLI");
  });

  it("classifies a trailing phrase in an oversized Buffer chunk", async () => {
    const child = makeHangingChild();
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("data", Buffer.concat([Buffer.alloc(20_000, "x"), Buffer.from(" usage limit")]));
    child.emit("close", 1);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/^Codex compaction reached a usage limit\./);
  });

  it("drains a paused same-tick stderr write after attaching the listener", async () => {
    const child = makeHangingChild();
    child.stderr.write("usage limit");
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("close", 1);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/^Codex compaction reached a usage limit\./);
  });

  it("falls back when a known diagnostic is pushed out of the 16 KiB terminal window", async () => {
    const child = makeChild(1, `usage limit${"x".repeat(16 * 1024)}`);
    const error = await createCodexProcessSummarizer(baseDeps(child))("text", false)
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toContain("Upgrade the Codex CLI");
  });

  it.each([
    ["usage", 429],
    ["authentication", 401],
  ] as const)("prefers the gateway %s category over generic stderr", async (category) => {
    const child = makeChild(1, category === "usage" ? "authentication required" : "usage limit");
    const gateway = makeGateway({ upstreamFailureCategory: category });
    const error = await createCodexProcessSummarizer({
      ...baseDeps(child),
      _createGateway: vi.fn().mockResolvedValue(gateway),
    } as never)("text", false).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain("Upgrade the Codex CLI");
    expect(error.message).toMatch(category === "usage" ? /usage limit/i : /authentication|sign in/i);
  });

  it("preserves gateway category precedence across abort, timeout, and success", async () => {
    const successGateway = makeGateway({ upstreamFailureCategory: "usage" });
    await expect(createCodexProcessSummarizer({
      ...baseDeps(makeChild(0)),
      _createGateway: vi.fn().mockResolvedValue(successGateway),
    })("text", false)).resolves.toBe("summary");

    const controller = new AbortController();
    const abortChild = makeHangingChild();
    abortChild.kill.mockImplementation(() => { abortChild.emit("close", null); });
    const abortSpawn = vi.fn().mockReturnValue(abortChild);
    const abortPending = createCodexProcessSummarizer({
      ...baseDeps(abortChild),
      spawn: abortSpawn as unknown as SpawnFn,
      _createGateway: vi.fn().mockResolvedValue(makeGateway({ upstreamFailureCategory: "usage" })),
    })("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(abortSpawn).toHaveBeenCalledOnce());
    controller.abort();
    await expect(abortPending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("preserves gateway category precedence on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = makeHangingChild();
      child.kill.mockImplementation(() => { child.emit("close", null); });
      const gateway = makeGateway({ upstreamFailureCategory: "authentication" });
      const pending = createCodexProcessSummarizer({
        ...baseDeps(child),
        timeoutMs: 1,
        _createGateway: vi.fn().mockResolvedValue(gateway),
      })("text", false);
      const observed = pending.then(() => undefined, error => error);
      await vi.waitFor(() => expect(child.stdin.listenerCount("error")).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1);
      await expect(observed).resolves.toMatchObject({ message: expect.stringMatching(/timed out/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps classified controls and known evidence for a null exit", async () => {
    const child = makeHangingChild();
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("data", "usage limit");
    child.emit("close", null);
    const error = await pending.catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/usage limit/i);
    expect(error.message).toContain('reasoning effort "default/omitted"');
  });

  it("lets abort win after quota stderr has been received", async () => {
    const controller = new AbortController();
    const child = makeHangingChild();
    child.kill.mockImplementation(() => { child.emit("close", null); });
    const spawn = vi.fn().mockReturnValue(child);
    const pending = createCodexProcessSummarizer({
      ...baseDeps(child),
      spawn: spawn as unknown as SpawnFn,
    })("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("data", "usage limit");
    controller.abort();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("ignores quota stderr on a successful exit", async () => {
    const child = makeChild(0, "usage limit");
    await expect(createCodexProcessSummarizer(baseDeps(child))("text", false)).resolves.toBe("summary");
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

  it("terminates the child and cleans owned resources when teardown setup throws", async () => {
    const child = makeHangingChild();
    vi.spyOn(child, "once").mockImplementation(() => {
      throw new Error("teardown listener setup failed");
    });
    const gateway = makeGateway();
    const rmSyncMock = vi.fn() as unknown as RmSyncFn;
    const summarizer = createCodexProcessSummarizer({
      ...baseDeps(child, { rmSync: rmSyncMock }),
      _createGateway: vi.fn(async () => gateway),
    } as never);

    await expect(summarizer("text", false)).rejects.toThrow("teardown listener setup failed");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(rmSyncMock).toHaveBeenCalledOnce();
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
