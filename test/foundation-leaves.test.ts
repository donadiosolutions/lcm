import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatConfigValue,
  getConfigValue,
  maskConfigSecrets,
} from "../src/config-manager.js";
import {
  boundedModelForDisplay,
  createProcessCompatibilityError,
  MAX_MODEL_DISPLAY_LENGTH,
} from "../src/llm/process-utils.js";
import { estimateTokens, parseTranscript } from "../src/transcript.js";
import {
  isUrlLikeKey,
  sanitizeEmbeddedUrlValuesForDisplay,
  sanitizeUrlForDisplay,
  sanitizeUrlValueForDisplay,
} from "../src/url-display.js";
import {
  createTemporaryDirectory,
  injectedFailure,
} from "./fixtures/runtime.js";

describe("foundation leaf-module boundaries", (): void => {
  it("parses nested transcript blocks and ignores every non-message shape", (): void => {
    const directory = createTemporaryDirectory("lcm-transcript-");
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
      "not json",
      JSON.stringify({ message: { role: "tool", content: "ignored role" } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "image", text: "ignored" }] } }),
      JSON.stringify({ message: { role: "user", content: [
        { type: "text", text: "question" },
        { type: "tool_result", content: [{ type: "text", text: "answer" }] },
        { type: "tool_result", content: 42 },
      ] } }),
      "",
    ].join("\n"));

    expect(parseTranscript(path)).toEqual([
      { role: "user", content: "question\nanswer", tokenCount: 4 },
    ]);
    expect(parseTranscript(join(directory, "missing.jsonl"))).toEqual([]);
    expect(estimateTokens("")).toBe(1);
  });

  it("covers URL key, protocol-relative, punctuation, and invalid URL boundaries", (): void => {
    expect(isUrlLikeKey(undefined)).toBe(false);
    expect(isUrlLikeKey("callback_uri")).toBe(true);
    expect(isUrlLikeKey("label")).toBe(false);
    expect(sanitizeUrlForDisplay("https://example.com/path")).toBe("https://example.com/path");
    expect(sanitizeUrlForDisplay("not a URL")).toBe("[REDACTED]");
    expect(sanitizeUrlValueForDisplay("ordinary", "endpoint")).toBe("[REDACTED]");
    expect(sanitizeEmbeddedUrlValuesForDisplay("see //example.com/path.")).toBe("see //example.com/path.");
    expect(sanitizeEmbeddedUrlValuesForDisplay("bad //user@[.")).toBe("bad [REDACTED].");
    expect(sanitizeEmbeddedUrlValuesForDisplay("bad //[.")).toBe("bad //[.");

    const NativeUrl = URL;
    let calls = 0;
    vi.stubGlobal("URL", class extends NativeUrl {
      constructor(value: string | URL, base?: string | URL) {
        calls++;
        if (calls === 2) throw new TypeError("deterministic URL failure");
        super(value, base);
      }
    });
    try {
      expect(sanitizeEmbeddedUrlValuesForDisplay("//user:password@example.com/path"))
        .toBe("[REDACTED]");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("covers non-object config traversal, non-string masking, and undefined formatting", (): void => {
    const directory = createTemporaryDirectory("lcm-config-leaf-");
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ extension: { scalar: 1 }, list: [1] }), { mode: 0o600 });

    expect((): unknown => getConfigValue({ configPath, path: "extension.scalar.child" })).toThrow("does not exist");
    expect((): unknown => getConfigValue({ configPath: directory, path: "llm" })).toThrow();
    expect(maskConfigSecrets(null)).toBeNull();
    expect(formatConfigValue(undefined)).toBe("undefined");
  });

  it("bounds process diagnostics across omitted, empty, long, and explicit controls", (): void => {
    expect(boundedModelForDisplay("\u0000  \n")).toBe("default");
    expect(boundedModelForDisplay("x".repeat(MAX_MODEL_DISPLAY_LENGTH))).toHaveLength(MAX_MODEL_DISPLAY_LENGTH);
    expect(boundedModelForDisplay("x".repeat(MAX_MODEL_DISPLAY_LENGTH + 1))).toBe(
      `${"x".repeat(MAX_MODEL_DISPLAY_LENGTH)}...[truncated]`,
    );
    expect(createProcessCompatibilityError({ cliName: "codex", providerId: "codex-process", code: null }).message)
      .toContain("exit unknown");
    expect(createProcessCompatibilityError({
      cliName: "claude",
      providerId: "claude-process",
      code: 2,
      model: "sonnet",
      reasoningEffort: "high",
      fastMode: false,
    }).message).toContain("fast mode false");
  });

  it("creates deterministic errno failures for process and filesystem tests", (): void => {
    expect(injectedFailure("cross-device", "EXDEV")).toMatchObject({
      message: "cross-device",
      code: "EXDEV",
    });
  });
});
