import { describe, expect, it } from "vitest";
import {
  addCodexHooksFeature,
  classifyCodexHooksFeature,
  scanCodexConfigToml,
} from "../../src/connectors/codex-config-toml.js";

const KEY = "/h/hooks.json:session_start:0:0";

describe("classifyCodexHooksFeature", () => {
  it.each([
    ["", "absent"],
    ["model = 'x'\n", "absent"],
    ["[features]\nother = true\n", "absent"],
    ["[features]\nhooks = true\n", "explicit-true"],
    ["[features]\nhooks = false\n", "explicit-false"],
    ["[features]\ncodex_hooks = true\n", "explicit-true"],
    ["[features]\ncodex_hooks = false\n", "explicit-false"],
    ["features.hooks = true\n", "explicit-true"],
    ["features.codex_hooks = false\n", "explicit-false"],
    ['["features"]\n"hooks" = false\n', "explicit-false"],
    ["['features']\n'hooks' = true\n", "explicit-true"],
    ['[ features ]\n"h\\u006fo\\U0000006Bs" = false\n', "explicit-false"],
    ["[features]\nhooks = false\ncodex_hooks = true\n", "explicit-false"],
    ["[features]\ncodex_hooks = false\nhooks = true\n", "explicit-true"],
    ["[features]\nhooks = true # comment\r\ncodex_hooks = false\r\n", "explicit-true"],
    ["\uFEFF[features]\nhooks = false\n", "explicit-false"],
    ['note = """\n[features]\nhooks = false\n"""\n', "absent"],
    ["note = '''\n[features]\nhooks = false\n'''\n", "absent"],
    ['note = """a\\"""b""""\n[features]\nhooks = false\n', "explicit-false"],
    ["[features]\nhooks = true\nhooks = false\n", "unrecognized"],
    ["[features]\ncodex_hooks = true\ncodex_hooks = false\n", "unrecognized"],
    ["features.hooks = true\n[features]\nhooks = true\n", "unrecognized"],
    ["[features]\n[features]\n", "unrecognized"],
    ["features = { hooks = false }\n", "unrecognized"],
    ["[features]\nhooks = { enabled = false }\n", "unrecognized"],
    ["[features.hooks]\nenabled = false\n", "unrecognized"],
    ["[features.codex_hooks]\nenabled = false\n", "unrecognized"],
    ["[[features]]\nhooks = true\n", "unrecognized"],
    ["[features]\nhooks = 1\n", "unrecognized"],
    ['[features]\nhooks = "true"\n', "unrecognized"],
    ["features.hooks.extra = true\n", "unrecognized"],
    ["[features]\nhooks = tru\n", "unrecognized"],
    ["[features]\nhooks = true x\n", "unrecognized"],
    ["[features\nhooks = true\n", "unrecognized"],
    ["[[features]\n", "unrecognized"],
    ["[features] junk\n", "unrecognized"],
    ["hooks true\n", "unrecognized"],
    ["= true\n", "unrecognized"],
    ['"unterminated = 1\n', "unrecognized"],
    ["'unterminated = 1\n", "unrecognized"],
    ['"""a" = 1\n', "unrecognized"],
    ["'''a' = 1\n", "unrecognized"],
    ['x = "bad \\q escape"\n', "unrecognized"],
    ['x = "bad \\uZZZZ"\n', "unrecognized"],
    ['x = "bad \\uD800"\n', "unrecognized"],
    ['x = "bad \\U00110000"\n', "unrecognized"],
    ['x = "bad \\u12"\n', "unrecognized"],
    ['x = "abc', "unrecognized"],
    ['x = "abc\\', "unrecognized"],
    ["d = 1979-05-27 ", "absent"],
    ['x = "tab\\there \\\\ \\" \\b\\f\\n\\r \\u00e9"\n', "absent"],
    ['x = "line\nbreak"\n', "unrecognized"],
    ["x = 'line\nbreak'\n", "unrecognized"],
    ['x = """never closed\n', "unrecognized"],
    ["x = [1, 2\n", "unrecognized"],
    ["x = { a = 1\n", "unrecognized"],
    ["x = { a 1 }\n", "unrecognized"],
    ["x = [1 2]\n", "unrecognized"],
    ["x =\n", "unrecognized"],
    ["x = \r\n", "unrecognized"],
    ["x = 1\ry = 2\n", "unrecognized"],
  ] as const)("classifies %j as %s", (content, expected) => {
    expect(classifyCodexHooksFeature(content)).toBe(expected);
  });

  it("accepts the TOML value forms it must skip", () => {
    const config = [
      "int = 1_000",
      "float = -3.14e+2",
      "date = 1979-05-27",
      "datetime = 1979-05-27 07:32:00Z",
      "datetime2 = 1979-05-27T07:32:00-07:00",
      "array = [",
      "  1, # comment",
      "  [2, 3],",
      "  { a = 1, 'b' = [ ] },",
      '  "x",',
      "]",
      "empty = []",
      "table = { a = { b = 1 }, c.d = 'e' }",
      "emptytable = {}",
      "inf = inf",
      'multi = """',
      "text with \\\\ backslash and \"quotes\"",
      '"""',
      "dotted . key = 1",
      "",
      "[ a . 'b' ]",
      "x = 1   # trailing",
      "[features]",
      "hooks = true",
      "",
    ].join("\r\n");
    expect(classifyCodexHooksFeature(config)).toBe("explicit-true");
    expect(classifyCodexHooksFeature("d = 1979-05-27 x\n")).toBe("unrecognized");
  });

  it("treats pathological nesting as unrecognized instead of throwing", () => {
    expect(classifyCodexHooksFeature("x = " + "[".repeat(80) + "]".repeat(80) + "\n")).toBe("unrecognized");
    expect(classifyCodexHooksFeature("x = " + "[".repeat(20000) + "\n")).toBe("unrecognized");
  });
});

