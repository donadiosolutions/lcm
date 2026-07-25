import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeClaudeSettings,
  resolveBinaryPath,
  install,
  ensureLcmMd,
  REQUIRED_HOOKS,
  parseInstalledClaudePlugins,
  migrateClaudeMarketplacePlugins,
  canonicalHookCommand,
  type ServiceDeps,
} from "../../installer/install.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyLcmCommand, legacyLcmMcpServerName } from "../../src/legacy-names.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_RETRY_POLICY, parseDaemonConfig } from "../../src/daemon/config.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0, stdout = "[]") {
  return vi.fn().mockReturnValue({ status, stdout, stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    spawnSync: makeSpawn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    promptUser: vi.fn().mockResolvedValue("1"), // default: option 1
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    runDoctor: vi.fn().mockResolvedValue([]),
    binaryPath: "/opt/npm/bin/lcm",
    ...overrides,
  };
}

// ─── mergeClaudeSettings ────────────────────────────────────────────────────

describe("mergeClaudeSettings", () => {
  const binary = "/opt/npm/bin/lcm";

  it("installs exactly six absolute native hooks", () => {
    const result = mergeClaudeSettings({}, binary);
    expect(Object.keys(result.hooks)).toHaveLength(6);
    for (const { event, command } of REQUIRED_HOOKS) {
      expect(result.hooks[event]).toEqual([{
        matcher: "",
        hooks: [{ type: "command", command: canonicalHookCommand(binary, command) }],
      }]);
    }
  });

  it("generates a Windows-safe Node plus runtime hook command", () => {
    expect(canonicalHookCommand(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@donadiosolutions\\lcm\\dist\\lcm.mjs",
      "restore",
      "C:\\Program Files\\nodejs\\node.exe",
      "win32",
    )).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" '
      + '"C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@donadiosolutions\\lcm\\dist\\lcm.mjs" restore',
    );
  });

  it("quotes platform-specific path characters and rejects a relative Node executable", () => {
    expect(canonicalHookCommand("/opt/npm/it's/lcm.mjs", "restore", "/opt/node's/bin/node"))
      .toContain("'\\''");
    expect(canonicalHookCommand(
      'C:\\npm\\"quoted"\\lcm.mjs',
      "restore",
      'C:\\node\\"quoted"\\node.exe',
      "win32",
    )).toContain('""quoted""');
    expect(() => canonicalHookCommand(binary, "restore", "node"))
      .toThrow("Node executable path must be absolute");
  });

  it("replaces legacy hooks while preserving MCP and unrelated hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        PostToolUse: [{ matcher: "custom", hooks: [{ type: "command", command: "other" }] }],
      },
      mcpServers: { lcm: { command: binary, args: ["mcp"] } },
    };
    const r = mergeClaudeSettings(existing, binary);
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PostToolUse[0].hooks[0].command).toBe("other");
    expect(r.hooks.PostToolUse).toHaveLength(2);
    expect(r.mcpServers).toEqual({ lcm: { command: binary, args: ["mcp"] } });
  });

  it("replaces stale absolute LCM hooks without removing unrelated absolute commands", () => {
    const result = mergeClaudeSettings({
      hooks: {
        PreCompact: [{
          matcher: "",
          hooks: [
            { type: "command", command: 'node "/old/plugin/lcm.mjs" compact --hook' },
            { type: "command", command: "/opt/tools/snapshot compact --hook" },
          ],
        }],
      },
    }, binary);
    expect(result.hooks.PreCompact[0].hooks).toEqual([
      { type: "command", command: "/opt/tools/snapshot compact --hook" },
    ]);
    expect(result.hooks.PreCompact[1].hooks[0].command).toBe(canonicalHookCommand(binary, "compact --hook"));
  });

  it("preserves a malformed command prefix that only shares a managed suffix", () => {
    const result = mergeClaudeSettings({
      hooks: {
        SessionStart: [{ hooks: [
          { type: "command", command: " restore" },
          { type: "command", command: '" restore' },
        ] }],
      },
    }, binary);
    expect(result.hooks.SessionStart[0].hooks[0].command).toBe(" restore");
    expect(result.hooks.SessionStart[0].hooks[1].command).toBe('" restore');
  });

  it("preserves a command when executable extraction returns no match", () => {
    const result = mergeClaudeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: '" restore' }] }],
      },
    }, binary);
    expect(result.hooks.SessionStart[0].hooks[0].command).toBe('" restore');
  });

  it("recognizes escaped Windows-style absolute LCM hook paths", () => {
    const result = mergeClaudeSettings({
      hooks: {
        SessionStart: [{
          hooks: [{ type: "command", command: '"C:\\\\npm\\\\lcm" restore' }],
        }],
      },
    }, binary);
    expect(result.hooks.SessionStart).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: canonicalHookCommand(binary, "restore") }],
    }]);
  });

  it("REQUIRED_HOOKS contains exactly 6 expected events", () => {
    expect(REQUIRED_HOOKS.map(h => h.event).sort()).toEqual([
      "PostToolUse", "PreCompact", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("removes legacy MCP and is idempotent", () => {
    const legacyServerName = legacyLcmMcpServerName();
    const existing = {
      mcpServers: { [legacyServerName]: {}, other: {} },
    };
    const result = mergeClaudeSettings(existing, binary);
    expect(result.mcpServers[legacyServerName]).toBeUndefined();
    expect(mergeClaudeSettings(result, binary)).toEqual(result);
  });

  it("fails closed for malformed settings and non-absolute paths", () => {
    expect(() => mergeClaudeSettings({ hooks: [] }, binary)).toThrow("hooks must be");
    expect(() => mergeClaudeSettings({}, "lcm")).toThrow("must be absolute");
    expect(() => mergeClaudeSettings({ hooks: { Stop: "invalid" } }, binary)).toThrow("hooks.Stop must be an array");
    expect(() => mergeClaudeSettings({ hooks: { Stop: [{ hooks: "invalid" }] } }, binary)).toThrow("entry hooks must be an array");
    expect(() => mergeClaudeSettings({ mcpServers: [] }, binary)).toThrow("mcpServers must be a JSON object");
  });

  it("preserves custom and malformed unrelated hook entries", () => {
    const result = mergeClaudeSettings({
      hooks: {
        Stop: [
          null,
          "custom",
          { matcher: "metadata-only" },
          { matcher: "", label: "keep", hooks: [{ command: "lcm session-snapshot" }] },
        ],
      },
    }, binary);
    expect(result.hooks.Stop.slice(0, 4)).toEqual([
      null,
      "custom",
      { matcher: "metadata-only" },
      { matcher: "", label: "keep", hooks: [] },
    ]);
  });
});

// ─── resolveBinaryPath ──────────────────────────────────────────────────────

describe("resolveBinaryPath", () => {
  it("returns path from which when available", () => {
    const spawnMock = makeSpawn(0, "/usr/local/bin/lcm\n");
    const deps = {
      spawnSync: spawnMock,
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("/usr/local/bin/lcm");
    expect(spawnMock).toHaveBeenCalledWith("sh", ["-c", "command -v lcm"], expect.anything());
  });

  it("falls back to ~/.npm-global/bin when which fails", () => {
    const npmGlobal = join(homedir(), ".npm-global", "bin", "lcm");
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockImplementation((p: string) => p === npmGlobal),
    };
    expect(resolveBinaryPath(deps)).toBe(npmGlobal);
  });

  it("returns bare binary name when nothing found", () => {
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("lcm");
  });

  it("ignores non-string and blank command output before checking all fallbacks", () => {
    expect(resolveBinaryPath({ spawnSync: makeSpawn(0, "   "), existsSync: vi.fn().mockReturnValue(false) })).toBe("lcm");
    expect(resolveBinaryPath({
      spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from("/bin/lcm") }),
      existsSync: vi.fn().mockImplementation((path: string) => path === "/opt/homebrew/bin/lcm"),
    })).toBe("/opt/homebrew/bin/lcm");
  });
});

