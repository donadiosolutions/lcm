import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GITLEAKS_PATTERNS } from "./generated-patterns.js";
import { validateRegex } from "./store/regex-safety.js";

const _thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Reads the sync date from the generated-patterns.js header comment.
 * Returns a formatted date string like "2026-03-27" or null if unavailable.
 */
export function readGitleaksSyncDate(): string | null {
  try {
    const genFile = join(_thisDir, "generated-patterns.js");
    if (!existsSync(genFile)) return null;
    const header = readFileSync(genFile, "utf-8").slice(0, 500);
    const match = header.match(/\/\/ Updated: (\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Native (hand-curated) patterns that gap-fill what gitleaks doesn't cover.
 * These are applied in addition to GITLEAKS_PATTERNS.
 *
 * Merge order: GITLEAKS_PATTERNS → NATIVE_PATTERNS → globalUserPatterns → projectPatterns
 */
export const NATIVE_PATTERNS: string[] = [
  // OpenAI / generic sk- keys (gitleaks covers these but with context — add bare form)
  "sk-[A-Za-z0-9]{20,}",
  // Anthropic keys
  "sk-ant-[A-Za-z0-9\\-]{40,}",
  // GitHub PATs (bare form — gitleaks covers with context)
  "ghp_[A-Za-z0-9]{36}",
  // AWS access key IDs (bare form)
  "AKIA[0-9A-Z]{16}",
  // PEM key headers
  "-----BEGIN .* KEY-----",
  // Bearer tokens (authorization header value)
  "Bearer [A-Za-z0-9\\-._~+/]+=*",
  // Password assignments
  "[Pp]assword\\s*[:=]\\s*\\S+",
  // npm tokens (classic npm_ prefix — revoked Dec 2025 but may exist in old configs)
  "npm_[A-Za-z0-9]{30,}",
  // Slack tokens: bot (xoxb), user (xoxp), workspace (xoxa), owner (xoxo),
  // session (xoxs), rotating (xoxe), refresh (xoxr)
  "xox[bpoasre]-[A-Za-z0-9\\-]+",
  // Slack app-level tokens (xapp-) and workflow tokens (xwfp-)
  "xapp-[A-Za-z0-9\\-]+",
  "xwfp-[A-Za-z0-9\\-]+",
  // Stripe live keys (secret, publishable, restricted)
  "[spr]k_live_[A-Za-z0-9]{16,}",
  // Google/GCP API keys (deterministic AIza prefix)
  "AIza[\\w-]{35}",
  // SendGrid API tokens (SG. prefix, 66-char body)
  "SG\\.[a-zA-Z0-9=_\\-.]{66}",
  // Twilio API keys (SK prefix + 32 hex chars)
  "SK[0-9a-fA-F]{32}",
  // Shopify access tokens (shpat_, shpca_, shppa_, shpss_ prefixes)
  "shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}",
  // HashiCorp Vault service tokens (hvs. prefix)
  "hvs\\.[\\w-]{90,120}",
  // Doppler API tokens (dp.pt. prefix)
  "dp\\.pt\\.[a-z0-9]{43}",
  // Database connection strings with embedded credentials
  "(postgres|mysql|mongodb|redis|rediss)://\\S+:\\S+@\\S+",
  // JSON Web Tokens (three base64url segments separated by dots)
  "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
];

/**
 * @deprecated Use NATIVE_PATTERNS instead. Kept for backward compatibility.
 */
export const BUILT_IN_PATTERNS: string[] = NATIVE_PATTERNS;

/**
 * Returns true if a regex pattern source can match across whitespace boundaries.
 * Patterns containing a literal space, \s, or a dot (which matches space) are
 * considered "spanning" and will be applied to the full text rather than
 * token-by-token.
 */
function isSpanningPattern(source: string): boolean {
  // Check for literal space or the escape sequence \s — unambiguous spanning intent.
  // Use string includes (not regex) so we detect the two-char sequence \s, not whitespace chars.
  if (source.includes(" ") || source.includes("\\s")) return true;
  // Check for unescaped `.` which can match spaces
  // Walk the source and look for `.` not preceded by `\`
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (source[i] === ".") return true;
  }
  return false;
}

type TextRange = [number, number];

function nonWhitespaceRanges(text: string): TextRange[] {
  return Array.from(text.matchAll(/\S+/g), (match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

interface RegexSourceAnalysis {
  hasBackreference: boolean;
  hasCaptureDependentLookahead: boolean;
  hasPositiveLookbehind: boolean;
  hasUnescapedAlternation: boolean;
  hasPotentialConsumingAlternative: boolean;
  positiveLookaheadBodies: string[];
  topLevelAlternativeSources: string[];
}

interface RegexGroupFrame {
  assertion: boolean;
  positiveLookaheadBodyStart: number | null;
}

function analyzeRegexSource(source: string): RegexSourceAnalysis {
  const groupStack: RegexGroupFrame[] = [];
  const positiveLookaheadBodies: string[] = [];
  const topLevelAlternationIndexes: number[] = [];
  let assertionDepth = 0;
  let positiveLookaheadDepth = 0;
  let inCharacterClass = false;
  let hasBackreference = false;
  let hasCaptureDependentLookahead = false;
  let hasPositiveLookbehind = false;
  let hasUnescapedAlternation = false;
  let hasPotentialConsumingAlternative = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inCharacterClass) {
      if (character === "\\") index++;
      else if (character === "]") inCharacterClass = false;
      continue;
    }
    if (character === "\\") {
      const escapedCharacter = source.charAt(index + 1);
      const isBackreference = (escapedCharacter >= "1" && escapedCharacter <= "9")
        || source.startsWith("\\k<", index);
      if (isBackreference) hasBackreference = true;
      if (positiveLookaheadDepth > 0 && isBackreference) {
        hasCaptureDependentLookahead = true;
      }
      if (assertionDepth === 0 && escapedCharacter !== "b" && escapedCharacter !== "B") {
        hasPotentialConsumingAlternative = true;
      }
      index++;
      continue;
    }
    if (character === "[") {
      if (assertionDepth === 0) hasPotentialConsumingAlternative = true;
      inCharacterClass = true;
      continue;
    }
    if (character === "(") {
      let assertion = false;
      let positiveLookaheadBodyStart: number | null = null;
      if (source.startsWith("(?=", index)) {
        assertion = true;
        positiveLookaheadBodyStart = index + 3;
        positiveLookaheadDepth++;
        index += 2;
      } else if (source.startsWith("(?!", index)) {
        assertion = true;
        index += 2;
      } else if (source.startsWith("(?<=", index)) {
        assertion = true;
        hasPositiveLookbehind = true;
        index += 3;
      } else if (source.startsWith("(?<!", index)) {
        assertion = true;
        index += 3;
      } else if (source.startsWith("(?:", index)) {
        index += 2;
      } else if (source.startsWith("(?<", index)) {
        // The RegExp constructor already proved that every named group closes.
        index = source.indexOf(">", index + 3);
      }
      groupStack.push({ assertion, positiveLookaheadBodyStart });
      if (assertion) assertionDepth++;
      continue;
    }
    if (character === ")") {
      const group = groupStack.pop();
      if (group?.positiveLookaheadBodyStart != null) {
        positiveLookaheadBodies.push(source.slice(group.positiveLookaheadBodyStart, index));
        positiveLookaheadDepth--;
      }
      if (group?.assertion) assertionDepth--;
      continue;
    }
    if (character === "|") {
      hasUnescapedAlternation = true;
      if (groupStack.length === 0) topLevelAlternationIndexes.push(index);
      continue;
    }
    if (assertionDepth > 0 || "^$*+?".includes(character)) continue;
    const quantifierFirst = source[index + 1] ?? "";
    if (character === "{" && quantifierFirst >= "0" && quantifierFirst <= "9") {
      const quantifierEnd = source.indexOf("}", index + 2);
      if (quantifierEnd >= 0) {
        index = quantifierEnd;
        continue;
      }
    }
    hasPotentialConsumingAlternative = true;
  }
  return {
    hasBackreference,
    hasCaptureDependentLookahead,
    hasPositiveLookbehind,
    hasUnescapedAlternation,
    hasPotentialConsumingAlternative,
    positiveLookaheadBodies,
    topLevelAlternativeSources: topLevelAlternationIndexes.length === 0
      ? []
      : [
          -1,
          ...topLevelAlternationIndexes,
          source.length,
        ].slice(1).map((end, branchIndex, boundaries) =>
          source.slice((boundaries[branchIndex - 1] ?? -1) + 1, end)
        ),
  };
}

interface RegexCollectionPlan {
  alternativeProbes: RegExp[];
  hasCaptureDependentAlternative: boolean;
  hasCaptureDependentLookahead: boolean;
  lookaheadProbes: RegExp[];
  preferPrecedingAtBoundary: boolean;
  preserveAlternativeMatches: boolean;
}

interface CompiledScrubPattern {
  plan: RegexCollectionPlan;
  regex: RegExp;
  source: string;
}

function createRegexCollectionPlan(regex: RegExp): RegexCollectionPlan {
  const sourceAnalysis = analyzeRegexSource(regex.source);
  const lookaheadFlags = regex.flags.replace(/[dgy]/gu, "");
  const lookaheadProbes = sourceAnalysis.hasCaptureDependentLookahead
    ? []
    : sourceAnalysis.positiveLookaheadBodies.map(
        (body) => new RegExp(`^(?:${body})`, lookaheadFlags),
      );
  const preserveAlternativeMatches = sourceAnalysis.hasUnescapedAlternation
    && sourceAnalysis.hasPotentialConsumingAlternative;
  const hasCaptureDependentAlternative = preserveAlternativeMatches
    && sourceAnalysis.hasBackreference
    && sourceAnalysis.topLevelAlternativeSources.length > 0;
  const alternativeFlags = regex.flags.replace(/[dy]/gu, "");
  const alternativeProbes = preserveAlternativeMatches && !hasCaptureDependentAlternative
    ? sourceAnalysis.topLevelAlternativeSources.map(
        (source) => new RegExp(source, alternativeFlags),
      )
    : [];
  return {
    alternativeProbes,
    hasCaptureDependentAlternative,
    hasCaptureDependentLookahead: sourceAnalysis.hasCaptureDependentLookahead,
    lookaheadProbes,
    preferPrecedingAtBoundary: sourceAnalysis.hasPositiveLookbehind,
    preserveAlternativeMatches,
  };
}

function zeroWidthTokenRanges(
  ranges: readonly TextRange[],
  anchor: number,
  preferPrecedingAtBoundary: boolean,
  includeFollowingAtBoundary: boolean,
): readonly TextRange[] {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle][1] <= anchor) low = middle + 1;
    else high = middle;
  }
  const preceding = ranges[low - 1];
  const following = ranges[low];
  if (
    preferPrecedingAtBoundary
    && preceding
    && following
    && preceding[1] < anchor
    && following[0] >= anchor
  ) {
    return [preceding, following];
  }
  if (preferPrecedingAtBoundary && preceding?.[1] === anchor) {
    return includeFollowingAtBoundary && following ? [preceding, following] : [preceding];
  }
  const selected = following ?? preceding;
  return selected ? [selected] : [];
}

/**
 * Convert a regex match into a consuming source range.
 *
 * Consuming matches retain their exact range. A zero-width match uses cached
 * non-whitespace boundaries to select the containing or following token. At a
 * token-end boundary, positive lookbehind prefers the preceding token; when a
 * matching lookahead also identifies non-whitespace text, both plausible token
 * ranges are returned. The final preceding token is the fallback when nothing
 * follows the anchor. Inputs containing no token do not produce a redaction.
 */
function consumingMatchRanges(
  match: RegExpExecArray,
  getTokenRanges: () => readonly TextRange[],
  preferPrecedingAtBoundary: boolean,
  includeFollowingAtBoundary: boolean,
): readonly TextRange[] {
  if (match[0].length > 0) return [[match.index, match.index + match[0].length]];
  return zeroWidthTokenRanges(
    getTokenRanges(),
    match.index,
    preferPrecedingAtBoundary,
    includeFollowingAtBoundary,
  );
}

function collectConsumingRanges(
  text: string,
  pattern: CompiledScrubPattern,
  getTokenRanges: () => readonly TextRange[],
  collect: (range: TextRange) => void,
): void {
  const { plan, regex } = pattern;
  regex.lastIndex = 0;
  let previousZeroRanges: readonly TextRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const isZeroWidth = match[0].length === 0;
    const anchor = match.index;
    const includeFollowingAtBoundary = plan.preferPrecedingAtBoundary && (
      plan.hasCaptureDependentLookahead
      || plan.lookaheadProbes.some(
        (probe) => /\S/u.test(probe.exec(text.slice(anchor))?.[0] ?? ""),
      )
    );
    const ranges = consumingMatchRanges(
      match,
      getTokenRanges,
      plan.preferPrecedingAtBoundary,
      includeFollowingAtBoundary,
    );
    for (const range of ranges) {
      if (!isZeroWidth || !previousZeroRanges.includes(range)) collect(range);
    }

    if (!isZeroWidth) continue;
    if (ranges.length === 0) break;

    let consumingAlternativeEnd = anchor;
    const expandedEnd = Math.max(...ranges.map((range) => range[1]));
    if (plan.hasCaptureDependentAlternative) {
      const expandedStart = Math.min(...ranges.map((range) => range[0]));
      collect([expandedStart, text.length]);
      consumingAlternativeEnd = text.length;
    }
    for (const probe of plan.alternativeProbes) {
      probe.lastIndex = anchor;
      const alternativeMatch = probe.exec(text);
      if (
        alternativeMatch
        && alternativeMatch[0].length > 0
        && alternativeMatch.index < expandedEnd
      ) {
        const alternativeEnd = alternativeMatch.index + alternativeMatch[0].length;
        collect([alternativeMatch.index, alternativeEnd]);
        consumingAlternativeEnd = Math.max(consumingAlternativeEnd, alternativeEnd);
      }
    }

    previousZeroRanges = ranges;
    const lastIndexAfterMatch = regex.lastIndex;
    if (!plan.preserveAlternativeMatches || consumingAlternativeEnd > anchor) {
      regex.lastIndex = Math.max(regex.lastIndex, ...ranges.map((range) => range[1]));
      regex.lastIndex = Math.max(regex.lastIndex, consumingAlternativeEnd);
    }
    if (regex.lastIndex === lastIndexAfterMatch) regex.lastIndex++;
  }
}

