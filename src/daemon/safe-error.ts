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
const IPV6_AUTHORITY_PATTERN = /^[\dA-Fa-f:.%]$/u;

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
  spacedFileTail: Uint8Array;
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

function computeWordRunEnds(chars: readonly string[]): Int32Array {
  // Every path-word run is measured once for the whole message. Without this
  // table each word-bearing question rescans the run it starts from, so a
  // single long word makes classification quadratic in the message length.
  // The table is its own bound: reading the length back keeps every index an
  // integer derived from the allocation rather than from the message, which is
  // what CodeQL's remote-property-injection query reports on this write.
  const ends = new Int32Array(chars.length + 1);
  let runEnd = ends.length - 1;
  for (let index = ends.length - 1; index >= 0; index -= 1) {
    if (!isPathWord(chars[index])) runEnd = index;
    ends[index] = runEnd;
  }
  return ends;
}

function startsWordBearingSlashPath(
  chars: readonly string[],
  index: number,
  wordRunEnds: Int32Array,
): boolean {
  if (!isPathWord(chars[index])) return false;
  const cursor = wordRunEnds[index];
  return chars[cursor] === "/" && isPathWord(chars[cursor + 1]);
}

function wordBearingPrivateRootPathStart(
  chars: readonly string[],
  index: number,
  wordRunEnds: Int32Array,
): number {
  if (!isPathWord(chars[index])) return -1;
  const cursor = wordRunEnds[index];
  if (chars[cursor] !== "/") return -1;
  const root = chars.slice(cursor + 1, cursor + 6).join("").toLowerCase();
  if (root !== "users" || (chars[cursor + 6] !== "/" && chars[cursor + 6] !== "\\")) return -1;
  return cursor;
}

function wordBearingWindowsValuePathStart(
  chars: readonly string[],
  index: number,
  wordRunEnds: Int32Array,
): number {
  if (!isPathWord(chars[index])) return -1;
  const cursor = wordRunEnds[index];
  if (chars[cursor] !== "=") return -1;
  const valueStart = cursor + 1;
  return chars[valueStart] === "\\" || isWindowsDrivePathStart(chars, valueStart) ? valueStart : -1;
}

interface BracketGroupIndex {
  groupOf: Int32Array;
  depth: Int32Array;
  urlBearingBefore: Uint8Array;
  fileChildBearing: Uint8Array;
  filePathChildBearing: Uint8Array;
  fileChildSettled: Uint8Array;
  childCloseOwner: Uint8Array;
  pathlessChildQuery: Uint8Array;
  armedHandoff: Uint8Array;
  queryBearing: Uint8Array;
  whitespace: Uint8Array;
  wordRunEnds: Int32Array;
}

