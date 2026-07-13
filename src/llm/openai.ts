import OpenAI from "openai";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import type { LlmApiMode, LlmReasoningEffort } from "../daemon/config.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

type OpenAISummarizerOptions = {
  model: string;
  baseURL: string;
  apiKey?: string;
  apiMode?: LlmApiMode;
  reasoningEffort?: LlmReasoningEffort;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

const CONFIGURATION_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

type OpenAIErrorMetadata = {
  status?: unknown;
  code?: unknown;
};

function getErrorMetadata(err: unknown): OpenAIErrorMetadata {
  if (typeof err !== "object" || err === null) return {};
  const candidate = err as Record<string, unknown>;
  return { status: candidate.status, code: candidate.code };
}

function isConfigurationError(err: unknown): boolean {
  const { status } = getErrorMetadata(err);
  return typeof status === "number" && CONFIGURATION_ERROR_STATUSES.has(status);
}

function configurationError(
  err: unknown,
  opts: OpenAISummarizerOptions,
): Error {
  const metadata = getErrorMetadata(err);
  const status = typeof metadata.status === "number" ? `status ${metadata.status}` : "unknown status";
  const rawCode =
    typeof metadata.code === "string" || typeof metadata.code === "number" ? String(metadata.code) : "";
  const safeCode = rawCode.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  const code = safeCode ? `, code ${safeCode}` : "";
  const apiMode = opts.apiMode === "responses" ? "responses" : "chat-completions";

  if (apiMode === "chat-completions") {
    return new Error(
      `OpenAI Chat Completions request rejected (${status}${code}): api mode chat-completions, ` +
        `model ${JSON.stringify(opts.model)}. Verify that the selected model supports the Chat Completions API ` +
        "and that the request configuration is valid.",
    );
  }

  const reasoningEffort = opts.reasoningEffort ?? "default/omitted";
  return new Error(
    `OpenAI Responses request rejected (${status}${code}): api mode responses, model ${JSON.stringify(opts.model)}, ` +
      `reasoning effort ${JSON.stringify(reasoningEffort)}. Verify that the selected model supports the Responses API ` +
      "and requested reasoning configuration; choose a supported effort or omit reasoningEffort.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createOpenAISummarizer(opts: OpenAISummarizerOptions): LcmSummarizeFn {
  const client =
    opts._clientOverride ??
    new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey || "local", // many local servers require a non-empty key
    });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;

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

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
        if (isConfigurationError(err)) {
          throw configurationError(err, opts);
        }
        lastError = err;
        if (attempt < MAX_RETRIES - 1) await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  };
}
