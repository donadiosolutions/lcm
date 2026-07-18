import { describe, expect, it } from "vitest";
import {
  __summarizeTestUtils as utils,
  buildCondensedSummaryPrompt,
  buildLeafSummaryPrompt,
  resolveTargetTokens,
} from "../src/summarize.js";

describe("summarization prompt boundaries", () => {
  it.each([
    [{ inputTokens: 1, mode: "aggressive", isCondensed: false, condensedTargetTokens: 1 }, 96],
    [{ inputTokens: 10_000, mode: "aggressive", isCondensed: false, condensedTargetTokens: 1 }, 640],
    [{ inputTokens: 1, mode: "normal", isCondensed: false, condensedTargetTokens: 1 }, 192],
    [{ inputTokens: 10_000, mode: "normal", isCondensed: false, condensedTargetTokens: 1 }, 1200],
    [{ inputTokens: 1, mode: "normal", isCondensed: true, condensedTargetTokens: 1 }, 512],
    [{ inputTokens: 1, mode: "normal", isCondensed: true, condensedTargetTokens: 900 }, 900],
  ] as const)("resolves target %#", (input, expected) => {
    expect(resolveTargetTokens(input)).toBe(expected);
  });

  it("builds leaf prompts with and without optional context", () => {
    expect(buildLeafSummaryPrompt({ text: "text", mode: "normal", targetTokens: 200 })).toContain("Operator instructions: (none)");
    expect(buildLeafSummaryPrompt({
      text: "text", mode: "aggressive", targetTokens: 100, previousSummary: " prior ", customInstructions: " custom ",
    })).toContain("Operator instructions:\ncustom");
  });

  it.each([1, 2, 3])("builds the depth-%s condensed prompt", (depth) => {
    const prompt = buildCondensedSummaryPrompt({
      text: "text", targetTokens: 500, depth,
      previousSummary: depth === 1 ? " prior " : undefined,
      customInstructions: depth === 2 ? " custom " : undefined,
    });
    expect(prompt).toContain("text");
    if (depth === 1) expect(prompt).toContain("<previous_context>");
    if (depth === 2) expect(prompt).toContain("Operator instructions:\ncustom");
    if (depth === 3) expect(prompt).toContain("Operator instructions: (none)");
  });

  it("builds a depth-one prompt without prior context or custom instructions", () => {
    const prompt = buildCondensedSummaryPrompt({ text: "text", targetTokens: 500, depth: 0 });
    expect(prompt).toContain("Focus on what matters for continuation");
  });

  it.each([1, 3])("includes custom instructions at condensed depth %s", (depth) => {
    expect(buildCondensedSummaryPrompt({
      text: "text", targetTokens: 500, depth, customInstructions: " custom ",
    })).toContain("Operator instructions:\ncustom");
  });
});

describe("completion normalization boundaries", () => {
  it("collects nested string wrappers while dropping blanks and duplicates", () => {
    const normalized = utils.normalizeCompletionSummary([
      null,
      "primitive",
      {
        type: " outer ",
        text: [" alpha ", { value: "beta" }, { text: "alpha" }, 1],
        output_text: { text: "gamma" },
        thinking: { value: "delta" },
        content: [{ type: "inner", text: " " }],
        response: { message: { summary: { output: { text: "epsilon" } } } },
      },
    ]);
    expect(normalized.summary).toBe("alpha\nbeta\ngamma\ndelta\nepsilon");
    expect(normalized.blockTypes).toEqual(["inner", "outer"]);
  });
});

describe("legacy provider API resolution", () => {
  it("returns undefined for missing or malformed configuration", () => {
    expect(utils.resolveProviderApiFromLegacyConfig(undefined, "openai")).toBeUndefined();
    expect(utils.resolveProviderApiFromLegacyConfig({}, "openai")).toBeUndefined();
    expect(utils.resolveProviderApiFromLegacyConfig({ models: { providers: "bad" } }, "openai")).toBeUndefined();
  });

  it("uses an exact provider entry with a non-empty API", () => {
    expect(utils.resolveProviderApiFromLegacyConfig({
      models: { providers: { openai: { api: " responses " } } },
    }, "openai")).toBe("responses");
  });

  it("finds case-insensitive entries while ignoring invalid candidates", () => {
    const config = {
      models: { providers: {
        wrong: { api: "wrong" },
        OPENAI: null,
        OpenAi: { api: " " },
        oPeNaI: { api: " codex-responses " },
      } },
    };
    expect(utils.resolveProviderApiFromLegacyConfig(config, " openAI ")).toBe("codex-responses");
    expect(utils.resolveProviderApiFromLegacyConfig({ models: { providers: { openai: 1 } } }, "openai")).toBeUndefined();
    expect(utils.resolveProviderApiFromLegacyConfig({ models: { providers: { openai: { api: 1 } } } }, "openai")).toBeUndefined();
  });
});

