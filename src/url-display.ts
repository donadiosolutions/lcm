const ABSOLUTE_URI_VALUE_PATTERN = /^\s*[a-z][a-z\d+.-]*:\/\//i;
const PROTOCOL_RELATIVE_URL_VALUE_PATTERN = /^\s*\/\//;
const URL_KEY_SUFFIXES = [
  "url", "urls", "uri", "uris", "endpoint", "endpoints", "dsn", "connectionstring",
] as const;
const EMBEDDED_URI_PATTERN = /(^|[^a-z\d+./-])((?:[a-z][a-z\d+.-]*:)?\/\/[^\s<>"'`\])}]+)/gi;
const TRAILING_URI_PUNCTUATION_PATTERN = /[.,;!?]+$/;
const CONNECTION_SECRET_ASSIGNMENT_PATTERN = /(\b(?:password|pwd|user(?:name|\s+id)?|uid|token|api[-_\s]?key|secret)\s*=\s*)(?:\{(?:[^}]|}})*\}|"[^"]*"|'[^']*'|[^;\s,]+)/gi;

export function isUrlLikeKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return URL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Remove URL userinfo, query values, and fragments before diagnostic display. */
export function sanitizeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[REDACTED]";
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    if (url.search) url.search = "?[REDACTED]";
    if (url.hash) url.hash = "#[REDACTED]";
    return url.toString();
  } catch {
    return "[REDACTED]";
  }
}

/** Sanitize credential-bearing URIs and connection assignments embedded in arbitrary text. */
export function sanitizeEmbeddedUrlValuesForDisplay(value: string): string {
  const sanitizedUris = value.replace(EMBEDDED_URI_PATTERN, (_match, prefix: string, match: string) => {
    const trailing = match.match(TRAILING_URI_PUNCTUATION_PATTERN)?.[0] ?? "";
    const uri = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    if (!uri.startsWith("//")) {
      return `${prefix}${sanitizeUrlForDisplay(uri)}${trailing}`;
    }
    try {
      const parsed = new URL(`https:${uri}`);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        return `${prefix}${match}`;
      }
      const sanitized = sanitizeUrlForDisplay(`https:${uri}`);
      const protocolRelative = sanitized === "[REDACTED]" ? sanitized : sanitized.slice("https:".length);
      return `${prefix}${protocolRelative}${trailing}`;
    } catch {
      return `${prefix}${uri.includes("@") || /[?#]/.test(uri) ? "[REDACTED]" : uri}${trailing}`;
    }
  });
  return sanitizedUris.replace(CONNECTION_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]");
}

/** Sanitize URL values while leaving ordinary non-URL strings unchanged. */
export function sanitizeUrlValueForDisplay(value: string, key?: string): string {
  if (
    ABSOLUTE_URI_VALUE_PATTERN.test(value)
    || PROTOCOL_RELATIVE_URL_VALUE_PATTERN.test(value)
    || isUrlLikeKey(key)
  ) {
    return sanitizeUrlForDisplay(value);
  }
  return sanitizeEmbeddedUrlValuesForDisplay(value);
}
