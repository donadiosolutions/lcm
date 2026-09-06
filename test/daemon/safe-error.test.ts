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
      "https://outer.test/x?next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x?next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x#next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x#next=file://host.invalid<path>",
    ],
    [
      "https://outer.test/x&next=file://host.invalid/Users/canary/private.db",
      "https://outer.test/x&next=file://host.invalid<path>",
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
      'file://host"name/Users/canary/private.db',
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
