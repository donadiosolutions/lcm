import { describe, it, expect, vi } from "vitest";
import { validateAndFixHooks, type AutoHealDeps } from "../../src/hooks/auto-heal.js";
import { canonicalHookCommand, mergeClaudeSettings } from "../../src/installer/settings.js";

function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    binaryPath: "/opt/npm/bin/lcm",
    nodePath: "/usr/bin/node",
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

  it("replaces legacy hooks with canonical native hooks", () => {
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
    expect(written.hooks.PreCompact[0].hooks[0].command).toBe(canonicalHookCommand("/opt/npm/bin/lcm", "compact --hook", "/usr/bin/node"));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(canonicalHookCommand("/opt/npm/bin/lcm", "restore", "/usr/bin/node"));
    expect(written.hooks.PostToolUse[0].hooks[0].command).toBe("other");
  });

  it("adds missing managed hooks", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
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
    expect(written.hooks.PreCompact[0].hooks[0].command).toBe(canonicalHookCommand("/opt/npm/bin/lcm", "compact --hook", "/usr/bin/node"));
    expect(written.hooks.PostToolUse[0].hooks[0].command).toBe("other");
    // mcpServers.lcm is preserved (owned by settings.json, not removed during hook cleanup)
    expect(written.mcpServers.lcm).toEqual({ command: "lcm", args: ["mcp"] });
    expect(written.mcpServers.other).toEqual({ command: "other", args: ["mcp"] });
  });

  it("repairs hooks while preserving mcpServers.lcm", () => {
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
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
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

  it("skips an already canonical hook set and logs an unresolved executable", () => {
    const canonical = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify(
        mergeClaudeSettings({}, "/opt/npm/bin/lcm", "/usr/bin/node"),
      )),
    });
    validateAndFixHooks(canonical);
    expect(canonical.writeFileSync).not.toHaveBeenCalled();

    const unresolved = makeDeps({ binaryPath: "" });
    validateAndFixHooks(unresolved);
    expect(unresolved.appendFileSync).toHaveBeenCalledWith(
      unresolved.logPath,
      expect.stringContaining("cannot resolve absolute LCM executable"),
    );
  });

  it("handles a relative process entrypoint in the default adapter", () => {
    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = "relative-lcm";
      expect(() => validateAndFixHooks()).not.toThrow();
      process.argv[1] = undefined as never;
      expect(() => validateAndFixHooks()).not.toThrow();
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("rewrites 'lcm compact' without --hook to the canonical native hook", () => {
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
    expect(precompact[0].hooks[0].command).toBe(canonicalHookCommand("/opt/npm/bin/lcm", "compact --hook", "/usr/bin/node"));
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
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.PreCompact[0].hooks[0].command).toBe("lcm compact --all");
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
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("handles missing hooks and logs non-Error failures", () => {
    const noHooks = makeDeps({ readFileSync: vi.fn().mockReturnValue("{}") });
    validateAndFixHooks(noHooks);
    expect(noHooks.writeFileSync).toHaveBeenCalledTimes(1);

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
