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
  forcedPath: Uint8Array;
  nestedFileSchemeStarts: Uint8Array;
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
  return isFileUrlLiteral(chars, index + 1);
}

function isFileUrlLiteral(chars: readonly string[], index: number): boolean {
  return (
    chars[index]?.toLowerCase() === "f" &&
    chars[index + 1]?.toLowerCase() === "i" &&
    chars[index + 2]?.toLowerCase() === "l" &&
    chars[index + 3]?.toLowerCase() === "e" &&
    chars[index + 4] === ":" &&
    chars[index + 5] === "/" &&
    chars[index + 6] === "/"
  );
}

function isSingleSlashFileUrlLiteral(chars: readonly string[], index: number): boolean {
  return (
    chars[index]?.toLowerCase() === "f" &&
    chars[index + 1]?.toLowerCase() === "i" &&
    chars[index + 2]?.toLowerCase() === "l" &&
    chars[index + 3]?.toLowerCase() === "e" &&
    chars[index + 4] === ":" &&
    chars[index + 5] === "/" &&
    chars[index + 6] !== "/"
  );
}

function startsWordBearingSlashPath(chars: readonly string[], index: number): boolean {
  if (!isPathWord(chars[index])) return false;
  let cursor = index + 1;
  while (isPathWord(chars[cursor])) cursor += 1;
  return chars[cursor] === "/" && isPathWord(chars[cursor + 1]);
}

function wordBearingPrivateRootPathStart(chars: readonly string[], index: number): number {
  if (!isPathWord(chars[index])) return -1;
  let cursor = index + 1;
  while (isPathWord(chars[cursor])) cursor += 1;
  if (chars[cursor] !== "/") return -1;
  const root = chars.slice(cursor + 1, cursor + 6).join("").toLowerCase();
  if (root !== "users" || (chars[cursor + 6] !== "/" && chars[cursor + 6] !== "\\")) return -1;
  return cursor;
}

function wordBearingWindowsValuePathStart(chars: readonly string[], index: number): number {
  if (!isPathWord(chars[index])) return -1;
  let cursor = index + 1;
  while (isPathWord(chars[cursor])) cursor += 1;
  if (chars[cursor] !== "=") return -1;
  const valueStart = cursor + 1;
  return chars[valueStart] === "\\" || isWindowsDrivePathStart(chars, valueStart) ? valueStart : -1;
}

