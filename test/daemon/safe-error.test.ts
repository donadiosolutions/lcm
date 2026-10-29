import { createHash } from "node:crypto";
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
      input: "file://host;name/Users/canary/private.db",
      expected: "file://host;name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host,name/Users/canary/private.db",
      expected: "file://host,name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host'name/Users/canary/private.db",
      expected: "file://host'name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host)name/Users/canary/private.db",
      expected: "file://host)name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host}name/Users/canary/private.db",
      expected: "file://host}name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host;name,other'part)tail}/Users/canary/private.db",
      expected: "file://host;name,other'part)tail}<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "file://host;name/C:\\Users\\canary\\private.db",
      expected: "file://host;name<path>",
      absent: ["C:", "Users", "canary", "private.db"],
    },
    {
      input: "file://host,name\\Users\\canary\\private.db",
      expected: "file://host,name<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "FiLe://HOST}NAME/Users/canary/private.db",
      expected: "FiLe://HOST}NAME<path>",
      absent: ["Users", "canary", "private.db"],
    },
    {
      input: "'file://host;name/My Files/private.db'",
      expected: "'file://host;name<path>'",
      absent: ["host;name/My Files", "private.db"],
    },
    {
      input: '\"file://host\'name/My Files/private.db\"',
      expected: '\"file://host\'name<path>\"',
      absent: ["host'name/My Files", "private.db"],
    },
    {
      input: "file://host;name/",
      expected: "file://host;name/",
      absent: [],
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
    [
      "'file://host'name/Users/canary/private.db'",
      "'file://host'name<path>'",
    ],
    [
      "'file://ho'st'name/Users/canary/private.db'",
      "'file://ho'st'name<path>'",
    ],
    [
      "'file://host''name/Users/canary/private.db'",
      "'file://host''name<path>'",
    ],
    [
      "'file://host'name/My Files/private.db'",
      "'file://host'name<path>'",
    ],
    [
      "'file://host'name/Users/canary/private.db trailing prose",
      "'file://host'name<path>",
    ],
    [
      "'file://host'name/Users/canary/private.db\ntrailing prose",
      "'file://host'name<path>\ntrailing prose",
    ],
    [
      "'file://host'/Users/canary/private.db'",
      "'file://host'<path>'",
    ],
    [
      "'file://host'name/Users/canary/private.db' later'",
      "'file://host'name<path>' later'",
    ],
    ["'file://host'name'", "'file://host'name'"],
    ["'file://host'name/'", "'file://host'name/'"],
    [
      "'file://host'name' https://example.test/x'",
      "'file://host'name' https://example.test/x'",
    ],
    [
      "'https://host'name/Users/canary/private.db'",
      "'https://host'name/Users/canary/private.db'",
    ],
    [
      "'file://host'name/C:/Users/canary/private.db'",
      "'file://host'name<path>'",
    ],
    [
      "'file://host'name\\Users\\canary\\private.db'",
      "'file://host'name<path>'",
    ],
    [
      "'file://authority-authority-authority-authority-authority.invalid'name/Users/canary/private.db'",
      "'file://authority-authority-authority-authority-authority.invalid'name<path>'",
    ],
    [
      "'file://höst'name/Users/canary/private.db'",
      "'file://höst'name<path>'",
    ],
    [
      "'file://host;na,me')tail}/Users/canary/private.db'",
      "'file://host;na,me')tail}<path>'",
    ],
    [
      "'file://host'name?part/Users/canary/private.db'",
      "'file://host'name?part<path>'",
    ],
    [
      "'file://host'name#part/Users/canary/private.db'",
      "'file://host'name#part<path>'",
    ],
    [
      "'file://host'na me/Users/canary/private.db'",
      "'file://host'na me/Users/canary/private.db'",
    ],
    [
      "file://host'name/Users/canary/private.db",
      "file://host'name<path>",
    ],
    [
      '\"file://host\'name/Users/canary/private.db\"',
      '\"file://host\'name<path>\"',
    ],
  ] as const)("handles ambiguous apostrophes in quoted file authorities: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "'file://'file://host'/My Files/canary.db",
      "'file://'file://host'<path>",
    ],
    [
      "'file://'file://host'\\C:\\Users\\canary\\My Files\\canary.db",
      "'file://'file://host'<path>",
    ],
    [
      "ENOENT: 'file://'file://server'/Shared Docs/canary.db' not found",
      "ENOENT: 'file://'file://server'<path>' not found",
    ],
    [
      "'file://'FiLe://host'/My Files/canary.db",
      "'file://'FiLe://host'<path>",
    ],
    [
      "file://host'file://x/Users/canary/private.db",
      "file://host'file:<path>",
    ],
    [
      '\"file://host\'file://x/Users/canary/private.db\"',
      '\"file://host\'file:<path>\"',
    ],
  ] as const)("redacts separately quoted nested file URL paths: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it("keeps compound nested file URL redaction idempotent", () => {
    const input = "'file://host?;mefile://https://example.test/x'file://'file://}]'";
    const first = sanitizeError(input);

    expect(first).toBe("'file://host?;mefile:<path>'file://'file://}]'");
    expect(sanitizeError(first)).toBe(first);
  });

  it("redacts a path after a bracket-wrapped quoted file path on the first pass", () => {
    const result = sanitizeError("'file://host'['/private']?/Users/SECRET");

    expect(result).toBe("'file://host'['<path>']?<path>");
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private']?\\Users\\SECRET", "'file://host'['<path>']?<path>"],
    ["'file://host'['/private']#\\Users\\SECRET", "'file://host'['<path>']#<path>"],
    ['"file://host["/private"]?\\Users\\SECRET', '"file://host["<path>"]?<path>'],
    ['"file://host["/private"]#\\Users\\SECRET', '"file://host["<path>"]#<path>'],
    ["'file://host'['/private'?\\Users\\SECRET", "'file://host'['<path>'?<path>"],
    ['"file://host["/private"#\\Users\\SECRET', '"file://host["<path>"#<path>'],
    ["'file://host'[['/private']]?\\C:\\Users\\SECRET", "'file://host'[['<path>']]?<path>"],
    ["'file://host'['/private']#C:\\Users\\SECRET", "'file://host'['<path>']#<path>"],
    ["'file://host'['/private']?\\\\server\\share\\SECRET", "'file://host'['<path>']?<path>"],
  ] as const)("redacts backslash query tails after a closed quoted file path: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private'?a]\\Users\\SECRET", "'file://host'['<path>'?a]<path>"],
    ["'file://host'['/private'#a]\\Users\\SECRET", "'file://host'['<path>'#a]<path>"],
    ['"file://host["/private"?a]\\Users\\SECRET', '"file://host["<path>"?a]<path>'],
    ['"file://host["/private"#a]\\Users\\SECRET', '"file://host["<path>"#a]<path>'],
    ["'file://host'[['/private'?a]]\\Users\\SECRET", "'file://host'[['<path>'?a]]<path>"],
    ["'file://host'[['/private'#a]]\\Users\\SECRET", "'file://host'[['<path>'#a]]<path>"],
    ['"file://host[["/private"?a]]\\Users\\SECRET', '"file://host[["<path>"?a]]<path>'],
    ['"file://host[["/private"#a]]\\Users\\SECRET', '"file://host[["<path>"#a]]<path>'],
  ] as const)("retains open quoted wrapper context through query delimiters: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private']?https://y.test/p\\Users\\SECRET", "'file://host'['<path>']?https:<path>"],
    ["'file://host'['/private']#https://y.test/p\\Users\\SECRET", "'file://host'['<path>']#https:<path>"],
    ["'file://host'['/private']?http://y.test/p\\Users\\SECRET", "'file://host'['<path>']?http:<path>"],
    ["'file://host'['/private']#http://y.test/p\\Users\\SECRET", "'file://host'['<path>']#http:<path>"],
    ["'file://host'['/private']?https://y.test/p/Users/SECRET", "'file://host'['<path>']?https:<path>"],
    ["'file://host'['/private']#https://y.test/p/Users/SECRET", "'file://host'['<path>']#https:<path>"],
    ["'file://host'['/private']?http://y.test/p/Users/SECRET", "'file://host'['<path>']?http:<path>"],
    ["'file://host'['/private']#http://y.test/p/Users/SECRET", "'file://host'['<path>']#http:<path>"],
    ['"file://host["/private"]?https://y.test/p\\Users\\SECRET', '"file://host["<path>"]?https:<path>'],
    ['"file://host["/private"]#https://y.test/p\\Users\\SECRET', '"file://host["<path>"]#https:<path>'],
    ['"file://host["/private"]?http://y.test/p\\Users\\SECRET', '"file://host["<path>"]?http:<path>'],
    ['"file://host["/private"]#http://y.test/p\\Users\\SECRET', '"file://host["<path>"]#http:<path>'],
    ['"file://host["/private"]?https://y.test/p/Users/SECRET', '"file://host["<path>"]?https:<path>'],
    ['"file://host["/private"]#https://y.test/p/Users/SECRET', '"file://host["<path>"]#https:<path>'],
    ['"file://host["/private"]?http://y.test/p/Users/SECRET', '"file://host["<path>"]?http:<path>'],
    ['"file://host["/private"]#http://y.test/p/Users/SECRET', '"file://host["<path>"]#http:<path>'],
  ] as const)("retains conservative glued URL redaction after quoted query delimiters: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private']?x=[https://y.test/p]\\Users\\SECRET", "'file://host'['<path>']?x=[https://y.test/p]<path>"],
    ["'file://host'['/private']#x=[http://y.test/p]\\Users\\SECRET", "'file://host'['<path>']#x=[http://y.test/p]<path>"],
    ['"file://host["/private"]?x=[http://y.test/p]\\Users\\SECRET', '"file://host["<path>"]?x=[http://y.test/p]<path>'],
    ['"file://host["/private"]#x=[https://y.test/p]\\Users\\SECRET', '"file://host["<path>"]#x=[https://y.test/p]<path>'],
  ] as const)("preserves bracketed URLs and redacts their quoted-file tails: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["file://host.invalid/Users/outer.db?x=[a]\\Users\\canary\\private.db", "file://host.invalid<path>?x=[a]<path>"],
    ["file://host.invalid/Users/outer.db#x=[a]\\Users\\canary\\private.db", "file://host.invalid<path>#x=[a]<path>"],
    ["file://host.invalid/Users/outer.db?\\Users\\SECRET", "file://host.invalid<path>?<path>"],
    ["file://host.invalid/Users/outer.db#\\C:\\Users\\SECRET", "file://host.invalid<path>#<path>"],
    ["file://host.invalid/Users/outer.db?C:\\Users\\SECRET", "file://host.invalid<path>?<path>"],
    ["file://host.invalid/Users/outer.db#\\\\server\\share\\SECRET", "file://host.invalid<path>#<path>"],
    ["file://host.invalid/Users/outer.db?x=[a\\Users\\SECRET", "file://host.invalid<path>?x=[a<path>"],
    ["file://host.invalid[/Users/outer.db]?x=a\\Users\\SECRET", "file://host.invalid[<path>]?x=a<path>"],
  ] as const)("redacts backslash query tails after an unquoted outer file path: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["file://host.invalid?x=[a|\\Users\\canary\\private.db", "file://host.invalid?x=[a|<path>"],
    ["file://host.invalid?x=[a] \\Users\\canary\\private.db", "file://host.invalid?x=[a] <path>"],
    [
      "file://host.invalid?x=[https://y.test/p]\\Users\\canary\\private.db",
      "file://host.invalid?x=[https://y.test/p]<path>",
    ],
    // Bug #1128 reclassifies this inherited P3-shaped row as a positive privacy contract.
    [
      "file://host.invalid?x=[https://y.test/p]\\Users\\literal",
      "file://host.invalid?x=[https://y.test/p]<path>",
    ],
    [
      "file://host.invalid/Users/outer.db?x=[a]\\Users\\canary\\private.db",
      "file://host.invalid<path>?x=[a]<path>",
    ],
    ["file://host.invalid#x=[a|\\Users\\canary\\private.db", "file://host.invalid#x=[a|<path>"],
    ["file://host.invalid#x=[a]\t\\Users\\canary\\private.db", "file://host.invalid#x=[a]\t<path>"],
    [
      "file://host.invalid#x=[http://y.test/p]\\Users\\canary\\private.db",
      "file://host.invalid#x=[http://y.test/p]<path>",
    ],
    ["FiLe://host.invalid?x=[[a],] \\home\\canary\\private.db", "FiLe://host.invalid?x=[[a],] <path>"],
  ] as const)("redacts bracket-handoff backslash tails from file URL values: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("Users");
    expect(first).not.toContain("canary");
    expect(first).not.toContain("private.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "file://h?x=[https://[::1]/p]\\Users\\fictional.db",
      "file://h?x=[https://[::1]/p]<path>",
    ],
    [
      "file://h?x=[https://[::1]:443/p]\\Users\\fictional.db",
      "file://h?x=[https://[::1]:443/p]<path>",
    ],
    [
      "file://h?x=[https://[::1]?q=a]\\Users\\fictional.db",
      "file://h?x=[https://[::1]?q=a]<path>",
    ],
  ] as const)("redacts IPv6 URL bracket-handoff backslash tails: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    ["ordinary?x=[a]\\Users\\literal", "ordinary?x=[a]\\Users\\literal"],
    [
      "https://host.invalid/outer?x=[a]\\Users\\literal",
      "https://host.invalid/outer?x=[a]\\Users\\literal",
    ],
    [
      "file://host.invalid?x=value then \\Users\\literal",
      "file://host.invalid?x=value then \\Users\\literal",
    ],
    ["file://host.invalid?x=value|\\Users\\literal", "file://host.invalid?x=value|\\Users\\literal"],
    ["file://host.invalid?x=value]\\Users\\literal", "file://host.invalid?x=value]\\Users\\literal"],
    [
      "file://host.invalid?x=[a] prose \\Users\\literal",
      "file://host.invalid?x=[a] prose \\Users\\literal",
    ],
    ["file://host.invalid?x=[a]\n\\Users\\literal", "file://host.invalid?x=[a]\n\\Users\\literal"],
    ["file://host.invalid?x=[a]\r\\Users\\literal", "file://host.invalid?x=[a]\r\\Users\\literal"],
    ["file://host.invalid?x=[a]\u00a0\\Users\\literal", "file://host.invalid?x=[a]\u00a0\\Users\\literal"],
    [
      "file://host.invalid?x=https://y.test/p\\Users\\literal",
      "file://host.invalid?x=https://y.test/p\\Users\\literal",
    ],
    [
      "file://host.invalid/outer?x=a \\Users\\literal",
      "file://host.invalid<path>?x=a \\Users\\literal",
    ],
    [
      "file://host.invalid/outer?x=a|\\Users\\literal",
      "file://host.invalid<path>?x=a|\\Users\\literal",
    ],
    ["file://host.invalid?x=[a]https://example.test/p", "file://host.invalid?x=[a]https://example.test/p"],
    ["err at \\Users\\canary\\private.db now", "err at \\Users\\canary\\private.db now"],
    ["file://host.invalid?x=[a|see\\Users\\literal", "file://host.invalid?x=[a|see\\Users\\literal"],
    ["file://host.invalid?x=[a| \\Users\\literal", "file://host.invalid?x=[a| \\Users\\literal"],
    [
      "file://host.invalid?x=[a|https://y.test/p?q=\\Users\\literal",
      "file://host.invalid?x=[a|https://y.test/p?q=\\Users\\literal",
    ],
    ["file://host.invalid?x=[a]]\\Users\\literal", "file://host.invalid?x=[a]]\\Users\\literal"],
    [
      "file://host.invalid?x=[a|see]\\Users\\literal",
      "file://host.invalid?x=[a|see]\\Users\\literal",
    ],
    [
      "file://h?x=[https://[::1]prose]\\Users\\fictional.db",
      "file://h?x=[https://[::1]prose]\\Users\\fictional.db",
    ],
  ] as const)("preserves bracket-handoff boundaries: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(expected);
  });

  it("consumes a bracket-handoff only once across sanitizer passes", () => {
    const input = "file://host.invalid?x=[a|\\Users\\first.db|\\Users\\second.db";
    const expected = "file://host.invalid?x=[a|<path>|\\Users\\second.db";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(expected);
    expect(sanitizeError(sanitizeError(first))).toBe(expected);
  });

  it("repeats an IPv6 bracket handoff for every rooted successor", () => {
    const input = "file://h?x=[https://[::1]/p|\\Users\\first.db|\\Users\\second.db";
    const expected = "file://h?x=[https://[::1]/p|<path>|<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("second.db");
    expect(sanitizeError(first)).toBe(expected);
    expect(sanitizeError(sanitizeError(first))).toBe(expected);
  });

  it.each([
    [
      "IPv6 authority",
      "file://h?x=[https://[::1]/t|/Users/a/one&\\Users\\SECRET\\x]",
      "file://h?x=[https://[::1]/t|<path>&<path>]",
    ],
    [
      "bracketed path segment",
      "file://h?x=[https://e.test/t[/seg]|/Users/a/one&\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t[/seg]|<path>&<path>]",
    ],
    [
      "repeated pipe after a bracketed segment",
      "file://h?x=[https://e.test/t[/seg]|\\Users\\S1|\\Users\\S2]",
      "file://h?x=[https://e.test/t[/seg]|<path>|<path>]",
    ],
    [
      "unbracketed parity control",
      "file://h?x=[https://e.test/t|\\Users\\alice\\one.db|\\Users\\bob\\secret.db]",
      "file://h?x=[https://e.test/t|<path>|<path>]",
    ],
    [
      "ampersand successor control",
      "file://h?x=[https://[::1]/t&\\Users\\SECRET\\x]",
      "file://h?x=[https://[::1]/t&<path>]",
    ],
  ] as const)("keeps handoff ownership across a bracketed nested public URL (Bug #1343): %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    "file://h?x=[https://[::1]prose]\\Users\\fictional.db",
    "file://h?x=[https://[::1]/t|relative/path&\\Users\\SECRET\\x]",
  ] as const)("does not arm the Bug #1343 handoff without a path root: %s", (input) => {
    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it.each([
    ["ordinary?x=a\\Users\\literal", "ordinary?x=a\\Users\\literal"],
    ["https://host.invalid/outer?x=[a]\\Users\\literal", "https://host.invalid/outer?x=[a]\\Users\\literal"],
    ["file://host.invalid/outer[x]\\Users\\literal", "file://host.invalid<path>"],
    ["file://host.invalid[/outer]x\\Users\\literal", "file://host.invalid[<path>]x\\Users\\literal"],
    ["file://host.invalid/outer?x=a \\Users\\literal", "file://host.invalid<path>?x=a \\Users\\literal"],
    ["file://host.invalid/outer?x=a|\\Users\\literal", "file://host.invalid<path>?x=a|\\Users\\literal"],
    ["file://host.invalid/outer?x=a;\\Users\\literal", "file://host.invalid<path>?x=a;\\Users\\literal"],
    ["file://host.invalid/outer?x=[a]/public", "file://host.invalid<path>?x=[a]/public"],
  ] as const)("keeps backslash query handling within its file URL context: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    ["'file://host'['/private'\\Users\\SECRET", "'file://host'['<path>'<path>"],
    ['"file://host["/private"\\Users\\SECRET', '"file://host["<path>"<path>'],
    ["'file://host'[['/private'\\Users\\SECRET", "'file://host'[['<path>'<path>"],
  ] as const)("redacts immediate backslash tails inside unmatched quoted wrappers: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
    expect(sanitizeError(sanitizeError(input))).toBe(expected);
  });

  it.each([
    ["'file://host'name\"/'\\Users\\SECRET", "'file://host'name\"/'<path>"],
    ["'file://host'name\"//'\\Users\\SECRET", "'file://host'name\"//'<path>"],
    ["'file://host'name\"/private'\\Users\\SECRET", "'file://host'name\"<path>'<path>"],
  ] as const)("redacts immediate backslash tails after root-only quoted file paths: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
    expect(sanitizeError(sanitizeError(input))).toBe(expected);
  });

  it.each([
    [
      "'file://host'['/private']?next/Users/SECRET",
      "'file://host'['<path>']?next<path>",
    ],
    [
      "'file://host'['/private']#next/Users/SECRET",
      "'file://host'['<path>']#next<path>",
    ],
    [
      '"file://host["/private"]?next/Users/SECRET',
      '"file://host["<path>"]?next<path>',
    ],
    [
      '"file://host["/private"]#next/Users/SECRET',
      '"file://host["<path>"]#next<path>',
    ],
  ] as const)("redacts word-bearing quoted query tails in one pass: %#", (input, expected) => {
    const first = sanitizeError(input);
    const second = sanitizeError(first);
    const third = sanitizeError(second);

    expect(first).toBe(expected);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it.each([
    ["'file://host'['/private']? /Users/SECRET", "'file://host'['<path>']? <path>"],
    [
      "'file://host'['/private']|https://example.test/x",
      "'file://host'['<path>']|https://example.test/x",
    ],
    [
      "'file://host'['/private']?file://two.invalid/Users/b?next2/Users/SECRET",
      "'file://host'['<path>']?file://two.invalid<path>?next2/Users/SECRET",
    ],
    [
      "'file://host'['/private']|file://two.invalid/Users/b?next2/Users/SECRET",
      "'file://host'['<path>']|file://two.invalid<path>?next2/Users/SECRET",
    ],
    [
      "file://host.invalid/Users/a?next/Users/SECRET",
      "file://host.invalid<path>?next/Users/SECRET",
    ],
    [
      "'file://host'['/private']?next/Users/SECRET|https://example.test/x",
      "'file://host'['<path>']?next<path>|https://example.test/x",
    ],
    [
      "'file://host'['/private']?a&b=c/Users/SECRET",
      "'file://host'['<path>']?a&b=c<path>",
    ],
    ["'file://host'['/private']?next?/Users/SECRET", "'file://host'['<path>']?next?<path>"],
    ["'file://host'['/private']?next#/Users/SECRET", "'file://host'['<path>']?next#<path>"],
    [
      "'file://host'['/private']?next/Users/A?more/Users/B",
      "'file://host'['<path>']?next<path>?more<path>",
    ],
    ["ordinary?next/Users/SECRET", "ordinary?next/Users/SECRET"],
    ["file://host.invalid/Users/canary/private.db", "file://host.invalid<path>"],
  ] as const)("keeps quoted query-tail handoff within its file URL context: %#", (input, expected) => {
    const first = sanitizeError(input);
    const second = sanitizeError(first);
    const third = sanitizeError(second);

    expect(first).toBe(expected);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it.each([
    [
      "'file://host'['/private']?next/https://public.test/x",
      "'file://host'['<path>']?next/https:<path>",
    ],
    [
      "'file://host'['/private']?next/ftp://public.test/x",
      "'file://host'['<path>']?next/ftp:<path>",
    ],
  ] as const)("does not consume a recognized scheme as a quoted query tail: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    ["'file://host'[['/private']]#/Users/SECRET", "'file://host'[['<path>']]#<path>"],
    ['"file://host["/private"]?/Users/SECRET', '"file://host["<path>"]?<path>'],
    ["'file://host'[\\C:\\private']?/Users/SECRET", "'file://host'[<path>']?<path>"],
    ["'file://host'['/private'?/Users/SECRET", "'file://host'['<path>'?<path>"],
  ] as const)("ends quoted file path classification inside brackets: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private']https://h]/Users/SECRET", "'file://host'['<path>']https:<path>]<path>"],
    ["'file://host'['/private']\\Users\\SECRET", "'file://host'['<path>']<path>"],
    ['"file://host["/private"]\\Users\\SECRET', '"file://host["<path>"]<path>'],
    ["'file://host'['/private']\\D:\\SECRET", "'file://host'['<path>']<path>"],
    ["'file://host'['/private'https://h)/Users/SECRET", "'file://host'['<path>'https:<path>)<path>"],
    ["'file://host'['/private']https://h;/Users/SECRET", "'file://host'['<path>']https:<path>;<path>"],
    ["'file://host'['/private']https://h\\D:\\SECRET", "'file://host'['<path>']https:<path>\\<path>"],
    ["'file://host'['/private']https://pub.test/x\\C:\\Users\\SECRET", "'file://host'['<path>']https:<path>\\<path>"],
    ['"file://host["/private"]https://h\\D:\\SECRET', '"file://host["<path>"]https:<path>\\<path>'],
  ] as const)("redacts later paths after a bracketed path quote on the first pass: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'['/private']https://pub.test/x", "'file://host'['<path>']https:<path>"],
    ["'file://host'['/private'] https://pub.test/x", "'file://host'['<path>'] https://pub.test/x"],
    ["'file://host'['/private'] at https://pub.test/x", "'file://host'['<path>'] at https://pub.test/x"],
    ["'file://host'['/private'] https://h\\D:\\SECRET", "'file://host'['<path>'] https://h\\<path>"],
    ["'file://host'['/private'] https://[fe80::1]/pub", "'file://host'['<path>'] https://[fe80::1]/pub"],
  ] as const)("preserves public URLs after a bracketed path quote when separated by whitespace: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["/p\\D:\\E:\\SECRET", "<path>\\<path>"],
    ["ENOENT: /private\\C:\\Users\\E:\\SECRET", "ENOENT: <path>\\<path>"],
    ["'file://host'['/private']https://h\\D:\\E:\\SECRET", "'file://host'['<path>']https:<path>\\<path>"],
    ["D:\\E:\\SECRET", "<path>"],
  ] as const)("redacts nested Windows drives completely on the first pass: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["/p\\C:\\E::\\SECRET", "<path>\\<path>"],
    ["/C:\\E::\\SECRET", "<path>"],
    ["/private/C:\\E::\\SECRET", "<path>"],
    ["/C:\\dir/E::\\SECRET", "<path>"],
    ["D:\\E::\\SECRET", "<path>"],
    ["d:\\e::\\secret", "<path>"],
    ["\\\\host\\E::\\SECRET", "<path>"],
    ["file://host.invalid/E::\\SECRET", "file://host.invalid<path>"],
    ["file:///C:\\E::\\SECRET", "file://<path>"],
    ["https://example.test/C:\\E::\\SECRET", "https://example.test/<path>"],
    ["C:\\E::\\E::\\SECRET", "<path>"],
    ["/p\\E::\\dir/F::\\SECRET", "<path>"],
    ["C:\\E::\\1SECRET", "<path>"],
    ["C:\\E::\\", "<path>"],
    ["/p\\C:\\E::\\SECRET https://pub.test/x", "<path>\\<path> https://pub.test/x"],
  ] as const)("redacts doubled-colon drive segments inside recognized paths: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'C:\\E::\\SECRET'", "'<path>'"],
    ['"C:\\E::\\SECRET"', '"<path>"'],
    ["E::\\SECRET", "E::\\SECRET"],
    ["/p/E::\\SECRET", "<path>::\\SECRET"],
    ["C:\\E:::\\SECRET", "<path>:::\\SECRET"],
    ["C:\\E::/SECRET", "<path>::<path>"],
    ["C:\\E::", "<path>::"],
    ["C:\\E::SECRET", "<path>::SECRET"],
    ["C:\\AB::\\SECRET", "<path>::\\SECRET"],
    ["C:\\1::\\SECRET", "<path>::\\SECRET"],
    ["C:\\Ω::\\SECRET", "<path>::\\SECRET"],
    ["C:\\É::\\SECRET", "<path>::\\SECRET"],
    ["C:\\fe80::\\SECRET", "<path>::\\SECRET"],
    ["C:\\a%25::\\SECRET", "<path>::\\SECRET"],
    ["fooC:\\E::\\SECRET", "fooC:\\E::\\SECRET"],
    ["https://pub.test/a::\\q", "https://pub.test/a::\\q"],
    ["https://[::1]/secret", "https://[::1]/secret"],
    ["/p\\C:\\E::\\https://private.example/SECRET", "<path>\\<path>::\\https://private.example/SECRET"],
    ["/C:\\Users\\SECRET", "<path>"],
    ["/p\\D:\\E:\\SECRET", "<path>\\<path>"],
  ] as const)("preserves doubled-colon path rejection boundaries: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["'file://host'name/a'/C:\\Users\\SECRET\\private.db", "'file://host'name<path>'<path>"],
    ["'file://host'name/a'/c:\\Users\\SECRET\\private.db", "'file://host'name<path>'<path>"],
    ['"file://host\'name/a"/C:\\Users\\SECRET\\private.db', '"file://host\'name<path>"<path>'],
    ['"file://host\'name/a"/c:\\Users\\SECRET\\private.db', '"file://host\'name<path>"<path>'],
    ["/C:\\Users\\SECRET", "<path>"],
    ["/c:\\Users\\SECRET", "<path>"],
    ["/private/C:\\Users\\SECRET", "<path>"],
  ] as const)("redacts slash-prefixed Windows drives completely on the first pass: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["/AB:\\literal", "<path>:\\literal"],
    ["/1:\\literal", "<path>:\\literal"],
    ["/C:note\\literal", "<path>:note\\literal"],
    ["/C:/public", "<path>:<path>"],
  ] as const)("preserves non-drive colon boundaries after a POSIX span: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it("redacts a Windows drive following a bare POSIX path separately on the first pass", () => {
    const result = sanitizeError("/private\\D:\\SECRET");

    expect(result).toBe("<path>\\<path>");
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://remote.invalid[/Users/canary/one.db]/Users/canary/two.db",
      "file://remote.invalid[<path>]<path>",
    ],
    [
      "file://remote.invalid[[[/Users/canary/one.db]/Users/canary/two.db]/Users/canary/three.db]" +
        "/Users/canary/four.db",
      "file://remote.invalid[[[<path>]<path>]<path>]<path>",
    ],
    [
      "file://remote.invalid[[/Users/canary/one.db]]/Users/canary/two/deeper.db",
      "file://remote.invalid[[<path>]]<path>",
    ],
    [
      "file://remote.invalid[[[/Users/canary/one.db]]]/Users/canary/two/deeper.db",
      "file://remote.invalid[[[<path>]]]<path>",
    ],
    [
      "FILE://LOCALHOST[/Users/canary/one.db]/Users/canary/two.db",
      "FILE://LOCALHOST[<path>]<path>",
    ],
    [
      "file://[/Users/canary/one.db]/Users/canary/two.db",
      "file://[<path>]<path>",
    ],
    [
      "file://remote.invalid[/C:/Users/canary/one.db]/D:/Users/canary/two.db",
      "file://remote.invalid[<path>]<path>",
    ],
    [
      "file://remote.invalid[\\C:\\Users\\canary\\one.db]\\D:\\Users\\canary\\two.db",
      "file://remote.invalid[<path>]<path>",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]\\\\server\\share\\two.db",
      "file://remote.invalid[<path>]<path>",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]/Users/δοκιμή/file[2].db",
      "file://remote.invalid[<path>]<path>",
    ],
    [
      "file://remote.invalid[/Users/canary/file[1].db]/Users/canary/two.db",
      "file://remote.invalid[<path>]<path>",
    ],
  ] as const)("redacts adjacent post-bracket file paths in one pass: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["?", "https", "file://host.invalid?x=[label]/https://e.test/p", "file://host.invalid?x=[label]<path>"],
    ["?", "http", "file://host.invalid?x=[label]/http://e.test/p", "file://host.invalid?x=[label]<path>"],
    ["?", "ftp", "file://host.invalid?x=[label]/ftp://e.test/p", "file://host.invalid?x=[label]<path>"],
    ["#", "https", "file://host.invalid#x=[label]/https://e.test/p", "file://host.invalid#x=[label]<path>"],
    ["#", "http", "file://host.invalid#x=[label]/http://e.test/p", "file://host.invalid#x=[label]<path>"],
    ["#", "ftp", "file://host.invalid#x=[label]/ftp://e.test/p", "file://host.invalid#x=[label]<path>"],
  ] as const)(
    "converges slash-prefixed nested URLs after a balanced pathless %s bracket with %s: %#",
    (_marker, _scheme, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(first).not.toContain("://e.test/p");
      expect(sanitizeError(first)).toBe(expected);
      expect(sanitizeError(sanitizeError(first))).toBe(expected);
    },
  );

  it.each([
    ["?", "https", "file://host.invalid?x=[a/https://e.test/p]", "file://host.invalid?x=[a<path>]"],
    ["?", "http", "file://host.invalid?x=[a/http://e.test/p]", "file://host.invalid?x=[a<path>]"],
    ["?", "ftp", "file://host.invalid?x=[a/ftp://e.test/p]", "file://host.invalid?x=[a<path>]"],
    ["#", "https", "file://host.invalid#x=[a/https://e.test/p]", "file://host.invalid#x=[a<path>]"],
    ["#", "http", "file://host.invalid#x=[a/http://e.test/p]", "file://host.invalid#x=[a<path>]"],
    ["#", "ftp", "file://host.invalid#x=[a/ftp://e.test/p]", "file://host.invalid#x=[a<path>]"],
  ] as const)(
    "converges slash-prefixed nested URLs inside an open pathless %s bracket with %s: %#",
    (_marker, _scheme, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(first).not.toContain("://e.test/p");
      expect(sanitizeError(first)).toBe(expected);
      expect(sanitizeError(sanitizeError(first))).toBe(expected);
    },
  );

  it.each([
    [
      "file://host.invalid?x=label/https://e.test/p",
      "file://host.invalid?x=label/https://e.test/p",
    ],
    [
      "file://host.invalid#x=label/ftp://e.test/p",
      "file://host.invalid#x=label/ftp://e.test/p",
    ],
    [
      "file://host.invalid?x=[label]/Users/canary/private.db",
      "file://host.invalid?x=[label]<path>",
    ],
    [
      "file://host.invalid#x=[a/Users/canary/private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[label]/file://other.invalid/Users/canary/private.db",
      "file://host.invalid?x=[label]/file://other.invalid<path>",
    ],
    ["see /https://example.test/p", "see <path>"],
    [
      "file://host.invalid?x=[label]/https://e.test/p?a=b",
      "file://host.invalid?x=[label]<path>?a=b",
    ],
    [
      "file://host.invalid?x=[label]/HTTPS://EXAMPLE.TEST:8443/p",
      "file://host.invalid?x=[label]<path>",
    ],
  ] as const)("keeps #1111 URL and path boundaries: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(expected);
    expect(sanitizeError(sanitizeError(first))).toBe(expected);
  });

  it.each([
    [
      "file://remote.invalid[/Users/canary/one.db]?next=/Users/canary/two.db",
      "file://remote.invalid[<path>]?next=/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]#next=/Users/canary/two.db",
      "file://remote.invalid[<path>]#next=/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]&next=/Users/canary/two.db",
      "file://remote.invalid[<path>]&next=/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]=prefix/Users/canary/two.db",
      "file://remote.invalid[<path>]=prefix/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db]x/Users/canary/two.db",
      "file://remote.invalid[<path>]x/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db].then/Users/canary/two.db",
      "file://remote.invalid[<path>].then/Users/canary/two.db",
    ],
    [
      "file://remote.invalid[/Users/canary/one.db], then /Users/canary/two.db",
      "file://remote.invalid[<path>], then <path>",
    ],
    [
      "'file://remote.invalid[/Users/canary/one.db]/Users/canary/two.db'",
      "'file://remote.invalid[<path>'",
    ],
  ] as const)("preserves post-bracket compatibility boundaries: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    [
      "file://host[/private]?next=[label]/https://public.test/x",
      "file://host[<path>]?next=[label]/https://public.test/x",
    ],
    [
      "file://host[/private]#next=[label]/https://public.test/x",
      "file://host[<path>]#next=[label]/https://public.test/x",
    ],
    [
      "file://host[/private]&next=[label]/https://public.test/x",
      "file://host[<path>]&next=[label]/https://public.test/x",
    ],
    [
      "file://host[/private]=next=[label]/https://public.test/x",
      "file://host[<path>]=next=[label]/https://public.test/x",
    ],
    [
      "file://host[/private]x[/label]/https://public.test/x",
      "file://host[<path>]x[/label]/https://public.test/x",
    ],
    [
      "file://host/private?next=[label]/https://public.test/x",
      "file://host<path>?next=[label]/https://public.test/x",
    ],
    [
      "file://host/private#next=[label]/https://public.test/x",
      "file://host<path>#next=[label]/https://public.test/x",
    ],
    [
      "file://host/private&next=[label]/https://public.test/x",
      "file://host<path>&next=[label]/https://public.test/x",
    ],
    [
      "file://host/private=next=[label]/https://public.test/x",
      "file://host<path>=next=[label]/https://public.test/x",
    ],
  ] as const)("preserves non-file URL tails after unrelated brackets: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    [
      "https://outer.test/x?file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x#file://host.invalid/Users/canary/private.db",
      "https://outer.test/x#file://host.invalid<path>",
    ],
    [
      "https://outer.test/x#next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x#next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x&file://host.invalid/Users/canary/private.db",
      "https://outer.test/x&file://host.invalid<path>",
    ],
    [
      "https://outer.test/x&next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x&next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x=next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x=next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?next=FiLe://host.invalid/Users/canary/private.db",
      "https://outer.test/x?next=FiLe://host.invalid<path>",
    ],
    [
      "https://outer.test/x?next=file:///Users/canary/private.db",
      "https://outer.test/x?next=file://<path>",
    ],
    [
      "https://outer.test/x?next=file://localhost/Users/canary/private.db",
      "https://outer.test/x?next=file://localhost<path>",
    ],
    [
      "https://outer.test/x?next=file://host.invalid/C:/Users/canary/private.db",
      "https://outer.test/x?next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?next=file://host.invalid/C:\\Users\\canary\\private.db",
      "https://outer.test/x?next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?next=file://[fe80::1%25eth0]/Users/canary/private.db",
      "https://outer.test/x?next=file://[fe80::1%25eth0]<path>",
    ],
    [
      "https://outer.test/x?next=file://remote.invalid[/Users/canary/private.db",
      "https://outer.test/x?next=file://remote.invalid[<path>",
    ],
    [
      "https://outer.test/[unterminated?next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/[unterminated?next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?a=file://one.invalid/Users/canary/one.db&b=file://two.invalid/Users/canary/two.db",
      "https://outer.test/x?a=file://one.invalid<path>&b=file://two.invalid<path>",
    ],
    [
      "file://outer.invalid/Users/canary/outer.db?next=file://inner.invalid/Users/canary/inner.db",
      "file://outer.invalid<path>?next=file://inner.invalid<path>",
    ],
    [
      "https://outer.test/x?next='file://host.invalid/Users/canary/My Files/private.db'",
      "https://outer.test/x?next='file://host.invalid<path>'",
    ],
    [
      'https://outer.test/x?next="file://host.invalid/Users/canary/My Files/private.db"',
      'https://outer.test/x?next="file://host.invalid<path>"',
    ],
    [
      "https://outer.test/x?next=file://host;name,other'part)tail}/Users/canary/private.db",
      "https://outer.test/x?next=file://host;name,other'part)tail}<path>",
    ],
    [
      "https://outer.test/x?next=file://host;name[/Users/canary/private.db",
      "https://outer.test/x?next=file://host;name[<path>",
    ],
    [
      'https://outer.test/x?next="file://host\'name/My Files/private.db"',
      'https://outer.test/x?next="file://host\'name<path>"',
    ],
    [
      "https://outer.test/x?next=prefix-file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?next=prefix-file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=[a=b]file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?q=[a=b]file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=(file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?q=(file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=1file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?q=1file://host.invalid<path>",
    ],
    [
      "https://outer.test/x#q=1file://host.invalid/Users/canary/private.db",
      "https://outer.test/x#q=1file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=(FiLe://host.invalid/Users/canary/private.db",
      "https://outer.test/x?q=(FiLe://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=1FILE://HOST.INVALID/Users/canary/private.db",
      "https://outer.test/x?q=1FILE://HOST.INVALID<path>",
    ],
    [
      "https://outer.test/x?q=1file:///Users/canary/private.db",
      "https://outer.test/x?q=1file://<path>",
    ],
    [
      "https://outer.test/x?q=1file://localhost/Users/canary/private.db",
      "https://outer.test/x?q=1file://localhost<path>",
    ],
    [
      "https://outer.test/x?q=1file://[fe80::1%25eth0]/Users/canary/private.db",
      "https://outer.test/x?q=1file://[fe80::1%25eth0]<path>",
    ],
    [
      "https://outer.test/x?q=1file://host.invalid/C:\\Users\\canary\\private.db",
      "https://outer.test/x?q=1file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=1'file://host.invalid/Users/canary/My Files/x'",
      "https://outer.test/x?q=1'file://host.invalid<path>'",
    ],
    [
      "https://outer.test/x?a=1file://one.invalid/Users/canary/one.db&b=(file://two.invalid/Users/canary/two.db",
      "https://outer.test/x?a=1file://one.invalid<path>&b=(file://two.invalid<path>",
    ],
    [
      "file://outer.invalid/Users/canary/outer.db?q=1file://inner.invalid/Users/canary/inner.db",
      "file://outer.invalid<path>?q=1file://inner.invalid<path>",
    ],
    [
      "https://outer.test/x?q=0123456789012345678901234567890123456789012345678901234567890123file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?q=0123456789012345678901234567890123456789012345678901234567890123file://host.invalid<path>",
    ],
    [
      "https://a.test/x?z=1 then https://outer.test/y?q=(file://host.invalid/Users/canary/private.db",
      "https://a.test/x?z=1 then https://outer.test/y?q=(file://host.invalid<path>",
    ],
    [
      "https://outer.test/x?q=1file://host.invalid/Users/canary/private.db https://b.test/y?z=1",
      "https://outer.test/x?q=1file://host.invalid<path> https://b.test/y?z=1",
    ],
  ] as const)("redacts nested file URL paths: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "https://outer.test/x?q=file://h.invalid/Users/a-file://h2.invalid/Users/b",
      "https://outer.test/x?q=file://h.invalid<path>file://h2.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/a-file://two.invalid/Users/b-file://three.invalid/Users/c",
      "https://outer.test/x?q=file://one.invalid<path>file://two.invalid<path>file://three.invalid<path>",
    ],
    [
      "https://outer.test/x#q=FiLe://one.invalid/Users/a-FILE://two.invalid/Users/b",
      "https://outer.test/x#q=FiLe://one.invalid<path>FILE://two.invalid<path>",
    ],
    [
      "https://outer.test?q=file://one.invalid/C:\\Users\\a-file://two.invalid/C:\\Users\\b",
      "https://outer.test?q=file://one.invalid<path>file://two.invalid<path>",
    ],
    [
      "https://outer.test?q=file://one.invalid\\\\server\\share\\a-file://two.invalid\\\\server\\share\\b",
      "https://outer.test?q=file://one.invalid<path>file://two.invalid<path>",
    ],
    [
      "file://outer.invalid?q=file://one.invalid/Users/a-file://two.invalid/Users/b",
      "file://outer.invalid?q=file://one.invalid<path>file://two.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://[fe80::1%25eth0]/Users/a-file://[::1]/Users/b",
      "https://outer.test/x?q=file://[fe80::1%25eth0]<path>file://[::1]<path>",
    ],
  ] as const)("preserves adjacent recognized file URL schemes across sanitizer passes: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it.each([
    [
      "https://outer.test/x?q=file://one.invalid//file://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid//file://two.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/file://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid/file://two.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/-file://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>file://two.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file:///file://two.invalid/Users/b",
      "https://outer.test/x?q=file:///file://two.invalid<path>",
    ],
  ] as const)("preserves root-only spans before adjacent recognized file URL schemes: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each(["-", "1", "(", "[", ".", "_", "@", "+", "~", "%", "$", "*"] as const)(
    "absorbs recognized file URL glue into the preceding redacted path: %s",
    (glue) => {
      const input = `https://outer.test/x?q=file://one.invalid/Users/a${glue}file://two.invalid/Users/b`;
      const expected = "https://outer.test/x?q=file://one.invalid<path>file://two.invalid<path>";
      const result = sanitizeError(input);

      expect(result).toBe(expected);
      expect(sanitizeError(result)).toBe(result);
    },
  );

  it.each([
    [
      "https://outer.test/x?q='file://one.invalid/Users/a-file://two.invalid/Users/b'",
      "https://outer.test/x?q='file://one.invalid<path>'",
    ],
    [
      'https://outer.test/x?q="file://one.invalid/Users/a-file://two.invalid/Users/b"',
      'https://outer.test/x?q="file://one.invalid<path>"',
    ],
    [
      "https://outer.test/x?q='file://one.invalid/Users/a-file://two.invalid/Users/b",
      "https://outer.test/x?q='file://one.invalid<path>",
    ],
  ] as const)("retains quoted scanning across adjacent file URL markers: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  // Bug #1117 absorbs an adjacent literal file suffix only after an unquoted
  // confidential path scan has started. Non-file suffixes remain independent.
  it.each([
    [
      "file://one.invalid/Users/a-file://two.invalid/Users/b",
      "file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/afile://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/aprofile://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/a-profile://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/afile://two.invalid\\Users\\b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
  ] as const)("absorbs adjacent literal file suffixes into active paths: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it.each([
    [
      "https://outer.test/x?q=file://one.invalid/Users/ahttps://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/a-https://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
  ] as const)("absorbs adjacent non-file scheme components into active paths: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
  });

  it.each([
    [
      "https://outer.test/x?q=file://h.invalid/Users/afile://h2.invalid/Users/b",
      "https://outer.test/x?q=file://h.invalid<path>",
    ],
    [
      "file://host.invalid?x=a\\Users\\a-file://h2.invalid/Users/b",
      "file://host.invalid?x=a<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/aFILE://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/aFiLe://two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    [
      "https://outer.test/x?q=file://one.invalid/Users/afile://two.invalid/Users/cfile://three.invalid/Users/d",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    ["failed C:\\Users\\a\\afile://two.invalid/Users/b", "failed <path>"],
    ["failed \\\\server\\share\\afile://two.invalid/Users/b", "failed <path>"],
    ["failed /Users/aliceprofile://two.invalid/Users/b", "failed <path>"],
  ] as const)("converges adjacent file suffix path canaries: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(firstPass).not.toContain("/Users");
    expect(firstPass.match(/<path>/g)).toHaveLength(1);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it.each([
    "two.invalid:8080/Users/b",
    "[fe80::1]/Users/b",
    "[fe80::1]:8080/Users/b",
    "[fe80::1%25eth0]/Users/b",
    "u:p@two.invalid:99/Users/b",
  ] as const)("absorbs adjacent file authority shape %s", (tail) => {
    const input = `https://outer.test/x?q=file://one.invalid/Users/afile://${tail}`;
    const expected = "https://outer.test/x?q=file://one.invalid<path>";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(firstPass).not.toContain("/Users");
    expect(firstPass.match(/<path>/g)).toHaveLength(1);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it("absorbs a parenthesized adjacent file authority", () => {
    const input = "(file://one.invalid/Users/afile://two.invalid:80/Users/b)";
    const expected = "(file://one.invalid<path>)";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(firstPass).not.toContain("/Users");
    expect(firstPass.match(/<path>/g)).toHaveLength(1);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it.each([
    ["two.invalid trailing text", " trailing text"],
    ["two.invalid\ttrailing text", "\ttrailing text"],
    ["two.invalid\ntrailing text", "\ntrailing text"],
    ["two.invalid\rtrailing text", "\rtrailing text"],
    ["two.invalid,tail", ",tail"],
    ["two.invalid]tail", "]tail"],
    ['two.invalid"tail', '"tail'],
    ["two.invalid", ""],
    ["", ""],
    ["/", ""],
  ] as const)("stops adjacent file authority at its bounded terminator: %#", (tail, preserved) => {
    const input = `https://outer.test/x?q=file://one.invalid/Users/afile://${tail}`;
    const expected = `https://outer.test/x?q=file://one.invalid<path>${preserved}`;
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it("hands a recognized nested file marker off after an authority delimiter", () => {
    const input =
      "https://outer.test/x?q=file://one.invalid/Users/afile://h1.invalid?x=file://h2.invalid/Users/c";
    const expected =
      "https://outer.test/x?q=file://one.invalid<path>?x=file://h2.invalid<path>";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(firstPass).not.toContain("/Users");
    expect(firstPass.match(/<path>/g)).toHaveLength(2);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it.each(["-", "1", "[", ".", "_", "@", "+", "~", "%", "$", "*", ":"] as const)(
    "preserves an authority-internal nested file marker after %s glue",
    (glue) => {
      const input =
        `https://outer.test/x?q=file://one.invalid/Users/afile://h1.invalid${glue}` +
        "file://h2.invalid/Users/b";
      const expected =
        "https://outer.test/x?q=file://one.invalid<path>file://h2.invalid<path>";
      const firstPass = sanitizeError(input);

      expect(firstPass).toBe(expected);
      expect(firstPass).not.toContain("/Users");
      expect(firstPass.match(/<path>/g)).toHaveLength(2);
      expect(sanitizeError(firstPass)).toBe(expected);
      expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
    },
  );

  it("keeps a word-glued private-looking tail beyond an ordinary authority delimiter", () => {
    const input =
      "https://outer.test/x?q=file://one.invalid/Users/afile://h]tail/Users/b";
    const expected =
      "https://outer.test/x?q=file://one.invalid<path>]tail/Users/b";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it("resumes active path scanning at an opening parenthesis after an authority", () => {
    const input =
      "https://outer.test/x?q=file://one.invalid/Users/afile://h(tail/Users/b";
    const expected = "https://outer.test/x?q=file://one.invalid<path>";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(firstPass).not.toContain("/Users");
    expect(sanitizeError(firstPass)).toBe(expected);
    expect(sanitizeError(sanitizeError(firstPass))).toBe(expected);
  });

  it("preserves recognized nested file handoff with a port", () => {
    const input =
      "https://outer.test/x?q=file://one.invalid/Users/a-file://two.invalid:8080/Users/b";
    const expected =
      "https://outer.test/x?q=file://one.invalid<path>file://two.invalid:8080<path>";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it("retains quoted scanning across a glued file authority with a port", () => {
    const input =
      "https://outer.test/x?q='file://one.invalid/Users/afile://two.invalid:8080/Users/b'";
    const expected = "https://outer.test/x?q='file://one.invalid<path>'";
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it.each([
    [
      "profile://remote.invalid/Users/canary/private.db",
      "profile://remote.invalid/Users/canary/private.db",
    ],
    ["afile://remote.invalid/Users/canary/private.db", "afile://remote.invalid/Users/canary/private.db"],
    ["xfile://remote.invalid/Users/canary/private.db", "xfile://remote.invalid/Users/canary/private.db"],
    [
      "file://host.invalid?next=afile://remote.invalid/Users/canary/private.db",
      "file://host.invalid?next=afile://remote.invalid/Users/canary/private.db",
    ],
    [
      "profile://localhost/Users/canary/private.db",
      "profile://localhost<path>",
    ],
    [
      "https://outer.test/x?q=https://one.invalid/Users/afile://two.invalid/Users/b",
      "https://outer.test/x?q=https://one.invalid/Users/afile://two.invalid/Users/b",
    ],
  ] as const)("preserves ordinary URL classification around file suffixes: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it.each([
    ["file://one.invalid/Users/afile:/two.invalid/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/C:/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/c:\\Users\\b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/aFiLe:/two.invalid/Users/b", "file://one.invalid<path>"],
    ["C:\\Users\\afile:/two.invalid/Users/b", "<path>"],
    ["/Users/afile:/two.invalid/Users/b", "<path>"],
    ["file://one.invalid/Users/afile:/two.invalid/Users/b trailing prose", "file://one.invalid<path> trailing prose"],
    [
      "https://outer.test/x?q=file://one.invalid/Users/afile:/two.invalid/Users/b",
      "https://outer.test/x?q=file://one.invalid<path>",
    ],
    ["file://host.invalid?x=a\\Users\\a-file:/h2.invalid/Users/b", "file://host.invalid?x=a<path>"],
    ["file://one.invalid/Users/afile:/https://public.test/x", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/two/bfile:/three/Users/c", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/C:/Users/bfile:/D:/Users/c", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/1:/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/Ç:/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/aprofile:/two.invalid/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/a-profile:/two.invalid/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/two.invalid:8080/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/two.invalid/Users/b?x=1", "file://one.invalid<path>?x=1"],
    ["file://one.invalid/Users/afile:/two.invalid/Users/b#frag", "file://one.invalid<path>#frag"],
    ["file://one.invalid/Users/afile:/two.invalid/Users/b&x=1", "file://one.invalid<path>&x=1"],
    ["file://one.invalid/Users/afile:/file://two.invalid/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/E::\\SECRET", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:/ two.invalid/Users/b", "file://one.invalid<path> two.invalid/Users/b"],
    ["file://one.invalid/Users/afile:/D|/Users/b", "file://one.invalid<path>|<path>"],
  ] as const)("redacts single-slash file continuations in one pass: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    ["https://one.invalid/Users/afile:/two.invalid/Users/b", "https://one.invalid/Users/afile:/two.invalid/Users/b"],
    ["https://one.invalid/x?q=file:/Users/private.db", "https://one.invalid/x?q=file:/Users/private.db"],
    ["profile://one.invalid/Users/afile:/two.invalid/Users/b", "profile://one.invalid/Users/afile:/two.invalid/Users/b"],
    ["afile:/two.invalid/Users/b", "afile:<path>"],
    ["file:/Users/b", "file:<path>"],
    ["file://one.invalid/Users/afile://two.invalid/Users/b", "file://one.invalid<path>"],
    ["file://one.invalid/Users/afile:two.invalid/Users/b", "file://one.invalid<path>:two.invalid/Users/b"],
    ["'file://one.invalid/Users/afile:/two.invalid/Users/b'", "'file://one.invalid<path>'"],
    ["'C:\\Users\\afile:/My Files/private.db'", "'<path>'"],
    ["file://one.invalid/Users/afile:", "file://one.invalid<path>:"],
    ["/C:/public", "<path>:<path>"],
  ] as const)("preserves single-slash file continuation boundaries: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
  });

  it.each([
    [
      "file://host.invalid?x=https://example.test/p",
      "file://host.invalid?x=https://example.test/p",
    ],
    [
      "file://host.invalid#x=https://example.test/p",
      "file://host.invalid#x=https://example.test/p",
    ],
    [
      "file://host.invalid?next=profile://remote.invalid/Users/canary/private.db",
      "file://host.invalid?next=profile://remote.invalid/Users/canary/private.db",
    ],
    [
      "file://host.invalid#next=profile://remote.invalid/Users/canary/private.db",
      "file://host.invalid#next=profile://remote.invalid/Users/canary/private.db",
    ],
    [
      "file://host.invalid?next=xfile://remote.invalid/Users/canary/private.db",
      "file://host.invalid?next=xfile://remote.invalid/Users/canary/private.db",
    ],
    [
      "file://host.invalid#next=xfile://remote.invalid/Users/canary/private.db",
      "file://host.invalid#next=xfile://remote.invalid/Users/canary/private.db",
    ],
    [
      "file://host.invalid?x=https://example.test/p, /Users/canary/private.db",
      "file://host.invalid?x=https://example.test/p, <path>",
    ],
  ] as const)("preserves nested non-file URLs after unquoted pathless file URL delimiters: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["file://host.invalid?x=/Users/canary/private.db", "file://host.invalid?x=<path>"],
    ["file://host.invalid?/Users/canary/private.db", "file://host.invalid?<path>"],
    ["file://host.invalid#/Users/canary/private.db", "file://host.invalid#<path>"],
    [
      "file://host.invalid?x=y#z=/Users/canary/private.db",
      "file://host.invalid?x=y#z=<path>",
    ],
    ["file://localhost?/Users/canary/private.db", "file://localhost?<path>"],
    [
      "file://[fe80::1%25eth0]?x=/Users/canary/private.db",
      "file://[fe80::1%25eth0]?x=<path>",
    ],
    ["file://host.invalid?x=[/Users/canary/private.db]", "file://host.invalid?x=[<path>]"],
    [
      "file://remote.invalid[<path>]?next=/Users/canary/two.db",
      "file://remote.invalid[<path>]?next=<path>",
    ],
    [
      "file://host.invalid?x=C:\\Users\\canary\\private.db",
      "file://host.invalid?x=<path>",
    ],
    [
      "file://host.invalid?x=\\\\server\\share\\private.db",
      "file://host.invalid?x=<path>",
    ],
    [
      "file://host.invalid?x='/Users/canary/My Files/x'",
      "file://host.invalid?x='<path>'",
    ],
    [
      "file://host.invalid?file:///Users/canary/private.db",
      "file://host.invalid?file://<path>",
    ],
    [
      "file://host.invalid#file:///Users/canary/private.db",
      "file://host.invalid#file://<path>",
    ],
    [
      "file://host.invalid?FiLe:///Users/canary/private.db",
      "file://host.invalid?FiLe://<path>",
    ],
  ] as const)("redacts paths after unquoted pathless file URL delimiters: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://host.invalid?x=[a]\\Users\\canary\\private.db",
      "file://host.invalid?x=[a]<path>",
    ],
    [
      "file://host.invalid#x=[a]\\Users\\canary\\private.db",
      "file://host.invalid#x=[a]<path>",
    ],
    [
      "file://host.invalid?x=[a/Users/canary/private.db",
      "file://host.invalid?x=[a<path>",
    ],
    [
      "file://host.invalid#x=[a/Users/canary/private.db",
      "file://host.invalid#x=[a<path>",
    ],
    [
      "file://[fe80::1%25eth0]?x=[a/Users/canary/private.db",
      "file://[fe80::1%25eth0]?x=[a<path>",
    ],
    [
      "file://host.invalid?x=[[a/Users/canary/private.db]]",
      "file://host.invalid?x=[[a<path>]]",
    ],
    [
      "file://host.invalid#x=[a]C:\\Users\\canary\\private.db",
      "file://host.invalid#x=[a]<path>",
    ],
    [
      "file://host.invalid?x=[[a]]\\\\server\\share\\private.db",
      "file://host.invalid?x=[[a]]<path>",
    ],
    [
      "file://host.invalid?x=[a]b\\Users\\canary\\private.db",
      "file://host.invalid?x=[a]b<path>",
    ],
    [
      "file://host.invalid#x=[a][b]\\Users\\canary\\private.db",
      "file://host.invalid#x=[a][b]<path>",
    ],
    [
      "file://host.invalid?x=[[a]]\\Users\\canary\\private.db",
      "file://host.invalid?x=[[a]]<path>",
    ],
    [
      "file://host.invalid?x=[a/b]\\Users\\canary\\private.db",
      "file://host.invalid?x=[a<path>]<path>",
    ],
    [
      "file://host.invalid#x=[a]\\Users\\canary\\private.db]tail",
      "file://host.invalid#x=[a]<path>]tail",
    ],
  ] as const)("redacts restarted pathless file URL bracket tails: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://host.invalid?x=[a]b/Users/canary/private.db",
      "file://host.invalid?x=[a]b/Users/canary/private.db",
    ],
    [
      "file://host.invalid#x=value]\\Users\\canary\\private.db",
      "file://host.invalid#x=value]\\Users\\canary\\private.db",
    ],
    [
      "file://host.invalid?x=[https://y.test/p]/Users/canary/z",
      "file://host.invalid?x=[https://y.test/p]<path>",
    ],
    [
      "file://host.invalid#x=[a]https://example.test/p",
      "file://host.invalid#x=[a]https://example.test/p",
    ],
    [
      "file://host.invalid?q=[a=b]prefix-file://host.invalid/Users/canary/private.db",
      "file://host.invalid?q=[a=b]prefix-file://host.invalid<path>",
    ],
    [
      "file://host.invalid?x=[next=file://inner.invalid/Users/canary/private.db",
      "file://host.invalid?x=[next=file://inner.invalid<path>",
    ],
    [
      "file://host.invalid#q=prefix-file://host.invalid/Users/canary/private.db",
      "file://host.invalid#q=prefix-file://host.invalid<path>",
    ],
    [
      "file://host.invalid?x=[10/20]rate",
      "file://host.invalid?x=[10<path>]rate",
    ],
    [
      "file://host.invalid#x=[a/b]https://example.test/p",
      "file://host.invalid#x=[a<path>]https://example.test/p",
    ],
  ] as const)("enforces restarted pathless file URL bracket boundaries: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    ["file://h?x=/a:[/\\]", "file://h?x=<path>:[<path>]"],
    ["file://h#x=/a:[/\\\\]", "file://h#x=<path>:[<path>]"],
    ["file://h?x=[word/\\]", "file://h?x=[word<path>]"],
    ["file://h#x=[-/\\\\]", "file://h#x=[-<path>]"],
    ["file://h?x=[/]", "file://h?x=[<path>]"],
    [
      "file://h#x=[/C:\\Users\\canary\\private.db]",
      "file://h#x=[<path>]",
    ],
    [
      "file://h?x=[/c:/Users/canary/private.db]",
      "file://h?x=[<path>]",
    ],
    [
      "file://h?x=[/\\\\server\\share\\private.db]",
      "file://h?x=[<path>]",
    ],
    [
      "file://h#x=[/Users/canary/private.db]",
      "file://h#x=[<path>]",
    ],
  ] as const)("redacts forced bracket paths in one stable pass: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it.each([
    [
      "file://host.invalid?x=[a/\\C:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[-/\\C:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[-<path>]",
    ],
    [
      "file://host.invalid?x=[/\\C:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[<path>]",
    ],
    [
      "file://host.invalid#x=[a/\\c:/Users/canary/private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a//C:/Users/canary/private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a//\\server\\share\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/\\/server\\share\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/\\C:\\Users\\canary\\private.db",
      "file://host.invalid?x=[a<path>",
    ],
    [
      "file://host.invalid#x=[a/\\C:\\Users\\canary\\private.db]tail",
      "file://host.invalid#x=[a<path>]tail",
    ],
  ] as const)("redacts forced mixed-separator paths in one stable pass: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  // Bug #1156 keeps this promotion inside an already-admitted forced scan.
  // The canonical and slash forms are clean at the parent as two spans; the
  // one-span result pins the same bounded transition as the numeric and
  // non-ASCII forms whose backslash tails leak at the parent.
  it.each([
    [
      "file://host.invalid?x=[a/b/\\C:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\Ç:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a/b/\\C:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a/b/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a/b/\\Ç:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\c:/Users/canary/private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\1:/Users/canary/private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\Ç:/Users/canary/private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/\\Ç:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid#x=[a/\\Ç:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\C:\\Users\\canary\\private.db",
      "file://host.invalid?x=[a<path>",
    ],
    [
      "file://host.invalid?x=[a/b/\\1:\\Users\\canary\\private.db",
      "file://host.invalid?x=[a<path>",
    ],
    [
      "file://host.invalid?x=[a/b/\\Ç:\\Users\\canary\\private.db",
      "file://host.invalid?x=[a<path>",
    ],
    [
      "file://host.invalid?x=[a/b/\\@:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    [
      "file://host.invalid?x=[a/b/\\1:\\Users\\canary\\private.db https://public.test/x",
      "file://host.invalid?x=[a<path> https://public.test/x",
    ],
  ] as const)("redacts forced drive continuations after earlier content: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  it.each([
    [
      "file://host.invalid?x=[a/b/\\!:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>!:\\Users\\canary\\private.db]",
    ],
    [
      "file://host.invalid?x=[a/b/\\AB:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>:\\Users\\canary\\private.db]",
    ],
    [
      "file://host.invalid?x=[a/b/\\12:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>:\\Users\\canary\\private.db]",
    ],
    [
      "file://host.invalid?x=[a/b/\\C:note\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>:note\\Users\\canary\\private.db]",
    ],
    [
      "file://host.invalid?x=[a/b/\\C\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
    ],
    ["file://host.invalid?x=[a/b/\\C:]", "file://host.invalid?x=[a<path>:]"],
    ["file://host.invalid?x=[a/b/\\1:", "file://host.invalid?x=[a<path>:"],
    ["/p\\C:\\E::\\SECRET", "<path>\\<path>"],
  ] as const)("preserves forced drive continuation boundaries: %#", (input, expected) => {
    const firstPass = sanitizeError(input);

    expect(firstPass).toBe(expected);
    expect(sanitizeError(firstPass)).toBe(expected);
  });

  // Bug #1234 extends the admitted continuation grammar to the zero-label form.
  it("redacts the empty-label forced continuation for Bug #1234", () => {
    const input = "file://host.invalid?x=[a/\\:\\Users\\canary\\private.db]";
    const expected = "file://host.invalid?x=[a<path>]";

    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  // Leading file-path starts use a distinct classifier from Bug #1156's
  // forced-scan-only transition. The S8 continuation repair covers both seams.
  it.each([
    [
      "file://host.invalid?x=[\\1:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[<path>]",
    ],
    [
      "file://host.invalid?x=[\\Ç:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[<path>]",
    ],
  ] as const)("redacts leading drive-like continuations in one pass: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  // Bug #1111's historical nested-HTTPS row now follows the same span-local
  // scheme-colon rule as Bugs #1243 and #1246.
  it("converges the historical nested HTTPS row for Bug #1111", () => {
    const first = sanitizeError("file://host.invalid?x=[a/b/https://public.test/p]");

    expect(first).toBe("file://host.invalid?x=[a<path>]");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  const sanitizerS8CanonicalCases = [
    [
      1228,
      "'file://host'['/private']|https://[fe80::1]/x",
      "'file://host'['<path>']|https://[fe80::1]/x",
      ["/private"],
    ],
    [
      1234,
      "file://host.invalid?x=[a/\\:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
      ["Users", "canary", "private.db"],
    ],
    [
      1234,
      "file://host.invalid#x=[a/\\:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
      ["Users", "canary", "private.db"],
    ],
    [
      1236,
      "file://host.invalid?x=[a\\b/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid?x=[a<path>]",
      ["Users", "canary", "private.db"],
    ],
    [
      1236,
      "file://host.invalid#x=[a\\b/\\1:\\Users\\canary\\private.db]",
      "file://host.invalid#x=[a<path>]",
      ["Users", "canary", "private.db"],
    ],
    [
      1239,
      "'file://h'['/private']?a/Users/alice/notes&b/Users/bob/secret.db",
      "'file://h'['<path>']?a<path>&b<path>",
      ["Users", "alice", "notes", "bob", "secret.db"],
    ],
    [1243, "/Users/a/https://e.test/p", "<path>", ["e.test"]],
    [1243, "/Users/a//https://e.test/p", "<path>", ["e.test"]],
    [1243, "/1https://e.test/p", "<path>", ["e.test"]],
    [1243, "//https://e.test/p", "<path>", ["e.test"]],
    [
      1246,
      "file://host.invalid?x=[a|\\https://y.test/p\\Users\\canary\\private.db",
      "file://host.invalid?x=[a|<path>",
      ["y.test", "Users", "canary", "private.db"],
    ],
    [
      1246,
      "file://host.invalid?x=a\\https://y.test/p\\Users\\canary\\private.db",
      "file://host.invalid?x=a<path>",
      ["y.test", "Users", "canary", "private.db"],
    ],
    [
      1260,
      "file://h?x=[https://[::1]#f]\\Users\\fictional.db",
      "file://h?x=[https://[::1]#f]<path>",
      ["fictional.db"],
    ],
    [
      1261,
      "file://h?x=[a]\\1:\\Users\\fictional.db",
      "file://h?x=[a]<path>",
      ["Users", "fictional.db"],
    ],
    [
      1261,
      "file://h?x=[https://[::1]/p]\\1:\\Users\\fictional.db",
      "file://h?x=[https://[::1]/p]<path>",
      ["Users", "fictional.db"],
    ],
    [
      1263,
      "file://h/p?x=[[a]/b]\\Users\\fictional.db",
      "file://h<path>?x=[[a]<path>]<path>",
      ["fictional.db"],
    ],
    [
      1263,
      "file://h/p?x=[[a]/https://example.test/t]\\Users\\fictional.db",
      "file://h<path>?x=[[a]<path>]<path>",
      ["example.test", "fictional.db"],
    ],
    [
      1263,
      "file://h/p?x=[[a]/http://example.test/t]\\Users\\fictional.db",
      "file://h<path>?x=[[a]<path>]<path>",
      ["example.test", "fictional.db"],
    ],
    [
      1263,
      "file://h/p?x=[[[a]]/https://example.test/t]\\Users\\fictional.db",
      "file://h<path>?x=[[[a]]<path>]<path>",
      ["example.test", "fictional.db"],
    ],
  ] as const;

  it.each(sanitizerS8CanonicalCases)(
    "redacts S8 issue #%i private spans in one stable pass: %#",
    (_issue, input, expected, absent) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      for (const privateFragment of absent) expect(first).not.toContain(privateFragment);
      expect(second).toBe(first);
      expect(third).toBe(first);
    },
  );

  it.each([
    [
      "'file://host'['/private']|https://[fe80::1]:443/x?q=1",
      "'file://host'['<path>']|https://[fe80::1]:443/x?q=1",
    ],
    [
      "'file://host'['/private'],https://[fe80::1]:443/x?q=1",
      "'file://host'['<path>'],https://[fe80::1]:443/x?q=1",
    ],
    [
      "'file://host'['/private'];http://[2001:db8::1]:8080/public/path?q=1",
      "'file://host'['<path>'];http://[2001:db8::1]:8080/public/path?q=1",
    ],
    ["http://[2001:db8::1]/public/path", "http://[2001:db8::1]/public/path"],
    [
      "'file://host'['/private'] https://[fe80::1]/x",
      "'file://host'['<path>'] https://[fe80::1]/x",
    ],
  ] as const)("keeps S8 quoted-file public URL boundaries: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
  });

  // GitHub review thread 4011654853 keeps the direct ampersand form outside
  // the quoted-query public-URL reset introduced for Bug #1239.
  it("keeps a direct quoted-wrapper ampersand URL conservative across passes", () => {
    const input = "'file://host'['/private']&https://example.test/p";
    const expected = "'file://host'['<path>']&https:<path>";
    const first = sanitizeError(input);
    const second = sanitizeError(first);
    const third = sanitizeError(second);

    expect(first).toBe(expected);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it.each([
    ["file://h?x=[a]\\C:\\Users\\fictional.db", "file://h?x=[a]<path>"],
    ["file://h?x=[a]\\1:\\Users\\fictional.db", "file://h?x=[a]<path>"],
    ["file://h?x=[a]\\Ç:\\Users\\fictional.db", "file://h?x=[a]<path>"],
    ["file://h?x=[a]\\\\1:\\Users\\fictional.db", "file://h?x=[a]<path>"],
    [
      "file://h?x=[a]\\!:\\Users\\fictional.db",
      "file://h?x=[a]\\!:\\Users\\fictional.db",
    ],
    [
      "file://h?x=[a]\\AB:\\Users\\fictional.db",
      "file://h?x=[a]<path>:\\Users\\fictional.db",
    ],
    [
      "file://h?x=[a]\\12:\\Users\\fictional.db",
      "file://h?x=[a]<path>:\\Users\\fictional.db",
    ],
    [
      "file://h?x=[a]\\C:note\\Users\\fictional.db",
      "file://h?x=[a]<path>:note\\Users\\fictional.db",
    ],
  ] as const)("keeps S8 post-wrapper drive grammar narrow: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "'file://h'['/private']?a/Users/alice&https://example.test/x",
      "'file://h'['<path>']?a<path>&https://example.test/x",
    ],
    [
      "'file://h'['/private']?a/Users/alice&file://two.invalid/Users/b",
      "'file://h'['<path>']?a<path>&file://two.invalid<path>",
    ],
    ["/Users/a/https://e.test/p | https://public.test/x", "<path> | https://public.test/x"],
    ["'/Users/a/https://e.test/p'", "'<path>'"],
    ["/Users/a/file://nested.invalid/p", "<path>"],
    ["/Users/a/file:/nested/p", "<path>"],
    [
      "file://h/p?x=[https://example.test/t]",
      "file://h<path>?x=[https://example.test/t]",
    ],
    ["file://h/p?x=plain", "file://h<path>?x=plain"],
  ] as const)("keeps S8 public and nested span boundaries: %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "'file://host.invalid?x=/Users/canary/My Files/x'",
      "'file://host.invalid?x=<path>'",
    ],
    [
      "'file://host.invalid#x=/Users/canary/My Files/x'",
      "'file://host.invalid#x=<path>'",
    ],
    [
      '\"file://host.invalid?x=/Users/canary/My Files/x\"',
      '\"file://host.invalid?x=<path>\"',
    ],
    [
      "'file://host.invalid?x=https://example.test/p'",
      "'file://host.invalid?x=https:<path>'",
    ],
    [
      "'file://a.invalid?x=/Users/c/My F/x' file://b.invalid?y=https://e.test/p",
      "'file://a.invalid?x=<path>' file://b.invalid?y=https://e.test/p",
    ],
  ] as const)("retains conservative outer-quoted pathless file URL handling: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    ["file://host.invalid?x=\\Users\\canary\\private.db", "file://host.invalid?x=<path>"],
    ["file://host.invalid#x=\\Users\\canary\\private.db", "file://host.invalid#x=<path>"],
    ["file://host.invalid?x=a\\server\\share\\db", "file://host.invalid?x=a<path>"],
    ["file://host.invalid?x=a\\\\server\\share\\db", "file://host.invalid?x=a<path>"],
    ["file://host.invalid?x=1\\/Users/canary/private.db", "file://host.invalid?x=1<path>"],
    [
      "file://host.invalid?x=foo/bar\\Users\\canary\\private.db",
      "file://host.invalid?x=foo/bar<path>",
    ],
    [
      "file://host.invalid?x=a/b\\Users\\canary\\private.db",
      "file://host.invalid?x=a/b<path>",
    ],
    ["file://host.invalid?x=a/\\Users\\canary\\private.db", "file://host.invalid?x=a/<path>"],
    [
      "file://host.invalid?x=a/b\\\\server\\share\\private.db",
      "file://host.invalid?x=a/b<path>",
    ],
    [
      "file://host.invalid#x=a/b\\Users\\canary\\private.db",
      "file://host.invalid#x=a/b<path>",
    ],
    [
      "file://host.invalid?x=a,b\\Users\\canary\\private.db",
      "file://host.invalid?x=a,b<path>",
    ],
    [
      "file://host.invalid?x=a;b\\\\server\\share\\db",
      "file://host.invalid?x=a;b<path>",
    ],
    [
      "file://host.invalid#x=a)b\\Users\\canary\\private.db",
      "file://host.invalid#x=a)b<path>",
    ],
    [
      "file://host.invalid?x=a}b\\Users\\canary\\private.db",
      "file://host.invalid?x=a}b<path>",
    ],
    [
      "file://host.invalid#x=a'b\\Users\\canary\\private.db",
      "file://host.invalid#x=a'b<path>",
    ],
  ] as const)("retains contextual backslash redaction after a pathless file URL: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://host.invalid?x=https://example.test/a\\server\\share\\db",
      "file://host.invalid?x=https://example.test/a\\server\\share\\db",
    ],
    [
      "file://host.invalid#x=profile://remote.invalid\\Users\\canary\\private.db",
      "file://host.invalid#x=profile://remote.invalid\\Users\\canary\\private.db",
    ],
    [
      "file://host.invalid?x=value then \\Users\\canary\\private.db",
      "file://host.invalid?x=value then \\Users\\canary\\private.db",
    ],
    [
      "file://host.invalid?x=value,\\Users\\canary\\private.db",
      "file://host.invalid?x=value,<path>",
    ],
    [
      "file://host.invalid?x=foo/bar/baz",
      "file://host.invalid?x=foo/bar/baz",
    ],
    [
      "file://host.invalid?x=/tmp\\Users\\canary",
      "file://host.invalid?x=<path>",
    ],
    [
      "err at \\Users\\canary\\private.db now",
      "err at \\Users\\canary\\private.db now",
    ],
    [
      "file://host.invalid?x=value|\\Users\\canary\\private.db",
      "file://host.invalid?x=value|\\Users\\canary\\private.db",
    ],
    [
      "file://host.invalid?x=value]\\Users\\canary\\private.db",
      "file://host.invalid?x=value]\\Users\\canary\\private.db",
    ],
    [
      'file://host.invalid?x=value"\\Users\\canary\\private.db',
      'file://host.invalid?x=value"\\Users\\canary\\private.db',
    ],
    [
      "file://host.invalid?x=value<\\Users\\canary\\private.db",
      "file://host.invalid?x=value<\\Users\\canary\\private.db",
    ],
    [
      "file://host.invalid?x=value>\\Users\\canary\\private.db",
      "file://host.invalid?x=value>\\Users\\canary\\private.db",
    ],
  ] as const)("bounds contextual backslash redaction to the pathless file URL tail: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  // Bug #903 retains broader arbitrary-prefix semantics. These rows pin the
  // safer file-URL recognition that follows the bounded pathless reset here.
  it.each([
    [
      "file://host.invalid?q=(file://host.invalid/Users/canary/private.db",
      "file://host.invalid?q=(file://host.invalid<path>",
    ],
    [
      "file://host.invalid?q=[a=b]file://host.invalid/Users/canary/private.db",
      "file://host.invalid?q=[a=b]file://host.invalid<path>",
    ],
    [
      "file://host.invalid?next=1file://host.invalid/Users/canary/private.db",
      "file://host.invalid?next=1file://host.invalid<path>",
    ],
    [
      "file://outer.invalid?q=prefix-file://host.invalid/Users/canary/private.db",
      "file://outer.invalid?q=prefix-file://host.invalid<path>",
    ],
    [
      "file://outer.invalid#q=prefix-file://host.invalid/Users/canary/private.db",
      "file://outer.invalid#q=prefix-file://host.invalid<path>",
    ],
  ] as const)("redacts newly recognized file URL paths after a pathless reset: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "https://outer.test/x?next=/Users/canary/private.db",
      "https://outer.test/x?next=/Users/canary/private.db",
    ],
    [
      "https://outer.test/x&next=/Users/canary/private.db",
      "https://outer.test/x&next=/Users/canary/private.db",
    ],
    [
      "https://outer.test/x?next=https://other.invalid/Users/canary/private.db",
      "https://outer.test/x?next=https://other.invalid/Users/canary/private.db",
    ],
    [
      "https://outer.test/x?next=profile://remote.invalid/Users/canary/private.db",
      "https://outer.test/x?next=profile://remote.invalid/Users/canary/private.db",
    ],
    [
      "https://outer.test/x?next=xfile://remote.invalid/Users/canary/private.db",
      "https://outer.test/x?next=xfile://remote.invalid/Users/canary/private.db",
    ],
    [
      "https://outer.test/x?next=file%3A%2F%2Fhost.invalid%2FUsers%2Fcanary%2Fprivate.db",
      "https://outer.test/x?next=file%3A%2F%2Fhost.invalid%2FUsers%2Fcanary%2Fprivate.db",
    ],
    ["https://outer.test/a/b/c?d=e#f", "https://outer.test/a/b/c?d=e#f"],
    [
      "https://outer.test/x/file://host.invalid/Users/canary/private.db",
      "https://outer.test/x/file://host.invalid/Users/canary/private.db",
    ],
    ["file://host.invalid&x=https://y.test/p", "file://host.invalid&x=https:<path>"],
    ["file://host.invalid=x=https://y.test/p", "file://host.invalid=x=https:<path>"],
    ["file://host.invalid[?x=https://y.test/p", "file://host.invalid[?x=https:<path>"],
    [
      "https://outer.test/x?next=file://host.invalid",
      "https://outer.test/x?next=file://host.invalid",
    ],
    [
      "https://outer.test/x?next=file://host.invalid/",
      "https://outer.test/x?next=file://host.invalid/",
    ],
  ] as const)("preserves nested URL controls and residuals: %#", (input, expected) => {
    expect(sanitizeError(input)).toBe(expected);
  });

  it.each([
    ['file://host"name/Users/canary/private.db', 'file://host"name<path>'],
    ['file://host"name\\Users\\canary\\private.db', 'file://host"name<path>'],
    ['file://host"name/C:/Users/canary/private.db', 'file://host"name<path>'],
    ['FILE://host"name/Users/canary/private.db', 'FILE://host"name<path>'],
    ['file://host"name"part/Users/canary/private.db', 'file://host"name"part<path>'],
    [
      '\'file://host"name/Users/canary/My Files/private.db\'',
      '\'file://host"name<path>\'',
    ],
    ['file://host"name/b', 'file://host"name<path>'],
    ['file://host"name/', 'file://host"name/'],
    [
      'https://outer.test/x?next=file://host"name/path',
      'https://outer.test/x?next=file://host"name<path>',
    ],
    [
      'file://host"na?x=/Users/canary/private.db',
      'file://host"na?x=<path>',
    ],
  ] as const)("redacts embedded double quotes within file URL authorities: %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
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
    [
      "prefix-file://host.invalid/Users/canary/private.db",
      "prefix-file://host.invalid/Users/canary/private.db",
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
    [
      "file://host;name/Users/canary/private.db;retry",
      "file://host;name<path>;retry",
    ],
    [
      "'file://host' then see https://example.test/x",
      "'file://host' then see https://example.test/x",
    ],
    [
      "'file://host' /Users/canary/private.db then see https://example.test/x",
      "'file://host' <path> then see https://example.test/x",
    ],
    [
      '"file://host"/Users/canary/private.db then see https://example.test/x',
      '"file://host"<path>',
    ],
    [
      "file://host|name/Users/canary/private.db",
      "file://host|name/Users/canary/private.db",
    ],
    [
      "file://host<name/Users/canary/private.db",
      "file://host<name/Users/canary/private.db",
    ],
    [
      "file://host>name/Users/canary/private.db",
      "file://host>name/Users/canary/private.db",
    ],
    [
      "file://host]name/Users/canary/private.db",
      "file://host]name/Users/canary/private.db",
    ],
    [
      'file://host"name/Users/canary/private.db',
      'file://host"name<path>',
    ],
    [
      '"file://host"name/Users/canary/private.db"',
      '"file://host"name/Users/canary/private.db"',
    ],
    [
      "https://host;name/Users/canary/private.db",
      "https://host;name/Users/canary/private.db",
    ],
  ] as const)("preserves file URL compatibility boundary %#", (input, expected) => {
    const result = sanitizeError(input);

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
  });

  it.each([
    [
      "file://remote.invalid/Users/canary/private.db?next=/etc/private.db",
      "file://remote.invalid<path>?next=<path>",
    ],
    [
      "file://remote.invalid/Users/canary/private.db#next=/etc/private.db",
      "file://remote.invalid<path>#next=<path>",
    ],
  ] as const)("redacts file URL delimiter residuals on the first pass %#", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts Bug #1294 Windows tails after nested public URL brackets in one pass", () => {
    const input = "file://h?x=[[a]/https://example.test/t]\\Users\\fictional.db";
    const expected = "file://h?x=[[a]<path>]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("Users");
    expect(first).not.toContain("fictional.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts Bug #1303 later quoted-query private parameters in one pass", () => {
    const input = "'file://h'['/private']?a/Users/alice&https://e.test/x&c/Users/bob/secret.db";
    const expected = "'file://h'['<path>']?a<path>&https://e.test/x&c<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/private");
    expect(first).not.toContain("alice");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "non-word",
      "'file://h'['/private']?a/Users/alice&https://e.test/x&=/Users/bob/secret.db",
      "'file://h'['<path>']?a<path>&https://e.test/x&=/Users/bob/secret.db",
    ],
    [
      "word-bearing",
      "'file://h'['/private']?a/Users/alice&https://e.test/x&later/Users/bob/secret.db",
      "'file://h'['<path>']?a<path>&https://e.test/x&later<path>",
    ],
  ] as const)("distinguishes %s paths after quoted-query public URLs", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts Bug #1304 paths after closed nested public URL brackets in one pass", () => {
    const input = "file://h/p?x=[https://e.test/t]/Users/alice/secret.db";
    const expected = "file://h<path>?x=[https://e.test/t]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts Bug #1312 absolute paths after nested public URL ampersands in one pass", () => {
    const input = "file://h?x=[https://example.test/t&/Users/alice/secret.db]";
    const expected = "file://h?x=[https://example.test/t&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("preserves Bug #1313 pipe-delimited absolute-path redaction as a stable regression", () => {
    const input = "file://h?x=[https://example.test/t|/Users/alice/secret.db]";
    const expected = "file://h?x=[https://example.test/t|<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("keeps Bug #1317 unquoted wrapper output stable while preserving its public URL", () => {
    const input = "file://host['/private']&https://e.test/p";
    const expected = "file://host['<path>']&https://e.test/p";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/private");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("keeps slash-bearing values inside ordinary nested public queries", () => {
    const input = "file://h?x=[https://example.test/t?a=/public]";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps named slash-bearing parameters inside nested public queries", () => {
    const input = "file://h?x=[https://example.test/t?key=/public/path&next=/also/public]";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps relative ampersand continuations inside nested public URLs", () => {
    const input = "file://h?x=[https://example.test/t&relative/path]";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps relative pipe continuations inside nested public URLs", () => {
    const input = "file://h?x=[https://example.test/t|relative/path]";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps nested IPv6 public URL authority brackets and query syntax", () => {
    const input = "file://h?x=[https://[fe80::1]/p?q=1]";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps ordinary public URLs in pathless file queries", () => {
    const input = "file://h?x=https://e.test/p";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps Bug #1317 generated-marker output byte-identical", () => {
    const input = "file://host['<path>']&https://e.test/p";

    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it("keeps separately quoted wrappers conservatively redacted", () => {
    const input = "'file://host'['/private']&https://example.test/p";
    const expected = "'file://host'['<path>']&https:<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("preserves public URLs after whitespace-separated unquoted wrappers", () => {
    const input = "file://host['/private'] https://e.test/p";
    const expected = "file://host['<path>'] https://e.test/p";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains doubled-bracket public URL syntax before Bug #1294 Windows tails", () => {
    const input =
      "file://h?x=[[a]/https://e.test/t?key=/public&next=/also]\\Users\\alice\\secret.db";
    const expected =
      "file://h?x=[[a]<path>https://e.test/t?key=/public&next=/also]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains doubled-bracket public URL syntax before immediate private paths", () => {
    const input =
      "file://h?x=[[a]/https://e.test/t?key=/public&next=/also&/Users/alice/secret.db]";
    const expected =
      "file://h?x=[[a]<path>https://e.test/t?key=/public&next=/also&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("conservatively redacts slash values after literal doubled-bracket path markers", () => {
    const input = "file://h?x=[[a]<path>?key=/public&next=/also]/Users/alice/secret.db";
    const expected = "file://h?x=[[a]<path>?key=<path>&next=<path>]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("does not trust raw doubled-bracket path markers as public-query provenance", () => {
    const input = "file://h?x=[[a]<path>?key=/Users/alice/secret.db]";
    const expected = "file://h?x=[[a]<path>?key=<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "query",
      "file://h?x=[[a]<path>?key=\\Users\\alice\\secret.db]",
      "file://h?x=[[a]<path>?key=<path>]",
    ],
    [
      "fragment",
      "file://h?x=[[a]<path>#key=\\Users\\alice\\secret.db]",
      "file://h?x=[[a]<path>#key=<path>]",
    ],
    [
      "arbitrary literal",
      "file://h?x=[[a]<opaque>?key=\\Users\\alice\\secret.db]",
      "file://h?x=[[a]<opaque>?key=<path>]",
    ],
  ] as const)("redacts contextual Windows roots after %s text", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    "ordinary <opaque>?key=\\Users\\alice\\secret.db prose",
    "https://e.test/t?key=\\Users\\alice\\secret.db",
  ] as const)("does not make single-root Windows paths global: %s", (input) => {
    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it.each([
    [
      "query",
      "file://h?x=[[a]/https://e.test/t?key=/public&next=/also]\\Users\\alice\\secret.db",
      "file://h?x=[[a]<path>https://e.test/t?key=/public&next=/also]<path>",
    ],
    [
      "fragment",
      "file://h?x=[[a]/https://e.test/t#key=/public&next=/also]\\Users\\alice\\secret.db",
      "file://h?x=[[a]<path>https://e.test/t#key=/public&next=/also]<path>",
    ],
  ] as const)("retains actual nested public URL %s syntax", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains bracketed public URL syntax before Bug #1294 Windows tails", () => {
    const input =
      "file://h?x=[[a]/https://e.test/t?key=[/public]&next=/also]\\Users\\alice\\secret.db";
    const expected =
      "file://h?x=[[a]<path>https://e.test/t?key=[/public]&next=/also]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("conservatively redacts bracketed slash values after literal path markers", () => {
    const input =
      "file://h?x=[[a]<path>?key=[/public]&next=/also]/Users/alice/secret.db";
    const expected = "file://h?x=[[a]<path>?key=[<path>]&next=<path>]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("returns later Windows values to the enclosing owner after a public URL path handoff", () => {
    const input =
      "file://h?x=[https://e.test/t&/Users/a/one&key=\\Users\\bob\\secret.db]";
    const expected = "file://h?x=[https://e.test/t&<path>&key=<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("balances nested brackets after returning from a public URL path handoff", () => {
    const input =
      "file://h?x=[https://e.test/t&/Users/a/one&key=[/Users/b/two]]";
    const expected = "file://h?x=[https://e.test/t&<path>&key=[<path>]]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    "file://h?x=[https://e.test/t?key=/public&next=/also]",
    "file://h?x=[https://e.test/t&relative/path]",
  ] as const)("keeps nested public named and relative controls stable: %s", (input) => {
    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  it.each([
    [
      "Windows",
      "file://h?x=[https://e.test/t|/Users/a/one]\\Users\\b\\two",
      "file://h?x=[https://e.test/t|<path>]<path>",
    ],
    [
      "POSIX",
      "file://h?x=[https://e.test/t|/Users/a/one]/Users/b/two",
      "file://h?x=[https://e.test/t|<path>]<path>",
    ],
  ] as const)("redacts %s paths after pipe handoff wrappers", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    "file://h?x=[https://e.test/t|relative/path]",
    "file://h?x=[https://[fe80::1]/p?q=1|relative/path]",
  ] as const)("keeps pipe public, relative, and IPv6 controls stable: %s", (input) => {
    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  describe("Bug #1332", () => {
    it("keeps the privacy decision for the original and post-pipe-handoff contexts", () => {
      const input = "file://h?x=[value|later=\\Users\\bob\\secret.db]";
      const expected = "file://h?x=[value|later=<path>]";
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  it("keeps quoted-query ownership after an immediate public URL path handoff", () => {
    const input =
      "'file://h'['/private']?a/Users/alice&https://e.test/x&/Users/bob&c/Users/carol";
    const expected =
      "'file://h'['<path>']?a<path>&https://e.test/x&<path>&c<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("carol");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts repeated quoted-query bare paths before a word-bearing path", () => {
    const input =
      "'file://h'['/private']?a/Users/alice&https://e.test/x&/PrivateOne/a&/PrivateTwo/b&d/Users/carol";
    const expected =
      "'file://h'['<path>']?a<path>&https://e.test/x&<path>&<path>&d<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("PrivateOne");
    expect(first).not.toContain("PrivateTwo");
    expect(first).not.toContain("carol");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "drive and UNC",
      "'file://h'['/private']?a/Users/alice&https://e.test/x&/Users/bob&drive=C:\\Users\\carol\\secret.db&unc=\\\\server\\share\\secret.db",
      "'file://h'['<path>']?a<path>&https://e.test/x&<path>&drive=<path>&unc=<path>",
    ],
    [
      "later public URL",
      "'file://h'['/private']?a/Users/alice&https://e.test/x&/Users/bob&https://p.test/y&c/Users/carol",
      "'file://h'['<path>']?a<path>&https://e.test/x&<path>&https://p.test/y&c<path>",
    ],
    [
      "named public values",
      "'file://h'['/private']?a/Users/alice&https://e.test/x?key=/public&next=/also&/Users/bob",
      "'file://h'['<path>']?a<path>&https://e.test/x?key=/public&next=/also&<path>",
    ],
  ] as const)("preserves quoted-query %s boundaries", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("consumes a nested pipe handoff at its originating wrapper close", () => {
    const input = "file://h?x=[[https://e.test/t|/Users/a/one]\\Users\\b\\two]";
    const expected = "file://h?x=[[https://e.test/t|<path>]<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("\\Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains pending pipe handoffs at two wrapper depths", () => {
    const input =
      "file://h?x=[https://e.test/t|/Users/a/one&/Users/b/two&[https://p.test/x|/Users/c/three]\\Users\\d\\four]\\Users\\e\\five";
    const expected =
      "file://h?x=[https://e.test/t|<path>&<path>&[https://p.test/x|<path>]<path>]<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("\\Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "three depths",
      "file://h?x=[https://a.test/t|/Users/a/one&[https://b.test/t|/Users/b/two&[https://c.test/t|/Users/c/three]\\Users\\c\\tail]\\Users\\b\\tail]\\Users\\a\\tail",
      "file://h?x=[https://a.test/t|<path>&[https://b.test/t|<path>&[https://c.test/t|<path>]<path>]<path>]<path>",
    ],
    [
      "repeated same depth",
      "file://h?x=[https://a.test/t|/Users/a/one|/Users/b/two]\\Users\\c\\tail",
      "file://h?x=[https://a.test/t|<path>|<path>]<path>",
    ],
    [
      "close without tail",
      "file://h?x=[https://a.test/t|/Users/a/one]done",
      "file://h?x=[https://a.test/t|<path>]done",
    ],
    [
      "whitespace reset",
      "file://h?x=[https://a.test/t|/Users/a/one \\Users\\b\\two]",
      "file://h?x=[https://a.test/t|<path> \\Users\\b\\two]",
    ],
  ] as const)("keeps pipe handoffs bounded for %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("restores enclosing ownership after a later public URL", () => {
    const input =
      "file://h?x=[https://e.test/t&/Users/a/one&https://p.test/x&\\Users\\bob\\secret.db]";
    const expected = "file://h?x=[https://e.test/t&<path>&https://p.test/x&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "root-relative Windows",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>]",
    ],
    [
      "POSIX",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&/TopSecret/c/three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>]",
    ],
  ] as const)("restores enclosing ownership after nested file URLs: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("TopSecret");
    expect(first).not.toContain("\\Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "hosted and root-relative Windows",
      "file://h?x=[https://e.test/t&/Users/a/one&file://host/Users/b/two&\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://host<path>&<path>]",
    ],
    [
      "UNC",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\\\server\\share\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>]",
    ],
    [
      "drive",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&C:\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>]",
    ],
    [
      "later public and relative values",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&https://p.test/x&relative/path]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&https://p.test/x&relative/path]",
    ],
    [
      "whitespace reset",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two \\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path> \\Users\\c\\three]",
    ],
    [
      "unclosed wrapper",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>",
    ],
    [
      "own query",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two?key=/public&next=/also&\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>?key=<path>&next=<path>&<path>]",
    ],
    [
      "own fragment",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two#key=/public&next=/also&\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>#key=<path>&next=<path>&<path>]",
    ],
  ] as const)("keeps nested file child and parent boundaries for %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains nested-file parent ownership across repeated Windows roots", () => {
    const input =
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three&\\Users\\d\\four]";
    const expected =
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("\\Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "three pathless roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three&\\Users\\d\\four&\\Users\\e\\five]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&<path>&<path>]",
    ],
    [
      "hosted roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file://host/Users/b/two&\\Users\\c\\three&\\Users\\d\\four]",
      "file://h?x=[https://e.test/t&<path>&file://host<path>&<path>&<path>]",
    ],
    [
      "child query roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two?key=/public&\\Users\\c\\three&\\Users\\d\\four]",
      "file://h?x=[https://e.test/t&<path>&file://<path>?key=<path>&<path>&<path>]",
    ],
    [
      "child fragment roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two#key=/public&\\Users\\c\\three&\\Users\\d\\four]",
      "file://h?x=[https://e.test/t&<path>&file://<path>#key=<path>&<path>&<path>]",
    ],
    [
      "unclosed wrapper roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three&\\Users\\d\\four",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&<path>",
    ],
    [
      "repeated POSIX roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&/Private/c/three&/Private/d/four]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&<path>]",
    ],
    [
      "UNC and drive roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\\\server\\share\\three&C:\\Users\\d\\four]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&<path>]",
    ],
    [
      "bare and word-bearing roots",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three&later/Users/d/four]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&later<path>]",
    ],
    [
      "named Windows root",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&name=\\Users\\c\\three]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&name=<path>]",
    ],
    [
      "public and relative successors",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three&https://p.test/x&relative/path]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>&https://p.test/x&relative/path]",
    ],
  ] as const)("retains returned nested-file parent for %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "matching close",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three]\\Users\\outside",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path>]<path>",
    ],
    [
      "whitespace reset",
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&\\Users\\c\\three \\Users\\outside]",
      "file://h?x=[https://e.test/t&<path>&file://<path>&<path> \\Users\\outside]",
    ],
  ] as const)("expires returned nested-file parent at %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains outer returned-parent ownership after an inner file child closes", () => {
    const input =
      "file://h?x=[https://o.test/t&/Users/o/one&file:///Users/a/two&[https://i.test/t&/Users/i/one&file:///Users/b/two&\\Users\\i\\three]&\\Users\\o\\after]";
    const expected =
      "file://h?x=[https://o.test/t&<path>&file://<path>&[https://i.test/t&<path>&file://<path>&<path>]&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("\\Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "hosted children",
      "file://h?x=[https://o.test/t&/Users/o/one&file://outer/Users/a/two&[https://i.test/t&/Users/i/one&file://inner/Users/b/two&\\Users\\i\\three]&\\Users\\o\\after]",
      "file://h?x=[https://o.test/t&<path>&file://outer<path>&[https://i.test/t&<path>&file://inner<path>&<path>]&<path>]",
    ],
    [
      "inner child query",
      "file://h?x=[https://o.test/t&/Users/o/one&file:///Users/a/two&[https://i.test/t&/Users/i/one&file:///Users/b/two?key=/public&\\Users\\i\\three]&\\Users\\o\\after]",
      "file://h?x=[https://o.test/t&<path>&file://<path>&[https://i.test/t&<path>&file://<path>?key=<path>&<path>]&<path>]",
    ],
    [
      "inner child fragment",
      "file://h?x=[https://o.test/t&/Users/o/one&file:///Users/a/two&[https://i.test/t&/Users/i/one&file:///Users/b/two#key=/public&\\Users\\i\\three]&\\Users\\o\\after]",
      "file://h?x=[https://o.test/t&<path>&file://<path>&[https://i.test/t&<path>&file://<path>#key=<path>&<path>]&<path>]",
    ],
    [
      "three returned-parent depths",
      "file://h?x=[https://a.test/t&file:///Users/a/one&[https://b.test/t&file:///Users/b/two&[https://c.test/t&file:///Users/c/three&\\Users\\c\\tail]&\\Users\\b\\tail]&\\Users\\a\\tail]",
      "file://h?x=[https://a.test/t&file://<path>&[https://b.test/t&file://<path>&[https://c.test/t&file://<path>&<path>]&<path>]&<path>]",
    ],
    [
      "unclosed outer wrapper",
      "file://h?x=[https://o.test/t&file:///Users/a/two&[https://i.test/t&file:///Users/b/two&\\Users\\i\\three]&\\Users\\o\\after",
      "file://h?x=[https://o.test/t&file://<path>&[https://i.test/t&file://<path>&<path>]&<path>",
    ],
  ] as const)("retains nested-file returned parents for %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("preserves the Bug #1336 direct-relative successor", () => {
    const input =
      "file://h?x=[https://o.test/t&/Users/o/one&file:///Users/a/two&relative/path]";
    const expected =
      "file://h?x=[https://o.test/t&<path>&file://<path>&relative/path]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "pathless query",
      "file://h?x=[https://e.test/t&/Users/o/one&file:///Users/a/one?key=/public&later/Users/tail/secret]",
      "file://h?x=[https://e.test/t&<path>&file://<path>?key=<path>&later<path>]",
    ],
    [
      "hosted fragment",
      "file://h?x=[https://e.test/t&/Users/o/one&file://host/Users/a/one#key=/public&later/Users/tail/secret]",
      "file://h?x=[https://e.test/t&<path>&file://host<path>#key=<path>&later<path>]",
    ],
    [
      "unclosed query wrapper",
      "file://h?x=[https://e.test/t&file:///Users/a/one?key=/public&later/Users/tail/secret",
      "file://h?x=[https://e.test/t&file://<path>?key=<path>&later<path>",
    ],
  ] as const)("returns from nested-file %s for private word-bearing roots", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("Users/tail/secret");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("returns from nested-file child queries at two retained depths", () => {
    const input =
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&[file:///Users/b/two#key=/public&later/Users/b/secret]&later/Users/outer/secret]";
    const expected =
      "file://h?x=[file://<path>?key=<path>&later<path>&[file://<path>#key=<path>&later<path>]&later<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("returns from repeated nested-file query children at one depth", () => {
    const input =
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&file://host/Users/b/two#key=/public&later/Users/b/secret]";
    const expected =
      "file://h?x=[file://<path>?key=<path>&later<path>&file://host<path>#key=<path>&later<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "query",
      "file://h?x=[https://e.test/t&file:///Users/a/one?key=/public&relative/path]",
      "file://h?x=[https://e.test/t&file://<path>?key=<path>&relative/path]",
      "file://h?x=[https://e.test/t&file://<path>?key=<path>&relative/path]",
    ],
    [
      "fragment",
      "file://h?x=[https://e.test/t&file:///Users/a/one#key=/public&docs/readme/more]",
      "file://h?x=[https://e.test/t&file://<path>#key=<path>&docs/readme/more]",
      "file://h?x=[https://e.test/t&file://<path>#key=<path>&docs/readme/more]",
    ],
    [
      "incomplete Users root",
      "file://h?x=[https://e.test/t&file:///Users/a/one?key=/public&later/Users]",
      "file://h?x=[https://e.test/t&file://<path>?key=<path>&later/Users]",
      "file://h?x=[https://e.test/t&file://<path>?key=<path>&later/Users]",
    ],
  ] as const)("pins Bug #1336 %s pass stability", (_name, input, firstExpected, stableExpected) => {
    const first = sanitizeError(input);
    const second = sanitizeError(first);

    expect(first).toBe(firstExpected);
    expect(second).toBe(stableExpected);
    expect(sanitizeError(second)).toBe(second);
  });

  it.each([
    [
      "matching close",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/tail/secret]&later/Users/outside",
      "file://h?x=[file://<path>?key=<path>&later<path>]&later/Users/outside",
    ],
    [
      "whitespace reset",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/tail/secret later/Users/outside]",
      "file://h?x=[file://<path>?key=<path>&later<path> later/Users/outside]",
    ],
  ] as const)("expires nested-file query return at %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("returns from a later public child to a retained exact-file parent", () => {
    const input =
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/SECRET_A&https://public.test/x&later/Users/final/SECRET_FINAL]";
    const expected =
      "file://h?x=[file://<path>?key=<path>&later<path>&https://public.test/x&later<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET_A");
    expect(first).not.toContain("SECRET_FINAL");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "hosted fragment and named public child",
      "file://h?x=[file://host/Users/a/one#key=/public&later/Users/a/secret&https://p.test/x?key=/public&next=/also&later/Users/final/secret]",
      "file://h?x=[file://host<path>#key=<path>&later<path>&https://p.test/x?key=/public&next=/also&later<path>]",
    ],
    [
      "IPv6 child and mixed-case backslash root",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&https://[::1]/p&later/uSeRs\\final\\secret]",
      "file://h?x=[file://<path>?key=<path>&later<path>&https://[::1]/p&later<path>]",
    ],
    [
      "unclosed wrapper",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&https://p.test/x&later/Users/final/secret",
      "file://h?x=[file://<path>?key=<path>&later<path>&https://p.test/x&later<path>",
    ],
    [
      "alternating public children",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&https://p.test/one&later/Users/b/secret&ftp://p.test/two&later/Users/c/secret]",
      "file://h?x=[file://<path>?key=<path>&later<path>&https://p.test/one&later<path>&ftp://p.test/two&later<path>]",
    ],
  ] as const)("retains returned parent across %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("/uSeRs");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("retains public-child return at two nested parent depths", () => {
    const input =
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&[file:///Users/b/two#key=/public&later/Users/b/secret&https://inner.test/x&later/Users/inner/secret]&https://outer.test/x&later/Users/outer/secret]";
    const expected =
      "file://h?x=[file://<path>?key=<path>&later<path>&[file://<path>#key=<path>&later<path>&https://inner.test/x&later<path>]&https://outer.test/x&later<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "matching close",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&https://p.test/x]&later/Users/outside",
      "file://h?x=[file://<path>?key=<path>&later<path>&https://p.test/x]&later/Users/outside",
    ],
    [
      "whitespace reset",
      "file://h?x=[file:///Users/a/one?key=/public&later/Users/a/secret&https://p.test/x later/Users/outside]",
      "file://h?x=[file://<path>?key=<path>&later<path>&https://p.test/x later/Users/outside]",
    ],
  ] as const)("expires retained public-child parent at %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts a named Windows root after a later public child", () => {
    const input =
      "file://h?x=[https://z.test/t&file:///Users/CHILD/path&https://a.test/t&name=\\Users\\SECRET\\path]";
    const expected =
      "file://h?x=[https://z.test/t&file://<path>&https://a.test/t&name=<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "query relative parameter",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo?a=1&relative/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&relative/path",
    ],
    [
      "fragment relative parameter",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo#x=1&docs/readme/more",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo#x=1&docs/readme/more",
    ],
    [
      "named slash parameter",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo?a=1&next=/public/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&next=/public/path",
    ],
  ] as const)("keeps quoted public URL internal %s intact", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("preserves the pre-query broad word-bearing private return", () => {
    const input =
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo&relative/path";
    const expected =
      "'file://h'['<path>']?a<path>&https://cdn.test/logo&relative<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "bare private return",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo&/Users/bob",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo&<path>",
    ],
    [
      "word-bearing private return",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo&c/Users/bob",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo&c<path>",
    ],
    [
      "later independent public URL",
      "'file://h'['/private']?a/Users/alice&https://cdn.test/logo&/Users/bob&https://p.test/x",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo&<path>&https://p.test/x",
    ],
  ] as const)("preserves quoted public child %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "named Windows root",
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo?a=1&name=\\Users\\SECRET\\path&https://later.test/x&c/Users/LATER/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&name=<path>&https://later.test/x&c<path>",
    ],
    [
      "named drive",
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo?a=1&drive=C:\\Users\\SECRET\\path&https://later.test/x&c/Users/LATER/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&drive=<path>&https://later.test/x&c<path>",
    ],
    [
      "named UNC",
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo?a=1&unc=\\\\server\\share\\SECRET&https://later.test/x&c/Users/LATER/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&unc=<path>&https://later.test/x&c<path>",
    ],
  ] as const)("restores quoted parent after public-child %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET");
    expect(first).not.toContain("LATER");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo?a=1&c/Public/path",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&c/Public/path",
    ],
    [
      "'file://h'['/private']?a/Users/PARENT&https://cdn.test/logo?a=1&c/Users",
      "'file://h'['<path>']?a<path>&https://cdn.test/logo?a=1&c/Users",
    ],
  ] as const)("keeps quoted public-child non-private word value intact: %s", (input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts repeated pipe Windows paths inside one wrapper", () => {
    const input =
      "file://h?x=[https://e.test/t|\\Users\\alice\\one.db|\\Users\\bob\\secret.db]";
    const expected = "file://h?x=[https://e.test/t|<path>|<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    ["public", "file://h?x=[https://e.test/t]", "file://h?x=[https://e.test/t]"],
    [
      "named",
      "file://h?x=[https://e.test/t?key=/public&next=/also]",
      "file://h?x=[https://e.test/t?key=/public&next=/also]",
    ],
    ["relative", "file://h?x=[https://e.test/t|relative/path]", "file://h?x=[https://e.test/t|relative/path]"],
    [
      "IPv6",
      "file://h?x=[https://[::1]/p|\\Users\\first.db|\\Users\\second.db",
      "file://h?x=[https://[::1]/p|<path>|<path>",
    ],
    [
      "deferred Bug #1332",
      "file://h?x=[value|later=\\Users\\bob\\secret.db]",
      "file://h?x=[value|later=<path>]",
    ],
  ] as const)("preserves post-review 5 %s control", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts repeated nested-public ampersand paths in the same wrapper", () => {
    const input = "file://h?x=[https://e.test/t&/Users/a/one.db&/Users/b/two.db]";
    const expected = "file://h?x=[https://e.test/t&<path>&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/Users");
    expect(first).not.toContain("one.db");
    expect(first).not.toContain("two.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts nested-public ampersand Windows-root paths", () => {
    const input = "file://h?x=[https://example.test/t&\\Users\\alice\\secret.db]";
    const expected = "file://h?x=[https://example.test/t&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("alice");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts nested-public ampersand POSIX paths beginning with a Unicode symbol", () => {
    const input = "file://h?x=[https://example.test/t&/📁/secret.db]";
    const expected = "file://h?x=[https://example.test/t&<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("📁");
    expect(first).not.toContain("secret.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts bare ampersand paths after public URLs in quoted file queries", () => {
    const input = "'file://h'['/private']?a/Users/alice&https://e.test/x&/Users/bob/two.db";
    const expected = "'file://h'['<path>']?a<path>&https://e.test/x&<path>";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("/private");
    expect(first).not.toContain("alice");
    expect(first).not.toContain("bob");
    expect(first).not.toContain("two.db");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });


  it.each([
    [
      "pipe-then-ampersand returned owner",
      "file://h?x=[https://e.test/t|/Users/a/one&\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|<path>&<path>]",
    ],
    [
      "ampersand-then-pipe nested file child",
      "file://h?x=[https://e.test/t&file://host?key=/public|\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t&file://host?key=<path>|<path>]",
    ],
    [
      "pipe-then-pipe nested file child",
      "file://h?x=[https://e.test/t|file://host?key=/public|\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|file://host?key=<path>|<path>]",
    ],
    [
      "ampersand-relative-then-pipe nested file child",
      "file://h?x=[https://e.test/t&file://host?key=/public&more|\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t&file://host?key=<path>&more|<path>]",
    ],
  ] as const)("redacts a single-backslash Windows root after %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "POSIX successor",
      "file://h?x=[https://e.test/t&file://host?key=/public|/Users/SECRET/x]",
      "file://h?x=[https://e.test/t&file://host?key=<path>|<path>]",
    ],
    [
      "UNC successor",
      "file://h?x=[https://e.test/t&file://host?key=/public|\\\\srv\\share\\s]",
      "file://h?x=[https://e.test/t&file://host?key=<path>|<path>]",
    ],
    [
      "drive successor",
      "file://h?x=[https://e.test/t&file://host?key=/public|C:\\Users\\SECRET]",
      "file://h?x=[https://e.test/t&file://host?key=<path>|<path>]",
    ],
  ] as const)("keeps already-recognized %s forms redacted after a pipe handoff", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("SECRET");
    expect(first).not.toContain("srv");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("keeps a single-pipe direct handoff control stable", () => {
    const input = "file://h?x=[https://e.test/t|\\Users\\SECRET\\x]";
    const expected = "file://h?x=[https://e.test/t|<path>]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  describe("Bug #1349", () => {
    it.each([
      [
        "returns from a path-bearing child on pipe",
        "file://h?x=[file:///Users/CHILD/x|later/Users/alice/secret.db]",
        "file://h?x=[file://<path>|later<path>]",
        "file://h?x=[file://<path>|later<path>]",
      ],
      [
        "preserves the Bug #1336 ordinary relative pipe successor",
        "file://h?x=[file:///Users/CHILD/x|relative/path]",
        "file://h?x=[file://<path>|relative/path]",
        "file://h?x=[file://<path>|relative/path]",
      ],
      [
        "keeps the ampersand return",
        "file://h?x=[file:///Users/CHILD/x&later/Users/alice/secret.db]",
        "file://h?x=[file://<path>&later<path>]",
        "file://h?x=[file://<path>&later<path>]",
      ],
      [
        "keeps a query-only child scoped",
        "file://h?x=[https://e.test/t&file://host?key=/public|later/Users/secret]",
        "file://h?x=[https://e.test/t&file://host?key=<path>|later/Users/secret]",
        "file://h?x=[https://e.test/t&file://host?key=<path>|later/Users/secret]",
      ],
      [
        "keeps a POSIX root redacted",
        "file://h?x=[file:///Users/CHILD/x|/Users/alice/secret.db]",
        "file://h?x=[file://<path>|<path>]",
        "file://h?x=[file://<path>|<path>]",
      ],
      [
        "keeps a Windows root redacted",
        "file://h?x=[file:///Users/CHILD/x|\\Users\\alice\\secret.db]",
        "file://h?x=[file://<path>|<path>]",
        "file://h?x=[file://<path>|<path>]",
      ],
      [
        "keeps a drive root redacted",
        "file://h?x=[file:///Users/CHILD/x|C:\\Users\\alice\\secret.db]",
        "file://h?x=[file://<path>|<path>]",
        "file://h?x=[file://<path>|<path>]",
      ],
    ] as const)("%s", (_name, input, firstExpected, stableExpected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);

      expect(first).toBe(firstExpected);
      expect(second).toBe(stableExpected);
      expect(sanitizeError(second)).toBe(second);
    });
  });

  describe("Bug #1336", () => {
    const prefix = "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two";
    const expectedPrefix = "file://h?x=[https://e.test/t&<path>&file://<path>";
    const returnedParentRows = [
      ["relative path", "relative/path", "relative/path"],
      ["ordinary value", "another/ordinary/value", "another/ordinary/value"],
      ["nested Users root", "later/Users/alice/secret", "later<path>"],
      ["nested home root", "later/home/alice/secret", "later<path>"],
      ["nested root root", "later/root/secret", "later<path>"],
      ["leading Users root", "Users/alice/secret", "Users<path>"],
      ["leading home root", "home/alice/secret", "home<path>"],
      ["leading root root", "root/private", "root<path>"],
      ["non-leading Users root", "not/Users/secret", "not<path>"],
      ["non-leading home root", "backup/home/secret", "backup<path>"],
      ["deep Users root", "a/b/Users/alice/secret", "a<path>"],
      ["case-insensitive Users root", "docs/users/guide", "docs<path>"],
      ["incomplete Users root", "later/Users", "later/Users"],
      ["homeless segment", "later/homeless/x", "later/homeless/x"],
      ["Users2 segment", "later/Users2/x", "later/Users2/x"],
      ["public URL", "https://p.test/x", "https://p.test/x"],
      ["POSIX root", "/Users/c/three", "<path>"],
      ["Windows root", "\\Users\\c\\three", "<path>"],
      ["UNC root", "\\\\srv\\share\\s", "<path>"],
      ["drive root", "C:\\Users\\c\\three", "<path>"],
      ["P3 Users backslash continuation", "later/Users\\alice\\secret", "later<path>"],
      ["P3 home backslash continuation", "later/home\\alice\\secret", "later<path>"],
      ["repeated separator after Users", "later/Users//CANARY/secret.db", "later<path>"],
      ["repeated separator after home", "later/home//CANARY", "later<path>"],
      ["repeated separator after root", "later/root//CANARY", "later<path>"],
      ["empty segment before Users", "a/b//Users/CANARY", "a<path>"],
      ["mixed separator run", "later/Users/\\CANARY", "later<path>"],
      ["repeated backslash continuation", "later/Users\\\\CANARY", "later<path>"],
      ["leading backslash-only relative", "Users\\CANARY", "Users\\CANARY"],
      ["separator run without continuation", "later/Users//", "later/Users//"],
    ] as const;
    const cases: Array<readonly [string, string, string]> = returnedParentRows.flatMap(
      ([name, value, expected]) =>
        (["&", "|"] as const).map((delimiter) => [
          `${name} after ${delimiter}`,
          `${prefix}${delimiter}${value}]`,
          `${expectedPrefix}${delimiter}${expected}]`,
        ] as const),
    );
    cases.push(
      [
        "query child ordinary relative",
        "file://h?x=[https://e.test/t&file:///Users/a/one?key=/public&relative/path]",
        "file://h?x=[https://e.test/t&file://<path>?key=<path>&relative/path]",
      ],
      [
        "hard reset",
        `${prefix}&relative/path later/Users/secret]`,
        `${expectedPrefix}&relative/path later/Users/secret]`,
      ],
      [
        "matching close",
        `${prefix}]&relative/path`,
        `${expectedPrefix}]&relative/path`,
      ],
    );

    it.each(cases)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1763", () => {
    const prefix = "file://h?x=[file:///Users/CHILD/x";
    const expectedPrefix = "file://h?x=[file://<path>";
    const successorRows = [
      ["issue body home root", "later/home/alice/secret.db", "later<path>"],
      ["separator run before Users", "later//Users/CANARY", "later<path>"],
      ["empty segment before root", "a/b//root//CANARY", "a<path>"],
      ["leading home root", "home/alice/secret", "home<path>"],
      ["leading Users root", "Users/alice/secret", "Users<path>"],
      ["leading root root", "root/private", "root<path>"],
      ["deep root root", "a/b/c/root/secret", "a<path>"],
      ["non-leading Users root", "not/Users/secret", "not<path>"],
      ["mixed case home root", "later/HOME/alice", "later<path>"],
      ["slash-first home backslash continuation", "later/home\\alice", "later<path>"],
      ["slash-first root backslash continuation", "later/root\\secret", "later<path>"],
      ["preserved Users with trailing separator", "later/Users/", "later<path>"],
      ["preserved Users with trailing separator run", "later/Users//", "later<path>"],
      ["preserved Users path", "later/Users/alice/secret.db", "later<path>"],
      ["second successor", "later/home/a&second/Users/b", "later<path>&second<path>"],
      ["successor with its own query", "later/home/alice/secret.db?key=/Users/Z", "later<path>?key=<path>"],
      ["backslash-first relative", "later\\home\\alice", "later\\home\\alice"],
      ["homes segment", "later/homes/x", "later/homes/x"],
      ["Users2 segment", "later/Users2/x", "later/Users2/x"],
      ["bare home", "later/home", "later/home"],
      ["home with empty continuation", "later/home/", "later/home/"],
      ["bare root", "later/root", "later/root"],
      ["ordinary relative value", "later/var/data", "later/var/data"],
      ["relative path", "relative/path", "relative/path"],
      ["public URL", "https://p.test/x", "https://p.test/x"],
    ] as const;
    const cases: Array<readonly [string, string, string]> = successorRows.flatMap(
      ([name, value, expected]) =>
        (["&", "|"] as const).map((delimiter) => [
          name + " after " + delimiter,
          prefix + delimiter + value + "]",
          expectedPrefix + delimiter + expected + "]",
        ] as const),
    );
    cases.push(
      [
        "successor after a public URL parameter of the active child",
        prefix + "&https://e.test/x&later/home/bob/secret.db]",
        expectedPrefix + "&https://e.test/x&later<path>]",
      ],
      [
        "query-only child keeps a relative successor visible",
        "file://host?key=/public&later/Users/secret",
        "file://host?key=<path>&later/Users/secret",
      ],
      [
        "quoted public query home successor stays visible",
        "file://h?x=['https://e.test/x?q=1'&later/home/bob/secret.db]",
        "file://h?x=['https://e.test/x?q=1'&later/home/bob/secret.db]",
      ],
      [
        "quoted public query separator-run successor stays visible",
        "file://h?x=['https://e.test/x?q=1'&later//Users/bob/secret.db]",
        "file://h?x=['https://e.test/x?q=1'&later//Users/bob/secret.db]",
      ],
      [
        "retained parent home successor stays visible",
        "file://h?x=[https://e.test/t&/Users/a/one&https://p.test/x&later/home/final/secret]",
        "file://h?x=[https://e.test/t&<path>&https://p.test/x&later/home/final/secret]",
      ],
      [
        "retained parent separator-run successor stays visible",
        "file://h?x=[https://e.test/t&/Users/a/one&https://p.test/x&later//home/final/secret]",
        "file://h?x=[https://e.test/t&<path>&https://p.test/x&later//home/final/secret]",
      ],
    );

    it.each(cases)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1344", () => {
    it.each([
      [
        "single-quoted pipe handoff",
        "file://h?x=['https://e.test/t'|\\Users\\SECRET\\x]",
        "file://h?x=['https://e.test/t'|<path>]",
      ],
      [
        "single-quoted ampersand handoff",
        "file://h?x=['https://e.test/t'&\\Users\\SECRET\\x]",
        "file://h?x=['https://e.test/t'&<path>]",
      ],
      [
        "double-quoted pipe handoff",
        'file://h?x=["https://e.test/t"|\\Users\\SECRET\\x]',
        'file://h?x=["https://e.test/t"|<path>]',
      ],
      [
        "P3 own-query preservation",
        "file://h?x=['https://e.test/t?next=/public'|\\Users\\SECRET\\x]",
        "file://h?x=['https://e.test/t?next=/public'|<path>]",
      ],
      [
        "quoted nested-file control",
        'file://h?x=["file://host?key=/public"|\\Users\\SECRET\\x]',
        'file://h?x=["file://host?key=<path>"|<path>]',
      ],
      [
        "Bug #1374 single-quoted named root",
        "file://h?x=['https://e.test/t'name=\\Users\\SECRET\\x]",
        "file://h?x=['https://e.test/t'name=<path>]",
      ],
      [
        "Bug #1374 double-quoted named root",
        'file://h?x=["https://e.test/t"name=\\Users\\SECRET\\x]',
        'file://h?x=["https://e.test/t"name=<path>]',
      ],
      [
        "quoted public URL without successor",
        "file://h?x=['https://e.test/t']",
        "file://h?x=['https://e.test/t']",
      ],
      [
        "standalone quoted public URL",
        "'https://e.test/t'|\\Users\\SECRET\\x",
        "'https://e.test/t'|\\Users\\SECRET\\x",
      ],
      [
        "ordinary relative successor",
        "file://h?x=['https://e.test/t'|relative/path]",
        "file://h?x=['https://e.test/t'|relative/path]",
      ],
      [
        "public URL successor",
        "file://h?x=['https://e.test/t'|https://f.test/x]",
        "file://h?x=['https://e.test/t'|https://f.test/x]",
      ],
      [
        "POSIX-root successor",
        "file://h?x=['https://e.test/t'|/Users/SECRET/x]",
        "file://h?x=['https://e.test/t'|<path>]",
      ],
      [
        "drive-root successor",
        "file://h?x=['https://e.test/t'|C:\\Users\\SECRET\\x]",
        "file://h?x=['https://e.test/t'|<path>]",
      ],
      [
        "UNC-root successor",
        "file://h?x=['https://e.test/t'|\\\\srv\\share\\SECRET]",
        "file://h?x=['https://e.test/t'|<path>]",
      ],
      [
        "Bug #1374 W2 query-only control",
        "file://h?x=[file://host?key=/public&'https://e.test/t'&later/Users/secret]",
        "file://h?x=[file://host?key=<path>&'https://e.test/t'&later/Users/secret]",
      ],
    ] as const)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });

    const inheritedFileRootCases: Array<readonly [string, string, string]> = (["'", '"'] as const).flatMap(
      (quote) =>
        (["&", "|"] as const).flatMap((delimiter) =>
          [
            ["Windows", "\\Users\\SECRET\\x"],
            ["POSIX", "/Users/SECRET/x"],
            ["drive", "C:\\Users\\SECRET\\x"],
            ["UNC", "\\\\srv\\share\\SECRET"],
          ].map(([rootName, successor]) => [
            `${quote} inherited file quote, ${delimiter}, ${rootName} root`,
            `file://h?x=[${quote}https://outer.test/x?next=file:///Users/a/My Files/private.db${quote}${delimiter}${successor}]`,
            `file://h?x=[${quote}https://outer.test/x?next=file://<path>${quote}${delimiter}<path>]`,
          ] as const),
        ),
    );
    inheritedFileRootCases.push(
      ...(["'", '"'] as const).map((quote) => [
        `${quote} inherited file quote with private relative successor`,
        `file://h?x=[${quote}https://outer.test/x?next=file:///Users/a/My Files/private.db${quote}&later/Users/CANARY/x]`,
        `file://h?x=[${quote}https://outer.test/x?next=file://<path>${quote}&later<path>]`,
      ] as const),
      [
        "standalone inherited file quote control",
        "'https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\SECRET\\x",
        "'https://outer.test/x?next=file://<path>'|\\Users\\SECRET\\x",
      ],
      [
        "inherited file quote public successor control",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|https://f.test/x]",
        "file://h?x=['https://outer.test/x?next=file://<path>'|https://f.test/x]",
      ],
      [
        "inherited file quote ordinary relative control",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|relative/path]",
        "file://h?x=['https://outer.test/x?next=file://<path>'|relative/path]",
      ],
      ...(["'", '"'] as const).flatMap((quote) =>
        (["&", "|"] as const).map((delimiter) => [
          `${quote} inherited file quote, ${delimiter}, named Windows successor`,
          `file://h?x=[${quote}https://outer.test/x?next=file:///Users/a/My Files/private.db${quote}${delimiter}name=\\Users\\SECRET\\x]`,
          `file://h?x=[${quote}https://outer.test/x?next=file://<path>${quote}${delimiter}name=<path>]`,
        ] as const),
      ),
      [
        "inherited file quote chained rooted successors",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\SECRET\\x&\\Users\\CANARY\\y]",
        "file://h?x=['https://outer.test/x?next=file://<path>'|<path>&<path>]",
      ],
      [
        "inherited file quote later private-root relative",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\SECRET\\x&later/Users/CANARY/y]",
        "file://h?x=['https://outer.test/x?next=file://<path>'|<path>&later<path>]",
      ],
    );

    it.each(inheritedFileRootCases)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1346", () => {
    it.each([
      [
        "bare pipe opener does not re-enter sibling ownership",
        "file://host?key=/public|[relative/path]",
        "file://host?key=<path>|[relative/path]",
      ],
      [
        "path-bearing pipe sibling",
        "file://h?x=[file:///Users/b/two]|[value|\\Users\\SECRET\\y]",
        "file://h?x=[file://<path>]|[value|<path>]",
      ],
      [
        "path-bearing comma sibling",
        "file://h?x=[file:///Users/b/two],[value|\\Users\\SECRET\\y]",
        "file://h?x=[file://<path>],[value|<path>]",
      ],
      [
        "path-bearing semicolon sibling",
        "file://h?x=[file:///Users/b/two];[value|\\Users\\SECRET\\y]",
        "file://h?x=[file://<path>];[value|<path>]",
      ],
      [
        "path-bearing sibling ordinary relative control",
        "file://h?x=[file:///Users/b/two]|[later/thing]",
        "file://h?x=[file://<path>]|[later/thing]",
      ],
      [
        "path-bearing sibling private-root relative",
        "file://h?x=[file:///Users/b/two]|[later/Users/SECRET/y]",
        "file://h?x=[file://<path>]|[later<path>]",
      ],
      [
        "path-bearing sibling delimited private-root relative",
        "file://h?x=[file:///Users/b/two]|[value|later/Users/SECRET/y]",
        "file://h?x=[file://<path>]|[value|later<path>]",
      ],
      [
        "sibling query-only file children",
        "file://h?x=[file://a?key=/pub&\\Users\\S1\\x]&[file://b?key2=/pub2|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>&<path>]&[file://b?key2=<path>|<path>]",
      ],
      [
        "sibling close variant",
        "file://h?x=[file://alpha?token=/tmp&\\Users\\ALICE\\one.db]&[file://beta?token=/tmp|\\Users\\BOB\\two.db]",
        "file://h?x=[file://alpha?token=<path>&<path>]&[file://beta?token=<path>|<path>]",
      ],
      [
        "pipe-separated file sibling",
        "file://h?x=[file://a?key=/pub&\\Users\\S1\\x]|[file://b?key2=/pub2|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>&<path>]|[file://b?key2=<path>|<path>]",
      ],
      [
        "comma-separated file sibling",
        "file://h?x=[file://a?key=/pub&\\Users\\S1\\x],[file://b?key2=/pub2|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>&<path>],[file://b?key2=<path>|<path>]",
      ],
      [
        "semicolon-separated file sibling",
        "file://h?x=[file://a?key=/pub&\\Users\\S1\\x];[file://b?key2=/pub2|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>&<path>];[file://b?key2=<path>|<path>]",
      ],
      [
        "pipe-separated literal sibling",
        "file://h?x=[file://a?key=/pub]|[value|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>]|[value|<path>]",
      ],
      [
        "nested child closes before its Windows tail",
        "file://h?x=[[https://e.test/t|file://host?key=/public]\\Users\\SECRET\\x]",
        "file://h?x=[[https://e.test/t|file://host?key=<path>]<path>]",
      ],
      [
        "file wrapper closes before its Windows tail",
        "file://h?x=[file://host?key=/Users/a/private]|\\Users\\SECRET\\x",
        "file://h?x=[file://host?key=<path>]|<path>",
      ],
      [
        "Bug #1374 item 6 outward handoff",
        "file://h?x=[[[https://e.test/t|file://host?key=/public]]|\\Users\\SECRET\\x]",
        "file://h?x=[[[https://e.test/t|file://host?key=<path>]]|<path>]",
      ],
      [
        "later public sibling",
        "file://h?x=[file://a?key=/pub]&[https://e.test/t|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>]&[https://e.test/t|<path>]",
      ],
      [
        "later literal sibling",
        "file://h?x=[file://a?key=/pub]&[value|\\Users\\S2\\y]",
        "file://h?x=[file://a?key=<path>]&[value|<path>]",
      ],
      [
        "Bug #1374 W1 outward handoff",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "nested post-close tail brackets",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[[https://host?key=/Users/SECOND/secret]]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]]",
      ],
      [
        "adjacent public bracket components",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host][https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "adjacent text bracket component",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[text][https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "adjacent empty bracket component",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[][https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "adjacent nested bracket component",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[[https://host]][https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "path-word bridge between bracket components",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host]x[https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "ampersand rooted query value",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host][https://other?x=1&/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?x=1&<path>]",
      ],
      [
        "fragment rooted query value",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host][https://other#/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>#<path>]",
      ],
      [
        "question rooted query value",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host][https://other?/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?<path>]",
      ],
      [
        "backslash rooted query value",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host?key=\\Users\\SECOND\\secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "space ends post-close bracket composition",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host] [https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path> [https://other?key=/Users/SECOND/secret]",
      ],
      [
        "newline ends post-close bracket composition",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host]\n[https://other?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>\n[https://other?key=/Users/SECOND/secret]",
      ],
      [
        "whitespace-separated prose control",
        "file://h?x=[file://host?key=/public] later/thing",
        "file://h?x=[file://host?key=<path>] later/thing",
      ],
      [
        "whitespace-separated public URL control",
        "file://h?x=[file://host?key=/public] https://p.test/x",
        "file://h?x=[file://host?key=<path>] https://p.test/x",
      ],
      [
        "ordinary relative post-close control",
        "file://h?x=[file://host?key=/public]later/thing",
        "file://h?x=[file://host?key=<path>]later/thing",
      ],
    ] as const)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1374", () => {
    it.each([
      [
        "item 1 single-quoted public child",
        "file://h?x=['https://e.test/t'name=\\Users\\SECRET\\x",
        "file://h?x=['https://e.test/t'name=<path>",
      ],
      [
        "item 2 double-quoted public child",
        'file://h?x=["https://e.test/t"name=\\Users\\SECRET\\x',
        'file://h?x=["https://e.test/t"name=<path>',
      ],
      [
        "item 3 nested-file suspension control",
        "file://h?x=[[[https://e.test/t|file://host?key=/public]]|name=\\Users\\SECRET\\x]",
        "file://h?x=[[[https://e.test/t|file://host?key=<path>]]|name=<path>]",
      ],
      [
        "item 4 later public URL control",
        "file://h?x=[value|https://e.test/t|name=\\Users\\SECRET\\x]",
        "file://h?x=[value|https://e.test/t|name=<path>]",
      ],
      [
        "item 5a opaque scheme privacy decision",
        "file://h?x=[mailto:a@b|name=\\Users\\SECRET\\x]",
        "file://h?x=[mailto:a@b|name=<path>]",
      ],
      [
        "item 5b single-slash file scheme",
        "file://h?x=[file:/x|name=\\Users\\SECRET\\x]",
        "file://h?x=[file:<path>|name=<path>]",
      ],
      [
        "item 6 outward handoff",
        "file://h?x=[[[https://e.test/t|file://host?key=/public]]|\\Users\\SECRET\\x]",
        "file://h?x=[[[https://e.test/t|file://host?key=<path>]]|<path>]",
      ],
      [
        "item 7 Windows path",
        "C:\\tmp\\private[https://public.test/x]secret.db",
        "<path>",
      ],
      [
        "item 7 POSIX path",
        "/tmp/private[https://public.test/x]secret.db",
        "<path>",
      ],
      [
        "item 7 prose path",
        "error C:\\tmp\\private[https://public.test/x]secret.db failed",
        "error <path> failed",
      ],
      [
        "item 8 drive wrapper",
        "file://h?x=[C:\\Users\\SECRET\\x|name=\\Users\\SECRET\\y]",
        "file://h?x=[<path>|name=<path>]",
      ],
      [
        "W1 bracketed URL after file tail",
        "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x[https://host?key=/Users/SECOND/secret]",
        "file://h?x=[file://host?key=<path>]<path>?key=<path>]",
      ],
      [
        "W2 query-only child boundary",
        "file://h?x=[file://host?key=/public&'https://e.test/t'&later/Users/secret]",
        "file://h?x=[file://host?key=<path>&'https://e.test/t'&later/Users/secret]",
      ],
    ] as const)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1765", () => {
    type TailOrigin = readonly [
      name: string,
      prefix: string,
      expectedPrefix: string,
      closing: string,
    ];
    const postCloseTail: TailOrigin = [
      "post-close tail",
      "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x",
      "file://h?x=[file://host?key=<path>]<path>",
      "",
    ];
    const inheritedQuoteTails: TailOrigin[] = (["|", "&"] as const).flatMap((delimiter) => [
      [
        "inherited-quote successor with spaces after " + delimiter,
        "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'" +
          delimiter +
          "\\Users\\CANARY\\x",
        "file://h?x=['https://outer.test/x?next=file://<path>'" + delimiter + "<path>",
        "]",
      ] as const,
      [
        "inherited-quote successor without spaces after " + delimiter,
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'" +
          delimiter +
          "\\Users\\CANARY\\x",
        "file://h?x=['https://outer.test/x?next=file://<path>'" + delimiter + "<path>",
        "]",
      ] as const,
    ]);
    const origins: TailOrigin[] = [postCloseTail, ...inheritedQuoteTails];
    const inner = "[https://other?key=/Users/SECOND/secret]";

    const tails: Array<readonly [string, string, string]> = [
      ...["(", "{", "^", "`"].map(
        (punctuation) =>
          ["punctuation " + punctuation, punctuation + inner, "?key=<path>]"] as const,
      ),
      ...[":", ":x", ":x/y", "(", "{", "^", "`"].map(
        (bridge) =>
          ["bridge " + bridge, "[https://host]" + bridge + inner, "?key=<path>]"] as const,
      ),
      ["two bridged components", "[https://host]:x[https://mid]:y" + inner, "?key=<path>]"],
      [
        "adjacent components",
        "[https://a?key=/Users/SECOND/s][https://b?key=/Users/THIRD/s]",
        "?key=<path>][https://b?key=<path>]",
      ],
      ["nested brackets", "[[https://a?key=/Users/SECOND/s]]", "?key=<path>]]"],
      ["bracket opened inside the tail", "[x[https://a?key=/home/SECOND/s]]", "?key=<path>]]"],
      ["no punctuation", inner, "?key=<path>]"],
      ["nested exact file URL inside the bracket", "[file:///Users/NEST/x?key=/Users/SECOND/s]", "?key=<path>]"],
      ["nested exact file URL after a bridge", "[https://host]:x[file:///Users/NEST/x]", ""],
      ["public URL with a plain query", "([https://other/public/path?key=plain]", "?key=plain]"],
      ["delimiter at the end of input", "([https://other?", "?"],
      ["root-only separator run", "([https://other?key=//]", "?key=//]"],
      ["delimiter without a path word", "([https://other?key=/]", "?key=/]"],
      // The scan stopped at the query of a component, so the tail does not own what follows it.
      ["bridge after a query-bearing component", "[https://host?q=1]:x[https://other?key=/Users/SECOND/s]", "?q=1]:x[https://other?key=/Users/SECOND/s]"],
      // An unmatched close ends the tail.
      ["unmatched close", "[https://host]]:x[https://other?key=/after/close]", "]:x[https://other?key=/after/close]"],
      ["unmatched close before a component", "[https://a?key=/Users/SECOND/s]][https://other?key=/after/close]", "?key=<path>]][https://other?key=/after/close]"],
    ];
    const roots = ["Users", "home", "root"] as const;
    const runs: Array<readonly [string, (root: string) => string]> = [
      ["slash", (root) => "/" + root + "/SECOND/secret"],
      ["backslash", (root) => "\\" + root + "\\SECOND\\secret"],
      ["double slash", (root) => "//" + root + "/SECOND/secret"],
      ["double backslash", (root) => "\\\\" + root + "\\SECOND\\secret"],
      ["slash then backslash", (root) => "/\\" + root + "/SECOND/secret"],
      ["backslash then slash", (root) => "\\/" + root + "/SECOND/secret"],
    ];
    const queries: Array<readonly [string, string, string]> = [
      ["equals", "?key=", "?key="],
      ["ampersand", "?a=1&", "?a=1&"],
      ["fragment", "#", "#"],
      ["question mark", "?", "?"],
      ["fragment equals", "?q=1#key=", "?q=1#key="],
      ["ampersand equals", "?q=1&key=", "?q=1&key="],
    ];
    const values: Array<readonly [string, string, string]> = roots.flatMap((root) =>
      runs.flatMap(([runName, value]) =>
        queries.flatMap(([queryName, query, expectedQuery]) =>
          ["", "(", "[https://host]:x"].map(
            (lead) =>
              [
                root + " " + runName + " value after " + queryName + (lead === "" ? "" : " behind " + lead),
                lead + "[https://other" + query + value(root) + "]",
                expectedQuery + "<path>]",
              ] as const,
          ),
        ),
      ),
    );

    const driveValues: Array<readonly [string, string, string]> = ["C:/Users/SECOND/s", "c:/Users/SECOND/s", "D:/home/SECOND/s", "Z:/root/SECOND/s"].flatMap(
      (value) =>
        queries.flatMap(([queryName, query, expectedQuery]) =>
          ["", "(", "[https://host]:x"].map(
            (lead) =>
              [
                "forward-slash drive " + value + " after " + queryName + (lead === "" ? "" : " behind " + lead),
                lead + "[https://other" + query + value + "]",
                expectedQuery + "<path>]",
              ] as const,
          ),
        ),
    );

    describe.each(origins)("%s", (_origin, prefix, expectedPrefix, closing) => {
      it.each([...tails, ...values, ...driveValues])("%s", (_name, tail, expectedTail) => {
        const first = sanitizeError(prefix + tail + closing);

        expect(first).toBe(expectedPrefix + expectedTail + closing);
        expect(sanitizeError(first)).toBe(first);
        expect(sanitizeError(sanitizeError(first))).toBe(first);
      });

      it.each([
        ["space", " "],
        ["tab", "\t"],
        ["newline", "\n"],
      ])("keeps a bracketed URL after %s visible", (_name, whitespace) => {
        const input = prefix + whitespace + "([https://other?key=/after/space]" + closing;
        const first = sanitizeError(input);

        expect(first).toBe(expectedPrefix + whitespace + "([https://other?key=/after/space]" + closing);
        expect(sanitizeError(first)).toBe(first);
        expect(sanitizeError(sanitizeError(first))).toBe(first);
      });
    });

    describe.each(inheritedQuoteTails)("%s", (_origin, prefix, expectedPrefix, closing) => {
      it.each(["&", "|"])("redacts a private-root relative value after %s inside the owned bracket", (delimiter) => {
        for (const [value, expectedValue] of [
          ["later/Users/SECOND/s", "later<path>"],
          ["Users/SECOND/s", "Users<path>"],
          ["later/home/SECOND/s", "later<path>"],
          ["later/root/SECOND/s", "later<path>"],
          ["a/b/Users/SECOND/s", "a<path>"],
          ["later//Users//SECOND/s", "later<path>"],
        ] as const) {
          const first = sanitizeError(prefix + "([https://other?a=1" + delimiter + value + "]" + closing);

          expect(first).toBe(expectedPrefix + "?a=1" + delimiter + expectedValue + "]" + closing);
          expect(sanitizeError(first)).toBe(first);
          expect(sanitizeError(sanitizeError(first))).toBe(first);
        }
      });

      it.each(["&", "|"])("keeps ordinary, incomplete, and public values after %s readable", (delimiter) => {
        for (const value of [
          "later/data/SECOND/s",
          "later/Users",
          "later/Users/",
          "https://p.test/x",
          "plain",
        ]) {
          const first = sanitizeError(prefix + "([https://other?a=1" + delimiter + value + "]" + closing);

          expect(first).toBe(expectedPrefix + "?a=1" + delimiter + value + "]" + closing);
          expect(sanitizeError(first)).toBe(first);
          expect(sanitizeError(sanitizeError(first))).toBe(first);
        }
      });
    });

    it.each(["&", "|"])("keeps a post-close private-root relative value after %s readable", (delimiter) => {
      const input = postCloseTail[1] + "([https://other?a=1" + delimiter + "later/Users/SECOND/s]";
      const first = sanitizeError(input);

      expect(first).toBe(postCloseTail[2] + "?a=1" + delimiter + "later/Users/SECOND/s]");
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });

    it.each(["C:/Users/S/s", "c:/home/S/s"])("keeps a standalone public URL drive value %s unchanged", (value) => {
      const input = "[https://other?key=" + value + "]";

      expect(sanitizeError(input)).toBe(input);
      expect(sanitizeError(sanitizeError(input))).toBe(input);
    });

    it.each([
      [
        "slash successor",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'|/Users/CANARY/x[https://host]:x" + inner + "]",
        "file://h?x=['https://outer.test/x?next=file://<path>'|<path>?key=<path>]]",
      ],
      [
        "drive successor",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'&C:\\Users\\CANARY\\x(" + inner + "]",
        "file://h?x=['https://outer.test/x?next=file://<path>'&<path>?key=<path>]]",
      ],
      [
        "private-root successor",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'&later/Users/CANARY/x[https://host]:x" + inner + "]",
        "file://h?x=['https://outer.test/x?next=file://<path>'&later<path>?key=<path>]]",
      ],
      [
        "ordinary relative successor stays readable",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'&later/data[https://host]:x" + inner + "]",
        "file://h?x=['https://outer.test/x?next=file://<path>'&later/data[https://host]:x" + inner + "]",
      ],
      [
        "public URL successor stays readable",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'&https://p.test/x" + inner + "]",
        "file://h?x=['https://outer.test/x?next=file://<path>'&https://p.test/x" + inner + "]",
      ],
    ] as const)("pins the inherited-quote %s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  describe("Bug #1766", () => {
    // These pin the documented boundary of the inherited quote owner. The
    // whitespace-separated outputs deliberately keep the successor readable:
    // #1766 corrects docs/privacy.md instead of widening runtime ownership.
    const base = "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'";
    const redactedBase = "file://h?x=['https://outer.test/x?next=file://<path>'";
    const successor = "\\Users\\SECRET\\x]";
    const cases: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
      ["immediate pipe hands off the owner", base + "|" + successor, redactedBase + "|<path>]"],
      ["space before pipe prevents the handoff", base + " |" + successor, redactedBase + " |" + successor],
      ["tab before pipe prevents the handoff", base + "\t|" + successor, redactedBase + "\t|" + successor],
      ["newline before pipe prevents the handoff", base + "\n|" + successor, redactedBase + "\n|" + successor],
      ["carriage return before pipe prevents the handoff", base + "\r|" + successor, redactedBase + "\r|" + successor],
      [
        "non-breaking space before pipe prevents the handoff",
        base + "\u00a0|" + successor,
        redactedBase + "\u00a0|" + successor,
      ],
      ["space after pipe resets ownership", base + "| " + successor, redactedBase + "| " + successor],
      ["tab after pipe resets ownership", base + "|\t" + successor, redactedBase + "|\t" + successor],
      ["space before ampersand prevents the handoff", base + " &" + successor, redactedBase + " &" + successor],
      ["semicolon is not a handoff delimiter", base + ";" + successor, redactedBase + ";" + successor],
      ["a non-delimiter is not a handoff", base + "x" + successor, redactedBase + "x" + successor],
      [
        "later rooted successor after an immediate handoff",
        base + "|\\Users\\SECRET\\x&\\Users\\LATER\\y]",
        redactedBase + "|<path>&<path>]",
      ],
      [
        "later ordinary relative successor stays readable",
        base + "|\\Users\\SECRET\\x&later/var/data]",
        redactedBase + "|<path>&later/var/data]",
      ],
      [
        "whitespace after a later delimiter resets ownership",
        base + "|\\Users\\SECRET\\x& \\Users\\LATER\\y]",
        redactedBase + "|<path>& \\Users\\LATER\\y]",
      ],
    ];

    it.each(cases)("%s on every pass", (_name, input, expected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);
      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });
  });

  describe("Bug #1779", () => {
    const targets: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
      [
        "home successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "var successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/var/data]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "Users successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/Users/alice]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "root successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/root/x]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "case-insensitive successor",
        "file://h?x=[file:///Users/CHILD/x&Later\\/HOME/alice]",
        "file://h?x=[file://<path>&Later\\<path>]",
      ],
      [
        "ordinary path word after the slash",
        "file://h?x=[file:///Users/CHILD/x&later\\/homes/alice]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "multiple leading backslashes",
        "file://h?x=[file:///Users/CHILD/x&later\\\\/x]",
        "file://h?x=[file://<path>&later\\\\<path>]",
      ],
      [
        "public URL text after the slash",
        "file://h?x=[file:///Users/CHILD/x&later\\/https://public.test/x]",
        "file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "two ampersand successors",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/a&second\\/var/b]",
        "file://h?x=[file://<path>&later\\<path>&second\\<path>]",
      ],
      [
        "nested file child in a non-file owner",
        "https://h?x=[file:///Users/CHILD/x&later\\/home/alice]",
        "https://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "unclosed wrapper",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice",
        "file://h?x=[file://<path>&later\\<path>",
      ],
      [
        "successor followed by a bracketed URL",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>]",
      ],
    ];

    const controls: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
      [
        "pipe home successor",
        "file://h?x=[file:///Users/CHILD/x|later\\/home/alice]",
        "file://h?x=[file://<path>|later\\<path>]",
      ],
      [
        "pipe var successor",
        "file://h?x=[file:///Users/CHILD/x|later\\/var/data]",
        "file://h?x=[file://<path>|later\\<path>]",
      ],
      [
        "separator run without a path word",
        "file://h?x=[file:///Users/CHILD/x&later\\/]",
        "file://h?x=[file://<path>&later\\/]",
      ],
      [
        "word before the slash",
        "file://h?x=[file:///Users/CHILD/x&later\\x/y]",
        "file://h?x=[file://<path>&later\\x/y]",
      ],
      [
        "backslash-only value",
        "file://h?x=[file:///Users/CHILD/x&later\\home]",
        "file://h?x=[file://<path>&later\\home]",
      ],
      [
        "backslash-only path",
        "file://h?x=[file:///Users/CHILD/x&later\\home\\alice]",
        "file://h?x=[file://<path>&later\\home\\alice]",
      ],
      [
        "query child",
        "file://h?x=[file:///Users/CHILD/x?y=1&later\\/home/alice]",
        "file://h?x=[file://<path>?y=1&later<path>]",
      ],
      [
        "fragment child after ampersand",
        "file://h?x=[file:///Users/CHILD/x#f&later\\/var/data]",
        "file://h?x=[file://<path>#f&later<path>]",
      ],
      [
        "fragment child after pipe",
        "file://h?x=[file:///Users/CHILD/x#f|later\\/home/alice]",
        "file://h?x=[file://<path>#f|later\\<path>]",
      ],
      [
        "pathless child",
        "file://h?x=[file://host&later\\/home/alice]",
        "file://h?x=[file://host&later<path>]",
      ],
      [
        "forward-slash private relative",
        "file://h?x=[file:///Users/CHILD/x&later/home/alice]",
        "file://h?x=[file://<path>&later<path>]",
      ],
      [
        "forward-slash ordinary relative",
        "file://h?x=[file:///Users/CHILD/x&later/var/data]",
        "file://h?x=[file://<path>&later/var/data]",
      ],
      [
        "unrelated public URL",
        "https://public.test/a\\/var/data",
        "https://public.test/a\\/var/data",
      ],
      [
        "public URL query value",
        "https://e.test/x?next=later\\/var/data",
        "https://e.test/x?next=later\\/var/data",
      ],
      [
        "whole-message quoted wrapper",
        "'file://h?x=[file:///Users/CHILD/x&later\\/home/alice]'",
        "'file://h?x=[file://<path>'",
      ],
    ];

    const reviewedRegressions: ReadonlyArray<
      readonly [name: string, input: string, expected: string]
    > = [
      [
        "later private-relative query value",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s([https://other?a=1&later/home/SECOND/secret]",
        "file://h?x=[file://<path>&later\\<path>?a=1&later<path>]",
      ],
      [
        "named private-relative query value",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s([https://other?key=later/home/S/s]",
        "file://h?x=[file://<path>&later\\<path>?key=later<path>]",
      ],
      [
        "colon-slash query value",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s([https://other?key=XY:/Users/S/s]",
        "file://h?x=[file://<path>&later\\<path>?key=XY:<path>]",
      ],
      [
        "second rooted query value",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s?key=/Users/Z([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>?key=<path>]",
      ],
      [
        "query-ended second bracket",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s[https://a?q=plain]:x[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later\\<path>?q=plain]:x[https://other?key=<path>]",
      ],
      [
        "slash-only query value",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s([https://other?key=/]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>]",
      ],
      [
        "pipe public URL path",
        "file://h?x=[file:///Users/CHILD/x|later\\/https://public.test/x/s([https://other?key=plain]",
        "file://h?x=[file://<path>|later\\<path>?key=plain]",
      ],
      [
        "pipe private-looking public URL path",
        "file://h?x=[file:///Users/CHILD/x|later\\/https://public.test/Users/SECRET/x([https://other?key=plain]",
        "file://h?x=[file://<path>|later\\<path>?key=plain]",
      ],
      [
        "inherited-quote public URL path",
        "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'&later\\/https://public.test/x/s([https://other?key=C:\\Users\\SECRET2\\x]",
        "file://h?x=['https://outer.test/x?next=file://<path>'&later\\<path>?key=<path>]",
      ],
      [
        "ampersand backslash drive successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/C:\\Users\\x]",
        "file://h?x=[file://<path>&later\\/<path>]",
      ],
      [
        "ampersand lowercase drive successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/c:\\Users\\x]",
        "file://h?x=[file://<path>&later\\/<path>]",
      ],
      [
        "ampersand home drive successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/D:\\home\\x]",
        "file://h?x=[file://<path>&later\\/<path>]",
      ],
      [
        "multiple backslashes before a drive successor",
        "file://h?x=[file:///Users/CHILD/x&later\\\\/C:\\Users\\x]",
        "file://h?x=[file://<path>&later\\\\/<path>]",
      ],
      [
        "UNC root after the mixed separator",
        "file://h?x=[file:///Users/CHILD/x&later\\/\\\\Users\\x]",
        "file://h?x=[file://<path>&later\\/<path>]",
      ],
      [
        "pipe forward-slash drive successor",
        "file://h?x=[file:///Users/CHILD/x|later\\/C:/Users/x]",
        "file://h?x=[file://<path>|later\\<path>:<path>]",
      ],
      [
        "mixed successor after a public URL",
        "file://h?x=[file:///Users/CHILD/x&https://public.test/x&later\\/var/b]",
        "file://h?x=[file://<path>&https://public.test/x&later\\/var/b]",
      ],
      [
        "private-looking mixed successor after a public URL",
        "file://h?x=[file:///Users/CHILD/x&https://public.test/x&later\\/home/b]",
        "file://h?x=[file://<path>&https://public.test/x&later\\/home/b]",
      ],
      [
        "mixed successor after plain text",
        "file://h?x=[file:///Users/CHILD/x&plain&later\\/home/b]",
        "file://h?x=[file://<path>&plain&later\\<path>]",
      ],
      [
        "mixed successor after an ordinary relative",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/a&second/var/b&third\\/var/c]",
        "file://h?x=[file://<path>&later\\<path>&second/var/b&third\\<path>]",
      ],
      [
        "glued independent target copies",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice]file://h?x=[file:///Users/CHILD/x&later\\/home/alice]",
        "file://h?x=[file://<path>&later\\<path>]file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "space-separated independent target copies",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice] file://h?x=[file:///Users/CHILD/x&later\\/home/alice]",
        "file://h?x=[file://<path>&later\\<path>] file://h?x=[file://<path>&later\\<path>]",
      ],
      [
        "newline-separated independent target copies",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice]\nfile://h?x=[file:///Users/CHILD/x&later\\/home/alice]",
        "file://h?x=[file://<path>&later\\<path>]\nfile://h?x=[file://<path>&later\\<path>]",
      ],
    ];

    const reviewedPassSequences: ReadonlyArray<
      readonly [name: string, input: string, first: string, second: string, third: string]
    > = [
      [
        "preserved drive before a later mixed successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/C:/Users/x&second\\/var/b([https://other?key=/Users/S2/x]",
        "file://h?x=[file://<path>&later\\/C:/Users/x&second\\/var/b([https://other?key=<path>]",
        "file://h?x=[file://<path>&later\\<path>:<path>&second\\<path>?key=<path>]",
        "file://h?x=[file://<path>&later\\<path>:<path>&second\\<path>?key=<path>]",
      ],
      [
        "ordinary second successor before a bracket",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/alice&second/var/b([https://other?key=/Users/S2/x]",
        "file://h?x=[file://<path>&later\\/home/alice&second/var/b([https://other?key=<path>]",
        "file://h?x=[file://<path>&later\\<path>&second/var/b([https://other?key=<path>]",
        "file://h?x=[file://<path>&later\\<path>&second/var/b([https://other?key=<path>]",
      ],
      [
        "non-path mixed value",
        "file://h?x=[file:///Users/CHILD/x&=later\\/home/alice]",
        "file://h?x=[file://<path>&=later\\/home/alice]",
        "file://h?x=[file://<path>&=later\\<path>]",
        "file://h?x=[file://<path>&=later\\<path>]",
      ],
      [
        "mixed successor after a non-path value",
        "file://h?x=[file:///Users/CHILD/x&=x&later\\/home/alice]",
        "file://h?x=[file://<path>&=x&later\\/home/alice]",
        "file://h?x=[file://<path>&=x&later\\<path>]",
        "file://h?x=[file://<path>&=x&later\\<path>]",
      ],
      [
        "colon-stop XY successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/XY:/Users/S/s]",
        "file://h?x=[file://<path>&later\\/XY:/Users/S/s]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
      ],
      [
        "colon-stop mailto successor",
        "file://h?x=[file:///Users/CHILD/x&later\\/mailto:/Users/S/s]",
        "file://h?x=[file://<path>&later\\/mailto:/Users/S/s]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
      ],
      [
        "invalid numeric authority prefix",
        "file://h?x=[file:///Users/CHILD/x&later\\/1://Users/S/s]",
        "file://h?x=[file://<path>&later\\/1://Users/S/s]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
        "file://h?x=[file://<path>&later\\<path>:<path>]",
      ],
      [
        "claimed sibling before refused forward drive",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/a&later\\/C:/Users/x]",
        "file://h?x=[file://<path>&later\\<path>&later\\/C:/Users/x]",
        "file://h?x=[file://<path>&later\\<path>&later\\<path>:<path>]",
        "file://h?x=[file://<path>&later\\<path>&later\\<path>:<path>]",
      ],
      [
        "claimed sibling before refused file URL",
        "file://h?x=[file:///Users/CHILD/x&later\\/home/a&later\\/file:///Users/NEST/x]",
        "file://h?x=[file://<path>&later\\<path>&later\\/file://<path>]",
        "file://h?x=[file://<path>&later\\<path>&later\\<path><path>]",
        "file://h?x=[file://<path>&later\\<path>&later\\<path><path>]",
      ],
    ];

    it.each(targets)("redacts the %s on the first pass", (_name, input, expected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });

    it.each(controls)("keeps the %s stable", (_name, input, expected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });

    it.each(reviewedRegressions)("preserves the reviewed %s", (_name, input, expected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });

    it.each(reviewedPassSequences)(
      "preserves the reviewed %s pass sequence",
      (_name, input, expectedFirst, expectedSecond, expectedThird) => {
        const first = sanitizeError(input);
        const second = sanitizeError(first);
        const third = sanitizeError(second);

        expect(first).toBe(expectedFirst);
        expect(second).toBe(expectedSecond);
        expect(third).toBe(expectedThird);
      },
    );
  });

  describe("Bug #1785", () => {
    const assertStable = (input: string, expected: string): void => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    };

    const postClose = "file://h?x=[file://host?key=/public]\\Users\\FIRST\\x";
    const redactedPostClose = "file://h?x=[file://host?key=<path>]<path>";
    const rootedInner = "([https://other?key=/Users/SECOND/secret]";

    it.each([
      ["vertical tab", "\u000b"],
      ["form feed", "\u000c"],
      ["no-break space", "\u00a0"],
      ["Ogham space mark", "\u1680"],
      ["en quad", "\u2000"],
      ["em quad", "\u2001"],
      ["en space", "\u2002"],
      ["em space", "\u2003"],
      ["three-per-em space", "\u2004"],
      ["four-per-em space", "\u2005"],
      ["six-per-em space", "\u2006"],
      ["figure space", "\u2007"],
      ["punctuation space", "\u2008"],
      ["thin space", "\u2009"],
      ["hair space", "\u200a"],
      ["line separator", "\u2028"],
      ["paragraph separator", "\u2029"],
      ["narrow no-break space", "\u202f"],
      ["medium mathematical space", "\u205f"],
      ["ideographic space", "\u3000"],
      ["byte order mark", "\ufeff"],
    ] as const)("keeps the measured tail through %s", (_name, whitespace) => {
      assertStable(
        postClose + whitespace + rootedInner,
        redactedPostClose + "?key=<path>]",
      );
    });

    it("keeps the measured tail through consecutive no-break spaces", () => {
      assertStable(
        postClose + "\u00a0\u00a0" + rootedInner,
        redactedPostClose + "?key=<path>]",
      );
    });

    it("uses the owned-drive rule after a no-break space", () => {
      assertStable(
        postClose + "\u00a0([https://other?key=C:/Users/SECOND/s]",
        redactedPostClose + "?key=<path>]",
      );
    });

    it.each([
      ["space", " "],
      ["tab", "\t"],
      ["line feed", "\n"],
      ["carriage return", "\r"],
    ] as const)("hard-resets the tail at %s", (_name, whitespace) => {
      assertStable(
        postClose + whitespace + rootedInner,
        redactedPostClose + whitespace + rootedInner,
      );
    });

    it.each([
      [
        "colon bridge after no-break space",
        postClose + "\u00a0:x[https://other?key=/Users/SECOND/secret]",
        redactedPostClose + ":x[https://other?key=/Users/SECOND/secret]",
      ],
      [
        "unmatched close before no-break space",
        postClose + "]\u00a0([[https://other?key=/Users/SECOND/secret]]",
        redactedPostClose + "]\u00a0([[https://other?key=/Users/SECOND/secret]]",
      ],
      [
        "plain value after no-break space",
        postClose + "\u00a0([https://other?key=plain]",
        redactedPostClose + "?key=plain]",
      ],
      [
        "public URL value after no-break space",
        postClose + "\u00a0([https://other?key=https://public.test/x]",
        redactedPostClose + "?key=https://public.test/x]",
      ],
      [
        "opaque mail value after no-break space",
        postClose + "\u00a0([https://other?key=mailto:user@public.test]",
        redactedPostClose + "?key=mailto:user@public.test]",
      ],
      [
        "zero-width space already keeps ownership",
        postClose + "\u200b" + rootedInner,
        redactedPostClose + "?key=<path>]",
      ],
    ] as const)("preserves the measured-tail control: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    const inherited =
      "file://h?x=['https://outer.test/x?next=file:///Users/a/private.db'|\\Users\\CANARY\\x";
    const redactedInherited =
      "file://h?x=['https://outer.test/x?next=file://<path>'|<path>";

    it.each([
      [
        "private-root second successor",
        inherited + "&second/Users/B/x[https://inner?key=/home/C/s]]",
        redactedInherited + "&second<path>?key=<path>]]",
      ],
      [
        "rooted second successor",
        inherited + "&/Users/B/x[https://inner?key=/home/C/s]]",
        redactedInherited + "&<path>?key=<path>]]",
      ],
      [
        "pipe-delimited second successor",
        inherited + "|second/Users/B/x[https://inner?key=/home/C/s]]",
        redactedInherited + "|second<path>?key=<path>]]",
      ],
      [
        "third claimed successor",
        inherited +
          "&second/Users/B/x&third/home/C/x[https://inner?key=/home/C/s]]",
        redactedInherited + "&second<path>&third<path>?key=<path>]]",
      ],
    ] as const)("re-arms an inherited tail for a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "ordinary second successor",
        inherited + "&second/var/B/x[https://inner?key=/home/C/s]]",
        redactedInherited + "&second/var/B/x[https://inner?key=/home/C/s]]",
      ],
      [
        "plain value after a claimed successor",
        inherited + "&second/Users/B/x[https://inner?key=plain]]",
        redactedInherited + "&second<path>?key=plain]]",
      ],
      [
        "public URL value after a claimed successor",
        inherited + "&second/Users/B/x[https://inner?key=https://public.test/x]]",
        redactedInherited + "&second<path>?key=https://public.test/x]]",
      ],
    ] as const)("preserves the inherited-tail control: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    const integratedInheritedPrefix =
      "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'";
    const integratedRedactedPrefix =
      "file://h?x=['https://outer.test/x?next=file://<path>'";

    it.each([
      [
        "zero-width immediate bracket composition",
        integratedInheritedPrefix +
          "\u200b|\\Users\\SECRET\\x[https://inner?key=/home/C/s]]",
        integratedRedactedPrefix + "\u200b|<path>?key=<path>]]",
      ],
      [
        "zero-width handoff with a claimed second successor",
        integratedInheritedPrefix +
          "\u200b|\\Users\\SECRET\\x&second/Users/B/x" +
          "[https://inner?key=/home/C/s]]",
        integratedRedactedPrefix +
          "\u200b|<path>&second<path>?key=<path>]]",
      ],
    ] as const)("stabilizes the inherited-quote integration: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    const mixedSuccessorPrefix =
      "file://h?x=[file:///Users/CHILD/x&later\\/home/alice/s";

    it.each([
      [
        "rooted query value",
        mixedSuccessorPrefix + "([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>]",
      ],
      [
        "drive query value uses X1",
        mixedSuccessorPrefix + "([https://other?key=C:/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>]",
      ],
      [
        "colon-single-slash query value",
        mixedSuccessorPrefix + "([https://other?key=XY:/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=XY:<path>]",
      ],
      [
        "queryless consumed-component bridge",
        mixedSuccessorPrefix +
          "[https://host]:x[https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later\\<path>?key=<path>]",
      ],
      [
        "private-relative query stays readable",
        mixedSuccessorPrefix + "?key=later/home/S/s]",
        "file://h?x=[file://<path>&later\\<path>?key=later/home/S/s]",
      ],
    ] as const)("stabilizes the mixed-successor integration: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "backslash restart with a rooted value",
        "file://h?x=[a]\\b[https://other?key=/Users/S/s]",
        "file://h?x=[a]<path>?key=<path>]",
      ],
      [
        "slash restart with a rooted value",
        "file://h?x=[a]/b[https://other?key=/Users/S/s]",
        "file://h?x=[a]<path>?key=<path>]",
      ],
      [
        "backslash restart with a public rooted value",
        "file://h?x=[a]\\b[https://other?key=/public/docs]",
        "file://h?x=[a]<path>?key=<path>]",
      ],
      [
        "backslash restart with a drive value",
        "file://h?x=[a]\\b[https://other?key=C:/Users/S/s]",
        "file://h?x=[a]<path>?key=<path>]",
      ],
    ] as const)("owns a bracket after a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      ["private-looking relative value", "later/home/S/s"],
      ["plain value", "plain"],
      ["public URL value", "https://public.test/x"],
      ["opaque mail value", "mailto:user@public.test"],
    ] as const)("keeps a restarted-pathless %s visible", (_name, value) => {
      assertStable(
        "file://h?x=[a]\\b[https://other?key=" + value + "]",
        "file://h?x=[a]<path>?key=" + value + "]",
      );
    });

    const ownedValuePrefix = postClose + "([https://other?key=";
    const redactedOwnedValuePrefix = redactedPostClose + "?key=";

    it.each([
      ["alphabetic prefix", "XY:/Users/S/s", "XY:<path>"],
      ["public-looking path", "XY:/public/docs", "XY:<path>"],
      ["second alphabetic prefix", "AB:/Users/S/s", "AB:<path>"],
      ["numeric prefix", "1:/Users/x", "1:<path>"],
      ["empty prefix", ":/Users/x", ":<path>"],
      ["mail scheme text", "mailto:/Users/S/s", "mailto:<path>"],
      ["file scheme text", "file:/Users/S/s", "file:<path>"],
      ["slash-bearing prefix", "ab/cd:/Users/S/s", "ab/cd:<path>"],
    ] as const)("redacts the single-slash owned value with %s", (_name, value, expected) => {
      assertStable(
        ownedValuePrefix + value + "]",
        redactedOwnedValuePrefix + expected + "]",
      );
    });

    it.each([
      "https://public.test/x",
      "https://public.test/Users/secret",
      "http://public.test/a",
      "XY://Users/S/s",
      "custom+scheme://host/x",
      "git://host/repo",
      "12:30/Users/S/s",
      "XY:\\Users\\S\\s",
      "mailto:user@public.test",
      "note",
      "later/var/data",
      ":/",
      "XY:/",
      "XY:////",
      "/",
    ] as const)("keeps the owned value %s visible", (value) => {
      assertStable(
        ownedValuePrefix + value + "]",
        redactedOwnedValuePrefix + value + "]",
      );
    });

    it("does not claim a colon-single-slash value outside an owned bracket", () => {
      const input = "https://e.test/x?key=XY:/Users/S/s";

      assertStable(input, input);
    });

    const activeChild = "file://h?x=[file:///Users/CHILD/x";

    it.each([
      [
        "private-root successor with punctuation",
        activeChild + "&later/home/alice/s([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later<path>?key=<path>]",
      ],
      [
        "private-root successor without punctuation",
        activeChild + "&later/home/alice/s[https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later<path>?key=<path>]",
      ],
      [
        "rooted successor with a drive value",
        activeChild + "&/Users/alice/s([https://other?key=C:/Users/SECRET2/x]",
        "file://h?x=[file://<path>&<path>?key=<path>]",
      ],
      [
        "private-root successor with a drive value",
        activeChild + "&later/home/alice/s([https://other?key=C:/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later<path>?key=<path>]",
      ],
      [
        "private-root value inside the owned bracket",
        activeChild +
          "&later/Users/alice/s([https://other?a=1&later/home/SECOND/secret]",
        "file://h?x=[file://<path>&later<path>?a=1&later<path>]",
      ],
      [
        "pipe-delimited private-root successor",
        activeChild + "|a/b//root//s([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>|a<path>?key=<path>]",
      ],
      [
        "successor with its own rooted query",
        activeChild +
          "&later/home/alice/s?key=/Users/Z([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later<path>?key=<path>?key=<path>]",
      ],
      [
        "public URL before the claimed successor",
        activeChild +
          "&https://e.test/x&later/home/bob/s([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&https://e.test/x&later<path>?key=<path>]",
      ],
      [
        "consumed-component bridge",
        activeChild +
          "&later/home/alice/s[https://host]:x[https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later<path>?key=<path>]",
      ],
      [
        "inherited quote around a private-root successor",
        "file://h?x=[file:///Users/CHILD/x?next=['https://outer.test/x?next=" +
          "file:///Users/a/private.db'&later/home/CANARY/x" +
          "[https://other?key=/Users/SECRET2/x]]]",
        "file://h?x=[file://<path>?next=['https://outer.test/x?next=file://<path>'" +
          "&later<path>?key=<path>]]]",
      ],
      [
        "inherited quote around a rooted Windows successor",
        "file://h?x=[file:///Users/CHILD/x?next=['https://outer.test/x?next=" +
          "file:///Users/a/private.db'&\\Users\\CANARY\\x" +
          "[https://other?key=/Users/SECRET2/x]]]",
        "file://h?x=[file://<path>?next=['https://outer.test/x?next=file://<path>'" +
          "&<path>?key=<path>]]]",
      ],
    ] as const)("owns a bracket after an active-child %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "ordinary successor",
        activeChild + "&later/var/data([https://other?key=/Users/SECRET2/x]",
        "file://h?x=[file://<path>&later/var/data([https://other?key=<path>]",
      ],
      [
        "ordinary inner value",
        activeChild + "&later/home/alice/s([https://other?a=1&later/var/data]",
        "file://h?x=[file://<path>&later<path>?a=1&later/var/data]",
      ],
      [
        "query-ended bridge",
        activeChild +
          "&later/home/alice/s[https://a?q=plain]:x[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later<path>?q=plain]:x" +
          "[https://other?key=/Users/SECOND/s]",
      ],
      [
        "query without an equals sign",
        activeChild +
          "&later/home/alice/s?plain([https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later<path>?plain" +
          "([https://other?key=/Users/SECOND/s]",
      ],
      [
        "query without a name",
        activeChild +
          "&later/home/alice/s?=plain([https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later<path>?=plain" +
          "([https://other?key=/Users/SECOND/s]",
      ],
      [
        "space before bracket punctuation",
        activeChild + "&later/home/alice/s ([https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later<path> ([https://other?key=/Users/SECOND/s]",
      ],
    ] as const)("preserves the active-child control: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "measured whitespace tail",
        postClose +
          "\u00a0([https://first?key=plain][https://other?key=/Users/SECOND/s]",
        redactedPostClose + "?key=plain][https://other?key=/Users/SECOND/s]",
      ],
      [
        "later inherited successor",
        inherited +
          "&second/Users/B/x([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        redactedInherited +
          "&second<path>?key=plain][https://other?key=/Users/SECOND/s]",
      ],
      [
        "restarted backslash wrapper",
        "file://h?x=[a]\\b([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[a]<path>?key=plain][https://other?key=/Users/SECOND/s]",
      ],
      [
        "restarted slash wrapper",
        "file://h?x=[a]/b([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[a]<path>?key=plain][https://other?key=/Users/SECOND/s]",
      ],
      [
        "active private-root successor",
        activeChild +
          "&later/home/alice/s([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&later<path>?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
      ],
      [
        "active rooted successor",
        activeChild +
          "&/Users/alice/s([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&<path>?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
      ],
      [
        "active pipe successor",
        activeChild +
          "|a/b//root//s([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>|a<path>?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
      ],
      [
        "active successor after a public URL",
        activeChild +
          "&https://e.test/x&later/home/bob/s([https://first?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
        "file://h?x=[file://<path>&https://e.test/x&later<path>?key=plain]" +
          "[https://other?key=/Users/SECOND/s]",
      ],
    ] as const)(
      "ends %s ownership after a plain query component",
      (_name, input, expected) => {
        assertStable(input, expected);
      },
    );

    it("retains direct post-close ownership across adjacent components", () => {
      assertStable(
        postClose +
          "([https://first?key=plain][https://other?key=/Users/SECOND/s]",
        redactedPostClose + "?key=plain][https://other?key=<path>]",
      );
    });

    it.each(
      (["", "\u200b", "\u200c", "\u200d", "\u2060"] as const).flatMap(
        (interposer) =>
          (["|", "&"] as const).map((delimiter) => [
            `${interposer === "" ? "immediate" : "invisible-run"} ${delimiter} handoff`,
            integratedInheritedPrefix +
              interposer +
              delimiter +
              "\\Users\\CANARY\\x([https://first?key=plain]" +
              "[https://second?key=/home/B/y]",
            integratedRedactedPrefix +
              interposer +
              delimiter +
              "<path>?key=plain][https://second?key=<path>]",
          ] as const),
      ),
    )("retains original inherited adjacency for %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "private-relative value after an ampersand handoff",
        integratedInheritedPrefix +
          "&\\Users\\CANARY\\x[https://first?key=plain]" +
          "[https://second?a=1&later/home/B/y]",
        integratedRedactedPrefix +
          "&<path>?key=plain][https://second?a=1&later<path>]",
      ],
      [
        "drive value after an invisible pipe handoff",
        integratedInheritedPrefix +
          "\u200b|\\Users\\CANARY\\x([https://first?key=plain]" +
          "[https://second?key=C:/Users/B/y]",
        integratedRedactedPrefix +
          "\u200b|<path>?key=plain][https://second?key=<path>]",
      ],
      [
        "rooted successor without an opening parenthesis",
        integratedInheritedPrefix +
          "|/Users/CANARY/x[https://first?key=plain]" +
          "[https://second?key=/var/data]",
        integratedRedactedPrefix +
          "|<path>?key=plain][https://second?key=<path>]",
      ],
      [
        "private-root relative successor",
        integratedInheritedPrefix +
          "|later/Users/CANARY/x([https://first?key=plain]" +
          "[https://second?key=/home/B/y]",
        integratedRedactedPrefix +
          "|later<path>?key=plain][https://second?key=<path>]",
      ],
    ] as const)("retains the inherited-adjacency variant: %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "soft-whitespace origin",
        postClose +
          "\u00a0([https://first?key=/Users/A/x]" +
          "[https://second?key=/home/B/y]",
        redactedPostClose + "?key=<path>][https://second?key=/home/B/y]",
      ],
      [
        "later-successor origin",
        inherited +
          "&second/Users/B/x([https://first?key=/Users/A/x]" +
          "[https://second?key=/home/B/y]]",
        redactedInherited +
          "&second<path>?key=<path>][https://second?key=/home/B/y]]",
      ],
      [
        "restarted-wrapper origin",
        "file://h?x=[a]\\b([https://first?key=/Users/A/x]" +
          "[https://second?key=/home/B/y]",
        "file://h?x=[a]<path>?key=<path>][https://second?key=/home/B/y]",
      ],
      [
        "active-child origin",
        activeChild +
          "&later/home/alice/s([https://first?key=/Users/A/x]" +
          "[https://second?key=/home/B/y]",
        "file://h?x=[file://<path>&later<path>?key=<path>]" +
          "[https://second?key=/home/B/y]",
      ],
    ] as const)("limits %s to its first component", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "direct post-close owner",
        postClose +
          "([https://first?key=plain][https://second?key=XY:/Users/B/y]",
        redactedPostClose +
          "?key=plain][https://second?key=XY:/Users/B/y]",
      ],
      [
        "immediate inherited owner",
        inherited +
          "([https://first?key=/Users/A/x]" +
          "[https://second?key=XY:/Users/B/y]",
        redactedInherited +
          "?key=<path>][https://second?key=XY:/Users/B/y]",
      ],
      [
        "soft-whitespace owner",
        postClose +
          "\u00a0([https://first?key=/Users/A/x]" +
          "[https://second?key=mailto:/Users/B/y]",
        redactedPostClose +
          "?key=<path>][https://second?key=mailto:/Users/B/y]",
      ],
    ] as const)("keeps second-component colon text for %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "single-segment restarted slash tail",
        "file://h?x=[a]/b([https://inner?key=\\server\\share\\secret]",
        "file://h?x=[a]<path>?key=\\server\\share\\secret]",
      ],
      [
        "multi-segment restarted slash tail",
        "file://h?x=[a]/bc/de([https://inner?key=\\server\\share\\secret]",
        "file://h?x=[a]<path>?key=\\server\\share\\secret]",
      ],
    ] as const)("keeps the base UNC value for a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "soft-whitespace word bridge",
        postClose +
          "\u00a0([https://f?key=/Users/A/x]word[https://s?key=/home/B/y]",
        redactedPostClose + "?key=<path>]word[https://s?key=/home/B/y]",
      ],
      [
        "later-successor word/slash bridge",
        inherited +
          "&second/Users/B/x([https://f?key=/Users/A/x]" +
          "w/x[https://s?key=/home/B/y]]",
        redactedInherited +
          "&second<path>?key=<path>]w/x[https://s?key=/home/B/y]]",
      ],
      [
        "restarted-wrapper punctuation bridge",
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]" +
          ".x[https://s?key=/home/B/y]",
        "file://h?x=[a]<path>?key=<path>].x[https://s?key=/home/B/y]",
      ],
      [
        "active-child path-word bridge",
        activeChild +
          "&later/home/alice/s([https://f?key=/Users/A/x]" +
          "-x[https://s?key=/home/B/y]",
        "file://h?x=[file://<path>&later<path>?key=<path>]" +
          "-x[https://s?key=/home/B/y]",
      ],
    ] as const)("ends new ownership before a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "soft-whitespace slash-drive bridge",
        postClose +
          "\u00a0([https://f?key=/Users/A/x]/x[https://s?key=C:/Users/B/y]",
        redactedPostClose + "?key=<path>]<path>?key=C:<path>]",
      ],
      [
        "later-successor slash-drive bridge",
        inherited +
          "&second/Users/B/x([https://f?key=/Users/A/x]" +
          "/x[https://s?key=C:/Users/B/y]]",
        redactedInherited +
          "&second<path>?key=<path>]<path>?key=C:<path>]]",
      ],
      [
        "restarted-wrapper slash-drive bridge",
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]" +
          "/x[https://s?key=C:/Users/B/y]",
        "file://h?x=[a]<path>?key=<path>]<path>?key=C:<path>]",
      ],
      [
        "active-child slash-drive bridge",
        activeChild +
          "&later/home/alice/s([https://f?key=/Users/A/x]" +
          "/x[https://s?key=C:/Users/B/y]",
        "file://h?x=[file://<path>&later<path>?key=<path>]" +
          "<path>?key=C:<path>]",
      ],
    ] as const)("preserves the independent drive spelling for a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it.each([
      [
        "soft-whitespace slash-rooted bridge",
        postClose +
          "\u00a0([https://f?key=/Users/A/x]/x[https://s?key=/home/B/y]",
        redactedPostClose + "?key=<path>]<path>?key=<path>]",
      ],
      [
        "later-successor slash-rooted bridge",
        inherited +
          "&second/Users/B/x([https://f?key=/Users/A/x]" +
          "/x[https://s?key=/home/B/y]]",
        redactedInherited +
          "&second<path>?key=<path>]<path>?key=<path>]]",
      ],
      [
        "restarted-wrapper slash-rooted bridge",
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]" +
          "/x[https://s?key=/home/B/y]",
        "file://h?x=[a]<path>?key=<path>]<path>?key=<path>]",
      ],
      [
        "active-child slash-rooted bridge",
        activeChild +
          "&later/home/alice/s([https://f?key=/Users/A/x]" +
          "/x[https://s?key=/home/B/y]",
        "file://h?x=[file://<path>&later<path>?key=<path>]" +
          "<path>?key=<path>]",
      ],
    ] as const)("completes the independent rooted value for a %s", (_name, input, expected) => {
      assertStable(input, expected);
    });

    it("tracks nested brackets before an independent slash-bridge drive", () => {
      assertStable(
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]" +
          "/x[[https://nested]?key=C:/Users/B/y]",
        "file://h?x=[a]<path>?key=<path>]<path>?key=C:<path>]",
      );
    });

    it("leaves a slash bridge without another component to the base scanner", () => {
      assertStable(
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]/xplain",
        "file://h?x=[a]<path>?key=<path>]<path>",
      );
    });

    it.each([
      ["soft-whitespace", postClose + "\u00a0", redactedPostClose],
      ["later successor", inherited + "&second/Users/B/x", redactedInherited + "&second<path>"],
      ["restarted wrapper", "file://h?x=[a]\\b", "file://h?x=[a]<path>"],
    ] as const)("keeps a backslash-bridged drive visible for a %s origin", (_name, prefix, expectedPrefix) => {
      assertStable(
        prefix + "([https://f?key=/Users/A/x]\\x[https://s?key=C:/Users/B/y]",
        expectedPrefix + "?key=<path>]\\x[https://s?key=C:/Users/B/y]",
      );
    });

    it.each([
      ["UNC value", "\\srv\\share\\secret"],
      ["Users value", "\\Users\\B\\y"],
    ] as const)("completes an active-child named %s", (_name, value) => {
      assertStable(
        activeChild +
          "&later/home/alice/s([https://f?key=/Users/A/x&k2=" +
          value +
          "]",
        "file://h?x=[file://<path>&later<path>?key=<path>&k2=<path>]",
      );
    });

    it.each([
      ["soft-whitespace", postClose + "\u00a0", redactedPostClose],
      ["restarted wrapper", "file://h?x=[a]\\b", "file://h?x=[a]<path>"],
    ] as const)("keeps a named backslash value visible for a %s origin", (_name, prefix, expectedPrefix) => {
      assertStable(
        prefix + "([https://f?key=/Users/A/x&k2=\\srv\\share\\secret]",
        expectedPrefix + "?key=<path>&k2=\\srv\\share\\secret]",
      );
    });

    it("applies X1 to a named drive parameter in the first owned component", () => {
      assertStable(
        activeChild +
          "&later/home/alice/s([https://f?key=/Users/A/x&k2=C:/Users/B/y]",
        "file://h?x=[file://<path>&later<path>?key=<path>&k2=<path>]",
      );
    });

    it("records the independent slash-bridge colon pass sequence", () => {
      const input =
        "file://h?x=[a]\\b([https://f?key=/Users/A/x]" +
        "/x[https://s?key=XY:/Users/B/y]";
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(
        "file://h?x=[a]<path>?key=<path>]<path>?key=XY:/Users/B/y]",
      );
      expect(second).toBe(
        "file://h?x=[a]<path>?key=<path>]<path>?key=XY:<path>]",
      );
      expect(third).toBe(second);
    });

    describe("claims nested inside an owned bracket", () => {
      const quoted = "file://h?x=['https://o?x=file:///a'";
      const redactedQuoted = "file://h?x=['https://o?x=file://<path>'";
      const secretBracket = "[https://o?key=/Users/SECRET/s]]";

      it.each([
        ["pipe", "|"],
        ["ampersand", "&"],
      ] as const)(
        "keeps the inherited owner through an active child after %s",
        (_name, delimiter) => {
          assertStable(
            quoted + delimiter + "\\a[file:///b&/c]" + secretBracket,
            redactedQuoted + delimiter + "<path>&<path>][https://o?key=<path>]]",
          );
        },
      );

      it.each([
        ["zero width space", "\u200b"],
        ["zero width non-joiner", "\u200c"],
        ["zero width joiner", "\u200d"],
        ["word joiner", "\u2060"],
      ] as const)("keeps the inherited owner behind a %s run", (_name, interposer) => {
        assertStable(
          quoted + interposer + "|\\a[file:///b&/c]" + secretBracket,
          redactedQuoted + interposer + "|<path>&<path>][https://o?key=<path>]]",
        );
      });

      it.each([
        ["rooted", "/Users/SECRET/x", "<path>"],
        ["private-relative", "later/Users/SECRET/x", "later<path>"],
      ] as const)("keeps a %s inherited successor owner", (_name, successor, expected) => {
        assertStable(
          quoted + "|" + successor + "[file:///b&/c]" + secretBracket,
          redactedQuoted + "|" + expected + "&<path>][https://o?key=<path>]]",
        );
      });

      it.each([
        ["pipe child", "[file:///b|/c]", "<path>|<path>]"],
        ["backslash child", "[file:///b&\\c]", "<path>&<path>]"],
        ["later rooted successor", "[file:///b&/c&/d]", "<path>&<path>&<path>]"],
        ["later private successor", "[file:///b&/c&later/Users/d]", "<path>&<path>&later<path>]"],
        ["later pipe successor", "[file:///b&/c|/d]", "<path>&<path>|<path>]"],
        ["queried private child", "[file:///b?q=1&later/home/c]", "<path>?q=1&later<path>]"],
        ["mixed-separator child", "[file:///b&later\\/home/c]", "<path>&later\\<path>]"],
        ["restarted backslash wrapper", "[file://h2?x=[a]\\b]", "<path>?x=[a]<path>]"],
        ["restarted slash wrapper", "[file://h2?x=[a]/b]", "<path>?x=[a]<path>]"],
        ["restarted nested bracket", "[file://h2?x=[a][/Users/S/s]]", "<path>?x=[a][<path>]]"],
        [
          "child with its own bracket",
          "[file:///b&/c([https://i?key=/Users/I/s]]",
          "<path>&<path>?key=<path>]]",
        ],
      ] as const)("keeps the inherited owner through a %s", (_name, inner, expected) => {
        assertStable(
          quoted + "|\\a" + inner + secretBracket,
          redactedQuoted + "|" + expected + "[https://o?key=<path>]]",
        );
      });

      it.each([
        ["drive", "C:/Users/SECRET/s", "<path>"],
        ["private-relative", "later/home/SECRET/s", "later/home/SECRET/s"],
        ["colon", "XY:/Users/SECRET/s", "XY:/Users/SECRET/s"],
        ["plain", "plain", "plain"],
        ["public", "https://public.test/x", "https://public.test/x"],
      ] as const)("keeps the adjacent %s value as before", (_name, value, expected) => {
        assertStable(
          quoted + "|\\a[file:///b&/c][https://o?key=" + value + "]]",
          redactedQuoted + "|<path>&<path>][https://o?key=" + expected + "]]",
        );
      });

      it.each([
        ["bridged", ":x"],
        ["parenthesised", "("],
      ] as const)("leaves a %s rooted value visible as before", (_name, bridge) => {
        assertStable(
          quoted + "|\\a[file:///b&/c]" + bridge + secretBracket,
          redactedQuoted + "|<path>&<path>]" + bridge + secretBracket,
        );
      });

      it.each([
        ["active child", "[file:///b&/c]", "&<path>]"],
        ["later successor", "[file:///b&/c&/d]", "&<path>&<path>]"],
        ["restarted wrapper", "[file://h2?x=[a]\\b]", "?x=[a]<path>]"],
      ] as const)("keeps the direct post-close owner through a %s", (_name, inner, expected) => {
        assertStable(
          postClose + inner + "[https://o?key=/Users/SECRET/s]",
          redactedPostClose + expected + "[https://o?key=<path>]",
        );
      });
    });
  });

  describe("Bug #1789", () => {
    const prefix = "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'";
    const redactedPrefix = "file://h?x=['https://outer.test/x?next=file://<path>'";
    const windowsRoot = "\\Users\\SECRET\\x]";
    const cases: Array<readonly [name: string, input: string, expected: string]> = [
      ...([
        ["U+200B", "\u200b"],
        ["U+200C", "\u200c"],
        ["U+200D", "\u200d"],
        ["U+2060", "\u2060"],
      ] as const).map(([name, interposer]) => [
        name + " before pipe restores the inherited owner",
        prefix + interposer + "|" + windowsRoot,
        redactedPrefix + interposer + "|<path>]",
      ] as const),
      [
        "mixed invisible run before pipe restores the inherited owner",
        prefix + "\u200b\u200c|" + windowsRoot,
        redactedPrefix + "\u200b\u200c|<path>]",
      ],
      [
        "U+200B before ampersand restores the inherited owner",
        prefix + "\u200b&" + windowsRoot,
        redactedPrefix + "\u200b&<path>]",
      ],
      [
        "U+200B before a private-root relative pipe successor",
        prefix + "\u200b|later/home/alice]",
        redactedPrefix + "\u200b|later<path>]",
      ],
      ["quote-equals backslash Users value", prefix + "=\\Users\\SECRET\\x]", redactedPrefix + "=<path>]"],
      ["quote-equals ordinary backslash value", prefix + "=\\var\\data]", redactedPrefix + "=<path>]"],
      [
        "quote-repeated-equals backslash value",
        prefix + "==\\Users\\SECRET\\x]",
        redactedPrefix + "==<path>]",
      ],
      [
        "invisible run before quote-equals backslash value",
        prefix + "\u200b=\\var\\data]",
        redactedPrefix + "\u200b=<path>]",
      ],
      [
        "invisible run successor owns its immediate bracket composition",
        prefix + "\u200b|\\Users\\SECRET\\x[https://inner?key=/home/C/s]]",
        redactedPrefix + "\u200b|<path>?key=<path>]]",
      ],
      ["immediate pipe keeps its established handoff", prefix + "|" + windowsRoot, redactedPrefix + "|<path>]"],
      [
        "immediate ampersand keeps its established handoff",
        prefix + "&" + windowsRoot,
        redactedPrefix + "&<path>]",
      ],
      ["POSIX value after equals keeps its established redaction", prefix + "=/Users/SECRET/x]", redactedPrefix + "=<path>]"],
      [
        "Windows drive value after equals keeps its established redaction",
        prefix + "=C:\\Users\\SECRET\\x]",
        redactedPrefix + "=<path>]",
      ],
      [
        "UNC value after equals keeps its established redaction",
        prefix + "=\\\\server\\share]",
        redactedPrefix + "=<path>]",
      ],
      [
        "forward-slash drive value after equals keeps its established redaction",
        prefix + "=C:/Users/SECRET/x]",
        redactedPrefix + "=C:<path>]",
      ],
      [
        "private-root relative value after equals stays readable",
        prefix + "=later/home/alice]",
        redactedPrefix + "=later/home/alice]",
      ],
      [
        "Users relative value after equals stays readable",
        prefix + "=Users/alice/x]",
        redactedPrefix + "=Users/alice/x]",
      ],
      ["plain value after equals stays readable", prefix + "=plain]", redactedPrefix + "=plain]"],
      [
        "public URL value after equals stays readable",
        prefix + "=https://public.test/x]",
        redactedPrefix + "=https://public.test/x]",
      ],
      [
        "space and U+200B after equals keep a backslash value readable",
        prefix + "= \u200b\\Users\\SECRET\\x]",
        redactedPrefix + "= \u200b\\Users\\SECRET\\x]",
      ],
      [
        "U+200B after equals keeps a backslash value readable",
        prefix + "=\u200b\\Users\\SECRET\\x]",
        redactedPrefix + "=\u200b\\Users\\SECRET\\x]",
      ],
      [
        "U+200B after pipe keeps a backslash value readable",
        prefix + "|\u200b\\Users\\SECRET\\x]",
        redactedPrefix + "|\u200b\\Users\\SECRET\\x]",
      ],
      ...(["|", "&", "="] as const).map((delimiter) => [
        "U+FEFF before " + delimiter + " remains a whitespace boundary",
        prefix + "\ufeff" + delimiter + windowsRoot,
        redactedPrefix + "\ufeff" + delimiter + windowsRoot,
      ] as const),
      ...([
        ["space", " "],
        ["tab", "\t"],
        ["non-breaking space", "\u00a0"],
      ] as const).map(([name, whitespace]) => [
        name + " before pipe remains a whitespace boundary",
        prefix + whitespace + "|" + windowsRoot,
        redactedPrefix + whitespace + "|" + windowsRoot,
      ] as const),
      [
        "semicolon instead of a handoff delimiter stays readable",
        prefix + ";" + windowsRoot,
        redactedPrefix + ";" + windowsRoot,
      ],
      [
        "ordinary text instead of a handoff delimiter stays readable",
        prefix + "x" + windowsRoot,
        redactedPrefix + "x" + windowsRoot,
      ],
    ];

    it.each(cases)("%s on every pass", (_name, input, expected) => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });
  });

  describe("Bug #1803", () => {
    const prefix = "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'";
    const redactedPrefix = "file://h?x=['https://outer.test/x?next=file://<path>'";
    const bracket = "[https://inner?key=/home/C/s]]";
    const assertPasses = (
      input: string,
      expectedFirst: string,
      expectedSecond = expectedFirst,
      expectedThird = expectedSecond,
    ): void => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expectedFirst);
      expect(second).toBe(expectedSecond);
      expect(third).toBe(expectedThird);
    };

    it.each([
      [
        "equals backslash value with a bracket",
        prefix + "=\\Users\\SECRET\\x" + bracket,
        redactedPrefix + "=<path>?key=<path>]]",
      ],
      [
        "repeated equals backslash value with a bracket",
        prefix + "==\\Users\\SECRET\\x" + bracket,
        redactedPrefix + "==<path>?key=<path>]]",
      ],
      [
        "invisible run before an equals backslash value with a bracket",
        prefix + "\u200b=\\Users\\SECRET\\x" + bracket,
        redactedPrefix + "\u200b=<path>?key=<path>]]",
      ],
      [
        "equals backslash value before a later private-root successor",
        prefix + "=\\Users\\x&later/home/alice]",
        redactedPrefix + "=<path>&later<path>]",
      ],
      [
        "equals plain value before a later private-root successor",
        prefix + "=plain&later/home/alice]",
        redactedPrefix + "=plain&later<path>]",
      ],
    ] as const)("redacts the %s on the first pass", (_name, input, expected) => {
      assertPasses(input, expected);
    });

    it.each([
      ["direct", ""],
      ["after U+200B", "\u200b"],
    ] as const)("redacts the drive-origin bracket %s on the first pass", (_name, interposer) => {
      assertPasses(
        prefix + interposer + "=C:/Users/SECRET/x" + bracket,
        redactedPrefix + interposer + "=C:<path>?key=<path>]]",
        redactedPrefix + interposer + "=C:<path>?key=<path>]]",
        redactedPrefix + interposer + "=C:<path>?key=<path>]]",
      );
    });

    it.each([
      [
        "lowercase drive before a bracket",
        "=c:/Users/S/x" + bracket,
        "=c:<path>?key=/home/C/s]]",
        "=c:<path>?key=<path>]]",
      ],
      [
        "drive before an ampersand private relative",
        "=C:/Users/S/x&later/home/alice]",
        "=C:<path>&later/home/alice]",
        "=C:<path>&later<path>]",
      ],
      [
        "drive before a pipe private relative",
        "=C:/Users/S/x|later/home/alice]",
        "=C:<path>|later/home/alice]",
        "=C:<path>|later<path>]",
      ],
      [
        "drive before a backslash value",
        "=C:/Users/S/x&\\Users\\T\\y]",
        "=C:<path>&\\Users\\T\\y]",
        "=C:<path>&<path>]",
      ],
    ] as const)("redacts the drive-origin successor on the first pass for the %s", (_name, suffix, _first, fixed) => {
      assertPasses(
        prefix + suffix,
        redactedPrefix + fixed,
        redactedPrefix + fixed,
        redactedPrefix + fixed,
      );
    });

    it.each([
      ["POSIX value before a bracket", "=/Users/S/x" + bracket, "=<path>?key=<path>]]"],
      ["backslash-drive value before a bracket", "=C:\\Users\\S\\x" + bracket, "=<path>?key=<path>]]"],
      ["UNC value before a bracket", "=\\\\srv\\share" + bracket, "=<path>?key=<path>]]"],
      [
        "backslash value before a parenthesised bracket",
        "=\\Users\\S\\x([https://other?key=/home/C/s]",
        "=<path>?key=<path>]",
      ],
      ["backslash value before another backslash value", "=\\Users\\S\\x&\\Users\\T\\y]", "=<path>&<path>]"],
      ["backslash value before a pipe private relative", "=\\Users\\S\\x|later/home/alice]", "=<path>|later<path>]"],
      ["plain value before a pipe backslash value", "=plain|\\Users\\T\\y]", "=plain|<path>]"],
      ["plain value before an ampersand backslash value", "=plain&\\Users\\T\\y]", "=plain&<path>]"],
      ["plain value before a pipe private relative", "=plain|later/home/alice]", "=plain|later<path>]"],
      [
        "backslash and private-relative values before a bracket",
        "=\\Users\\S\\x&later/home/alice" + bracket,
        "=<path>&later<path>?key=<path>]]",
      ],
      [
        "plain and private-relative values before a bracket",
        "=plain&later/home/alice" + bracket,
        "=plain&later<path>?key=<path>]]",
      ],
      [
        "plain and backslash values before a bracket",
        "=plain|\\Users\\T\\y" + bracket,
        "=plain|<path>?key=<path>]]",
      ],
      [
        "backslash value before a private relative inside its bracket",
        "=\\Users\\S\\x[https://inner?a=1&later/home/D/s]]",
        "=<path>?a=1&later<path>]]",
      ],
      [
        "backslash value before a POSIX value inside its bracket",
        "=\\Users\\S\\x[https://inner?key=/var/data]]",
        "=<path>?key=<path>]]",
      ],
      [
        "backslash value before a backslash value inside its bracket",
        "=\\Users\\S\\x[https://inner?key=\\Users\\D\\s]]",
        "=<path>?key=<path>]]",
      ],
      [
        "backslash value followed by soft whitespace and a bracket",
        "=\\Users\\S\\x\u00a0" + bracket,
        "=<path>?key=<path>]]",
      ],
      [
        "backslash value followed by U+200B and a bracket",
        "=\\Users\\S\\x\u200b" + bracket,
        "=<path>?key=<path>]]",
      ],
      [
        "plain value with two private-relative successors",
        "=plain&later/home/alice&later/home/bob]",
        "=plain&later<path>&later<path>]",
      ],
    ] as const)("redacts the adopted %s on the first pass", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    it("keeps the base split for a bracket bridge with a later successor", () => {
      assertPasses(
        prefix + "=\\Users\\S\\x[x]&later/home/bob]",
        redactedPrefix + "=<path>&later/home/bob]",
        redactedPrefix + "=<path>&later<path>]",
        redactedPrefix + "=<path>&later<path>]",
      );
    });

    it.each([
      ["private-root relative equals value", "=later/home/alice]", "=later/home/alice]"],
      ["forward-slash drive equals value", "=C:/Users/SECRET/x]", "=C:<path>]"],
      ["backslash equals value", "=\\Users\\SECRET\\x]", "=<path>]"],
      ["Users relative equals value", "=Users/alice/x]", "=Users/alice/x]"],
      ["plain equals value", "=plain]", "=plain]"],
      ["public URL equals value", "=https://public.test/x]", "=https://public.test/x]"],
      ["space before equals", " =/Users/SECRET/x", " =<path>"],
      ["backslash-drive equals value", "=C:\\Users\\SECRET\\x]", "=<path>]"],
      ["UNC equals value", "=\\\\server\\share]", "=<path>]"],
      ["invisible run before a backslash value", "\u200b\\Users\\SECRET\\x]", "\u200b\\Users\\SECRET\\x]"],
      ["space and invisible run before a backslash value", " \u200b\\Users\\SECRET\\x]", " \u200b\\Users\\SECRET\\x]"],
      ["ordinary later successor", "=later/var/data&x=plain]", "=later/var/data&x=plain]"],
      [
        "visible private-relative value before a bracket",
        "=later/home/alice" + bracket,
        "=later/home/alice" + bracket,
      ],
      ["visible plain value before a bracket", "=plain" + bracket, "=plain" + bracket],
      ["plain value before an ordinary relative", "=plain&later/var/data]", "=plain&later/var/data]"],
      ["backslash value before an ordinary relative", "=\\Users\\S\\x&later/var/data]", "=<path>&later/var/data]"],
      ["backslash value before plain text", "=\\Users\\S\\x&plain]", "=<path>&plain]"],
      [
        "backslash value before a space-separated bracket",
        "=\\Users\\S\\x " + bracket,
        "=<path> " + bracket,
      ],
      [
        "space-separated backslash value before a bracket",
        "= \\Users\\S\\x" + bracket,
        "= \\Users\\S\\x" + bracket,
      ],
      [
        "Users relative before a bracket",
        "=Users/alice/x" + bracket,
        "=Users/alice/x" + bracket,
      ],
      [
        "public URL before a bracket",
        "=https://public.test/x" + bracket,
        "=https://public.test/x" + bracket,
      ],
      [
        "backslash value before a visible private relative inside its bracket",
        "=\\Users\\S\\x[https://inner?key=later/home/D/s]]",
        "=<path>?key=later/home/D/s]]",
      ],
      [
        "backslash value before a visible ordinary relative inside its bracket",
        "=\\Users\\S\\x[https://inner?key=later/var/d]]",
        "=<path>?key=later/var/d]]",
      ],
      [
        "backslash value before visible plain text inside its bracket",
        "=\\Users\\S\\x[https://inner?key=plain]]",
        "=<path>?key=plain]]",
      ],
      [
        "backslash value before a visible public URL inside its bracket",
        "=\\Users\\S\\x[https://inner?key=https://pub.test/x]]",
        "=<path>?key=https://pub.test/x]]",
      ],
      [
        "backslash value before a POSIX successor",
        "=\\Users\\S\\x&/Users/T/y]",
        "=<path>&<path>]",
      ],
      [
        "backslash value and bracket before an outside private relative",
        "=\\Users\\S\\x" + bracket + "&later/home/z]",
        "=<path>?key=<path>]]&later/home/z]",
      ],
      [
        "backslash value before a parent close and independent bracket",
        "=\\Users\\S\\x][https://inner?key=/home/C/s]",
        "=<path>][https://inner?key=/home/C/s]",
      ],
    ] as const)("keeps the %s byte-exact", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    it("redacts only the first of two adjacent bracket components", () => {
      const input = prefix + "=\\Users\\S\\x" + bracket + bracket;
      const expected = redactedPrefix + "=<path>?key=<path>]]" + bracket;
      assertPasses(input, expected);
    });

    it.each([
      [
        "private-relative value before another private relative",
        "=later/home/alice&later/home/bob]",
        "=later/home/alice&later/home/bob]",
        "=later/home/alice&later<path>]",
      ],
      [
        "ordinary relative value before a private relative",
        "=later/var/data&later/home/bob]",
        "=later/var/data&later/home/bob]",
        "=later/var/data&later<path>]",
      ],
      [
        "private-relative value before a backslash value",
        "=later/home/alice&\\Users\\T\\y]",
        "=later/home/alice&\\Users\\T\\y]",
        "=later/home/alice&<path>]",
      ],
      [", before a named backslash value", ",=\\Users\\S\\x]", ",=\\Users\\S\\x]", ",=<path>]"],
      [
        ", before a named backslash value and plain successor",
        ",=\\Users\\S\\x&plain]",
        ",=\\Users\\S\\x&plain]",
        ",=<path>&plain]",
      ],
      ["U+00AD before a named backslash value", "\u00ad=\\Users\\S\\x]", "\u00ad=\\Users\\S\\x]", "\u00ad=<path>]"],
      [
        "U+00AD before a named backslash value and bracket",
        "\u00ad=\\Users\\S\\x" + bracket,
        "\u00ad=\\Users\\S\\x" + bracket,
        "\u00ad=<path>?key=/home/C/s]]",
        "\u00ad=<path>?key=<path>]]",
      ],
      [
        "x before a named backslash value",
        "x=\\Users\\S\\x&plain]",
        "x=\\Users\\S\\x&plain]",
        "x=<path>&plain]",
      ],
      [
        "backslash interposer before a private relative",
        "a\\Users\\S\\x|later/home/alice]",
        "a\\Users\\S\\x|later/home/alice]",
        "a\\Users\\S\\x|later<path>]",
      ],
    ] as const)(
      "pins the adopted residual: %s",
      (_name, suffix, firstSuffix, secondSuffix, thirdSuffix = secondSuffix) => {
        assertPasses(
          prefix + suffix,
          redactedPrefix + firstSuffix,
          redactedPrefix + secondSuffix,
          redactedPrefix + thirdSuffix,
        );
      },
    );

    it.each([
      ["glued", ""],
      ["ampersand-separated", "&"],
    ] as const)("redacts %s independent target copies on the first pass", (_name, separator) => {
      const input = prefix + "=\\Users\\SECRET\\x" + bracket;
      const expected = redactedPrefix + "=<path>?key=<path>]]";

      assertPasses(input + separator + input, expected + separator + expected);
    });

    it("redacts target copies inside independent sibling wrappers", () => {
      const input = prefix + "=\\Users\\SECRET\\x" + bracket;
      const expected = redactedPrefix + "=<path>?key=<path>]]";

      assertPasses("[" + input + "][" + input + "]", "[" + expected + "][" + expected + "]");
    });

    it.each([
      [
        "uppercase drive query value",
        "=\\Users\\S\\x[https://inner?key=C:/Users/K/x]]",
        "=<path>?key=C:/Users/K/x]]",
        "=<path>?key=C:<path>]]",
      ],
      [
        "lowercase drive query value",
        "=\\Users\\S\\x[https://inner?key=c:/Users/K/x]]",
        "=<path>?key=c:/Users/K/x]]",
        "=<path>?key=c:<path>]]",
      ],
      [
        "second drive query value",
        "=\\Users\\S\\x[https://inner?key=/Users/A/x&k2=D:/Users/B/y]]",
        "=<path>?key=/Users/A/x&k2=D:/Users/B/y]]",
        "=<path>?key=<path>&k2=D:<path>]]",
      ],
      [
        "two drive query values",
        "=\\Users\\S\\x[https://inner?key=C:/Users/K/x&k2=D:/Users/B/y]]",
        "=<path>?key=C:/Users/K/x&k2=D:/Users/B/y]]",
        "=<path>?key=C:<path>&k2=D:<path>]]",
      ],
      [
        "drive after a public URL",
        "=\\Users\\S\\x[https://inner?key=https://pub.test/x&k2=C:/Users/K/x]]",
        "=<path>?key=https://pub.test/x&k2=C:/Users/K/x]]",
        "=<path>?key=https://pub.test/x&k2=C:/Users/K/x]]",
      ],
      [
        "drive inside a nested file child",
        "=\\Users\\S\\x[file:///b&C:/Users/c]]",
        "=<path>&C:/Users/c]]",
        "=<path>&C:<path>]]",
      ],
      [
        "bare drive value",
        "=\\Users\\S\\x[https://inner?key=C:/]]",
        "=<path>?key=C:/]]",
        "=<path>?key=C:/]]",
      ],
      [
        "doubled-slash drive value",
        "=\\Users\\S\\x[https://inner?key=C://x]]",
        "=<path>?key=C://x]]",
        "=<path>?key=C://x]]",
      ],
      [
        "compound drive value",
        "=\\Users\\S\\x[https://inner?key=C:/C:/Users/K/x]]",
        "=<path>?key=C:/C:/Users/K/x]]",
        "=<path>?key=C:<path>:<path>]]",
      ],
      [
        "file literal after a drive prefix",
        "=\\Users\\S\\x[https://inner?key=C:/file:///Users/K/x]]",
        "=<path>?key=C:/file://<path>]]",
        "=<path>?key=C:<path><path>]]",
      ],
    ] as const)(
      "keeps the base drive pass sequence for the %s",
      (_name, suffix, firstSuffix, fixedSuffix) => {
        assertPasses(
          prefix + suffix,
          redactedPrefix + firstSuffix,
          redactedPrefix + fixedSuffix,
          redactedPrefix + fixedSuffix,
        );
      },
    );

    it("keeps independent drive-query copies on their base pass sequence", () => {
      const firstInput = prefix + "=\\Users\\S\\x[https://inner?key=C:/Users/K/x]]";
      const secondInput = prefix + "=\\Users\\S\\x[https://inner?key=D:/Users/B/y]]";
      const firstPass = redactedPrefix + "=<path>?key=C:/Users/K/x]]";
      const secondPass = redactedPrefix + "=<path>?key=D:/Users/B/y]]";
      const firstFixed = redactedPrefix + "=<path>?key=C:<path>]]";
      const secondFixed = redactedPrefix + "=<path>?key=D:<path>]]";

      assertPasses(
        firstInput + " & " + secondInput,
        firstPass + " & " + secondPass,
        firstFixed + " & " + secondFixed,
        firstFixed + " & " + secondFixed,
      );
    });
  });

  describe("Bug #1804", () => {
    const prefix = "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'";
    const redactedPrefix = "file://h?x=['https://outer.test/x?next=file://<path>'";
    const bracket = "[https://inner?key=/home/C/s]]";
    const interposers = [
      "\u0085",
      "\u0000",
      "\u007f",
      "\u00ad",
      "\u180e",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u2066",
      "\u034f",
      "\ufe0f",
      ",",
      ":",
      "!",
      "x",
      "..",
      "ab",
      "a.b",
      "?q",
      "#f",
      "=x",
      "x=",
      "%20",
      "~",
      "\u00ad\u200b",
      "\u200b,",
      "=",
      "==",
      "C:",
      "C:,",
    ] as const;
    const assertPasses = (
      input: string,
      expectedFirst: string,
      expectedSecond = expectedFirst,
      expectedThird = expectedSecond,
    ): void => {
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expectedFirst);
      expect(second).toBe(expectedSecond);
      expect(third).toBe(expectedThird);
    };
    const targets = interposers.flatMap((interposer) => [
      [
        JSON.stringify(interposer) + " before pipe and backslash root",
        interposer + "|\\Users\\SECRET\\x]",
        interposer + "|<path>]",
      ],
      [
        JSON.stringify(interposer) + " before ampersand and backslash root",
        interposer + "&\\Users\\SECRET\\x]",
        interposer + "&<path>]",
      ],
      [
        JSON.stringify(interposer) + " before private-root relative successor",
        interposer + "|later/home/alice]",
        interposer + "|later<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a backslash root and bracket",
        interposer + "|\\Users\\SECRET\\x" + bracket,
        interposer + "|<path>?key=<path>]]",
      ],
    ] as const);

    it.each(targets)("redacts %s on the first pass", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    const successorTargets = interposers.flatMap((interposer) => [
      [
        JSON.stringify(interposer) + " before a rooted value and later private relative",
        interposer + "|\\Users\\SECRET\\x&later/home/bob]",
        interposer + "|<path>&later<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a private relative and bracket",
        interposer + "|later/home/alice" + bracket,
        interposer + "|later<path>?key=<path>]]",
      ],
      [
        JSON.stringify(interposer) + " before an ampersand rooted value and bracket",
        interposer + "&\\Users\\SECRET\\x" + bracket,
        interposer + "&<path>?key=<path>]]",
      ],
      [
        JSON.stringify(interposer) + " before a Users relative",
        interposer + "|users/alice/x]",
        interposer + "|users<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a home relative",
        interposer + "|home/alice]",
        interposer + "|home<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a root relative",
        interposer + "|root/x]",
        interposer + "|root<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a dotted home relative",
        interposer + "|./home/x]",
        interposer + "|.<path>]",
      ],
    ] as const);

    it.each(successorTargets)("redacts adopted successor shape %s", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    it.each([
      ["equals before an ampersand private relative", "=&later/home/alice]", "=&later<path>]"],
      ["comma before two private relatives", ",|later/home/alice&later/home/bob]", ",|later<path>&later<path>]"],
      ["comma before mixed successor kinds", ",&later/home/alice|\\Users\\B\\y]", ",&later<path>|<path>]"],
      ["comma before two backslash roots", ",|\\Users\\SECRET\\x&\\Users\\B\\y]", ",|<path>&<path>]"],
      ["x before two successor delimiters and a root", "x|y|\\Users\\S\\x]", "x|y|<path>]"],
      ["x before two successor delimiters and a private relative", "x|y&later/home/alice]", "x|y&later<path>]"],
      [
        "comma before a backslash drive and bracket",
        ",|C:\\Users\\S\\x" + bracket,
        ",|<path>?key=<path>]]",
      ],
      [
        "comma before a root and private relative inside its bracket",
        ",|\\Users\\S\\x[https://inner?a=1&later/home/D/s]]",
        ",|<path>?a=1&later<path>]]",
      ],
    ] as const)("redacts the adopted %s", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    const controls = interposers.flatMap((interposer) => [
      [JSON.stringify(interposer) + " before a plain value", interposer + "|plain]", interposer + "|plain]"],
      [
        JSON.stringify(interposer) + " before an already-redacted POSIX value",
        interposer + "|/Users/SECRET/x]",
        interposer + "|<path>]",
      ],
      [
        JSON.stringify(interposer) + " before an ordinary relative value",
        interposer + "|later/var/data]",
        interposer + "|later/var/data]",
      ],
      [
        JSON.stringify(interposer) + " before a forward-slash drive",
        interposer + "|C:/Users/S/x]",
        interposer + "|C:<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a backslash drive",
        interposer + "|C:\\Users\\S\\x]",
        interposer + "|<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a public URL",
        interposer + "|https://public.test/Users/S/x]",
        interposer + "|https://public.test/Users/S/x]",
      ],
      [
        JSON.stringify(interposer) + " before an opaque URL",
        interposer + "|mailto:u@public.test]",
        interposer + "|mailto:u@public.test]",
      ],
      [JSON.stringify(interposer) + " before a tilde value", interposer + "|~/x]", interposer + "|~/x]"],
      [
        JSON.stringify(interposer) + " before a doubled-slash value",
        interposer + "|//server/share/x]",
        interposer + "|<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a nested file URL",
        interposer + "|file:///Users/S/x]",
        interposer + "|file://<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a named POSIX value",
        interposer + "|plain=/Users/S/x]",
        interposer + "|plain=<path>]",
      ],
      [
        JSON.stringify(interposer) + " before a named drive value",
        interposer + "|k=C:/Users/S/x]",
        interposer + "|k=C:<path>]",
      ],
      [
        JSON.stringify(interposer) + " before an ordinary relative and visible bracket",
        interposer + "|later/var/data" + bracket,
        interposer + "|later/var/data" + bracket,
      ],
      [
        JSON.stringify(interposer) + " before plain text and visible bracket",
        interposer + "|plain" + bracket,
        interposer + "|plain" + bracket,
      ],
      [
        JSON.stringify(interposer) + " before a closed rooted value and outside relative",
        interposer + "|\\Users\\S\\x]&later/home/z]",
        interposer + "|<path>]&later/home/z]",
      ],
      [
        JSON.stringify(interposer) + " before a closed rooted value, whitespace, and relative",
        interposer + "|\\Users\\S\\x] later/home/z]",
        interposer + "|<path>] later/home/z]",
      ],
      [JSON.stringify(interposer) + " before an empty successor", interposer + "|", interposer + "|"],
      [JSON.stringify(interposer) + " at end of input", interposer, interposer],
    ] as const);

    it.each(controls)("keeps %s byte-exact", (_name, suffix, expectedSuffix) => {
      assertPasses(prefix + suffix, redactedPrefix + expectedSuffix);
    });

    it.each([
      ["space", " "],
      ["tab", "\t"],
      ["non-breaking space", "\u00a0"],
      ["ideographic space", "\u3000"],
      ["byte order mark", "\ufeff"],
      ["mixed soft-hyphen and space run", "\u00ad \u00ad"],
      ["Ogham space mark", "\u1680"],
      ["paragraph separator", "\u2029"],
      ["medium mathematical space", "\u205f"],
      ["vertical tab", "\u000b"],
      ["U+200B followed by space", "\u200b "],
      ["U+180E followed by space", "\u180e "],
    ] as const)("keeps %s as a whitespace boundary", (_name, whitespace) => {
      const suffix = whitespace + "|\\Users\\SECRET\\x]";
      assertPasses(prefix + suffix, redactedPrefix + suffix);
    });

    it("keeps the slash interposer on its established pass sequence", () => {
      assertPasses(
        prefix + "/|\\Users\\SECRET\\x]",
        redactedPrefix + "/|\\Users\\SECRET\\x]",
        redactedPrefix + "<path>",
        redactedPrefix + "<path>",
      );
    });

    it("keeps a public URL interposer visible", () => {
      const suffix = "http://p.test|later/home/alice]";
      assertPasses(prefix + suffix, redactedPrefix + suffix);
    });

    it("keeps a closing bracket as a run stopper", () => {
      const suffix = "x]|\\Users\\S\\x]";
      assertPasses(prefix + suffix, redactedPrefix + suffix);
    });

    it("keeps the established U+200B inherited handoff", () => {
      assertPasses(
        prefix + "\u200b|\\Users\\SECRET\\x]",
        redactedPrefix + "\u200b|<path>]",
      );
    });

    it.each([
      ["bracket", "[x]"],
      ["apostrophe", "'"],
      ["double quote", "\""],
      ["backslash", "\\"],
      ["slash-bearing text", "abc/def"],
      ["short slash-bearing text", "a/b"],
      ["embedded backslash", "a\\b"],
    ] as const)("pins the %s interposer residual", (_name, interposer) => {
      const input = prefix + interposer + "|\\Users\\SECRET\\x]";
      const first = redactedPrefix + interposer + "|\\Users\\SECRET\\x]";
      const fixed = redactedPrefix + interposer + "|<path>]";
      assertPasses(input, first, fixed, fixed);
    });

    it.each([
      [
        "slash",
        "/|\\Users\\S\\x]",
        "/|\\Users\\S\\x]",
        "<path>",
      ],
      [
        "public URL before ampersand root",
        "http://p.test&\\Users\\S\\x]",
        "http://p.test&\\Users\\S\\x]",
        "http://p.test&<path>]",
      ],
      [
        "comma and apostrophe",
        ",'|\\Users\\S\\x]",
        ",'|\\Users\\S\\x]",
        ",'|<path>]",
      ],
      [
        "two apostrophes",
        "''|\\Users\\S\\x]",
        "''|\\Users\\S\\x]",
        "''|<path>]",
      ],
      [
        "mixed-separator successor and bracket",
        ",|later\\/home/a" + bracket,
        ",|later\\<path>?key=/home/C/s]]",
        ",|later\\<path>?key=<path>]]",
      ],
      [
        "equals backslash successor and bracket",
        ",|=\\Users\\x" + bracket,
        ",|=\\Users\\x" + bracket,
        ",|=<path>?key=/home/C/s]]",
        ",|=<path>?key=<path>]]",
      ],
      [
        "U+200B equals backslash successor and bracket",
        "\u200b|=\\Users\\x" + bracket,
        "\u200b|=<path>?key=/home/C/s]]",
        "\u200b|=<path>?key=<path>]]",
      ],
    ] as const)(
      "pins the adopted residual: %s",
      (_name, suffix, firstSuffix, secondSuffix, thirdSuffix = secondSuffix) => {
        assertPasses(
          prefix + suffix,
          redactedPrefix + firstSuffix,
          redactedPrefix + secondSuffix,
          redactedPrefix + thirdSuffix,
        );
      },
    );

    it.each([
      ["long non-whitespace run", prefix + "x".repeat(200_000) + "|\\Users\\SECRET\\x]"],
      [
        "repeated inherited quote ends",
        "file://h?x=[" + "'https://o.test/x?n=file:///U/a'x".repeat(Math.ceil(200_000 / 34)) + "|\\U\\x]",
      ],
    ] as const)("scans the 200k %s in linear time", (_name, input) => {
      const started = performance.now();
      const first = sanitizeError(input);
      const elapsed = performance.now() - started;

      expect(first).not.toContain("/U/a");
      expect(sanitizeError(first)).toBe(first);
      expect(elapsed).toBeLessThan(2_000);
    });

    it.each([
      ["glued", ""],
      ["ampersand-separated", "&"],
    ] as const)("redacts %s independent target copies on the first pass", (_name, separator) => {
      const input = prefix + "\u00ad|\\Users\\SECRET\\x]";
      const expected = redactedPrefix + "\u00ad|<path>]";

      assertPasses(input + separator + input, expected + separator + expected);
    });

    it("redacts target copies inside independent sibling wrappers", () => {
      const input = prefix + "\u00ad|\\Users\\SECRET\\x]";
      const expected = redactedPrefix + "\u00ad|<path>]";

      assertPasses("[" + input + "][" + input + "]", "[" + expected + "][" + expected + "]");
    });

    it.each([
      [
        "uppercase drive query value",
        ",|\\Users\\S\\x[https://inner?key=C:/Users/K/x]]",
        ",|\\Users\\S\\x[https://inner?key=C:/Users/K/x]]",
        ",|<path>?key=C:/Users/K/x]]",
        ",|<path>?key=C:<path>]]",
      ],
      [
        "lowercase drive query value",
        ",|later/home/S/x[https://inner?key=c:/Users/K/x]]",
        ",|later/home/S/x[https://inner?key=c:/Users/K/x]]",
        ",|later<path>?key=c:/Users/K/x]]",
        ",|later<path>?key=c:<path>]]",
      ],
      [
        "second drive query value",
        ",|/Users/S/x[https://inner?key=/Users/A/x&k2=D:/Users/B/y]]",
        ",|<path>?key=/Users/A/x&k2=D:/Users/B/y]]",
        ",|<path>?key=<path>&k2=D:<path>]]",
      ],
      [
        "drive after a public URL",
        ",|\\Users\\S\\x[https://inner?key=https://pub.test/x&k2=C:/Users/K/x]]",
        ",|\\Users\\S\\x[https://inner?key=https://pub.test/x&k2=C:/Users/K/x]]",
        ",|<path>?key=https://pub.test/x&k2=C:/Users/K/x]]",
        ",|<path>?key=https://pub.test/x&k2=C:/Users/K/x]]",
      ],
      [
        "drive inside a nested file child",
        ",|\\Users\\S\\x[file:///b&C:/Users/c]]",
        ",|\\Users\\S\\x[file://<path>&C:/Users/c]]",
        ",|<path><path>&C:<path>]]",
      ],
      [
        "bare drive value",
        ",|\\Users\\S\\x[https://inner?key=C:/]]",
        ",|\\Users\\S\\x[https://inner?key=C:/]]",
        ",|<path>?key=C:/]]",
        ",|<path>?key=C:/]]",
      ],
      [
        "doubled-slash drive value",
        ",|\\Users\\S\\x[https://inner?key=C://x]]",
        ",|\\Users\\S\\x[https://inner?key=C://x]]",
        ",|<path>?key=C://x]]",
        ",|<path>?key=C://x]]",
      ],
      [
        "compound drive value",
        ",|\\Users\\S\\x[https://inner?key=C:/C:/Users/K/x]]",
        ",|\\Users\\S\\x[https://inner?key=C:/C:/Users/K/x]]",
        ",|<path>?key=C:/C:/Users/K/x]]",
        ",|<path>?key=C:<path>:<path>]]",
      ],
    ] as const)(
      "redacts the origin but keeps the base drive pass sequence for the %s",
      (_name, suffix, firstSuffix, secondSuffix, thirdSuffix = secondSuffix) => {
        assertPasses(
          prefix + suffix,
          redactedPrefix + firstSuffix,
          redactedPrefix + secondSuffix,
          redactedPrefix + thirdSuffix,
        );
      },
    );

    it.each([
      ["E1", ",|[file:///b&[https://o?key=/Users/ZQC/x]]", ",|[file://<path>&[https://o?key=<path>]]", ",|[file://<path>&[https://o?key=<path>]]", ",|[file://<path>&[https://o?key=<path>]]"],
      ["E2", ",|/https://pub.test/x?y=/Users/ZQD/x]", ",|<path>?y=/Users/ZQD/x]", ",|<path>?y=<path>]", ",|<path>?y=<path>]"],
      ["E3", "=/Users/ZQB/x[file:///b&[https://o?key=home/ZQC/x]]", "=<path>&[https://o?key=home<path>]]", "=<path>&[https://o?key=home<path>]]", "=<path>&[https://o?key=home<path>]]"],
      ["E4", "=/Users/ZQB/x[file:///b&[https://o?key=/home/ZQC/x]]", "=<path>&[https://o?key=<path>]]", "=<path>&[https://o?key=<path>]]", "=<path>&[https://o?key=<path>]]"],
      ["E5", "=plain&[file:///b&([https://o?key=/Users/ZQC/x]", "=plain&[file://<path>&([https://o?key=<path>]", "=plain&[file://<path>&([https://o?key=<path>]", "=plain&[file://<path>&([https://o?key=<path>]"],
      ["E6", "=/https://pub.test/x?y=/Users/ZQC/x]", "=<path>?y=/Users/ZQC/x]", "=<path>?y=<path>]", "=<path>?y=<path>]"],
      ["N1", ",|\\Users\\SA\\x[file:///b&/home/TA/s]]", ",|\\Users\\SA\\x[file://<path>&<path>]]", ",|<path><path>&<path>]]", ",|<path><path>&<path>]]"],
      ["N2", ",|\\Users\\ZQB\\x[file:///b]]", ",|\\Users\\ZQB\\x[file://<path>]]", ",|<path><path>]]", ",|<path><path>]]"],
      ["W1", ",|\\Users\\SA\\x\u00a0/home/TA/s]", ",|\\Users\\SA\\x\u00a0<path>]", ",|<path><path>]", ",|<path><path>]"],
      ["W2", "=\\Users\\ZQB\\x\u00a0[https://inner?key=C:/Users/ZQD/x]]", "=<path>?key=C:/Users/ZQD/x]]", "=<path>?key=C:<path>]]", "=<path>?key=C:<path>]]"],
      ["W3", "=\\Users\\ZQB\\x\u00a0[https://inner?key=C:/file:///Users/ZQD/x]]", "=<path>?key=C:/file://<path>]]", "=<path>?key=C:<path><path>]]", "=<path>?key=C:<path><path>]]"],
      ["W4", "=\\Users\\SP\\x[https://inner?key=/home/S1/s\u00a0/home/SA/s]]", "=<path>?key=/home/S1/s\u00a0<path>]]", "=<path>?key=<path><path>]]", "=<path>?key=<path><path>]]"],
      ["P1", "=\\Users\\SP\\x[https://inner?key=https://pub.test/p&k4=/home/SA/s]]", "=<path>?key=https://pub.test/p&k4=/home/SA/s]]", "=<path>?key=https://pub.test/p&k4=/home/SA/s]]", "=<path>?key=https://pub.test/p&k4=/home/SA/s]]"],
      ["B1", "=/]", "=/]", "=/]", "=/]"],
      ["B2", "=//]", "=//]", "=//]", "=//]"],
      ["B3", "=/&k=c:/ZQE]", "=/&k=c:<path>]", "=/&k=c:<path>]", "=/&k=c:<path>]"],
      ["D1", "=C:/Users/SECRET/x[https://inner?key=/home/C/s]]", "=C:<path>?key=<path>]]", "=C:<path>?key=<path>]]", "=C:<path>?key=<path>]]"],
      ["D2", "\u200b=C:/Users/SECRET/x[https://inner?key=/home/C/s]]", "\u200b=C:<path>?key=<path>]]", "\u200b=C:<path>?key=<path>]]", "\u200b=C:<path>?key=<path>]]"],
      ["D3", "=\\Users\\S\\x[https://inner?key=C:/Users/K/x]]", "=<path>?key=C:/Users/K/x]]", "=<path>?key=C:<path>]]", "=<path>?key=C:<path>]]"],
      ["D4", ",|\\Users\\S\\x&later/home/SQ&k=K:/Users/x]", ",|\\Users\\S\\x&later/home/SQ&k=K:<path>]", ",|<path>&later<path>&k=K:<path>]", ",|<path>&later<path>&k=K:<path>]"],
      ["T1", "=\\Users\\SECRET\\x[https://inner?key=/home/C/s]]", "=<path>?key=<path>]]", "=<path>?key=<path>]]", "=<path>?key=<path>]]"],
      ["T2", ",|\\Users\\SECRET\\x[https://inner?key=/home/C/s]]", ",|<path>?key=<path>]]", ",|<path>?key=<path>]]", ",|<path>?key=<path>]]"],
      ["T3", "=plain&later/home/alice]", "=plain&later<path>]", "=plain&later<path>]", "=plain&later<path>]"],
      ["C1", "|[file:///b&[https://o?key=/Users/ZQC/x]]", "|[file://<path>&[https://o?key=/Users/ZQC/x]]", "|[file://<path>&[https://o?key=/Users/ZQC/x]]", "|[file://<path>&[https://o?key=/Users/ZQC/x]]"],
      ["C2", "\u200b|/https://pub.test/x?y=/Users/ZQC/x]", "\u200b|<path>https://pub.test/x?y=/Users/ZQC/x]", "\u200b|<path>https://pub.test/x?y=/Users/ZQC/x]", "\u200b|<path>https://pub.test/x?y=/Users/ZQC/x]"],
      ["C3", " \u00ad|\\Users\\S\\x]", " \u00ad|\\Users\\S\\x]", " \u00ad|\\Users\\S\\x]", " \u00ad|\\Users\\S\\x]"],
      ["R2 trailing separator", "=/Users/]", "=<path>]", "=<path>]", "=<path>]"],
      ["R2 soft boundary backslash value", "=\\Users\\S\\x\u00a0[https://inner?key=\\Users\\D\\x]]", "=<path>?key=\\Users\\D\\x]]", "=<path>?key=<path>]]", "=<path>?key=<path>]]"],
      ["R2 soft boundary parenthesised bracket", "=\\Users\\S\\x\u00a0([https://inner?key=/home/D/x]", "=<path>?key=<path>]", "=<path>?key=<path>]", "=<path>?key=<path>]"],
      ["R2 unmatched bracket", ",|\\Users\\S\\x[https://inner?key=/home/C/s", ",|\\Users\\S\\x[https://inner?key=/home/C/s", ",|<path>?key=/home/C/s", ",|<path>?key=<path>"],
    ] as const)("pins round-2 synthesis row %s", (_id, inputSuffix, firstSuffix, secondSuffix, thirdSuffix) => {
      const first = sanitizeError(prefix + inputSuffix);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(redactedPrefix + firstSuffix);
      expect(second).toBe(redactedPrefix + secondSuffix);
      expect(third).toBe(redactedPrefix + thirdSuffix);
    });

    it.each([
      ["S1", "=\\Users\\ZQA\\x[x]&[file:///b&[https://o?key=/Users/ZQE/x]]]", "=<path>&[file://<path>&[https://o?key=<path>]]]", "=<path>&[file://<path>&[https://o?key=<path>]]]", "=<path>&[file://<path>&[https://o?key=<path>]]]"],
      ["S2", ",|\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]&[file:///b&[https://o?key=/Users/ZQE/x]]]", ",|\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]&[file://<path>&[https://o?key=<path>]]]", ",|<path>?key=/home/ZQC/s]&[file://<path>&[https://o?key=<path>]]]", ",|<path>?key=<path>]&[file://<path>&[https://o?key=<path>]]]"],
      ["S3", "=\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]&/https://pub.test/x?y=C:/Users/ZQE/x]", "=<path>?key=/home/ZQC/s]&<path>?y=C:/Users/ZQE/x]", "=<path>?key=<path>]&<path>?y=C:<path>]", "=<path>?key=<path>]&<path>?y=C:<path>]"],
      ["S4", "=/Users/ZQV/x[https://inner?key=plain]&later/home/ZQU]", "=<path>?key=plain]&later/home/ZQU]", "=<path>?key=plain]&later/home/ZQU]", "=<path>?key=plain]&later/home/ZQU]"],
      ["S5", "=\\Users\\ZQA\\x[x][https://j?key=C:/Users/ZQE/x]]", "=<path>?key=C:/Users/ZQE/x]]", "=<path>?key=C:<path>]]", "=<path>?key=C:<path>]]"],
      ["S6", "=\\Users\\ZQA\\x[https://i?key=/home/ZQC/s][https://j?key=/Users/ZQE/x]]", "=<path>?key=/home/ZQC/s][https://j?key=/Users/ZQE/x]]", "=<path>?key=<path>][https://j?key=/Users/ZQE/x]]", "=<path>?key=<path>][https://j?key=/Users/ZQE/x]]"],
      ["S7", "=C:/]", "=C:/]", "=C:/]", "=C:/]"],
      ["S8", "=C://ZQA/x]", "=C://ZQA/x]", "=C://ZQA/x]", "=C://ZQA/x]"],
      ["S9", "=C:///ZQA[https://i?key=/home/ZQC/s]]", "=C:///ZQA[https://i?key=/home/ZQC/s]]", "=C:///ZQA[https://i?key=/home/ZQC/s]]", "=C:///ZQA[https://i?key=/home/ZQC/s]]"],
      ["S10", "=C://ZQA/x[https://i?key=/home/ZQC/s]&k=\\Users\\ZQE\\x]", "=C://ZQA/x[https://i?key=/home/ZQC/s]&k=\\Users\\ZQE\\x]", "=C://ZQA/x[https://i?key=/home/ZQC/s]&k=<path>]", "=C://ZQA/x[https://i?key=/home/ZQC/s]&k=<path>]"],
      ["S11", "=C://ZQA/x&k=/Users/ZQE/x]", "=C://ZQA/x&k=/Users/ZQE/x]", "=C://ZQA/x&k=/Users/ZQE/x]", "=C://ZQA/x&k=/Users/ZQE/x]"],
      ["S13", ",|\\Users\\ZQA\\x(/Users/ZQE/x)]", ",|\\Users\\ZQA\\x(<path>)]", ",|<path><path>)]", ",|<path><path>)]"],
      ["S14", "=\\Users\\ZQA\\x[https://i#\\Users\\ZQE\\x]]", "=<path>#\\Users\\ZQE\\x]]", "=<path>#\\Users\\ZQE\\x]]", "=<path>#\\Users\\ZQE\\x]]"],
      ["S15", ",|/Users/ZQA/x[https://i#\\Users\\ZQE\\x]]", ",|<path>#\\Users\\ZQE\\x]]", ",|<path>#\\Users\\ZQE\\x]]", ",|<path>#\\Users\\ZQE\\x]]"],
      ["strict drive dangling separator", "=C:/Users/]", "=C:<path>]", "=C:<path>]", "=C:<path>]"],
      ["strict drive terminal value", "=C:/Users/x", "=C:<path>", "=C:<path>", "=C:<path>"],
    ] as const)("pins final-round synthesis row %s", (_id, inputSuffix, firstSuffix, secondSuffix, thirdSuffix) => {
      const first = sanitizeError(prefix + inputSuffix);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(redactedPrefix + firstSuffix);
      expect(second).toBe(redactedPrefix + secondSuffix);
      expect(third).toBe(redactedPrefix + thirdSuffix);
    });

    it("pins final-round synthesis row S12", () => {
      const input = "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=C:/Users/ZQB/x]]";
      const expected = "file://h?x=['https://o.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'=<path>]]";
      const first = sanitizeError(input);
      const second = sanitizeError(first);
      const third = sanitizeError(second);

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(third).toBe(expected);
    });

    it.each([
      [
        "fallback200k",
        "file://h?x=[" + "'https://o.test/x?next=file:///U/a',|v".repeat(5200) + "]",
        208_013,
        "c024dc35c125ec3d29e87a32bc8dc1722927774a087454b9baa9e92f8f603917",
      ],
      [
        "eqPosix200k",
        "file://h?x=[" + "'https://o.test/x?next=file:///U/a'=/U/v".repeat(5000) + "]",
        220_013,
        "95f18a3141abec73b4e16f103533842c9b5d7a1e7b3545ee38179c9145737a08",
      ],
      [
        "eqBackslash200k",
        "file://h?x=[" + "'https://o.test/x?next=file:///U/a'=\\U\\v".repeat(5000) + "]",
        220_013,
        "95f18a3141abec73b4e16f103533842c9b5d7a1e7b3545ee38179c9145737a08",
      ],
      [
        "longR",
        prefix + "x".repeat(200_000) + "|\\Users\\S\\x]",
        200_061,
        "679daaef1c2c504dd9691c3e2cffb0dde22a7c287237b16bcc2e33fe5c7f9793",
      ],
    ] as const)("matches the frozen oracle for %s in linear time", (_name, input, expectedLength, expectedHash) => {
      let value = input;
      for (let pass = 0; pass < 3; pass += 1) {
        const started = performance.now();
        value = sanitizeError(value);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(2_000);
        expect(value).toHaveLength(expectedLength);
        expect(createHash("sha256").update(value).digest("hex")).toBe(expectedHash);
      }
    });

    describe("escalation refusal guards", () => {
      const assertStable = (input: string, expected: string): void => {
        const first = sanitizeError(input);
        const second = sanitizeError(first);
        const third = sanitizeError(second);

        expect(first).toBe(expected);
        expect(second).toBe(expected);
        expect(third).toBe(expected);
      };

      it.each([
        [
          "A-F1a",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=\\Users\\ZQB\\x][https://j?key=/Users/ZQD/x]]",
          "file://h?x=['https://outer.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'=<path>][https://j?key=<path>]]",
        ],
        [
          "A-F1b",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a',|\\Users\\ZQB\\x][https://j?key=C:/Users/ZQD/x]]",
          "file://h?x=['https://outer.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>',|<path>][https://j?key=<path>]]",
        ],
        [
          "A-F1c",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'\u200b|\\Users\\ZQA\\x[file:///b&'https://o.test/x?next=file:///Users/ZQR/a'x&later/home/ZQB][https://j?key=\\Users\\ZQD\\x]]",
          "file://h?x=['https://outer.test/x?next=file://<path>'\u200b|<path>&'https://o.test/x?next=file://<path>'x&later<path>][https://j?key=<path>]]",
        ],
        [
          "A-F1d",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'&/Users/ZQA/x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=/Users/ZQB/x][file:///b&C:/Users/ZQD/x]]",
          "file://h?x=['https://outer.test/x?next=file://<path>'&<path>?key='https://o.test/x?next=file://<path>'=<path>][file://<path>&<path>]]",
        ],
        [
          "A-F1e",
          "file://h?x=[file:///Users/CHILD/x|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'==\\Users\\ZQB\\x][https://j?key=/Users/ZQD/x]]",
          "file://h?x=[file://<path>|<path>?key='https://o.test/x?next=file://<path>'==<path>][https://j?key=<path>]]",
        ],
        [
          "A-F2a",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/b[c'=\\Users\\ZQA\\x]&later/home/ZQD]",
          "file://h?x=['https://outer.test/x?next=file://<path>'=<path>]&later<path>]",
        ],
        [
          "A-F2b",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/b[c',|\\Users\\ZQA\\x]&\\Users\\ZQD\\x]",
          "file://h?x=['https://outer.test/x?next=file://<path>',|<path>]&<path>]",
        ],
        [
          "A-F2c",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/b[c'=\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]]&later/home/ZQD]",
          "file://h?x=['https://outer.test/x?next=file://<path>'=<path>?key=<path>]]&later<path>]",
        ],
        [
          "B-P1-1a",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=\\Users\\ZQB\\x][https://j?key=/Users/ZQE/x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'=<path>][https://j?key=<path>]]",
        ],
        [
          "B-P1-1b",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a',|\\Users\\ZQB\\x][https://j?key=C:/Users/ZQE/x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>',|<path>][https://j?key=<path>]]",
        ],
        [
          "B-P1-1c",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'\u200b|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'x&later/home/ZQB][file:///b&[https://o?key=/Users/ZQE/x]]]",
          "file://h?x=['https://o.test/x?next=file://<path>'\u200b|<path>?key='https://o.test/x?next=file://<path>'x&later<path>][file://<path>&[https://o?key=<path>]]]",
        ],
        [
          "B-P1-1d",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'&/Users/ZQA/x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=/Users/ZQB/x][https://j?key=\\Users\\ZQE\\x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'&<path>?key='https://o.test/x?next=file://<path>'=<path>][https://j?key=<path>]]",
        ],
        [
          "B-P1-1e",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|later/home/ZQA[https://i?key=/home/ZQC/s&k='https://o.test/x?next=file:///Users/ZQR/a'==\\Users\\ZQB\\x][https://j?key=C:/Users/ZQE/x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'|later<path>?key=<path>&k='https://o.test/x?next=file://<path>'==<path>][https://j?key=<path>]]",
        ],
        [
          "B-P1-2a",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP/p.db?v=[1'=\\Users\\ZQA\\x]|later/home/ZQE",
          "file://h?x=['https://outer.test/x?next=file://<path>'=<path>]|later<path>",
        ],
        [
          "B-P1-2b",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP[/p.db'=\\Users\\ZQA\\x]&k=\\Users\\ZQE\\x",
          "file://h?x=['https://outer.test/x?next=file://<path>'=<path>]&k=<path>",
        ],
        [
          "B-P1-2c",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP[/p.db'\u00ad|\\Users\\ZQA\\x[https://i?key=\\Users\\ZQC\\s]]&k=\\Users\\ZQE\\x",
          "file://h?x=['https://outer.test/x?next=file://<path>'\u00ad|<path>?key=<path>]]&k=<path>",
        ],
        [
          "B-P1-2d",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP[/p.db'\u200b=\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]]'https://o.test/x?next=file:///Users/ZQR/a'=\\Users\\ZQF\\x[https://j?key=/home/ZQG/s]",
          "file://h?x=['https://outer.test/x?next=file://<path>'\u200b=<path>?key=<path>]]'https://o.test/x?next=file://<path>'=<path>?key=<path>]",
        ],
        [
          "B-P1-2e",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP/p.db#[x'=plain&later/home/ZQA]|later/home/ZQE]",
          "file://h?x=['https://outer.test/x?next=file://<path>'=plain&later<path>]|later<path>]",
        ],
      ] as const)("refuses the new arm on synthesis row %s and keeps the oracle fixed point", (_id, input, expected) => {
        assertStable(input, expected);
      });

      it.each([
        [
          "A-F1-ctl-fwd",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/My Files/private.db'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=C:/Users/ZQB/x][https://j?key=/Users/ZQD/x]]",
          "file://h?x=['https://outer.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'=<path>][https://j?key=<path>]]",
        ],
        [
          "A-F2d",
          "file://h?x=['https://outer.test/x?next=file:///Users/a/b[c]d'x&later/home/ZQA]&\\Users\\ZQD\\x]",
          "file://h?x=['https://outer.test/x?next=file://<path>'x&later<path>]&\\Users\\ZQD\\x]",
        ],
        [
          "B-P1-2f",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP/p[1.db',|\\Users\\ZQA\\x]&k=/Users/ZQE/x",
          "file://h?x=['https://outer.test/x?next=file://<path>',|<path>]&k=<path>",
        ],
        [
          "B-ctl-imm-unbalanced",
          "file://h?x=['https://outer.test/x?next=file:///Users/ZQP[/p.db'|\\Users\\ZQA\\x]&k=\\Users\\ZQE\\x",
          "file://h?x=['https://outer.test/x?next=file://<path>'|<path>]&k=\\Users\\ZQE\\x",
        ],
        [
          "B-ctl-inner-immediate",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'|\\Users\\ZQB\\x][https://j?key=/Users/ZQE/x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'|<path>][https://j?key=/Users/ZQE/x]]",
        ],
        [
          "B-ctl-inner-drive-guarded",
          "file://h?x=['https://o.test/x?next=file:///Users/ZQP/a'|\\Users\\ZQA\\x[https://i?key='https://o.test/x?next=file:///Users/ZQR/a'=C:/Users/ZQB/x][https://j?key=/Users/ZQE/x]]",
          "file://h?x=['https://o.test/x?next=file://<path>'|<path>?key='https://o.test/x?next=file://<path>'=<path>][https://j?key=<path>]]",
        ],
      ] as const)("keeps synthesis control %s byte-identical to the oracle", (_id, input, expected) => {
        assertStable(input, expected);
      });

      it("keeps the bracket-noise quote row A-F4d exactly at the oracle", () => {
        assertStable(
          "file://h?x=['https://outer.test/x?next=file:///Users/a/b[c',|\\Users\\ZQA\\x[https://i?key=/home/ZQC/s]]&/https://pub.test/x?y=/Users/ZQD/x]",
          "file://h?x=['https://outer.test/x?next=file://<path>',|<path>?key=<path>]]&<path>https://pub.test/x?y=/Users/ZQD/x]",
        );
      });
    });
  });


  describe("Bug #917", () => {
    const matrix: Array<readonly [string, string, string]> = (["'", '"'] as const).flatMap(
      (quote) =>
        (["?", "#", "&"] as const).flatMap((delimiter) =>
          (["", "?keep=1", "#frag", "&other=1"] as const).map((suffix) => [
            `${quote} outer quote, ${delimiter} delimiter, ${suffix || "no suffix"}`,
            `${quote}https://outer.test/x${delimiter}next=file://host.invalid/Users/canary/My Files/private.db${suffix}${quote} trailing text`,
            `${quote}https://outer.test/x${delimiter}next=file://host.invalid<path>${quote} trailing text`,
          ] as const),
        ),
    );
    matrix.push(
      [
        "unquoted residual",
        "https://outer.test/x?next=file://host.invalid/Users/canary/My Files/private.db",
        "https://outer.test/x?next=file://host.invalid<path> Files/private.db",
      ],
      [
        "quote does not open an embedded URL",
        "error 'see https://outer.test/x?next=file://host.invalid/Users/canary/My Files/private.db' end",
        "error 'see https://outer.test/x?next=file://host.invalid<path> Files/private.db' end",
      ],
      [
        "immediately quoted nested file child",
        "https://outer.test/x?next='file://host.invalid/Users/canary/My Files/private.db'",
        "https://outer.test/x?next='file://host.invalid<path>'",
      ],
      [
        "unmatched outer quote residual",
        "'https://outer.test/x?next=file://host.invalid/Users/canary/My Files/private.db",
        "'https://outer.test/x?next=file://host.invalid<path> Files/private.db",
      ],
      [
        "newline terminates inherited quoting",
        "'https://outer.test/x?next=file://host.invalid/Users/canary/My\nFiles/private.db'",
        "'https://outer.test/x?next=file://host.invalid<path>\nFiles/private.db'",
      ],
      [
        "outer-quoted public URL without file child",
        "'https://outer.test/x?next=https://public.test/path'",
        "'https://outer.test/x?next=https://public.test/path'",
      ],
      [
        "outer-quoted file URL control",
        "'file://host.invalid/Users/canary/My Files/private.db'",
        "'file://host.invalid<path>'",
      ],
      [
        "multiple nested children share one quote boundary",
        "'https://outer.test/x?k0=file://host/Users/u/MyFiles/0.db&k1=file://host/Users/u/MyFiles/1.db'",
        "'https://outer.test/x?k0=file://host<path>'",
      ],
    );

    it.each(matrix)("%s", (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    });
  });

  it("preserves the Bug #1336 root anchor after the pipe-handoff fix", () => {
    const input =
      "file://h?x=[https://e.test/t&/Users/a/one&file:///Users/b/two&relative/path]";
    const expected =
      "file://h?x=[https://e.test/t&<path>&file://<path>&relative/path]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "ampersand delimiter",
      "file://h?x=[https://e.test/t&file://host?key=/public&later/Users/secret]",
      "file://h?x=[https://e.test/t&file://host?key=<path>&later/Users/secret]",
    ],
    [
      "pipe delimiter",
      "file://h?x=[https://e.test/t&file://host?key=/public|later/Users/secret]",
      "file://h?x=[https://e.test/t&file://host?key=<path>|later/Users/secret]",
    ],
    [
      "pipe scheme then ampersand tail",
      "file://h?x=[https://e.test/t|file://host?key=/public&later/Users/secret]",
      "file://h?x=[https://e.test/t|file://host?key=<path>&later/Users/secret]",
    ],
    [
      "pipe scheme then pipe tail",
      "file://h?x=[https://e.test/t|file://host?key=/public|later/Users/secret]",
      "file://h?x=[https://e.test/t|file://host?key=<path>|later/Users/secret]",
    ],
  ] as const)(
    "keeps the relative tail unchanged after a query-only nested file child return via %s",
    (_name, input, expected) => {
      const first = sanitizeError(input);

      expect(first).toBe(expected);
      expect(first).toContain("later/Users/secret");
      expect(sanitizeError(first)).toBe(first);
      expect(sanitizeError(sanitizeError(first))).toBe(first);
    },
  );

  it("keeps independent query-only nested-file restart depths isolated", () => {
    const input =
      "file://h?x=[file://a?k=/pub&later1/Users/one&[file://b?k=/pub|\\Users\\S2]&later2/Users/two]";
    const expected =
      "file://h?x=[file://a?k=<path>&later1/Users/one&[file://b?k=<path>|<path>]&later2/Users/two]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).toContain("later1/Users/one");
    expect(first).toContain("later2/Users/two");
    expect(first).not.toContain("S2");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("clears the query-only nested-file pipe/ampersand handoff at whitespace", () => {
    const input =
      "file://h?x=[https://e.test/t&file://host?key=/public whitespace|\\Users\\SECRET\\x]";
    const expected =
      "file://h?x=[https://e.test/t&file://host?key=<path> whitespace|\\Users\\SECRET\\x]";
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "ampersand nested child",
      "file://h?x=[[https://e.test/t&file://host?key=/public]\\Users\\SECRET\\x]",
      "file://h?x=[[https://e.test/t&file://host?key=<path>]<path>]",
    ],
    [
      "pipe nested child",
      "file://h?x=[[https://e.test/t|file://host?key=/public]\\Users\\SECRET\\x]",
      "file://h?x=[[https://e.test/t|file://host?key=<path>]<path>]",
    ],
  ] as const)("pins the Bug #1346 query-only nested-file handoff after its bracket for %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
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

  it("bounds adjacent recognized file URL classification work by input length", () => {
    const prefix = "request failed for https://outer.test/x?q=";
    const tokens = Array.from(
      { length: 256 },
      (_, index) => `file://host-${index}.invalid/Users/canary/private-${index}.db`,
    );
    const input = `${prefix}${tokens.join("-")}`;
    const expected = `${prefix}${tokens
      .map((_, index) => `file://host-${index}.invalid<path>`)
      .join("")}`;
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

    expect(result).toBe(expected);
    expect(sanitizeError(result)).toBe(result);
    expect(result.match(/file:\/\//gu)).toHaveLength(tokens.length);
    expect(result.match(/<path>/gu)).toHaveLength(tokens.length);
    expect(whitespaceChecks).toBeLessThanOrEqual(Array.from(input).length);
  });

  it.each([
    [
      "drive root arms the wrapper tail",
      "file://h?x=[https://e.test/t|C:\\Users\\alice\\one.db]\\Users\\bob\\secret.db",
      "file://h?x=[https://e.test/t|<path>]<path>",
    ],
    [
      "drive root arms a repeated in-wrapper handoff",
      "file://h?x=[https://e.test/t|C:\\Users\\alice\\one.db&\\Users\\bob\\x]",
      "file://h?x=[https://e.test/t|<path>&<path>]",
    ],
    [
      "backslash root control",
      "file://h?x=[https://e.test/t|\\Users\\alice\\one.db]\\Users\\bob\\secret.db",
      "file://h?x=[https://e.test/t|<path>]<path>",
    ],
    [
      "slash root control",
      "file://h?x=[https://e.test/t|/Users/alice/one.db]/Users/bob/secret.db",
      "file://h?x=[https://e.test/t|<path>]<path>",
    ],
    [
      "ampersand drive root control",
      "file://h?x=[https://e.test/t&C:\\Users\\alice\\one.db]\\Users\\bob\\secret.db",
      "file://h?x=[https://e.test/t&<path>]<path>",
    ],
  ] as const)("arms the nested-public handoff on a drive root (Bug #1348): %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(first).not.toContain("bob");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    "file://h?x=[https://e.test/t|relative/path]\\Users\\bob\\secret.db",
    "file://h?x=[https://e.test/t|C:relative]\\Users\\bob\\secret.db",
  ] as const)("does not arm the Bug #1348 handoff without a path root: %s", (input) => {
    expect(sanitizeError(input)).toBe(input);
    expect(sanitizeError(sanitizeError(input))).toBe(input);
    expect(sanitizeError(sanitizeError(sanitizeError(input)))).toBe(input);
  });

  // Bug #1345 asked whether "," and ";" should join "&" and "|" as sibling
  // handoff delimiters. They should not: both are already URL-end delimiters
  // throughout this grammar and are listed in FILE_URL_AUTHORITY_DELIMITERS,
  // so promoting them would change the meaning of every wrapper that uses
  // them as ordinary separators. The boundary is pinned here so the decision
  // is deliberate rather than incidental. Note the residual surface is narrow:
  // only the single-leading-backslash Windows form survives these delimiters,
  // because POSIX and drive roots still redact through the private-root rules.
  it.each([
    [
      "comma does not hand off",
      "file://h?x=[https://e.test/t|/Users/a/one,\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|<path>,\\Users\\SECRET\\x]",
    ],
    [
      "semicolon does not hand off",
      "file://h?x=[https://e.test/t|/Users/a/one;\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|<path>;\\Users\\SECRET\\x]",
    ],
    [
      "ampersand does hand off",
      "file://h?x=[https://e.test/t|/Users/a/one&\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|<path>&<path>]",
    ],
    [
      "pipe does hand off",
      "file://h?x=[https://e.test/t|/Users/a/one|\\Users\\SECRET\\x]",
      "file://h?x=[https://e.test/t|<path>|<path>]",
    ],
    [
      "comma still redacts a POSIX root",
      "file://h?x=[https://e.test/t|/Users/a/one,/Users/b/two]",
      "file://h?x=[https://e.test/t|<path>,<path>]",
    ],
    [
      "semicolon still redacts a drive root",
      "file://h?x=[https://e.test/t|/Users/a/one;C:\\Users\\b\\two]",
      "file://h?x=[https://e.test/t|<path>;<path>]",
    ],
  ] as const)("pins the Bug #1345 sibling delimiter boundary: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    ["ampersand then query", "file://h/a&?/Users/A/secret.db", "file://h<path>&?<path>"],
    ["query parameter then ampersand", "file://h/a?q=1&/Users/alice/secret.db", "file://h<path>?q=1&<path>"],
    ["surrounding text", "see file://h/a&?/Users/A/secret.db end", "see file://h<path>&?<path> end"],
    ["Unicode symbol component", "file://h/a&/📁/secret.db", "file://h<path>&<path>"],
    ["Unicode symbol component after a question mark", "file://h/a&?/📁/secret.db", "file://h<path>&?<path>"],
  ] as const)("redacts a root after an unbracketed file URL path ampersand on the first pass: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "bracketed public child query",
      "file://h/a?q=[https://e.test/t?key=/public&/word]",
      "file://h<path>?q=[https://e.test/t?key=/public&/word]",
    ],
    [
      "bracketed public child query after a question mark",
      "file://h/a?q=[https://e.test/t?key=/public&?/word]",
      "file://h<path>?q=[https://e.test/t?key=/public&?/word]",
    ],
    ["top-level public URL", "https://h/a?x=1&/word", "https://h/a?x=1&/word"],
    ["plain text", "a&/b", "a&<path>"],
    ["repeated ampersand with a bare slash", "file:///a?q=&&/ end", "file://<path>?q=&&/ end"],
    ["trailing bare slash", "file://h/a&/", "file://h<path>&/"],
  ] as const)("keeps the first-pass output of a non-private ampersand successor: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("redacts a root after an ampersand in an unbracketed nested public URL query (intended stable-output change)", () => {
    const first = sanitizeError("file://h/a?u=http://x/y&/Users/x/s.db");

    expect(first).toBe("file://h<path>?u=http://x/y&<path>");
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("does not rescan a long file URL path suffix at every non-ampersand slash", () => {
    const input = `file://h${"/a".repeat(16384)}`;
    const started = performance.now();
    const result = sanitizeError(input);
    const elapsed = performance.now() - started;

    expect(result).toBe("file://h<path>");
    // Linear takes milliseconds; the quadratic rescan took several seconds.
    expect(elapsed).toBeLessThan(1000);
  });

  it.each([
    ["question mark", "file://h/a?/Users/x", "file://h<path>?<path>"],
    ["query parameter", "file://h/a?q=/Users/x", "file://h<path>?q=<path>"],
    ["surrounding text", "see file://h/a?q=/Users/x end", "see file://h<path>?q=<path> end"],
    ["empty authority", "file:///a?q=/Users/x", "file://<path>?q=<path>"],
    ["repeated question marks", "file://h/a??/Users/x", "file://h<path>??<path>"],
    ["repeated equals signs", "file://h/a?q==/Users/x", "file://h<path>?q==<path>"],
    ["fragment parameter", "file://h/a#q=/Users/x", "file://h<path>#q=<path>"],
    ["Unicode symbol component", "file://h/a?q=/📁/secret.db", "file://h<path>?q=<path>"],
    [
      "before an unbracketed public URL parameter",
      "file://h/a?q=/Users/secret&u=https://e.test/t?key=/public",
      "file://h<path>?q=<path>&u=https://e.test/t?key=/public",
    ],
    [
      "before a question mark and an unbracketed public URL",
      "file://h/a?q=/Users/x?u=https://e.test/t?key=/public",
      "file://h<path>?q=<path>?u=https://e.test/t?key=/public",
    ],
    [
      "after a bracketed backslash query segment",
      "file://h/a?q=[\\Users\\b]?q=/Users/x",
      "file://h<path>?q=[<path>]?q=<path>",
    ],
    [
      "after a closed bracketed public URL",
      "file://h/a?q=[https://e.test/t]?/Users/y",
      "file://h<path>?q=[https://e.test/t]?<path>",
    ],
    [
      "after a closed bracketed public URL named parameter",
      "file://h/a?q=[https://e.test/t]=/Users/y",
      "file://h<path>?q=[https://e.test/t]=<path>",
    ],
    [
      "after a public URL and an ampersand root",
      "file://h/a?u=https://e.test/t&/Users/a?q=/Users/x",
      "file://h<path>?u=https://e.test/t&<path>?q=<path>",
    ],
    [
      "after a scheme-like path span",
      "file://h/a?q=/https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "after a scheme-like path component",
      "file://h/a?q=/Users/x://y?w=/Users/z",
      "file://h<path>?q=<path>?w=<path>",
    ],
    [
      "after a backslash scheme-like path span",
      "file://h/a?q=\\https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "after a backslash-joined scheme-like path span",
      "file://h/a\\https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>",
    ],
    [
      "after a digit-leading pseudo scheme",
      "file://h/a?1ab://x?q=/Users/x",
      "file://h<path>?1ab://x?q=<path>",
    ],
  ] as const)("redacts a root after an unbracketed file URL path query delimiter on the first pass: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "bracketed public child query",
      "file://h/a?q=[https://e.test/t?key=/public]",
      "file://h<path>?q=[https://e.test/t?key=/public]",
    ],
    [
      "bracketed public child query question mark",
      "file://h/a?q=[https://e.test/t?/public]",
      "file://h<path>?q=[https://e.test/t?/public]",
    ],
    ["top-level public URL question mark", "https://h/a?/word", "https://h/a?/word"],
    ["top-level public URL equals sign", "https://h/a?q=/word", "https://h/a?q=/word"],
    ["plain text equals sign", "a=/b", "a=<path>"],
    ["trailing bare slash after question mark", "file://h/a?/", "file://h<path>?/"],
    ["trailing bare slash after equals sign", "file://h/a?q=/", "file://h<path>?q=/"],
    ["bracketed query value", "file://h/a?[q=/Users/x]", "file://h<path>?[q=<path>]"],
    [
      "unbracketed public URL query",
      "file://h/a?u=https://cdn.test/logo?next=/public/path",
      "file://h<path>?u=https://cdn.test/logo?next=/public/path",
    ],
    [
      "unbracketed public URL question mark",
      "file://h/a?u=https://e.test/t?/public",
      "file://h<path>?u=https://e.test/t?/public",
    ],
    [
      "unbracketed public URL named parameter",
      "file://h/a?u=https://e.test/t?a=1&k=/public",
      "file://h<path>?u=https://e.test/t?a=1&k=/public",
    ],
    [
      "unbracketed public URL query then ampersand root",
      "file://h/a?u=https://e.test/t?key=/public&/Users/secret",
      "file://h<path>?u=https://e.test/t?key=/public&<path>",
    ],
    [
      "unbracketed public URL fragment",
      "file://h/a#u=https://e.test/t#k=/public",
      "file://h<path>#u=https://e.test/t#k=/public",
    ],
    [
      "unbracketed public URL then slash value",
      "file://h/a?u=http://x/y?k=/Users/x",
      "file://h<path>?u=http://x/y?k=/Users/x",
    ],
    [
      "public URL after an ampersand",
      "file://h/a&u=https://e.test/t?k=/public",
      "file://h<path>&u=https://e.test/t?k=/public",
    ],
    [
      "public URL after an equals sign",
      "file://h/a=https://e.test/t?k=/public",
      "file://h<path>=https://e.test/t?k=/public",
    ],
    [
      "public URL after an ampersand with a dotted host",
      "file://h/a&u=https://example.com/t?k=/public",
      "file://h<path>&u=https://example.com/t?k=/public",
    ],
    [
      "public URL directly after an ampersand",
      "file://h/a&https://e.test/t?k=/public",
      "file://h<path>&https://e.test/t?k=/public",
    ],
    [
      "plain public URL after an ampersand",
      "file://h/a&u=http://x/y?k=/public",
      "file://h<path>&u=http://x/y?k=/public",
    ],
  ] as const)("keeps the first-pass output of a non-private query delimiter successor: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("keeps the bracketed-authority start after a later query backslash restart", () => {
    const first = sanitizeError("file://h[/Users/a]?q=\\Users\\b?/Users/x");

    expect(first).toBe("file://h[<path>]?q=<path>?/Users/x");
    expect(sanitizeError(first)).toBe("file://h[<path>]?q=<path>?<path>");
    expect(sanitizeError(sanitizeError(first))).toBe("file://h[<path>]?q=<path>?<path>");
  });

  it("does not rescan a long file URL path suffix at every query delimiter slash", () => {
    const input = `file://h${"/a?".repeat(16384)}${"=/a".repeat(16384)}`;
    const started = performance.now();
    const result = sanitizeError(input);
    const elapsed = performance.now() - started;

    expect(result).not.toContain("/a");
    // Linear takes milliseconds; a rescan at every delimiter would take seconds.
    expect(elapsed).toBeLessThan(1000);
  });

  it.each([
    ["fragment root", "file://h/a#/Users/x", "file://h<path>#<path>"],
    ["fragment root with surrounding text", "see file:///a#/Users/x end", "see file://<path>#<path> end"],
    [
      "scheme inside a query root",
      "file://h/a?q=/Users/_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "scheme inside a backslash restart after a public URL",
      "file://h/a?u=https://e.test/t&\\Users\\b?q=/Users/x",
      "file://h<path>?u=https://e.test/t&<path>?q=<path>",
    ],
    [
      "scheme inside a backslash restart",
      "file://h/a?q=\\Users\\_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "scheme inside a backslash restart after a fragment marker",
      "file://h/a#q=\\Users\\_https://e.test/t?q=/Users/x",
      "file://h<path>#q=<path>?q=<path>",
    ],
    [
      "fragment root after a backslash restart scheme",
      "file://h/a?q=\\Users\\_https://e.test/t#/Users/x",
      "file://h<path>?q=<path>#<path>",
    ],
    [
      "scheme inside a backslash restart after an equals run",
      "file://h/a?q==\\Users\\_https://e.test/t?q=/Users/x",
      "file://h<path>?q==<path>?q=<path>",
    ],
    [
      "scheme inside a backslash restart after a public URL and an ampersand",
      "file://h/a?u=https://e.test/t&\\Users\\_https://e.test/t?q=/Users/x",
      "file://h<path>?u=https://e.test/t&<path>?q=<path>",
    ],
    [
      "scheme inside a path joined by a backslash",
      "file://h/a\\_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>",
    ],
    [
      "scheme inside the initial path",
      "file://h/Users/_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>",
    ],
    [
      "fragment root after a scheme inside the initial path",
      "file://h/Users/_https://e.test/t#/Users/x",
      "file://h<path>#<path>",
    ],
    [
      "scheme inside the initial path of an empty authority",
      "file:///Users/_https://e.test/t?q=/Users/x",
      "file://<path>?q=<path>",
    ],
    [
      "scheme inside a drive-rooted query path",
      "file://h/a?q=/C:/Users/_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "scheme inside a bare drive-rooted query path",
      "file://h/a?q=/C:/_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "scheme inside a doubled-slash drive-rooted query path",
      "file://h/a?q=//C:/Users/_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
    [
      "backslash after a path segment of an unbracketed public URL",
      "file://h/a?u=https://e.test/t?k=\\public?x=/public2",
      "file://h<path>?u=https://e.test/t?k=<path>?x=<path>",
    ],
    [
      "backslash inside the path of an unbracketed public URL",
      "file://h/a?u=https://e.test/t\\public?k=/public",
      "file://h<path>?u=https://e.test/t<path>?k=<path>",
    ],
    [
      "scheme inside a drive path with backslashes",
      "file://h/a?q=/C:\\Users\\_https://e.test/t?q=/Users/x",
      "file://h<path>?q=<path>?q=<path>",
    ],
  ] as const)("redacts a successor root after a fragment marker or a scheme inside a private span on the first pass: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it.each([
    [
      "public URL after a question mark",
      "file://h/a?_https://e.test/t?k=/public",
      "file://h<path>?_https://e.test/t?k=/public",
    ],
    [
      "public URL after an ampersand",
      "file://h/a&u=https://e.test/t?k=/public",
      "file://h<path>&u=https://e.test/t?k=/public",
    ],
    [
      "public URL query fragment",
      "file://h/a?u=https://e.test/t#/public",
      "file://h<path>?u=https://e.test/t#/public",
    ],
    [
      "public URL after a private query root",
      "file://h/a?q=/Users/x&u=https://e.test/t?k=/public",
      "file://h<path>?q=<path>&u=https://e.test/t?k=/public",
    ],
    [
      "public URL after a backslash restart",
      "file://h/a?q=\\Users\\b?u=https://e.test/t?k=/public",
      "file://h<path>?q=<path>?u=https://e.test/t?k=/public",
    ],
    [
      "public URL fragment after a private query root",
      "file://h/a?q=/Users/x?u=https://e.test/t#/public",
      "file://h<path>?q=<path>?u=https://e.test/t#/public",
    ],
    [
      "bracketed public URL fragment",
      "file://h/a?q=[https://e.test/t#/public]",
      "file://h<path>?q=[https://e.test/t#/public]",
    ],
    ["bare slash after a fragment marker", "file://h/a#/", "file://h<path>#/"],
    ["doubled slash after a fragment marker", "file://h/a#//", "file://h<path>#//"],
  ] as const)("keeps the first-pass output of a public URL or bare delimiter after a private span: %s", (_name, input, expected) => {
    const first = sanitizeError(input);

    expect(first).toBe(expected);
    expect(sanitizeError(first)).toBe(first);
    expect(sanitizeError(sanitizeError(first))).toBe(first);
  });

  it("keeps main's two-pass behavior for a fragment root after a bracketed authority path", () => {
    const first = sanitizeError("file://h[/Users/a]#/Users/x");

    expect(first).toBe("file://h[<path>]#/Users/x");
    expect(sanitizeError(first)).toBe("file://h[<path>]#<path>");
    expect(sanitizeError(sanitizeError(first))).toBe("file://h[<path>]#<path>");
  });

  it("redacts long runs of fragment roots and scheme-bearing private spans in linear time", () => {
    const input = [
      "file://h/a",
      "#/Users/x".repeat(2048),
      "?q=/Users/_https://e.test/t".repeat(2048),
      "?q=\\x_https://e.test/t".repeat(2048),
    ].join("");
    const started = performance.now();
    const result = sanitizeError(input);
    const elapsed = performance.now() - started;

    expect(result).not.toContain("/Users/");
    expect(result).not.toContain("\\x");
    expect(sanitizeError(result)).toBe(result);
    // Linear takes milliseconds; a rescan at every private start would take seconds.
    expect(elapsed).toBeLessThan(1000);
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
