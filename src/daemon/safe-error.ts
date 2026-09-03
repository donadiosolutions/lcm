/**
 * Sanitizes error messages for HTTP responses to prevent leaking
 * internal file paths, stack traces, or database schema details.
 */
const PATH_WORD_PATTERN = /^[\p{L}\p{N}\p{M}]$/u;
const PROSE_STOP_WORDS = new Set(["after", "and", "at", "because", "before", "did", "for", "from", "http", "https", "in", "on", "or", "see", "then", "to", "while", "with"]);
const PATH_DELIMITERS = new Set(["#", "&", "=", "|", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "<", ">"]);

function isPathWord(char: string | undefined): boolean {
  return char !== undefined && (PATH_WORD_PATTERN.test(char) || "_.-@+~%$*".includes(char));
}

function isFileUrlPathStart(chars: readonly string[], index: number): boolean {
  return index >= 7 && chars.slice(index - 7, index).join("") === "file://";
}

function isPosixPathStart(chars: readonly string[], index: number): boolean {
  if (chars[index] !== "/" || chars[index + 1] === "/") return false;
  if (isFileUrlPathStart(chars, index)) return true;
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

function nextToken(chars: readonly string[], index: number): string {
  let end = index;
  while (end < chars.length && !/[\s#&=|,;:!?()[\]{}'"<>]/u.test(chars[end])) end += 1;
  return chars.slice(index, end).join("").toLowerCase();
}

function shouldStopAtSpace(chars: readonly string[], index: number): boolean {
  const next = chars[index + 1];
  if (next === undefined || next === "\n" || next === "\r" || next === "\t") return true;
  if (PATH_DELIMITERS.has(next)) return true;
  if (next === "=" && chars[index + 2] === ">") return true;
  const token = nextToken(chars, index + 1);
  return PROSE_STOP_WORDS.has(token);
}

function scanAbsolutePath(chars: readonly string[], start: number, windows: boolean): number {
  let index = start;
  let parentheses = 0;
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
    if (char === " " && shouldStopAtSpace(chars, index)) break;
    if (char === " ") {
      index += 1;
      continue;
    }
    if (char === "\t" || char === "\n" || char === "\r" || PATH_DELIMITERS.has(char)) break;
    index += 1;
  }
  return sawPathCharacter ? index : start;
}

function sanitizeAbsolutePaths(message: string): string {
  const chars = Array.from(message);
  const sanitized: string[] = [];
  for (let index = 0; index < chars.length;) {
    const windows = isWindowsDrivePathStart(chars, index) || isUncPathStart(chars, index);
    const posix = isPosixPathStart(chars, index);
    if (!windows && !posix) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    const end = scanAbsolutePath(chars, index, windows);
    if (end <= index + (windows && isWindowsDrivePathStart(chars, index) ? 3 : 1)) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    sanitized.push("<path>");
    index = end;
  }
  return sanitized.join("");
}

export function sanitizeError(message: string): string {
  // Replace SQLite internal details with a generic message
  if (/SQLITE_/.test(message)) return "database constraint error";
  return sanitizeAbsolutePaths(message);
}
