import { describe, it, expect, vi } from "vitest";
import { validateAndFixHooks, type AutoHealDeps } from "../../src/hooks/auto-heal.js";

function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    ...overrides,
  };
}

describe("validateAndFixHooks", () => {
  it("uses filesystem defaults safely", () => {
    expect(() => validateAndFixHooks()).not.toThrow();
  });

  it("reads settings through the default filesystem adapter", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const claudeDir = join(homedir(), ".claude");
    const settingsPath = join(claudeDir, "settings.json");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, "{}");
    expect(() => validateAndFixHooks()).not.toThrow();
    rmSync(settingsPath, { force: true });
  });

  it("removes duplicate lcm hooks from settings.json", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.PreCompact).toBeUndefined();
    expect(written.hooks.SessionStart).toBeUndefined();
    expect(written.hooks.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
  });

  it("no-ops when no managed hooks are present", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("preserves mcpServers.lcm when cleaning duplicate hooks", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
        mcpServers: {
          lcm: { command: "lcm", args: ["mcp"] },
          other: { command: "other", args: ["mcp"] },
        },
      })),
    });

    validateAndFixHooks(deps);

    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.PreCompact).toBeUndefined();
    expect(written.hooks.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
    // mcpServers.lcm is preserved (owned by settings.json, not removed during hook cleanup)
    expect(written.mcpServers.lcm).toEqual({ command: "lcm", args: ["mcp"] });
    expect(written.mcpServers.other).toEqual({ command: "other", args: ["mcp"] });
  });

  it("no-ops when only mcpServers.lcm is present without duplicate hooks", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
        mcpServers: {
          lcm: { command: "lcm", args: ["mcp"] },
        },
      })),
    });

    validateAndFixHooks(deps);

    // No duplicate hooks → no write needed (mcpServers.lcm alone doesn't trigger cleanup)
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not throw on fs errors", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
  });

  it("logs errors to auto-heal.log", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    validateAndFixHooks(deps);
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("ENOENT"),
    );
  });

  it("handles corrupt settings.json gracefully", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue("not valid json {{{"),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("auto-heal error"),
    );
  });

  it("handles missing settings.json gracefully", () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.appendFileSync).not.toHaveBeenCalled();
  });

  it("rewrites 'lcm compact' without --hook: entry is removed (matches plugin.json duplicate)", () => {
    // After rewrite: "lcm compact --hook" matches REQUIRED_HOOKS → mergeClaudeSettings removes it.
    // Result: no PreCompact entry in settings.json.
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    // "lcm compact" (without --hook) must be gone
    const precompact = written.hooks?.PreCompact ?? [];
    const hasOldCommand = precompact.some((e: any) =>
      Array.isArray(e.hooks) && e.hooks.some((h: any) => h.command === "lcm compact")
    );
    expect(hasOldCommand).toBe(false);
  });

  it("does NOT rewrite 'lcm compact --all' (user-custom variant, semantics would change)", () => {
    // After fix: only exact "lcm compact" is rewritten. Flagged variants are left unchanged.
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --all" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    // No rewrite, no duplicate → no write
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("skips malformed hook collections and commands", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          InvalidEvent: "invalid",
          PreCompact: [
            { matcher: "missing-hooks" },
            { hooks: [{ type: "prompt" }] },
          ],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("handles missing hooks and logs non-Error failures", () => {
    const noHooks = makeDeps({ readFileSync: vi.fn().mockReturnValue("{}") });
    validateAndFixHooks(noHooks);
    expect(noHooks.writeFileSync).not.toHaveBeenCalled();

    const stringFailure = makeDeps({
      readFileSync: vi.fn(() => { throw "plain failure"; }),
    });
    validateAndFixHooks(stringFailure);
    expect(stringFailure.appendFileSync).toHaveBeenCalledWith(
      stringFailure.logPath,
      expect.stringContaining("plain failure"),
    );
  });

  it("swallows a fallback logging failure", () => {
    const deps = makeDeps({
      readFileSync: vi.fn(() => { throw new Error("read failed"); }),
      mkdirSync: vi.fn(() => { throw new Error("log failed"); }),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
  });
});
