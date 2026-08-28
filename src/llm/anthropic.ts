import Anthropic from "@anthropic-ai/sdk";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import {
  abortableDelay,
  createAbortError,
  isAbortError,
  throwIfAborted,
  waitForAbortable,
} from "../daemon/cancellation.js";

export type { LcmSummarizeFn } from "./types.js";

type SummarizerOptions = {
  model: string;
  apiKey: string;
  _clientOverride?: any;
  _retryDelayMs?: number;
  _sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function createAnthropicSummarizer(opts: SummarizerOptions): LcmSummarizeFn {
  const client = opts._clientOverride ?? new Anthropic({ apiKey: opts.apiKey });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;
  const wait = opts._sleep ?? ((ms: number, signal?: AbortSignal) => abortableDelay(ms, signal));

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    const signal = ctx.signal;
    throwIfAborted(signal);
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
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
        throwIfAborted(signal);
        const requestOptions = signal === undefined ? undefined : { signal };
        const response = await waitForAbortable(
          Promise.resolve(client.messages.create({
            model: opts.model,
            max_tokens: 1024,
            system: LCM_SUMMARIZER_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          }, requestOptions)),
          signal,
        );
        throwIfAborted(signal);

        const textContent = response.content.find((c: any) => c.type === "text")?.text ?? "";

        if (!textContent && attempt === 0) {
          // Single retry on empty response
          throwIfAborted(signal);
          const retry = await waitForAbortable(
            Promise.resolve(client.messages.create({
              model: opts.model,
              max_tokens: 1024,
              system: LCM_SUMMARIZER_SYSTEM_PROMPT,
              messages: [{ role: "user", content: prompt }],
            }, requestOptions)),
            signal,
          );
          throwIfAborted(signal);
          return retry.content.find((c: any) => c.type === "text")?.text ?? text.slice(0, 500);
        }

        return textContent || text.slice(0, 500);
      } catch (err: any) {
        if (signal?.aborted) throw createAbortError(signal.reason);
        if (isAbortError(err)) throw err;
        if (err?.status === 401) throw err; // auth error: no retry
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          throwIfAborted(signal);
          await waitForAbortable(wait(retryDelayMs * Math.pow(2, attempt), signal), signal);
          throwIfAborted(signal);
        }
      }
    }
    throw lastError;
  };
}
