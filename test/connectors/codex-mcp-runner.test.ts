import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installConnector, listConnectorInventory, removeConnector } from "../../src/connectors/installer.js";

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
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow(message);
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
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow(message);
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
      expect(() => installConnector("codex", "mcp", cwd, { codexCliRunner: runner, persistTransport: false })).toThrow("Codex MCP lcm entry failed JSON readback verification");
      expect(calls).toContainEqual(["mcp", "add", "lcm", "--", "lcm", "mcp"]);
    });
  });

  it("allows explicit Codex removal only for an exact owned entry and verifies removal", () => {
    withTempHome((cwd) => {
      let present = true;
      const calls: readonly string[][] = [];
      const runner: CodexCliRunner = (request) => {
        (calls as string[][]).push([...request.argv]);
        if (request.argv[1] === "get") return { status: 0, stdout: present ? JSON.stringify(validEntry()) : "[]" };
        present = false;
        return { status: 0, stdout: "" };
      };
      const result = removeConnector("codex", cwd, { codexCliRunner: runner, queryCodexMcp: true });
      expect(result).toMatchObject({ success: true, removed: true });
      expect(calls).toEqual([
        ["mcp", "get", "lcm", "--json"],
        ["mcp", "remove", "lcm"],
        ["mcp", "get", "lcm", "--json"],
      ]);
    });
  });

  it("reports a deterministic removal readback failure", () => {
    withTempHome((cwd) => {
      const runner: CodexCliRunner = (request) => ({
        status: 0,
        stdout: request.argv[1] === "get" ? JSON.stringify(validEntry()) : "",
      });
      expect(removeConnector("codex", cwd, { codexCliRunner: runner })).toMatchObject({
        success: false,
        removed: false,
        failures: ["mcp: Codex MCP lcm entry remained after removal"],
      });
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
    ["another server", { status: 1, stderr: "No MCP server named 'other' found.\n" }],
    ["substantive prefix", { status: 1, stderr: "prefix: No MCP server named 'lcm' found.\n" }],
    ["substantive suffix", { status: 1, stderr: "No MCP server named 'lcm' found. detail\n" }],
    ["empty stderr", { status: 1, stderr: "" }],
    ["permission error", { status: 1, stderr: "permission denied\n" }],
    ["result.error", { status: 1, stderr: "No MCP server named 'lcm' found.\n", error: new Error("runner exploded") }],
  ] as const)("does not classify %s as native MCP absence", (_label, result) => {
    withTempHome((cwd) => {
      const inspection = listConnectorInventory(cwd, {
        codexCliRunner: () => result,
      });
      expect(inspection.codexMcp.state).not.toBe("absent");
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
