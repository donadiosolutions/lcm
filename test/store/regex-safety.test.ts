import { describe, it, expect } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

function nestedQuantifierFixture(): string {
  return String.fromCharCode(40, 97, 43, 41, 43, 36);
}

function repeatedWildcardFixture(): string {
  return String.fromCharCode(40, 46, 42, 97, 41, 123, 50, 48, 125);
}

describe("validateRegex", () => {
  it("returns RegExp for safe patterns", () => {
    expect(validateRegex("hello.*world")).toBeInstanceOf(RegExp);
    expect(validateRegex("\\d{3}-\\d{4}")).toBeInstanceOf(RegExp);
  });

  it("throws for catastrophic backtracking patterns", () => {
    expect(() => validateRegex(nestedQuantifierFixture())).toThrow(/unsafe/i);
    expect(() => validateRegex(repeatedWildcardFixture())).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow();
    expect(() => validateRegex("(?P<name>")).toThrow();
  });
});