describe("Claude Marketplace migration", () => {
  it("ignores only a missing Claude executable and blocks other list failures", () => {
    const missing = vi.fn().mockReturnValue({
      status: null,
      stdout: "",
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    expect(() => migrateClaudeMarketplacePlugins({ spawnSync: missing as any }, "/work")).not.toThrow();

    const failed = vi.fn().mockReturnValue({ status: 2, stdout: "", stderr: "broken" });
    expect(() => migrateClaudeMarketplacePlugins({ spawnSync: failed as any }, "/work"))
      .toThrow("Could not list installed Claude plugins");
  });

  it("does not query marketplaces when no possible LCM plugin is installed", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([null, [], {}, { id: 42 }, { id: "other@marketplace" }]),
    });
    migrateClaudeMarketplacePlugins({ spawnSync: spawnSync as any }, "/work");
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("blocks an unverified LCM marketplace and supports an unqualified verified id", () => {
    const unverified = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ id: "lcm@unknown" }]) })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ name: "unknown", repo: "someone/lcm" }]) });
    expect(() => migrateClaudeMarketplacePlugins({ spawnSync: unverified as any }, "/work"))
      .toThrow("could not be verified");
    expect(unverified).toHaveBeenCalledTimes(2);

    const verified = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ id: "lcm", repository: "donadiosolutions/lcm" }]) })
      .mockReturnValueOnce({ status: 0, stdout: "[]" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]" });
    migrateClaudeMarketplacePlugins({ spawnSync: verified as any }, "/work");
    expect(verified).toHaveBeenCalledTimes(4);
  });

  it("parses only allowlisted repositories with scope and cwd", () => {
    const plugins = JSON.stringify([
      { id: "lcm@current", scope: "user" },
      { id: "lcm@legacy", scope: "project", projectPath: "/work/p" },
      { id: "lcm@unrelated", scope: "user", installPath: "/tmp/lossless-claude/lcm" },
      { id: "other@current", scope: "user" },
    ]);
    const marketplaces = JSON.stringify([
      { name: "current", source: "github", repo: "donadiosolutions/lcm" },
      { name: "legacy", source: "github", repo: "lossless-claude/lcm" },
      { name: "unrelated", source: "github", repo: "someone/lcm" },
    ]);
    expect(parseInstalledClaudePlugins(plugins, marketplaces)).toEqual([
      { identifier: "lcm@current", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@legacy", repository: "lossless-claude/lcm", scope: "project", cwd: "/work/p" },
    ]);
  });

  it("uninstalls recognized plugins in scope and re-queries", () => {
    const plugin = JSON.stringify([{ id: "lcm@current", scope: "local", projectPath: "/work/p" }]);
    const marketplaces = JSON.stringify([{ name: "current", source: "github", repo: "donadiosolutions/lcm" }]);
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: plugin })
      .mockReturnValueOnce({ status: 0, stdout: marketplaces })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]" });
    migrateClaudeMarketplacePlugins({ spawnSync: spawnSync as any }, "/work/default");
    expect(spawnSync).toHaveBeenNthCalledWith(3, "claude", [
      "plugin", "uninstall", "lcm@current",
      "--scope", "local", "--yes", "--keep-data",
    ], expect.objectContaining({ cwd: "/work/p" }));
    expect(spawnSync).toHaveBeenCalledTimes(4);
  });

  it("fails closed on malformed output, uninstall failure, and a remaining plugin", () => {
    expect(() => parseInstalledClaudePlugins("{")).toThrow("malformed JSON");
    expect(() => parseInstalledClaudePlugins("{}")).toThrow("unsupported shape");
    const plugin = JSON.stringify([{ id: "lcm@legacy", scope: "user" }]);
    const marketplaces = JSON.stringify([{ name: "legacy", source: "github", repo: "lossless-claude/lcm" }]);
    expect(() => migrateClaudeMarketplacePlugins({
      spawnSync: vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: plugin })
        .mockReturnValueOnce({ status: 0, stdout: marketplaces })
        .mockReturnValueOnce({ status: 1, stdout: "" }) as any,
    }, "/work")).toThrow("Could not uninstall");
    expect(() => migrateClaudeMarketplacePlugins({
      spawnSync: vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: plugin })
        .mockReturnValueOnce({ status: 0, stdout: marketplaces })
        .mockReturnValueOnce({ status: 0, stdout: "" })
        .mockReturnValueOnce({ status: 0, stdout: plugin }) as any,
    }, "/work")).toThrow("remains installed");
    expect(() => migrateClaudeMarketplacePlugins({
      spawnSync: vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: plugin })
        .mockReturnValueOnce({ status: 0, stdout: marketplaces })
        .mockReturnValueOnce({ status: 0, stdout: "" })
        .mockReturnValueOnce({
          status: 0,
          stdout: JSON.stringify([{ id: "lcm@unknown", repository: "someone/lcm" }]),
        }) as any,
    }, "/work")).toThrow("Claude Marketplace plugin remains installed: lcm@unknown");
    expect(() => migrateClaudeMarketplacePlugins({
      spawnSync: vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: plugin })
        .mockReturnValueOnce({ status: 1, stdout: "" }) as any,
    }, "/work")).toThrow("Could not verify configured");
  });

  it("covers explicit repository shapes, default scope, cwd, and unsupported scopes", () => {
    expect(parseInstalledClaudePlugins(JSON.stringify([
      { id: "lcm", repository: "github:donadiosolutions/lcm", cwd: "/cwd" },
      { id: "lcm@x", repo: "https://github.com/lossless-claude/lcm.git" },
      { id: "lcm@y", source: { repo: "git@github.com:donadiosolutions/lcm.git" } },
      { id: "lcm@z", source: { repo: 42 } },
      { id: "lcm@direct", source: "github:donadiosolutions/lcm" },
      { id: "lcm@missing" },
      { id: "lcm" },
      { id: 1 },
      null,
      [],
    ]))).toEqual([
      { identifier: "lcm", repository: "donadiosolutions/lcm", scope: "user", cwd: "/cwd" },
      { identifier: "lcm@x", repository: "lossless-claude/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@y", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@direct", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
    ]);
    expect(() => parseInstalledClaudePlugins(JSON.stringify([
      { id: "lcm@x", repository: "donadiosolutions/lcm", scope: "workspace" },
    ]))).toThrow("unsupported scope");
    expect(() => parseInstalledClaudePlugins("[]", "{}")).toThrow("marketplace list returned an unsupported shape");
    expect(parseInstalledClaudePlugins("[]", JSON.stringify([
      null, [], {}, { name: "missing-repo" }, { repo: "missing-name" },
      { name: "other", repo: "someone/else" },
    ]))).toEqual([]);
  });

  it("rejects a failed post-uninstall plugin query", () => {
    const plugin = JSON.stringify([{ id: "lcm@legacy", scope: "user" }]);
    const marketplaces = JSON.stringify([{ name: "legacy", repo: "lossless-claude/lcm" }]);
    expect(() => migrateClaudeMarketplacePlugins({
      spawnSync: vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: plugin })
        .mockReturnValueOnce({ status: 0, stdout: marketplaces })
        .mockReturnValueOnce({ status: 0, stdout: "" })
        .mockReturnValueOnce({ status: 1, stdout: "" }) as any,
    }, "/work")).toThrow("Could not verify Claude Marketplace plugin removal");
  });
});

