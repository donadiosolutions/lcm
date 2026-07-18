import { describe, expect, it, vi } from "vitest";
import {
  __configTestUtils,
  daemonConfigForPersistence,
  deepMerge,
  loadDaemonConfig,
  parseDaemonConfig,
  parseStoredConfig,
  resolveLlmRequestPolicy,
} from "../../src/daemon/config.js";

describe("daemon configuration uncovered boundaries", () => {
  it("covers deep merge scalar, array, undefined, denied, and invalid source branches", () => {
    const source = JSON.parse('{"nested":{"replace":[2]},"scalar":2,"skip":null,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    source.undefined = undefined;
    expect(deepMerge({ nested: { keep: true, replace: [1] }, scalar: { old: true } }, source)).toEqual({
      nested: { keep: true, replace: [2] }, scalar: 2, skip: null,
    });
    expect(deepMerge({ keep: true }, null as unknown as Record<string, unknown>)).toEqual({ keep: true });
  });

  it.each([
    [{ compaction: { promotionThresholds: { eventConfidence: { decision: "bad" } } } }, "eventConfidence.decision"],
    [{ restoration: { recencyHalfLifeHours: "bad" } }, "recencyHalfLifeHours"],
    [{ security: { sensitivePatterns: "bad" } }, "sensitivePatterns"],
    [{ daemon: { socketPath: 3 } }, "socketPath"],
    [{ overrides: true }, "overrides"],
  ] as const)("covers validation failure %#", (input, path) => {
    if ("overrides" in input) expect(() => parseDaemonConfig("{}", null)).toThrow(path);
    else expect(() => parseStoredConfig(JSON.stringify(input))).toThrow(path);
  });

  it("redacts nested credentials and sanitizes nested URLs in validation output", () => {
    expect(() => parseStoredConfig(JSON.stringify({ daemon: { port: { apiKey: "secret", endpoint: "https://user:pass@example.com/x" } } }))).toThrow("[REDACTED]");
    expect(() => parseStoredConfig(JSON.stringify({ llm: { provider: "bad", apiKey: "secret" } }))).toThrow("valid choices");
    expect(() => parseStoredConfig(JSON.stringify({ llm: { provider: "https://user:pass@example.com/path" } }))).toThrow("https://example.com/path");
  });

  it("handles unusual validation display and parser failures", () => {
    expect(() => parseDaemonConfig("{}", Symbol("override"))).toThrow("overrides");
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "parser failed"; });
    expect(() => parseStoredConfig("{}")).toThrow("parser failed");
    parse.mockRestore();
    expect(() => parseStoredConfig(JSON.stringify({ restoration: { recencyHalfLifeHours: 1 } }))).not.toThrow();
  });

  it("validates malformed and unknown request-policy shapes", () => {
    const base = { requestTimeoutMs: 100, retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2 } };
    expect(() => resolveLlmRequestPolicy(base, null as never, "policy")).toThrow("policy");
    expect(() => resolveLlmRequestPolicy(base, { unknown: true } as never, "policy")).toThrow("policy.unknown");
    expect(() => resolveLlmRequestPolicy(base, { retry: [] } as never, "policy")).toThrow("policy.retry");
    expect(() => resolveLlmRequestPolicy(base, { retry: { unknown: 1 } } as never, "policy")).toThrow("policy.retry.unknown");
    expect(resolveLlmRequestPolicy(base, {})).toEqual(base);
  });

  it("normalizes persistence fields by provider capabilities", () => {
    const disabled = loadDaemonConfig("/missing", { llm: { provider: "disabled" } });
    disabled.llm.reasoningEffort = "high";
    const storedDisabled = daemonConfigForPersistence(disabled) as { llm: Record<string, unknown> };
    expect(storedDisabled.llm).not.toHaveProperty("requestTimeoutMs");
    expect(storedDisabled.llm).not.toHaveProperty("retry");
    expect(storedDisabled.llm).not.toHaveProperty("fastMode");
    expect(storedDisabled.llm).not.toHaveProperty("reasoningEffort");

    const openai = loadDaemonConfig("/missing");
    Object.assign(openai.llm, { provider: "openai", apiMode: "responses", reasoningEffort: "medium", fastMode: true });
    const storedOpenai = daemonConfigForPersistence(openai) as { llm: Record<string, unknown> };
    expect(storedOpenai.llm).toHaveProperty("requestTimeoutMs");
    expect(storedOpenai.llm).toHaveProperty("retry");
    expect(storedOpenai.llm).not.toHaveProperty("fastMode");
    expect(storedOpenai.llm.reasoningEffort).toBe("medium");

    const claude = loadDaemonConfig("/missing", { llm: { provider: "claude-process", fastMode: true } });
    expect((daemonConfigForPersistence(claude) as { llm: Record<string, unknown> }).llm.fastMode).toBe(true);
  });

  it("accepts non-empty required public provider credentials", () => {
    expect(() => parseDaemonConfig("{}", { llm: { provider: "anthropic", model: "m", apiKey: "key" } })).not.toThrow();
    expect(() => parseDaemonConfig("{}", { llm: { provider: "openai", model: "m", baseUrl: "https://api.openai.com/v1", apiKey: "key" } })).not.toThrow();
  });

  it("covers malformed JSON, bad roots, non-HTTP endpoints, migration, and read failures", () => {
    expect(() => parseStoredConfig("{")) .toThrow("malformed JSON");
    expect(() => parseStoredConfig("null")).toThrow("JSON object");
    expect(() => parseStoredConfig("[]")).toThrow("JSON object");
    expect(() => parseDaemonConfig("{}", { llm: { provider: "openai", model: "m", baseUrl: "ftp://example.com" } })).toThrow("HTTP(S)");
    const migrated = parseDaemonConfig("{}", { compaction: { promotionThresholds: { mergeMaxEntries: 17 } } });
    // Issue #132 tracks that this legacy value is accepted but currently cannot override the default.
    expect(migrated.compaction.promotionThresholds.dedupCandidateLimit).toBe(100);
    expect(() => loadDaemonConfig("/tmp", {})).toThrow();
  });

  it("executes the legacy migration arm through its pure internal seam", () => {
    const input = { mergeMaxEntries: 17, confidenceDecayRate: 0.5 };
    expect(__configTestUtils.migrateLegacyPromotionThresholds(input)).toEqual({ dedupCandidateLimit: 17 });
    expect(input).toEqual({ mergeMaxEntries: 17, confidenceDecayRate: 0.5 });
  });
});
