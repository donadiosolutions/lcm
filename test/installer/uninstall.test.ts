import { describe, it, expect, vi, afterEach } from "vitest";
import { removeClaudeSettings, teardownDaemonService, uninstall, type TeardownDeps } from "../../installer/uninstall.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyLaunchdPlistName, legacyLcmCommand, legacyLcmSlug, legacySystemdServiceName } from "../../src/legacy-names.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0) {
  return vi.fn().mockReturnValue({ status, stdout: "", stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(existsResult = true, overrides: Partial<TeardownDeps> = {}): TeardownDeps & {
  spawnSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
} {
  return {
    spawnSync: makeSpawn(),
    existsSync: vi.fn().mockReturnValue(existsResult),
    rmSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    ...overrides,
  };
}

// ─── removeClaudeSettings ───────────────────────────────────────────────────

describe("removeClaudeSettings", () => {
  it("fails closed for malformed settings containers", () => {
    expect(() => removeClaudeSettings({ hooks: [], mcpServers: "invalid" })).toThrow("hooks must be");
    expect(() => removeClaudeSettings({ hooks: { Stop: "invalid" } })).toThrow("hooks.Stop must be an array");
    expect(() => removeClaudeSettings({ hooks: { Stop: [{ hooks: "invalid" }] } })).toThrow("entry hooks must be an array");
    expect(() => removeClaudeSettings({ mcpServers: [] })).toThrow("mcpServers must be a JSON object");
  });

  it("preserves non-array events and entries without hook arrays", () => {
    const existing = {
      hooks: {
        InvalidEvent: "invalid",
        PreCompact: [{ matcher: "missing-hooks" }],
      },
      mcpServers: {},
    };
    expect(removeClaudeSettings(existing).hooks).toEqual(existing.hooks);
  });

  it("removes lcm hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "other" }] },
          { matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lcm restore" }] },
        ],
      },
      mcpServers: { "lcm": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
    expect(r.hooks.SessionStart).toBeUndefined();
    expect(r.mcpServers["lcm"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });

  it("removes all 4 lcm hook events", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lcm restore" }] },
        ],
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] },
        ],
      },
      mcpServers: { "lcm": {} },
    });
    expect(r.hooks).toBeUndefined();
    expect(r.mcpServers).toBeUndefined();
  });

  it("removes entry when any sub-hook matches a lcm command", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "something-else" },
              { type: "command", command: "lcm compact --hook" },
            ],
          },
        ],
      },
      mcpServers: {},
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("something-else");
  });

  it("removes pre-hook legacy compact commands", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: legacyLcmCommand("lcm compact") }] },
          { matcher: "", hooks: [{ type: "command", command: "other" }] },
        ],
      },
      mcpServers: {},
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
  });

  it("preserves unrelated primitive and metadata-bearing hook entries", () => {
    const result = removeClaudeSettings({
      hooks: {
        Stop: [
          null,
          "custom",
          { matcher: "metadata-only" },
          { label: "keep", hooks: [{ command: "lcm session-snapshot" }] },
        ],
      },
      mcpServers: { other: {} },
    });
    expect(result).toEqual({
      hooks: {
        Stop: [null, "custom", { matcher: "metadata-only" }, { label: "keep", hooks: [] }],
      },
      mcpServers: { other: {} },
    });
  });
});

// ─── teardownDaemonService ──────────────────────────────────────────────────

describe("teardownDaemonService", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("on macOS calls launchctl unload and removes plist when plist exists", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("launchctl unload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(legacyLaunchdPlistName())
    );
  });

  it("on macOS warns when plist does not exist", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("plist not found"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("on Linux calls systemctl stop, disable, daemon-reload and removes unit file", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes(`systemctl --user stop ${legacyLcmSlug()}`))).toBe(true);
    expect(cmds.some((c: string) => c.includes(`systemctl --user disable ${legacyLcmSlug()}`))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user daemon-reload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining(legacySystemdServiceName())
    );
  });

  it("on Linux warns when unit file does not exist but still runs systemctl commands", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unit file not found"));
    expect(deps.rmSync).not.toHaveBeenCalled();
    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes(`systemctl --user stop ${legacyLcmSlug()}`))).toBe(true);
    warnSpy.mockRestore();
  });

  it("on unsupported platform warns and skips", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const deps = makeDeps();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── uninstall ──────────────────────────────────────────────────────────────

describe("uninstall", () => {
  it("removes settings via deps.writeFileSync when settings.json exists", async () => {
    const writeFileMock = vi.fn();
    const deps: TeardownDeps = {
      spawnSync: makeSpawn(),
      existsSync: vi.fn().mockReturnValue(true),
      rmSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }] },
        mcpServers: { "lcm": {} },
      })),
      writeFileSync: writeFileMock,
    };
    await uninstall(deps);
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.any(String)
    );
  });

  it("stops before removing runtime assets when settings.json contains invalid JSON", async () => {
    const deps: TeardownDeps = {
      spawnSync: makeSpawn(),
      existsSync: vi.fn().mockReturnValue(true),
      rmSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue("not valid json"),
      writeFileSync: vi.fn(),
    };
    await expect(uninstall(deps)).rejects.toThrow("uninstall was stopped before removing runtime assets");
    expect(deps.rmSync).not.toHaveBeenCalled();
    expect(deps.spawnSync).not.toHaveBeenCalled();
  });

  it("stringifies non-Error settings failures", async () => {
    const deps = makeDeps(true, {
      readFileSync: vi.fn(() => { throw "plain failure"; }),
    });

    await expect(uninstall(deps)).rejects.toThrow("plain failure");
  });

  it("warns for Error and primitive CLAUDE.md cleanup failures", async () => {
    for (const failure of [new Error("claude md error"), "plain claude md error"]) {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let claudeMdReads = 0;
      const deps = makeDeps(true, {
        readFileSync: vi.fn((path: string) => {
          if (path.endsWith("settings.json")) return "{}";
          if (path.endsWith("CLAUDE.md")) {
            claudeMdReads += 1;
            throw failure;
          }
          return "";
        }),
      });
      await uninstall(deps);
      expect(claudeMdReads).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
        failure instanceof Error ? failure.message : failure,
      ));
      warnSpy.mockRestore();
    }
  });

  it("writes an empty CLAUDE.md when only the managed block remains", async () => {
    const deps = makeDeps(true, {
      readFileSync: vi.fn((path: string) => path.endsWith("CLAUDE.md")
        ? "<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->\n"
        : "{}"),
    });
    await uninstall(deps);
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("CLAUDE.md"),
      "",
    );
  });

  it("preserves content surrounding the removed CLAUDE.md block", async () => {
    const deps = makeDeps(true, {
      readFileSync: vi.fn((path: string) => path.endsWith("CLAUDE.md")
        ? "before\n<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->\n"
        : "{}"),
    });
    await uninstall(deps);
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("CLAUDE.md"),
      "before\n",
    );
  });
});

// ─── uninstall dry-run ───────────────────────────────────────────────────────

describe("uninstall with DryRunServiceDeps", () => {
  it("prints [dry-run] lines and writes no real files", async () => {
    const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(uninstall(new DryRunServiceDeps())).resolves.not.toThrow();

    const dryRunLines = logSpy.mock.calls
      .flatMap((c: any[]) => c)
      .filter((s: any) => typeof s === "string" && s.includes("[dry-run]"));

    expect(dryRunLines.length).toBeGreaterThan(0);
    // uninstall uses unload, not load — no launchctl load should appear
    expect(dryRunLines.every((l: string) => !l.includes("would run: launchctl load"))).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
