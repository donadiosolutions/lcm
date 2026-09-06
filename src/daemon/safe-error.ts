/**
 * Sanitizes error messages for HTTP responses to prevent leaking
 * internal file paths, stack traces, or database schema details.
 */
const PATH_WORD_PATTERN = /^[\p{L}\p{N}\p{M}]$/u;
const URL_SCHEME_START_PATTERN = /^[A-Za-z]$/u;
const URL_SCHEME_CHARACTER_PATTERN = /^[A-Za-z\d+.-]$/u;
const FILE_SCHEME = "file";
const WHITESPACE_PATTERN = /\s/u;
const PATH_DELIMITERS = new Set(["#", "&", "=", "|", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "<", ">"]);
const URL_END_DELIMITERS = new Set(["|", ",", ";", ")", "]", "}", "'", '"', "<", ">"]);
const FILE_URL_AUTHORITY_DELIMITERS = new Set([",", ";", ")", "}", "'"]);
const NESTED_FILE_URL_DELIMITERS = new Set(["?", "#", "&", "="]);

function isPathWord(char: string | undefined): boolean {
  return char !== undefined && (PATH_WORD_PATTERN.test(char) || "_.-@+~%$*".includes(char));
}

function isFileUrlPathStart(chars: readonly string[], index: number): boolean {
  const prefix = chars.slice(Math.max(0, index - 16), index).join("").toLowerCase();
  return prefix.endsWith("file://") || prefix.endsWith("file://localhost");
}

interface UrlPathStarts {
  authority: Uint8Array;
  file: Uint8Array;
  fileQuote: Uint8Array;
}

function quoteCode(char: string | undefined): number {
  if (char === "'") return 1;
  if (char === '"') return 2;
  return 0;
}

function quoteFromCode(code: number): string | undefined {
  if (code === 1) return "'";
  if (code === 2) return '"';
  return undefined;
}

function isNestedFileUrlStart(chars: readonly string[], index: number): boolean {
  if (!NESTED_FILE_URL_DELIMITERS.has(chars[index])) return false;
  return (
    chars[index + 1]?.toLowerCase() === "f" &&
    chars[index + 2]?.toLowerCase() === "i" &&
    chars[index + 3]?.toLowerCase() === "l" &&
    chars[index + 4]?.toLowerCase() === "e" &&
    chars[index + 5] === ":" &&
    chars[index + 6] === "/" &&
    chars[index + 7] === "/"
  );
}

function findUrlPathStarts(chars: readonly string[]): UrlPathStarts {
  const authority = new Uint8Array(chars.length);
  const file = new Uint8Array(chars.length);
  const fileQuote = new Uint8Array(chars.length);
  let schemeLength = 0;
  let fileSchemeLength = 0;
  let schemeQuote = 0;
  let separator = -1;
  let brackets = 0;
  let exactFileScheme = false;
  let foundFilePath = false;
  let filePathBracketDepth = 0;
  let restartedPathlessFile = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (WHITESPACE_PATTERN.test(char)) {
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      separator = -1;
      brackets = 0;
      exactFileScheme = false;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      continue;
    }
    if (separator >= 0 && char === "[") {
      brackets += 1;
      continue;
    }
    if (separator >= 0 && char === "]" && brackets > 0) {
      const closesFilePathWrapper = foundFilePath && brackets === filePathBracketDepth;
      brackets -= 1;
      if (closesFilePathWrapper) {
        filePathBracketDepth = brackets;
        if (chars[index + 1] === "/" || chars[index + 1] === "\\") foundFilePath = false;
      }
      continue;
    }
    if (separator >= 0 && isNestedFileUrlStart(chars, index)) {
      separator = index + 5;
      brackets = 0;
      exactFileScheme = true;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      authority[index + 6] = 1;
      authority[index + 7] = 1;
      continue;
    }
    if (
      separator >= 0 &&
      exactFileScheme &&
      !foundFilePath &&
      brackets === 0 &&
      schemeQuote === 0 &&
      (char === "?" || char === "#")
    ) {
      // An unquoted pathless file URL has finished its authority. Scan the
      // query or fragment from fresh state so nested URLs and standalone paths
      // retain their own classification.
      separator = -1;
      exactFileScheme = false;
      foundFilePath = false;
      filePathBracketDepth = 0;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      restartedPathlessFile = true;
      continue;
    }
    if (restartedPathlessFile && URL_END_DELIMITERS.has(char)) {
      restartedPathlessFile = false;
    }
    // These characters are valid in a file URL authority. Keep classifying
    // until the first path separator, except when one closes a quote that
    // immediately preceded the scheme. Once a path starts, all URL-ending
    // delimiters retain their existing termination behavior below.
    const fileAuthorityDelimiter =
      exactFileScheme &&
      !foundFilePath &&
      FILE_URL_AUTHORITY_DELIMITERS.has(char) &&
      !(schemeQuote !== 0 && quoteCode(char) === schemeQuote);
    if (separator >= 0 && brackets === 0 && URL_END_DELIMITERS.has(char) && !fileAuthorityDelimiter) {
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      separator = -1;
      exactFileScheme = false;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      continue;
    }
    if (separator >= 0) {
      if (char === "/") authority[index] = 1;
      if (
        exactFileScheme &&
        !foundFilePath &&
        index > separator + 2 &&
        // Valid bracketed IP-literal authorities cannot contain a slash or backslash,
        // so the first such separator is the file URL path boundary even when
        // malformed bracket state is still open.
        (char === "/" || char === "\\")
      ) {
        file[index] = 1;
        fileQuote[index] = schemeQuote;
        foundFilePath = true;
        filePathBracketDepth = brackets;
      }
      continue;
    }
    // Preserve the former file-authority handling for the first backslash in
    // this tail without widening backslash detection in unrelated text.
    if (restartedPathlessFile && (char === "/" || char === "\\")) {
      restartedPathlessFile = false;
      if (char === "\\") {
        file[index] = 1;
        continue;
      }
    }
    if (char === ":" && schemeLength > 0 && chars[index + 1] === "/" && chars[index + 2] === "/") {
      restartedPathlessFile = false;
      separator = index;
      authority[index + 1] = 1;
      authority[index + 2] = 1;
      exactFileScheme = schemeLength === FILE_SCHEME.length && fileSchemeLength === FILE_SCHEME.length;
      foundFilePath = false;
      filePathBracketDepth = 0;
      continue;
    }
    if (schemeLength === 0) {
      if (URL_SCHEME_START_PATTERN.test(char)) {
        schemeLength = 1;
        fileSchemeLength = char.toLowerCase() === FILE_SCHEME[0] ? 1 : -1;
        schemeQuote = quoteCode(chars[index - 1]);
      } else {
        schemeQuote = 0;
      }
      continue;
    }
    if (URL_SCHEME_CHARACTER_PATTERN.test(char)) {
      schemeLength += 1;
      if (
        fileSchemeLength >= 0 &&
        fileSchemeLength < FILE_SCHEME.length &&
        char.toLowerCase() === FILE_SCHEME[fileSchemeLength]
      ) {
        fileSchemeLength += 1;
      } else {
        fileSchemeLength = -1;
      }
    } else {
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
    }
  }

  return { authority, file, fileQuote };
}

