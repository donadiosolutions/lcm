import OpenAI from "openai";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_POLICY,
  type LlmApiMode,
  type LlmRetryPolicy,
  type OpenAIReasoningEffort,
} from "../daemon/config.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

type ChatCompletionRequest = Pick<
  OpenAI.ChatCompletionCreateParamsNonStreaming,
  "model" | "max_completion_tokens" | "max_tokens" | "messages"
>;

type ChatCompletionTokenLimit =
  | {
      max_completion_tokens: NonNullable<ChatCompletionRequest["max_completion_tokens"]>;
      max_tokens?: never;
    }
  | {
      max_completion_tokens?: never;
      max_tokens: NonNullable<ChatCompletionRequest["max_tokens"]>;
    };

type ChatCompletionChoice = OpenAI.ChatCompletion["choices"][number];
type ChatCompletionResult = {
  choices: Array<{
    message?: Partial<Pick<ChatCompletionChoice["message"], "content">>;
  }>;
};

type ResponsesRequest = Pick<
  OpenAI.Responses.ResponseCreateParamsNonStreaming,
  "model" | "max_output_tokens" | "input" | "reasoning"
>;

type ResponsesResult = Partial<Pick<OpenAI.Responses.Response, "status" | "output_text">>;

type OpenAISummarizerClient = {
  chat?: {
    completions: {
      create(request: ChatCompletionRequest): PromiseLike<ChatCompletionResult>;
    };
  };
  responses?: {
    create(request: ResponsesRequest): PromiseLike<ResponsesResult>;
  };
};

type OpenAISummarizerOptions = {
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiMode?: LlmApiMode;
  reasoningEffort?: OpenAIReasoningEffort;
  requestTimeoutMs?: number;
  retry?: LlmRetryPolicy;
  _clientOverride?: OpenAISummarizerClient;
  _sleep?: (ms: number) => Promise<void>;
  _retryDelayMs?: number;
};

const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const RETRYABLE_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "LCM_INCOMPLETE_RESPONSE",
]);
const MODERN_CHAT_COMPLETION_MODEL_PATTERN = /(?:^|[/:])(?:gpt-5(?:[.:-]|$)|o\d+(?:[.:-]|$))/i;

type OpenAIErrorMetadata = {
  status?: unknown;
  code?: unknown;
};

type EffectiveOpenAIRequestPolicy = {
  requestTimeoutMs: number;
  retry: LlmRetryPolicy;
};

/** Select the one token-limit field supported by the model's Chat Completions family. */
function selectChatCompletionTokenLimit(model: string, value: number): ChatCompletionTokenLimit {
  return MODERN_CHAT_COMPLETION_MODEL_PATTERN.test(model.trim())
    ? { max_completion_tokens: value }
    : { max_tokens: value };
}

function getErrorMetadata(err: unknown): OpenAIErrorMetadata {
  if (typeof err !== "object" || err === null) return {};
  const candidate = err as Record<string, unknown>;
  return { status: candidate.status, code: candidate.code };
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError) return true;
  const { status, code } = getErrorMetadata(err);
  if (typeof status === "number") return RETRYABLE_STATUSES.has(status) || status >= 500;
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as Record<string, unknown>;
  if (typeof candidate.name === "string" && RETRYABLE_ERROR_NAMES.has(candidate.name)) return true;
  return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code.toUpperCase());
}

function safeMetadata(err: unknown): string {
  const metadata = getErrorMetadata(err);
  const status = typeof metadata.status === "number" ? `status ${metadata.status}` : "status unavailable";
  const rawCode = typeof metadata.code === "string" || typeof metadata.code === "number" ? String(metadata.code) : "";
  const safeCode = rawCode.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return safeCode ? `${status}, code ${safeCode}` : status;
}

function policyDescription(policy: EffectiveOpenAIRequestPolicy, attempts: number): string {
  const { retry, requestTimeoutMs } = policy;
  return `attempts ${attempts}/${retry.maxAttempts}; timeout ${requestTimeoutMs}ms; retry policy ` +
    `initialDelayMs=${retry.initialDelayMs}, maxDelayMs=${retry.maxDelayMs}, multiplier=${retry.multiplier}`;
}

function terminalRequestError(
  err: unknown,
  opts: OpenAISummarizerOptions,
  attempts: number,
  policy: EffectiveOpenAIRequestPolicy,
): Error {
  const apiMode = opts.apiMode === "responses" ? "responses" : "chat-completions";
  const metadata = safeMetadata(err);
  const policyDetails = policyDescription(policy, attempts);

  if (apiMode === "chat-completions") {
    return new Error(
      `OpenAI Chat Completions request rejected (${metadata}; ${policyDetails}): api mode chat-completions, ` +
        `model ${JSON.stringify(opts.model)}. Verify that the selected model supports the Chat Completions API ` +
        "and that the request configuration is valid.",
    );
  }

  const reasoningEffort = opts.reasoningEffort ?? "default/omitted";
  return new Error(
    `OpenAI Responses request rejected (${metadata}; ${policyDetails}): api mode responses, model ${JSON.stringify(opts.model)}, ` +
      `reasoning effort ${JSON.stringify(reasoningEffort)}. Verify that the selected model supports the Responses API ` +
      "and requested reasoning configuration; choose a supported effort or omit reasoningEffort.",
  );
}

