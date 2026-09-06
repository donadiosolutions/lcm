import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __codexConfigTestUtils,
  type CodexConfigDeps,
  resolveCodexOpenAIBaseUrl as resolveCodexOpenAIBaseUrlWithHostDefaults,
} from "../../src/llm/codex-config.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  requests: unknown[];
  pid?: number;
};

function childWithProtocol(lines: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit("close", 0); return true; });
  child.requests = [];
  child.pid = 8123;
  let requestBuffer = "";
  let responseIndex = 0;
  child.stdin.on("data", (chunk) => {
    requestBuffer += chunk.toString();
    let newline = requestBuffer.indexOf("\n");
    while (newline >= 0) {
      const request = requestBuffer.slice(0, newline);
      requestBuffer = requestBuffer.slice(newline + 1);
      newline = requestBuffer.indexOf("\n");
      let parsed: unknown;
      try { parsed = JSON.parse(request) as unknown; } catch { continue; }
      child.requests.push(parsed);
      const method = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { method?: unknown }).method
        : undefined;
      if (method === "initialize" && responseIndex === 0) {
        child.stdout.write(`${lines[0]}\n`);
        if (lines[0]?.includes('"id":2') && lines[2] !== undefined) {
          child.stdout.write(`${lines[1]}\n`);
          responseIndex = 2;
        } else {
          responseIndex = 1;
        }
      } else if (method === "config/read" && responseIndex === 1) {
        setImmediate(() => {
          child.stdout.write(`${lines[1]}\n`);
          child.stdout.end();
          child.emit("close", 0);
        });
        responseIndex = 2;
      } else if (method === "config/read" && responseIndex === 2) {
        setImmediate(() => {
          child.stdout.write(`${lines[2]}\n`);
          child.stdout.end();
          child.emit("close", 0);
        });
        responseIndex = 3;
      }
    }
  });
  return child;
}

function spawnFor(child: FakeChild) {
  return vi.fn(() => child) as never;
}

function isolatedProcessOptions(): CodexConfigDeps {
  return {
    platform: "linux",
    daemonProcessGroupId: 8100,
    killProcess: vi.fn(),
    isProcessGroupAlive: () => false,
    processGroupIdProbe: pid => pid,
    processBirthTime: pid => `birth-${pid}`,
  };
}

function resolveCodexOpenAIBaseUrl(
  options: CodexConfigDeps = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  return resolveCodexOpenAIBaseUrlWithHostDefaults({
    ...isolatedProcessOptions(),
    ...options,
  }, signal);
}

function hangingChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit("close", null); return true; });
  child.pid = 8124;
  return child;
}

function childWithForcedGroupCleanup(configValue: unknown): {
  child: FakeChild;
  isGroupAlive: () => boolean;
  killProcess: ReturnType<typeof vi.fn>;
} {
  const child = hangingChild();
  child.stdin.removeAllListeners("data");
  let groupAlive = true;
  child.stdin.on("data", (chunk) => {
    const requests = chunk.toString().trim().split("\n").map(line => JSON.parse(line) as { method?: string });
    for (const request of requests) {
      if (request.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      } else if (request.method === "config/read") {
        const config = configValue === undefined ? {} : { openai_base_url: configValue };
        child.stdout.write(`${JSON.stringify({ id: 2, result: { config } })}\n`);
        child.stdout.end();
      }
    }
  });
  const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") {
      groupAlive = false;
      child.emit("close", null, "SIGKILL");
    }
  });
  return { child, isGroupAlive: () => groupAlive, killProcess };
}

let hostProcessKill: ReturnType<typeof vi.spyOn>;

