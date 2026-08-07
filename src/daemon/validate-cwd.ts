import { resolve, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { sanitizeError } from "./safe-error.js";

export class MissingCwdError extends Error {
  readonly code = "CWD_NOT_FOUND" as const;

  constructor(cwd: string) {
    super(sanitizeError(`cwd does not exist: ${cwd}`));
    this.name = "MissingCwdError";
  }
}

export function isMissingCwdError(error: unknown): error is MissingCwdError {
  return error instanceof MissingCwdError;
}

export interface ValidateCwdOptions {
  /** Accept an unavailable path after lexical validation so callers can recover queued state. */
  allowMissing?: boolean;
}

/**
 * Normalize and validate a cwd parameter from a daemon route.
 *
 * Preserve the caller's lexical path after validation so an explicitly mapped
 * project alias remains distinguishable from the canonical directory it may
 * currently reference. Project identity resolution performs its own canonical
 * fallback for paths that are not aliases.
 */
export function validateCwd(cwd: string, options: ValidateCwdOptions = {}): string {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required");
  }
  if (!isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }
  const resolved = resolve(cwd);
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("cwd must be a directory");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTDIR means an ancestor vanished into a non-directory. A leaf that
    // does exist as a regular file takes the non-missing branch above.
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (options.allowMissing) return resolved;
      throw new MissingCwdError(resolved);
    }
    // Sanitize all other filesystem errors (e.g. EACCES) to avoid leaking absolute paths.
    const msg = err instanceof Error ? err.message : "filesystem error";
    throw new Error(sanitizeError(msg));
  }
  return resolved;
}
