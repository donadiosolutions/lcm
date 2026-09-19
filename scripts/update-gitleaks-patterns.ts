#!/usr/bin/env -S node --experimental-strip-types
/**
 * update-gitleaks-patterns.ts
 *
 * Fetches the canonical gitleaks.toml from GitHub, converts Go regexes to JS,
 * validates each pattern (compiles + smoke tests), and writes src/generated-patterns.ts.
 *
 * Usage:
 *   pnpm run update:patterns (from a source checkout)
 *
 * The script aborts (exit 1) if:
 *   - Fetch fails
 *   - New valid pattern count drops >10% from previous (regression guard)
 *   - Known token-sample positive tests fail
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUT_FILE = join(REPO_ROOT, "src", "generated-patterns.ts");
const GITLEAKS_REVISION = "4c232b5014f7618360bd992b4c489cb055881c6b";
const GITLEAKS_TOML_SHA256 = "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf";
const TOML_URL = `https://raw.githubusercontent.com/gitleaks/gitleaks/${GITLEAKS_REVISION}/config/gitleaks.toml`;

/** Bounded, conservative analysis of the generated JavaScript regex grammar. */
const MAX_SOURCE = 16_384;
const MAX_DEPTH = 64;
const MAX_STATES = 4096;
const MAX_WORK = 2_000_000;
const MAX_WITNESS = 8192;
const OTHER = "\u0080";
const ASCII = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index));
const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

type Node =
  | { kind: "empty" }
  | { kind: "chars"; values: string[]; witness: string }
  | { kind: "sequence" | "choice"; children: Node[] }
  | { kind: "repeat"; child: Node; min: number; max: number };

class Unsupported extends Error {}