describe("scanCodexConfigToml hook state", () => {
  const states = (content: string) => scanCodexConfigToml(content).states;

  it("reads state from table headers, dotted keys and quoted keys", () => {
    const content = [
      "[hooks]",
      "state.'/h/hooks.json:stop:0:0'.trusted_hash = 'sha256:bb'",
      "state.'/h/hooks.json:stop:0:0'.enabled = true",
      "",
      '[hooks.state."' + KEY + '"]',
      "enabled = false",
      'trusted_hash = "sha256:aa"',
      "",
      "[other]",
      'hooks.state."ignored".enabled = false',
    ].join("\n");
    const scan = scanCodexConfigToml(content);
    expect(scan.statesUnknown).toBe(false);
    expect(scan.states.get(KEY)).toEqual({ enabled: false, trustedHash: "sha256:aa" });
    expect(scan.states.get("/h/hooks.json:stop:0:0")).toEqual({ enabled: true, trustedHash: "sha256:bb" });
    expect(scan.states.has("ignored")).toBe(false);
    expect(states('hooks.state."' + KEY + '".enabled = false\n').get(KEY)).toEqual({ enabled: false });
    expect(states('hooks.state."  ' + KEY + ' ".trusted_hash = "x"\n').get(KEY)).toEqual({ trustedHash: "x" });
  });

  it("ignores unrelated hook definitions and unrelated state fields", () => {
    const content = '[[hooks.PreToolUse]]\nmatcher = "x"\n[hooks.state."k"]\nnote = 1\n[hooks]\nPostToolUse = [{ hooks = [] }]\n';
    const scan = scanCodexConfigToml(content);
    expect(scan.statesUnknown).toBe(false);
    expect(scan.states.get("k")).toBeUndefined();
  });

  it("marks fields unknown for wrong types and unsupported forms", () => {
    expect(states('[hooks.state."k"]\nenabled = "no"\n').get("k")).toEqual({ enabled: "unknown", trustedHash: "unknown" });
    expect(states('[hooks.state."k"]\ntrusted_hash = 5\n').get("k")).toEqual({ enabled: "unknown", trustedHash: "unknown" });
    expect(states('hooks.state."k" = { enabled = false }\n').get("k")).toEqual({ enabled: "unknown", trustedHash: "unknown" });
    expect(states('hooks.state."k".enabled.extra = false\n').get("k")).toEqual({ enabled: "unknown", trustedHash: "unknown" });
    expect(states('hooks.state."k".trusted_hash = """multi"""\n').get("k")).toEqual({ enabled: "unknown", trustedHash: "unknown" });
  });

  it("marks every state unknown when a containing table is defined opaquely", () => {
    for (const content of [
      "hooks = { state = {} }\n",
      "hooks = 5\n",
      "hooks.state = {}\n",
      "[hooks]\nstate = { k = { enabled = false } }\n",
      "[[hooks]]\n",
      "[[hooks.state]]\n",
      "not valid toml\n",
    ]) {
      expect(scanCodexConfigToml(content).statesUnknown, content).toBe(true);
    }
  });

  it("reports an invalid document as entirely unknown", () => {
    const scan = scanCodexConfigToml("= broken");
    expect(scan).toMatchObject({ valid: false, featureUnknown: true, statesUnknown: true });
  });

  it("fails closed on documents a TOML parser rejects, so they can never look trusted", () => {
    const trusted = '[hooks.state."' + KEY + '"]\ntrusted_hash = "sha256:aa"\n';
    for (const invalid of [
      '[hooks.state."' + KEY + '"]\nenabled = true\n' + trusted,
      "x = 01\n" + trusted,
      "x = @@@\n" + trusted,
      "x = 1\nx = 2\n" + trusted,
      '[hooks.state."k"]\nenabled = true\nenabled = false\n',
      '[hooks.state."k"]\ntrusted_hash = "a"\ntrusted_hash = "b"\n',
      "[a]\n[a]\n",
      "a = 1\n[a]\n",
      "a = 1\n[a.b]\n",
      "a = { b = 1 }\n[a.c]\n",
      "a = { b = 1 }\n[[a.c]]\n",
      "[a]\nb = 1\n[a.b]\n",
      "[a.b]\n[a.b]\n",
      "a.b = 1\n[a]\n",
      "[a]\nb.c = 1\n[a.b]\n",
      "a = []\n[[a]]\n",
      "a = { b = 1 }\n[a]\n",
      "a = { b = 1 }\na.c = 2\n",
      "[a]\nb = {}\nb.c = 1\n",
      "a = { b = 1, b = 2 }\n",
      "a = { b.c = 1, b = 2 }\n",
      "a = [ { b = 1, b = 2 } ]\n",
      "[[a]]\nb = 1\nb = 2\n",
      "[a]\nb = 1\n[[a]]\n",
      "[[a]]\n[a.b]\n[a.b]\n",
      "[[a.b]]\n[a]\n[a.b]\n",
      "x = 1__0\n",
      "x = 1_\n",
      "x = 0x\n",
      "x = 1.\n",
      "x = .5\n",
      "x = 1e\n",
      "x = 1979-5-27\n",
      "x = 07:32\n",
      "x = +\n",
      "x = 0b2\n",
      "x = 0o8\n",
      "x = infinity\n",
    ]) {
      expect(scanCodexConfigToml(invalid), invalid).toMatchObject({ valid: false, featureUnknown: true, statesUnknown: true });
    }
  });

  // Value-domain counterexamples from review: the shape is right but TOML (toml/toml_datetime) rejects the value.
  const C0 = (code: number) => String.fromCharCode(code);
  const invalidValues: string[] = [
    "x = 2026-13-01\n", "x = 2026-00-10\n", "x = 2026-02-30\n", "x = 2024-02-31\n", "x = 2023-02-29\n", "x = 1900-02-29\n",
    "x = 2026-04-31\n", "x = 2026-01-00\n", "x = 2026-01-32\n",
    "x = 25:61:61\n", "x = 25:00:00\n", "x = 24:00:00\n", "x = 23:60:00\n", "x = 23:59:61\n",
    "x = 2026-01-01T24:00:00Z\n", "x = 2026-01-01T12:60:00\n", "x = 2026-01-01T12:00:61\n",
    "x = 2026-01-01T12:00:00+24:00\n", "x = 2026-01-01T12:00:00-00:60\n", "x = 2026-01-01 12:00:00+23:60\n",
    "x = 2026-01-01T12:00:00+24:00\r\n",
    // Floats that overflow f64 are rejected by toml 0.9 (Codex 0.163.0) even though their shape is valid.
    "x = 1e309\n", "x = -1e309\n", "x = +1e309\n", "x = 1_0e309\n", "x = 1.0e999\n", "x = 1e400\n", "x = 1e1000\n",
    "x = 17976931348623159e292\n", "x = 1.7976931348623159e308\n", "x = 1" + "0".repeat(309) + ".0\n",
    "x = [ 1.5, 1e309 ]\n", "x = { y = -1e309 }\n", "x = [ { y = [ 1e999 ] } ]\n",
    "x = 9223372036854775808\n", "x = -9223372036854775809\n", "x = 99999999999999999999999999\n", "x = 9_223_372_036_854_775_808\n",
    "x = 0x8000000000000000\n", "x = 0xFFFFFFFFFFFFFFFF\n", "x = 0o1000000000000000000000\n", "x = 0b" + "1".repeat(64) + "\n",
    "x = " + "9".repeat(40) + "\n",
    "x = \"a" + C0(1) + "b\"\n", "x = \"a" + C0(0x7f) + "b\"\n", "x = 'a" + C0(1) + "b'\n", "x = 'a" + C0(0x7f) + "b'\n",
    "x = \"\"\"a" + C0(1) + "b\"\"\"\n", "x = \"\"\"a" + C0(0x7f) + "b\"\"\"\n",
    "x = '''a" + C0(1) + "b'''\n", "x = '''a" + C0(0x7f) + "b'''\n", "x = '''a" + C0(0) + "b'''\n",
    "x = \"a" + C0(0x0b) + "\"\n", "x = '''a\rb'''\n", "x = \"\"\"a\rb\"\"\"\n",
    "\"k" + C0(1) + "\" = 1\n", "'k" + C0(0x7f) + "' = 1\n",
    'x = """a \\q b"""\n', 'x = """a \\uD800 b"""\n', 'x = """a \\U00110000 b"""\n', 'x = """a \\u12 b"""\n',
    'x = """a \\x4 b"""\n', 'x = """a \\ b"""\n', 'x = """a \\\n', 'x = """a \\',
    'x = "a \\x4"\n', 'x = "a \\xZZ"\n',
    "# comment " + C0(1) + "\n", "# comment " + C0(0x7f) + "\n", "# comment \r bare\n", "x = 1 # c" + C0(1) + "\n",
    "[a] # c\r bare\n", "# bare cr at end \r",
    "x = [1, # c" + C0(1) + "\n 2]\n", "x = { a = 1 } # c\r\r\n",
  ];
  const validValues: string[] = [
    "x = 2024-02-29\n", "x = 2000-02-29\n", "x = 2026-12-31\n", "x = 0000-01-01\n", "x = 2026-04-30\n",
    "x = 23:59:59\n", "x = 00:00:00\n", "x = 23:59:60\n", "x = 12:00:00.123456789012\n",
    "x = 2026-01-01T23:59:60Z\n", "x = 2026-01-01t12:00:00z\n", "x = 2026-01-01 12:00:00+23:59\n", "x = 2026-01-01T12:00:00-23:59\n",
    "x = 2026-01-01T00:00:00.5\n", "x = 2026-01-01T00:00:00\n", "x = 2026-01-01\n",
    "x = 9223372036854775807\n", "x = -9223372036854775808\n", "x = +9223372036854775807\n", "x = 9_223_372_036_854_775_807\n",
    "x = 0x7FFFFFFFFFFFFFFF\n", "x = 0x7fff_ffff_ffff_ffff\n", "x = 0o777777777777777777777\n", "x = 0b" + "1".repeat(63) + "\n",
    "x = 0x0\n", "x = 0\n", "x = -0\n", "x = +0\n",
    "x = 1.7976931348623157e308\n", "x = -1.7976931348623157e308\n", "x = 1.7976931348623158e308\n", "x = 1e-400\n", "x = 5e-324\n",
    "x = inf\n", "x = +inf\n", "x = -inf\n", "x = nan\n", "x = +nan\n", "x = -nan\n", "x = 1_000.5e1_0\n",
    "x = 9999999999999999999999.0\n", "x = -inf\n",
    "x = \"tab\there \\t \\e \\x41 \\u00e9 \\U0001F600 \\\\ \\\" é 😀 " + C0(0x80) + "\"\n", "x = 'tab\there é ' # comment\ttab é 😀 " + C0(0x80) + "\n",
    'x = """line one\nline "two"\r\n\ttabbed \\n \\e \\x41 \\u00e9 "" end"""\n', "x = '''raw \\q \\ no escapes\r\nline\ttab'''\n",
    'x = """a \\\n   continued \\   \n\n   more \\\r\n  crlf"""\n', 'x = """\\\n"""\n', 'x = """quote at end""""\n',
    "# comment with tab\there and unicode é 😀\n", "x = 1 # trailing\ttab\r\ny = 2\r\n",
    // TOML 1.1 inline tables (newlines, comments and trailing comma) are valid for the Codex parser.
    "x = { b = 1, }\n", "x = { b = 1,\n c = 2 }\n", "x = {\n  b = 1, # why\n  c = 2,\n}\n", "x = { b = 1,\r\n c = 2 }\r\n",
  ];

  it("rejects scalar values outside the ranges TOML defines, raw control characters, and invalid escapes or comments", () => {
    const trusted = '[hooks.state."' + KEY + '"]\ntrusted_hash = "sha256:aa"\n';
    for (const invalid of invalidValues) {
      expect(scanCodexConfigToml(invalid + trusted), JSON.stringify(invalid)).toMatchObject({ valid: false, featureUnknown: true, statesUnknown: true });
      expect(classifyCodexHooksFeature(invalid + "[features]\nhooks = true\n"), JSON.stringify(invalid)).toBe("unrecognized");
      expect(addCodexHooksFeature(invalid), JSON.stringify(invalid)).toEqual({ content: invalid, added: false });
    }
  });

  it("keeps boundary values and TOML 1.1 forms valid", () => {
    for (const valid of validValues) {
      expect(scanCodexConfigToml(valid + "[features]\nhooks = true\n"), JSON.stringify(valid)).toMatchObject({ valid: true });
      expect(classifyCodexHooksFeature(valid + "[features]\nhooks = true\n"), JSON.stringify(valid)).toBe("explicit-true");
    }
  });

  it("accepts valid redeclaration-free documents including implicit parents and arrays of tables", () => {
    for (const valid of [
      "[a.b.c]\nx = 1\n[a]\ny = 2\n[a.b]\nz = 3\n",
      "[[a]]\nb = 1\n[[a]]\nb = 2\n[a.c]\nd = 1\n",
      "[[a]]\n[a.b]\n[[a]]\n[a.b]\n",
      "[[a.b]]\nx = 1\n[[a.b]]\nx = 2\n",
      "[a]\nb.c = 1\nb.d = 2\n[a.e]\nf = 1\n[a.b.g]\nh = 1\n",
      "a = { b = { c = 1 }, d.e = 2, f.g = 3 }\nx = [ { y = 1 }, { y = 2 } ]\n",
      "[a]\n[b]\n",
      "a.b = 1\na.c = 2\n",
      "n = [ -1, +2, 0, 0x1F, 0o17, 0b101, 1_000, 3.14, 6.02e+23, 1e-3, +inf, -inf, nan, 1979-05-27, 07:32:00, 07:32:00.5, 1979-05-27T07:32:00Z, 1979-05-27 07:32:00-07:00 ]\n",
    ]) {
      expect(scanCodexConfigToml(valid), valid).toMatchObject({ valid: true });
    }
  });
});

