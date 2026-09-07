import { describe, expect, it } from "vitest";
import { parseTsqueryEvidence } from "../../src/storage/postgresql/tsquery-evidence.js";

describe("PostgreSQL canonical tsquery evidence", () => {
  it.each(["", " \t\r\n", "!'absent'", "!( 'absent' | 'other' )"])(
    "returns zero evidence for empty or all-negative input %#",
    (canonical) => {
      expect(parseTsqueryEvidence(canonical)).toEqual({ atoms: [], groupIds: [], queryTermCount: 0 });
    },
  );

  it("retains distinct positive native terms across all binary operators", () => {
    expect(parseTsqueryEvidence("'state-of-the-art' <-> 'state' <2> 'of' & 'the' | 'art' <0> 'state'"))
      .toEqual({
        atoms: ["'state-of-the-art'", "'state'", "'of'", "'the'", "'art'"],
        groupIds: [0, 1, 2, 3, 4],
        queryTermCount: 5,
      });
  });

  it("tracks nested and double NOT scope without changing sibling polarity", () => {
    expect(parseTsqueryEvidence("!( 'negative' | !('positive' & !!'also-positive') ) & !!'tail' | !'positive'"))
      .toEqual({
        atoms: ["'positive'", "'also-positive'", "'tail'"],
        groupIds: [0, 1, 2],
        queryTermCount: 3,
      });
    expect(parseTsqueryEvidence("! 'negative' <-> 'positive' & ! ! 'other' | 'end'"))
      .toEqual({ atoms: ["'positive'", "'other'", "'end'"], groupIds: [0, 1, 2], queryTermCount: 3 });
  });

  it("groups every positive qualifier alternative by decoded lexeme", () => {
    expect(parseTsqueryEvidence("'run':A | 'run':* | 'run':*ABCD | 'run':B | 'run' | 'run':A | !'run':C | 'swim':D"))
      .toEqual({
        atoms: ["'run':A", "'run':*", "'run':*ABCD", "'run':B", "'run'", "'swim':D"],
        groupIds: [0, 0, 0, 0, 0, 1],
        queryTermCount: 2,
      });
  });

  it("preserves escaped atom bytes and treats punctuation inside quotes as data", () => {
    const quote = "'can''t'";
    const slash = String.raw`'c:\\work\\file'`;
    const punctuation = "'!()&|<->: * https://example.test/a 123 café'";
    expect(parseTsqueryEvidence(`${quote} | ${slash}:*AB | ${quote}:B | ${punctuation} | ${slash}`))
      .toEqual({
        atoms: [quote, `${slash}:*AB`, `${quote}:B`, punctuation, slash],
        groupIds: [0, 1, 0, 2, 1],
        queryTermCount: 3,
      });
  });

  it("does not apply JavaScript case, Unicode, stemming, or punctuation normalization", () => {
    expect(parseTsqueryEvidence("'Run' | 'run' | 'running' | 'é' | 'é' | 'foo-bar' | 'foo'"))
      .toEqual({
        atoms: ["'Run'", "'run'", "'running'", "'é'", "'é'", "'foo-bar'", "'foo'"],
        groupIds: [0, 1, 2, 3, 4, 5, 6],
        queryTermCount: 7,
      });
  });

  it("admits deep parentheses and NOT chains without recursive stack growth", () => {
    const depth = 20_000;
    expect(parseTsqueryEvidence(`${"!(".repeat(depth)}'deep'${")".repeat(depth)}`))
      .toEqual({ atoms: ["'deep'"], groupIds: [0], queryTermCount: 1 });
    expect(parseTsqueryEvidence(`${"!".repeat(depth + 1)}'negative' | 'positive'`))
      .toEqual({ atoms: ["'positive'"], groupIds: [0], queryTermCount: 1 });
  });

  it.each([255, 256, 257, 512, 513, 20_000])("retains all %i distinct terms without a recall cutoff", (count) => {
    const atoms = Array.from({ length: count }, (_, i) => `'term${i}'`);
    const actual = parseTsqueryEvidence(`${atoms.join(" | ")} | 'term0':A | 'term0'`);
    expect(actual.queryTermCount).toBe(count);
    expect(actual.atoms).toEqual([...atoms, "'term0':A"]);
    expect(actual.groupIds).toEqual([...Array.from({ length: count }, (_, i) => i), 0]);
  });

  it.each([
    "raw unquoted", "'secret", "''", "'secret' trailing", "'secret' 'other'", "'secret'(",
    "'secret'!", "'secret'&", "'secret'||'other'", "&'secret'", "()", "('secret'", "'secret')",
    "('secret' | )", "!", "!()", "'secret':", "'secret':E", "'secret':a", "'secret':A*",
    "'secret':**", "'secret'::A", "'secret':*Z", "'secret':AA", "'secret':BA",
    "'secret' <1 'other'", "'secret' <> 'other'",
    "'secret' <-1> 'other'", "'secret' <+2> 'other'", "'secret' <1.5> 'other'", "'secret' <01> 'other'",
    "'secret' <->", "'secret' <2> & 'other'", String.raw`'secret\value'`, "'secret\\",
    "'secret\u0000value'", "!'secret' trailing",
  ])("rejects malformed or incomplete canonical output without exposing it %#", (canonical) => {
    let failure: unknown;
    try {
      parseTsqueryEvidence(canonical);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("secret");
    expect((failure as Error).cause).toBeUndefined();
  });
});