describe("diagnostic sanitization boundaries", () => {
  it("sanitizes every primitive, collection, depth, secret, and truncation path", () => {
    const manyKeys = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`key${i}`, i]));
    const value = {
      secretKey: "secret",
      undefinedValue: undefined,
      functionValue: () => undefined,
      symbolValue: Symbol("value"),
      scalarValues: [null, true, 1, ...Array.from({ length: 7 }, (_, i) => i)],
      nested: { a: { b: { c: { d: "too deep" } } } },
      manyKeys,
    };
    const sanitized = utils.sanitizeForDiagnostics(value) as Record<string, unknown>;
    expect(sanitized.secretKey).toBe("[REDACTED]");
    expect(sanitized.undefinedValue).toBe("[undefined]");
    expect(sanitized.functionValue).toBe("[function]");
    expect(sanitized.symbolValue).toBe("[symbol]");
    expect(sanitized.scalarValues).toContain("[+2 more items]");
    expect(JSON.stringify(sanitized)).toContain("[max-depth]");
    expect(JSON.stringify(sanitized)).toContain("__truncated_keys__");
  });

  it("handles JSON values, oversized output, and unserializable bigint payloads", () => {
    expect(utils.formatDiagnosticPayload(undefined)).toBe('"[undefined]"');
    expect(utils.formatDiagnosticPayload({ value: "x".repeat(1500) })).toContain("[truncated:");
    expect(utils.formatDiagnosticPayload(1n)).toBe('"[unserializable]"');
  });

  it("preserves and redacts non-plain Error diagnostics", () => {
    const error = new Error("provider rejected https://user:secret@example.com/v1?token=hidden");
    const diagnostic = utils.formatDiagnosticPayload(error);
    expect(diagnostic).toContain("Error: provider rejected https://example.com/v1?[REDACTED]");
    expect(diagnostic).not.toContain("user:secret");
    expect(diagnostic).not.toContain("token=hidden");

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: "kept" });
    expect(utils.formatDiagnosticPayload(nullPrototype)).toBe('{"value":"kept"}');
  });

  it("appends only non-empty response diagnostics", () => {
    const empty: string[] = ["base"];
    utils.appendResponseDiagnostics(empty, null);
    expect(empty).toEqual(["base"]);

    const populated: string[] = ["base"];
    utils.appendResponseDiagnostics(populated, { content: [] });
    expect(populated).toEqual(["base", expect.stringContaining("content_kind=array")]);
  });

  it.each([
    [null, ""],
    [{}, "content_kind=missing"],
    [{ content: null }, "content_kind=null"],
    [{ content: "text" }, "content_kind=string"],
  ] as const)("describes envelope %#", (value, expected) => {
    expect(utils.extractResponseDiagnostics(value)).toContain(expected);
  });

  it("extracts every envelope, identifier, usage, finish, and error variant", () => {
    const diagnostics = utils.extractResponseDiagnostics({
      content: [], summary: {}, output: {}, message: {}, response: {},
      request_id: " request ", "x-request-id": " x ", id: " id ",
      model: " model ", provider: " provider ",
      request_provider: " rp ", request_model: " rm ", request_api: " ra ",
      request_reasoning: " rr ", request_has_system: " yes ",
      request_temperature: " temp ", request_temperature_sent: " sent ",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, input: 4, output: 5, cacheRead: 6, cacheWrite: 7 },
      finish_reason: "done", errorMessage: " error ", error: { code: 1 },
    });
    expect(diagnostics).toContain("payload_preview=");
    expect(diagnostics).toContain("cacheWrite=7");
    expect(diagnostics).toContain("finish=done");
    expect(diagnostics).toContain("error_message=error");
  });

  it("supports both alternative stop reason fields and empty usage", () => {
    expect(utils.extractResponseDiagnostics({ content: [], stopReason: "first", usage: {} })).toContain("finish=first");
    expect(utils.extractResponseDiagnostics({ content: [], stop_reason: "second", usage: { prompt_tokens: "no" } })).toContain("finish=second");
  });
});

describe("deterministic fallback boundaries", () => {
  it("returns short text unchanged and truncates long text", () => {
    expect(utils.buildDeterministicFallbackSummary(" short ", 100)).toBe("short");
    expect(utils.buildDeterministicFallbackSummary("x".repeat(1000), 10)).toContain("[LCM fallback summary;");
  });
});
