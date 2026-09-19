import { describe, expect, it } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";
import * as regexSnippet from "../../src/store/regex-snippet.js";

describe("createRegexSnippet", () => {
  it("resets a validated global regex before every safe-row match", () => {
    const regex = validateRegex("ordinary", "g");

    expect(regexSnippet.createRegexSnippet("ordinary ordinary", regex)).toBe("ordinary");
    expect(regexSnippet.createRegexSnippet("ordinary ordinary", regex)).toBe("ordinary");
  });

  it("exports the fixed fallback used when complete-row scrubbing removes a match", () => {
    expect(regexSnippet.REGEX_SNIPPET_REDACTION_FALLBACK).toBe("[REDACTED]");
  });
});
