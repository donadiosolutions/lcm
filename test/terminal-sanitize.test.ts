import { describe, expect, it } from "vitest";
import { boundedTerminalText } from "../src/terminal-sanitize.js";

describe("boundedTerminalText", () => {
  const marks = "\u0301";

  it("keeps combining marks at zero terminal width", () => {
    expect(boundedTerminalText("e\u0301", 1)).toBe("e\u0301");
  });

  it.each(["界", "😀"])("counts %s as two terminal columns", (value) => {
    expect(boundedTerminalText(value, 2)).toBe(value);
    expect(boundedTerminalText(value, 1)).toBe("…");
  });

  it("truncates before a wide codepoint that crosses the width budget", () => {
    expect(boundedTerminalText("ab界", 3)).toBe("ab…");
  });

  it("adjusts removal width through a trailing combining mark", () => {
    expect(boundedTerminalText("界\u0301a", 2)).toBe("…");
  });

  it("bounds combining-only text by a separate finite code-point budget", () => {
    const result = boundedTerminalText(marks.repeat(10_000), 1);
    expect(result).toBe(`${marks.repeat(4)}…`);
    expect(Array.from(result)).toHaveLength(5);
  });

  it("bounds a huge combining prefix before a visible base", () => {
    const result = boundedTerminalText(`${marks.repeat(10_000)}a`, 2);
    expect(result).toBe(`${marks.repeat(8)}…`);
    expect(Array.from(result)).toHaveLength(9);
  });

  it("preserves a base plus combining marks while the code-point budget permits", () => {
    expect(boundedTerminalText(`a${marks.repeat(6)}`, 2)).toBe(`a${marks.repeat(6)}`);
    expect(boundedTerminalText(`a${marks.repeat(8)}`, 2)).toBe(`a${marks.repeat(7)}…`);
  });

  it("keeps a wide base and marks within budget and truncates without over-width", () => {
    expect(boundedTerminalText(`界${marks.repeat(6)}`, 2)).toBe(`界${marks.repeat(6)}`);
    expect(boundedTerminalText(`界${marks.repeat(8)}`, 2)).toBe("…");
  });

  it.each([
    [marks.repeat(100), 1, `${marks.repeat(4)}…`],
    [`a${marks.repeat(100)}`, 1, "…"],
    [`界${marks.repeat(100)}`, 2, "…"],
  ] as const)("keeps truncated combining input within width %s", (value, maxWidth, expected) => {
    expect(boundedTerminalText(value, maxWidth)).toBe(expected);
  });

  it("returns safe ASCII unchanged when it fits", () => {
    expect(boundedTerminalText("plain text", 10)).toBe("plain text");
  });

  it("sanitizes terminal controls before measuring width", () => {
    expect(boundedTerminalText("a\u001b[31m\nb", 3)).toBe("a b");
  });

  it("counts fullwidth-forms code points as two terminal columns", () => {
    expect(boundedTerminalText("\uff21", 2)).toBe("\uff21");
    expect(boundedTerminalText("\uff21", 1)).toBe("…");
  });

  it("counts fullwidth signs (U+FFE0-FFE6) as two terminal columns", () => {
    expect(boundedTerminalText("\uffe0", 2)).toBe("\uffe0");
    expect(boundedTerminalText("\uffe6", 2)).toBe("\uffe6");
    expect(boundedTerminalText("\uffe0", 1)).toBe("…");
  });

  it("does not double-count adjacent halfwidth forms as wide", () => {
    expect(boundedTerminalText("\uff61\uff71", 2)).toBe("\uff61\uff71");
    expect(boundedTerminalText("\uffe7", 1)).toBe("\uffe7");
  });

  it("counts astral-plane emoji at the top of the wide range as two columns", () => {
    const wide = String.fromCodePoint(0x1faff);
    expect(boundedTerminalText(wide, 2)).toBe(wide);
    expect(boundedTerminalText(wide, 1)).toBe("…");
  });

  it("treats astral-plane code points just past the wide range as narrow", () => {
    const narrow = String.fromCodePoint(0x1fb00);
    expect(boundedTerminalText(narrow, 1)).toBe(narrow);
    expect(boundedTerminalText(`${narrow}${narrow}`, 1)).toBe("…");
  });

  it("truncates before an astral-plane emoji that crosses the width budget", () => {
    expect(boundedTerminalText("ab😀", 3)).toBe("ab…");
    expect(boundedTerminalText("a😀", 2)).toBe("a…");
  });

  it("keeps a CJK ideograph exactly at both scanning boundaries of its range", () => {
    expect(boundedTerminalText(String.fromCodePoint(0x2e80), 2)).toBe(String.fromCodePoint(0x2e80));
    expect(boundedTerminalText(String.fromCodePoint(0x2e7f), 1)).toBe(String.fromCodePoint(0x2e7f));
    expect(boundedTerminalText(String.fromCodePoint(0xa4cf), 2)).toBe(String.fromCodePoint(0xa4cf));
    expect(boundedTerminalText(String.fromCodePoint(0xa4d0), 1)).toBe(String.fromCodePoint(0xa4d0));
  });

  it.each([
    ["CJK Extension B start", 0x20000],
    ["CJK Compatibility Supplement", 0x2f800],
    ["plane 2 top", 0x2fffd],
    ["CJK Extension G start", 0x30000],
    ["plane 3 top", 0x3fffd],
  ])("counts supplementary CJK %s as two terminal columns", (_name, code) => {
    const wide = String.fromCodePoint(code);

    expect(boundedTerminalText(wide, 2)).toBe(wide);
    expect(boundedTerminalText(wide, 1)).toBe("…");
  });

  it.each([
    ["below plane 2 wide range", 0x1fffd],
    ["between plane 2 and plane 3", 0x2fffe],
    ["above plane 3 wide range", 0x3fffe],
  ])("treats supplementary %s as narrow", (_name, code) => {
    const narrow = String.fromCodePoint(code);

    expect(boundedTerminalText(narrow, 1)).toBe(narrow);
    expect(boundedTerminalText(`${narrow}${narrow}`, 1)).toBe("…");
  });

  it("truncates a supplementary CJK ideograph that crosses the budget", () => {
    const wide = String.fromCodePoint(0x20000);

    expect(boundedTerminalText(`${wide}a`, 2)).toBe("…");
    expect(boundedTerminalText(`${wide}a`, 3)).toBe(`${wide}a`);
    expect(boundedTerminalText(`a${wide}`, 2)).toBe("a…");
  });

  it("measures supplementary CJK with combining marks and the ellipsis", () => {
    const wide = String.fromCodePoint(0x20000);

    expect(boundedTerminalText(`${wide}\u0301`, 2)).toBe(`${wide}\u0301`);
    expect(boundedTerminalText(`${wide}\u0301b`, 2)).toBe("…");
    expect(boundedTerminalText(`${wide}${wide}`, 4)).toBe(`${wide}${wide}`);
    expect(boundedTerminalText(`${wide}${wide}`, 3)).toBe(`${wide}…`);
  });

  it("sanitizes before measuring supplementary CJK width", () => {
    const wide = String.fromCodePoint(0x20000);

    expect(boundedTerminalText(`\u001b[31m${wide}\u001b[0m`, 2)).toBe(wide);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxWidth %s",
    (maxWidth) => {
      expect(() => boundedTerminalText("value", maxWidth)).toThrow(
        "terminal text width must be a positive safe integer",
      );
    },
  );
});