// ─── install ────────────────────────────────────────────────────────────────

describe("install", () => {
  it("core install works with zero external dependencies", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(install(deps)).resolves.not.toThrow();
    // No setup.sh, no cipher, no qdrant
    const bashCalls = (deps.spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === "bash");
    expect(bashCalls).toHaveLength(0);
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("writes config.json with provider=auto and empty apiKey in non-TTY mode", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const writeFileMock = vi.fn();
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false), writeFileSync: writeFileMock });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configWriteCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configWriteCall).toBeDefined();
    const written = JSON.parse(configWriteCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBe("");
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("calls chmodSync(0o600) on config.json after creation", async () => {
    const chmodSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      chmodSync,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    expect(chmodSync).toHaveBeenCalledWith(
      expect.stringContaining("config.json"),
      0o600,
    );
  });

  it("rejects stale config symlink leaves before reading or writing them", async () => {
    const deps = makeDeps({
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => true, isFile: () => false }) as never),
    });

    await expect(install(deps)).rejects.toThrow("symlink config path");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects non-regular config leaves before reading or writing them", async () => {
    const deps = makeDeps({
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isFile: () => false }) as never),
    });

    await expect(install(deps)).rejects.toThrow("not a regular file");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("uses the atomic private writer when creating the production config", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const atomicWritePrivateFile = vi.fn();
    const deps = makeDeps({
      lstatSync: vi.fn(() => { throw missing; }),
      atomicWritePrivateFile,
    });

    await install(deps);

    expect(atomicWritePrivateFile).toHaveBeenCalledWith(
      expect.stringContaining("config.json"),
      expect.stringContaining('"provider": "auto"'),
    );
  });

  it("accepts an existing regular config leaf", async () => {
    const atomicWritePrivateFile = vi.fn();
    const deps = makeDeps({
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isFile: () => true }) as never),
      existsSync: vi.fn((path: string) => path.endsWith("config.json")),
      atomicWritePrivateFile,
    });

    await expect(install(deps)).resolves.not.toThrow();
    expect(atomicWritePrivateFile).not.toHaveBeenCalled();
  });

  it("fails installation when the LCM data root cannot be secured", async () => {
    const deps = makeDeps({
      chmodSync: vi.fn(() => { throw new Error("chmod failed"); }),
    });

    await expect(install(deps)).rejects.toThrow("chmod failed");
    expect(deps.runDoctor).not.toHaveBeenCalled();
  });

  it("fails before mutation for a relative executable or malformed Claude settings", async () => {
    const relative = makeDeps({ binaryPath: "lcm" });
    await expect(install(relative)).rejects.toThrow("absolute npm-installed");
    expect(relative.runDoctor).not.toHaveBeenCalled();

    const settingsPath = join(homedir(), ".claude", "settings.json");
    const malformed = makeDeps({
      existsSync: vi.fn((path: string) => path === settingsPath),
      readFileSync: vi.fn((path: string) => path === settingsPath ? "{" : "{}"),
    });
    await expect(install(malformed)).rejects.toThrow("Refusing to modify malformed Claude settings");
    expect(malformed.runDoctor).not.toHaveBeenCalled();
  });

  it("ignores config chmod failures and reports doctor failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      chmodSync: vi.fn((path) => {
        if (String(path).endsWith("config.json")) throw new Error("chmod failed");
      }),
      runDoctor: vi.fn().mockResolvedValue([{ name: "daemon", status: "fail" }]),
    });
    await install(deps);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("1 check(s) failed"));
    errorSpy.mockRestore();
  });

  it("copies only markdown commands and installs the native MCP settings", async () => {
    const rmSync = vi.fn();
    const copyFileSync = vi.fn();
    const readdirSync = vi.fn((path: string, options?: { withFileTypes?: boolean }) => {
      if (options?.withFileTypes) {
        return [
          { name: "1.3.0", isDirectory: () => true },
          { name: "1.4.0", isDirectory: () => true },
          { name: "README", isDirectory: () => false },
        ];
      }
      return ["one.md", "ignore.txt", "two.md"];
    });
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settingsReads = 0;
    const deps = makeDeps({
      existsSync: vi.fn((path: string) =>
        path.endsWith("config.json")
        || path === "/templates/commands"
        || path === "/templates/skills"
        || path === settingsPath),
      readFileSync: vi.fn((path: string) => {
        if (path.endsWith("package.json")) return JSON.stringify({ version: "1.4.0" });
        if (path === settingsPath) return settingsReads++ === 0 ? "{}" : "null";
        return "{}";
      }),
      readdirSync: readdirSync as any,
      rmSync: rmSync as any,
      copyFileSync: copyFileSync as any,
      commandsSourceDir: "/templates/commands",
      skillSourceDir: "/templates/skills",
    });

    await install(deps);
    expect(rmSync).not.toHaveBeenCalled();
    expect(copyFileSync).toHaveBeenCalledTimes(4);
    const settingsWrite = vi.mocked(deps.writeFileSync).mock.calls.filter(([path]) => path === settingsPath).at(-1);
    expect(JSON.parse(settingsWrite![1]).mcpServers.lcm).toBeDefined();
  });

  it("preserves a valid MCP server map", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || path.includes("plugins/cache") || path === settingsPath),
      readFileSync: vi.fn((path: string) => path === settingsPath
        ? JSON.stringify({ mcpServers: { other: { command: "other" } } })
        : "invalid package json"),
    });
    await install(deps);
    const settingsWrite = vi.mocked(deps.writeFileSync).mock.calls.filter(([path]) => path === settingsPath).at(-1);
    expect(JSON.parse(settingsWrite![1]).mcpServers.other).toBeDefined();
  });

  it("uses default filesystem operations for cache cleanup and command copies", async () => {
    const fs = await import("node:fs");
    const { legacyLcmSlug } = await import("../../src/legacy-names.js");
    const home = homedir();
    const lcmDir = join(home, ".lcm");
    const cacheDir = join(home, ".claude", "plugins", "cache", legacyLcmSlug(), "lcm");
    const claudeDir = join(home, ".claude");
    const commandsDestDir = join(claudeDir, "commands");
    const commandsSourceDir = fs.mkdtempSync(join(home, "commands-source-"));
    try {
      fs.mkdirSync(lcmDir, { recursive: true });
      fs.writeFileSync(join(lcmDir, "config.json"), "{}");
      fs.mkdirSync(join(cacheDir, "1.3.0"), { recursive: true });
      fs.mkdirSync(join(cacheDir, "1.4.0"), { recursive: true });
      fs.writeFileSync(join(commandsSourceDir, "command.md"), "command");
      fs.writeFileSync(join(commandsSourceDir, "ignore.txt"), "ignore");

      const deps: ServiceDeps = {
        spawnSync: vi.fn().mockReturnValue({
          status: null,
          stdout: "",
          error: Object.assign(new Error("missing"), { code: "ENOENT" }),
        }) as ServiceDeps["spawnSync"],
        readFileSync: (path, encoding) => path.endsWith("package.json")
          ? JSON.stringify({ version: "1.4.0" })
          : fs.readFileSync(path, encoding as BufferEncoding) as string,
        writeFileSync: (path, data) => fs.writeFileSync(path, data),
        mkdirSync: fs.mkdirSync,
        existsSync: fs.existsSync,
        promptUser: vi.fn(),
        ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
        runDoctor: vi.fn().mockResolvedValue([]),
        commandsSourceDir,
        binaryPath: "/opt/npm/bin/lcm",
      };

      await install(deps);
      expect(fs.existsSync(join(cacheDir, "1.3.0"))).toBe(true);
      expect(fs.existsSync(join(cacheDir, "1.4.0"))).toBe(true);
      expect(fs.readFileSync(join(commandsDestDir, "command.md"), "utf-8")).toBe("command");
      await install(deps);
    } finally {
      fs.rmSync(lcmDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(commandsDestDir, { recursive: true, force: true });
      for (const file of ["settings.json", "lcm.md", "CLAUDE.md"]) {
        fs.rmSync(join(claudeDir, file), { force: true });
      }
      fs.rmSync(commandsSourceDir, { recursive: true, force: true });
    }
  });
});

