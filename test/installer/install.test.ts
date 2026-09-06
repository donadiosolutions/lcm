import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeClaudeSettings,
  resolveBinaryPath,
  install,
  prepareInstallConfig,
  ensureLcmMd,
  REQUIRED_HOOKS,
  parseInstalledClaudePlugins,
  migrateClaudeMarketplacePlugins,
  canonicalHookCommand,
  hasCanonicalClaudeMcpEntry,
  hasManagedClaudeSettings,
  mergeClaudeMcpEntry,
  installClaudeSkill,
  removeClaudeLegacyAssets,
  readlinePrompt,
  resolveClaudeTransport,
  createInstallerPublicationConvergence,
  type ServiceDeps,
} from "../../installer/install.js";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import {
  chmodSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  mkdtempSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { legacyLcmCommand, legacyLcmMcpServerName } from "../../src/legacy-names.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_RETRY_POLICY, parseDaemonConfig } from "../../src/daemon/config.js";
import { removeManagedClaudeHooks } from "../../src/installer/settings.js";
import { OWNER_ONLY_FILE_MODES } from "../../src/security-files.js";
import { readBoundedRegularFile } from "../../src/security-files.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { createPublicationConvergence } from "../../src/storage/publication-convergence.js";
import { PACKAGED_RUNTIME_ENTRYPOINT, PKG_VERSION, RUNTIME_DIGEST } from "../../src/daemon/version.js";
import * as backendPublication from "../../src/storage/backend-publication.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0, stdout = "[]") {
  return vi.fn().mockReturnValue({ status, stdout, stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  const {
    readFileSync: readOverride,
    writeFileSync: writeOverride,
    ...remainingOverrides
  } = overrides;
  const writtenFiles = new Map<string, string>();
  return {
    spawnSync: makeSpawn(),
    readFileSync: vi.fn((path: string, encoding: string) => {
      if (readOverride) return readOverride(path, encoding);
      if (writtenFiles.has(path)) return writtenFiles.get(path)!;
      return "{}";
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      writeOverride?.(path, data);
      writtenFiles.set(path, data);
    }),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    rmSync: vi.fn(),
    promptUser: vi.fn().mockResolvedValue("1"), // default: option 1
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    runDoctor: vi.fn().mockResolvedValue([]),
    binaryPath: "/opt/npm/bin/lcm",
    ...remainingOverrides,
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

  it("deduplicates canonical POSIX hooks whose absolute paths contain apostrophes", () => {
    const apostropheRuntime = "/opt/npm/owner's/lcm.mjs";
    const apostropheNode = "/opt/node's/bin/node";
    const first = mergeClaudeSettings({}, apostropheRuntime, apostropheNode);
    const second = mergeClaudeSettings(first, apostropheRuntime, apostropheNode);

    expect(second).toEqual(first);
    for (const { event } of REQUIRED_HOOKS) {
      expect(second.hooks[event]).toHaveLength(1);
      expect(second.hooks[event][0].hooks).toHaveLength(1);
    }
  });

  it("detects only managed hook or MCP markers and validates their containers", () => {
    expect(hasManagedClaudeSettings({ theme: "dark", mcpServers: { unrelated: {} } })).toBe(false);
    expect(hasManagedClaudeSettings({ mcpServers: { lcm: {} } })).toBe(true);
    expect(hasManagedClaudeSettings({
      hooks: { SessionStart: [{ hooks: [{ command: "lcm restore" }] }] },
    })).toBe(true);
    expect(hasManagedClaudeSettings({
      hooks: { SessionStart: [null, "custom", { other: true }, { hooks: [{ command: "other" }, { command: 42 }] }] },
    })).toBe(false);
    expect(() => hasManagedClaudeSettings(null)).toThrow("must contain a JSON object");
    expect(() => hasManagedClaudeSettings({ mcpServers: [] })).toThrow("mcpServers must be");
    expect(() => hasManagedClaudeSettings({ hooks: [] })).toThrow("hooks must be");
    expect(() => hasManagedClaudeSettings({ hooks: { Stop: "invalid" } })).toThrow("hooks.Stop must be");
    expect(() => hasManagedClaudeSettings({ hooks: { Stop: [{ hooks: "invalid" }] } }))
      .toThrow("entry hooks must be");
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

  it("deduplicates and removes Windows canonical hooks with doubled quotes", () => {
    const windowsCommand = canonicalHookCommand(
      'C:\\npm\\"root"\\run"time"\\lcm.mjs',
      "restore",
      'C:\\node\\run"time"\\node.exe',
      "win32",
    );
    const existing = {
      hooks: {
        SessionStart: [{
          matcher: "",
          hooks: [{ type: "command", command: windowsCommand }],
        }],
      },
      mcpServers: { other: { command: "other" } },
    };

    const merged = mergeClaudeSettings(existing, binary);
    expect(merged.hooks.SessionStart).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: canonicalHookCommand(binary, "restore") }],
    }]);

    const removed = removeManagedClaudeHooks(existing);
    expect(removed).toEqual({ mcpServers: { other: { command: "other" } } });
  });

  it("preserves malformed Windows quote escaping", () => {
    const malformed = '"C:\\node\\node.exe" "C:\\npm\\broken"quote\\lcm.mjs restore';
    const existing = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: malformed }] }],
      },
    };

    expect(mergeClaudeSettings(existing, binary).hooks.SessionStart[0].hooks[0].command)
      .toBe(malformed);
    expect(removeManagedClaudeHooks(existing)).toEqual(existing);
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
describe("Claude MCP entry ownership", () => {
  const binary = "/opt/npm/bin/lcm";
  const node = "/opt/node/bin/node";

  it("owns command and args while preserving valid user and Claude options", () => {
    const existing = {
      command: "/old/node",
      args: ["/old/lcm", "mcp"],
      env: { LCM_POSTGRES_URL: "configured-elsewhere" },
      nested: { future: true },
    };

    const merged = mergeClaudeMcpEntry(existing, binary, node);

    expect(merged).toEqual({
      type: "stdio",
      command: node,
      args: [binary, "mcp"],
      env: existing.env,
      nested: { future: true },
    });
    expect(existing.command).toBe("/old/node");
    expect(hasCanonicalClaudeMcpEntry(merged, binary, node)).toBe(true);
  });

  it("normalizes HTTP and SSE entries to usable stdio without losing safe options", () => {
    for (const remoteType of ["http", "sse"]) {
      const existing = {
        type: remoteType,
        url: "https://example.invalid/lcm",
        headers: { Authorization: "Bearer secret" },
        transport: remoteType,
        env: { LCM_POSTGRES_URL: "postgresql://configured" },
        futureOption: { enabled: true },
      };

      const merged = mergeClaudeMcpEntry(existing, binary, node);

      expect(merged).toEqual({
        type: "stdio",
        command: node,
        args: [binary, "mcp"],
        env: existing.env,
        futureOption: { enabled: true },
      });
      expect(existing).toEqual(expect.objectContaining({
        type: remoteType,
        url: "https://example.invalid/lcm",
        headers: { Authorization: "Bearer secret" },
        transport: remoteType,
      }));
      expect(hasCanonicalClaudeMcpEntry(merged, binary, node)).toBe(true);
      expect(hasCanonicalClaudeMcpEntry({
        ...merged,
        type: remoteType,
      }, binary, node)).toBe(false);
      for (const field of ["url", "headers", "transport"]) {
        expect(hasCanonicalClaudeMcpEntry({
          ...merged,
          [field]: "incompatible",
        }, binary, node)).toBe(false);
      }
    }
  });

  it("replaces malformed entries and rejects stale owned fields", () => {
    expect(mergeClaudeMcpEntry(null, binary, node)).toEqual({
      type: "stdio",
      command: node,
      args: [binary, "mcp"],
    });
    expect(mergeClaudeMcpEntry([], binary, node)).toEqual({
      type: "stdio",
      command: node,
      args: [binary, "mcp"],
    });
    expect(mergeClaudeMcpEntry("invalid", binary, node)).toEqual({
      type: "stdio",
      command: node,
      args: [binary, "mcp"],
    });
    expect(hasCanonicalClaudeMcpEntry(null, binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry([], binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry("invalid", binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry({ type: "stdio", command: node, args: "invalid" }, binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry({ type: "stdio", command: node, args: [binary] }, binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry({ type: "stdio", command: "/stale", args: [binary, "mcp"] }, binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry({ type: "stdio", command: node, args: [binary, "other"] }, binary, node)).toBe(false);
    expect(hasCanonicalClaudeMcpEntry({ command: node, args: [binary, "mcp"] }, binary, node)).toBe(false);
  });

  it("requires absolute runtime and Node paths", () => {
    expect(() => mergeClaudeMcpEntry({}, "lcm", node)).toThrow("runtime path must be absolute");
    expect(() => hasCanonicalClaudeMcpEntry({}, binary, "node")).toThrow("Node executable path must be absolute");
    expect(hasCanonicalClaudeMcpEntry(
      { type: "stdio", command: "C:\\node\\node.exe", args: ["C:\\npm\\lcm.mjs", "mcp"], env: {} },
      "C:\\npm\\lcm.mjs",
      "C:\\node\\node.exe",
      "win32",
    )).toBe(true);
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
      { id: "lcm@mixed-current", scope: "user" },
      { id: "lcm@mixed-legacy", scope: "user" },
      { id: "lcm@unrelated", scope: "user", installPath: "/tmp/lossless-claude/lcm" },
      { id: "lcm@lookalike", scope: "user" },
      { id: "other@current", scope: "user" },
    ]);
    const marketplaces = JSON.stringify([
      { name: "current", source: "github", repo: "donadiosolutions/lcm" },
      { name: "legacy", source: "github", repo: "lossless-claude/lcm" },
      { name: "mixed-current", source: "github", repo: "GitHub:DonadioSolutions/LCM" },
      { name: "mixed-legacy", source: "github", repo: "HTTPS://GITHUB.COM/Lossless-Claude/LCM.GIT" },
      { name: "unrelated", source: "github", repo: "someone/lcm" },
      { name: "lookalike", source: "github", repo: "DonadioSolutions/LCM-extra" },
    ]);
    expect(parseInstalledClaudePlugins(plugins, marketplaces)).toEqual([
      { identifier: "lcm@current", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@legacy", repository: "lossless-claude/lcm", scope: "project", cwd: "/work/p" },
      { identifier: "lcm@mixed-current", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@mixed-legacy", repository: "lossless-claude/lcm", scope: "user", cwd: undefined },
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

  it("dry-run queries verified plugins and reports removals without mutating Claude", () => {
    const plugin = JSON.stringify([{ id: "lcm@current", scope: "project", projectPath: "/work/p" }]);
    const marketplaces = JSON.stringify([{ name: "current", repo: "DonadioSolutions/LCM" }]);
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: plugin })
      .mockReturnValueOnce({ status: 0, stdout: marketplaces });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      migrateClaudeMarketplacePlugins({ spawnSync: spawnSync as any, dryRun: true }, "/work/default");
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync).not.toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["uninstall"]),
        expect.anything(),
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[dry-run] would uninstall Claude Marketplace plugin lcm@current "
        + "(project, donadiosolutions/lcm) in /work/p",
      );
    } finally {
      logSpy.mockRestore();
    }
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
      { id: "lcm@mixed", repository: "GitHub:DonadioSolutions/LCM" },
      { id: "lcm@legacy-mixed", repo: "git@GitHub.com:Lossless-Claude/LCM.GIT" },
      { id: "lcm@lookalike", repository: "DonadioSolutions/LCM-extra" },
      { id: "lcm@unknown-owner", repository: "someone/LCM" },
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
      { identifier: "lcm@mixed", repository: "donadiosolutions/lcm", scope: "user", cwd: undefined },
      { identifier: "lcm@legacy-mixed", repository: "lossless-claude/lcm", scope: "user", cwd: undefined },
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

describe("Claude skill and legacy guidance seams", () => {
  const home = "/tmp/lcm-installer-guidance-coverage";
  const skillPath = join(home, ".claude", "skills", "lcm-memory", "SKILL.md");
  const legacySkillPath = join(home, ".claude", "skills", "lcm-context");
  const lcmMdPath = join(home, ".claude", "lcm.md");
  const claudeMdPath = join(home, ".claude", "CLAUDE.md");

  it("renders and byte-verifies the canonical skill through the default renderer", () => {
    const files = new Map<string, string>();
    const deps = {
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => files.get(path) ?? ""),
      writeFileSync: vi.fn((path: string, content: string) => { files.set(path, content); }),
      mkdirSync: vi.fn(),
    };

    expect(installClaudeSkill(deps, "cli", home)).toBe(skillPath);
    expect(files.get(skillPath)).toContain("lcm-managed-skill:v1");
    expect(deps.mkdirSync).toHaveBeenCalledWith(dirname(skillPath), { recursive: true });
  });

  it("preserves an unowned skill collision and rejects a failed readback", () => {
    const collision = new Map([[skillPath, "user-owned guidance"]]);
    const collisionDeps = {
      existsSync: (path: string) => collision.has(path),
      readFileSync: (path: string) => collision.get(path) ?? "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    expect(() => installClaudeSkill(collisionDeps, "mcp", home)).toThrow("unowned LCM skill");

    let reads = 0;
    const generated = "---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n";
    const mismatchDeps = {
      existsSync: () => false,
      readFileSync: () => { reads += 1; return reads === 1 ? "" : "different"; },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      renderClaudeSkill: () => generated,
    };
    expect(() => installClaudeSkill(mismatchDeps, "mcp", home)).toThrow("byte verification");
  });

  it.each([
    [
      "a marker embedded in YAML frontmatter",
      `---\nname: user-authored\n${"<!-- lcm-managed-skill:v1 -->"}\n---\nuser content\n`,
    ],
    [
      "a marker embedded in the document body",
      `---\nname: user-authored\n---\nuser content\n<!-- lcm-managed-skill:v1 -->\n`,
    ],
    [
      "a marker separated from frontmatter by a blank line",
      `---\nname: user-authored\n---\n\n<!-- lcm-managed-skill:v1 -->\nuser content\n`,
    ],
  ])("does not own or overwrite %s", (_description, collision) => {
    const files = new Map([[skillPath, collision]]);
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: vi.fn((path: string, content: string) => { files.set(path, content); }),
      mkdirSync: vi.fn(),
      renderClaudeSkill: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n",
    };

    expect(() => installClaudeSkill(deps, "mcp", home)).toThrow("unowned LCM skill");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(files.get(skillPath)).toBe(collision);
  });

  it("accepts an exact historical generated skill during migration", () => {
    const historical = fsReadFileSync(new URL("../connectors/fixtures/historical-skill-v0.md", import.meta.url), "utf-8");
    const files = new Map([[skillPath, historical]]);
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: (path: string, content: string) => { files.set(path, content); },
      mkdirSync: vi.fn(),
      renderClaudeSkill: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n",
    };

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(files.get(skillPath)).toContain("<!-- lcm-managed-skill:v1 -->");
  });

  const historicalInitialBlankLine = fsReadFileSync(
    new URL("../connectors/fixtures/historical-skill-initial-blank-line.md", import.meta.url),
    "utf-8",
  );

  it("replaces the historical initial-blank-line skill with exact canonical content", () => {
    const files = new Map([[skillPath, historicalInitialBlankLine]]);
    const canonical = "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n";
    const writes = vi.fn((path: string, content: string) => { files.set(path, content); });
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: writes,
      mkdirSync: vi.fn(),
      renderClaudeSkill: () => canonical,
    };

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(files.get(skillPath)).toBe(canonical);
  });

  it.each([
    ["with the initial template terminal LF removed", historicalInitialBlankLine.slice(0, -2)],
    ["with two appended LF bytes", `${historicalInitialBlankLine}\n`],
    ["with one changed ASCII body byte", historicalInitialBlankLine.replace("# Lossless", "# Xossless")],
  ])("rejects the historical skill %s without writing", (_description, existing) => {
    const files = new Map([[skillPath, existing]]);
    const writes = vi.fn((path: string, content: string) => { files.set(path, content); });
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: writes,
      mkdirSync: vi.fn(),
      renderClaudeSkill: () => canonicalSkill,
    };

    expect(() => installClaudeSkill(deps, "mcp", home)).toThrow("unowned LCM skill");
    expect(writes).not.toHaveBeenCalled();
    expect(files.get(skillPath)).toBe(existing);
  });

  const canonicalSkill = "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n";
  const skillDepsForExisting = (existing: string, generated = canonicalSkill) => {
    const files = new Map([[skillPath, existing]]);
    const writes = vi.fn((path: string, content: string) => { files.set(path, content); });
    return {
      files,
      writes,
      deps: {
        existsSync: (path: string) => files.has(path),
        readFileSync: (path: string) => files.get(path) ?? "",
        writeFileSync: writes,
        mkdirSync: vi.fn(),
        renderClaudeSkill: () => generated,
      },
    };
  };

  it.each([
    ["without a leading frontmatter opener", "<!-- lcm-managed-skill:v1 -->\nbody\n"],
    ["with an opener that has no first newline", "---"],
    ["with an inline frontmatter opener", "--- name: user-authored\n---\n<!-- lcm-managed-skill:v1 -->\n"],
    ["with unterminated frontmatter", "---\nname: user-authored"],
    ["with a closing delimiter at EOF but no marker", "---\nname: user-authored\n---"],
  ])("does not own a skill %s", (_description, existing) => {
    const { deps, files, writes } = skillDepsForExisting(existing);

    expect(() => installClaudeSkill(deps, "mcp", home)).toThrow("unowned LCM skill");
    expect(writes).not.toHaveBeenCalled();
    expect(files.get(skillPath)).toBe(existing);
  });

  it("recognizes CRLF frontmatter and marker delimiters", () => {
    const existing = "---\r\nname: lcm-memory\r\n---\r\n<!-- lcm-managed-skill:v1 -->\r\nold\r\n";
    const { deps, files, writes } = skillDepsForExisting(existing);

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(writes).toHaveBeenCalledOnce();
    expect(files.get(skillPath)).toBe(canonicalSkill);
  });

  it("recognizes a managed marker at EOF immediately after frontmatter", () => {
    const existing = "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->";
    const { deps, files, writes } = skillDepsForExisting(existing);

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(writes).toHaveBeenCalledOnce();
    expect(files.get(skillPath)).toBe(canonicalSkill);
  });

  it("accepts exact generated bytes as owned", () => {
    const { deps, files, writes } = skillDepsForExisting(canonicalSkill);

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(writes).toHaveBeenCalledOnce();
    expect(files.get(skillPath)).toBe(canonicalSkill);
  });

  it("reinstalls an empty canonical skill with exact generated bytes", () => {
    const { deps, files, writes } = skillDepsForExisting("");

    expect(() => installClaudeSkill(deps, "mcp", home)).not.toThrow();
    expect(writes).toHaveBeenCalledOnce();
    expect(files.get(skillPath)).toBe(canonicalSkill);
  });

  it("previews a managed skill without mutating files during dry-run", () => {
    const preview = vi.fn();
    const deps = {
      existsSync: () => true,
      readFileSync: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nold\n",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      previewWriteFile: preview,
      dryRun: true,
      renderClaudeSkill: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nnew\n",
    };
    expect(installClaudeSkill(deps, "cli", home)).toBe(skillPath);
    expect(preview).toHaveBeenCalledWith(skillPath, "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nnew\n");
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("previews the exact historical initial-blank-line migration without writing", () => {
    const files = new Map([[skillPath, historicalInitialBlankLine]]);
    const preview = vi.fn();
    const canonical = "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n";
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      previewWriteFile: preview,
      dryRun: true,
      renderClaudeSkill: () => canonical,
    };

    expect(installClaudeSkill(deps, "cli", home)).toBe(skillPath);
    expect(preview).toHaveBeenCalledWith(skillPath, canonical);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(files.get(skillPath)).toBe(historicalInitialBlankLine);
  });

  it("removes recognized legacy assets and preserves modified or unreadable collisions", () => {
    const files = new Map<string, string>([
      [skillPath, "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nold\n"],
      [legacySkillPath, "directory"],
      [join(legacySkillPath, "SKILL.md"), "LCM legacy guidance"],
      [lcmMdPath, "Long Context Manager legacy guidance"],
      [claudeMdPath, `before\n<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->\nafter\n`],
    ]);
    const removed: string[] = [];
    const deps = {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
      writeFileSync: (path: string, content: string) => { files.set(path, content); },
      mkdirSync: vi.fn(),
      lstatSync: (path: string) => ({ isDirectory: () => path === legacySkillPath }) as never,
      readdirSync: () => ["SKILL.md"],
      rmSync: (path: string) => { removed.push(path); },
      removeCurrentSkill: true,
    };

    removeClaudeLegacyAssets(deps, home);
    expect(removed).toEqual([skillPath, legacySkillPath, lcmMdPath]);
    expect(files.get(claudeMdPath)).toBe("before\nafter\n");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const collisionDeps = {
      existsSync: (path: string) => [skillPath, legacySkillPath, lcmMdPath, claudeMdPath].includes(path),
      readFileSync: (path: string) => {
        if (path === skillPath) throw new Error("unreadable skill");
        if (path === lcmMdPath) return "user-owned file";
        if (path === claudeMdPath) return `<!-- lcm:start -->\nuser edit\n<!-- lcm:end -->`;
        return "user-owned legacy";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      lstatSync: () => ({ isDirectory: () => false }) as never,
      readdirSync: vi.fn(),
      rmSync: vi.fn(),
      removeCurrentSkill: true,
    };
    removeClaudeLegacyAssets(collisionDeps, home);
    expect(collisionDeps.rmSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("preserves the legacy skill when inspection seams are omitted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    try {
      removeClaudeLegacyAssets({
        existsSync: (path: string) => path === legacySkillPath,
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        rmSync,
      }, home);

      expect(rmSync).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized Claude legacy skill collision"));
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves the legacy skill when inspection fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    try {
      removeClaudeLegacyAssets({
        existsSync: (path: string) => path === legacySkillPath,
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        lstatSync: () => { throw new Error("inspection failed"); },
        readdirSync: vi.fn(),
        rmSync,
      }, home);

      expect(rmSync).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized Claude legacy skill collision"));
    } finally {
      warn.mockRestore();
    }
  });

  it("covers legacy directory contents, dry-run removal, and unreadable metadata", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const makeDeps = (entries: unknown[], read: (path: string) => string, dryRun = false) => ({
        existsSync: (path: string) => path === legacySkillPath || path === lcmMdPath || path === claudeMdPath,
        readFileSync: read,
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        lstatSync: () => ({ isDirectory: () => true }) as never,
        readdirSync: () => entries,
        rmSync: vi.fn(),
        dryRun,
        removeCurrentSkill: false,
      });
      removeClaudeLegacyAssets(makeDeps(["notes.txt"], () => "user"), home);
      const unreadable = makeDeps(["SKILL.md"], () => { throw new Error("read failed"); });
      unreadable.existsSync = (path: string) => path === legacySkillPath || path === lcmMdPath;
      removeClaudeLegacyAssets(unreadable, home);
      removeClaudeLegacyAssets(makeDeps(["SKILL.md"], () => "LCM", true), home);

      const dryRunAll = makeDeps(["SKILL.md"], () => "LCM", true);
      dryRunAll.existsSync = (path: string) => [skillPath, legacySkillPath, lcmMdPath, claudeMdPath].includes(path);
      dryRunAll.readFileSync = (path: string) => path === claudeMdPath
        ? `before\n<!-- lcm:start -->\n@lcm.md\n<!-- lcm:end -->\nafter\n`
        : path === skillPath ? "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nowned\n" : "LCM memory";
      dryRunAll.removeCurrentSkill = true;
      removeClaudeLegacyAssets(dryRunAll, home);

      const defaultRemoval = makeDeps(["SKILL.md"], () => "LCM");
      defaultRemoval.existsSync = (path: string) => path === legacySkillPath || path === lcmMdPath;
      delete (defaultRemoval as { rmSync?: unknown }).rmSync;
      removeClaudeLegacyAssets(defaultRemoval, home);

      removeClaudeLegacyAssets({
        existsSync: (path: string) => path === skillPath || path === lcmMdPath,
        readFileSync: (path: string) => path === skillPath
          ? "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\nowned\n"
          : "LCM memory legacy guidance",
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        removeCurrentSkill: true,
      }, home);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("would remove"));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("Claude transport resolution", () => {
  it("defaults to MCP when the stored config is absent", () => {
    expect(resolveClaudeTransport("/tmp/lcm-no-such-config/.lcm/config.json")).toBe("mcp");
  });
});

// ─── install ────────────────────────────────────────────────────────────────

describe("install", () => {
  it("installs the rendered Claude lcm-memory skill and verifies its bytes before legacy cleanup", async () => {
    const home = homedir();
    const files = new Map<string, string>([
      [join(home, ".claude/skills/lcm-context/SKILL.md"), "legacy lcm guidance"],
      [join(home, ".claude/lcm.md"), "# Long Context Manager\n"],
      [join(home, ".claude/CLAUDE.md"), "before\n<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\nafter\n"],
    ]);
    const writes: string[] = [];
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || [...files.keys()].some((file) => file === path || file.startsWith(`${path}/`))),
      readFileSync: vi.fn((path: string) => files.get(path) ?? "{}"),
      writeFileSync: vi.fn((path: string, content: string) => { writes.push(path); files.set(path, content); }),
      rmSync: vi.fn((path: string) => { for (const file of files.keys()) if (file === path || file.startsWith(`${path}/`)) files.delete(file); }),
      mkdirSync: vi.fn(),
      lstatSync: vi.fn((path: string) => ({
        isSymbolicLink: () => false,
        isFile: () => path.endsWith("config.json"),
        isDirectory: () => path === join(home, ".claude", "skills", "lcm-context"),
      }) as never),
      readdirSync: vi.fn(() => ["SKILL.md"]),
      renderClaudeSkill: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n",
      runDoctor: vi.fn().mockResolvedValue([]),
    } as any);

    await install(deps);

    expect(files.get(join(home, ".claude/skills/lcm-memory/SKILL.md"))).toContain("canonical");
    expect(files.has(join(home, ".claude/skills/lcm-context/SKILL.md"))).toBe(false);
    expect(files.has(join(home, ".claude/lcm.md"))).toBe(false);
    expect(files.get(join(home, ".claude/CLAUDE.md"))).toBe("before\nafter\n");
    expect(writes.indexOf(join(home, ".claude/skills/lcm-memory/SKILL.md"))).toBeLessThan(
      writes.indexOf(join(home, ".claude/CLAUDE.md")),
    );
  });

  it("preserves a legacy skill collision when injected install dependencies omit inspection", async () => {
    const legacySkillPath = join(homedir(), ".claude", "skills", "lcm-context");
    const rmSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || path === legacySkillPath),
      rmSync,
      renderClaudeSkill: () => "---\nname: lcm-memory\n---\n<!-- lcm-managed-skill:v1 -->\ncanonical\n",
    });

    await install(deps);

    expect(rmSync).not.toHaveBeenCalledWith(legacySkillPath, expect.anything());
  });

  it("does not add Claude MCP for stored CLI transport", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings = JSON.stringify({ mcpServers: { unrelated: { command: "other" } } });
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || path === settingsPath),
      readFileSync: vi.fn((path: string) => path === settingsPath ? settings : "{}"),
      writeFileSync: vi.fn((path: string, content: string) => { if (path === settingsPath) settings = content; }),
      runDoctor: vi.fn().mockResolvedValue([]),
    });
    const configPath = join(homedir(), ".lcm", "config.json");
    (deps as ServiceDeps).claudeTransport = "cli";

    await install(deps);

    const installed = JSON.parse(settings);
    expect(installed.mcpServers).toEqual({ unrelated: { command: "other" } });
    expect(installed.hooks.UserPromptSubmit.at(-1).hooks[0].command)
      .toContain("user-prompt --transport cli");
    expect(configPath).toContain("config.json");
  });

  it("removes only the exact owned Claude MCP entry for CLI transport", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const binaryPath = "/opt/npm/bin/lcm";
    let settings = JSON.stringify({
      mcpServers: {
        lcm: { type: "stdio", command: process.execPath, args: [binaryPath, "mcp"] },
      },
    });
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || path === settingsPath),
      readFileSync: vi.fn((path: string) => path === settingsPath ? settings : "{}"),
      writeFileSync: vi.fn((path: string, content: string) => { if (path === settingsPath) settings = content; }),
      binaryPath,
      claudeTransport: "cli",
      runDoctor: vi.fn().mockResolvedValue([]),
    });

    await install(deps);

    const installed = JSON.parse(settings);
    expect(installed.mcpServers).toBeUndefined();
  });

  it("fails before native settings or legacy removal when canonical skill generation fails", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const legacySkillPath = join(homedir(), ".claude", "skills", "lcm-context");
    const writeFileSync = vi.fn();
    const rmSync = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path === settingsPath || path.endsWith("config.json") || path === legacySkillPath),
      writeFileSync,
      rmSync,
      renderClaudeSkill: () => { throw new Error("renderer failed"); },
    });

    await expect(install(deps)).rejects.toThrow("renderer failed");
    expect(writeFileSync).not.toHaveBeenCalledWith(settingsPath, expect.any(String));
    expect(rmSync).not.toHaveBeenCalledWith(legacySkillPath, expect.anything());
  });

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

  it("uses the durable atomic writer when that production seam is provided", async () => {
    const atomicWritePrivateFileDurable = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      atomicWritePrivateFileDurable,
    });

    await install(deps);

    expect(atomicWritePrivateFileDurable).toHaveBeenCalledWith(
      expect.stringContaining("config.json"),
      expect.stringContaining('"provider": "auto"'),
      { requireAbsent: true },
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

  it("uses the bounded config reader inside the canonical publication lock", async () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-bounded-config-"));
    const root = join(home, ".lcm");
    const configPath = join(root, "config.json");
    process.env.HOME = home;
    fsMkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    fsWriteFileSync(configPath, "{}", { mode: 0o600 });
    try {
      const bounded = vi.fn((path: string) => fsReadFileSync(path, "utf-8"));
      const deps = makeDeps({
        existsSync: fsExistsSync,
        readFileSync: fsReadFileSync,
        writeFileSync: fsWriteFileSync,
        mkdirSync: fsMkdirSync,
        ensureLcmHome: vi.fn(),
        readBoundedRegularFile: bounded as ServiceDeps["readBoundedRegularFile"],
        ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
      });

      await expect(install(deps)).resolves.not.toThrow();
      expect(bounded).toHaveBeenCalledWith(configPath, expect.objectContaining({
        allowedRoot: root,
        maxBytes: 4 * 1024 * 1024,
        allowedModes: OWNER_ONLY_FILE_MODES,
        requireSingleLink: true,
      }));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("creates a missing canonical config under the publication lock", async () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-canonical-create-"));
    const root = join(home, ".lcm");
    const configPath = join(root, "config.json");
    process.env.HOME = home;
    fsMkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    try {
      const deps = makeDeps({
        existsSync: fsExistsSync,
        readFileSync: fsReadFileSync,
        writeFileSync: fsWriteFileSync,
        mkdirSync: fsMkdirSync,
        ensureLcmHome: vi.fn(),
        ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
      });

      await expect(install(deps)).resolves.not.toThrow();
      expect(fsExistsSync(configPath)).toBe(true);
      expect(JSON.parse(fsReadFileSync(configPath, "utf-8")).llm.provider).toBe("auto");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a canonical PostgreSQL config without completed publication evidence", async () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-canonical-postgres-"));
    const root = join(home, ".lcm");
    const configPath = join(root, "config.json");
    process.env.HOME = home;
    fsMkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    fsWriteFileSync(configPath, '{"storage":{"backend":"postgresql"}}', { mode: 0o600 });
    try {
      const deps = makeDeps({
        existsSync: fsExistsSync,
        readFileSync: fsReadFileSync,
        writeFileSync: fsWriteFileSync,
        mkdirSync: fsMkdirSync,
        ensureLcmHome: vi.fn(),
      });

      await expect(install(deps)).rejects.toThrow("publication evidence");
      expect(deps.ensureDaemon).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("fails installation when the LCM data root cannot be secured", async () => {
    const deps = makeDeps({
      chmodSync: vi.fn(() => { throw new Error("chmod failed"); }),
    });

    await expect(install(deps)).rejects.toThrow("chmod failed");
    expect(deps.runDoctor).not.toHaveBeenCalled();
  });

  it("does not inspect or remove Marketplace plugins when config preparation fails", async () => {
    const spawnSync = vi.fn();
    const deps = makeDeps({
      spawnSync: spawnSync as any,
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn((path: string) => {
        if (path.endsWith("config.json")) throw new Error("preparation failed");
      }),
    });

    await expect(install(deps)).rejects.toThrow("preparation failed");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("does not inspect or remove Marketplace plugins when native settings cannot be persisted", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const spawnSync = vi.fn();
    const deps = makeDeps({
      spawnSync: spawnSync as any,
      existsSync: vi.fn((path: string) => path.endsWith("config.json")),
      writeFileSync: vi.fn((path: string) => {
        if (path === settingsPath) throw new Error("settings write failed");
      }),
    });

    await expect(install(deps)).rejects.toThrow("settings write failed");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("keeps Marketplace plugins when native settings read-back loses managed fields", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const spawnSync = vi.fn();
    const deps = makeDeps({
      spawnSync: spawnSync as any,
      existsSync: vi.fn((path: string) => path === settingsPath || path.endsWith("config.json")),
      readFileSync: vi.fn((path: string) => path === settingsPath ? "{}" : "{}"),
    });

    await expect(install(deps)).rejects.toThrow("did not persist correctly");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("keeps Marketplace plugins when native settings read-back is malformed JSON", async () => {
    const spawnSync = vi.fn();
    const deps = makeDeps({
      spawnSync: spawnSync as any,
      existsSync: vi.fn((path: string) => path.endsWith("config.json")),
      readFileSync: vi.fn(() => "{"),
    });

    await expect(install(deps)).rejects.toThrow("Could not verify native Claude settings after writing");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("persists wizard configuration before uninstalling a recognized Marketplace plugin", async () => {
    const events: string[] = [];
    const plugin = JSON.stringify([{ id: "lcm@legacy", scope: "user" }]);
    const marketplaces = JSON.stringify([{ name: "legacy", repo: "lossless-claude/lcm" }]);
    const spawnSync = vi.fn()
      .mockImplementationOnce(() => ({ status: 0, stdout: plugin }))
      .mockImplementationOnce(() => ({ status: 0, stdout: marketplaces }))
      .mockImplementationOnce(() => {
        events.push("uninstall");
        return { status: 0, stdout: "" };
      })
      .mockImplementationOnce(() => ({ status: 0, stdout: "[]" }));
    const deps = makeDeps({
      spawnSync: spawnSync as any,
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn((path: string) => {
        if (path.endsWith("config.json")) events.push("config");
        if (path.endsWith("settings.json")) events.push("native-settings");
      }),
    });

    await install(deps);

    expect(events[0]).toBe("config");
    expect(events.indexOf("uninstall")).toBeGreaterThan(events.indexOf("config"));
    expect(events.indexOf("uninstall")).toBeGreaterThan(events.indexOf("native-settings"));
  });

  it("keeps native settings read-only during dry-run and preserves Marketplace ordering", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const nativeSettings = JSON.stringify(mergeClaudeSettings({}, "/opt/npm/bin/lcm"));
    const events: string[] = [];
    let previewedSettings: Record<string, any> | undefined;
    const plugin = JSON.stringify([{ id: "lcm@legacy", scope: "user" }]);
    const marketplaces = JSON.stringify([{ name: "legacy", repo: "lossless-claude/lcm" }]);
    const spawnSync = vi.fn((_cmd: string, args: string[]) => {
      if (args[1] === "list") {
        events.push("marketplace-scan");
        return { status: 0, stdout: plugin };
      }
      if (args[1] === "marketplace") {
        events.push("marketplace-verification");
        return { status: 0, stdout: marketplaces };
      }
      events.push("marketplace-uninstall");
      return { status: 0, stdout: "" };
    });
    const deps = makeDeps({
      dryRun: true,
      spawnSync: spawnSync as any,
      existsSync: vi.fn((path: string) =>
        path === settingsPath || path.endsWith("config.json")),
      readFileSync: vi.fn((path: string) => {
        if (path === settingsPath) {
          events.push("settings-read");
          return nativeSettings;
        }
        return "{}";
      }),
      writeFileSync: vi.fn((path: string) => {
        if (path === settingsPath) events.push("settings-write");
      }),
      previewWriteFile: vi.fn((path: string, data: string) => {
        if (path === settingsPath) {
          events.push("settings-preview");
          previewedSettings = JSON.parse(data);
        }
      }),
      mkdirSync: vi.fn((path: string) => {
        if (path === dirname(settingsPath)) events.push("settings-directory");
      }),
    });

    await install(deps);

    expect(events.filter((event) => event === "settings-read")).toHaveLength(4);
    expect(events.filter((event) => event === "settings-preview")).toHaveLength(1);
    expect(events).not.toContain("settings-write");
    expect(events).not.toContain("marketplace-uninstall");
    expect(previewedSettings?.mcpServers).toEqual({
      lcm: {
        type: "stdio",
        command: process.execPath,
        args: ["/opt/npm/bin/lcm", "mcp"],
      },
    });
    expect(events.indexOf("marketplace-scan")).toBeGreaterThan(
      events.indexOf("settings-preview"),
    );
    expect(events.indexOf("marketplace-verification")).toBeGreaterThan(
      events.indexOf("marketplace-scan"),
    );
    expect(events.indexOf("settings-directory")).toBeGreaterThan(
      events.indexOf("marketplace-verification"),
    );
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
    const retiredCommand = join(homedir(), ".claude", "commands", "lcm-dogfood.md");
    let settings = "{}";
    const deps = makeDeps({
      existsSync: vi.fn((path: string) =>
        path.endsWith("config.json")
        || path === "/templates/commands"
        || path === "/templates/skills"
        || path === settingsPath),
      readFileSync: vi.fn((path: string) => {
        if (path.endsWith("package.json")) return JSON.stringify({ version: "1.4.0" });
        if (path === settingsPath) return settings;
        return "{}";
      }),
      writeFileSync: vi.fn((path: string, data: string) => {
        if (path === settingsPath) settings = data;
      }),
      readdirSync: readdirSync as any,
      rmSync: rmSync as any,
      copyFileSync: copyFileSync as any,
      commandsSourceDir: "/templates/commands",
      skillSourceDir: "/templates/skills",
    });

    await install(deps);
    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync).toHaveBeenCalledWith(retiredCommand, { force: true });
    expect(copyFileSync).toHaveBeenCalledTimes(4);
    const settingsWrite = vi.mocked(deps.writeFileSync).mock.calls.filter(([path]) => path === settingsPath).at(-1);
    expect(JSON.parse(settingsWrite![1]).mcpServers.lcm).toBeDefined();
  });

  it("re-reads Claude settings after Marketplace migration before reconciling native settings", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const plugin = JSON.stringify([{ id: "lcm@legacy", scope: "user" }]);
    const marketplaces = JSON.stringify([{ name: "legacy", repo: "lossless-claude/lcm" }]);
    let settings = JSON.stringify({ theme: "before" });
    let spawnCall = 0;
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path === settingsPath || path.endsWith("config.json")),
      readFileSync: vi.fn((path: string) => path === settingsPath ? settings : "{}"),
      writeFileSync: vi.fn((path: string, data: string) => {
        if (path === settingsPath) settings = data;
      }),
      spawnSync: vi.fn(() => {
        spawnCall += 1;
        if (spawnCall === 1) return { status: 0, stdout: plugin };
        if (spawnCall === 2) return { status: 0, stdout: marketplaces };
        if (spawnCall === 3) {
          settings = JSON.stringify({ theme: "after", pluginCleanup: true });
          return { status: 0, stdout: "" };
        }
        return { status: 0, stdout: "[]" };
      }) as any,
    });

    await install(deps);

    expect(JSON.parse(settings)).toEqual(expect.objectContaining({
      theme: "after",
      pluginCleanup: true,
      mcpServers: expect.objectContaining({ lcm: expect.any(Object) }),
    }));
  });

  it("normalizes a remote MCP entry while preserving settings across installation", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings = JSON.stringify({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        lcm: {
          type: "http",
          url: "https://example.invalid/lcm",
          headers: { Authorization: "Bearer secret" },
          transport: "http",
          env: { LCM_POSTGRES_URL: "postgresql://configured" },
          futureOption: { enabled: true },
        },
      },
    });
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path === settingsPath || path.endsWith("config.json")),
      readFileSync: vi.fn((path: string) => path === settingsPath ? settings : "{}"),
      writeFileSync: vi.fn((path: string, data: string) => {
        if (path === settingsPath) settings = data;
      }),
    });

    await install(deps);

    expect(JSON.parse(settings)).toEqual(expect.objectContaining({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        lcm: {
          type: "stdio",
          command: process.execPath,
          args: ["/opt/npm/bin/lcm", "mcp"],
          env: { LCM_POSTGRES_URL: "postgresql://configured" },
          futureOption: { enabled: true },
        },
      },
    }));
  });

  it("preserves a valid MCP server map", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings = JSON.stringify({ mcpServers: { other: { command: "other" } } });
    const deps = makeDeps({
      existsSync: vi.fn((path: string) => path.endsWith("config.json") || path.includes("plugins/cache") || path === settingsPath),
      readFileSync: vi.fn((path: string) => path === settingsPath
        ? settings
        : "invalid package json"),
      writeFileSync: vi.fn((path: string, data: string) => {
        if (path === settingsPath) settings = data;
      }),
    });
    await install(deps);
    const settingsWrite = vi.mocked(deps.writeFileSync).mock.calls.filter(([path]) => path === settingsPath).at(-1);
    expect(JSON.parse(settingsWrite![1]).mcpServers.other).toBeDefined();
  });

  it("uses default filesystem operations for cache cleanup and command copies", async () => {
    const fs = await import("node:fs");
    const { legacyLcmSlug } = await import("../../src/legacy-names.js");
    const previousHome = process.env.HOME;
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-installer-filesystem-"));
    process.env.HOME = home;
    const lcmDir = join(home, ".lcm");
    const cacheDir = join(home, ".claude", "plugins", "cache", legacyLcmSlug(), "lcm");
    const claudeDir = join(home, ".claude");
    const commandsDestDir = join(claudeDir, "commands");
    const commandsSourceDir = fs.mkdtempSync(join(home, "commands-source-"));
    try {
      fs.mkdirSync(lcmDir, { recursive: true });
      fs.writeFileSync(join(lcmDir, "config.json"), "{}", { mode: 0o600 });
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
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
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

describe("installer publication admission integration", () => {
  function rawSnapshot(content: string, rawSha256: string, ino = "2") {
    return {
      content,
      witness: {
        presence: "present" as const,
        rawSha256,
        byteLength: Buffer.byteLength(content),
        dev: "1",
        ino,
        mtimeMs: 0,
      },
    };
  }

  it("captures configured and default daemon ports through the real factory", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-factory-port-"));
    try {
      const configuredPath = join(home, "config.json");
      fsWriteFileSync(configuredPath, '{"daemon":{"port":4123}}', { mode: 0o600 });
      await expect(createInstallerPublicationConvergence(configuredPath)).resolves.toMatchObject({ port: 4123 });

      const defaultPath = join(home, "default.json");
      fsWriteFileSync(defaultPath, '{"daemon":{}}', { mode: 0o600 });
      await expect(createInstallerPublicationConvergence(defaultPath)).resolves.toMatchObject({ port: 3737 });
    } finally {
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed when the factory snapshots drift or publication journal changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-factory-drift-"));
    const configPath = join(home, "config.json");
    const content = '{"daemon":{}}';
    fsWriteFileSync(configPath, content, { mode: 0o600 });
    try {
      const witnessDrift = [rawSnapshot(content, "a"), rawSnapshot(content, "b")];
      await expect(createInstallerPublicationConvergence(configPath, {
        _readDaemonConfigRawSnapshot: () => witnessDrift.shift()!,
      })).resolves.toMatchObject({ identity: undefined });

      const journalDrift = ["journal-a", "journal-b"];
      await expect(createInstallerPublicationConvergence(configPath, {
        _assertBackendPublicationConfigReadAccess: () => ({
          journalChecksumSha256: journalDrift.shift() ?? "journal-b",
        }),
      })).resolves.toMatchObject({ identity: undefined });
    } finally {
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("executes both default capture and retry token readers", async () => {
    const canonicalHome = mkdtempSync(join(tmpdir(), "lcm-installer-factory-token-"));
    const canonicalRoot = join(canonicalHome, ".lcm");
    const canonicalConfig = join(canonicalRoot, "config.json");
    fsMkdirSync(canonicalRoot, { mode: 0o700 });
    fsWriteFileSync(canonicalConfig, '{"daemon":{"port":3737}}', { mode: 0o600 });
    fsWriteFileSync(join(canonicalRoot, "daemon.token"), "token\n", { mode: 0o600 });
    const expectedVersion = PKG_VERSION ?? "test-version";
    const expectedEntrypoint = PACKAGED_RUNTIME_ENTRYPOINT ?? "/opt/lcm.mjs";
    const expectedRuntimeDigest = RUNTIME_DIGEST ?? "a".repeat(64);
    const health = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "ok", pid: process.pid, version: expectedVersion,
        storageBackend: "sqlite", entrypoint: expectedEntrypoint,
        runtimeDigest: expectedRuntimeDigest,
      }),
    })) as unknown as typeof globalThis.fetch;
    const nonCanonicalHome = mkdtempSync(join(tmpdir(), "lcm-installer-factory-token-alt-"));
    const nonCanonical = join(nonCanonicalHome, "config.json");
    fsWriteFileSync(nonCanonical, '{"daemon":{}}', { mode: 0o600 });
    try {
      const canonical = await createInstallerPublicationConvergence(canonicalConfig, {
        fetch: health,
        _expectedVersionForTesting: expectedVersion,
        _expectedEntrypointForTesting: expectedEntrypoint,
        _expectedRuntimeDigestForTesting: expectedRuntimeDigest,
      });
      expect(canonical.identity).toBeDefined();
      expect(canonical.deps.readToken?.()).toBe("token");
      const alternate = await createInstallerPublicationConvergence(nonCanonical);
      expect(alternate.deps.readToken?.()).toBeNull();
    } finally {
      fsRmSync(canonicalHome, { recursive: true, force: true });
      fsRmSync(nonCanonicalHome, { recursive: true, force: true });
    }
  });

  it("rejects lock-free existing-config witness drift and admits PostgreSQL via its read seam", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-lockfree-drift-"));
    const root = join(home, ".lcm");
    const configPath = join(root, "config.json");
    fsMkdirSync(root, { mode: 0o700 });
    const sqliteContent = '{"daemon":{}}';
    fsWriteFileSync(configPath, sqliteContent, { mode: 0o600 });
    const baseDeps = {
      ...makeDeps(),
      ensureLcmHome: vi.fn(),
      readBoundedRegularFile,
      _forceLockFreePublicationReadForTesting: true,
      existsSync: fsExistsSync,
      _readDaemonConfigRawSnapshot: vi.fn()
        .mockReturnValueOnce(rawSnapshot(sqliteContent, "a"))
        .mockReturnValueOnce(rawSnapshot(sqliteContent, "b")),
    } satisfies ServiceDeps;
    try {
      expect(() => prepareInstallConfig(baseDeps, configPath))
        .toThrow("configuration changed during lock-free publication admission");

      const postgresContent = '{"storage":{"backend":"postgresql"}}';
      fsWriteFileSync(configPath, postgresContent, { mode: 0o600 });
      const postgresDeps = {
        ...baseDeps,
        _readDaemonConfigRawSnapshot: vi.fn().mockReturnValue(rawSnapshot(postgresContent, "postgres")),
        _assertBackendPublicationConfigReadAccess: vi.fn(() => ({ journalChecksumSha256: "journal" })),
      } satisfies ServiceDeps;
      expect(prepareInstallConfig(postgresDeps, configPath)).toEqual({ exists: true, content: postgresContent });
    } finally {
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("reads an existing canonical config through the production bounded reader", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-publication-existing-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const root = join(home, ".lcm");
    const configPath = join(root, "config.json");
    fsMkdirSync(root, { recursive: true, mode: 0o700 });
    fsWriteFileSync(configPath, JSON.stringify({ version: 1 }), { mode: 0o600 });
    try {
      const result = prepareInstallConfig({
        ...makeDeps({
          ensureLcmHome: vi.fn(),
          readBoundedRegularFile,
          existsSync: fsExistsSync,
        }),
      }, configPath);
      expect(result).toEqual({ exists: true, content: JSON.stringify({ version: 1 }) });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fsRmSync(home, { recursive: true, force: true });
    }
  });

  it("retries ensureLcmHome contention and uses the lock-free config reader", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-installer-publication-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    fsMkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, ".claude"), 0o700);
    let now = 0;
    const sleeps: number[] = [];
    const firstContention = new PrivateMutationLockContentionError("publication busy");
    const configLockContention = new PrivateMutationLockContentionError("config publication busy");
    let homeCalls = 0;
    let configLockCalls = 0;
    let actualConfigLockCalls = 0;
    let configCreationCallbackCalls = 0;
    let contendedCallbackInvoked = false;
    const originalConfigLock = backendPublication.withBackendPublicationConfigLock;
    const configLock = vi.spyOn(backendPublication, "withBackendPublicationConfigLock")
      .mockImplementation((configFile, callback, permit) => {
        configLockCalls += 1;
        if (configFile === join(home, ".lcm", "config.json")) {
          actualConfigLockCalls += 1;
          if (actualConfigLockCalls === 1) throw configLockContention;
        }
        return originalConfigLock(configFile, (token) => {
          configCreationCallbackCalls += 1;
          if (actualConfigLockCalls === 1) contendedCallbackInvoked = true;
          return callback(token);
        }, permit);
      });
    const ensureLcmHome = vi.fn((homeDir: string) => {
      homeCalls += 1;
      if (homeCalls === 1) throw firstContention;
      fsMkdirSync(join(homeDir, ".lcm"), { recursive: true, mode: 0o700 });
    });
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: {
        pid: process.pid,
        version: "1.4.2",
        storageBackend: "sqlite",
        entrypoint: "/opt/lcm.mjs",
        runtimeDigest: "a".repeat(64),
      },
      deps: {
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: process.pid, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({ status: "ok", pid: process.pid, version: "1.4.2", storageBackend: "sqlite", entrypoint: "/opt/lcm.mjs", runtimeDigest: "a".repeat(64) }),
        })) as unknown as typeof globalThis.fetch,
        lockPath: join(home, ".lcm.backend-publication.lock"),
        platform: "linux",
      },
    });
    const deps = makeDeps({
      ensureLcmHome,
      publicationConvergence: convergence,
      readBoundedRegularFile,
      _forceLockFreePublicationReadForTesting: true,
      existsSync: fsExistsSync,
      readFileSync: fsReadFileSync,
      writeFileSync: vi.fn((path: string, content: string) => fsWriteFileSync(path, content)),
      mkdirSync: fsMkdirSync,
      chmodSync,
      ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
      commandsSourceDir: join(home, "missing-commands"),
      skillSourceDir: join(home, "missing-skills"),
    });
    try {
      await expect(install(deps, convergence)).resolves.toBeUndefined();
      expect(ensureLcmHome).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([50, 50]);
      expect(configLockCalls).toBeGreaterThanOrEqual(2);
      expect(contendedCallbackInvoked).toBe(false);
      expect(configCreationCallbackCalls).toBeGreaterThanOrEqual(1);
      expect((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
        .filter(([path]) => path === join(home, ".lcm", "config.json"))).toHaveLength(1);
      expect(deps.promptUser).not.toHaveBeenCalled();
      expect((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
        .filter(([path]) => path === join(home, ".claude", "skills", "lcm-memory", "SKILL.md"))).toHaveLength(1);
      expect(fsExistsSync(join(home, ".lcm", "config.json"))).toBe(true);
    } finally {
      configLock.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fsRmSync(home, { recursive: true, force: true });
    }
  });
});
