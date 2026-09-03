/**
 * Sanitizes error messages for HTTP responses to prevent leaking
 * internal file paths, stack traces, or database schema details.
 */
const PATH_WORD_PATTERN = /^[\p{L}\p{N}\p{M}]$/u;
const URL_SCHEME_START_PATTERN = /^[A-Za-z]$/u;
const URL_SCHEME_CHARACTER_PATTERN = /^[A-Za-z\d+.-]$/u;
const WHITESPACE_PATTERN = /\s/u;
const PATH_DELIMITERS = new Set(["#", "&", "=", "|", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "<", ">"]);

function isPathWord(char: string | undefined): boolean {
  return char !== undefined && (PATH_WORD_PATTERN.test(char) || "_.-@+~%$*".includes(char));
}

function isFileUrlPathStart(chars: readonly string[], index: number): boolean {
  const prefix = chars.slice(Math.max(0, index - 16), index).join("").toLowerCase();
  return prefix.endsWith("file://") || prefix.endsWith("file://localhost");
}

function findUrlAuthorityPathStarts(chars: readonly string[]): Uint8Array {
  const pathStarts = new Uint8Array(chars.length);
  let tokenStart = 0;
  let schemeCandidate = true;
  let separator = -1;
  let validScheme = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (WHITESPACE_PATTERN.test(char)) {
      tokenStart = index + 1;
      schemeCandidate = true;
      separator = -1;
      validScheme = false;
      continue;
    }
    if (separator < 0) {
      if (char === ":" && chars[index + 1] === "/" && chars[index + 2] === "/") {
        separator = index;
        validScheme = index > tokenStart && schemeCandidate;
        continue;
      }
      const schemeCharacter = index === tokenStart
        ? URL_SCHEME_START_PATTERN.test(char)
        : URL_SCHEME_CHARACTER_PATTERN.test(char);
      schemeCandidate &&= schemeCharacter;
      continue;
    }
    if (validScheme && char === "/" && index > separator + 2) pathStarts[index] = 1;
  }

  return pathStarts;
}

function isPosixPathStart(chars: readonly string[], index: number, urlAuthorityPathStarts: Uint8Array): boolean {
  if (chars[index] !== "/" || chars[index + 1] === "/") return false;
  if (isFileUrlPathStart(chars, index)) return true;
  if (urlAuthorityPathStarts[index] === 1) return false;
  const previous = chars[index - 1];
  return previous === undefined || (!isPathWord(previous) && previous !== "/");
}

function isWindowsDrivePathStart(chars: readonly string[], index: number): boolean {
  if (!chars[index]?.match(/^[A-Za-z]$/u) || chars[index + 1] !== ":" || chars[index + 2] !== "\\") return false;
  return !isPathWord(chars[index - 1]);
}

function isUncPathStart(chars: readonly string[], index: number): boolean {
  if (chars[index] !== "\\" || chars[index + 1] !== "\\") return false;
  return !isPathWord(chars[index - 1]);
}

function scanAbsolutePath(chars: readonly string[], start: number, windows: boolean, quote?: string): number {
  let index = start;
  let parentheses = 0;
  let brackets = 0;
  let sawPathCharacter = false;
  while (index < chars.length) {
    const char = chars[index];
    if (isPathWord(char)) {
      sawPathCharacter = true;
      index += 1;
      continue;
    }
    if (windows && index === start + 1 && char === ":") {
      index += 1;
      continue;
    }
    if (char === "/" || (windows && char === "\\")) {
      sawPathCharacter = true;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) return index + 1;
      if (char === "\n" || char === "\r") break;
      index += 1;
      continue;
    }
    if (char === "(" && sawPathCharacter) {
      parentheses += 1;
      index += 1;
      continue;
    }
    if (char === ")" && parentheses > 0) {
      parentheses -= 1;
      index += 1;
      continue;
    }
    if (char === "[" && sawPathCharacter) {
      brackets += 1;
      index += 1;
      continue;
    }
    if (char === "]" && brackets > 0) {
      brackets -= 1;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || PATH_DELIMITERS.has(char)) break;
    index += 1;
  }
  return index;
}

function sanitizeAbsolutePaths(message: string): string {
  const chars = Array.from(message);
  const urlAuthorityPathStarts = findUrlAuthorityPathStarts(chars);
  const sanitized: string[] = [];
  for (let index = 0; index < chars.length;) {
    const quote = chars[index] === "'" || chars[index] === '"' ? chars[index] : undefined;
    const start = quote === undefined ? index : index + 1;
    const windows = isWindowsDrivePathStart(chars, start) || isUncPathStart(chars, start);
    const posix = isPosixPathStart(chars, start, urlAuthorityPathStarts);
    if (!windows && !posix) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    const end = scanAbsolutePath(chars, start, windows, quote);
    if (end <= start + (windows && isWindowsDrivePathStart(chars, start) ? 3 : 1)) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    if (quote !== undefined) sanitized.push(quote);
    sanitized.push("<path>");
    if (quote !== undefined && chars[end - 1] === quote) sanitized.push(quote);
    index = end;
  }
  return sanitized.join("");
}

export function sanitizeError(message: string): string {
  // Replace SQLite internal details with a generic message
  if (/SQLITE_/.test(message)) return "database constraint error";
  return sanitizeAbsolutePaths(message);
}
