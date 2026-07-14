import { createServer } from "node:http";
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
        create: vi.fn().mockResolvedValue({ status: "completed", output_text: text }),
      },
    };
  }

  it("calls OpenAI-compatible endpoint and returns text", async () => {
    const mockClient = makeClient("Summary.");
    const summarizer = createOpenAISummarizer({
      model: "qwen2.5:14b",
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
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
      baseUrl: "https://api.openai.com/v1",
      apiMode: "chat-completions",
      _clientOverride: mockClient,
    });

    await summarizer("text", false);

    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
    expect(mockClient.responses.create).not.toHaveBeenCalled();
  });

  it("calls the Responses API with the combined prompt", async () => {
    const mockClient = makeClient("Responses summary.");
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      reasoningEffort: "high",
      _clientOverride: mockClient,
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
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient,
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
        baseUrl: "https://api.openai.com/v1",
        apiMode: "responses",
        reasoningEffort,
        _clientOverride: mockClient,
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
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      reasoningEffort: "xhigh",
      _clientOverride: mockClient,
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
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient,
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

  it("retries 3 times on 5xx error then throws a safe contextual error", async () => {
    const secretProviderMessage = "server error containing PRIVATE PROMPT and sk-secret";
    const err = Object.assign(new Error(secretProviderMessage), { status: 500 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
      _retryDelayMs: 0,
    });
    let thrown: Error | undefined;
    try {
      await summarizer("PRIVATE PROMPT", false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("OpenAI Chat Completions request failed after retries");
    expect(thrown?.message).toContain('model "test-model"');
    expect(thrown?.message).toContain("initialDelayMs=0, maxDelayMs=0, multiplier=2");
    expect(thrown?.message).not.toContain(secretProviderMessage);
    expect(thrown?.message).not.toContain("PRIVATE PROMPT");
    expect(thrown?.message).not.toContain("sk-secret");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("safely wraps an unclassified rejection without retrying", async () => {
    const secretRejection = "provider rejected PRIVATE PROMPT with sk-secret";
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(secretRejection) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model\nFORGED LOG LINE",
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
      _retryDelayMs: 0,
    });

    let thrown: unknown;
    try {
      await summarizer("PRIVATE PROMPT", false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("OpenAI Chat Completions request rejected");
    expect((thrown as Error).message).toContain("api mode chat-completions");
    expect((thrown as Error).message).toContain('model "test-model\\nFORGED LOG LINE"');
    expect((thrown as Error).message).not.toContain(secretRejection);
    expect((thrown as Error).message).not.toContain("PRIVATE PROMPT");
    expect((thrown as Error).message).not.toContain("sk-secret");
    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
  });

  it.each([400, 403, 404, 422])(
    "safely wraps a Chat Completions %s configuration error without retrying",
    async (status) => {
      const secretPrompt = "PRIVATE CHAT PROMPT";
      const secretProviderMessage = `bad request containing ${secretPrompt} and sk-secret`;
      const model = "test-model\nFORGED LOG LINE";
      const err = Object.assign(new Error(secretProviderMessage), {
        status,
        code: "invalid/request\n",
        request: { apiKey: "sk-secret", messages: [{ content: secretPrompt }] },
      });
      const mockClient = {
        chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
      };
      const summarizer = createOpenAISummarizer({
        model,
        baseUrl: "http://localhost:11435/v1",
        _clientOverride: mockClient,
        _retryDelayMs: 0,
      });

      let thrown: Error | undefined;
      try {
        await summarizer(secretPrompt, false);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).toContain("OpenAI Chat Completions request rejected");
      expect(thrown?.message).toContain(`status ${status}`);
      expect(thrown?.message).toContain("code invalidrequest");
      expect(thrown?.message).toContain("api mode chat-completions");
      expect(thrown?.message).toContain('model "test-model\\nFORGED LOG LINE"');
      expect(thrown?.message).not.toContain(model);
      expect(thrown?.message).not.toContain(secretPrompt);
      expect(thrown?.message).not.toContain(secretProviderMessage);
      expect(thrown?.message).not.toContain("sk-secret");
      expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
    },
  );

  it("safely wraps a Chat Completions 401 auth error without retrying", async () => {
    const secretPrompt = "PRIVATE CHAT PROMPT";
    const secretProviderMessage = `invalid key sk-secret for ${secretPrompt}`;
    const model = "test-model\nFORGED LOG LINE";
    const err = Object.assign(new Error(secretProviderMessage), {
      status: 401,
      code: "invalid/api-key\n",
      request: { apiKey: "sk-secret", messages: [{ content: secretPrompt }] },
    });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model,
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
      _retryDelayMs: 0,
    });

    let thrown: Error | undefined;
    try {
      await summarizer(secretPrompt, false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("OpenAI Chat Completions request rejected");
    expect(thrown?.message).toContain("status 401");
    expect(thrown?.message).toContain("code invalidapi-key");
    expect(thrown?.message).toContain("api mode chat-completions");
    expect(thrown?.message).toContain('model "test-model\\nFORGED LOG LINE"');
    expect(thrown?.message).not.toContain(model);
    expect(thrown?.message).not.toContain(secretPrompt);
    expect(thrown?.message).not.toContain(secretProviderMessage);
    expect(thrown?.message).not.toContain("sk-secret");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("safely wraps a Responses 401 auth error without retrying", async () => {
    const secretPrompt = "PRIVATE RESPONSES PROMPT";
    const secretProviderMessage = `invalid key sk-secret for ${secretPrompt}`;
    const model = "gpt-5\nFORGED LOG LINE";
    const err = Object.assign(new Error(secretProviderMessage), {
      status: 401,
      code: "invalid/api-key\n",
      request: { apiKey: "sk-secret", input: secretPrompt },
    });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model,
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      reasoningEffort: "high",
      _clientOverride: mockClient,
      _retryDelayMs: 0,
    });

    let thrown: Error | undefined;
    try {
      await summarizer(secretPrompt, false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("OpenAI Responses request rejected");
    expect(thrown?.message).toContain("status 401");
    expect(thrown?.message).toContain("code invalidapi-key");
    expect(thrown?.message).toContain("api mode responses");
    expect(thrown?.message).toContain('model "gpt-5\\nFORGED LOG LINE"');
    expect(thrown?.message).toContain('reasoning effort "high"');
    expect(thrown?.message).not.toContain(model);
    expect(thrown?.message).not.toContain(secretPrompt);
    expect(thrown?.message).not.toContain(secretProviderMessage);
    expect(thrown?.message).not.toContain("sk-secret");
    expect(mockClient.responses.create).toHaveBeenCalledTimes(1);
  });

  it("retries Responses rate limits three times", async () => {
    const err = Object.assign(new Error("rate limit"), { status: 429 });
    const mockClient = {
      responses: { create: vi.fn().mockRejectedValue(err) },
    };
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient,
      _retryDelayMs: 0,
    });

    await expect(summarizer("text", false)).rejects.toThrow(
      "OpenAI Responses request failed after retries",
    );
    expect(mockClient.responses.create).toHaveBeenCalledTimes(3);
  });

  it("retries an incomplete Responses result instead of accepting partial output", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ status: "incomplete", output_text: "Partial summary." })
      .mockResolvedValueOnce({ status: "completed", output_text: "Complete summary." });
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: { responses: { create } },
      _retryDelayMs: 0,
    });

    await expect(summarizer("text", false)).resolves.toBe("Complete summary.");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails safely when Responses remain incomplete after retries", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "incomplete",
      output_text: "Partial summary containing PRIVATE PROMPT and sk-secret",
    });
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: { responses: { create } },
      _retryDelayMs: 0,
    });

    let thrown: Error | undefined;
    try {
      await summarizer("PRIVATE PROMPT", false);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("OpenAI Responses request failed after retries");
    expect(thrown?.message).toContain('model "gpt-5"');
    expect(thrown?.message).not.toContain("Partial summary");
    expect(thrown?.message).not.toContain("PRIVATE PROMPT");
    expect(thrown?.message).not.toContain("sk-secret");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("uses 'local' as apiKey when none provided", async () => {
    const mockClient = makeClient();
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
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
      baseUrl: "http://localhost:11435/v1",
      _clientOverride: mockClient,
    });
    const result = await summarizer(longText, false);
    expect(result).toBe(longText.slice(0, 500));
  });

  it("falls back to truncated text if a Responses result is empty", async () => {
    const mockClient = {
      responses: { create: vi.fn().mockResolvedValue({ status: "completed", output_text: "" }) },
    };
    const longText = "x".repeat(600);
    const summarizer = createOpenAISummarizer({
      model: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      _clientOverride: mockClient,
    });

    await expect(summarizer(longText, false)).resolves.toBe(longText.slice(0, 500));
  });

  it("uses exact bounded backoff and succeeds within the configured attempt count", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 409, code: "conflict" }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 429 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: "Recovered." } }] });
    const delays: number[] = [];
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseUrl: "http://localhost/v1",
      retry: { maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 25, multiplier: 2 },
      _clientOverride: { chat: { completions: { create } } },
      _sleep: async (ms) => { delays.push(ms); },
    });

    await expect(summarizer("text", false)).resolves.toBe("Recovered.");
    expect(create).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([10, 20, 25]);
  });

  it.each([408, 409, 429, 500, 503])("retries HTTP %s", async (status) => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("provider body secret"), { status }));
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseUrl: "http://localhost/v1",
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2 },
      _clientOverride: { chat: { completions: { create } } },
    });
    await expect(summarizer("private prompt", false)).rejects.toThrow("attempts 2/2");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each(["APIConnectionError", "APIConnectionTimeoutError"])("retries %s failures", async (name) => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("connection secret"), { name }));
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseUrl: "http://localhost/v1",
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2 },
      _clientOverride: { chat: { completions: { create } } },
    });
    await expect(summarizer("private prompt", false)).rejects.toThrow("attempts 2/2");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("talks to an actual loopback OpenAI-v1 Chat Completions server", async () => {
    const requests: string[] = [];
    const authorizationHeaders: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(body);
        authorizationHeaders.push(req.headers.authorization);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "loopback-model",
          choices: [{ index: 0, message: { role: "assistant", content: "Loopback summary." }, finish_reason: "stop" }],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("loopback server did not bind");
      const summarizer = createOpenAISummarizer({
        model: "loopback-model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "sk-loopback-test",
        requestTimeoutMs: 5_000,
        retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      });
      await expect(summarizer("Loopback conversation", false)).resolves.toBe("Loopback summary.");
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0])).toMatchObject({ model: "loopback-model" });
      expect(authorizationHeaders).toEqual(["Bearer sk-loopback-test"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