export interface ScrubCounts {
  text: string;
  gitleaks: number;
  builtIn: number;
  global: number;
  project: number;
}

/** Gitleaks sync date extracted from generated file header (ISO string or null). */
export function getGitleaksSyncDate(): string | null {
  // Import the generated file's header comment to extract the sync date.
  // We parse it from the module-level comment using a regex on the import URL.
  // Since we can't read import comments at runtime, we embed it via the GITLEAKS_PATTERNS array length check.
  // The date is exposed via the module's comment; callers can read it via readGitleaksSyncDate().
  return null;
}

export class ScrubEngine {
  private readonly spanningPatterns: CompiledScrubPattern[] = [];
  private readonly tokenPatterns: CompiledScrubPattern[] = [];
  /**
   * Original index (into the combined [gitleaks, native, global, project] array) for each spanning pattern.
   * Gitleaks patterns are always "spanning" (applied to full text regardless of isSpanningPattern).
   */
  private readonly _spanningOrigIdx: number[] = [];
  /** Original index for each token pattern. */
  private readonly _tokenOrigIdx: number[] = [];
  /** Number of gitleaks patterns at the start of the combined array. */
  private readonly _gitleaksCount: number;
  /** Number of native (built-in) patterns after gitleaks. */
  private readonly _nativeCount: number;
  /** Number of global patterns (for category accounting). */
  private readonly _globalPatternCount: number;
  readonly invalidPatterns: string[] = [];