/** The parser deliberately rejects valid JavaScript outside this small grammar. */
function parse(source: string, flags: string): Node {
  if (flags !== "" && flags !== "i") throw new Unsupported("unsupported flags");
  if (source.length > MAX_SOURCE) throw new Unsupported("source limit exceeded");
  if (/[^\x00-\x7f]/.test(source)) throw new Unsupported("non-ASCII source");
  new RegExp(source, flags);
  let index = 0;

  function characters(raw: string, unknownNonAscii = false): Node {
    const regex = new RegExp(`^(?:${raw})$`, flags);
    const actual = ASCII.filter((character) => regex.test(character));
    const preferredOrder = raw.includes("\\s")
      ? [" ", "a", "A", "0", "_", "-", "\n"]
      : ["a", "A", "0", " ", "_", "-", "\n"];
    const preferred = preferredOrder.find((value) => actual.includes(value));
    return {
      kind: "chars",
      values: [...new Set([...actual.map(fold), ...(unknownNonAscii ? [OTHER] : [])])],
      witness: preferred ?? actual[0] ?? OTHER,
    };
  }

  function escape(inClass: boolean): void {
    index++;
    const escaped = source[index++];
    if (escaped === undefined) throw new Unsupported("unfinished escape");
    if ("dDsSwWnrtfv".includes(escaped)) return;
    if (escaped === "b" || escaped === "B") {
      if (!inClass || escaped === "b") return;
      throw new Unsupported("unsupported class escape");
    }
    if ("\\^$.*+?()[]{}|/-#\"'`=".includes(escaped)) return;
    // Do not interpret legacy octal, identity, property or backreference escapes.
    throw new Unsupported(`unsupported escape: \\${escaped}`);
  }

  function expression(depth: number): Node {
    if (depth > MAX_DEPTH) throw new Unsupported("group depth limit exceeded");
    const choices: Node[] = [];
    let sequence: Node[] = [];
    while (index < source.length && source[index] !== ")") {
      if (source[index] === "|") {
        index++;
        choices.push({ kind: "sequence", children: sequence });
        sequence = [];
        continue;
      }
      let node: Node;
      const start = index;
      const character = source[index++];
      if (character === "(") {
        if (source[index] === "?") {
          if (source.slice(index, index + 2) !== "?:") {
            throw new Unsupported(`unsupported group construct at offset ${start}`);
          }
          index += 2;
        }
        node = expression(depth + 1);
        if (source[index++] !== ")") throw new Unsupported("unclosed group");
      } else if (character === "[") {
        let unknownNonAscii = source[index] === "^";
        while (index < source.length && source[index] !== "]") {
          if (source[index] === "\\") {
            // \s includes Unicode whitespace; complements can also match non-ASCII.
            if ("DsSW".includes(source[index + 1] ?? "")) unknownNonAscii = true;
            escape(true);
          } else index++;
        }
        if (source[index++] !== "]") throw new Unsupported("unclosed class");
        node = characters(source.slice(start, index), unknownNonAscii);
      } else if (character === "\\") {
        index = start;
        escape(false);
        const raw = source.slice(start, index);
        node = raw === "\\b" || raw === "\\B"
          ? { kind: "empty" }
          : characters(raw, /^\\[DsSW]$/.test(raw));
      } else if (character === "^" || character === "$") {
        node = { kind: "empty" };
      } else if (character === ".") {
        node = characters(".", true);
      } else {
        if ("*+?{]".includes(character)) throw new Unsupported("unsupported literal syntax");
        node = characters(character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
      }

      const quantifier = source[index];
      let min: number | undefined;
      let max = Infinity;
      if (quantifier === "*" || quantifier === "+" || quantifier === "?") {
        index++;
        min = quantifier === "+" ? 1 : 0;
        if (quantifier === "?") max = 1;
      } else if (quantifier === "{") {
        const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(source.slice(index));
        if (!match) throw new Unsupported("unsupported quantifier");
        index += match[0].length;
        min = Number(match[1]);
        max = match[0].includes(",") ? (match[2] ? Number(match[2]) : Infinity) : min;
        if (!Number.isSafeInteger(min) || (max !== Infinity && !Number.isSafeInteger(max))) {
          throw new Unsupported("quantifier limit exceeded");
        }
      }
      if (min !== undefined) {
        if (node.kind === "empty") throw new Unsupported("quantified assertion");
        node = { kind: "repeat", child: node, min, max };
        if (source[index] === "?") index++;
      }
      sequence.push(node);
    }
    choices.push({ kind: "sequence", children: sequence });
    return choices.length === 1 ? choices[0] : { kind: "choice", children: choices };
  }

  const root = expression(0);
  if (index !== source.length) throw new Unsupported("unconsumed syntax");
  return root;
}

export interface KeywordAnalysis {
  verified: boolean;
  reason: string | null;
}

export type RequiredKeywordAnalysis = KeywordAnalysis;

/**
 * Prove that every regex match contains at least one supplied keyword after
 * ASCII case folding. Missing proof means the caller must run the regex.
 *
 * States are proper keyword prefixes. Paths that encounter a keyword disappear
 * into an accepting sink. An empty final state set proves the OR condition.
 * Assertions are erased and character classes conservatively overapproximated,
 * so the analyzed language contains the regex language, never less of it.
 */
export function analyzeRequiredKeywords(
  source: string,
  keywords: readonly string[],
  flags: string,
): KeywordAnalysis {
  try {
    const root = parse(source, flags);
    if (keywords.length === 0 || keywords.length > 256) throw new Unsupported("keyword count limit");
    if (keywords.some((keyword) => keyword.length === 0 || /[^\x00-\x7f]/.test(keyword))) {
      throw new Unsupported("keywords must be nonempty ASCII strings");
    }
    const words = [...new Set(keywords.map(fold))];
    const prefixes = new Set([""]);
    for (const word of words) {
      if (word.length > MAX_STATES) throw new Unsupported("keyword length limit");
      for (let end = 1; end < word.length; end++) {
        prefixes.add(word.slice(0, end));
        if (prefixes.size > MAX_STATES) throw new Unsupported("automaton state limit");
      }
    }
    let work = 0;
    const tick = (): void => {
      if (++work > MAX_WORK) throw new Unsupported("analysis work limit exceeded");
    };
    const transitions = new Map<string, string | null>();
    function transition(state: string, character: string): string | null {
      tick();
      const key = `${state}\u0000${character}`;
      if (transitions.has(key)) return transitions.get(key)!;
      let next = state + character;
      if (words.some((word) => next.endsWith(word))) {
        transitions.set(key, null);
        return null;
      }
      while (!prefixes.has(next)) next = next.slice(1);
      transitions.set(key, next);
      return next;
    }
    const equal = (left: Set<string>, right: Set<string>): boolean =>
      left.size === right.size && [...left].every((value) => right.has(value));

    function evaluate(node: Node, states: Set<string>): Set<string> {
      tick();
      if (states.size === 0 || node.kind === "empty") return states;
      if (node.kind === "chars") {
        const result = new Set<string>();
        for (const state of states) for (const character of node.values) {
          const next = transition(state, character);
          if (next !== null) result.add(next);
        }
        return result;
      }
      if (node.kind === "sequence") {
        return node.children.reduce((current, child) => evaluate(child, current), states);
      }
      if (node.kind === "choice") {
        return new Set(node.children.flatMap((child) => [...evaluate(child, states)]));
      }
      let current = states;
      for (let count = 0; count < node.min; count++) {
        const next = evaluate(node.child, current);
        if (equal(next, current)) break;
        current = next;
      }
      const result = new Set(current);
      for (let count = node.min; count < node.max; count++) {
        const next = evaluate(node.child, result);
        let added = false;
        for (const state of next) if (!result.has(state)) { result.add(state); added = true; }
        if (!added) break;
      }
      return result;
    }
    const verified = evaluate(root, new Set([""])).size === 0;
    return { verified, reason: verified ? null : "a matching path may omit all supplied keywords" };
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "analysis failed" };
  }
}

