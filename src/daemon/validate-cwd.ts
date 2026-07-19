import { resolve, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { sanitizeError } from "./safe-error.js";

/**
 * Normalize and validate a cwd parameter from a daemon route.
 *
 * Preserve the caller's lexical path after validation so an explicitly mapped
 * project alias remains distinguishable from the canonical directory it may
 * currently reference. Project identity resolution performs its own canonical
 * fallback for paths that are not aliases.
 */
export function validateCwd(cwd: string): string {
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(sanitizeError(`cwd does not exist: ${resolved}`));
    }
    // Sanitize all other filesystem errors (e.g. EACCES) to avoid leaking absolute paths.
    const msg = err instanceof Error ? err.message : "filesystem error";
    throw new Error(sanitizeError(msg));
  }
  return resolved;
}