  constructor(globalPatterns: string[], projectPatterns: string[]) {
    this._gitleaksCount = GITLEAKS_PATTERNS.length;
    this._nativeCount = NATIVE_PATTERNS.length;
    this._globalPatternCount = globalPatterns.length;

    // Merge order: gitleaks → native → global → project
    const trustedPatterns: Array<{ source: string; isGitleaks: boolean; flags: string }> = [
      ...GITLEAKS_PATTERNS.map((p) => ({ source: p.regex, isGitleaks: true, flags: p.flags })),
      ...NATIVE_PATTERNS.map((p) => ({ source: p, isGitleaks: false, flags: "" })),
    ];
    const userPatterns: Array<{ source: string; isGitleaks: false; flags: string }> = [
      ...globalPatterns.map((p) => ({ source: p, isGitleaks: false as const, flags: "" })),
      ...projectPatterns.map((p) => ({ source: p, isGitleaks: false as const, flags: "" })),
    ];
    for (let i = 0; i < trustedPatterns.length; i++) {
      const { source, isGitleaks, flags } = trustedPatterns[i];
      try {
        const regex = new RegExp(source, "g" + flags);
        const pattern = { source, regex, plan: createRegexCollectionPlan(regex) };
        // Gitleaks patterns always run against full text (bypass spanning check)
        if (isGitleaks || isSpanningPattern(source)) {
          this.spanningPatterns.push(pattern);
          this._spanningOrigIdx.push(i);
        } else {
          this.tokenPatterns.push(pattern);
          this._tokenOrigIdx.push(i);
        }
      } catch {
        this.invalidPatterns.push(source);
      }
    }

    for (let i = 0; i < userPatterns.length; i++) {
      const { source, flags } = userPatterns[i];
      const originalIndex = trustedPatterns.length + i;
      try {
        const regex = validateRegex(source, "g" + flags);
        const pattern = { source, regex, plan: createRegexCollectionPlan(regex) };
        if (isSpanningPattern(source)) {
          this.spanningPatterns.push(pattern);
          this._spanningOrigIdx.push(originalIndex);
        } else {
          this.tokenPatterns.push(pattern);
          this._tokenOrigIdx.push(originalIndex);
        }
      } catch {
        this.invalidPatterns.push(source);
      }
    }
  }

