import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENTS,
  findAgent,
  resolveAgentTransport,
} from "../../src/connectors/registry.js";
import {
  CONNECTOR_TRANSPORTS,
  type ConnectorTransport,
} from "../../src/connectors/types.js";
import {
  clearConnectorTransport,
  readConnectorTransport,
  setConnectorTransport,
} from "../../src/config-manager.js";
import {
  installConnector,
  removeConnector,
  type ConnectorInstallerOptions,
} from "../../src/connectors/installer.js";
import { renderGuidance } from "../../src/connectors/template-service.js";

describe("connector transport core", () => {
  it("defines the complete transport matrix and defaults", () => {
    expect(CONNECTOR_TRANSPORTS).toEqual(["cli", "mcp"]);

    const expectedDefaults: Record<string, ConnectorTransport> = {
      "claude-code": "mcp",
      codex: "cli",
      "gemini-cli": "cli",
      opencode: "cli",
      "qwen-code": "mcp",
      warp: "cli",
      "auggie-cli": "cli",
      cursor: "cli",
      windsurf: "cli",
      zed: "mcp",
      trae: "cli",
      qoder: "cli",
      antigravity: "cli",
      cline: "cli",
      "github-copilot": "cli",
      "roo-code": "cli",
      "kilo-code": "cli",
      "augment-code": "cli",
      amp: "cli",
      kiro: "cli",
      junie: "cli",
      openclaw: "cli",
    };

    expect(Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.defaultTransport]))).toEqual(expectedDefaults);
    expect(findAgent("cline")?.capabilities.mcp).toBeUndefined();
    expect(findAgent("augment-code")?.capabilities.mcp).toBeUndefined();
    expect(findAgent("codex")?.capabilities.cli.nativeHook).toBe(true);
    expect(findAgent("codex")?.capabilities.cli.guidance).toEqual(["skill"]);
    expect(findAgent("openclaw")?.capabilities.cli.guidance).toEqual(["skill"]);
  });

  it("resolves explicit, stored, and default transport choices and fails closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-resolution-"));
    const configPath = join(directory, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        unrelated: { keep: true },
        connectors: { transports: { codex: "mcp" } },
      }), { mode: 0o600 });

      expect(resolveAgentTransport("codex", undefined, { configPath })).toMatchObject({
        transport: "mcp",
        source: "stored",
      });
      expect(resolveAgentTransport("codex", "cli", { configPath })).toMatchObject({
        transport: "cli",
        source: "explicit",
      });
      expect(resolveAgentTransport("cursor", undefined, { configPath })).toMatchObject({
        transport: "cli",
        source: "default",
      });

      expect(() => resolveAgentTransport("codex", "unsupported" as never, { configPath }))
        .toThrow(/choose cli or mcp/);
      expect(() => resolveAgentTransport("cline", "mcp", { configPath }))
        .toThrow(/does not support connector transport/);

      writeFileSync(configPath, JSON.stringify({ connectors: { transports: { codex: "invalid" } } }), { mode: 0o600 });
      expect(() => resolveAgentTransport("codex", undefined, { configPath })).toThrow(/unsupported|invalid|one of/i);

      writeFileSync(configPath, JSON.stringify({ connectors: { transports: { cline: "mcp" } } }), { mode: 0o600 });
      expect(() => resolveAgentTransport("cline", undefined, { configPath }))
        .toThrow('Stored connector transport "mcp" is unsupported for agent "Cline"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists and clears a transport without disturbing unrelated configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-config-"));
    const configPath = join(directory, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({ version: 1, unrelated: { keep: true } }), { mode: 0o600 });
      setConnectorTransport(configPath, "codex", "cli");
      expect(readConnectorTransport(configPath, "codex")).toBe("cli");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        version: 1,
        unrelated: { keep: true },
        connectors: { transports: { codex: "cli" } },
      });
      clearConnectorTransport(configPath, "codex");
      expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ version: 1, unrelated: { keep: true } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs a CLI bundle and removes the complete owned bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-bundle-"));
    try {
      const phases: string[] = [];
      const options: ConnectorInstallerOptions = { configPath: join(directory, "config.json"), onPhase: (phase) => phases.push(phase) };
      const installed = installConnector("cursor", "cli", directory, options);
      expect(installed.success).toBe(true);
      expect(installed.transport).toBe("cli");
      expect(phases).toEqual(["snapshot", "stage", "verify", "remove-superseded", "persist", "complete"]);
      expect(installed.paths.some((path) => path.endsWith("SKILL.md"))).toBe(true);
      expect(existsSync(join(directory, ".cursor", "mcp.json"))).toBe(false);
      expect(removeConnector("cursor", directory, options)).toMatchObject({ success: true });
      expect(existsSync(join(directory, ".cursor", "skills", "lcm-memory", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs guidance bytes for the selected transport", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-guidance-"));
    try {
      const mcp = installConnector("cursor", "mcp", directory, {
        configPath: join(directory, "config.json"),
      });
      const skillPath = mcp.paths.find((path) => path.endsWith("SKILL.md"));
      expect(skillPath).toBeDefined();
      const skill = readFileSync(skillPath!, "utf8");
      expect(skill).toContain("lcm_search");
      expect(skill).not.toMatch(/\blcm\s+(?:search|grep|describe|expand|store|doctor)\b/iu);

      installConnector("cursor", "cli", directory, {
        configPath: join(directory, "config.json"),
      });
      const switched = readFileSync(skillPath!, "utf8");
      expect(switched).toContain("lcm search");
      expect(switched).not.toContain("lcm_search");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an explicit Codex CLI bundle to native hook, skill, and minimal rules", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-codex-cli-bundle-"));
    const home = join(directory, "home");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = installConnector("codex", "cli", directory, {
        configPath: join(directory, "config.json"),
        codexMcpRunner: { get: () => [], add: () => undefined, remove: () => undefined },
      });
      expect(result.paths).toHaveLength(3);
      expect(result.paths.some((path) => path.endsWith("hooks.json"))).toBe(true);
      expect(result.paths.some((path) => path.endsWith("SKILL.md"))).toBe(true);
      expect(result.paths.some((path) => path.endsWith("AGENTS.md"))).toBe(true);
      expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe(
        "<!-- lcm -->\n"
        + "**Before starting any substantive kind of work** or when needing to gather further project understanding, **use the $lcm-memory skill**.\n"
        + "<!-- lcm -->\n",
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes only the managed Codex rule when converging from CLI to MCP", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-codex-mcp-convergence-"));
    const home = join(directory, "home");
    const configPath = join(directory, "config.json");
    const rulesPath = join(home, ".codex", "AGENTS.md");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    let entries: readonly Record<string, unknown>[] = [];
    const runner = {
      get: () => entries,
      add: () => { entries = [{
        name: "lcm",
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: null },
        enabled_tools: null,
        disabled_tools: null,
        startup_timeout_sec: null,
        tool_timeout_sec: null,
      }]; },
      remove: () => { entries = []; },
    };
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(rulesPath, "Personal Codex rules");
      installConnector("codex", "cli", directory, { configPath, codexMcpRunner: runner });
      expect(readFileSync(rulesPath, "utf8")).toContain("use the $lcm-memory skill");

      const result = installConnector("codex", "mcp", directory, { configPath, codexMcpRunner: runner });

      expect(result.paths.some((path) => path.endsWith("AGENTS.md"))).toBe(false);
      expect(readFileSync(rulesPath, "utf8")).toBe("Personal Codex rules\n");
      expect(entries).toHaveLength(1);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores prior Codex AGENTS.md bytes when CLI bundle verification rolls back", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-codex-rules-rollback-"));
    const home = join(directory, "home");
    const configPath = join(directory, "config.json");
    const rulesPath = join(home, ".codex", "AGENTS.md");
    const original = "Personal Codex rules without a terminal newline";
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(rulesPath, original);

      expect(() => installConnector("codex", "cli", directory, {
        configPath,
        codexMcpRunner: { get: () => [], add: () => undefined, remove: () => undefined },
        failAt: "complete",
      })).toThrow("Injected connector installer failure at complete");

      expect(readFileSync(rulesPath, "utf8")).toBe(original);
      expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not persist a resolved default, but persists an explicit transport", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-persistence-"));
    const configPath = join(directory, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({ version: 1, unrelated: { keep: true } }) + "\n", { mode: 0o600 });
      installConnector("cursor", undefined, directory, { configPath });
      expect(readConnectorTransport(configPath, "cursor")).toBeUndefined();
      expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify({ version: 1, unrelated: { keep: true } }) + "\n");

      installConnector("cursor", "cli", directory, { configPath });
      expect(readConnectorTransport(configPath, "cursor")).toBe("cli");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not rewrite a stored transport while installing its resolved bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-stored-"));
    const configPath = join(directory, "config.json");
    try {
      setConnectorTransport(configPath, "cursor", "cli");
      const before = readFileSync(configPath, "utf8");
      installConnector("cursor", undefined, directory, { configPath });
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("orders convergence phases and rolls back every injected failure phase", () => {
    const phases = ["snapshot", "stage", "verify", "remove-superseded", "persist", "complete"] as const;
    for (const failAt of phases) {
      const directory = mkdtempSync(join(tmpdir(), `lcm-transport-rollback-${failAt}-`));
      const configPath = join(directory, "config.json");
      const skillPath = join(directory, ".cursor", "skills", "lcm-memory", "SKILL.md");
      const mcpPath = join(directory, ".cursor", "mcp.json");
        const priorSkill = renderGuidance("skill", "mcp");
      try {
        writeFileSync(configPath, JSON.stringify({ connectors: { transports: { cursor: "mcp" } } }) + "\n", { mode: 0o600 });
        mkdirSync(join(directory, ".cursor", "skills", "lcm-memory"), { recursive: true });
        writeFileSync(skillPath, priorSkill);
        mkdirSync(join(directory, ".cursor"), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lcm: { type: "stdio", command: "lcm", args: ["mcp"] } } }, null, 2) + "\n");
        const seen: string[] = [];
        expect(() => installConnector("cursor", "cli", directory, {
          configPath,
          failAt,
          onPhase: (phase) => seen.push(phase),
        })).toThrow(`Injected connector installer failure at ${failAt}`);
        expect(seen).toEqual(phases.slice(0, phases.indexOf(failAt) + 1));
        expect(readFileSync(skillPath, "utf8")).toBe(priorSkill);
        expect(readFileSync(mcpPath, "utf8")).toContain('"lcm"');
        expect(readConnectorTransport(configPath, "cursor")).toBe("mcp");
        expect(readdirSync(directory, { recursive: true }).filter((entry) => String(entry).includes(".lcm-connector-txn-"))).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("refuses a JSON MCP collision and preserves the complete prior bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-mcp-collision-"));
    const configPath = join(directory, "config.json");
    const mcpPath = join(directory, ".mcp.json");
    try {
      setConnectorTransport(configPath, "claude-code", "mcp");
      const collision = JSON.stringify({ mcpServers: { lcm: { type: "sse", url: "https://example.invalid" }, other: { command: "other" } } }, null, 2) + "\n";
      writeFileSync(mcpPath, collision);
      expect(() => installConnector("claude-code", "mcp", directory, { configPath })).toThrow(/Refusing to overwrite/);
      expect(readFileSync(mcpPath, "utf8")).toBe(collision);
      expect(readConnectorTransport(configPath, "claude-code")).toBe("mcp");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a bundle removal collision without clearing stored transport", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-remove-collision-"));
    const configPath = join(directory, "config.json");
    const mcpPath = join(directory, ".mcp.json");
    try {
      setConnectorTransport(configPath, "claude-code", "mcp");
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lcm: { type: "sse", url: "https://example.invalid" } } }, null, 2) + "\n");
      const result = removeConnector("claude-code", directory, { configPath });
      expect(result).toMatchObject({ success: false, removed: false });
      expect(result).toEqual(expect.objectContaining({ failures: expect.arrayContaining([expect.stringMatching(/mcp:.*Refusing/)]) }));
      expect(readConnectorTransport(configPath, "claude-code")).toBe("mcp");
      expect(readFileSync(mcpPath, "utf8")).toContain("https://example.invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes a stored Codex CLI bundle's exact stale MCP entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-codex-stored-"));
    const home = join(directory, "home");
    const configPath = join(directory, "config.json");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(home, { recursive: true });
      setConnectorTransport(configPath, "codex", "cli");
      let present = true;
      const runner = {
        get: () => present ? [{
          name: "lcm",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: null },
          enabled_tools: null,
          disabled_tools: null,
          startup_timeout_sec: null,
          tool_timeout_sec: null,
        }] : [],
        add: () => { throw new Error("unexpected add"); },
        remove: () => { present = false; },
      };
      installConnector("codex", undefined, directory, { configPath, codexMcpRunner: runner, queryCodexMcp: false });
      expect(present).toBe(false);
      expect(readConnectorTransport(configPath, "codex")).toBe("cli");
      expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain(
        "use the $lcm-memory skill",
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores prior Codex MCP presence through the injected rollback seam", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-transport-codex-rollback-"));
    const home = join(directory, "home");
    const configPath = join(directory, "config.json");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(home, { recursive: true });
      let entries: readonly Record<string, unknown>[] = [];
      let restores = 0;
      const runner = {
        get: () => entries,
        add: () => { entries = [{
          name: "lcm",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: null },
          enabled_tools: null,
          disabled_tools: null,
          startup_timeout_sec: null,
          tool_timeout_sec: null,
        }]; },
        remove: () => { entries = []; },
        restore: (prior: readonly Record<string, unknown>[]) => { restores += 1; entries = [...prior]; },
      };
      expect(() => installConnector("codex", "mcp", directory, {
        configPath,
        codexMcpRunner: runner,
        failAt: "complete",
      })).toThrow("Injected connector installer failure at complete");
      expect(restores).toBe(1);
      expect(entries).toEqual([]);
      expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
