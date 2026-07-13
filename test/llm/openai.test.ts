import { describe, it, expect, vi } from "vitest";
import { createOpenAISummarizer } from "../../src/llm/openai.js";

describe("createOpenAISummarizer", () => {
  function makeClient(text = "Summary.") {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: text } }],
          }),
        },
      },
      responses: {
        create: vi.fn().mockResolvedValue({ output_text: text }),
      },
    };
  }

  it("calls OpenAI-compatible endpoint and returns text", async () => {
    const mockClient = makeClient("Summary.");
    const summarizer = createOpenAISummarizer({
      model: "qwen2.5:14b",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    const result = await summarizer("Conversation text", false, { isCondensed: false });
    expect(result).toBe("Summary.");
    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
    const args = mockClient.chat.completions.create.mock.calls[0][0];
    expect(args.model).toBe("qwen2.5:14b");
    expect(args.max_tokens).toBe(1024);
    // System prompt is merged into user message for local LLM compatibility
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe("user");
    expect(args.messages[0].content).toContain("context-compaction summarization engine");
    expect(mockClient.responses.create).not.toHaveBeenCalled();
  });

  it("uses Chat Completions when apiMode is explicitly selected", async () => {
    const mockClient = makeClient();
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "https://api.openai.com/v1",
      apiMode: "chat-completions",
      _clientOverride: mockClient as any,
    });

    await summarizer("text", false);

    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
    expect(mockClient.responses.create).not.toHaveBeenCalled();
  });

  it("calls the Responses API with the combined prompt", async () => {
    const mockClient = makeClient("Responses summary.");
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      reasoningEffort: "high",
      _clientOverride: mockClient as any,
    });

    await expect(summarizer("Conversation text", false)).resolves.toBe("Responses summary.");
    expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
    expect(mockClient.responses.create).toHaveBeenCalledOnce();
    const args = mockClient.responses.create.mock.calls[0][0];
    expect(args).toEqual({
      model: "gpt-5",
      max_output_tokens: 1024,
      input: expect.stringContaining("context-compaction summarization engine"),
      reasoning: { effort: "high" },
    });
    expect(args.input).toContain("Conversation text");
  });

  it("omits reasoning from Responses requests when effort is unset", async () => {
    const mockClient = makeClient();
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient as any,
    });

    await summarizer("text", false);

    const args = mockClient.responses.create.mock.calls[0][0];
    expect(args).not.toHaveProperty("reasoning");
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"] as const)(
    "passes the %s reasoning effort to Responses",
    async (reasoningEffort) => {
      const mockClient = makeClient();
      const summarizer = createOpenAISummarizer({
        model: "gpt-5",
        baseURL: "https://api.openai.com/v1",
        apiMode: "responses",
        reasoningEffort,
        _clientOverride: mockClient as any,
      });

      await summarizer("text", false);

      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: reasoningEffort } }),
      );
    },
  );

  it("fails immediately with a safe actionable error when reasoning is rejected", async () => {
    const secretPrompt = "SECRET PROMPT CONTENT";
    const secretProviderMessage = `unsupported: ${secretPrompt} sk-secret`;
    const err = Object.assign(new Error(secretProviderMessage), {
      status: 400,
      code: "unsupported_value",
      request: { apiKey: "sk-secret", input: secretPrompt },
    });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model: "gpt-4.1",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      reasoningEffort: "xhigh",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });

    let thrown: Error | undefined;
    try {
      await summarizer(secretPrompt, false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("api mode responses");
    expect(thrown?.message).toContain('model "gpt-4.1"');
    expect(thrown?.message).toContain('reasoning effort "xhigh"');
    expect(thrown?.message).toContain("status 400");
    expect(thrown?.message).toContain("code unsupported_value");
    expect(thrown?.message).toContain("choose a supported effort");
    expect(thrown?.message).not.toContain(secretPrompt);
    expect(thrown?.message).not.toContain("sk-secret");
    expect(mockClient.responses.create).toHaveBeenCalledOnce();
  });

  it("safely wraps Responses configuration errors when reasoning effort is omitted", async () => {
    const secretPrompt = "PRIVATE CONVERSATION";
    const model = "gpt-4.1\nFORGED LOG LINE";
    const err = Object.assign(new Error(`invalid request: ${secretPrompt} sk-private`), {
      status: 400,
      request: { apiKey: "sk-private", input: secretPrompt },
    });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model,
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });

    let thrown: Error | undefined;
    try {
      await summarizer(secretPrompt, false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("api mode responses");
    expect(thrown?.message).toContain('model "gpt-4.1\\nFORGED LOG LINE"');
    expect(thrown?.message).not.toContain(model);
    expect(thrown?.message).toContain('reasoning effort "default/omitted"');
    expect(thrown?.message).toContain("status 400");
    expect(thrown?.message).toContain("supports the Responses API");
    expect(thrown?.message).not.toContain(secretPrompt);
    expect(thrown?.message).not.toContain("sk-private");
    expect(mockClient.responses.create).toHaveBeenCalledOnce();
  });

  it("retries 3 times on 5xx error then throws", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });
    await expect(summarizer("text", false)).rejects.toThrow("server error");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on a Chat Completions configuration error", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });

    await expect(summarizer("text", false)).rejects.toThrow("bad request");
    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
  });

  it("throws immediately on 401 auth error", async () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    await expect(summarizer("text", false)).rejects.toThrow("auth");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on a Responses 401 auth error", async () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient as any,
    });

    await expect(summarizer("text", false)).rejects.toThrow("auth");
    expect(mockClient.responses.create).toHaveBeenCalledTimes(1);
  });

  it("retries Responses rate limits three times", async () => {
    const err = Object.assign(new Error("rate limit"), { status: 429 });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });

    await expect(summarizer("text", false)).rejects.toThrow("rate limit");
    expect(mockClient.responses.create).toHaveBeenCalledTimes(3);
  });

  it("uses 'local' as apiKey when none provided", async () => {
    const mockClient = makeClient();
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    const result = await summarizer("text", false);
    expect(result).toBe("Summary.");
  });

  it("falls back to truncated text if response is empty", async () => {
    const mockClient = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] }) } },
    };
    const longText = "x".repeat(600);
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    const result = await summarizer(longText, false);
    expect(result).toBe(longText.slice(0, 500));
  });

  it("falls back to truncated text if a Responses result is empty", async () => {
    const mockClient = {
      responses: { create: vi.fn().mockResolvedValue({ output_text: "" }) },
    };
    const longText = "x".repeat(600);
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient as any,
    });

    await expect(summarizer(longText, false)).resolves.toBe(longText.slice(0, 500));
  });
});