function fileChildAuthorityEnd(
  chars: readonly string[],
  start: number,
  whitespace: Uint8Array,
): number {
  // Walks a nested file child's authority once and reports where it ends. The
  // caller reads the character there: "?" or "#" opens a query region the child
  // owns, "/" or "\\" means the child reached a path, and anything else means it
  // settled on neither. A malformed bracketed authority reports -1, which is
  // also neither. Reporting the position rather than only the query start is
  // what lets ownership stop depending on a "<path>" marker an earlier pass
  // wrote, because a child whose authority runs into that marker reached no
  // path and no query in either text.
  let cursor = start + FILE_SCHEME.length + 3;
  if (chars[cursor] === "[") {
    // A bracketed IPv6 authority is host syntax rather than a wrapper boundary,
    // so an address-literal child is still eligible for query-only ownership.
    const authorityStart = cursor + 1;
    cursor += 1;
    while (IPV6_AUTHORITY_PATTERN.test(chars[cursor] ?? "")) cursor += 1;
    if (cursor === authorityStart || chars[cursor] !== "]") return -1;
    cursor += 1;
  }
  while (cursor < chars.length) {
    const char = chars[cursor];
    if (
      char === "?" ||
      char === "#" ||
      char === "/" ||
      char === "\\" ||
      char === "[" ||
      char === "]" ||
      char === "|" ||
      char === "&" ||
      whitespace[cursor] === 1
    ) {
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

function startsRootedValue(chars: readonly string[], index: number, wordRunEnds: Int32Array): boolean {
  const char = chars[index];
  if (char === "/") {
    const previous = chars[index - 1];
    // A scheme separator is URL syntax rather than a rooted value, so "://"
    // never makes its wrapper look like it carries a path root.
    return previous === undefined || (!isPathWord(previous) && previous !== "/" && previous !== ":");
  }
  if (char === "\\") {
    if (isUncPathStart(chars, index) || chars[index - 1] === "=") return true;
    const root = chars.slice(index + 1, index + 6).join("").toLowerCase();
    return root === "users" && (chars[index + 6] === "/" || chars[index + 6] === "\\");
  }
  return (
    isWindowsDrivePathStart(chars, index) ||
    wordBearingPrivateRootPathStart(chars, index, wordRunEnds) >= 0
  );
}

function ownershipSchemeStart(chars: readonly string[], index: number): number {
  // A scheme colon needs a value character after it, so ordinary prose
  // punctuation is not read as a scheme.
  if (chars[index] !== ":") return -1;
  if (!isPathWord(chars[index + 1]) && chars[index + 1] !== "/") return -1;
  let start = index;
  while (start > 0 && URL_SCHEME_CHARACTER_PATTERN.test(chars[start - 1])) start -= 1;
  if (!URL_SCHEME_START_PATTERN.test(chars[start])) return -1;
  if (index - start >= 2) return start;
  // RFC 3986 allows a one-character scheme and the emit scanner accepts one,
  // so only the Windows drive form stays excluded. A drive root has a single
  // slash where a scheme authority has two, which is what separates "C:/Users"
  // from "a://host". Rejecting every one-character scheme here left the emit
  // scanner treating "a://host" as a URL while the pre-pass did not, so the
  // group never became URL-bearing and a later private value stayed in clear.
  return index - start === 1 && chars[index + 1] === "/" && chars[index + 2] === "/"
    ? start
    : -1;
}

function isOwnershipSchemeColon(chars: readonly string[], index: number): boolean {
  return ownershipSchemeStart(chars, index) >= 0;
}

function classifyBracketGroups(chars: readonly string[]): BracketGroupIndex {
  // One O(n) stack walk answers, for every bracket group, whether it contains
  // URL syntax and whether it contains a nested exact file child. Facts move
  // outward once when a group closes, so an enclosing wrapper inherits every
  // nested fact without rescanning its span per question.
  const groupOf = new Int32Array(chars.length);
  const depth = new Int32Array(chars.length);
  const childCloseOwner = new Uint8Array(chars.length);
  const pathlessChildQuery = new Uint8Array(chars.length);
  const pathlessChildQueryStarts = new Uint8Array(chars.length);
  const armedHandoff: number[] = [0];
  const queryBearing: number[] = [0];
  const whitespace = new Uint8Array(chars.length);
  // One whitespace classification per character is shared by both passes, so
  // adding the ownership pre-pass does not double the scanner's regex work.
  for (let index = 0; index < chars.length; index += 1) {
    if (WHITESPACE_PATTERN.test(chars[index])) whitespace[index] = 1;
  }
  // Word-run ends are shared the same way, so both passes answer word-bearing
  // questions in constant time instead of rescanning the run each time.
  const wordRunEnds = computeWordRunEnds(chars);
  const urlBearing: number[] = [0];
  // URL syntax is recorded per position as well as per group, because a URL
  // cannot own a sibling value that precedes it. The per-group flag still
  // carries facts outward on close; this records whether the group already
  // carried URL syntax when each position was reached.
  const urlBearingBefore = new Uint8Array(chars.length);
  const fileChildBearing: number[] = [0];
  // A child that reached a path returns ownership to every wrapper that
  // outlives it, unlike fileChildBearing, which expires with the wrapper that
  // held the child so a query-only child keeps its relative tail public.
  const filePathChildBearing: number[] = [0];
  // Whether a file child in this group reached a path or opened a query of its
  // own. A child that reached neither never settles on an ownership grammar, so
  // it cannot hand a successor back to its wrapper.
  const fileChildSettled: number[] = [0];
  const rootedBearing: number[] = [0];
  const pathlessQueryActive: number[] = [0];
  const openGroup = (): number => {
    urlBearing.push(0);
    fileChildBearing.push(0);
    filePathChildBearing.push(0);
    fileChildSettled.push(0);
    rootedBearing.push(0);
    armedHandoff.push(0);
    queryBearing.push(0);
    pathlessQueryActive.push(0);
    return urlBearing.length - 1;
  };
  let stack = [0];
  let inUrlSpan = false;
  let spanEndAdjacent = false;
  // The quote that opened the current URL span, if any. Bug #917: a space
  // inside a quoted URL belongs to that URL, so it must not end ownership here
  // either, or the two passes disagree about the shape and the first result is
  // no longer stable.
  let spanQuote = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (whitespace[index] === 1) {
      if (spanQuote !== 0 && (char === " " || char === "\t")) {
        const held = stack[stack.length - 1];
        groupOf[index] = held;
        depth[index] = stack.length - 1;
        if (urlBearing[held] === 1) urlBearingBefore[index] = 1;
        continue;
      }
      // Whitespace is a hard ownership boundary, matching the scanner reset, so
      // a later wrapper cannot inherit facts from text before the gap.
      inUrlSpan = false;
      spanQuote = 0;
      stack = [openGroup()];
      groupOf[index] = stack[0];
      depth[index] = 0;
      continue;
    }
    if (spanQuote !== 0 && quoteCode(char) === spanQuote) spanQuote = 0;
    if (char === "[") {
      const opened = openGroup();
      stack.push(opened);
      groupOf[index] = opened;
      depth[index] = stack.length - 1;
      continue;
    }
    if (char === "]" && stack.length > 1) {
      const closed = stack[stack.length - 1];
      stack.pop();
      const parent = stack[stack.length - 1];
      // URL syntax and path roots propagate outward, so an enclosing wrapper
      // still owns its tail after a child closes. File-child ownership does not:
      // it expires with the wrapper that held the child.
      if (urlBearing[closed] === 1) urlBearing[parent] = 1;
      if (rootedBearing[closed] === 1) rootedBearing[parent] = 1;
      if (filePathChildBearing[closed] === 1) filePathChildBearing[parent] = 1;
      if (fileChildSettled[closed] === 1) fileChildSettled[parent] = 1;
      // A child that carried both URL syntax and a path root hands its wrapper
      // an owned tail. A literal-only or path-less child hands over nothing.
      if (urlBearing[closed] === 1 && rootedBearing[closed] === 1) childCloseOwner[index] = 1;
      // The close belongs to the parent, so an adjacent tail reads the wrapper
      // that outlives the closed child instead of the child that just ended.
      groupOf[index] = parent;
      depth[index] = stack.length - 1;
      continue;
    }
    const current = stack[stack.length - 1];
    groupOf[index] = current;
    depth[index] = stack.length - 1;
    if (urlBearing[current] === 1) urlBearingBefore[index] = 1;
    if (pathlessChildQueryStarts[index] === 1) pathlessQueryActive[current] = 1;
    if (pathlessQueryActive[current] === 1) {
      // The region is held on the group that opened it, so a sibling wrapper
      // keeps its own ownership and the query resumes after that wrapper
      // closes. An unmatched close, a quote, or another URL element releases
      // it. Carrying the region here is what keeps the pre-pass linear.
      if (
        char === "]" ||
        quoteCode(char) !== 0 ||
        isFileUrlLiteral(chars, index) ||
        isOwnershipSchemeColon(chars, index)
      ) {
        pathlessQueryActive[current] = 0;
      } else {
        pathlessChildQuery[index] = 1;
      }
    }
    if (
      (char === "|" || char === "&") &&
      (inUrlSpan || spanEndAdjacent) &&
      startsRootedValue(chars, index + 1, wordRunEnds)
    ) {
      // The first rooted successor handed off by an ending URL span arms this
      // wrapper. Later rooted successors in the same wrapper stay owned, which
      // is why a repeated pipe does not silently leak.
      armedHandoff[current] = 1;
    }
    if (char === "?" || char === "#") queryBearing[current] = 1;
    if (URL_END_DELIMITERS.has(char) || char === "?" || char === "#") {
      // A span that ends here still owns an immediately adjacent delimiter, so
      // a quoted public URL arms its wrapper exactly like a closing bracket.
      spanEndAdjacent = inUrlSpan || spanEndAdjacent;
      inUrlSpan = false;
    } else {
      spanEndAdjacent = false;
    }
    if (isFileUrlLiteral(chars, index)) {
      urlBearing[current] = 1;
      // Only a nested child answers wrapper-ownership questions. The file URL
      // that opens the message is the wrapper itself, not a child of one.
      const previous = chars[index - 1];
      if (stack.length > 1 || (previous !== undefined && (NESTED_FILE_URL_DELIMITERS.has(previous) || previous === "|"))) {
        fileChildBearing[current] = 1;
        const authorityEnd = fileChildAuthorityEnd(chars, index, whitespace);
        const authorityStop = authorityEnd >= 0 ? chars[authorityEnd] : undefined;
        if (authorityStop === "?" || authorityStop === "#") {
          pathlessChildQueryStarts[authorityEnd] = 1;
        } else {
          filePathChildBearing[current] = 1;
        }
        // A child settles on a grammar of its own unless its authority ran
        // straight into the delimiter that hands ownership back. A malformed
        // bracketed authority reports no stop and still settles, because it is
        // not a query-only child and its wrapper keeps the tail.
        if (authorityStop !== "&" && authorityStop !== "|") fileChildSettled[current] = 1;
      }
      inUrlSpan = true;
      continue;
    }
    const schemeStart = ownershipSchemeStart(chars, index);
    if (isSingleSlashFileUrlLiteral(chars, index) || schemeStart >= 0) {
      urlBearing[current] = 1;
      // The scheme colon carries the quote for every span, including one opened
      // by a file literal, because the literal is always followed by its colon
      // before any whitespace can end the span.
      if (spanQuote === 0 && schemeStart >= 0) spanQuote = quoteCode(chars[schemeStart - 1]);
      inUrlSpan = true;
    }
    if (startsRootedValue(chars, index, wordRunEnds)) rootedBearing[current] = 1;
  }

  return {
    groupOf,
    depth,
    childCloseOwner,
    pathlessChildQuery,
    armedHandoff: Uint8Array.from(armedHandoff),
    queryBearing: Uint8Array.from(queryBearing),
    whitespace,
    wordRunEnds,
    urlBearingBefore,
    fileChildBearing: Uint8Array.from(fileChildBearing),
    filePathChildBearing: Uint8Array.from(filePathChildBearing),
    fileChildSettled: Uint8Array.from(fileChildSettled),
  };
}

function findUrlPathStarts(chars: readonly string[]): UrlPathStarts {
  const authority = new Uint8Array(chars.length);
  const file = new Uint8Array(chars.length);
  const fileQuote = new Uint8Array(chars.length);
  const forcedPath = new Uint8Array(chars.length);
  const nestedFileSchemeStarts = new Uint8Array(chars.length);
  const spacedFileTail = new Uint8Array(chars.length);
  const groups = classifyBracketGroups(chars);
  // Ownership is asked at read time rather than mutated, so no decision depends
  // on the order in which flags were written. URL syntax owns only the text
  // that follows it, so a trailing URL cannot claim an earlier sibling value.
  const ownsRootedSuccessors = (index: number): boolean =>
    groups.urlBearingBefore[index] === 1 ||
    groups.fileChildBearing[groups.groupOf[index]] === 1;
  // Facts propagate outward on close, so an enclosing group already carries
  // everything its children carried. Checking the adjacent close is therefore
  // enough to know whether an owning child just ended, however deep the run of
  // closing brackets before this delimiter is.
  const followsOwningChildClose = (index: number): boolean =>
    chars[index - 1] === "]" && groups.childCloseOwner[index - 1] === 1;
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
  let enclosingSchemeQuote = 0;
  let spacedFileTailPending = false;
  let fileTailBracketDepth = 0;
  let pendingFileTailBackslash = false;
  let pendingNestedUrlContinuation = false;
  let queryOrFragment = false;
  let queryOrFragmentStart = -1;
  let nestedPublicUrlBracketDepth = 0;
  let slashPrefixedNestedPublicSchemeStart = -1;
  let quotedQueryPublicUrl = false;
  let quotedQueryPublicUrlOwnQueryOrFragment = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (groups.whitespace[index] === 1) {
      const preservesClosedBracketHandoff =
        pendingFileTailBackslash && fileTailBracketDepth === 0 && (char === " " || char === "\t");
      // Bug #917: a space inside a quoted URL is part of that URL, so the quote
      // that bounds it outlives the gap and a later nested file tail in the same
      // quoted span still ends at the quote. A line break ends the span the same
      // way it ends every other ownership fact here.
      const preservesEnclosingSchemeQuote =
        enclosingSchemeQuote !== 0 && separator >= 0 && (char === " " || char === "\t");
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
      enclosingSchemeQuote = preservesEnclosingSchemeQuote ? enclosingSchemeQuote : 0;
      spacedFileTailPending = false;
      queryOrFragment = false;
      nestedPublicUrlBracketDepth = 0;
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
    if (enclosingSchemeQuote !== 0 && quoteCode(char) === enclosingSchemeQuote) {
      // The enclosing quote closed, so later nested file tails no longer
      // inherit it as a boundary.
      enclosingSchemeQuote = 0;
      spacedFileTailPending = false;
    }
    // Closing a child does not end its wrapper. The group index says whether the
    // child that just closed carried both URL syntax and a path root, so the
    // tail is owned by an enclosing wrapper that outlives the close.
    if (
      groups.childCloseOwner[index] === 1 &&
      (chars[index + 1] === "/" || chars[index + 1] === "\\")
    ) {
      forcedPath[index + 1] = 1;
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
    // A named Windows value belongs to its wrapper only when that wrapper
    // carries URL syntax. A literal-only wrapper, including one whose only
    // colon is a drive letter, leaves the value alone.
    if (
      char === "\\" &&
      chars[index - 1] === "=" &&
      (ownsRootedSuccessors(index) ||
        (groups.depth[index] > 0 && groups.queryBearing[groups.groupOf[index]] === 1)) &&
      (separator < 0 ||
        (!exactFileScheme && groups.fileChildBearing[groups.groupOf[index]] === 1))
    ) {
      forcedPath[index] = 1;
      continue;
    }
    // A delimiter before a rooted successor hands off inside a wrapper that
    // carries URL syntax, however many children have opened or closed first, and
    // immediately after a closed owning child even once the wrapper has ended.
    if (
      (char === "|" || char === "&") &&
      (chars[index + 1] === "/" ||
        chars[index + 1] === "\\" ||
        isWindowsDrivePathStart(chars, index + 1)) &&
      ownsRootedSuccessors(index) &&
      (groups.fileChildBearing[groups.groupOf[index]] === 1 ||
        groups.armedHandoff[groups.groupOf[index]] === 1 ||
        (separator >= 0 && groups.depth[index] > 0) ||
        followsOwningChildClose(index))
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
        ? wordBearingPrivateRootPathStart(chars, index + 1, groups.wordRunEnds)
        : -1;
      const windowsValuePathStart = quotedQueryPublicUrl
        ? wordBearingWindowsValuePathStart(chars, index + 1, groups.wordRunEnds)
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
        startsWordBearingSlashPath(chars, index + 1, groups.wordRunEnds)
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
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = quoteCode(chars[nestedFileSchemeStart - 1]);
      // Bug #917: a nested file URL with no adjacent quote of its own is still
      // bounded by the quote around the URL that contains it, so a space inside
      // its path does not end the private span.
      spacedFileTailPending = schemeQuote === 0 && enclosingSchemeQuote !== 0;
      authority[nestedFileSchemeStart + 5] = 1;
      authority[nestedFileSchemeStart + 6] = 1;
      continue;
    }
    if (
      groups.depth[index] > 0 &&
      ownsRootedSuccessors(index) &&
      exactFileScheme &&
      foundFilePath &&
      queryOrFragment &&
      (char === "/" || char === "\\") &&
      chars[index - 1] === "="
    ) {
      forcedPath[index] = 1;
      continue;
    }
    // A nested exact file child returns to its wrapper on either delimiter. A
    // query-only child has already left its span at the pathless restart, so
    // only a child that reached a path can be active here, which is what
    // separates Bug #1349 from its delimiter controls.
    if (
      groups.depth[index] > 0 &&
      ownsRootedSuccessors(index) &&
      exactFileScheme &&
      foundFilePath &&
      (char === "&" || char === "|")
    ) {
      const wordBearingPrivatePathStart = queryOrFragment
        ? wordBearingPrivateRootPathStart(chars, index + 1, groups.wordRunEnds)
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
      }
    }
    // Once a child span has closed, an established private root returns to the
    // enclosing file-query wrapper. Only a Users-rooted parameter qualifies, so
    // an ordinary relative successor is preserved on every pass.
    if (
      !exactFileScheme &&
      (char === "&" || char === "|") &&
      // A child that reached neither a path nor a query of its own never
      // settled on a grammar it could hand back, so it owns no successor.
      // Without this the scan read a "<path>" marker written by an earlier
      // pass as evidence that a path-bearing child had ended, which made the
      // classification depend on our own previous output.
      groups.fileChildSettled[groups.groupOf[index]] === 1 &&
      (groups.fileChildBearing[groups.groupOf[index]] === 1 ||
        (groups.depth[index] > 0 &&
          groups.filePathChildBearing[groups.groupOf[index]] === 1)) &&
      groups.pathlessChildQuery[index] === 0
    ) {
      const retainedPrivateRootStart = wordBearingPrivateRootPathStart(
        chars,
        index + 1,
        groups.wordRunEnds,
      );
      if (retainedPrivateRootStart >= 0) {
        forcedPath[retainedPrivateRootStart] = 1;
        // A public child that ends here returns the wrapper to its own grammar.
        separator = -1;
        foundFilePath = false;
        filePathBracketDepth = 0;
        schemeLength = 0;
        fileSchemeLength = 0;
        schemeQuote = 0;
        queryOrFragment = false;
        nestedPublicUrlBracketDepth = 0;
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
      fileTailBracketDepth = 0;
      pendingFileTailBackslash = false;
      pendingNestedUrlContinuation = false;
      nestedPublicUrlBracketDepth = 0;
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      continue;
    }
    // A nested public URL owns its query slashes, but an immediate rooted path
    // after an ampersand returns to the enclosing file-query grammar, so the
    // public span ends here instead of claiming the successor as authority.
    if (
      separator >= 0 &&
      !exactFileScheme &&
      groups.depth[index] > 0 &&
      char === "&" &&
      (chars[index + 1] === "/" ||
        chars[index + 1] === "\\" ||
        isWindowsDrivePathStart(chars, index + 1))
    ) {
      separator = -1;
      foundFilePath = false;
      filePathBracketDepth = 0;
      schemeLength = 0;
      fileSchemeLength = 0;
      schemeQuote = 0;
      queryOrFragment = false;
      nestedPublicUrlBracketDepth = 0;
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
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
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
        if (spacedFileTailPending) spacedFileTail[index] = 1;
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
      slashPrefixedNestedPublicSchemeStart = -1;
      quotedQueryPublicUrl = false;
      quotedQueryPublicUrlOwnQueryOrFragment = false;
      file[index] = 1;
      continue;
    }
    if (char === ":" && schemeLength > 0 && chars[index + 1] === "/" && chars[index + 2] === "/") {
      const enclosingPathlessBracketDepth = restartedPathlessFile
        ? restartedPathlessBrackets
        : groups.depth[index];
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
      // Bug #917: an unquoted nested scheme does not close the quote around the
      // URL that contains it, so the enclosing boundary survives until its own
      // closing delimiter. Clearing it here let a later nested file tail lose
      // the quote that still bounds it and stop at the first space. A nested
      // scheme that carries a quote of its own does not replace it either: that
      // quote bounds the nested URL through fileQuote, while the enclosing one
      // still bounds the text that follows the nested quote's close.
      if (enclosingSchemeQuote === 0) enclosingSchemeQuote = schemeQuote;
      // A file URL that arrives on a delimiter this branch handles is bounded
      // by the same enclosing quote as one reached through a query delimiter,
      // so both routes agree on whether a space can end its path.
      spacedFileTailPending = exactFileScheme && schemeQuote === 0 && enclosingSchemeQuote !== 0;
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

  return { authority, file, fileQuote, forcedPath, nestedFileSchemeStarts, spacedFileTail };
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
  stopAtBracketedUrl: boolean,
  allowInteriorSpaces: boolean,
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
      // A span this module forced from wrapper ownership stops at a bracketed
      // URL instead of swallowing it. Ordinary prose paths are never forced, so
      // an absolute path containing a bracketed URL stays one span.
      if (stopAtBracketedUrl && startsUrlSchemeLiteral(chars, index + 1)) break;
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
    const endsAtSpace = char === " " && !allowInteriorSpaces;
    if (endsAtSpace || char === "\t" || char === "\n" || char === "\r" || PATH_DELIMITERS.has(char)) break;
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
      forcedPath,
      urlPathStarts.spacedFileTail[index] === 1,
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
