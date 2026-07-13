import type { DaemonConfig, LlmReasoningEffort } from "./config.js";
import { createClaudeProcessSummarizer } from "../llm/claude-process.js";
import { createCodexProcessSummarizer } from "../llm/codex-process.js";
import { createMockSummarizer } from "../llm/mock-summarizer.js";
import type { LcmSummarizeFn } from "../llm/types.js";

export type CompactClient = "claude" | "codex";
export type EffectiveProvider = Exclude<DaemonConfig["llm"]["provider"], "auto">;

export function resolveEffectiveProvider(config: DaemonConfig, client?: CompactClient): EffectiveProvider {
  if (config.llm.provider === "auto") {
    return client === "codex" ? "codex-process" : "claude-process";
  }
  return config.llm.provider;
}

export async function createSummarizer(
  provider: EffectiveProvider,
  config: DaemonConfig,
  overrides: { reasoningEffort?: LlmReasoningEffort } = {},
): Promise<LcmSummarizeFn | null> {
  // Mock summarizer for E2E testing — deterministic, no LLM calls
  if (config.summarizer?.mock) return createMockSummarizer();
  if (provider === "disabled") return null;
  if (provider === "claude-process") return createClaudeProcessSummarizer();
  if (provider === "codex-process") {
    return createCodexProcessSummarizer({ model: config.llm.model });
  }
  if (provider === "openai") {
    const { createOpenAISummarizer } = await import("../llm/openai.js");
    return createOpenAISummarizer({
      model: config.llm.model,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      apiMode: config.llm.apiMode ?? "chat-completions",
      reasoningEffort: overrides.reasoningEffort ?? config.llm.reasoningEffort,
    });
  }
  // anthropic
  const { createAnthropicSummarizer } = await import("../llm/anthropic.js");
  return createAnthropicSummarizer({
    model: config.llm.model,
    apiKey: config.llm.apiKey!,
  });
}

/**
 * Creates a cached summarizer factory for a given DaemonConfig.
 * The returned function lazily creates summarizers per provider and memoizes them.
 */
export function makeSummarizerCache(config: DaemonConfig) {
  const cache = new Map<string, Promise<LcmSummarizeFn | null>>();
  return (provider: EffectiveProvider, reasoningEffort?: LlmReasoningEffort): Promise<LcmSummarizeFn | null> => {
    const cacheKey = `${provider}:${config.llm.apiMode ?? ""}:${reasoningEffort ?? config.llm.reasoningEffort ?? ""}`;
    let cached = cache.get(cacheKey);
    if (!cached) {
      cached = createSummarizer(provider, config, { reasoningEffort });
      cache.set(cacheKey, cached);
    }
    return cached;
  };
}