describe("resolveCodexOpenAIBaseUrl", () => {
  beforeEach(() => {
    hostProcessKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("unexpected host process signal"), { code: "ESRCH" });
    });
  });

  afterEach(() => {
    try {
      expect(hostProcessKill).not.toHaveBeenCalled();
    } finally {
      hostProcessKill.mockRestore();
    }
  });

  it("covers strict framing and URL normalization edges", () => {
    const utils = __codexConfigTestUtils;
    expect(utils.normalizeConfiguredUrl(undefined)).toBeUndefined();
    expect(utils.normalizeConfiguredUrl(null)).toBeUndefined();
    expect(utils.normalizeConfiguredUrl("https://example.test/responses/")).toBe("https://example.test/responses");
    expect(() => utils.normalizeConfiguredUrl(42)).toThrow("codex endpoint resolution failed");
    expect(() => utils.normalizeConfiguredUrl(" ")).toThrow("codex endpoint resolution failed");
    expect(() => utils.configValueFromResponse({ result: {} })).toThrow();
    expect(() => utils.configValueFromResponse(null)).toThrow();
    expect(() => utils.configValueFromResponse([])).toThrow();
    expect(() => utils.configValueFromResponse({ result: null })).toThrow();
    expect(() => utils.configValueFromResponse({ result: [] })).toThrow();
    expect(() => utils.configValueFromResponse({ result: { config: null } })).toThrow();
    expect(() => utils.configValueFromResponse({ result: { config: [] } })).toThrow();
    expect(utils.responseId(null)).toBeUndefined();
    expect(utils.responseId([])).toBeUndefined();
    expect(utils.responseId({ id: "1" })).toBeUndefined();
    expect(utils.responseId({ id: 1 })).toBe(1);
    expect(utils.responseHasError(null)).toBe(false);
    expect(utils.responseHasError([])).toBe(false);
    expect(utils.responseHasError({})).toBe(false);
    expect(utils.responseHasError({ error: "bad" })).toBe(true);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const state = { line: "" };
    expect(utils.parseProtocolLine(decoder, new TextEncoder().encode("{"), state)).toEqual([]);
    expect(utils.parseProtocolLine(decoder, new TextEncoder().encode("}\n"), state)).toEqual([{}]);
    expect(() => utils.parseProtocolLine(new TextDecoder(), new TextEncoder().encode("x".repeat(4 * 1024 * 1024 + 1)), { line: "" })).toThrow();
    expect(utils.parseProtocolLine(decoder, new TextEncoder().encode("\n{}\r\n"), state)).toEqual([{}]);
    expect(() => utils.parseProtocolLine(new TextDecoder(), new TextEncoder().encode(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`), { line: "" })).toThrow();
    expect(() => utils.parseProtocolLine(decoder, new TextEncoder().encode("not-json\n"), state)).toThrow();
    expect(() => utils.parseProtocolLine(new TextDecoder("utf-8", { fatal: true }), Uint8Array.from([0xff]), { line: "" })).toThrow();
  });

  it("performs initialize, initialized, config/read and returns a normalized URL", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: { openai_base_url: "https://proxy.example/v1/" } } }),
    ]);
    const spawn = spawnFor(child);
    // Exercise the host-platform fallback while retaining isolated process seams.
    await expect(resolveCodexOpenAIBaseUrl({
      spawn,
      platform: undefined,
      processBirthTime: () => "birth",
      env: { CODEX_HOME: "/private/.codex" },
    }))
      .resolves.toBe("https://proxy.example/v1/responses");
    expect(child.requests).toEqual([
      {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "lcm", version: "1" } },
      },
      { method: "initialized" },
      {
        id: 2,
        method: "config/read",
        params: { includeLayers: false, cwd: process.cwd() },
      },
    ]);
    expect((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(expect.arrayContaining([
      "codex", ["app-server", "--listen", "stdio://"], expect.objectContaining({ env: { CODEX_HOME: "/private/.codex" } }),
    ]));
  });

  it("ignores an out-of-order config response until initialize completes", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 2, result: { config: {} } }),
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("uses the default child-process spawn when no spawn seam is supplied", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    vi.doMock("node:child_process", () => ({ spawn: spawnFor(child) }));
    vi.resetModules();
    try {
      const module = await import("../../src/llm/codex-config.js");
      await expect(module.resolveCodexOpenAIBaseUrl({
        ...isolatedProcessOptions(),
        processBirthTime: () => "birth",
      })).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("returns undefined when the merged config has no override", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("treats an explicit null openai_base_url as the token-class default", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: { openai_base_url: null } } }),
    ]);
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("accepts intentional SIGTERM settlement after a valid config response", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    child.stdin.removeAllListeners("data");
    child.stdin.on("data", () => {
      child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: { config: {} } })}\n`);
      child.stdout.end();
      child.emit("close", null, "SIGTERM");
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("preserves a validated endpoint after TERM is ignored and KILL settles the owned group", async () => {
    vi.useFakeTimers();
    try {
      const forced = childWithForcedGroupCleanup("https://forced.example/v1/");
      const { child, isGroupAlive, killProcess } = forced;
      const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
      let outcome: string | undefined;
      const pending = resolveCodexOpenAIBaseUrl({
        spawn: spawnFor(child),
        platform: "linux",
        processBirthTime: () => "birth",
        processGroupId: 8124,
        daemonProcessGroupId: 8122,
        processGroupIdProbe: () => 8124,
        isProcessGroupAlive: isGroupAlive,
        killProcess,
        timeoutMs: 20_000,
        daemonInstanceId: "daemon",
        witnessStore,
      }).then(value => { outcome = value; return value; });

      await vi.advanceTimersByTimeAsync(0);
      expect(killProcess).toHaveBeenCalledWith(-8124, "SIGTERM");
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(killProcess).not.toHaveBeenCalledWith(-8124, "SIGKILL");
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("https://forced.example/v1/responses");
      expect(killProcess).toHaveBeenCalledWith(-8124, "SIGKILL");
      expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves absent and null defaults after forced cleanup", async () => {
    vi.useFakeTimers();
    try {
      for (const configValue of [undefined, null]) {
        const { child, isGroupAlive, killProcess } = childWithForcedGroupCleanup(configValue);
        const pending = resolveCodexOpenAIBaseUrl({
          spawn: spawnFor(child),
          platform: "linux",
          processBirthTime: () => "birth",
          processGroupId: 8124,
          daemonProcessGroupId: 8122,
          processGroupIdProbe: () => 8124,
          isProcessGroupAlive: isGroupAlive,
          killProcess,
          timeoutMs: 20_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(killProcess).toHaveBeenCalledWith(-8124, "SIGTERM");
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toBeUndefined();
        expect(killProcess).toHaveBeenCalledWith(-8124, "SIGKILL");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for malformed, sensitive, and non-http URLs", async () => {
    for (const value of ["not a url", "https://[", "file:///tmp/x", "https://user:pass@example.test", "https://example.test/x?q=1"]) {
      const child = childWithProtocol([
        JSON.stringify({ id: 1, result: {} }),
        JSON.stringify({ id: 2, result: { config: { openai_base_url: value } } }),
      ]);
      await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
        .rejects.toThrow("codex endpoint resolution failed");
    }
  });

  it("fails closed when protocol data ends before config/read", async () => {
    const child = childWithProtocol([]);
    child.stdin.removeAllListeners("data");
    child.stdin.on("data", () => { child.stdout.end(); child.emit("close", 0); });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects a nonzero close before a valid config response", async () => {
    const child = hangingChild();
    const killProcess = vi.fn();
    child.stdin.on("data", () => { child.stdout.end(); child.emit("close", 2); });
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "linux",
      processBirthTime: () => "birth",
      processGroupId: 8124,
      daemonProcessGroupId: 8122,
      processGroupIdProbe: () => 8124,
      isProcessGroupAlive: () => false,
      killProcess,
    }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects a partial JSONL frame at EOF and an app-server error event", async () => {
    const partial = hangingChild();
    partial.stdin.on("data", () => { partial.stdout.write("{\"id\":1"); partial.stdout.end(); partial.emit("close", 0); });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(partial), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
    const errored = hangingChild();
    const pending = resolveCodexOpenAIBaseUrl({ spawn: spawnFor(errored), processBirthTime: () => "birth" });
    await vi.waitFor(() => expect(errored.stdin.writableLength).toBeGreaterThanOrEqual(0));
    errored.emit("error", new Error("secret app-server error"));
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects a decoder error raised only when the final UTF-8 frame flushes", async () => {
    const child = hangingChild();
    child.stdin.on("data", () => {
      child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      child.stdout.write(Uint8Array.from([0xc3]));
      child.stdout.end();
      child.emit("close", 0);
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects an unterminated trailing frame in the config response chunk", async () => {
    const child = hangingChild();
    let written = false;
    child.stdin.on("data", () => {
      if (written) return;
      written = true;
      child.stdout.write(
        `${JSON.stringify({ id: 1, result: {} })}\n`
        + `${JSON.stringify({ id: 2, result: { config: {} } })}\nnot-json`,
      );
      child.emit("close", 0);
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects an incomplete multibyte character in the config response chunk", async () => {
    const child = hangingChild();
    let written = false;
    child.stdin.on("data", () => {
      if (written) return;
      written = true;
      child.stdout.write(
        Buffer.concat([
          Buffer.from(`${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: { config: {} } })}\n`),
          Buffer.from([0xc3]),
        ]),
      );
      child.emit("close", 0);
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("accepts a valid multibyte character split across protocol chunks", async () => {
    const child = hangingChild();
    let written = false;
    child.stdin.on("data", () => {
      if (written) return;
      written = true;
      const response = Buffer.from(
        `${JSON.stringify({ id: 1, result: {} })}\n`
        + `${JSON.stringify({ id: 2, result: { config: {}, note: "cafe\u0301" } })}\n`,
      );
      const split = response.indexOf(Buffer.from("\u0301")) + 1;
      child.stdout.write(response.subarray(0, split));
      child.stdout.write(response.subarray(split));
      child.emit("close", 0);
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("fails closed on an asynchronous app-server stdin error", async () => {
    const child = hangingChild();
    const pending = resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" });
    child.stdin.emit("error", Object.assign(new Error("EPIPE secret"), { code: "EPIPE" }));
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
  });

  it("fails closed when config/read framing throws asynchronously", async () => {
    const child = hangingChild();
    const originalWrite = child.stdin.write.bind(child.stdin);
    let writes = 0;
    child.stdin.write = ((chunk: string | Uint8Array) => {
      writes += 1;
      if (writes >= 2) throw new Error("config write failed");
      return originalWrite(chunk);
    }) as typeof child.stdin.write;
    child.stdin.on("data", () => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
    const pending = resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" });
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
  });

  it("rejects an incomplete UTF-8 code point after the stream iterator ends", async () => {
    const child = hangingChild();
    const first = new TextEncoder().encode(`${JSON.stringify({ id: 1, result: {} })}\n`);
    child.stdout = {
      async *[Symbol.asyncIterator]() {
        yield first;
        yield Uint8Array.from([0xc3]);
      },
    } as never;
    child.stdin.on("data", () => { setImmediate(() => child.emit("close", 0)); });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });

  it("fails closed for spawn, protocol, and process failures", async () => {
    await expect(resolveCodexOpenAIBaseUrl({ spawn: vi.fn(() => { throw new Error("missing"); }) as never }))
      .rejects.toThrow("codex endpoint resolution failed");
    for (const lines of [
      [JSON.stringify({ id: 1, error: { code: "bad" } })],
      [JSON.stringify({ id: 1, result: {} }), JSON.stringify({ id: 2, error: { code: "bad" } })],
      [JSON.stringify({ id: 1, result: {} }), JSON.stringify({ id: 2, result: { config: "bad" } })],
    ]) {
      await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(childWithProtocol(lines)), processBirthTime: () => "birth" }))
        .rejects.toThrow("codex endpoint resolution failed");
    }
    const nonzero = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    nonzero.stdin.removeAllListeners("data");
    nonzero.stdin.on("data", () => {
      nonzero.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: { config: {} } })}\n`);
      nonzero.stdout.end();
      nonzero.emit("close", 2);
    });
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(nonzero),
      platform: "linux",
      processBirthTime: () => "birth",
      processGroupId: 8123,
      daemonProcessGroupId: 8122,
      processGroupIdProbe: () => 8123,
      isProcessGroupAlive: () => false,
      killProcess: vi.fn(),
    }))
      .resolves.toBeUndefined();
  });

  it("fails closed when the app-server stdin or teardown setup fails", async () => {
    const writeFailure = hangingChild();
    writeFailure.stdin.write = () => { throw new Error("write failed"); };
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(writeFailure), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
    const kill = vi.fn();
    const malformed = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill };
    await expect(resolveCodexOpenAIBaseUrl({ spawn: vi.fn(() => malformed) as never }))
      .rejects.toThrow("codex endpoint resolution failed");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("aborts and tears down a stalled app-server", async () => {
    const child = hangingChild();
    const controller = new AbortController();
    const killProcess = vi.fn(() => { child.emit("close", null); });
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      processBirthTime: () => "birth",
      platform: "linux",
      processGroupId: 8123,
      daemonProcessGroupId: 8122,
      processGroupIdProbe: () => 8123,
      isProcessGroupAlive: () => false,
      killProcess,
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(killProcess).toHaveBeenCalled();
  });

  it("removes the witness once after a proven protocol failure", async () => {
    const child = hangingChild();
    child.stdin.on("data", () => {
      child.stdout.write(`${JSON.stringify({ id: 1, error: { code: "bad" } })}\n`);
    });
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    })).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("removes the witness once after a proven child error", async () => {
    const child = hangingChild();
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    });
    child.emit("error", new Error("child failed"));
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("removes the witness once after a proven stdin error", async () => {
    const child = hangingChild();
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    });
    child.stdin.emit("error", new Error("stdin failed"));
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("removes the witness once after a proven abort", async () => {
    const child = hangingChild();
    const controller = new AbortController();
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    }, controller.signal);
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("removes the witness once after a proven timeout", async () => {
    const child = hangingChild();
    let timeout: (() => void) | undefined;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
      timeoutMs: 10,
      setTimeout: vi.fn((callback: () => void) => {
        timeout = callback;
        return 1 as never;
      }) as never,
      clearTimeout: vi.fn(),
    });
    await vi.waitFor(() => expect(timeout).toBeTypeOf("function"));
    timeout?.();
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("retains the witness when failure teardown cannot prove settlement", async () => {
    const child = hangingChild();
    child.kill = vi.fn(() => true);
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const setTimeoutMock = vi.fn((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
      timeoutMs: 10_000,
      setTimeout: setTimeoutMock,
      clearTimeout: vi.fn(),
    });
    const observed = pending.then(() => undefined, error => error);
    child.emit("error", new Error("child failed"));
    await vi.waitFor(() => expect(timers.filter(timer => timer.delay === 2_000)).toHaveLength(1));
    timers.find(timer => timer.delay === 2_000)?.callback();
    await vi.waitFor(() => expect(timers.filter(timer => timer.delay === 2_000)).toHaveLength(2));
    timers.filter(timer => timer.delay === 2_000)[1]?.callback();
    await expect(observed).resolves.toMatchObject({ message: expect.stringContaining("codex endpoint resolution failed") });
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).not.toHaveBeenCalled();
  });

  it("preserves the original failure when witness removal throws", async () => {
    const child = hangingChild();
    child.stdin.on("data", () => {
      child.stdout.write(`${JSON.stringify({ id: 1, error: { code: "secret" } })}\n`);
    });
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw new Error("remove failed"); }),
      path: "/tmp/witness",
    };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    })).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.remove).toHaveBeenCalledOnce();
  });

  it("preserves AbortError when witness removal throws", async () => {
    const child = hangingChild();
    const controller = new AbortController();
    const witnessStore = {
      add: vi.fn(),
      remove: vi.fn(() => { throw new Error("remove failed"); }),
      path: "/tmp/witness",
    };
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child),
      platform: "win32",
      processBirthTime: () => "birth",
      daemonInstanceId: "daemon",
      witnessStore,
    }, controller.signal);
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(witnessStore.remove).toHaveBeenCalledOnce();
  });

  it("fails closed when a detached group survives intentional TERM and KILL", async () => {
    vi.useFakeTimers();
    try {
      const child = hangingChild();
      let written = false;
      child.stdin.on("data", () => {
        if (written) return;
        written = true;
        child.stdout.write(
          `${JSON.stringify({ id: 1, result: {} })}\n`
          + `${JSON.stringify({ id: 2, result: { config: {} } })}\n`,
        );
        child.emit("close", null, "SIGTERM");
      });
      const killProcess = vi.fn();
      const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
      const pending = resolveCodexOpenAIBaseUrl({
        spawn: spawnFor(child),
        platform: "linux",
        processBirthTime: () => "birth",
        daemonInstanceId: "daemon",
        witnessStore,
        processGroupIdProbe: () => 8124,
        isProcessGroupAlive: () => true,
        killProcess,
      });
      const observed = pending.then(() => undefined, error => error);
      await vi.waitFor(() => expect(killProcess).toHaveBeenCalledWith(-8124, "SIGTERM"));
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(observed).resolves.toMatchObject({ message: expect.stringContaining("codex endpoint resolution failed") });
      expect(killProcess).toHaveBeenCalledWith(-8124, "SIGKILL");
      expect(witnessStore.add).toHaveBeenCalledOnce();
      expect(witnessStore.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the resolver timeout and keeps errors secret-free", async () => {
    const child = hangingChild();
    let timeout: (() => void) | undefined;
    const pending = resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child), processBirthTime: () => "birth", timeoutMs: 10,
      setTimeout: vi.fn((callback: () => void) => { timeout = callback; return 1 as never; }) as never,
      clearTimeout: vi.fn(),
    });
    await vi.waitFor(() => expect(timeout).toBeTypeOf("function"));
    timeout?.();
    await expect(pending).rejects.toThrow("codex endpoint resolution failed");
  });

  it("records and removes a secret-free resolver witness", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child), processBirthTime: () => "birth", daemonInstanceId: "daemon",
      invocationId: "invocation", witnessStore,
    })).resolves.toBeUndefined();
    expect(witnessStore.add).toHaveBeenCalledOnce();
    expect(witnessStore.remove).toHaveBeenCalledWith(witnessStore.add.mock.calls[0]?.[0]);
  });

  it("does not attempt witness cleanup when publication itself fails", async () => {
    const child = hangingChild();
    const witnessStore = { add: vi.fn(() => { throw new Error("publish failed"); }), remove: vi.fn(), path: "/tmp/witness" };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child), processBirthTime: () => "birth", daemonInstanceId: "daemon", witnessStore,
    })).rejects.toThrow("codex endpoint resolution failed");
    expect(witnessStore.remove).not.toHaveBeenCalled();
  });

  it("ignores a late resolver error after a successful response", async () => {
    const child = childWithProtocol([]);
    child.stdin.removeAllListeners("data");
    let written = false;
    child.stdin.on("data", () => {
      if (written) return;
      written = true;
      child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 2, result: { config: {} } })}\n`);
      child.stdout.end();
      setImmediate(() => child.emit("error", new Error("late")));
      child.emit("close", 0);
    });
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(child), processBirthTime: () => "birth" }))
      .resolves.toBeUndefined();
  });

  it("uses the default process identity probe when no resolver probe is supplied", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    const witnessStore = { add: vi.fn(), remove: vi.fn(), path: "/tmp/witness" };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child), platform: "win32", processBirthTime: undefined,
      daemonInstanceId: "daemon", witnessStore,
    })).resolves.toBeUndefined();
    expect(witnessStore.add).toHaveBeenCalledOnce();
  });

  it("keeps resolver success when identity probing and witness removal fail", async () => {
    const child = childWithProtocol([
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { config: {} } }),
    ]);
    const witnessStore = { add: vi.fn(), remove: vi.fn(() => { throw new Error("remove failed"); }), path: "/tmp/witness" };
    await expect(resolveCodexOpenAIBaseUrl({
      spawn: spawnFor(child), processBirthTime: () => { throw new Error("probe failed"); },
      daemonInstanceId: "daemon", witnessStore,
    })).resolves.toBeUndefined();
  });

  it("bounds streamed protocol chunks and rejects non-byte output", async () => {
    const oversized = hangingChild();
    oversized.stdout = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(8 * 1024 * 1024 + 1);
      },
    } as never;
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(oversized), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");

    const nonBytes = hangingChild();
    nonBytes.stdout = {
      async *[Symbol.asyncIterator]() {
        yield "not bytes";
      },
    } as never;
    await expect(resolveCodexOpenAIBaseUrl({ spawn: spawnFor(nonBytes), processBirthTime: () => "birth" }))
      .rejects.toThrow("codex endpoint resolution failed");
  });
});
