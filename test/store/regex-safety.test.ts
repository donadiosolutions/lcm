import { describe, it, expect, vi } from "vitest";
import { validateRegex } from "../../src/store/regex-safety.js";

vi.mock("safe-regex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("safe-regex")>();
  return {
    default: (pattern: string): boolean => {
      if (pattern === "throw-from-safe-regex") throw new Error("probe failed");
      return actual.default(pattern);
    },
  };
});

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
    expect(() => validateRegex("throw-from-safe-regex")).toThrow(/unsafe/i);
  });

  it("throws for invalid regex syntax", () => {
    expect(() => validateRegex("[invalid")).toThrow();
    expect(() => validateRegex("(?P<name>")).toThrow();
  });

  it("rejects invalid and duplicate flags before compiling", () => {
    expect(() => validateRegex("safe", "z")).toThrow("Invalid regex flags: z");
    expect(() => validateRegex("safe", "gg")).toThrow("Duplicate regex flags");
    expect(validateRegex("safe", "dgimsuy").flags).toBe("dgimsuy");
    expect(validateRegex("safe", "v").flags).toBe("v");
  });

  it("normalizes non-Error compilation failures", () => {
    vi.spyOn(Reflect, "construct").mockImplementationOnce(() => {
      throw "not-an-error";
    });
    expect(() => validateRegex("safe")).toThrow("Invalid regex pattern: syntax error");
    vi.spyOn(Reflect, "construct").mockImplementationOnce(() => {
      throw new Error("compile failed");
    });
    expect(() => validateRegex("safe")).toThrow("Invalid regex pattern: compile failed");
  });
});
