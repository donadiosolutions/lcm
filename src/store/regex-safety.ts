import safeRegex from "safe-regex";

export function validateRegex(pattern: string, flags = ""): RegExp {
  try {
    // Custom regex support intentionally accepts user regexes after syntax and safe-regex validation.
    // lgtm[js/regex-injection]
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
  // Custom regex support intentionally accepts user regexes after syntax and safe-regex validation.
  // lgtm[js/regex-injection]
  return new RegExp(pattern, flags);
}
