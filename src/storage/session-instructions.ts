import { createHash } from "node:crypto";
import type { SessionInstructionsScope } from "./contracts.js";

const SCOPE_HASH_VERSION = "lcm-session-instructions-v1";

export function validateSessionInstructionsScope(
  scope: SessionInstructionsScope,
): SessionInstructionsScope {
  const fields = [
    ["clientName", scope.clientName],
    ["sessionId", scope.sessionId],
    ["worktreePath", scope.worktreePath],
    ["cwdPath", scope.cwdPath],
  ] as const;
  for (const [field, value] of fields) {
    if (typeof value !== "string") {
      throw new TypeError(`instruction-cache ${field} must be a string`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const following = value.charCodeAt(index + 1);
        if (!(following >= 0xdc00 && following <= 0xdfff)) {
          throw new TypeError(
            `instruction-cache ${field} contains malformed UTF-16`,
          );
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new TypeError(
          `instruction-cache ${field} contains malformed UTF-16`,
        );
      }
    }
  }
  return scope;
}

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
  validateSessionInstructionsScope(scope);
  const hash = createHash("sha256");
  hash.update(SCOPE_HASH_VERSION);
  hash.update("\0");
  addLengthPrefixed(hash, scope.clientName);
  addLengthPrefixed(hash, scope.sessionId);
  addLengthPrefixed(hash, scope.worktreePath);
  addLengthPrefixed(hash, scope.cwdPath);
  return hash.digest("hex");
}
