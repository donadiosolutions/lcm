import { describe, it, expect } from "vitest";
import { sanitizeError } from "../../src/daemon/safe-error.js";

describe("sanitizeError", () => {
  it("strips absolute file paths from error messages", () => {
    const result = sanitizeError("ENOENT: no such file /Users/pedro/.lcm/x");
    expect(result).not.toContain("/Users/pedro");
  });

  it("strips POSIX paths containing spaces", () => {
    const result = sanitizeError("ENOENT: no such file /Users/a/My Files/x");
    expect(result).toBe("ENOENT: no such file <path>");
  });

  it("strips Windows paths containing spaces", () => {
    const result = sanitizeError("ENOENT: no such file C:\\Users\\a\\My Files\\x");
    expect(result).toBe("ENOENT: no such file <path>");
  });

  it("stops at delimiters and preserves URL slashes", () => {
    const result = sanitizeError("failed at /Users/a/My Files/x: see https://example.test/x");
    expect(result).toBe("failed at <path>: see https://example.test/x");
  });

  it("is idempotent after replacing absolute paths", () => {
    const input = "failed at C:\\Users\\a\\My Files\\x";
    const sanitized = sanitizeError(input);
    expect(sanitizeError(sanitized)).toBe(sanitized);
  });

  it.each([
    ["open /home/bcdonadio/.lcm/memory.db => EACCES", "open <path> => EACCES"],
    ["/Users/pedro/secret.db#fragment", "<path>#fragment"],
    ["path=/Users/pedro/secret.db&retry=1", "path=<path>&retry=1"],
    ["glob /Users/pedro/secret* did not match", "glob <path> did not match"],
    ["/Users/pedro/secret.db=1", "<path>=1"],
    ["/Users/pedro/secret.db|retry", "<path>|retry"],
    ["ENOENT /Users/pedro/secret.db\n    at Object.open (/Users/pedro/app.js:1:1)", "ENOENT <path>\n    at Object.open (<path>:1:1)"],
    ["failed at /var/lib/lcm and then retried later.", "failed at <path> and then retried later."],
    ["failed at /tmp/x see https://example.test/x", "failed at <path> see https://example.test/x"],
    ["failed at C:\\tmp\\x see https://example.test/x", "failed at <path> see https://example.test/x"],
    ["file:///Users/pedro/secret.db", "file://<path>"],
    ["/Users/José/file", "<path>"],
    ["\\\\server\\share\\file", "<path>"],
    ["/tmp/file (copy).db", "<path>"],
    ["C:\\Users\\a\\secret.db#fragment", "<path>#fragment"],
    ["C:\\Users\\a\\secret.db\t=> denied", "<path>\t=> denied"],
  ] as const)("sanitizes adversarial path form %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it("replaces SQLite constraint details with generic message", () => {
    const result = sanitizeError("SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.conversation_id");
    expect(result).not.toContain("messages.conversation_id");
    expect(result).toContain("database");
  });

  it("preserves generic error messages", () => {
    expect(sanitizeError("invalid input")).toBe("invalid input");
    expect(sanitizeError("cwd is required")).toBe("cwd is required");
  });
});