describe("addCodexHooksFeature", () => {
  const add = (content: string) => addCodexHooksFeature(content);

  it("treats only TOML blank space as empty and leaves other whitespace documents untouched", () => {
    for (const invalid of ["\v", "\f", "\u00a0", " \u00a0 ", "\n\v\n", "\u2003", "\u3000\n"]) {
      expect(add(invalid), JSON.stringify(invalid)).toEqual({ content: invalid, added: false });
    }
    expect(add("\t \r\n\t\n")).toEqual({ content: "[features]\nhooks = true\n", added: true });
  });

  it("creates, inserts and appends only when the feature is absent", () => {
    expect(add("")).toEqual({ content: "[features]\nhooks = true\n", added: true });
    expect(add("\r\n \n")).toEqual({ content: "[features]\nhooks = true\n", added: true });
    expect(add("model = 'x'\n").content).toBe("model = 'x'\n\n[features]\nhooks = true\n");
    expect(add("model = 'x'").content).toBe("model = 'x'\n\n[features]\nhooks = true\n");
    expect(add("model = 'x'\r\n").content).toBe("model = 'x'\r\n\r\n[features]\r\nhooks = true\r\n");
    expect(add("[features]\nvalue = 1\n[other]\nx = 1\n").content).toBe("[features]\nvalue = 1\nhooks = true\n[other]\nx = 1\n");
    expect(add("[features] # settings\n").content).toBe("[features] # settings\nhooks = true\n");
    expect(add("[features]").content).toBe("[features]\nhooks = true\n");
    expect(add("[features]\r\nvalue = [\r\n  1,\r\n]\r\n[other]\r\n").content)
      .toBe("[features]\r\nvalue = [\r\n  1,\r\n]\r\nhooks = true\r\n[other]\r\n");
    expect(add('["features"]\nvalue = 1\n').content).toBe('["features"]\nvalue = 1\nhooks = true\n');
    expect(add("[features.sub]\nx = 1\n").content).toBe("[features.sub]\nx = 1\n\n[features]\nhooks = true\n");
  });

  it("keeps every existing, disabled or unrecognised definition byte-identical", () => {
    for (const content of [
      "[features]\nhooks = false\n[other]\nx = 1\n",
      "[features] # settings\ncodex_hooks = true\nhooks = false\n",
      "[features]\nhooks = false\ncodex_hooks = true\n",
      "[features]\ncodex_hooks = true\n",
      "features.hooks = true\n",
      '["features"]\n"hooks" = true\n',
      "[features]\nhooks = true\nhooks = true\n",
      "features = { x = 1 }\n",
      "features.other = true\nmodel = 'x'\n",
      "not valid = = toml\n",
    ]) {
      expect(add(content), content).toEqual({ content, added: false });
    }
  });

  it("never produces a duplicate table or key", () => {
    for (const content of ["", "x = 1\n", "[features]\n", "[features]\nfoo = 1\n[b]\n", "[features.sub]\n", "[a]\nb = 1\n"]) {
      const out = add(content).content;
      const scan = scanCodexConfigToml(out);
      expect(scan.valid).toBe(true);
      expect(scan.featuresHeaderCount).toBe(1);
      expect(classifyCodexHooksFeature(out)).toBe("explicit-true");
      expect(add(out)).toEqual({ content: out, added: false });
    }
  });
});
