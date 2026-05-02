import safeRegex from "safe-regex";

export function validateRegex(pattern: string, flags = ""): RegExp {
  try {
    // codeql[js/regex-injection] Custom regex support intentionally accepts user regexes after syntax and safe-regex validation.
    new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : "syntax error"}`);
  }
  let safe: boolean;
  try {
    safe = safeRegex(pattern);
  } catch {
    safe = false;
  }
  if (!safe) {
    throw new Error(`Unsafe regex pattern rejected (potential catastrophic backtracking): ${pattern}`);
  }
  // codeql[js/regex-injection] Custom regex support intentionally accepts user regexes after syntax and safe-regex validation.
  return new RegExp(pattern, flags);
}
