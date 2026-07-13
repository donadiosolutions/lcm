const ALWAYS_SENSITIVE_SEGMENTS = new Set([
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
]);

const TOKEN_MEASUREMENT_SEGMENTS = new Set([
  "after",
  "before",
  "budget",
  "count",
  "counts",
  "estimate",
  "estimated",
  "leaf",
  "limit",
  "max",
  "min",
  "total",
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function hasCompoundKey(segments: readonly string[], prefix: "api" | "private"): boolean {
  return segments.some((segment, index) => (
    segment === prefix && (segments[index + 1] === "key" || segments[index + 1] === "keys")
  ));
}

/** Match complete delimited/camelCase credential segments without masking token metrics. */
export function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  if (segments.some((segment) => ALWAYS_SENSITIVE_SEGMENTS.has(segment))) return true;
  if (hasCompoundKey(segments, "api") || hasCompoundKey(segments, "private")) return true;

  const tokenIndex = segments.findIndex((segment) => segment === "token" || segment === "tokens");
  if (tokenIndex < 0) return false;
  if (segments.length === 1) return true;
  return !segments.some((segment, index) => (
    index !== tokenIndex && TOKEN_MEASUREMENT_SEGMENTS.has(segment)
  ));
}
