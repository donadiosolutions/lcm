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
