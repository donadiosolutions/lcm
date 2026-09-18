import { describe, expect, it } from "vitest";

import { analyzeRequiredKeywords } from "../scripts/update-gitleaks-patterns.js";

interface OracleCase {
  name: string;
  source: string;
  keywords: readonly string[];
  flags: "" | "i";
  expectedVerified: boolean;
  hasKeywordAbsentMatch?: boolean;
}

const ALPHABET = ["a", "b", "c", "A", "0", "-", " ", "+", ".", "é", "É", "K"] as const;
const MAX_LENGTH = 4;

const ORACLE_CASES: readonly OracleCase[] = [
  { name: "ASCII literal", source: "ab", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "escaped literals", source: "\\+\\.", keywords: ["+."], flags: "", expectedVerified: true },
  { name: "positive class", source: "[abc]b", keywords: ["ab", "bb", "cb"], flags: "", expectedVerified: true },
  { name: "negated class", source: "[^a]b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "class range", source: "[a-c]b", keywords: ["ab", "bb", "cb"], flags: "", expectedVerified: true },
  { name: "digit shorthand", source: "\\d+a", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "non-digit shorthand", source: "\\D+b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "space shorthand", source: "\\s+a", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "non-space shorthand", source: "\\S+a", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "word shorthand", source: "\\w+a", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "non-word shorthand", source: "\\W+a", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "dot includes non-ASCII", source: ".b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "capturing group", source: "(ab)c", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "non-capturing group", source: "(?:ab)c", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "concatenation", source: "a[0-9]b", keywords: ["a"], flags: "", expectedVerified: true },
  {
    name: "nested alternation requires different keywords",
    source: "(?:a(?:b|c)|ba)",
    keywords: ["ab", "ac", "ba"],
    flags: "",
    expectedVerified: true,
  },
  {
    name: "top-level alternation requires different keywords",
    source: "ab|ba",
    keywords: ["ab", "ba"],
    flags: "",
    expectedVerified: true,
  },
  {
    name: "top-level alternation has keyword-free arm",
    source: "ab|c",
    keywords: ["ab"],
    flags: "",
    expectedVerified: false,
    hasKeywordAbsentMatch: true,
  },
  {
    name: "nested alternation has keyword-free arm",
    source: "(?:ab|(?:c|ba))",
    keywords: ["ab", "ba"],
    flags: "",
    expectedVerified: false,
    hasKeywordAbsentMatch: true,
  },
  { name: "start and end assertions", source: "^ab$", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "word-boundary assertions", source: "\\bab\\b", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "non-boundary assertion", source: "a\\Bb", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "optional greedy", source: "a?b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "optional lazy", source: "a??b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "star greedy", source: "a*b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "star lazy", source: "a*?b", keywords: ["b"], flags: "", expectedVerified: true },
  { name: "plus greedy", source: "a+b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "plus lazy", source: "a+?b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "exact repeat greedy", source: "a{2}b", keywords: ["aa"], flags: "", expectedVerified: true },
  { name: "exact repeat lazy", source: "a{2}?b", keywords: ["aa"], flags: "", expectedVerified: true },
  { name: "open repeat greedy", source: "a{1,}b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "open repeat lazy", source: "a{1,}?b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "bounded repeat greedy", source: "a{1,2}b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "bounded repeat lazy", source: "a{1,2}?b", keywords: ["a"], flags: "", expectedVerified: true },
  { name: "case-sensitive folding", source: "Ab", keywords: ["ab"], flags: "", expectedVerified: true },
  { name: "case-insensitive folding", source: "AB", keywords: ["ab"], flags: "i", expectedVerified: true },
  {
    name: "case-insensitive class folding",
    source: "[A-C]b",
    keywords: ["ab", "bb", "cb"],
    flags: "i",
    expectedVerified: true,
  },
  {
    name: "non-ASCII source fails closed",
    source: "éa",
    keywords: ["a"],
    flags: "",
    expectedVerified: false,
  },
  {
    name: "non-ASCII keyword fails closed",
    source: "a",
    keywords: ["é"],
    flags: "",
    expectedVerified: false,
    hasKeywordAbsentMatch: true,
  },
];

function enumerateStrings(alphabet: readonly string[], maxLength: number): string[] {
  const values = [""];
  let level = [""];
  for (let length = 1; length <= maxLength; length++) {
    level = level.flatMap((prefix) => alphabet.map((character) => prefix + character));
    values.push(...level);
  }
  return values;
}

describe("Gitleaks keyword analyzer differential oracle", () => {
  it("proves verified corpus cases against the JavaScript RegExp engine", () => {
    const strings = enumerateStrings(ALPHABET, MAX_LENGTH);

    for (const entry of ORACLE_CASES) {
      const analysis = analyzeRequiredKeywords(entry.source, entry.keywords, entry.flags);
      const regex = new RegExp(entry.source, entry.flags);
      const foldedKeywords = entry.keywords.map((keyword) => keyword.toLowerCase());
      const keywordAbsentMatches: string[] = [];
      let keywordAbsentMatchCount = 0;
      let matchCount = 0;

      for (const candidate of strings) {
        if (!regex.test(candidate)) continue;
        matchCount++;
        const foldedCandidate = candidate.toLowerCase();
        if (!foldedKeywords.some((keyword) => foldedCandidate.includes(keyword))) {
          keywordAbsentMatchCount++;
          if (keywordAbsentMatches.length < 8) keywordAbsentMatches.push(candidate);
        }
      }

      if (analysis.verified) {
        expect(keywordAbsentMatches, entry.name).toEqual([]);
        expect(matchCount, `${entry.name} must exercise at least one runtime match`)
          .toBeGreaterThan(0);
      }
      if (entry.hasKeywordAbsentMatch) {
        expect(keywordAbsentMatchCount, `${entry.name} negative control`).toBeGreaterThan(0);
      }
      expect(analysis.verified, entry.name).toBe(entry.expectedVerified);
    }

    expect(strings).toHaveLength(22_621);
    expect(ORACLE_CASES).toHaveLength(39);
    expect(ORACLE_CASES.filter(({ expectedVerified }) => expectedVerified)).toHaveLength(35);
  }, 30_000);
});

// A keyword-absent corpus for the 216 shipped prefiltered rules is deliberately
// omitted. Their long, high-entropy regexes make bounded keyword-free enumeration
// overwhelmingly produce no matches, so such a test would be decorative. The
// synthetic corpus keeps every match dense enough to exercise the runtime oracle;
// scrub.test.ts separately keeps generated positives and the four fail-closed
// keyword-absent witnesses pinned.