  /**
   * Redact all matching patterns in text, returning the scrubbed text along
   * with per-category counts of how many redactions were made.
   *
   * Strategy:
   * - Gitleaks patterns are always applied to the full text (they're pre-vetted
   *   for full-text scanning and many contain `.` for key-value matching).
   * - "Spanning" native/user patterns (those that can match across whitespace)
   *   are applied to the full text via a multi-range merge.
   * - "Token" native/user patterns (no whitespace/dot in source) are applied
   *   token-by-token so that greedy `.*`-style patterns don't eat adjacent tokens.
   */
  scrubWithCounts(text: string): ScrubCounts {
    const gitleaksCount = this._gitleaksCount;
    const nativeCount = this._nativeCount;
    const globalCount = this._globalPatternCount;

    // Step 1: collect ranges from spanning patterns applied to full text
    // (includes all gitleaks patterns + spanning native/user patterns)
    type TaggedRange = { range: TextRange; idx: number };
    const taggedRangesByKey = new Map<string, TaggedRange>();
    const addTaggedRange = (range: TextRange, idx: number): void => {
      const key = `${range[0]}:${range[1]}`;
      const winnerIdx = Math.min(idx, taggedRangesByKey.get(key)?.idx ?? idx);
      taggedRangesByKey.set(key, { range, idx: winnerIdx });
    };
    let textTokenRanges: TextRange[] | null = null;
    const getTextTokenRanges = (): readonly TextRange[] => {
      textTokenRanges ??= nonWhitespaceRanges(text);
      return textTokenRanges;
    };
    for (let pi = 0; pi < this.spanningPatterns.length; pi++) {
      const pattern = this.spanningPatterns[pi];
      collectConsumingRanges(text, pattern, getTextTokenRanges, (range) => {
        addTaggedRange(range, this._spanningOrigIdx[pi]);
      });
    }

    // Step 2: apply token patterns per whitespace-separated segment
    const segments = text.split(/(\s+)/);
    let offset = 0;
    for (const seg of segments) {
      if (!/^\s+$/.test(seg) && this.tokenPatterns.length > 0) {
        const segmentTokenRanges: TextRange[] = seg.length > 0 ? [[0, seg.length]] : [];
        for (let pi = 0; pi < this.tokenPatterns.length; pi++) {
          const pattern = this.tokenPatterns[pi];
          collectConsumingRanges(seg, pattern, () => segmentTokenRanges, (range) => {
            addTaggedRange(
              [offset + range[0], offset + range[1]],
              this._tokenOrigIdx[pi],
            );
          });
        }
      }
      offset += seg.length;
    }

    const taggedRanges = [...taggedRangesByKey.values()];
    if (taggedRanges.length === 0) return { text, gitleaks: 0, builtIn: 0, global: 0, project: 0 };

    // Sort by start position
    taggedRanges.sort((a, b) => a.range[0] - b.range[0]);

    // Merge overlapping ranges; when overlaps occur, the lowest original pattern
    // index wins so that gitleaks > native > global > project and earlier patterns win.
    const merged: Array<{ range: [number, number]; idx: number }> = [];
    let cur = taggedRanges[0];
    for (let i = 1; i < taggedRanges.length; i++) {
      const next = taggedRanges[i];
      if (next.range[0] <= cur.range[1]) {
        cur = { range: [cur.range[0], Math.max(cur.range[1], next.range[1])], idx: Math.min(cur.idx, next.idx) };
      } else {
        merged.push(cur);
        cur = next;
      }
    }
    merged.push(cur);

    // Count redactions by category
    let gitleaks = 0;
    let builtIn = 0;
    let global = 0;
    let project = 0;
    for (const { idx } of merged) {
      if (idx < gitleaksCount) gitleaks++;
      else if (idx < gitleaksCount + nativeCount) builtIn++;
      else if (idx < gitleaksCount + nativeCount + globalCount) global++;
      else project++;
    }

    // Build result string
    let result = "";
    let pos = 0;
    for (const { range: [s, e] } of merged) {
      result += text.slice(pos, s) + "[REDACTED]";
      pos = e;
    }
    result += text.slice(pos);
    return { text: result, gitleaks, builtIn, global, project };
  }

  /**
   * Redact all matching patterns in text, replacing matches with [REDACTED].
   *
   * Strategy:
   * - Gitleaks patterns always applied to full text.
   * - "Spanning" native/user patterns applied to full text.
   * - "Token" patterns applied token-by-token.
   */
  scrub(text: string): string {
    return this.scrubWithCounts(text).text;
  }

  /** Parse a sensitive-patterns.txt file. Returns empty array if file is absent. */
  static async loadProjectPatterns(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Build a ScrubEngine for a given project directory. */
  static async forProject(
    globalPatterns: string[],
    projectDir: string,
  ): Promise<ScrubEngine> {
    const projectPatterns = await ScrubEngine.loadProjectPatterns(
      join(projectDir, "sensitive-patterns.txt"),
    );
    return new ScrubEngine(globalPatterns, projectPatterns);
  }
}
