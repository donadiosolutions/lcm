import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeClaudeSettings,
  resolveBinaryPath,
  install,
  ensureLcmMd,
  waitForHealth,
  REQUIRED_HOOKS,
  type ServiceDeps,
} from "../../installer/install.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyLcmCommand, legacyLcmMcpServerName } from "../../src/legacy-names.js";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_RETRY_POLICY, parseDaemonConfig } from "../../src/daemon/config.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0, stdout = "") {
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
    ...overrides,
  };
}

// ─── mergeClaudeSettings ────────────────────────────────────────────────────

describe("mergeClaudeSettings", () => {
  it("removes managed hooks and mcpServers from empty settings", () => {
    const r = mergeClaudeSettings({});
    expect(r).toEqual({});
  });

  it("removes all 4 required hooks when already present", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] }],
      },
      mcpServers: {
        lcm: { command: "lcm", args: ["mcp"] },
      },
    };
    const r = mergeClaudeSettings(existing);
    expect(r.hooks).toBeUndefined();
    // mcpServers.lcm is now owned by settings.json and preserved
    expect(r.mcpServers).toEqual({ lcm: { command: "lcm", args: ["mcp"] } });
  });

  it("REQUIRED_HOOKS contains exactly 6 expected events", () => {
    expect(REQUIRED_HOOKS.map(h => h.event).sort()).toEqual([
      "PostToolUse", "PreCompact", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("removes any of the 5 hooks if already present", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-snapshot" }] }],
      },
    };
    const r = mergeClaudeSettings(existing);
    expect(r.hooks).toBeUndefined();
  });

  it("preserves unrelated hooks", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }] } });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
  });

  it("removes managed hooks without leaving duplicates behind", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }] } });
    expect(r.hooks).toBeUndefined();
  });

  it("removes only matching managed sub-hooks from a mixed entry", () => {
    const r = mergeClaudeSettings({
      hooks: {
        PreCompact: [{
          matcher: "",
          hooks: [
            { type: "command", command: "other" },
            { type: "command", command: "lcm compact --hook" },
          ],
        }],
      },
    });

    expect(r.hooks.PreCompact).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: "other" }],
    }]);
  });

  it("migrates legacy hooks to lcm before removing them", () => {
    const legacyServerName = legacyLcmMcpServerName();
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: legacyLcmCommand("lcm compact") }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: legacyLcmCommand("lcm restore") }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
      },
      mcpServers: {
        [legacyServerName]: { command: legacyServerName, args: ["mcp"] },
        other: { command: "other", args: ["mcp"] },
      }
    };
    const result = mergeClaudeSettings(existing);
    for (const { event, command } of REQUIRED_HOOKS) {
      const entries = result.hooks?.[event] ?? [];
      const commands = entries.flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(commands).not.toContain(command);
      expect(commands).not.toContain(legacyLcmCommand(command));
    }
    expect(result.hooks?.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
    expect(result.mcpServers[legacyServerName]).toBeUndefined();
    expect(result.mcpServers["lcm"]).toBeUndefined();
    expect(result.mcpServers.other).toEqual({ command: "other", args: ["mcp"] });
  });

  it("normalizes malformed settings containers", () => {
    expect(mergeClaudeSettings({ hooks: [], mcpServers: "invalid" })).toEqual({});
    expect(mergeClaudeSettings({ hooks: null, mcpServers: [] })).toEqual({});
  });

  it("preserves malformed hook events and entries without hooks", () => {
    const result = mergeClaudeSettings({
      hooks: {
        InvalidEvent: "invalid",
        PreCompact: [{ matcher: "missing-hooks" }],
      },
    });

    expect(result.hooks).toEqual({
      InvalidEvent: "invalid",
      PreCompact: [{ matcher: "missing-hooks" }],
    });
  });

  it("deduplicates migrated commands and commandless hooks", () => {
    const legacy = legacyLcmCommand("lcm compact");
    const result = mergeClaudeSettings({
      hooks: {
        Custom: [{
          hooks: [
            { type: "command", command: legacy },
            { type: "command", command: "lcm compact --hook" },
            { type: "prompt" },
            { type: "prompt", prompt: "duplicate commandless hook" },
          ],
        }],
      },
    });

    expect(result.hooks.Custom[0].hooks).toEqual([
      { type: "command", command: "lcm compact --hook" },
      { type: "prompt" },
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

describe("waitForHealth", () => {
  it("returns immediately for a healthy response", async () => {
    await expect(waitForHealth("http://localhost/health", 10, vi.fn().mockResolvedValue({ ok: true }) as any))
      .resolves.toBe(true);
  });

  it("retries failed and throwing responses against a monotonic deadline", async () => {
    vi.useFakeTimers();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(-1_000_000_000);
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: false });
    try {
      const result = waitForHealth("http://localhost/health", 1000, fetchFn as any);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      wallClock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds the final retry sleep to the remaining deadline", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    try {
      let settled = false;
      const result = waitForHealth("http://localhost/health", 750, fetchFn as any)
        .finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(749);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not sleep after a request consumes the remaining deadline", async () => {
    const monotonicClock = vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10);
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(waitForHealth(
        "http://localhost/health",
        10,
        vi.fn().mockResolvedValue({ ok: false }) as any,
      )).resolves.toBe(false);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
      monotonicClock.mockRestore();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite timeout %s",
    async (timeoutMs) => {
      await expect(waitForHealth("http://localhost/health", timeoutMs, vi.fn() as any))
        .rejects.toThrow(new RangeError("timeoutMs must be a finite, non-negative number"));
    },
  );

  it("rejects negative timeouts but permits an immediate zero timeout", async () => {
    const fetchFn = vi.fn();
    await expect(waitForHealth("http://localhost/health", -1, fetchFn as any))
      .rejects.toThrow(new RangeError("timeoutMs must be a finite, non-negative number"));
    await expect(waitForHealth("http://localhost/health", 0, fetchFn as any)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
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

  it("ignores chmod failures and reports doctor failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      chmodSync: vi.fn(() => { throw new Error("chmod failed"); }),
      runDoctor: vi.fn().mockResolvedValue([{ name: "daemon", status: "fail" }]),
    });
    await install(deps);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("1 check(s) failed"));
    errorSpy.mockRestore();
  });

  it("clears stale cache directories, copies only markdown commands, and repairs malformed MCP settings", async () => {
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
        path.endsWith("config.json") || path.includes("plugins/cache") || path.endsWith(".claude-plugin/commands") || path === settingsPath),
      readFileSync: vi.fn((path: string) => {
        if (path.endsWith("package.json")) return JSON.stringify({ version: "1.4.0" });
        if (path === settingsPath) return settingsReads++ === 0 ? "{}" : "null";
        return "{}";
      }),
      readdirSync: readdirSync as any,
      rmSync: rmSync as any,
      copyFileSync: copyFileSync as any,
    });

    await install(deps);
    expect(rmSync).toHaveBeenCalledWith(expect.stringContaining("1.3.0"), { recursive: true, force: true });
    expect(copyFileSync).toHaveBeenCalledTimes(2);
    const settingsWrite = vi.mocked(deps.writeFileSync).mock.calls.filter(([path]) => path === settingsPath).at(-1);
    expect(JSON.parse(settingsWrite![1]).mcpServers.lcm).toBeDefined();
  });

  it("preserves a valid MCP server map and ignores cache inspection failures", async () => {
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
        spawnSync: makeSpawn(1, ""),
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
      };

      await install(deps);
      expect(fs.existsSync(join(cacheDir, "1.3.0"))).toBe(false);
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

  it("option 3 retries each empty required value once before accepting it", async () => {
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

  it("option 3 falls back atomically to auto after two empty server URLs", async () => {
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

  it("option 3 discards a valid URL when two model attempts are empty", async () => {
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
