import OpenAI from "openai";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_POLICY,
  type LlmApiMode,
  type LlmReasoningEffort,
  type LlmRetryPolicy,
} from "../daemon/config.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

type OpenAISummarizerOptions = {
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiMode?: LlmApiMode;
  reasoningEffort?: LlmReasoningEffort;
  requestTimeoutMs?: number;
  retry?: LlmRetryPolicy;
  _clientOverride?: any;
  _sleep?: (ms: number) => Promise<void>;
  _retryDelayMs?: number;
};

const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const RETRYABLE_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "LCM_INCOMPLETE_RESPONSE",
]);

type OpenAIErrorMetadata = {
  status?: unknown;
  code?: unknown;
};

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

function policyDescription(opts: OpenAISummarizerOptions, attempts: number): string {
  const retry = opts.retry ?? DEFAULT_LLM_RETRY_POLICY;
  const timeout = opts.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  return `attempts ${attempts}/${retry.maxAttempts}; timeout ${timeout}ms; retry policy ` +
    `initialDelayMs=${retry.initialDelayMs}, maxDelayMs=${retry.maxDelayMs}, multiplier=${retry.multiplier}`;
}

function terminalRequestError(
  err: unknown,
  opts: OpenAISummarizerOptions,
  attempts: number,
): Error {
  const apiMode = opts.apiMode === "responses" ? "responses" : "chat-completions";
  const metadata = safeMetadata(err);
  const policy = policyDescription(opts, attempts);

  if (apiMode === "chat-completions") {
    return new Error(
      `OpenAI Chat Completions request rejected (${metadata}; ${policy}): api mode chat-completions, ` +
        `model ${JSON.stringify(opts.model)}. Verify that the selected model supports the Chat Completions API ` +
        "and that the request configuration is valid.",
    );
  }

  const reasoningEffort = opts.reasoningEffort ?? "default/omitted";
  return new Error(
    `OpenAI Responses request rejected (${metadata}; ${policy}): api mode responses, model ${JSON.stringify(opts.model)}, ` +
      `reasoning effort ${JSON.stringify(reasoningEffort)}. Verify that the selected model supports the Responses API ` +
      "and requested reasoning configuration; choose a supported effort or omit reasoningEffort.",
  );
}

function requestFailureError(err: unknown, opts: OpenAISummarizerOptions, attempts: number): Error {
  const apiMode = opts.apiMode === "responses" ? "responses" : "chat-completions";
  const apiName = apiMode === "responses" ? "Responses" : "Chat Completions";
  return new Error(
    `OpenAI ${apiName} request failed after retries (${safeMetadata(err)}; ${policyDescription(opts, attempts)}): ` +
      `api mode ${apiMode}, model ${JSON.stringify(opts.model)}. ` +
      "Verify endpoint availability and the provider configuration.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createOpenAISummarizer(opts: OpenAISummarizerOptions): LcmSummarizeFn {
  const retry = opts._retryDelayMs === undefined
    ? opts.retry ?? { ...DEFAULT_LLM_RETRY_POLICY }
    : { ...(opts.retry ?? DEFAULT_LLM_RETRY_POLICY), initialDelayMs: opts._retryDelayMs, maxDelayMs: opts._retryDelayMs };
  const client =
    opts._clientOverride ??
    new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey || "local", // many local servers require a non-empty key
      timeout: opts.requestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
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
          const input = `${LCM_SUMMARIZER_SYSTEM_PROMPT}\n\n${prompt}`;
          const request: {
            model: string;
            max_output_tokens: number;
            input: string;
            reasoning?: { effort: NonNullable<OpenAISummarizerOptions["reasoningEffort"]> };
          } = {
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

        const response = await client.chat.completions.create({
          model: opts.model,
          max_tokens: 1024,
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
        if (!isRetryableError(err)) throw terminalRequestError(err, opts, attempts);
        if (attempts < retry.maxAttempts) {
          const delay = Math.min(retry.maxDelayMs, retry.initialDelayMs * Math.pow(retry.multiplier, attempt));
          await wait(delay);
        }
      }
    }
    throw requestFailureError(lastError, opts, retry.maxAttempts);
  };
}
