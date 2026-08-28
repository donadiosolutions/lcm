import { describe, it, expect, vi } from "vitest";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";
import { createAbortError, isAbortError } from "../../src/daemon/cancellation.js";

describe("createAnthropicSummarizer", () => {
  it("constructs the default SDK client lazily", () => {
    expect(createAnthropicSummarizer({ model: "model", apiKey: "key" })).toBeTypeOf("function");
  });
  it("calls Anthropic and returns text", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Summary." }],
    });
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    const result = await summarizer("Conversation text", false, { isCondensed: false });
    expect(result).toBe("Summary.");
    expect(mockCreate).toHaveBeenCalledOnce();
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(1024);
    expect(args.system).toBeDefined();
  });

  it("forwards a per-call signal and skips a pre-aborted request", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const preCreate = vi.fn();
    const preSummarizer = createAnthropicSummarizer({
      model: "model",
      apiKey: "key",
      _clientOverride: { messages: { create: preCreate } },
    });

    await expect(preSummarizer("text", false, { signal: preAborted.signal }))
      .rejects.toSatisfy(error => isAbortError(error));
    expect(preCreate).not.toHaveBeenCalled();

    const controller = new AbortController();
    const create = vi.fn(() => new Promise<never>(() => {}));
    const summarizer = createAnthropicSummarizer({
      model: "model",
      apiKey: "key",
      _clientOverride: { messages: { create } },
    });
    const pending = summarizer("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
  });

  it("aborts a retry delay without starting another attempt", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockRejectedValue(new Error("temporary"));
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const summarizer = createAnthropicSummarizer({
      model: "model",
      apiKey: "key",
      _retryDelayMs: 1000,
      _clientOverride: { messages: { create } },
      _sleep: sleep,
    });

    const pending = summarizer("text", false, { signal: controller.signal });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toSatisfy(error => isAbortError(error));
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not retry an already-marked intentional abort from a client", async () => {
    const create = vi.fn().mockRejectedValue(createAbortError());
    const summarizer = createAnthropicSummarizer({
      model: "model",
      apiKey: "key",
      _clientOverride: { messages: { create } },
    });
    await expect(summarizer("text", false)).rejects.toSatisfy(error => isAbortError(error));
    expect(create).toHaveBeenCalledOnce();
  });

  it("retries once on empty content, then returns", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Retry." }] });
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    expect(await summarizer("text", false)).toBe("Retry.");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on 401 auth error", async () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    const mockCreate = vi.fn().mockRejectedValue(err);
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "bad",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    await expect(summarizer("text", false)).rejects.toThrow("auth");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries 3 times on 429 rate limit then throws", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const mockCreate = vi.fn().mockRejectedValue(err);
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
      _retryDelayMs: 0,
    });
    await expect(summarizer("text", false)).rejects.toThrow("rate limited");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("builds condensed and aggressive prompts with explicit targets", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Summary" }] });
    const summarizer = createAnthropicSummarizer({
      model: "model", apiKey: "key", _clientOverride: { messages: { create: mockCreate } },
    });
    await summarizer("text", true, { isCondensed: true, targetTokens: 42, depth: 3 });
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain("42");
  });

  it("builds an aggressive leaf prompt", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
    const summarizer = createAnthropicSummarizer({ model: "model", apiKey: "key", _clientOverride: { messages: { create } } });
    await summarizer("text", true, { isCondensed: false });
    expect(create).toHaveBeenCalled();
  });

  it("falls back to source text when empty responses persist", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: "tool_use" }] });
    const summarizer = createAnthropicSummarizer({
      model: "model", apiKey: "key", _clientOverride: { messages: { create: mockCreate } },
    });
    await expect(summarizer("source text", false)).resolves.toBe("source text");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns source fallback after a retryable error followed by empty content", async () => {
    const mockCreate = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ content: [] });
    const summarizer = createAnthropicSummarizer({
      model: "model", apiKey: "key", _retryDelayMs: 0,
      _clientOverride: { messages: { create: mockCreate } },
    });
    await expect(summarizer("source", true, { isCondensed: true })).resolves.toBe("source");
  });

  it("preserves a non-Error terminal failure", async () => {
    const mockCreate = vi.fn().mockRejectedValue("plain failure");
    const summarizer = createAnthropicSummarizer({
      model: "model", apiKey: "key", _retryDelayMs: 0,
      _clientOverride: { messages: { create: mockCreate } },
    });
    await expect(summarizer("source", false)).rejects.toBe("plain failure");
  });
});