function isPosixPathStart(chars: readonly string[], index: number, urlAuthorityPathStarts: Uint8Array): boolean {
  if (chars[index] !== "/") return false;
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

function fileUrlDriveColonIndex(chars: readonly string[], start: number): number {
  let index = start;
  while (chars[index] === "/" || chars[index] === "\\") index += 1;
  const letter = chars[index];
  const codePoint = letter?.codePointAt(0) ?? 0;
  const asciiLetter = (codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122);
  if (
    asciiLetter &&
    chars[index + 1] === ":" &&
    (chars[index + 2] === "/" || chars[index + 2] === "\\")
  ) {
    return index + 1;
  }
  return -1;
}

function scanAbsolutePath(
  chars: readonly string[],
  start: number,
  windows: boolean,
  driveColonIndex: number,
  quote?: string,
): { end: number; sawNonSeparator: boolean } {
  let index = start;
  let parentheses = 0;
  let brackets = 0;
  let sawPathCharacter = false;
  let sawNonSeparator = false;
  while (index < chars.length) {
    const char = chars[index];
    if (isPathWord(char)) {
      sawPathCharacter = true;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (index === driveColonIndex && char === ":") {
      index += 1;
      continue;
    }
    if (char === "/" || (windows && char === "\\")) {
      sawPathCharacter = true;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) return { end: index + 1, sawNonSeparator };
      if (char === "\n" || char === "\r") break;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (char === "(" && sawPathCharacter) {
      parentheses += 1;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (char === ")" && parentheses > 0) {
      parentheses -= 1;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (char === "[" && sawPathCharacter) {
      brackets += 1;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (char === "]" && brackets > 0) {
      brackets -= 1;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || PATH_DELIMITERS.has(char)) break;
    sawNonSeparator = true;
    index += 1;
  }
  return { end: index, sawNonSeparator };
}

function sanitizeAbsolutePaths(message: string): string {
  const chars = Array.from(message);
  const urlPathStarts = findUrlPathStarts(chars);
  const sanitized: string[] = [];
  for (let index = 0; index < chars.length;) {
    const fileUrl = urlPathStarts.file[index] === 1;
    const openingQuote = chars[index] === "'" || chars[index] === '"' ? chars[index] : undefined;
    const start = fileUrl || openingQuote === undefined ? index : index + 1;
    const windowsDrive = isWindowsDrivePathStart(chars, start);
    const windows = fileUrl || windowsDrive || isUncPathStart(chars, start);
    const posix = !fileUrl && isPosixPathStart(chars, start, urlPathStarts.authority);
    if (!fileUrl && !windows && !posix) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    const quote = fileUrl ? quoteFromCode(urlPathStarts.fileQuote[index]) : openingQuote;
    const driveColonIndex = fileUrl ? fileUrlDriveColonIndex(chars, start) : windowsDrive ? start + 1 : -1;
    const { end, sawNonSeparator } = scanAbsolutePath(chars, start, windows, driveColonIndex, quote);
    if (
      ((fileUrl || posix) && !sawNonSeparator) ||
      (!fileUrl && end <= start + (windowsDrive ? 3 : 1))
    ) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    if (!fileUrl && openingQuote !== undefined) sanitized.push(openingQuote);
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
