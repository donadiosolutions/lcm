import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  claude: vi.fn(), codex: vi.fn(), mock: vi.fn(), openai: vi.fn(), anthropic: vi.fn(),
}));

vi.mock("../../src/llm/claude-process.js", () => ({ createClaudeProcessSummarizer: mocks.claude }));
vi.mock("../../src/llm/codex-process.js", () => ({ createCodexProcessSummarizer: mocks.codex }));
vi.mock("../../src/llm/mock-summarizer.js", () => ({ createMockSummarizer: mocks.mock }));
vi.mock("../../src/llm/openai.js", () => ({ createOpenAISummarizer: mocks.openai }));
vi.mock("../../src/llm/anthropic.js", () => ({ createAnthropicSummarizer: mocks.anthropic }));

import { createSummarizer, makeSummarizerCache, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";

const summary = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReturnValue(summary);
});

describe("daemon summarizer selection", () => {
  it("resolves automatic providers by client and preserves explicit providers", () => {
    const config = loadDaemonConfig("/missing", { llm: { provider: "auto" } });
    expect(resolveEffectiveProvider(config)).toBe("claude-process");
    expect(resolveEffectiveProvider(config, "claude")).toBe("claude-process");
    expect(resolveEffectiveProvider(config, "codex")).toBe("codex-process");
    config.llm.provider = "disabled";
    expect(resolveEffectiveProvider(config, "codex")).toBe("disabled");
  });

  it("prioritizes mock mode and handles disabled mode", async () => {
    const config = loadDaemonConfig("/missing", { summarizer: { mock: true } });
    await expect(createSummarizer("disabled", config)).resolves.toBe(summary);
    expect(mocks.mock).toHaveBeenCalledOnce();
    config.summarizer.mock = false;
    await expect(createSummarizer("disabled", config)).resolves.toBeNull();
  });

  it("constructs process providers with defaults and overrides", async () => {
    const config = loadDaemonConfig("/missing", {
      llm: { model: "model", reasoningEffort: "high", fastMode: true },
    });
    await expect(createSummarizer("claude-process", config)).resolves.toBe(summary);
    expect(mocks.claude).toHaveBeenCalledWith({ model: "model", reasoningEffort: "high", fastMode: true, timeoutMs: 600_000 });
    await createSummarizer("codex-process", config, {
      reasoningEffort: "low",
      fastMode: false,
      requestPolicy: { requestTimeoutMs: 45_000, retry: config.llm.retry },
    });
    expect(mocks.codex).toHaveBeenCalledWith({ model: "model", reasoningEffort: "low", fastMode: false, timeoutMs: 45_000 });

    config.llm.reasoningEffort = undefined;
    config.llm.fastMode = undefined;
    await createSummarizer("claude-process", config);
    expect(mocks.claude).toHaveBeenLastCalledWith({ model: "model", reasoningEffort: undefined, fastMode: false, timeoutMs: 600_000 });
    await createSummarizer("codex-process", config);
    expect(mocks.codex).toHaveBeenLastCalledWith({ model: "model", reasoningEffort: undefined, fastMode: false, timeoutMs: 600_000 });
  });

  it("constructs OpenAI and Anthropic providers", async () => {
    const config = loadDaemonConfig("/missing");
    Object.assign(config.llm, {
      provider: "openai", model: "model", baseUrl: "http://localhost:11435/v1", apiKey: "key",
      reasoningEffort: "medium", requestTimeoutMs: 10, retry: { maxAttempts: 1, initialDelayMs: 2, maxDelayMs: 3 },
    });
    await expect(createSummarizer("openai", config, {
      reasoningEffort: "high",
      requestPolicy: { requestTimeoutMs: 20, retry: { maxAttempts: 2, initialDelayMs: 4, maxDelayMs: 5 } },
    })).resolves.toBe(summary);
    expect(mocks.openai).toHaveBeenCalledWith(expect.objectContaining({
      model: "model", baseUrl: "http://localhost:11435/v1", apiKey: "key", apiMode: "chat-completions",
      reasoningEffort: "high", requestTimeoutMs: 20, retry: { maxAttempts: 2, initialDelayMs: 4, maxDelayMs: 5 },
    }));
    config.llm.apiMode = "responses";
    await createSummarizer("openai", config);
    expect(mocks.openai).toHaveBeenLastCalledWith(expect.objectContaining({
      apiMode: "responses", reasoningEffort: "medium", requestTimeoutMs: 10,
    }));
    config.llm.apiMode = undefined;
    config.llm.reasoningEffort = undefined;
    config.llm.requestTimeoutMs = undefined;
    config.llm.retry = undefined;
    await createSummarizer("openai", config);
    expect(mocks.openai).toHaveBeenLastCalledWith(expect.objectContaining({
      apiMode: "chat-completions", reasoningEffort: undefined, requestTimeoutMs: undefined, retry: undefined,
    }));
    config.llm.requestTimeoutMs = 30;
    config.llm.retry = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 };
    await createSummarizer("openai", config, { requestPolicy: { requestTimeoutMs: undefined, retry: undefined } as never });
    expect(mocks.openai).toHaveBeenLastCalledWith(expect.objectContaining({ requestTimeoutMs: 30, retry: config.llm.retry }));
    await expect(createSummarizer("anthropic", config)).resolves.toBe(summary);
    expect(mocks.anthropic).toHaveBeenCalledWith({ model: "model", apiKey: "key" });
  });

  it("memoizes equal effective policies and separates every key dimension", async () => {
    const config = loadDaemonConfig("/missing", { llm: { model: "m" } });
    config.llm.requestTimeoutMs = 100;
    const cache = makeSummarizerCache(config);
    const first = cache("claude-process");
    expect(cache("claude-process")).toBe(first);
    await first;
    expect(mocks.claude).toHaveBeenCalledOnce();

    await cache("claude-process", "low", true, {
      requestTimeoutMs: 200, retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
    });
    await cache("claude-process", "low", true, {
      requestTimeoutMs: 201, retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
    });
    expect(mocks.claude).toHaveBeenCalledTimes(3);

    config.llm.apiMode = "responses";
    config.llm.reasoningEffort = "medium";
    config.llm.fastMode = true;
    config.llm.requestTimeoutMs = undefined;
    config.llm.retry = undefined;
    const configured = makeSummarizerCache(config);
    await configured("claude-process");
    await configured("claude-process", undefined, false);
    await configured("claude-process", undefined, undefined, null as never);
    expect(mocks.claude).toHaveBeenCalledTimes(5);

    config.llm.fastMode = undefined;
    const noFastMode = makeSummarizerCache(config);
    await noFastMode("claude-process");
  });

  it("threads one factory-scoped daemon witness through cached process providers", async () => {
    const config = loadDaemonConfig("/missing", { llm: { model: "m" } });
    const witnessStore = {
      path: "/tmp/daemon-runtime.json",
      add: vi.fn(),
      remove: vi.fn(),
    };
    const daemonInstanceId = "33333333-3333-4333-8333-333333333333";
    const cache = makeSummarizerCache(config, { daemonInstanceId, witnessStore });
    await cache("claude-process");
    expect(mocks.claude).toHaveBeenCalledWith(expect.objectContaining({ daemonInstanceId, witnessStore }));
    await cache("codex-process");
    expect(mocks.codex).toHaveBeenCalledWith(expect.objectContaining({ daemonInstanceId, witnessStore }));
  });
});
