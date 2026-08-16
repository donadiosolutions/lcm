import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import {
  installConnector,
  listConnectorInventory,
  removeConnector,
} from "../../src/connectors/installer.js";
import { AGENTS } from "../../src/connectors/registry.js";
import { setConnectorTransport } from "../../src/config-manager.js";

let directory: string;

function codexEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

function withTempHome<T>(callback: (cwd: string, home: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-installer-coverage-home-"));
  const home = join(cwd, "home");
  mkdirSync(home);
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return callback(cwd, home);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function withGeneratedContent<T>(content: string, callback: (install: typeof installConnector) => T): Promise<T> {
  vi.resetModules();
  vi.doMock("../../src/connectors/template-service.js", () => ({ generateContent: () => content }));
  try {
    const module = await import("../../src/connectors/installer.js");
    return callback(module.installConnector);
  } finally {
    vi.doUnmock("../../src/connectors/template-service.js");
    vi.resetModules();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-installer-coverage-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("installer defensive branches", () => {
  it("handles malformed and unterminated skill frontmatter", async () => {
    await withGeneratedContent("---\nname: lcm\n", (install) => {
      expect(() => install("claude-code", "skill", directory)).not.toThrow();
    });
    rmSync(join(directory, ".claude"), { recursive: true, force: true });
    await withGeneratedContent("---", (install) => {
      expect(() => install("claude-code", "skill", directory)).not.toThrow();
    });
    rmSync(join(directory, ".claude"), { recursive: true, force: true });
    await withGeneratedContent("----\nname: lcm\n", (install) => {
      expect(() => install("claude-code", "skill", directory)).not.toThrow();
    });
    rmSync(join(directory, ".claude"), { recursive: true, force: true });
    await withGeneratedContent("---\n---\n", (install) => {
      expect(() => install("claude-code", "skill", directory)).not.toThrow();
    });
  });

  it("handles non-file and unowned skills in strict and compatibility removal modes", () => {
    const skillPath = join(directory, ".claude", "skills", "lcm-memory", "SKILL.md");
    mkdirSync(skillPath, { recursive: true });
    expect(removeConnector("claude-code", "skill", directory)).toBe(false);
    const strictSkillRemoval = removeConnector("claude-code", { cwd: directory, configPath: join(directory, "config.json") });
    expect(strictSkillRemoval).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/unowned LCM skill|overwrite an unowned/iu)]),
    }));

    rmSync(skillPath, { recursive: true, force: true });
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "# user-owned skill\n");
    expect(removeConnector("claude-code", "skill", directory)).toBe(false);

    // Exercise the frontmatter terminator-at-EOF branch while preserving the
    // user-owned file (it must not be removed as an LCM skill).
    writeFileSync(skillPath, "---\n---");
    expect(removeConnector("claude-code", "skill", directory)).toBe(false);
  });

  it("covers strict and compatibility MCP shape handling", () => {
    const mcpPath = join(directory, ".mcp.json");
    for (const content of ["null", "[]", JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: { lcm: { type: "sse" } } })]) {
      writeFileSync(mcpPath, content);
      expect(removeConnector("claude-code", "mcp", directory)).toBe(false);
    }

    writeFileSync(mcpPath, "null");
    const strictNullRemoval = removeConnector("claude-code", { cwd: directory, configPath: join(directory, "config.json") });
    expect(strictNullRemoval).toMatchObject({ success: false });
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }));
    expect(removeConnector("claude-code", { cwd: directory, configPath: join(directory, "config.json") })).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/mcpServers must contain a JSON object/iu)]),
    }));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { lcm: { type: "sse" } } }));
    expect(removeConnector("claude-code", { cwd: directory, configPath: join(directory, "config.json") })).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/Refusing to remove/iu)]),
    }));

    rmSync(mcpPath, { force: true });
    mkdirSync(mcpPath, { recursive: true });
    expect(() => installConnector("claude-code", "mcp", directory)).toThrow();

    rmSync(mcpPath, { recursive: true, force: true });
    writeFileSync(mcpPath, "invalid");
    expect(() => installConnector("claude-code", "mcp", directory, {
      configPath: join(directory, "config.json"),
    })).toThrow(/not valid JSON|Unexpected token/iu);

    writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }));
    expect(() => installConnector("claude-code", "mcp", directory, {
      configPath: join(directory, "config.json"),
    })).toThrow(/mcpServers must contain a JSON object/iu);

    writeFileSync(mcpPath, "invalid");
    expect(removeConnector("claude-code", { cwd: directory, configPath: join(directory, "config.json") })).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/Unable to parse MCP configuration/iu)]),
    }));
  });

  it("uses the legacy MCP default for an agent outside the CLI list", () => {
    const result = installConnector("zed", undefined, directory);
    expect(result.success).toBe(true);
    expect(removeConnector("zed", undefined, directory)).toBe(true);
  });

  it("uses the process cwd when the legacy caller omits installer options", () => {
    const originalCwd = process.cwd();
    process.chdir(directory);
    try {
      expect(installConnector("cursor").success).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("covers a rules fallback when a listed agent has no skill path", () => {
    const agent = AGENTS.find((candidate) => candidate.id === "github-copilot")!;
    const original = agent.configPaths.skill;
    delete agent.configPaths.skill;
    try {
      expect(installConnector("github-copilot", undefined, directory).success).toBe(true);
    } finally {
      agent.configPaths.skill = original;
    }
  });

  it("rejects an MCP install with a non-object config path read failure", () => {
    const mcpPath = join(directory, ".mcp.json");
    mkdirSync(mcpPath, { recursive: true });
    expect(() => installConnector("claude-code", "mcp", directory)).toThrow();
  });

  it("covers native default runner normalization and process result coercion", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 0,
        stdout: Buffer.from(JSON.stringify(codexEntry())),
        stderr: Buffer.from(""),
      })),
    }));
    try {
      const module = await import("../../src/connectors/installer.js");
      withTempHome((cwd) => {
        expect(module.installConnector("codex", "mcp", cwd, {
          configPath: join(cwd, "config.json"),
          persistTransport: false,
        })).toMatchObject({ success: true, transport: "mcp" });
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("handles unsupported native process fields and Error results", async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 1,
            stdout: { unsupported: true },
            stderr: undefined,
            error: new Error("native runner error"),
          };
        }
        return {
          status: 1,
          stdout: { unsupported: true },
          stderr: undefined,
          error: undefined,
        };
      }),
    }));
    try {
      const module = await import("../../src/connectors/installer.js");
      withTempHome((cwd) => {
        expect(module.listConnectorInventory(cwd).codexMcp).toEqual({ state: "unknown", reason: "unavailable" });
        expect(module.listConnectorInventory(cwd).codexMcp).toEqual({ state: "unknown", reason: "unavailable" });
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("filters unsafe native environment values and supplies a fallback PATH", () => {
    withTempHome((cwd) => {
      const originalPath = process.env.PATH;
      const originalHome = process.env.HOME;
      const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
      process.env.PATH = "unsafe\npath";
      process.env.HOME = "";
      try {
        const inventory = listConnectorInventory(cwd, {
          codexCliRunner: (request) => {
            calls.push({ env: request.env });
            return { status: 1, stderr: "permission denied" };
          },
        });
        expect(inventory.codexMcp.state).toBe("unknown");
        expect(calls[0].env.PATH).toBe("/usr/bin:/bin");
        expect(calls[0].env.CODEX_HOME).toBe(".codex");
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });
  });

  it("injects filesystem races and failed readbacks through the public installer seams", async () => {
    let lstatMode: "normal" | "enoent" | "denied" = "normal";
    let readMode: "normal" | "tamper-skill" | "tamper-mcp" = "normal";
    let skillReads = 0;
    let mcpReads = 0;
    const skillPath = join(directory, ".claude", "skills", "lcm-memory", "SKILL.md");
    const mcpPath = join(directory, ".mcp.json");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const actualLstat = actual.lstatSync;
      const actualRead = actual.readFileSync;
      return {
        ...actual,
        lstatSync: ((path: fs.PathLike, ...args: unknown[]) => {
          if (String(path) === skillPath && lstatMode !== "normal") {
            throw Object.assign(new Error(lstatMode), { code: lstatMode === "enoent" ? "ENOENT" : "EACCES" });
          }
          return (actualLstat as (...values: unknown[]) => unknown)(path, ...args);
        }) as typeof actual.lstatSync,
        readFileSync: ((path: fs.PathLike, ...args: unknown[]) => {
          const value = (actualRead as (...values: unknown[]) => unknown)(path, ...args);
          if (String(path) === skillPath && readMode === "tamper-skill" && ++skillReads > 0) return Buffer.from("tampered");
          if (String(path) === mcpPath && readMode === "tamper-mcp" && ++mcpReads > 0) return Buffer.from(JSON.stringify({ mcpServers: {} }));
          return value;
        }) as typeof actual.readFileSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "# existing\n");
      lstatMode = "denied";
      expect(() => module.installConnector("claude-code", "skill", directory)).toThrow(/Unable to inspect LCM skill/iu);
      lstatMode = "enoent";
      expect(module.removeConnector("claude-code", "skill", directory)).toBe(false);
      lstatMode = "denied";
      expect(() => module.removeConnector("claude-code", "skill", directory)).toThrow(/Unable to inspect LCM skill/iu);

      lstatMode = "normal";
      rmSync(skillPath, { force: true });
      readMode = "tamper-skill";
      expect(() => module.installConnector("claude-code", "skill", directory)).toThrow(/ownership verification/iu);

      readMode = "normal";
      rmSync(mcpPath, { force: true });
      readMode = "tamper-mcp";
      expect(() => module.installConnector("claude-code", "mcp", directory)).toThrow(/ownership verification/iu);

      lstatMode = "denied";
      const inventory = module.listConnectorInventory(directory);
      expect(inventory.installed.some((entry) => entry.agentId === "claude-code" && entry.type === "skill")).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("classifies low-level runner failures and both runner error detail fallbacks", () => {
    withTempHome((cwd) => {
      const errorCases: Array<{ result: Record<string, unknown>; message: string }> = [
        { result: { status: 0, error: { name: "Named" } }, message: "Named" },
        { result: { status: 0, error: {} }, message: "unknown runner error" },
        { result: { status: 1, stderr: "" }, message: "status 1" },
      ];
      for (const { result, message } of errorCases) {
        const inventory = listConnectorInventory(cwd, {
          codexCliRunner: () => result as never,
        });
        expect(inventory.codexMcp).toEqual({ state: "unknown", reason: "unavailable" });
        expect(message).toBeTruthy();
      }

      for (const thrown of [new Error("thrown error"), "thrown string"]) {
        const inventory = listConnectorInventory(cwd, {
          codexCliRunner: () => { throw thrown; },
        });
        expect(inventory.codexMcp).toEqual({ state: "unknown", reason: "unavailable" });
      }
    });
  });

  it("normalizes every supported Codex JSON envelope and rejects malformed entries", () => {
    withTempHome((cwd) => {
      const body = codexEntry();
      const cases: unknown[] = [
        [null],
        { lcm: null },
        { servers: [{ ...body, name: "other" }] },
        { other: { ...body, name: "other" } },
        { other: null },
        1,
      ];
      for (const value of cases) {
        const inventory = listConnectorInventory(cwd, {
          codexCliRunner: () => ({ status: 0, stdout: JSON.stringify(value) }),
        });
        expect(inventory.codexMcp.state).toBe("unknown");
      }
      const installed = listConnectorInventory(cwd, {
        codexCliRunner: () => ({ status: 0, stdout: JSON.stringify({ lcm: body }) }),
      });
      expect(installed.codexMcp).toEqual({ state: "installed" });
    });
  });

  it("rejects each noncanonical Codex metadata and transport variant", () => {
    withTempHome((cwd) => {
      const variants: Record<string, unknown>[] = [
        { enabled: false },
        { disabled_reason: "disabled" },
        { enabled_tools: [] },
        { disabled_tools: [] },
        { startup_timeout_sec: 1 },
        { tool_timeout_sec: 1 },
        { transport: undefined },
        { transport: [] },
        { transport: { type: "sse", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: null } },
        { transport: { type: "stdio", command: "other", args: ["mcp"], env: null, env_vars: [], cwd: null } },
        { transport: { type: "stdio", command: "lcm", args: [], env: null, env_vars: [], cwd: null } },
        { transport: { type: "stdio", command: "lcm", args: ["other"], env: null, env_vars: [], cwd: null } },
        { transport: { type: "stdio", command: "lcm", args: ["mcp"], env: {}, env_vars: [], cwd: null } },
        { transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: ["X"], cwd: null } },
        { transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: "/tmp" } },
        { transport: { type: "stdio", command: "lcm", args: ["mcp"], env: null, env_vars: [], cwd: null, extra: true } },
        { extra: true },
      ];
      for (const variant of variants) {
        const inventory = listConnectorInventory(cwd, {
          codexCliRunner: () => ({ status: 0, stdout: JSON.stringify(codexEntry(variant)) }),
        });
        expect(inventory.codexMcp).toEqual({ state: "unknown", reason: "collision" });
      }
    });
  });

  it("exercises native compensation with add/remove fallback and failures", () => {
    withTempHome((cwd) => {
      let entries: readonly Record<string, unknown>[] = [];
      const runner = {
        get: () => entries,
        add: () => { entries = [codexEntry()]; },
        remove: () => { entries = []; },
      };
      expect(() => installConnector("codex", "mcp", cwd, {
        configPath: join(cwd, "config.json"),
        codexMcpRunner: runner,
        failAt: "complete",
      })).toThrow(/Injected connector installer failure/iu);
      expect(entries).toEqual([]);

      entries = [codexEntry()];
      expect(() => installConnector("codex", "cli", cwd, {
        configPath: join(cwd, "config.json"),
        codexMcpRunner: runner,
        failAt: "complete",
      })).toThrow(/Injected connector installer failure/iu);
      expect(entries).toHaveLength(1);

      entries = [];
      const mismatchingRunner = {
        get: () => entries,
        add: () => { entries = [codexEntry()]; },
        remove: () => undefined,
      };
      expect(() => installConnector("codex", "mcp", cwd, {
        configPath: join(cwd, "config-mismatch.json"),
        codexMcpRunner: mismatchingRunner,
        failAt: "complete",
      })).toThrow(/rollback incomplete/iu);
    });
  });

  it("covers malformed current compensation and non-file snapshots", () => {
    withTempHome((cwd) => {
      let entries: readonly Record<string, unknown>[] = [];
      const runner = {
        get: () => entries,
        add: () => { entries = [codexEntry()]; },
        remove: () => { entries = []; },
      };
      expect(() => installConnector("codex", "mcp", cwd, {
        configPath: join(cwd, "config.json"),
        codexMcpRunner: runner,
        failAt: "complete",
        onPhase: (phase) => {
          if (phase === "complete") entries = [codexEntry({ transport: { type: "stdio", command: "other" } })];
        },
      })).toThrow(/rollback incomplete.*safely removable/iu);

      const skillPath = join(cwd, ".cursor", "skills", "lcm-memory", "SKILL.md");
      mkdirSync(skillPath, { recursive: true });
      expect(() => installConnector("cursor", "cli", cwd, { configPath: join(cwd, "config.json") }))
        .toThrow(/skill|collision/iu);

      rmSync(skillPath, { recursive: true, force: true });
      const nonFileRulesPath = join(cwd, ".cursor", "rules", "lcm.mdc");
      mkdirSync(nonFileRulesPath, { recursive: true });
      expect(() => installConnector("cursor", "cli", cwd, {
        configPath: join(cwd, "config-non-file.json"),
        failAt: "complete",
        persistTransport: false,
      })).toThrow(/Injected connector installer failure/iu);
      expect(existsSync(nonFileRulesPath)).toBe(true);
    });
  });

  it("covers Codex verification, removal, and rules verification failures", () => {
    withTempHome((cwd) => {
      let gets = 0;
      const runner = {
        get: () => {
          gets += 1;
          if (gets === 4) return [];
          return gets === 1 ? [] : [codexEntry()];
        },
        add: () => undefined,
        remove: () => undefined,
      };
      expect(() => installConnector("codex", "mcp", cwd, {
        configPath: join(cwd, "config.json"),
        codexMcpRunner: runner,
        persistTransport: false,
      })).toThrow(/verification/iu);

      const badRunner = {
        get: () => [codexEntry({ transport: { type: "sse" } })],
        add: () => undefined,
        remove: () => undefined,
      };
      expect(removeConnector("codex", { cwd, codexMcpRunner: badRunner })).toEqual(expect.objectContaining({
        success: false,
        failures: expect.arrayContaining([expect.stringMatching(/unverified Codex MCP/iu)]),
      }));

      const configPath = join(cwd, "config.json");
      expect(() => installConnector("claude-code", "mcp", cwd, { configPath })).not.toThrow();

      const hookPath = join(cwd, "home", ".codex", "hooks.json");
      expect(() => installConnector("codex", "cli", cwd, {
        configPath: join(cwd, "codex-config.json"),
        codexMcpRunner: { get: () => [], add: () => undefined, remove: () => undefined },
        onPhase: (phase) => { if (phase === "verify") rmSync(hookPath, { force: true }); },
        persistTransport: false,
      })).toThrow(/Installed hook is missing/iu);

      const rulesPath = join(cwd, ".clinerules", "lcm.md");
      expect(() => installConnector("cline", "cli", cwd, {
        configPath: join(cwd, "cline-config.json"),
        onPhase: (phase) => { if (phase === "verify") rmSync(rulesPath, { force: true }); },
      })).toThrow(/Installed rules are missing/iu);

      expect(() => installConnector("cline", "cli", cwd, {
        configPath: join(cwd, "cline-config-2.json"),
        onPhase: (phase) => { if (phase === "verify") writeFileSync(rulesPath, "user content\n"); },
      })).toThrow(/Installed rules failed ownership/iu);
    });
  });

  it("covers verification races and unsupported bundle states", () => {
    const configPath = join(directory, "config.json");
    const skillPath = join(directory, ".cursor", "skills", "lcm-memory", "SKILL.md");
    const mcpPath = join(directory, ".cursor", "mcp.json");
    const mutateAtVerify = (kind: "missing-skill" | "wrong-skill" | "missing-mcp" | "wrong-mcp") => {
      expect(() => installConnector("cursor", "mcp", directory, {
        configPath,
        onPhase: (phase) => {
          if (phase !== "verify") return;
          if (kind === "missing-skill") rmSync(skillPath, { force: true });
          if (kind === "wrong-skill") writeFileSync(skillPath, "wrong");
          if (kind === "missing-mcp") rmSync(mcpPath, { force: true });
          if (kind === "wrong-mcp") writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
        },
      })).toThrow();
    };
    mutateAtVerify("missing-skill");
    mutateAtVerify("wrong-skill");
    mutateAtVerify("missing-mcp");
    mutateAtVerify("wrong-mcp");

    const agent = AGENTS.find((candidate) => candidate.id === "cursor")!;
    const originalDescriptor = Object.getOwnPropertyDescriptor(agent, "capabilities");
    const original = agent.capabilities;
    let access = 0;
    Object.defineProperty(agent, "capabilities", {
      configurable: true,
      get: () => {
        access += 1;
        return access === 1 ? original : { ...original, cli: undefined };
      },
    });
    try {
      expect(() => installConnector("cursor", "cli", directory, { configPath })).toThrow(/does not support/iu);
    } finally {
      Object.defineProperty(agent, "capabilities", originalDescriptor!);
    }

    access = 0;
    Object.defineProperty(agent, "capabilities", {
      configurable: true,
      get: () => {
        access += 1;
        return access === 1 ? original : { ...original, cli: { guidance: [] } };
      },
    });
    try {
      expect(() => installConnector("cursor", "cli", directory, { configPath })).toThrow(/no guidance/iu);
    } finally {
      Object.defineProperty(agent, "capabilities", originalDescriptor!);
    }
  });

  it("fails closed when a target path disappears before verification", () => {
    const agent = AGENTS.find((candidate) => candidate.id === "cursor")!;
    const originalSkillPath = agent.configPaths.skill;
    try {
      expect(() => installConnector("cursor", "cli", directory, {
        configPath: join(directory, "verify-path-config.json"),
        persistTransport: false,
        onPhase: (phase) => {
          if (phase === "verify") delete agent.configPaths.skill;
        },
      })).toThrow(/No config path defined for Cursor with type skill/iu);
    } finally {
      agent.configPaths.skill = originalSkillPath;
    }
  });

  it("reports Codex readback failure while compensating a failed install", () => {
    withTempHome((cwd) => {
      let failNextGet = false;
      let entries: readonly Record<string, unknown>[] = [];
      const runner = {
        get: () => {
          if (failNextGet) {
            failNextGet = false;
            throw new Error("Codex state readback failed");
          }
          return entries;
        },
        add: () => {
          failNextGet = true;
          throw new Error("Codex add failed");
        },
        remove: () => { entries = []; },
      };
      expect(() => installConnector("codex", "mcp", cwd, {
        codexMcpRunner: runner,
        configPath: join(cwd, "codex-readback-config.json"),
        persistTransport: false,
      })).toThrow(/rollback incomplete.*Codex MCP state readback/iu);
    });
  });

  it("reports owned-file compensation readback mismatch", async () => {
    const skillPath = join(directory, ".cursor", "skills", "lcm-memory", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "---\n---\n<!-- lcm-managed-skill:v1 -->\n");

    let tamperRestore = false;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const actualWrite = actual.writeFileSync;
      return {
        ...actual,
        writeFileSync: ((path: fs.PathLike, data: unknown, options?: unknown) => {
          if (tamperRestore && String(path) === skillPath) {
            return actualWrite(path, Buffer.from("tampered"), options as never);
          }
          return actualWrite(path, data as never, options as never);
        }) as typeof actual.writeFileSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      expect(() => module.installConnector("cursor", "cli", directory, {
        configPath: join(directory, "file-compensation-config.json"),
        persistTransport: false,
        failAt: "complete",
        onPhase: (phase) => {
          if (phase === "complete") tamperRestore = true;
        },
      })).toThrow(/rollback incomplete.*owned state/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("covers argument, transport, removal, and inventory fallbacks", () => {
    expect(installConnector("cursor", undefined, { configPath: join(directory, "object-config.json") }).success).toBe(true);
    const configPath = join(directory, "config.json");
    expect(() => installConnector("cursor", "bogus" as never, directory, { configPath })).toThrow(/choose cli or mcp/iu);
    expect(() => installConnector("cursor", "rules", directory)).not.toThrow();
    expect(() => installConnector("cursor", "cli", directory, {
      configPath: join(directory, "string-error-config.json"),
      onPhase: () => { throw "phase string"; },
    })).toThrow(/phase string/iu);
    expect(removeConnector("cline", { cwd: directory, configPath: join(directory, "cline-config.json") })).toMatchObject({ success: true });
    expect(removeConnector("claude-code", "rules")).toBe(false);

    const codexFailure = removeConnector("codex", {
      cwd: directory,
      codexMcpRunner: { get: () => { throw "native get failed"; }, add: () => undefined, remove: () => undefined },
    });
    expect(codexFailure).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/native get failed/iu)]),
    }));

    const configDirectory = join(directory, "config-directory");
    mkdirSync(configDirectory);
    expect(removeConnector("cursor", { cwd: directory, configPath: configDirectory })).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining([expect.stringMatching(/transport config/iu)]),
    }));

    const originalAgents = [...AGENTS];
    const codex = AGENTS.findIndex((agent) => agent.id === "codex");
    const codexAgent = AGENTS[codex];
    AGENTS.splice(codex, 1);
    try {
      expect(listConnectorInventory(directory, {
        codexMcpRunner: { get: () => [codexEntry()], add: () => undefined, remove: () => undefined },
      }).codexMcp).toEqual({ state: "installed" });
    } finally {
      AGENTS.splice(0, AGENTS.length, ...originalAgents);
      expect(codexAgent.id).toBe("codex");
    }

    setConnectorTransport(join(directory, "config.json"), "cursor", "cli");
  });

  it("reports a transport-config compensation readback mismatch", async () => {
    const configPath = join(directory, "transport-compensation-config.json");
    writeFileSync(configPath, JSON.stringify({ connectors: { transports: { cursor: "cli" } } }) + "\n", { mode: 0o600 });
    let reads = 0;
    vi.resetModules();
    vi.doMock("../../src/config-manager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/config-manager.js")>("../../src/config-manager.js");
      return {
        ...actual,
        readConnectorTransport: ((path: string, agentId: string) => {
          reads += 1;
          const value = actual.readConnectorTransport(path, agentId);
          return reads >= 2 ? "mcp" : value;
        }) as typeof actual.readConnectorTransport,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      expect(() => module.installConnector("cursor", "mcp", directory, {
        configPath,
        failAt: "complete",
      })).toThrow(/rollback incomplete.*transport config/iu);
    } finally {
      vi.doUnmock("../../src/config-manager.js");
      vi.resetModules();
    }
  });

  it("uses the default Codex MCP runner when no runner seam is supplied", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({
        status: 1,
        stderr: "No MCP server named 'lcm' found.",
      })),
    }));
    try {
      const module = await import("../../src/connectors/installer.js");
      withTempHome((cwd) => {
        expect(module.removeConnector("codex", { cwd })).toMatchObject({ success: true, removed: false });
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("formats non-Error transport cleanup failures without throwing", async () => {
    vi.resetModules();
    vi.doMock("../../src/config-manager.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/config-manager.js")>("../../src/config-manager.js");
      return { ...actual, clearConnectorTransport: () => { throw "string cleanup failure"; } };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      const result = module.removeConnector("cline", { cwd: directory, configPath: join(directory, "string-cleanup-config.json") });
      expect(result).toEqual(expect.objectContaining({
        success: false,
        failures: ["transport config: string cleanup failure"],
      }));
    } finally {
      vi.doUnmock("../../src/config-manager.js");
      vi.resetModules();
    }
  });
});
