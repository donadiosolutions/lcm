import { describe, expect, it } from "vitest";

import { analyzeRequiredKeywords } from "../scripts/update-gitleaks-patterns.js";
import { GITLEAKS_PATTERNS } from "../src/generated-patterns.js";

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
  {
    name: "escaped literal inside class",
    source: "[\\-]b",
    keywords: ["b"],
    flags: "",
    expectedVerified: true,
  },
  {
    name: "quantified class shorthand",
    source: "[\\w]+b",
    keywords: ["b"],
    flags: "",
    expectedVerified: true,
  },
  {
    name: "quantified group",
    source: "(?:a)+b",
    keywords: ["b"],
    flags: "",
    expectedVerified: true,
  },
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

// Lexical inventory only; this deliberately shares no parser or AST with the analyzer.
function collectRegexConstructs(source: string, flags: string): Set<string> {
  const constructs = new Set<string>();
  if (flags.includes("i")) constructs.add("case-insensitive flag");
  let depth = 0;
  let index = 0;
  let lastAtom: "character" | "class" | "group" | null = null;

  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const escaped = source[index + 1] ?? "";
      if ("dDsSwW".includes(escaped)) constructs.add("character shorthand");
      else if (escaped === "b" || escaped === "B") {
        constructs.add("boundary assertion");
        lastAtom = null;
        index += 2;
        continue;
      } else if ("nrtfv".includes(escaped)) constructs.add("control escape");
      else constructs.add("escaped literal");
      lastAtom = "character";
      index += 2;
      continue;
    }
    if (character === "[") {
      const negated = source[index + 1] === "^";
      constructs.add(negated ? "negated character class" : "positive character class");
      let classIndex = index + (negated ? 2 : 1);
      let previousWasContent = false;
      while (classIndex < source.length && source[classIndex] !== "]") {
        if (source[classIndex] === "\\") {
          const escaped = source[classIndex + 1] ?? "";
          constructs.add(
            "dDsSwW".includes(escaped) ? "class shorthand" : "class escaped literal",
          );
          previousWasContent = true;
          classIndex += 2;
          continue;
        }
        if (
          source[classIndex] === "-"
          && previousWasContent
          && source[classIndex + 1] !== "]"
        ) {
          constructs.add("class range");
        }
        previousWasContent = true;
        classIndex++;
      }
      index = Math.min(classIndex + 1, source.length);
      lastAtom = "class";
      continue;
    }
    if (character === "(") {
      if (source.startsWith("(?:", index)) {
        constructs.add("noncapturing group");
        index += 3;
      } else {
        constructs.add("capturing group");
        index++;
      }
      if (depth > 0) constructs.add("nested group");
      depth++;
      lastAtom = null;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index++;
      lastAtom = "group";
      continue;
    }
    if (character === "|") {
      constructs.add(depth === 0 ? "top-level alternation" : "grouped alternation");
      if (depth > 1) constructs.add("nested alternation");
      index++;
      lastAtom = null;
      continue;
    }
    if (character === "^" || character === "$") {
      constructs.add(character === "^" ? "start anchor" : "end anchor");
      index++;
      lastAtom = null;
      continue;
    }
    if (character === ".") {
      constructs.add("wildcard");
      index++;
      lastAtom = "character";
      continue;
    }

    let quantifier: string | null = null;
    let quantifierEnd = index + 1;
    if (character === "?") quantifier = "optional quantifier";
    else if (character === "*") quantifier = "zero-or-more quantifier";
    else if (character === "+") quantifier = "one-or-more quantifier";
    else if (character === "{") {
      const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(source.slice(index));
      if (match) {
        quantifier = !match[0].includes(",")
          ? "exact quantifier"
          : match[2] === ""
            ? "open quantifier"
            : "bounded quantifier";
        quantifierEnd = index + match[0].length;
      }
    }
    if (quantifier !== null) {
      constructs.add(quantifier);
      if (lastAtom !== null) constructs.add("quantified " + lastAtom);
      if (source[quantifierEnd] === "?") {
        constructs.add("lazy quantifier");
        quantifierEnd++;
      }
      index = quantifierEnd;
      continue;
    }

    if (character !== "]") constructs.add("literal");
    index++;
    lastAtom = "character";
  }

  return constructs;
}

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
  it("covers every regex construct used by the shipped rules", () => {
    const shipped = new Set(
      GITLEAKS_PATTERNS.flatMap(({ regex, flags }) => [
        ...collectRegexConstructs(regex, flags),
      ]),
    );
    const covered = new Set(
      ORACLE_CASES.flatMap(({ source, flags }) => [
        ...collectRegexConstructs(source, flags),
      ]),
    );
    const missing = [...shipped].filter((construct) => !covered.has(construct)).sort();

    expect([...shipped].sort()).toEqual([
      "boundary assertion",
      "bounded quantifier",
      "capturing group",
      "case-insensitive flag",
      "character shorthand",
      "class escaped literal",
      "class range",
      "class shorthand",
      "end anchor",
      "escaped literal",
      "exact quantifier",
      "grouped alternation",
      "lazy quantifier",
      "literal",
      "negated character class",
      "nested alternation",
      "nested group",
      "noncapturing group",
      "one-or-more quantifier",
      "optional quantifier",
      "positive character class",
      "quantified character",
      "quantified class",
      "quantified group",
      "start anchor",
      "top-level alternation",
      "wildcard",
      "zero-or-more quantifier",
    ]);
    expect(missing).toEqual([]);
  });

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
    expect(ORACLE_CASES).toHaveLength(42);
    expect(ORACLE_CASES.filter(({ expectedVerified }) => expectedVerified)).toHaveLength(38);
  }, 30_000);
});

// A keyword-absent corpus for the 216 shipped prefiltered rules is deliberately
// omitted. Their long, high-entropy regexes make bounded keyword-free enumeration
// overwhelmingly produce no matches, so such a test would be decorative. The
// synthetic corpus keeps every match dense enough to exercise the runtime oracle,
// and the construct inventory ties that corpus to all shipped syntax. scrub.test.ts
// separately keeps generated positives, keyword-removal probes, and the four
// fail-closed keyword-absent witnesses pinned.
