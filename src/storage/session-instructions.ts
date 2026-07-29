import { createHash } from "node:crypto";
import type { SessionInstructionsScope } from "./contracts.js";

const SCOPE_HASH_VERSION = "lcm-session-instructions-v1";

function addLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf-8");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

/**
 * Fixed-width lookup candidate for the complete instruction-cache scope.
 *
 * Repositories always retain and compare every original field after this
 * candidate matches. A theoretical digest collision therefore fails closed
 * instead of reading or overwriting another scope.
 */
export function sessionInstructionsScopeHash(
  scope: SessionInstructionsScope,
): string {
  const hash = createHash("sha256");
  hash.update(SCOPE_HASH_VERSION);
  hash.update("\0");
  addLengthPrefixed(hash, scope.clientName);
  addLengthPrefixed(hash, scope.sessionId);
  addLengthPrefixed(hash, scope.worktreePath);
  addLengthPrefixed(hash, scope.cwdPath);
  return hash.digest("hex");
}