// ─── install dry-run ─────────────────────────────────────────────────────────

describe("install with DryRunServiceDeps", () => {
  it("prints [dry-run] lines and writes no real files", async () => {
    const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(install(new DryRunServiceDeps())).resolves.not.toThrow();

    const dryRunLines = logSpy.mock.calls
      .flatMap((c: any[]) => c)
      .filter((s: any) => typeof s === "string" && s.includes("[dry-run]"));

    expect(dryRunLines.some((l: string) => l.includes("would write:"))).toBe(true);
    expect(dryRunLines.some((l: string) => l.includes("settings.json"))).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ─── summarizer picker ───────────────────────────────────────────────────────

describe("summarizer picker", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, writable: true });
  });

  it("option 1 (native CLI default): writes provider=auto to config.json", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn().mockResolvedValueOnce("1"),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBeFalsy();
  });

  it("option 2 (Anthropic API): writes provider=anthropic and apiKey literal to config.json", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn().mockResolvedValueOnce("2"),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("anthropic");
    expect(written.llm.apiKey).toBe("${ANTHROPIC_API_KEY}");
    expect(written.llm.model).toBe("claude-haiku-4-5-20251001");
    expect(written.llm).not.toHaveProperty("requestTimeoutMs");
    expect(written.llm).not.toHaveProperty("retry");

    const effective = parseDaemonConfig(configCall![1], {}, { ANTHROPIC_API_KEY: "sk-test" });
    expect(effective.llm.provider).toBe("anthropic");
    expect(effective.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(effective.llm.retry).toEqual(DEFAULT_LLM_RETRY_POLICY);
  });

  it("option 2 leaves the key empty when the environment variable is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      promptUser: vi.fn().mockResolvedValue("2"),
    });
    await install(deps);
    const configCall = vi.mocked(deps.writeFileSync).mock.calls.find(([path]) => path.endsWith("config.json"));
    expect(JSON.parse(configCall![1]).llm.apiKey).toBe("");
  });

  it("option 3 (custom server): prompts for URL and model, writes provider=openai", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn()
        .mockResolvedValueOnce("3")                           // picker: option 3
        .mockResolvedValueOnce("http://192.168.1.5:8080/v1") // URL prompt
        .mockResolvedValueOnce("my-model"),                   // model prompt
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("openai");
    expect(written.llm.baseUrl).toBe("http://192.168.1.5:8080/v1");
    expect(written.llm.baseURL).toBeUndefined();
    expect(written.llm.model).toBe("my-model");
    expect(written.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(written.llm.retry).toEqual(DEFAULT_LLM_RETRY_POLICY);
  });

  it("option 3 retries each empty required value once before accepting it", async (): Promise<void> => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      promptUser: vi.fn()
        .mockResolvedValueOnce("3")
        .mockResolvedValueOnce("   ")
        .mockResolvedValueOnce("http://localhost:8080/v1")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("local-model"),
    });

    await install(deps);

    const configCall = vi.mocked(deps.writeFileSync).mock.calls.find(([path]) => path.endsWith("config.json"));
    expect(JSON.parse(configCall![1]).llm).toMatchObject({
      provider: "openai",
      baseUrl: "http://localhost:8080/v1",
      model: "local-model",
    });
    expect(deps.promptUser).toHaveBeenCalledTimes(5);
  });

  it("option 3 falls back atomically to auto after two empty server URLs", async (): Promise<void> => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      promptUser: vi.fn()
        .mockResolvedValueOnce("3")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("   "),
    });

    await install(deps);

    const configCall = vi.mocked(deps.writeFileSync).mock.calls.find(([path]) => path.endsWith("config.json"));
    expect(JSON.parse(configCall![1]).llm).toMatchObject({
      provider: "auto",
      baseUrl: "",
      model: "",
    });
    expect(deps.promptUser).toHaveBeenCalledTimes(3);
  });

  it("option 3 discards a valid URL when two model attempts are empty", async (): Promise<void> => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      promptUser: vi.fn()
        .mockResolvedValueOnce("3")
        .mockResolvedValueOnce("http://localhost:8080/v1")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("   "),
    });

    await install(deps);

    const configCall = vi.mocked(deps.writeFileSync).mock.calls.find(([path]) => path.endsWith("config.json"));
    expect(JSON.parse(configCall![1]).llm).toMatchObject({
      provider: "auto",
      baseUrl: "",
      model: "",
    });
    expect(deps.promptUser).toHaveBeenCalledTimes(4);
  });

  it("invalid input re-prompts once then defaults to option 1 (auto)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn()
        .mockResolvedValueOnce("9")   // invalid
        .mockResolvedValueOnce("9"),  // invalid again → default to 1
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
  });

  it("non-TTY (process.stdin.isTTY is false): skips picker and defaults to auto", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });
    const writeFileMock = vi.fn();
    const promptUserMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: promptUserMock,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    expect(promptUserMock).not.toHaveBeenCalled(); // picker was skipped
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBe("");
  });
});

