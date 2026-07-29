import { describe, expect, it } from "vitest";
import type { SessionInstructionsScope } from "../../src/storage/contracts.js";
import {
  sessionInstructionsScopeHash,
  validateSessionInstructionsScope,
} from "../../src/storage/session-instructions.js";

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

  it("rejects lone UTF-16 surrogates in every scope field before hashing", () => {
    expect(() => validateSessionInstructionsScope({
      ...scope,
      sessionId: null,
    } as never)).toThrow("instruction-cache sessionId must be a string");

    for (const field of [
      "clientName",
      "sessionId",
      "worktreePath",
      "cwdPath",
    ] as const) {
      for (const malformed of [
        "\ud800",
        "\ud801",
        "\udc00",
        "\udc01",
      ]) {
        const candidate = {
          ...scope,
          [field]: `malformed-${malformed}`,
        } as SessionInstructionsScope;
        expect(() => validateSessionInstructionsScope(candidate))
          .toThrow(`instruction-cache ${field} contains malformed UTF-16`);
        expect(() => sessionInstructionsScopeHash(candidate))
          .toThrow(`instruction-cache ${field} contains malformed UTF-16`);
      }
    }
  });

  it("preserves valid paired supplementary code points", () => {
    const candidate = {
      ...scope,
      sessionId: "session-\ud83d\ude80",
      worktreePath: "/repo/\ud83d\ude80",
      cwdPath: "/repo/\ud83d\ude80/src",
    };
    expect(validateSessionInstructionsScope(candidate)).toBe(candidate);
    expect(sessionInstructionsScopeHash(candidate)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
