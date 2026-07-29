import { describe, expect, it } from "vitest";
import type { SessionInstructionsScope } from "../../src/storage/contracts.js";
import { sessionInstructionsScopeHash } from "../../src/storage/session-instructions.js";

const scope: SessionInstructionsScope = {
  clientName: "codex",
  sessionId: "session-a",
  worktreePath: "/repo/worktree-a",
  cwdPath: "/repo/worktree-a/src",
};

describe("session instruction scope hashing", () => {
  it("binds every scope dimension into a stable lowercase SHA-256 candidate", () => {
    const hash = sessionInstructionsScopeHash(scope);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(sessionInstructionsScopeHash(scope)).toBe(hash);

    for (const changed of [
      { ...scope, clientName: "claude" as const },
      { ...scope, sessionId: "session-b" },
      { ...scope, worktreePath: "/repo/worktree-b" },
      { ...scope, cwdPath: "/repo/worktree-a/test" },
    ]) {
      expect(sessionInstructionsScopeHash(changed)).not.toBe(hash);
    }
  });

  it("uses length-prefixed fields so component boundaries cannot alias", () => {
    expect(sessionInstructionsScopeHash({
      ...scope,
      sessionId: "ab",
      worktreePath: "c",
    })).not.toBe(sessionInstructionsScopeHash({
      ...scope,
      sessionId: "a",
      worktreePath: "bc",
    }));
  });
});