/** A best-effort bounded example; returned examples are validated by RegExp. */
export function createRegexWitness(source: string, flags: string): string | null {
  try {
    const root = parse(source, flags);
    let work = 0;
    function construct(node: Node, expandOptional: boolean): string {
      if (++work > MAX_WORK) throw new Unsupported("witness work limit exceeded");
      if (node.kind === "empty") return "";
      if (node.kind === "chars") return node.witness;
      if (node.kind === "choice") return construct(node.children[0], expandOptional);
      if (node.kind === "sequence") {
        let result = "";
        for (const child of node.children) {
          result += construct(child, expandOptional);
          if (result.length > MAX_WITNESS) throw new Unsupported("witness length limit exceeded");
        }
        return result;
      }
      const child = construct(node.child, expandOptional);
      const count = expandOptional && node.min === 0 && node.max > 0 ? 1 : node.min;
      if (child.length * count > MAX_WITNESS) throw new Unsupported("witness length limit exceeded");
      return child.repeat(count);
    }
    const candidates = [construct(root, false), construct(root, true)];
    const regex = new RegExp(source, flags);
    for (const candidate of candidates) {
      for (const before of ["", "a", " ", "\n"]) {
        for (const after of ["", "a", " ", "\n"]) {
          const value = before + candidate + after;
          if (regex.test(value)) return value;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function verifyGitleaksSource(toml: string, expectedSha256 = GITLEAKS_TOML_SHA256): void {
  const actual = createHash("sha256").update(toml).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`Gitleaks source checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawRule {
  id: string;
  description: string;
  regex: string;
  keywords: string[];
}

interface GitleaksPattern {
  id: string;
  regex: string;
  flags: string;
  description: string;
  keywords: string[];
  prefilter: boolean;
}

// ─── TOML Parser ──────────────────────────────────────────────────────────────

function parseRules(toml: string): RawRule[] {
  const rules: RawRule[] = [];
  const ruleBlocks = toml.split(/^\[\[rules\]\]/m).slice(1);

  for (const block of ruleBlocks) {
    // Stop at the next top-level section
    const end = block.search(/^\[[^\[]/m);
    const section = end === -1 ? block : block.slice(0, end);

    const idMatch = section.match(/^id\s*=\s*["']([^"']+)["']/m);
    if (!idMatch) continue;
    const id = idMatch[1];

    const descMatch = section.match(/^description\s*=\s*["']([^"']*?)["']/ms);
    const description = descMatch
      ? descMatch[1].replace(/\s+/g, " ").trim()
      : "";

    let regex: string | null = null;

    // Triple single-quote (most common in gitleaks.toml)
    const tripleMatch = section.match(/^regex\s*=\s*'''([\s\S]*?)'''/m);
    if (tripleMatch) {
      regex = tripleMatch[1];
    } else {
      // Triple double-quote
      const tripleDoubleMatch = section.match(/^regex\s*=\s*"""([\s\S]*?)"""/m);
      if (tripleDoubleMatch) {
        regex = tripleDoubleMatch[1];
      } else {
        // Regular single or double quoted
        const regularMatch = section.match(/^regex\s*=\s*["']([^"']+)["']/m);
        if (regularMatch) regex = regularMatch[1];
      }
    }

    if (!regex) continue;

    // Upstream uses both inline and multiline TOML string arrays. Preserve
    // source order, normalize to the case-insensitive scrub prefilter, and
    // deduplicate only exact normalized repetitions.
    const keywordMatch = section.match(/^keywords\s*=\s*\[([\s\S]*?)\]/m);
    const keywords = keywordMatch
      ? [...keywordMatch[1].matchAll(/(["'])(.*?)\1/g)]
        .map((match) => match[2].toLowerCase())
        .filter((keyword, index, all) => all.indexOf(keyword) === index)
      : [];

    rules.push({ id, description, regex, keywords });
  }

  return rules;
}

// ─── Go → JS Regex Converter ──────────────────────────────────────────────────

function convertGoRegex(goRegex: string): { regex: string; flags: string } {
  let jsRegex = goRegex;
  let flags = "";

  // Go's (?i) inline flag → JS i flag
  if (jsRegex.includes("(?i)")) {
    flags = "i";
    jsRegex = jsRegex.replace(/\(\?i\)/g, "");
  }

  // RE2 constructs that do not exist in JavaScript.
  jsRegex = jsRegex
    .replace(/\[\[:alnum:\]\]/g, "[A-Za-z0-9]")
    .replace(/\\z/g, "$")
    .replace(/\(\?s:\.\)/g, "[\\s\\S]");

  // JavaScript has no scoped flag groups. Gitleaks patterns are redaction
  // detectors, so broadening the whole expression to ignore case is safer
  // than silently dropping an otherwise valid secret detector.
  if (jsRegex.includes("(?i:")) flags = "i";
  jsRegex = jsRegex.replace(/\(\?[i-]+:/g, "(?:");

  // Go's hex escape for backtick → literal backtick
  jsRegex = jsRegex.replace(/\\x60/g, "`");

  return { regex: jsRegex, flags };
}

// Pinned gitleaks revision 4c232b5014f7618360bd992b4c489cb055881c6b
// spells these service hostnames with wildcard dots. Keep the correction in
// the generator so weekly regeneration preserves the fixes for CodeQL alerts
// 190, 191, and 192. Slack's hostname is also paired-case normalized so the
// detector accepts lower-, upper-, and mixed-case hostnames while retaining
// lowercase path and token semantics.
const HOST_LITERALS_BY_RULE: Readonly<Record<string, readonly string[]>> = {
  "sidekiq-sensitive-url": [
    "gems.contribsys.com",
    "enterprise.contribsys.com",
  ],
  "slack-webhook-url": ["hooks.slack.com"],
};

const PAIRED_CASE_HOST_RULES: ReadonlySet<string> = new Set([
  "slack-webhook-url",
]);

function pairedCaseHostname(hostname: string): string {
  return hostname.replace(/[a-z.]/g, (character) =>
    character === "."
      ? "\\."
      : `[${character.toUpperCase()}${character}]`,
  );
}

export function normalizeGitleaksHostnameLiterals(
  ruleId: string,
  regex: string,
): string {
  const hostnames = HOST_LITERALS_BY_RULE[ruleId];
  if (!hostnames) return regex;

  const usePairedCase = PAIRED_CASE_HOST_RULES.has(ruleId);
  return hostnames.reduce(
    (normalized, hostname) => {
      const escapedHostname = hostname.replaceAll(".", "\\.");
      const replacement = usePairedCase
        ? pairedCaseHostname(hostname)
        : escapedHostname;
      return normalized
        .replaceAll(hostname, replacement)
        .replaceAll(escapedHostname, replacement);
    },
    regex,
  );
}

/**
 * Collapse a redundant nested bounded lazy prefix over the same character
 * class into a single quantifier.
 *
 * Gitleaks writes several rules as `X{0,50}?(?i:X{0,50}?LITERAL…)`. Go has
 * scoped flag groups and JavaScript does not, so the converter above flattens
 * `(?i:` to `(?:` and leaves two adjacent lazy prefixes over the identical
 * class. Only the total length they consume is observable, because every
 * split of a given total consumes the same characters and lazy expansion
 * reaches every total 0..B before any larger total. So `X{0,A}?(?:X{0,B}?R)`
 * and `X{0,A+B}?(?:R)` match identically.
 *
 * The nested form costs (A+1)*(B+1) prefix attempts at every start position
 * instead of A+B+1. At A=B=50 that is 2601 against 101, and it made five
 * rules — cisco-meraki-api-key, cohere-api-token, okta-access-token,
 * privateai-api-token and sumologic-access-id — about 25x slower than an
 * equivalent single prefix, together 70% of the whole 220-rule scan cost on
 * long opaque input. That is what monopolized the daemon event loop during
 * native transcript backfill (#1358).
 */
export function collapseRedundantLazyPrefixes(regex: string): string {
  return regex.replace(
    /(\[(?:[^\]\\]|\\.)*\])\{0,(\d+)\}\?\(\?:\1\{0,(\d+)\}\?/g,
    (_match, characterClass: string, outer: string, inner: string) =>
      `${characterClass}{0,${Number(outer) + Number(inner)}}?(?:`,
  );
}

// ─── Smoke Tests ──────────────────────────────────────────────────────────────

const COMMON_ENGLISH_WORDS = [
  "the",
  "function",
  "return",
  "import",
  "export",
  "default",
  "class",
  "const",
  "let",
  "var",
];

// Maximum number of common words a pattern may match before being considered
// a false-positive generator (aggressive threshold — transcript scrubbing
// prefers false positives over missed secrets).
const MAX_FALSE_POSITIVE_WORDS = 3;

// ─── Regression Guard ─────────────────────────────────────────────────────────

function getPreviousCount(outFile: string): number {
  if (!existsSync(outFile)) return 0;
  const content = readFileSync(outFile, "utf-8");
  const match = content.match(/\/\/ Rules: (\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─── Escape for TS string literal ────────────────────────────────────────────

function escapeForSingleQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Fetching ${TOML_URL} …`);
  const res = await fetch(TOML_URL);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const toml = await res.text();
  verifyGitleaksSource(toml);
  console.log(`  Downloaded ${toml.length} bytes`);

  const rawRules = parseRules(toml);
  console.log(`  Parsed ${rawRules.length} [[rules]] entries`);

  const valid: GitleaksPattern[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const rule of rawRules) {
    const { regex: convertedRegex, flags } = convertGoRegex(rule.regex);
    const regex = collapseRedundantLazyPrefixes(
      normalizeGitleaksHostnameLiterals(rule.id, convertedRegex),
    );
    const keywordAnalysis = analyzeRequiredKeywords(
      regex,
      rule.keywords,
      flags,
    );
    if (!keywordAnalysis.verified) {
      console.log(
        `    PREFILTER OFF ${rule.id}: ${keywordAnalysis.reason ?? "not structurally verified"}`,
      );
    }

    // Test compilability
    let compiled: RegExp;
    try {
      compiled = new RegExp(regex, flags);
    } catch (e) {
      skipped.push({
        id: rule.id,
        reason: `JS-incompatible: ${(e as Error).message}`,
      });
      continue;
    }

    // Smoke test: must not match too many common English words
    const falsePositiveWords = COMMON_ENGLISH_WORDS.filter((w) =>
      compiled.test(w)
    );
    if (falsePositiveWords.length > MAX_FALSE_POSITIVE_WORDS) {
      skipped.push({
        id: rule.id,
        reason: `false-positive on common words: ${falsePositiveWords.join(", ")}`,
      });
      continue;
    }

    valid.push({
      id: rule.id,
      regex,
      flags,
      description: rule.description,
      keywords: rule.keywords,
      prefilter: keywordAnalysis.verified,
    });
  }

  console.log(`  Valid: ${valid.length}, Skipped: ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`    SKIP ${s.id}: ${s.reason}`);
    }
  }

  // Regression guard: abort if valid count dropped >10% from previous
  const previousCount = getPreviousCount(OUT_FILE);
  if (previousCount > 0) {
    const dropPct = (previousCount - valid.length) / previousCount;
    if (dropPct > 0.1) {
      throw new Error(
        `Regression guard: count dropped ${Math.round(dropPct * 100)}% (${previousCount} → ${valid.length}). Aborting.`
      );
    }
  }

  // Build TypeScript file
  const now = new Date().toISOString();
  const skipNote =
    skipped.length > 0
      ? skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")
      : "none";

  const lines: string[] = [
    `// AUTO-GENERATED by scripts/update-gitleaks-patterns.ts — do not edit manually`,
    `// Source: https://github.com/gitleaks/gitleaks/blob/${GITLEAKS_REVISION}/config/gitleaks.toml`,
    `// Updated: ${now}`,
    `// Rules: ${valid.length} (${skipped.length} skipped — ${skipNote})`,
    ``,
    `export interface GitleaksPattern {`,
    `  id: string;`,
    `  regex: string;`,
    `  flags: string;  // "" or "i" (from Go's (?i) inline flag)`,
    `  description: string;`,
    `  keywords: string[];`,
    `  prefilter: boolean;`,
    `}`,
    ``,
    `export const GITLEAKS_PATTERNS: GitleaksPattern[] = [`,
  ];

  for (const p of valid) {
    const escapedDesc = escapeForSingleQuote(p.description);
    const escapedRegex = escapeForSingleQuote(p.regex);
    const escapedKeywords = p.keywords
      .map((keyword) => `'${escapeForSingleQuote(keyword)}'`)
      .join(", ");
    lines.push(
      `  { id: '${p.id}', flags: '${p.flags}', regex: '${escapedRegex}', description: '${escapedDesc}', keywords: [${escapedKeywords}], prefilter: ${p.prefilter} },`
    );
  }

  lines.push(`];`);
  lines.push(``);

  const tsContent = lines.join("\n");
  writeFileSync(OUT_FILE, tsContent, "utf-8");
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  ${valid.length} patterns, ${tsContent.length} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
