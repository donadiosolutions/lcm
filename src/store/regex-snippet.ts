import { ScrubEngine } from "../scrub.js";

const MAX_REGEX_SNIPPET_CODE_POINTS = 512;

export const REGEX_SNIPPET_TRUNCATION_MARKER = "…[truncated]";
export const REGEX_SNIPPET_REDACTION_FALLBACK = "[REDACTED]";

let credentialScrubber: ScrubEngine | undefined;

function getCredentialScrubber(): ScrubEngine {
  credentialScrubber ??= new ScrubEngine([], []);
  return credentialScrubber;
}

function boundRegexSnippet(match: string): string {
  if (match.length === 0) {
    return "";
  }

  const codePoints = Array.from(match);
  if (codePoints.length <= MAX_REGEX_SNIPPET_CODE_POINTS) {
    return match;
  }

  const markerLength = Array.from(REGEX_SNIPPET_TRUNCATION_MARKER).length;
  return codePoints
    .slice(0, MAX_REGEX_SNIPPET_CODE_POINTS - markerLength)
    .join("") + REGEX_SNIPPET_TRUNCATION_MARKER;
}

export function createRegexSnippet(content: string, regex: RegExp): string {
  const scrubbed = getCredentialScrubber().scrub(content);
  regex.lastIndex = 0;
  const safeMatch = regex.exec(scrubbed);
  return boundRegexSnippet(safeMatch?.[0] ?? REGEX_SNIPPET_REDACTION_FALLBACK);
}
