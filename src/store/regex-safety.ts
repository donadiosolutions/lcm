import safeRegex from "safe-regex";

function validateRegexFlags(flags: string): void {
  if (!/^[dgimsuvy]*$/.test(flags)) {
    throw new Error(`Invalid regex flags: ${flags}`);
  }
  if (new Set(flags).size !== flags.length) {
    throw new Error(`Duplicate regex flags are not allowed: ${flags}`);
  }
}

function compileValidatedRegex(pattern: string, flags: string): RegExp {
  return Reflect.construct(RegExp, [pattern, flags]) as RegExp;
}

export function validateRegex(pattern: string, flags = ""): RegExp {
  validateRegexFlags(flags);

  let safe: boolean;
  try {
    safe = safeRegex(pattern);
  } catch {
    safe = false;
  }
  if (!safe) {
    throw new Error(`Unsafe regex pattern rejected (potential catastrophic backtracking): ${pattern}`);
  }

  try {
    return compileValidatedRegex(pattern, flags);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : "syntax error"}`);
  }
}
