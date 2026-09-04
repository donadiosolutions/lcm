import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installConnector,
  listConnectorInventory,
  nativeCodexMcpEnvironment,
  removeConnector,
} from "../../src/connectors/installer.js";

type CodexRunRequest = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
};

type CodexRunResult = {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
};

type CodexCliRunner = (request: CodexRunRequest) => CodexRunResult;

function validEntry(): Record<string, unknown> {
  return {
    name: "lcm",
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: "lcm",
      args: ["mcp"],
      env: null,
      env_vars: [],
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

function withTempHome<T>(fn: (cwd: string, home: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-codex-runner-"));
  const home = join(cwd, "home");
  mkdirSync(home);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(cwd, home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("native Codex MCP runner", () => {
  const uid = 1000;
  const runtimeDir = `/run/user/${uid}`;
  const busPath = `${runtimeDir}/bus`;
  const busAddress = `unix:path=${busPath}`;
  const trustedPathStats = (path: string) => ({
    uid,
    mode: path === runtimeDir ? 0o40700 : 0o140600,
    isDirectory: () => path === runtimeDir,
    isSocket: () => path === busPath,
    isSymbolicLink: () => false,
  });

  it("projects only the authenticated canonical current-user bus pair", () => {
    withTempHome((cwd, home) => {
      const environment = nativeCodexMcpEnvironment(cwd, {
        environment: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: busAddress,
          LD_PRELOAD: "/tmp/attacker.so",
          LCM_UNRELATED_SECRET: "must-not-cross",
        },
        getUid: () => uid,
        lstat: trustedPathStats,
        realpath: (path) => path,
      });

      expect(environment).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: home,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
        CODEX_HOME: join(home, ".codex"),
      });
    });
  });

  it.each([
    ["missing runtime directory", undefined, busAddress],
    ["empty runtime directory", "", busAddress],
    ["relative runtime directory", "relative", busAddress],
    ["foreign-user runtime directory", `/run/user/${uid + 1}`, `unix:path=/run/user/${uid + 1}/bus`],
    ["runtime directory newline", `${runtimeDir}\n`, busAddress],
    ["runtime directory NUL", `${runtimeDir}\0`, busAddress],
    ["oversized runtime directory", `/run/user/${"1".repeat(4097)}`, busAddress],
    ["missing bus address", runtimeDir, undefined],
    ["empty bus address", runtimeDir, ""],
    ["non-unix bus address", runtimeDir, "tcp:host=localhost"],
    ["mismatched bus path", runtimeDir, `unix:path=${runtimeDir}/other`],
    ["foreign-user bus path", runtimeDir, `unix:path=/run/user/${uid + 1}/bus`],
    ["bus address newline", runtimeDir, `${busAddress}\n`],
    ["bus address NUL", runtimeDir, `${busAddress}\0`],
    ["oversized bus address", runtimeDir, `unix:path=/${"x".repeat(4097)}`],
  ] as const)("rejects a %s instead of forwarding partial bus authority", (_label, candidateRuntime, candidateBus) => {
    const environment = nativeCodexMcpEnvironment("/workspace", {
      environment: {
        XDG_RUNTIME_DIR: candidateRuntime,
        DBUS_SESSION_BUS_ADDRESS: candidateBus,
      },
      getUid: () => uid,
      lstat: trustedPathStats,
      realpath: (path) => path,
    });

    expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it.each([
    ["runtime directory is unavailable", runtimeDir, undefined],
    ["runtime directory is a symlink", runtimeDir, { isSymbolicLink: () => true }],
    ["runtime directory is not a directory", runtimeDir, { isDirectory: () => false }],
    ["runtime directory has a foreign owner", runtimeDir, { uid: uid + 1 }],
    ["runtime directory has unsafe permissions", runtimeDir, { mode: 0o40755 }],
    ["runtime directory has special permission bits", runtimeDir, { mode: 0o41700 }],
    ["bus endpoint is unavailable", busPath, undefined],
    ["bus endpoint is a symlink", busPath, { isSymbolicLink: () => true }],
    ["bus endpoint is not a socket", busPath, { isSocket: () => false }],
    ["bus endpoint has a foreign owner", busPath, { uid: uid + 1 }],
  ] as const)("rejects the bus pair when the %s", (_label, rejectedPath, statsOverride) => {
    const environment = nativeCodexMcpEnvironment("/workspace", {
      environment: {
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      getUid: () => uid,
      lstat: (path) => {
        if (path === rejectedPath) {
          if (statsOverride === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { ...trustedPathStats(path), ...statsOverride };
        }
        return trustedPathStats(path);
      },
      realpath: (path) => path,
    });

    expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it.each([
    ["runtime directory", runtimeDir, `${runtimeDir}/redirected`],
    ["bus endpoint", busPath, `${runtimeDir}/redirected-bus`],
  ] as const)("rejects a non-canonical %s", (_label, rejectedPath, canonicalPath) => {
    const environment = nativeCodexMcpEnvironment("/workspace", {
      environment: {
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      getUid: () => uid,
      lstat: trustedPathStats,
      realpath: (path) => path === rejectedPath ? canonicalPath : path,
    });

    expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it.each([undefined, -1, 1.5, Number.NaN, 0x1_0000_0000])("rejects an unavailable or invalid current UID (%s)", (candidateUid) => {
    const environment = nativeCodexMcpEnvironment("/workspace", {
      environment: {
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      getUid: () => candidateUid,
      lstat: trustedPathStats,
      realpath: (path) => path,
    });

    expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it("rejects the bus pair when current UID lookup fails", () => {
    const environment = nativeCodexMcpEnvironment("/workspace", {
      environment: {
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      getUid: () => { throw new Error("UID lookup failed"); },
      lstat: trustedPathStats,
      realpath: (path) => path,
    });

    expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it("omits the bus pair when the platform does not expose process.getuid", () => {
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const environment = nativeCodexMcpEnvironment("/workspace", {
        environment: {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: busAddress,
        },
        lstat: trustedPathStats,
        realpath: (path) => path,
      });

      expect(environment.XDG_RUNTIME_DIR).toBeUndefined();
      expect(environment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    } finally {
      if (getuidDescriptor === undefined) Reflect.deleteProperty(process, "getuid");
      else Object.defineProperty(process, "getuid", getuidDescriptor);
    }
  });

  it("refuses an injected runner without add after preflight", () => {
    withTempHome((cwd) => {
      const runner = { get: () => [], remove: () => undefined };
      expect(() => installConnector("codex", "mcp", cwd, { codexMcpRunner: runner, persistTransport: false }))
        .toThrow(/does not provide add/iu);
    });
  });

  it("fails readback when injected add does not produce canonical state", () => {
    withTempHome((cwd) => {
      const runner = { get: () => [], add: () => undefined, remove: () => undefined };
      expect(() => installConnector("codex", "mcp", cwd, { codexMcpRunner: runner, persistTransport: false }))
        .toThrow(/failed JSON readback verification/iu);
    });
  });

  it("refuses removal when state becomes unverified after preflight", () => {
    withTempHome((cwd) => {
      let gets = 0;
      let removes = 0;
      const runner = {
        get: () => ++gets === 1 ? [validEntry()] : [{ ...validEntry(), custom: "collision" }],
        add: () => undefined,
        remove: () => { removes += 1; },
      };
      const result = removeConnector("codex", cwd, { codexMcpRunner: runner });
      expect(result).toMatchObject({ success: false, removed: false });
      expect(result.failures).toEqual(expect.arrayContaining([expect.stringMatching(/unverified Codex MCP/iu)]));
      expect(removes).toBe(0);
    });
  });

  it("refuses removal when an injected runner omits remove", () => {
    withTempHome((cwd) => {
      const runner = { get: () => [validEntry()], add: () => undefined };
      const result = removeConnector("codex", cwd, { codexMcpRunner: runner });
      expect(result).toMatchObject({ success: false, removed: false });
      expect(result.failures).toEqual(expect.arrayContaining([expect.stringMatching(/does not provide remove/iu)]));
    });
  });

  it("fails closed if pathname authority changes after native removal preflight", () => {
    withTempHome((cwd) => {
      let removes = 0;
      let checks = 0;
      const runner = {
        get: () => [validEntry()],
        add: () => undefined,
        remove: () => { removes += 1; },
        get pathnameBased() { return checks++ > 0; },
      };
      const result = removeConnector("codex", cwd, { codexMcpRunner: runner });
      expect(result).toMatchObject({ success: false, removed: false });
      expect(result.failures).toEqual(expect.arrayContaining([expect.stringMatching(/pathname-based native state/iu)]));
      expect(removes).toBe(0);
    });
  });
  it("refuses default pathname-based native add before any MCP mutation", () => {
    withTempHome((cwd) => {
      let adds = 0;
      let added = false;
      const runner: CodexCliRunner = (request) => {
        if (request.argv[1] === "add") {
          adds += 1;
          added = true;
          return { status: 0, stdout: "" };
        }
        if (added) return { status: 0, stdout: JSON.stringify(validEntry()) };
        return {
          status: 1,
          stderr: "No MCP server named 'lcm' found.",
          stdout: "",
        };
      };

      expect(() => installConnector("codex", "mcp", cwd, {
        codexCliRunner: runner,
        persistTransport: false,
      })).toThrow(/manual|pathname|native|descriptor/iu);
      expect(adds).toBe(0);
    });
  });

  it("refuses default pathname-based native removal before any MCP mutation", () => {
    withTempHome((cwd) => {
      let removals = 0;
      const runner: CodexCliRunner = (request) => {
        if (request.argv[1] === "remove") {
          removals += 1;
          return { status: 0, stdout: "" };
        }
        return { status: 0, stdout: JSON.stringify(validEntry()) };
      };
      const result = removeConnector("codex", cwd, { codexCliRunner: runner });
      expect(result).toMatchObject({ success: false, removed: false });
      expect(result).toMatchObject({ failures: [expect.stringMatching(/Automatic Codex MCP removal is unavailable/iu)] });
      expect(removals).toBe(0);
    });
  });

  it("passes exact argv and bounded safe process options through the injected low-level seam", () => {
    withTempHome((cwd, home) => {
      const calls: CodexRunRequest[] = [];
      const runner: CodexCliRunner = (request) => {
        calls.push(request);
        return {
          status: 0,
          stdout: JSON.stringify(validEntry()),
          stderr: "",
        };
      };

      expect(installConnector("codex", "mcp", cwd, {
        codexCliRunner: runner,
        persistTransport: false,
      })).toMatchObject({ success: true, transport: "mcp" });

      expect(calls.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
        { executable: "codex", argv: ["mcp", "get", "lcm", "--json"] },
        { executable: "codex", argv: ["mcp", "get", "lcm", "--json"] },
        { executable: "codex", argv: ["mcp", "get", "lcm", "--json"] },
        { executable: "codex", argv: ["mcp", "get", "lcm", "--json"] },
      ]);
      expect(calls.every((request) => request.cwd === cwd)).toBe(true);
      expect(calls.every((request) => request.shell === false)).toBe(true);
      expect(calls.every((request) => request.timeout === 5_000)).toBe(true);
      expect(calls.every((request) => request.maxBuffer === 1_048_576)).toBe(true);
      expect(calls.every((request) => request.env.CODEX_HOME === join(home, ".codex"))).toBe(true);
      expect(calls.every((request) => !Object.values(request.env).some((value) => value?.includes("\0")))).toBe(true);
    });
  });

  it("renders MCP guidance and stamps MCP hook transport for an explicit Codex MCP bundle", () => {
    withTempHome((cwd, home) => {
      const runner = {
        get: () => [validEntry()],
        add: () => undefined,
        remove: () => undefined,
      };

      const result = installConnector("codex", "mcp", cwd, {
        codexMcpRunner: runner,
        persistTransport: false,
      });
      const skillPath = result.paths.find((path) => path.endsWith("SKILL.md"));
      expect(skillPath).toBeDefined();
      expect(readFileSync(skillPath!, "utf8")).toContain("lcm_search");
      expect(readFileSync(skillPath!, "utf8")).not.toContain("lcm search");

      const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command)
        .toBe("lcm user-prompt --client codex --transport mcp");
    });
  });

  it("does not call the native runner for a fresh implicit Codex CLI install", () => {
    withTempHome((cwd) => {
      const calls: CodexRunRequest[] = [];
      const runner: CodexCliRunner = (request) => {
        calls.push(request);
        throw new Error("implicit Codex CLI install must not inspect MCP");
      };

      expect(installConnector("codex", undefined, cwd, {
        persistTransport: false,
        queryCodexMcp: false,
        codexCliRunner: runner,
      })).toMatchObject({ success: true, transport: "cli" });
      expect(calls).toHaveLength(0);
    });
  });

  it.each([
    ["runner errors", { error: new Error("runner exploded") }, "Codex CLI runner failed"],
    ["runner timeouts", { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }, "Codex CLI runner failed"],
    ["runner buffer limits", { error: Object.assign(new Error("max buffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) }, "Codex CLI runner failed"],
    ["nonzero status", { status: 9, stderr: "permission denied" }, "Codex CLI command mcp get lcm --json exited with status 9: permission denied"],
  ] as const)("returns a deterministic error when %s", (_caseName, result, message) => {
    withTempHome((cwd) => {
      const runner: CodexCliRunner = () => ({ status: 0, stdout: JSON.stringify(validEntry()), ...result });
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow(
        _caseName === "wrong name" ? /Automatic Codex MCP add is unavailable/iu : message,
      );
    });
  });

  it.each([
    ["malformed JSON", "not-json", "Codex MCP get returned malformed JSON"],
    ["wrong name", JSON.stringify({ ...validEntry(), name: "other" }), "Codex MCP lcm entry failed JSON readback verification"],
    ["wrong command", JSON.stringify({ ...validEntry(), transport: { ...validEntry().transport as Record<string, unknown>, command: "other" } }), "Refusing to overwrite an unverified Codex MCP entry named lcm"],
    ["wrong args", JSON.stringify({ ...validEntry(), transport: { ...validEntry().transport as Record<string, unknown>, args: ["wrong"] } }), "Refusing to overwrite an unverified Codex MCP entry named lcm"],
    ["custom metadata", JSON.stringify({ ...validEntry(), custom: "must not be preserved" }), "Refusing to overwrite an unverified Codex MCP entry named lcm"],
  ] as const)("rejects %s", (_caseName, stdout, message) => {
    withTempHome((cwd) => {
      const runner: CodexCliRunner = () => ({ status: 0, stdout });
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow(
        _caseName === "wrong name" ? /Automatic Codex MCP add is unavailable/iu : message,
      );
    });
  });

  it("refuses a non-stdio Codex collision without invoking add", () => {
    withTempHome((cwd) => {
      let adds = 0;
      const runner: CodexCliRunner = (request) => {
        if (request.argv[1] === "add") adds += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            ...validEntry(),
            transport: { ...validEntry().transport as Record<string, unknown>, type: "sse", url: "https://example.invalid" },
          }),
        };
      };
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow("Refusing to overwrite");
      expect(adds).toBe(0);
    });
  });

  it("performs no compensating writes when snapshot fails before mutation", () => {
    withTempHome((cwd) => {
      const configPath = join(cwd, "config.json");
      writeFileSync(configPath, JSON.stringify({ connectors: { transports: { codex: "cli" } } }) + "\n", { mode: 0o600 });
      const beforeContent = readFileSync(configPath, "utf8");
      const beforeMtime = statSync(configPath).mtimeNs;
      let writes = 0;
      const runner: CodexCliRunner = (request) => {
        if (request.argv[1] === "add" || request.argv[1] === "remove") writes += 1;
        return { status: 0, stdout: "[]" };
      };

      expect(() => installConnector("codex", "mcp", cwd, {
        configPath,
        codexCliRunner: runner,
        failAt: "snapshot",
      })).toThrow("Injected connector installer failure at snapshot");
      expect(writes).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(beforeContent);
      expect(statSync(configPath).mtimeNs).toBe(beforeMtime);
    });
  });

  it("does not overwrite a non-owned lcm entry", () => {
    withTempHome((cwd) => {
      let addCalls = 0;
      const runner: CodexCliRunner = () => {
        return {
          status: 0,
          stdout: JSON.stringify({
            ...validEntry(),
            transport: { ...validEntry().transport as Record<string, unknown>, command: "other" },
          }),
        };
      };
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow("Refusing to overwrite");
      expect(addCalls).toBe(0);
    });
  });

  it("rejects an add whose JSON readback is not the owned entry", () => {
    withTempHome((cwd) => {
      let gets = 0;
      const calls: string[][] = [];
      const runner: CodexCliRunner = (request) => {
        calls.push([...request.argv]);
        if (request.argv[1] === "get") {
          gets += 1;
          return { status: 0, stdout: gets === 1 ? "[]" : JSON.stringify({ name: "other", command: "other", args: ["wrong"] }) };
        }
        return { status: 0, stdout: "" };
      };
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow(/Automatic Codex MCP add is unavailable/iu);
      expect(calls).not.toContainEqual(["mcp", "add", "lcm", "--", "lcm", "mcp"]);
    });
  });

  it("allows explicit Codex removal only for an exact owned entry and verifies removal", () => {
    withTempHome((cwd) => {
      let present = true;
      const runner = {
        get: () => present ? [validEntry()] : [],
        add: () => undefined,
        remove: () => { present = false; },
      };
      const result = removeConnector("codex", cwd, { codexMcpRunner: runner });
      expect(result).toMatchObject({ success: true, removed: true });
    });
  });

  it("reports a deterministic removal readback failure", () => {
    withTempHome((cwd) => {
      const runner = {
        get: () => [validEntry()],
        add: () => undefined,
        remove: () => undefined,
      };
      expect(removeConnector("codex", cwd, { codexMcpRunner: runner })).toMatchObject({
        success: false,
        removed: false,
        failures: ["mcp: Codex MCP lcm entry remained after removal"],
      });
    });
  });

  it("retains low-level Codex argv coverage for native inventory inspection", () => {
    withTempHome((cwd) => {
      const calls: readonly string[][] = [];
      const runner: CodexCliRunner = (request) => {
        (calls as string[][]).push([...request.argv]);
        if (request.argv[1] === "get") return { status: 0, stdout: JSON.stringify(validEntry()) };
        return { status: 0, stdout: "" };
      };
      expect(listConnectorInventory(cwd, { codexCliRunner: runner }).codexMcp.state).toBe("installed");
      expect(calls).toHaveLength(1);
    });
  });

  it("returns one verified native MCP surface for an exact nested stdio entry", () => {
    withTempHome((cwd) => {
      const calls: CodexRunRequest[] = [];
      const inventory = listConnectorInventory(cwd, {
        codexCliRunner: (request) => {
          calls.push(request);
          return { status: 0, stdout: JSON.stringify(validEntry()) };
        },
      });

      expect(inventory.codexMcp).toEqual({ state: "installed" });
      expect(inventory.installed).toContainEqual(expect.objectContaining({
        agentId: "codex",
        type: "mcp",
        path: "codex mcp",
      }));
      expect(calls).toHaveLength(1);
      expect(calls[0].argv).toEqual(["mcp", "get", "lcm", "--json"]);
    });
  });

  it("accepts an injected high-level native MCP runner without invoking Codex config", () => {
    withTempHome((cwd) => {
      let gets = 0;
      const inventory = listConnectorInventory(cwd, {
        codexMcpRunner: {
          get: () => { gets += 1; return [{ ...validEntry() }]; },
          add: () => undefined,
          remove: () => undefined,
        },
        codexCliRunner: () => { throw new Error("low-level runner must not be used"); },
      });
      expect(inventory.codexMcp).toEqual({ state: "installed" });
      expect(gets).toBe(1);
    });
  });

  it.each([
    ["legacy", "No MCP server named 'lcm' found.\n"],
    ["Codex 0.147.0", "Error: No MCP server named 'lcm' found.\n"],
  ] as const)("distinguishes the supported %s native MCP absence from inspection failure", (_label, stderr) => {
    withTempHome((cwd) => {
      const absent = listConnectorInventory(cwd, {
        codexCliRunner: () => ({ status: 1, stderr }),
      });
      expect(absent.codexMcp).toEqual({ state: "absent" });
      expect(absent.installed.some((entry) => entry.agentId === "codex" && entry.type === "mcp")).toBe(false);
    });
  });

  it.each([
    ["null status", { status: null, stderr: "No MCP server named 'lcm' found.\n" }],
    ["zero status", { status: 0, stderr: "No MCP server named 'lcm' found.\n" }],
    ["negative status", { status: -1, stderr: "No MCP server named 'lcm' found.\n" }],
    ["fractional status", { status: 1.5, stderr: "No MCP server named 'lcm' found.\n" }],
    ["NaN status", { status: Number.NaN, stderr: "No MCP server named 'lcm' found.\n" }],
    ["another server", { status: 1, stderr: "No MCP server named 'other' found.\n" }],
    ["substantive prefix", { status: 1, stderr: "prefix: No MCP server named 'lcm' found.\n" }],
    ["substantive suffix", { status: 1, stderr: "No MCP server named 'lcm' found. detail\n" }],
    ["multiple lines", { status: 1, stderr: "warning\nNo MCP server named 'lcm' found.\n" }],
    ["diagnostic in stdout", { status: 1, stdout: "No MCP server named 'lcm' found.\n", stderr: "" }],
    ["ANSI decoration", { status: 1, stderr: "\u001b[31mNo MCP server named 'lcm' found.\u001b[0m\n" }],
    ["curly quotes", { status: 1, stderr: "No MCP server named ‘lcm’ found.\n" }],
    ["case difference", { status: 1, stderr: "No MCP server named 'LCM' found.\n" }],
    ["internal whitespace", { status: 1, stderr: "No  MCP server named 'lcm' found.\n" }],
    ["localized diagnostic", { status: 1, stderr: "Nenhum servidor MCP chamado 'lcm' foi encontrado.\n" }],
    ["empty stderr", { status: 1, stderr: "" }],
    ["permission error", { status: 1, stderr: "permission denied\n" }],
    ["result.error", { status: 1, stderr: "No MCP server named 'lcm' found.\n", error: new Error("runner exploded") }],
  ] as const)("does not classify %s as native MCP absence", (_label, result) => {
    withTempHome((cwd) => {
      const inspection = listConnectorInventory(cwd, {
        codexCliRunner: () => result,
      });
      expect(inspection.codexMcp).toEqual(result.status === 0
        ? { state: "unknown", reason: "collision" }
        : { state: "unknown", reason: "unavailable" });
    });
  });

  it("preserves unavailable semantics for a permission failure", () => {
    withTempHome((cwd) => {
      const unavailable = listConnectorInventory(cwd, {
        codexCliRunner: () => ({ status: 9, stderr: "permission denied" }),
      });
      expect(unavailable.codexMcp).toEqual({ state: "unknown", reason: "unavailable" });
    });
  });

  it.each([
    ["malformed", "not-json"],
    ["collision", JSON.stringify({ ...validEntry(), transport: { ...validEntry().transport as Record<string, unknown>, command: "other" } })],
  ] as const)("does not report CLI or MCP for a %s native entry", (_label, stdout) => {
    withTempHome((cwd) => {
      const inventory = listConnectorInventory(cwd, {
        codexCliRunner: () => ({ status: 0, stdout }),
      });
      expect(inventory.codexMcp).toEqual({ state: "unknown", reason: "collision" });
      expect(inventory.installed.some((entry) => entry.agentId === "codex" && entry.type === "mcp")).toBe(false);
    });
  });

});