function findUrlPathStarts(chars: readonly string[]): UrlPathStarts {
  const authority = new Uint8Array(chars.length);
  const file = new Uint8Array(chars.length);
  const fileQuote = new Uint8Array(chars.length);
  const forcedPath = new Uint8Array(chars.length);
  const nestedFileSchemeStarts = new Uint8Array(chars.length);
  const pipePathHandoffWrapperDepths = new Set<number>();
  const repeatedPipeHandoffWrapperDepths = new Set<number>();
  const nestedFileUrlParentOwnerBracketDepths = new Set<number>();
  const restartedNestedFileUrlParentOwnerBracketDepths = new Set<number>();
  const suspendedPathlessFileQueryOwnerDepths = new Set<number>();
  const closedChildGroupRootedOwnerDepths = new Set<number>();
  let pathlessFileQueryScopeActive = false;
  let urlSeenInsidePathlessWrapper = false;
  let schemeLength = 0;
  let fileSchemeLength = 0;
  let schemeQuote = 0;
  let separator = -1;
  let brackets = 0;
  let exactFileScheme = false;
  let foundFilePath = false;
  let filePathBracketDepth = 0;
  let restartedPathlessFile = false;
  let quotedPathEnded = false;
  let quotedQueryTail = false;
  let quotedPathEndedSeparator = -1;
  let restartedPathlessBrackets = 0;
  let pathlessFileQueryOwnerBracketDepth = 0;
  let activeNestedFileUrlParentOwnerBracketDepth = 0;
  let fileTailBracketDepth = 0;
  let pendingFileTailBackslash = false;
  let pendingNestedUrlContinuation = false;
  let queryOrFragment = false;
  let queryOrFragmentStart = -1;
  let nestedPublicUrlBracketDepth = 0;
  let pathlessFileQueryBracketDepth = 0;
  let pathlessNestedPublicUrlActive = false;
  let slashPrefixedNestedPublicSchemeStart = -1;
  let quotedQueryPublicUrl = false;
  let quotedQueryPublicUrlOwnQueryOrFragment = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (WHITESPACE_PATTERN.test(char)) {
      const preservesClosedBracketHandoff =
        pendingFileTailBackslash && fileTailBracketDepth === 0 && (char === " " || char === "\t");
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      separator = -1;
      brackets = 0;
      exactFileScheme = false;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      quotedPathEnded = false;
      quotedQueryTail = false;
      quotedPathEndedSeparator = -1;
      restartedPathlessBrackets = 0;
      pathlessFileQueryOwnerBracketDepth = 0;
      pipePathHandoffWrapperDepths.clear();
      repeatedPipeHandoffWrapperDepths.clear();
      nestedFileUrlParentOwnerBracketDepths.clear();
      restartedNestedFileUrlParentOwnerBracketDepths.clear();
      suspendedPathlessFileQueryOwnerDepths.clear();
      closedChildGroupRootedOwnerDepths.clear();
      pathlessFileQueryScopeActive = false;
      urlSeenInsidePathlessWrapper = false;
      activeNestedFileUrlParentOwnerBracketDepth = 0;
      queryOrFragment = false;
      nestedPublicUrlBracketDepth = 0;
      pathlessFileQueryBracketDepth = 0;
      pathlessNestedPublicUrlActive = false;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      if (!preservesClosedBracketHandoff) {
        fileTailBracketDepth = 0;
        pendingFileTailBackslash = false;
        pendingNestedUrlContinuation = false;
      }
      continue;
    }
    const closingPathlessFileQueryOwnerDepth =
      pathlessFileQueryOwnerBracketDepth > 0 && char === "]"
        ? pathlessFileQueryOwnerBracketDepth
        : 0;
    if (pathlessFileQueryOwnerBracketDepth > 0 && char === "[") {
      pathlessFileQueryOwnerBracketDepth += 1;
    } else if (pathlessFileQueryOwnerBracketDepth > 0 && char === "]") {
      suspendedPathlessFileQueryOwnerDepths.delete(pathlessFileQueryOwnerBracketDepth);
      pathlessFileQueryOwnerBracketDepth -= 1;
      if (pathlessFileQueryOwnerBracketDepth === 0) urlSeenInsidePathlessWrapper = false;
      // A private tail or a closed sibling group ends the restarted scanner
      // but not the enclosing file query, so a later sibling wrapper still
      // belongs to that query and must own its own bracket depth.
    } else if ((restartedPathlessFile || pathlessFileQueryScopeActive) && char === "[") {
      pathlessFileQueryOwnerBracketDepth = 1;
      urlSeenInsidePathlessWrapper = false;
    }
    if (
      closingPathlessFileQueryOwnerDepth > 0 &&
      pipePathHandoffWrapperDepths.delete(closingPathlessFileQueryOwnerDepth)
    ) {
      if (
        (chars[index + 1] === "/" || chars[index + 1] === "\\")
      ) {
        forcedPath[index + 1] = 1;
      }
    }
    if (closingPathlessFileQueryOwnerDepth > 0) {
      if (nestedFileUrlParentOwnerBracketDepths.delete(closingPathlessFileQueryOwnerDepth)) {
        // A closed child group takes its word-bearing ownership with it, but a
        // rooted successor is still private text belonging to the enclosing
        // scope. Hand that narrower ownership outward instead of dropping it.
        closedChildGroupRootedOwnerDepths.add(closingPathlessFileQueryOwnerDepth - 1);
        if (chars[index + 1] === "/" || chars[index + 1] === "\\") {
          forcedPath[index + 1] = 1;
        }
      } else if (
        closedChildGroupRootedOwnerDepths.delete(closingPathlessFileQueryOwnerDepth)
      ) {
        // Rooted ownership handed outward by an inner group keeps moving
        // outward through each further close, so an extra bracket level
        // between the child and its successor does not drop it.
        closedChildGroupRootedOwnerDepths.add(closingPathlessFileQueryOwnerDepth - 1);
        if (chars[index + 1] === "/" || chars[index + 1] === "\\") {
          forcedPath[index + 1] = 1;
        }
      }
      restartedNestedFileUrlParentOwnerBracketDepths.delete(closingPathlessFileQueryOwnerDepth);
      if (closingPathlessFileQueryOwnerDepth === activeNestedFileUrlParentOwnerBracketDepth) {
        activeNestedFileUrlParentOwnerBracketDepth = 0;
      }
    }
    if (closingPathlessFileQueryOwnerDepth > 0) {
      repeatedPipeHandoffWrapperDepths.delete(closingPathlessFileQueryOwnerDepth);
    }
    const fileTailBoundaryEvent =
      fileTailBracketDepth > 0 && (char === "]" || URL_END_DELIMITERS.has(char));
    if (pendingFileTailBackslash) {
      if (char === "\\") {
        if (!restartedPathlessFile) {
          file[index] = 1;
          fileTailBracketDepth = 0;
          pendingFileTailBackslash = false;
          pendingNestedUrlContinuation = false;
          continue;
        }
      } else {
        const continuesNestedUrl =
          pendingNestedUrlContinuation &&
          (char === "/" || char === ":" || char === "?" || char === "#" || char === "&");
        pendingFileTailBackslash = false;
        pendingNestedUrlContinuation = false;
        if (!fileTailBoundaryEvent && !continuesNestedUrl) fileTailBracketDepth = 0;
      }
    }
    if (
      pathlessFileQueryOwnerBracketDepth > 0 &&
      !suspendedPathlessFileQueryOwnerDepths.has(pathlessFileQueryOwnerBracketDepth) &&
      separator < 0 &&
      !pathlessNestedPublicUrlActive &&
      char === "\\" &&
      chars[index - 1] === "="
    ) {
      forcedPath[index] = 1;
      continue;
    }
    if (
      repeatedPipeHandoffWrapperDepths.has(pathlessFileQueryOwnerBracketDepth) &&
      (char === "|" || char === "&") &&
      (chars[index + 1] === "/" || chars[index + 1] === "\\")
    ) {
      forcedPath[index + 1] = 1;
    }
    if (fileTailBracketDepth > 0 && char === "[") {
      fileTailBracketDepth += 1;
    } else if (fileTailBracketDepth > 0 && char === "]") {
      fileTailBracketDepth -= 1;
      pendingFileTailBackslash = true;
      pendingNestedUrlContinuation =
        fileTailBracketDepth > 0 &&
        ((separator >= 0 && brackets > 0) || (restartedPathlessFile && restartedPathlessBrackets > 0));
    } else if (fileTailBracketDepth > 0 && URL_END_DELIMITERS.has(char)) {
      pendingFileTailBackslash = true;
      pendingNestedUrlContinuation = false;
    } else if (restartedPathlessFile && char === "[") {
      fileTailBracketDepth = 1;
    }
    if (separator >= 0 && (char === "?" || char === "#")) {
      const startsQuotedQueryTail =
        exactFileScheme &&
        foundFilePath &&
        quotedPathEndedSeparator === separator &&
        brackets === 0;

      queryOrFragment = true;
      queryOrFragmentStart = index;
      if (quotedQueryPublicUrl) quotedQueryPublicUrlOwnQueryOrFragment = true;
      if (slashPrefixedNestedPublicSchemeStart >= 0) {
        // Retain observable public URL syntax instead of reconstructing
        // provenance from a user-controlled textual redaction marker.
        nestedFileSchemeStarts[slashPrefixedNestedPublicSchemeStart] = 1;
        slashPrefixedNestedPublicSchemeStart = -1;
      }
      if (startsQuotedQueryTail) quotedQueryTail = true;
    }
    if ((quotedQueryTail || quotedQueryPublicUrl) && char === "&") {
      const privateRootPathStart = quotedQueryPublicUrl
        ? wordBearingPrivateRootPathStart(chars, index + 1)
        : -1;
      const windowsValuePathStart = quotedQueryPublicUrl
        ? wordBearingWindowsValuePathStart(chars, index + 1)
        : -1;
      if (chars[index + 1] === "/") {
        forcedPath[index + 1] = 1;
        quotedQueryTail = true;
        quotedQueryPublicUrl = false;
        quotedQueryPublicUrlOwnQueryOrFragment = false;
      } else if (privateRootPathStart >= 0 || windowsValuePathStart >= 0) {
        forcedPath[privateRootPathStart >= 0 ? privateRootPathStart : windowsValuePathStart] = 1;
        quotedQueryTail = true;
        quotedQueryPublicUrl = false;
        quotedQueryPublicUrlOwnQueryOrFragment = false;
      } else if (
        quotedQueryPublicUrl &&
        !quotedQueryPublicUrlOwnQueryOrFragment &&
        startsWordBearingSlashPath(chars, index + 1)
      ) {
        // A later word-bearing parameter resumes the surrounding quoted-file
        // query without treating named public URL parameters as private paths.
        quotedQueryTail = true;
        quotedQueryPublicUrl = false;
        quotedQueryPublicUrlOwnQueryOrFragment = false;
      }
    }
    if (
      quotedQueryTail &&
      char === "&" &&
      startsUrlSchemeLiteral(chars, index + 1) &&
      !isFileUrlLiteral(chars, index + 1)
    ) {
      // A fresh public URL ends quoted-query provenance without ending an
      // ordinary private ampersand parameter continuation.
      quotedPathEnded = false;
      quotedQueryTail = false;
      quotedPathEndedSeparator = -1;
      quotedQueryPublicUrl = true;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
    }
    const nestedFileSchemeStart = isNestedFileUrlStart(chars, index)
      ? index + 1
      : queryOrFragment &&
          !URL_SCHEME_START_PATTERN.test(char) &&
          isFileUrlLiteral(chars, index + 1)
        ? index + 1
        : -1;
    if ((separator >= 0 || restartedPathlessFile) && nestedFileSchemeStart >= 0) {
      activeNestedFileUrlParentOwnerBracketDepth = pathlessFileQueryOwnerBracketDepth;
      if (pathlessFileQueryOwnerBracketDepth > 0) {
        urlSeenInsidePathlessWrapper = true;
        suspendedPathlessFileQueryOwnerDepths.clear();
      }
      if (activeNestedFileUrlParentOwnerBracketDepth > 0) {
        nestedFileUrlParentOwnerBracketDepths.add(activeNestedFileUrlParentOwnerBracketDepth);
        restartedNestedFileUrlParentOwnerBracketDepths.delete(activeNestedFileUrlParentOwnerBracketDepth);
      }
      nestedFileSchemeStarts[nestedFileSchemeStart] = 1;
      separator = nestedFileSchemeStart + 4;
      brackets = 0;
      exactFileScheme = true;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      quotedQueryTail = false;
      restartedPathlessBrackets = 0;
      nestedPublicUrlBracketDepth = 0;
      pathlessFileQueryBracketDepth = 0;
      pathlessNestedPublicUrlActive = false;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = quoteCode(chars[nestedFileSchemeStart - 1]);
      authority[nestedFileSchemeStart + 5] = 1;
      authority[nestedFileSchemeStart + 6] = 1;
      continue;
    }
    if (
      activeNestedFileUrlParentOwnerBracketDepth > 0 &&
      exactFileScheme &&
      foundFilePath &&
      queryOrFragment &&
      (char === "/" || char === "\\") &&
      chars[index - 1] === "="
    ) {
      forcedPath[index] = 1;
      continue;
    }
    if (
      activeNestedFileUrlParentOwnerBracketDepth > 0 &&
      exactFileScheme &&
      foundFilePath &&
      // Returning to the enclosing owner is a property of the delimiter's
      // sibling role, not of the ampersand character, so a pipe returns too.
      (char === "&" || char === "|")
    ) {
      const wordBearingPrivatePathStart = queryOrFragment
        ? wordBearingPrivateRootPathStart(chars, index + 1)
        : -1;
      const returnsToParent =
        !queryOrFragment ||
        chars[index + 1] === "/" ||
        chars[index + 1] === "\\" ||
        wordBearingPrivatePathStart >= 0;
      if (returnsToParent && (chars[index + 1] === "/" || chars[index + 1] === "\\")) {
        forcedPath[index + 1] = 1;
      }
      if (wordBearingPrivatePathStart >= 0) forcedPath[wordBearingPrivatePathStart] = 1;
      if (returnsToParent) {
        separator = -1;
        exactFileScheme = false;
        foundFilePath = false;
        filePathBracketDepth = 0;
        schemeLength = 0;
        fileSchemeLength = 0;
        schemeQuote = 0;
        queryOrFragment = false;
        activeNestedFileUrlParentOwnerBracketDepth = 0;
      }
    }
    if (
      (nestedFileUrlParentOwnerBracketDepths.size > 0 ||
        closedChildGroupRootedOwnerDepths.has(pathlessFileQueryOwnerBracketDepth)) &&
      !exactFileScheme &&
      separator < 0 &&
      (char === "&" || char === "|")
    ) {
      if (chars[index + 1] === "/" || chars[index + 1] === "\\") {
        forcedPath[index + 1] = 1;
      } else if (
        nestedFileUrlParentOwnerBracketDepths.size > 0 &&
        !restartedNestedFileUrlParentOwnerBracketDepths.has(pathlessFileQueryOwnerBracketDepth)
      ) {
        // Returning from a nested file child does not make every relative
        // value private. Only an established private root re-enters the
        // enclosing file-query grammar here.
        const privateRootStart = wordBearingPrivateRootPathStart(chars, index + 1);
        if (privateRootStart >= 0) forcedPath[privateRootStart] = 1;
      }
    }
    if (restartedPathlessFile && char === "[") {
      restartedPathlessBrackets += 1;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      continue;
    }
    if (restartedPathlessFile && char === "]" && restartedPathlessBrackets > 0) {
      restartedPathlessBrackets -= 1;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      continue;
    }
    if (separator >= 0 && char === "[") {
      brackets += 1;
      continue;
    }
    if (separator >= 0 && char === "]" && brackets > 0) {
      const closesFilePathWrapper = foundFilePath && brackets === filePathBracketDepth;
      const closesUnquotedFileWrapperBeforePublicUrl =
        exactFileScheme &&
        !quotedPathEnded &&
        schemeQuote === 0 &&
        chars[index + 1] === "&" &&
        startsUrlSchemeLiteral(chars, index + 2);
      const closesNestedPublicUrl =
        exactFileScheme &&
        foundFilePath &&
        queryOrFragmentStart > separator &&
        nestedPublicUrlBracketDepth === brackets;
      brackets -= 1;
      if (closesNestedPublicUrl && (chars[index + 1] === "/" || chars[index + 1] === "\\")) {
        forcedPath[index + 1] = 1;
      }
      if (closesUnquotedFileWrapperBeforePublicUrl) {
        // The wrapper and following URL are observable syntax on every pass;
        // no textual redaction marker is trusted as provenance.
        separator = -1;
        exactFileScheme = false;
        foundFilePath = false;
        filePathBracketDepth = 0;
        schemeLength = 0;
        fileSchemeLength = 0;
        queryOrFragment = false;
      }
      if (nestedPublicUrlBracketDepth > brackets) nestedPublicUrlBracketDepth = 0;
      if (closesFilePathWrapper) {
        filePathBracketDepth = brackets;
        if (chars[index + 1] === "/" || chars[index + 1] === "\\") foundFilePath = false;
      }
      if (
        exactFileScheme &&
        !foundFilePath &&
        brackets === 0 &&
        schemeQuote !== 0 &&
        quoteCode(chars[index - 1]) === schemeQuote
      ) {
        quotedPathEnded = true;
        quotedPathEndedSeparator = separator;
        schemeQuote = 0;
      }
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
      quotedPathEnded = false;
      quotedPathEndedSeparator = -1;
      restartedPathlessBrackets = 0;
      pathlessFileQueryScopeActive = true;
      pipePathHandoffWrapperDepths.clear();
      repeatedPipeHandoffWrapperDepths.clear();
      activeNestedFileUrlParentOwnerBracketDepth = 0;
      if (pathlessFileQueryOwnerBracketDepth > 0) {
        restartedNestedFileUrlParentOwnerBracketDepths.add(pathlessFileQueryOwnerBracketDepth);
      }
      fileTailBracketDepth = 0;
      pendingFileTailBackslash = false;
      pendingNestedUrlContinuation = false;
      nestedPublicUrlBracketDepth = 0;
      pathlessFileQueryBracketDepth = 0;
      pathlessNestedPublicUrlActive = false;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      continue;
    }
    const retainedParentPrivatePathStart =
      char === "&" &&
      nestedFileUrlParentOwnerBracketDepths.has(pathlessFileQueryOwnerBracketDepth)
        ? wordBearingPrivateRootPathStart(chars, index + 1)
        : -1;
    const retainedParentNamedWindowsPathStart =
      char === "\\" &&
      chars[index - 1] === "=" &&
      nestedFileUrlParentOwnerBracketDepths.has(pathlessFileQueryOwnerBracketDepth)
        ? index
        : -1;
    if (
      pathlessFileQueryBracketDepth > 0 &&
      (((char === "&" || char === "|") &&
        (chars[index + 1] === "/" ||
          chars[index + 1] === "\\" ||
          // A drive-letter root is a path root just like / and \, so it must
          // arm the wrapper handoff rather than fall through to the URL-end
          // reset. Without this the inner path still redacts through the
          // private-root rules while the wrapper tail silently leaks.
          isWindowsDrivePathStart(chars, index + 1))) ||
        retainedParentPrivatePathStart >= 0 ||
        retainedParentNamedWindowsPathStart >= 0)
    ) {
      // A nested public URL owns its query slashes, but an immediate absolute
      // path after a delimiter returns to the enclosing file-query grammar.
      if (retainedParentPrivatePathStart >= 0) {
        forcedPath[retainedParentPrivatePathStart] = 1;
      } else if (retainedParentNamedWindowsPathStart >= 0) {
        forcedPath[retainedParentNamedWindowsPathStart] = 1;
      } else {
        forcedPath[index + 1] = 1;
      }
      if (char === "&" || retainedParentNamedWindowsPathStart >= 0) {
        separator = -1;
        exactFileScheme = false;
        foundFilePath = false;
        filePathBracketDepth = 0;
        schemeLength = 0;
        fileSchemeLength = 0;
        schemeQuote = 0;
        queryOrFragment = false;
        nestedPublicUrlBracketDepth = 0;
      } else {
        pipePathHandoffWrapperDepths.add(pathlessFileQueryOwnerBracketDepth);
        // A bracketed nested public URL, such as an IPv6 authority or a
        // bracketed path segment, does not change who owns the successors of
        // this handoff. Suppressing repeated ownership here left later rooted
        // Windows successors visible on every pass.
        repeatedPipeHandoffWrapperDepths.add(pathlessFileQueryOwnerBracketDepth);
      }
      pathlessNestedPublicUrlActive = false;
    }
    if (pathlessFileQueryBracketDepth > 0 && char === "[") {
      pathlessFileQueryBracketDepth += 1;
    } else if (pathlessFileQueryBracketDepth > 0 && char === "]") {
      pathlessFileQueryBracketDepth -= 1;
      if (pathlessFileQueryBracketDepth === 0) pathlessNestedPublicUrlActive = false;
    }
    if (
      restartedPathlessFile &&
      URL_END_DELIMITERS.has(char) &&
      !FILE_URL_AUTHORITY_DELIMITERS.has(char)
    ) {
      restartedPathlessFile = false;
      quotedQueryTail = false;
      restartedPathlessBrackets = 0;
      queryOrFragment = false;
      nestedPublicUrlBracketDepth = 0;
      pathlessFileQueryBracketDepth = 0;
      pathlessNestedPublicUrlActive = false;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
    }
    // A sibling-separating delimiter ends this bracket group's observable
    // file-query ownership, while the group's own bracket depth keeps counting
    // so its closing bracket still restores the enclosing owner. This is
    // deliberately independent of restartedPathlessFile: a generated <path>
    // marker earlier in the value ends the restarted scanner, and the Bug
    // #1332 boundary must still hold for a delimiter after it.
    //
    // Excluded: the closing bracket, which is structure rather than a sibling
    // separator; angle brackets and quotes, which wrap a value rather than
    // separating one; the file-authority delimiters "," and ";", per Bug
    // #1345; and any wrapper whose nested file URL already established
    // observable ownership, where a delimiter separates parameters instead.
    if (
      pathlessFileQueryOwnerBracketDepth > 0 &&
      URL_END_DELIMITERS.has(char) &&
      !FILE_URL_AUTHORITY_DELIMITERS.has(char) &&
      char !== "]" &&
      char !== "<" &&
      char !== ">" &&
      quoteCode(char) === 0 &&
      // A nested public URL span inside this wrapper is observable ownership
      // too, so a delimiter after it separates parameters rather than ending
      // the query.
      // Any URL seen anywhere inside this wrapper, at this depth or deeper, is
      // observable ownership, so a delimiter after it separates parameters
      // rather than ending the query. Only a wrapper of plain literal values
      // has nothing to own, which is exactly the Bug #1332 shape.
      !urlSeenInsidePathlessWrapper
    ) {
      suspendedPathlessFileQueryOwnerDepths.add(pathlessFileQueryOwnerBracketDepth);
    }
    // Conservatively keep supported punctuation and embedded double quotes in
    // an exact file URL authority until the first path separator. A matching
    // double quote still closes its quoted URL. A matching apostrophe closes
    // only before a fresh file URL literal so that separately quoted nested
    // file URLs retain their own path boundary. Once a path starts, URL-ending
    // delimiters keep their existing behavior.
    const fileAuthorityDelimiter =
      exactFileScheme &&
      !foundFilePath &&
      !quotedPathEnded &&
      (char === '"' || FILE_URL_AUTHORITY_DELIMITERS.has(char)) &&
      !(
        schemeQuote !== 0 &&
        quoteCode(char) === schemeQuote &&
        (char === '"' || isFileUrlLiteral(chars, index + 1))
      );
    const closesQuotedFilePath = foundFilePath && schemeQuote !== 0 && quoteCode(char) === schemeQuote;
    if (separator >= 0 && brackets > 0 && closesQuotedFilePath && URL_END_DELIMITERS.has(char)) {
      // The quoted path ended. Keep URL and wrapper state so an adjacent
      // separator after the wrapper still restarts a file path, but stop
      // claiming later slashes as this URL authority.
      quotedPathEnded = true;
      quotedPathEndedSeparator = separator;
      schemeQuote = 0;
      // An adjacent backslash starts a fresh path even before the wrapper closes.
      if (chars[index + 1] === "\\") foundFilePath = false;
      continue;
    }
    if (
      separator >= 0 &&
      brackets === 0 &&
      URL_END_DELIMITERS.has(char) &&
      !fileAuthorityDelimiter
    ) {
      // A closed quoted file path can hand off a root-relative Windows tail,
      // even when the preceding path contains only root separators.
      if (closesQuotedFilePath && chars[index + 1] === "\\") file[index + 1] = 1;
      // A quote that closes a nested public URL ends that URL, not the
      // enclosing pathless file query that owns it. Dropping the enclosing
      // span here left a following delimiter with no owner, so a rooted
      // successor stayed visible for quoted nested public URLs only.
      const closesQuotedNestedPublicUrl =
        pathlessFileQueryBracketDepth > 0 &&
        !exactFileScheme &&
        schemeQuote !== 0 &&
        quoteCode(char) === schemeQuote;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      separator = -1;
      exactFileScheme = false;
      foundFilePath = false;
      filePathBracketDepth = 0;
      restartedPathlessFile = false;
      quotedPathEnded = false;
      quotedQueryTail = false;
      quotedPathEndedSeparator = -1;
      restartedPathlessBrackets = 0;
      queryOrFragment = false;
      nestedPublicUrlBracketDepth = 0;
      // The closing quote always ends the nested public URL itself. Only the
      // enclosing file-query span survives, so that a following delimiter
      // still has an owner to hand off to.
      pathlessNestedPublicUrlActive = false;
      if (!closesQuotedNestedPublicUrl) {
        pathlessFileQueryBracketDepth = 0;
      }
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      continue;
    }
    if (separator >= 0) {
      if (
        exactFileScheme &&
        foundFilePath &&
        queryOrFragmentStart > separator &&
        brackets > 0 &&
        isUrlSchemeColon(chars, index, queryOrFragmentStart + 1)
      ) {
        // Preserve a public URL admitted independently inside the query. A
        // forced slash before its scheme still owns the enclosing private span.
        authority[index + 1] = 1;
        authority[index + 2] = 1;
        nestedPublicUrlBracketDepth = brackets;
      }
      if (
        quotedQueryTail &&
        brackets === 0 &&
        char === "/" &&
        isPathWord(chars[index - 1]) &&
        !startsUrlSchemeLiteral(chars, index + 1)
      ) {
        forcedPath[index] = 1;
        continue;
      }
      if (
        exactFileScheme &&
        foundFilePath &&
        queryOrFragmentStart > separator &&
        isNestedBracketPathStart(char, brackets, nestedPublicUrlBracketDepth > 0)
      ) {
        forcedPath[index] = 1;
        continue;
      }
      if (char === "/" && !quotedPathEnded) authority[index] = 1;
      if (
        exactFileScheme &&
        // After an outer path, only a backslash in its query or
        // fragment starts another file path. The delimiter must belong to
        // this URL, rather than an enclosing URL before its scheme separator.
        (!foundFilePath || (queryOrFragmentStart > separator && char === "\\")) &&
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
    if (restartedPathlessFile && isNestedBracketPathStart(char, restartedPathlessBrackets, false)) {
      forcedPath[index] = 1;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      continue;
    }
    // Preserve the former file-authority handling for the first backslash in
    // this tail without widening backslash detection in unrelated text.
    if (restartedPathlessFile && char === "\\") {
      restartedPathlessFile = false;
      restartedPathlessBrackets = 0;
      fileTailBracketDepth = 0;
      pendingFileTailBackslash = false;
      pendingNestedUrlContinuation = false;
      queryOrFragment = false;
      pathlessFileQueryBracketDepth = 0;
      pathlessNestedPublicUrlActive = false;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      file[index] = 1;
      continue;
    }
    if (char === ":" && schemeLength > 0 && pathlessFileQueryOwnerBracketDepth > 0) {
      // Any scheme colon marks this wrapper as carrying URL-like syntax, not
      // plain literal values. Single-slash and opaque schemes reach none of
      // the URL branches below, so the ownership flag is set here.
      urlSeenInsidePathlessWrapper = true;
      suspendedPathlessFileQueryOwnerDepths.clear();
    }
    if (char === ":" && schemeLength > 0 && chars[index + 1] === "/" && chars[index + 2] === "/") {
      const enclosingPathlessBracketDepth = restartedPathlessFile
        ? restartedPathlessBrackets
        : pathlessFileQueryOwnerBracketDepth;
      const nestedPublicBracketDepth =
        enclosingPathlessBracketDepth > 0 &&
        !(schemeLength === FILE_SCHEME.length && fileSchemeLength === FILE_SCHEME.length)
          ? enclosingPathlessBracketDepth
          : 0;
      const schemeStart = index - schemeLength;
      slashPrefixedNestedPublicSchemeStart =
        nestedPublicBracketDepth > 0 && forcedPath[schemeStart - 1] === 1 ? schemeStart : -1;
      restartedPathlessFile = false;
      quotedQueryTail = false;
      restartedPathlessBrackets = 0;
      queryOrFragment = false;
      separator = index;
      authority[index + 1] = 1;
      authority[index + 2] = 1;
      exactFileScheme = schemeLength === FILE_SCHEME.length && fileSchemeLength === FILE_SCHEME.length;
      if (pathlessFileQueryOwnerBracketDepth > 0) {
        // A URL appearing later in the wrapper establishes ownership for the
        // whole wrapper, so it also lifts a suspension an earlier delimiter
        // recorded while the wrapper still looked literal-only.
        urlSeenInsidePathlessWrapper = true;
        suspendedPathlessFileQueryOwnerDepths.clear();
      }
      if (exactFileScheme && pathlessFileQueryOwnerBracketDepth > 0) {
        activeNestedFileUrlParentOwnerBracketDepth = pathlessFileQueryOwnerBracketDepth;
        nestedFileUrlParentOwnerBracketDepths.add(activeNestedFileUrlParentOwnerBracketDepth);
        restartedNestedFileUrlParentOwnerBracketDepths.delete(activeNestedFileUrlParentOwnerBracketDepth);
      }
      foundFilePath = false;
      filePathBracketDepth = 0;
      pathlessFileQueryBracketDepth = nestedPublicBracketDepth;
      pathlessNestedPublicUrlActive = nestedPublicBracketDepth > 0;
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

  return { authority, file, fileQuote, forcedPath, nestedFileSchemeStarts };
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

function startsUrlSchemeLiteral(chars: readonly string[], index: number): boolean {
  if (!URL_SCHEME_START_PATTERN.test(chars[index] ?? "")) return false;
  let cursor = index + 1;
  while (URL_SCHEME_CHARACTER_PATTERN.test(chars[cursor] ?? "")) cursor += 1;
  return chars[cursor] === ":" && chars[cursor + 1] === "/" && chars[cursor + 2] === "/";
}

function isUrlSchemeColon(chars: readonly string[], index: number, lowerBound: number): boolean {
  if (chars[index] !== ":" || chars[index + 1] !== "/" || chars[index + 2] !== "/") return false;
  let start = index;
  while (start > lowerBound && URL_SCHEME_CHARACTER_PATTERN.test(chars[start - 1])) start -= 1;
  return URL_SCHEME_START_PATTERN.test(chars[start]);
}

function isSpanLocalSchemeColon(chars: readonly string[], start: number, index: number): boolean {
  if (chars[index] !== ":" || chars[index + 1] !== "/" || chars[index + 2] !== "/") return false;
  let cursor = index - 1;
  let hasSchemeLetter = false;
  while (cursor >= start && URL_SCHEME_CHARACTER_PATTERN.test(chars[cursor])) {
    if (URL_SCHEME_START_PATTERN.test(chars[cursor])) hasSchemeLetter = true;
    cursor -= 1;
  }
  return hasSchemeLetter;
}

function isNestedBracketPathStart(char: string, depth: number, insidePublicUrl: boolean): boolean {
  return char === "/" && depth > 0 && !insidePublicUrl;
}

function isDoubledDriveColonInPath(chars: readonly string[], index: number, windows: boolean): boolean {
  const boundary = chars[index - 2];
  return (
    chars[index] === ":" &&
    chars[index + 1] === ":" &&
    chars[index + 2] === "\\" &&
    /^[A-Za-z]$/u.test(chars[index - 1] ?? "") &&
    (boundary === "\\" || (windows && boundary === "/")) &&
    !startsUrlSchemeLiteral(chars, index + 3)
  );
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

function pathDriveContinuationColonIndex(chars: readonly string[], index: number): number {
  // Continuations admit an empty label or one path-word code point only.
  const colonIndex = isPathWord(chars[index + 1]) ? index + 2 : index + 1;
  if (chars[colonIndex] !== ":") return -1;
  if (chars[colonIndex + 1] !== "/" && chars[colonIndex + 1] !== "\\") return -1;
  return colonIndex;
}

function forcedSeparatorRunHasBackslash(chars: readonly string[], start: number): boolean {
  let index = start;
  let hasBackslash = false;
  while (chars[index] === "/" || chars[index] === "\\") {
    if (chars[index] === "\\") hasBackslash = true;
    index += 1;
  }
  return hasBackslash;
}

function scanAbsolutePath(
  chars: readonly string[],
  start: number,
  windows: boolean,
  driveColonIndex: number,
  allowPathDriveContinuation: boolean,
  nestedFileSchemeStarts: Uint8Array,
  quote?: string,
): { end: number; sawNonSeparator: boolean } {
  let index = start;
  let windowsContext = windows;
  let activeDriveColonIndex = driveColonIndex;
  let parentheses = 0;
  let brackets = 0;
  let sawPathCharacter = false;
  let sawNonSeparator = false;
  let singleSlashFileTail = false;
  let spanLocalUrlComponent = false;
  while (index < chars.length) {
    const char = chars[index];
    if (quote === undefined && nestedFileSchemeStarts[index] === 1) break;
    if (isPathWord(char)) {
      sawPathCharacter = true;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (index === activeDriveColonIndex && char === ":") {
      index += 1;
      continue;
    }
    if (char === ":" && chars[index + 1] === "\\" && isWindowsDrivePathStart(chars, index - 1)) {
      windowsContext = true;
      index += 1;
      continue;
    }
    if (isDoubledDriveColonInPath(chars, index, windowsContext)) {
      windowsContext = true;
      index += 2;
      continue;
    }
    const singleSlashFileUrl =
      quote === undefined &&
      char === ":" &&
      index >= start + FILE_SCHEME.length &&
      isSingleSlashFileUrlLiteral(chars, index - FILE_SCHEME.length);
    if (
      quote === undefined &&
      char === ":" &&
      index >= start + FILE_SCHEME.length &&
      isFileUrlLiteral(chars, index - FILE_SCHEME.length)
    ) {
      let cursor = index + 3;
      let authorityBrackets = 0;
      while (cursor < chars.length) {
        const authorityChar = chars[cursor];
        if (nestedFileSchemeStarts[cursor] === 1) break;
        if (authorityChar === "/" || authorityChar === "\\") break;
        if (
          authorityChar === " " ||
          authorityChar === "\t" ||
          authorityChar === "\n" ||
          authorityChar === "\r"
        ) {
          break;
        }
        if (authorityChar === "[") {
          authorityBrackets += 1;
          cursor += 1;
          continue;
        }
        if (authorityChar === "]") {
          if (authorityBrackets === 0) break;
          authorityBrackets -= 1;
          cursor += 1;
          continue;
        }
        if (authorityChar === ":" || authorityChar === "@" || isPathWord(authorityChar)) {
          cursor += 1;
          continue;
        }
        break;
      }
      sawNonSeparator = true;
      index = cursor;
      continue;
    }
    if (allowPathDriveContinuation && char === "\\") {
      const continuationColonIndex = pathDriveContinuationColonIndex(chars, index);
      if (continuationColonIndex >= 0) {
        windowsContext = true;
        activeDriveColonIndex = continuationColonIndex;
        sawPathCharacter = true;
        index += 1;
        continue;
      }
    }
    if (singleSlashFileUrl) {
      singleSlashFileTail = true;
      index += 1;
      continue;
    }
    if (singleSlashFileTail && char === ":") {
      index += 1;
      continue;
    }
    if (quote === undefined && isSpanLocalSchemeColon(chars, start, index)) {
      spanLocalUrlComponent = true;
      sawNonSeparator = true;
      index += 1;
      continue;
    }
    if (spanLocalUrlComponent && char === ":") {
      index += 1;
      continue;
    }
    if (char === "/" || (windowsContext && char === "\\")) {
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
    if (
      !windowsContext &&
      char === "\\" &&
      (isUncPathStart(chars, index) || isWindowsDrivePathStart(chars, index + 1))
    )
      break;
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
      // A bracketed non-file URL is its own span. Absorbing it here consumed
      // the URL and left its query unclassified until a second pass, which
      // broke one-pass convergence after the outward handoff. A bracketed
      // file URL is still absorbed as glue, which existing controls pin.
      if (
        quote === undefined &&
        startsUrlSchemeLiteral(chars, index + 1) &&
        !isFileUrlLiteral(chars, index + 1)
      ) {
        break;
      }
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
    const forcedPath = urlPathStarts.forcedPath[index] === 1;
    const openingQuote = chars[index] === "'" || chars[index] === '"' ? chars[index] : undefined;
    const start = fileUrl || openingQuote === undefined ? index : index + 1;
    const windowsDrive = isWindowsDrivePathStart(chars, start);
    const forcedDriveColonIndex = forcedPath ? fileUrlDriveColonIndex(chars, start) : -1;
    const forcedWindowsSeparators = forcedPath && forcedSeparatorRunHasBackslash(chars, start);
    const windows =
      fileUrl ||
      windowsDrive ||
      forcedDriveColonIndex >= 0 ||
      forcedWindowsSeparators ||
      isUncPathStart(chars, start);
    const posix = forcedPath || (!fileUrl && isPosixPathStart(chars, start, urlPathStarts.authority));
    if (!fileUrl && !windows && !posix) {
      sanitized.push(chars[index]);
      index += 1;
      continue;
    }
    const quote = fileUrl ? quoteFromCode(urlPathStarts.fileQuote[index]) : openingQuote;
    const driveColonIndex = fileUrl
      ? fileUrlDriveColonIndex(chars, start)
      : windowsDrive
        ? start + 1
        : forcedDriveColonIndex;
    const { end, sawNonSeparator } = scanAbsolutePath(
      chars,
      start,
      windows,
      driveColonIndex,
      forcedPath || fileUrl,
      urlPathStarts.nestedFileSchemeStarts,
      quote,
    );
    if (
      !forcedPath &&
      (((fileUrl || posix) && !sawNonSeparator) ||
        (!fileUrl && end <= start + (windowsDrive ? 3 : 1)))
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