function requestFailureError(
  err: unknown,
  opts: OpenAISummarizerOptions,
  attempts: number,
  policy: EffectiveOpenAIRequestPolicy,
): Error {
  const apiMode = opts.apiMode === "responses" ? "responses" : "chat-completions";
  const apiName = apiMode === "responses" ? "Responses" : "Chat Completions";
  return new Error(
    `OpenAI ${apiName} request failed after retries (${safeMetadata(err)}; ${policyDescription(policy, attempts)}): ` +
      `api mode ${apiMode}, model ${JSON.stringify(opts.model)}. ` +
      "Verify endpoint availability and the provider configuration.",
  );
}

const MAX_SLEEP_MS = 600_000; // matches the upper bound enforced by validateBoundedInteger for maxDelayMs

/** Schedule one retry-delay slice using a fixed literal timer duration, not one derived from user input. */
function scheduleRetrySleepSlice(callback: () => void, remainingMs: number): void {
  if (remainingMs >= 60_000) {
    setTimeout(callback, 60_000);
  } else if (remainingMs >= 10_000) {
    setTimeout(callback, 10_000);
  } else if (remainingMs >= 1_000) {
    setTimeout(callback, 1_000);
  } else if (remainingMs >= 100) {
    setTimeout(callback, 100);
  } else if (remainingMs >= 10) {
    setTimeout(callback, 10);
  } else {
    setTimeout(callback, 1);
  }
}

function sleep(ms: number): Promise<void> {
  const boundedMs = Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_SLEEP_MS)) : 0;
  if (boundedMs === 0) return new Promise((resolve) => setTimeout(resolve, 0));

  const deadline = performance.now() + boundedMs;
  return new Promise((resolve) => {
    const waitForDeadline = (): void => {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        resolve();
        return;
      }
      scheduleRetrySleepSlice(waitForDeadline, remainingMs);
    };
    waitForDeadline();
  });
}

export function createOpenAISummarizer(opts: OpenAISummarizerOptions): LcmSummarizeFn {
  const retry = opts._retryDelayMs === undefined
    ? opts.retry ?? { ...DEFAULT_LLM_RETRY_POLICY }
    : { ...(opts.retry ?? DEFAULT_LLM_RETRY_POLICY), initialDelayMs: opts._retryDelayMs, maxDelayMs: opts._retryDelayMs };
  const effectiveRequestPolicy: EffectiveOpenAIRequestPolicy = {
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    retry,
  };
  const client: OpenAISummarizerClient =
    opts._clientOverride ??
    new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey || "local", // many local servers require a non-empty key
      timeout: effectiveRequestPolicy.requestTimeoutMs,
      maxRetries: 0,
    });
  const wait = opts._sleep ?? sleep;

  return async function summarize(text, aggressive, ctx: SummarizeContext = {}): Promise<string> {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens =
      ctx.targetTokens ??
      resolveTargetTokens({
        inputTokens: estimatedInputTokens,
        mode: aggressive ? "aggressive" : "normal",
        isCondensed: ctx.isCondensed ?? false,
        condensedTargetTokens: 2000,
      });

    const prompt = ctx.isCondensed
      ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
      : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

    let lastError: unknown;
    for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
      try {
        if (opts.apiMode === "responses") {
          if (!client.responses) {
            throw new Error("OpenAI client does not provide the Responses API");
          }
          const input = `${LCM_SUMMARIZER_SYSTEM_PROMPT}\n\n${prompt}`;
          const request: ResponsesRequest = {
            model: opts.model,
            max_output_tokens: 1024,
            input,
          };
          if (opts.reasoningEffort !== undefined) {
            request.reasoning = { effort: opts.reasoningEffort };
          }

          const response = await client.responses.create(request);
          if (response.status !== "completed") {
            throw Object.assign(new Error("OpenAI Responses request did not complete"), {
              code: "LCM_INCOMPLETE_RESPONSE",
            });
          }
          return response.output_text || text.slice(0, 500);
        }

        if (!client.chat) {
          throw new Error("OpenAI client does not provide the Chat Completions API");
        }
        const response = await client.chat.completions.create({
          model: opts.model,
          ...selectChatCompletionTokenLimit(opts.model, 1024),
          // Merge system content into user message for compatibility with local
          // servers (e.g. MLX/llama.cpp) that don't support role:"system".
          messages: [
            { role: "user", content: `${LCM_SUMMARIZER_SYSTEM_PROMPT}\n\n${prompt}` },
          ],
        });

        const textContent = response.choices[0]?.message?.content ?? "";
        return textContent || text.slice(0, 500);
      } catch (err: unknown) {
        lastError = err;
        const attempts = attempt + 1;
        if (!isRetryableError(err)) throw terminalRequestError(err, opts, attempts, effectiveRequestPolicy);
        if (attempts < retry.maxAttempts) {
          const delay = Math.min(retry.maxDelayMs, retry.initialDelayMs * Math.pow(retry.multiplier, attempt));
          await wait(delay);
        }
      }
    }
    throw requestFailureError(lastError, opts, retry.maxAttempts, effectiveRequestPolicy);
  };
}