// ─── MCP registration ────────────────────────────────────────────────────────

describe("install — MCP registration", () => {
  it("writes mcpServers.lcm to settings.json", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let written = "";
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
        if (path === settingsPath) written = data;
      }),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();

    const settings = JSON.parse(written);
    expect(settings.mcpServers?.lcm).toBeDefined();
    expect(settings.mcpServers.lcm.args).toContain("mcp");
    expect(typeof settings.mcpServers.lcm.command).toBe("string");
    expect(settings.mcpServers.lcm.command.length).toBeGreaterThan(0);
  });
});

// ─── ensureLcmMd ────────────────────────────────────────────────────────────

describe("ensureLcmMd", () => {
  const CONTENT = "# lcm test content\n";
  const BLOCK = `<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->`;

  function makeDepsForLcm(claudeMdContent?: string) {
    const files = new Map<string, string>();
    if (claudeMdContent !== undefined) {
      files.set("/home/.claude/CLAUDE.md", claudeMdContent);
    }
    const written = new Map<string, string>();
    return {
      deps: {
        existsSync: (p: string) => files.has(p),
        readFileSync: (p: string) => files.get(p) ?? "",
        writeFileSync: (p: string, content: string) => { written.set(p, content); files.set(p, content); },
        mkdirSync: vi.fn(),
      },
      written,
    };
  }

  it("writes lcm.md and creates CLAUDE.md with managed block when neither exists", () => {
    const { deps, written } = makeDepsForLcm();
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.lcmMdWritten).toBe(true);
    expect(result.claudeMdPatched).toBe(true);
    expect(written.get("/home/.claude/lcm.md")).toBe(CONTENT);
    expect(written.get("/home/.claude/CLAUDE.md")).toContain(BLOCK);
  });

  it("appends managed block when CLAUDE.md exists without it", () => {
    const { deps, written } = makeDepsForLcm("@RTK.md\n");
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.claudeMdPatched).toBe(true);
    const claudeMd = written.get("/home/.claude/CLAUDE.md")!;
    expect(claudeMd).toContain("@RTK.md");
    expect(claudeMd).toContain(BLOCK);
  });

  it("scans whitespace-heavy CLAUDE.md content without a backtracking regex", () => {
    const existing = " ".repeat(100_000) + "not a marker\n";
    const { deps, written } = makeDepsForLcm(existing);
    expect(ensureLcmMd(deps, CONTENT, "/home").claudeMdPatched).toBe(true);
    expect(written.get("/home/.claude/CLAUDE.md")).toContain(BLOCK);
  });

  it("handles marker and non-marker files without trailing newlines", () => {
    const noMarker = makeDepsForLcm("single line");
    expect(ensureLcmMd(noMarker.deps, CONTENT, "/home").claudeMdPatched).toBe(true);

    const markerAtEof = makeDepsForLcm(
      "before\n<!-- lcm:start -->\n@old.md\n<!-- lcm:end -->",
    );
    expect(ensureLcmMd(markerAtEof.deps, CONTENT, "/home").claudeMdPatched).toBe(true);
    expect(markerAtEof.written.get("/home/.claude/CLAUDE.md")).toContain(BLOCK);
  });

  it("does not rewrite CLAUDE.md when managed block is already correct", () => {
    const existing = `@RTK.md\n<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n@other.md\n`;
    const { deps, written } = makeDepsForLcm(existing);
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.claudeMdPatched).toBe(false);
    expect(written.has("/home/.claude/CLAUDE.md")).toBe(false); // no write needed
  });

  it("updates managed block when its content changes", () => {
    const existing = `@RTK.md\n<!-- lcm:start -->\n@old.md\n<!-- lcm:end -->\n@other.md\n`;
    const { deps, written } = makeDepsForLcm(existing);
    const result = ensureLcmMd(deps, CONTENT, "/home");
    const claudeMd = written.get("/home/.claude/CLAUDE.md")!;
    expect(result.claudeMdPatched).toBe(true);
    expect(claudeMd).toContain("@RTK.md");
    expect(claudeMd).toContain("@other.md");
    expect(claudeMd).toContain(BLOCK);
    expect(claudeMd.indexOf("<!-- lcm:start -->")).toBe(claudeMd.lastIndexOf("<!-- lcm:start -->")); // only one block
  });

  it("overwrites lcm.md when content is stale", () => {
    const files = new Map<string, string>();
    files.set("/home/.claude/lcm.md", "# old content\n");
    const written = new Map<string, string>();
    const deps = {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => files.get(p) ?? "",
      writeFileSync: (p: string, content: string) => { written.set(p, content); files.set(p, content); },
      mkdirSync: vi.fn(),
    };
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.lcmMdWritten).toBe(true);
    expect(written.get("/home/.claude/lcm.md")).toBe(CONTENT);
  });

  it("overwrites unreadable lcm.md and appends after unreadable CLAUDE.md", () => {
    const writeFileSync = vi.fn();
    const deps = {
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn(() => { throw new Error("unreadable"); }),
      writeFileSync,
      mkdirSync: vi.fn(),
    };
    expect(ensureLcmMd(deps, CONTENT, "/home")).toEqual({ lcmMdWritten: true, claudeMdPatched: true });
    expect(writeFileSync).toHaveBeenCalledWith("/home/.claude/lcm.md", CONTENT);
  });

  it("does not rewrite an already current lcm.md", () => {
    const files = new Map([
      ["/home/.claude/lcm.md", CONTENT],
      ["/home/.claude/CLAUDE.md", BLOCK + "\n"],
    ]);
    const writeFileSync = vi.fn();
    const result = ensureLcmMd({
      existsSync: (path) => files.has(path),
      readFileSync: (path) => files.get(path)!,
      writeFileSync,
      mkdirSync: vi.fn(),
    }, CONTENT, "/home");
    expect(result.lcmMdWritten).toBe(false);
  });
});
