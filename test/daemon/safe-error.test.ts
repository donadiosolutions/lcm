import { describe, it, expect, vi } from "vitest";
import { sanitizeError } from "../../src/daemon/safe-error.js";

describe("sanitizeError", () => {
  it("strips absolute file paths from error messages", () => {
    const result = sanitizeError("ENOENT: no such file /Users/pedro/.lcm/x");
    expect(result).not.toContain("/Users/pedro");
  });

  it("strips POSIX paths containing spaces", () => {
    const result = sanitizeError("ENOENT: no such file '/Users/a/My Files/x'");
    expect(result).toBe("ENOENT: no such file '<path>'");
  });

  it("strips Windows paths containing spaces", () => {
    const result = sanitizeError("ENOENT: no such file \"C:\\Users\\a\\My Files\\x\"");
    expect(result).toBe("ENOENT: no such file \"<path>\"");
  });

  it("stops at delimiters and preserves URL slashes", () => {
    const result = sanitizeError("failed at '/Users/a/My Files/x': see https://example.test/x");
    expect(result).toBe("failed at '<path>': see https://example.test/x");
  });

  it("is idempotent after replacing absolute paths", () => {
    const input = "failed at \"C:\\Users\\a\\My Files\\x\"";
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
    ["/tmp/file(copy).db", "<path>"],
    ["open '/tmp/file (copy).db'", "open '<path>'"],
    ["C:\\Users\\a\\secret.db#fragment", "<path>#fragment"],
    ["C:\\Users\\a\\secret.db\t=> denied", "<path>\t=> denied"],
    ["open /var/lib/lcm during startup", "open <path> during startup"],
    ["open /var/lib/lcm when opening", "open <path> when opening"],
    ["open /var/lib/lcm is missing", "open <path> is missing"],
    ["open /var/lib/lcm was locked", "open <path> was locked"],
    ["open /var/lib/lcm failed", "open <path> failed"],
    ["open //home/alice/private.db failed", "open <path> failed"],
    ["root /", "root /"],
    ["root //", "root //"],
    ["open '/Users/a/My Files/x' during startup", "open '<path>' during startup"],
    ["open \"C:\\Users\\a\\My Files\\x\" during startup", "open \"<path>\" during startup"],
    ["FILE:///Users/pedro/secret.db", "FILE://<path>"],
    ["file://localhost/Users/pedro/secret.db", "file://localhost<path>"],
    ["https://[::1]/secret", "https://[::1]/secret"],
    ["url=https://[::1]/secret", "url=https://[::1]/secret"],
    ["(https://[::1]/secret)", "(https://[::1]/secret)"],
    [
      "failed for https://example.test/x,/Users/alice/private.db",
      "failed for https://example.test/x,<path>",
    ],
    ["/tmp/file[1].txt", "<path>"],
    ["open /tmp/💥payload failed", "open <path> failed"],
    ["open '/tmp/file\nfailed", "open '<path>\nfailed"],
  ] as const)("sanitizes adversarial path form %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  const hostedFileUrlCases = [
    {
      input: "file://remote.invalid[/Users/canary/private.db",
      expected: "file://remote.invalid[<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid[/Users/canary/private.db]",
      expected: "file://remote.invalid[<path>]",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://[/Users/canary/private.db",
      expected: "file://[<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid[[/Users/canary/private.db",
      expected: "file://remote.invalid[[<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid[/C:/Users/canary/private.db",
      expected: "file://remote.invalid[<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid[\\C:\\Users\\canary\\private.db",
      expected: "file://remote.invalid[<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "'file://remote.invalid[/Users/canary/My Files/private.db",
      expected: "'file://remote.invalid[<path>",
      absent: ["Users", "canary", "My Files", "private.db"],
    },
    {
      input: "'file://remote.invalid[/Users/canary/My Files/private.db]'",
      expected: "'file://remote.invalid[<path>'",
      absent: ["Users", "canary", "My Files", "private.db"],
    },
    {
      input: "see file://remote.invalid[/Users/canary/private.db later",
      expected: "see file://remote.invalid[<path> later",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid/Users/canary/private.db",
      expected: "file://remote.invalid<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid//Users/canary/private.db",
      expected: "file://remote.invalid<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid/C:/Users/canary/private.db",
      expected: "file://remote.invalid<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid/C:\\Users\\canary\\private.db",
      expected: "file://remote.invalid<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file://localhost/C:/Users/canary/private.db",
      expected: "file://localhost<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file:///C:/Users/canary/private.db",
      expected: "file://<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file:///C:/",
      expected: "file://<path>",
      absent: ["C:"],
    },
    {
      input: "FILE://REMOTE.INVALID/Users/canary/private.db",
      expected: "FILE://REMOTE.INVALID<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: `file://${"authority".repeat(24)}.invalid/Users/canary/private.db`,
      expected: `file://${"authority".repeat(24)}.invalid<path>`,
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://[fe80::1%25eth0]/Users/canary/private.db",
      expected: "file://[fe80::1%25eth0]<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid\\Users\\canary\\private.db",
      expected: "file://remote.invalid<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://remote.invalid\\\\C:\\Users\\canary\\private.db",
      expected: "file://remote.invalid<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "'file://remote.invalid/Users/canary/My Files/private.db'",
      expected: "'file://remote.invalid<path>'",
      absent: ["Users", "canary", "My Files", "private.db"],
    },
    {
      input: '\"file://remote.invalid/C:/Users/canary/My Files/private.db\"',
      expected: '\"file://remote.invalid<path>\"',
      absent: ["C:", "Users", "canary", "My Files", "private.db"],
    },
    {
      input: "'file://remote.invalid/Users/canary/My Files/private.db",
      expected: "'file://remote.invalid<path>",
      absent: ["Users", "canary", "My Files", "private.db"],
    },
    {
      input: "'file://remote.invalid/Users/canary/My Files\ncontinued",
      expected: "'file://remote.invalid<path>\ncontinued",
      absent: ["Users", "canary", "My Files"],
    },
    {
      input:
        '\"file://one.invalid/Users/canary/One File\"\"file://two.invalid/Users/canary/Two File\"',
      expected: '\"file://one.invalid<path>\"\"file://two.invalid<path>\"',
      absent: ["Users", "canary", "One File", "Two File"],
    },
    {
      input: "file://C:/Users/canary/private.db",
      expected: "file://C:<path>",
      absent: ["Users", "canary", "private.db"],
    },
  ] as const;

  it.each(hostedFileUrlCases)("redacts hosted file URL paths: $input", ({ input, expected, absent }) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    for (const component of absent) expect(result).not.toContain(component);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["xfile:///Users/canary/private.db", "xfile://<path>"],
    ["profile://localhost/Users/canary/private.db", "profile://localhost<path>"],
    ["xfile://remote.invalid/Users/canary/private.db", "xfile://remote.invalid/Users/canary/private.db"],
    [
      "profile://remote.invalid/Users/canary/private.db",
      "profile://remote.invalid/Users/canary/private.db",
    ],
    ["file://", "file://"],
    ["file://localhost", "file://localhost"],
    ["file:///", "file:///"],
    ["file://remote.invalid/", "file://remote.invalid/"],
    ["file://remote.invalid//", "file://remote.invalid//"],
    ["https://example.test/Users/canary/private.db", "https://example.test/Users/canary/private.db"],
    ["https://[fe80::1%25eth0]/Users/canary/private.db", "https://[fe80::1%25eth0]/Users/canary/private.db"],
    ["prefix=https://example.test/x", "prefix=https://example.test/x"],
    [
      "https://one.invalid/x,https://two.invalid/y,/Users/canary/private.db",
      "https://one.invalid/x,https://two.invalid/y,<path>",
    ],
    [
      "file://remote.invalid/Users/canary/private.db: retry https://example.test/x",
      "file://remote.invalid<path>: retry https://example.test/x",
    ],
    [
      "file://remote.invalid/Users/canary/My Files/private.db",
      "file://remote.invalid<path> Files/private.db",
    ],
    [
      "file://remote.invalid/Reports:2024/private.db",
      "file://remote.invalid<path>:2024/private.db",
    ],
  ] as const)("preserves file URL compatibility boundary %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://remote.invalid/Users/canary/private.db?next=/etc/private.db",
      "file://remote.invalid<path>?next=/etc/private.db",
      "file://remote.invalid<path>?next=<path>",
    ],
    [
      "file://remote.invalid/Users/canary/private.db#next=/etc/private.db",
      "file://remote.invalid<path>#next=/etc/private.db",
      "file://remote.invalid<path>#next=<path>",
    ],
  ] as const)("redacts file URL delimiter residuals monotonically %#", (input, firstPass, secondPass) => {
    expect(sanitizeError(input)).toBe(firstPass);
    expect(sanitizeError(firstPass)).toBe(secondPass);
    expect(sanitizeError(secondPass)).toBe(secondPass);
  });

  it("bounds URL authority classification work by input length", () => {
    const authority = `${"host-segment".repeat(64)}.invalid`;
    const path = Array.from({ length: 256 }, (_, index) => `segment-${index}`).join("/");
    const input = `request failed for file://${authority}/${path}`;
    const originalTest = RegExp.prototype.test;
    let whitespaceChecks = 0;
    const testSpy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (value: string): boolean {
      if (this.source === "\\s" && this.flags === "u") whitespaceChecks += 1;
      return Reflect.apply(originalTest, this, [value]);
    });

    let result: string;
    try {
      result = sanitizeError(input);
    } finally {
      testSpy.mockRestore();
    }

    expect(result).toBe(`request failed for file://${authority}<path>`);
    expect(result).not.toContain("segment-0");
    expect(whitespaceChecks).toBeLessThanOrEqual(Array.from(input).length);
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
