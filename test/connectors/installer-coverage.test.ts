import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

  it("uses the process cwd when object installer options omit cwd", () => {
    const originalCwd = process.cwd();
    process.chdir(directory);
    try {
      expect(installConnector("cursor", undefined, {
        configPath: join(directory, "object-fallback-config.json"),
      }).success).toBe(true);
      expect(existsSync(join(directory, ".cursor", "skills", "lcm-memory", "SKILL.md"))).toBe(true);
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
    let openMode: "normal" | "enoent" | "denied" = "normal";
    let readMode: "normal" | "tamper-skill" | "tamper-mcp" = "normal";
    let skillReads = 0;
    let mcpReads = 0;
    const skillPath = join(directory, ".claude", "skills", "lcm-memory", "SKILL.md");
    const mcpPath = join(directory, ".mcp.json");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const descriptors = new Map<number, string>();
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          if (String(path) === skillPath && openMode !== "normal") {
            throw Object.assign(new Error(openMode), { code: openMode === "enoent" ? "ENOENT" : "EACCES" });
          }
          const descriptor = mode === undefined
            ? actual.openSync(path, flags)
            : actual.openSync(path, flags, mode);
          descriptors.set(descriptor, String(path));
          return descriptor;
        }) as typeof actual.openSync,
        readSync: ((descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
          const bytesRead = actual.readSync(descriptor, buffer, offset, length, position);
          const path = descriptors.get(descriptor);
          const tamper = path === skillPath && readMode === "tamper-skill" && ++skillReads > 0
            ? Buffer.from("tampered")
            : path === mcpPath && readMode === "tamper-mcp" && ++mcpReads > 0
              ? Buffer.from(JSON.stringify({ mcpServers: {} }))
              : undefined;
          if (tamper !== undefined) {
            buffer.fill(0x20, offset, offset + bytesRead);
            tamper.copy(buffer, offset, 0, Math.min(tamper.length, bytesRead));
            return bytesRead;
          }
          return bytesRead;
        }) as typeof actual.readSync,
        closeSync: ((descriptor: number) => {
          descriptors.delete(descriptor);
          return actual.closeSync(descriptor);
        }) as typeof actual.closeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "# existing\n");
      openMode = "denied";
      expect(() => module.installConnector("claude-code", "skill", directory)).toThrow(/Unable to inspect LCM skill/iu);
      openMode = "enoent";
      expect(module.removeConnector("claude-code", "skill", directory)).toBe(false);
      openMode = "denied";
      expect(() => module.removeConnector("claude-code", "skill", directory)).toThrow(/Unable to inspect LCM skill/iu);

      openMode = "normal";
      rmSync(skillPath, { force: true });
      readMode = "tamper-skill";
      expect(() => module.installConnector("claude-code", "skill", directory)).toThrow(/ownership verification/iu);

      readMode = "normal";
      rmSync(mcpPath, { force: true });
      readMode = "tamper-mcp";
      expect(() => module.installConnector("claude-code", "mcp", directory)).toThrow(/ownership verification/iu);

      openMode = "denied";
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
      const descriptors = new Map<number, string>();
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const descriptor = mode === undefined
            ? actual.openSync(path, flags)
            : actual.openSync(path, flags, mode);
          descriptors.set(descriptor, String(path));
          return descriptor;
        }) as typeof actual.openSync,
        closeSync: ((descriptor: number) => {
          descriptors.delete(descriptor);
          return actual.closeSync(descriptor);
        }) as typeof actual.closeSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (tamperRestore && descriptors.get(descriptor) === skillPath) {
            const tampered = Buffer.from("tampered");
            return actual.writeSync(descriptor, tampered, 0, tampered.length, position);
          }
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
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
    expect(installConnector("cursor", undefined, { cwd: directory, configPath: join(directory, "object-config.json") }).success).toBe(true);
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

  it("fails closed across descriptor read, write, path, and snapshot faults", async () => {
    type Fault = {
      path?: string;
      invalidSize?: boolean;
      partialRead?: boolean;
      zeroWrite?: boolean;
      createError?: string;
      lstatError?: string;
      unlinkError?: string;
      openReadErrorAt?: number;
      openReadCount?: number;
      oneShotOpenError?: string;
      oneShotOpenWithoutCode?: boolean;
      symlinkOnCreateTarget?: string;
      replaceOnCreateContent?: string;
      lstatReplacement?: string;
    };
    const fault: Fault = {};
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const descriptors = new Map<number, string>();
      const error = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const currentPath = String(path);
          const numericFlags = Number(flags);
          if (currentPath === fault.path && fault.oneShotOpenError) {
            const code = fault.oneShotOpenError;
            fault.oneShotOpenError = undefined;
            throw error(code);
          }
          if (currentPath === fault.path && fault.oneShotOpenWithoutCode) {
            fault.oneShotOpenWithoutCode = false;
            throw new Error("unclassified open failure");
          }
          if (currentPath === fault.path && fault.createError && (numericFlags & fs.constants.O_EXCL) !== 0) {
            throw error(fault.createError);
          }
          if (currentPath === fault.path && fault.symlinkOnCreateTarget
            && (numericFlags & fs.constants.O_EXCL) !== 0) {
            const target = fault.symlinkOnCreateTarget;
            fault.symlinkOnCreateTarget = undefined;
            actual.symlinkSync(target, currentPath);
          }
          if (currentPath === fault.path && fault.replaceOnCreateContent !== undefined
            && (numericFlags & fs.constants.O_EXCL) !== 0) {
            const content = fault.replaceOnCreateContent;
            fault.replaceOnCreateContent = undefined;
            actual.writeFileSync(currentPath, content);
          }
          if (currentPath === fault.path && fault.openReadErrorAt !== undefined
            && (numericFlags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY) {
            fault.openReadCount = (fault.openReadCount ?? 0) + 1;
            if (fault.openReadCount === fault.openReadErrorAt) throw error("EACCES");
          }
          const descriptor = mode === undefined
            ? actual.openSync(path, flags)
            : actual.openSync(path, flags, mode);
          descriptors.set(descriptor, currentPath);
          return descriptor;
        }) as typeof actual.openSync,
        closeSync: ((descriptor: number) => {
          descriptors.delete(descriptor);
          return actual.closeSync(descriptor);
        }) as typeof actual.closeSync,
        fstatSync: ((descriptor: number, options?: fs.StatOptions) => {
          const stats = actual.fstatSync(descriptor, options as never);
          if (descriptors.get(descriptor) !== fault.path || !fault.invalidSize) return stats;
          return new Proxy(stats, {
            get(target, property) {
              if (property === "size") return -1;
              return Reflect.get(target, property, target);
            },
          });
        }) as typeof actual.fstatSync,
        readSync: ((descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (descriptors.get(descriptor) === fault.path && fault.partialRead) {
            if (position !== 0) return 0;
            return actual.readSync(descriptor, buffer, offset, Math.max(0, length - 1), position);
          }
          return actual.readSync(descriptor, buffer, offset, length, position);
        }) as typeof actual.readSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (descriptors.get(descriptor) === fault.path && fault.zeroWrite) return 0;
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
        lstatSync: ((path: fs.PathLike, options?: fs.StatOptions) => {
          if (String(path) === fault.path && fault.lstatError) throw error(fault.lstatError);
          if (String(path) === fault.path && fault.lstatReplacement) {
            return actual.lstatSync(fault.lstatReplacement, options as never);
          }
          return actual.lstatSync(path, options as never);
        }) as typeof actual.lstatSync,
        unlinkSync: ((path: fs.PathLike) => {
          if (String(path) === fault.path && fault.unlinkError) throw error(fault.unlinkError);
          return actual.unlinkSync(path);
        }) as typeof actual.unlinkSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");

      const invalidRoot = join(directory, "invalid-size");
      fault.path = join(invalidRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      mkdirSync(dirname(fault.path), { recursive: true });
      writeFileSync(fault.path, "owned");
      fault.invalidSize = true;
      expect(module.listConnectorInventory(invalidRoot).installed).not.toContainEqual(expect.objectContaining({ path: fault.path }));
      fault.invalidSize = false;

      const partialRoot = join(directory, "partial-read");
      const installed = module.installConnector("claude-code", "skill", partialRoot);
      expect(module.installConnector("claude-code", "skill", partialRoot).success).toBe(true);
      fault.path = installed.path;
      fault.partialRead = true;
      expect(module.listConnectorInventory(partialRoot).installed).toContainEqual(expect.objectContaining({ path: installed.path }));
      fault.partialRead = false;

      const writeRoot = join(directory, "zero-write");
      fault.path = join(writeRoot, ".clinerules", "lcm.md");
      fault.zeroWrite = true;
      expect(() => module.installConnector("cline", "rules", writeRoot)).toThrow(/write made no progress/iu);
      fault.zeroWrite = false;
      rmSync(writeRoot, { recursive: true, force: true });

      const createRoot = join(directory, "create-error");
      fault.path = join(createRoot, ".clinerules", "lcm.md");
      fault.createError = "EACCES";
      expect(() => module.installConnector("cline", "rules", createRoot)).toThrow(/EACCES/iu);
      fault.createError = undefined;

      const replaceRoot = join(directory, "skill-replaced-before-open");
      const replaceInstalled = module.installConnector("claude-code", "skill", replaceRoot);
      fault.path = replaceInstalled.path;
      fault.replaceOnCreateContent = "user-owned replacement\n";
      expect(() => module.installConnector("claude-code", "skill", replaceRoot)).toThrow(/unowned LCM skill/iu);

      const symlinkInstallRoot = join(directory, "skill-symlink-install");
      fault.path = join(symlinkInstallRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      mkdirSync(dirname(fault.path), { recursive: true });
      const symlinkTarget = join(symlinkInstallRoot, "user-owned.md");
      writeFileSync(symlinkTarget, "user owned\n");
      fault.symlinkOnCreateTarget = symlinkTarget;
      expect(() => module.installConnector("claude-code", "skill", symlinkInstallRoot)).toThrow(/collision|overwrite/iu);

      const symlinkRemoveRoot = join(directory, "skill-symlink-remove");
      fault.path = join(symlinkRemoveRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      mkdirSync(dirname(fault.path), { recursive: true });
      const removeTarget = join(symlinkRemoveRoot, "user-owned.md");
      writeFileSync(removeTarget, "user owned\n");
      fs.symlinkSync(removeTarget, fault.path);
      expect(module.removeConnector("claude-code", "skill", symlinkRemoveRoot)).toBe(false);
      expect(module.removeConnector("claude-code", {
        cwd: symlinkRemoveRoot,
        configPath: join(symlinkRemoveRoot, "config.json"),
      })).toEqual(expect.objectContaining({
        success: false,
        failures: expect.arrayContaining([expect.stringMatching(/skill.*collision|skill.*overwrite/iu)]),
      }));

      const unclassifiedRemoveRoot = join(directory, "unclassified-remove-error");
      fault.path = join(unclassifiedRemoveRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      fault.oneShotOpenWithoutCode = true;
      expect(() => module.removeConnector("claude-code", "skill", unclassifiedRemoveRoot))
        .toThrow(/Unable to inspect LCM skill/iu);

      const skillCreateRoot = join(directory, "skill-create-error");
      fault.path = join(skillCreateRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      fault.createError = "EACCES";
      expect(() => module.installConnector("claude-code", "skill", skillCreateRoot)).toThrow(/EACCES/iu);
      fault.createError = undefined;

      const installMismatchRoot = join(directory, "install-path-mismatch");
      const installMismatchSkill = join(installMismatchRoot, ".claude", "skills", "lcm-memory", "SKILL.md");
      const installMismatchReplacement = join(installMismatchRoot, "replacement.md");
      mkdirSync(dirname(installMismatchReplacement), { recursive: true });
      writeFileSync(installMismatchReplacement, "replacement\n");
      fault.path = installMismatchSkill;
      fault.lstatReplacement = installMismatchReplacement;
      expect(() => module.installConnector("claude-code", "skill", installMismatchRoot))
        .toThrow(/path changed during ownership verification/iu);
      fault.lstatReplacement = undefined;

      const pathRoot = join(directory, "path-errors");
      const pathSkill = module.installConnector("claude-code", "skill", pathRoot).path;
      fault.path = pathSkill;
      fault.lstatError = "ENOENT";
      expect(module.removeConnector("claude-code", "skill", pathRoot)).toBe(false);
      fault.lstatError = "EACCES";
      expect(() => module.removeConnector("claude-code", "skill", pathRoot)).toThrow(/EACCES/iu);
      fault.lstatError = undefined;
      fault.unlinkError = "ENOENT";
      expect(module.removeConnector("claude-code", "skill", pathRoot)).toBe(false);
      fault.unlinkError = undefined;

      const mismatchRoot = join(directory, "strict-path-mismatch");
      const mismatchSkill = module.installConnector("claude-code", "skill", mismatchRoot).path;
      const mismatchReplacement = join(mismatchRoot, "replacement.md");
      writeFileSync(mismatchReplacement, "replacement\n");
      fault.path = mismatchSkill;
      fault.lstatReplacement = mismatchReplacement;
      expect(module.removeConnector("claude-code", {
        cwd: mismatchRoot,
        configPath: join(mismatchRoot, "config.json"),
      })).toEqual(expect.objectContaining({
        success: false,
        failures: expect.arrayContaining([expect.stringMatching(/changed LCM skill/iu)]),
      }));
      fault.lstatReplacement = undefined;

      const malformedMcpRoot = join(directory, "malformed-mcp-object");
      fault.path = undefined;
      const malformedMcpPath = join(malformedMcpRoot, ".mcp.json");
      mkdirSync(dirname(malformedMcpPath), { recursive: true });
      writeFileSync(malformedMcpPath, "[]\n");
      expect(module.installConnector("claude-code", "mcp", malformedMcpRoot).success).toBe(true);

      const unexpectedMcpRoot = join(directory, "unexpected-mcp-parse-error");
      const unexpectedMcpPath = join(unexpectedMcpRoot, ".mcp.json");
      mkdirSync(dirname(unexpectedMcpPath), { recursive: true });
      writeFileSync(unexpectedMcpPath, "{}\n");
      const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw new TypeError("unexpected parser failure"); });
      expect(() => module.installConnector("claude-code", "mcp", unexpectedMcpRoot))
        .toThrow(/unexpected parser failure/iu);
      parse.mockRestore();

      const verifyMcpRoot = join(directory, "verify-mcp-error");
      const verifyMcpPath = join(verifyMcpRoot, ".mcp.json");
      expect(() => module.installConnector("claude-code", "mcp", verifyMcpRoot, {
        configPath: join(verifyMcpRoot, "config.json"),
        persistTransport: false,
        onPhase: (phase) => {
          if (phase === "verify") {
            fault.path = verifyMcpPath;
            fault.oneShotOpenError = "EACCES";
          }
        },
      })).toThrow(/EACCES/iu);

      const verifySkillRoot = join(directory, "verify-skill-read-error");
      const verifySkillPath = join(verifySkillRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      expect(() => module.installConnector("cursor", "cli", verifySkillRoot, {
        configPath: join(verifySkillRoot, "config.json"),
        persistTransport: false,
        onPhase: (phase) => {
          if (phase === "verify") {
            fault.path = verifySkillPath;
            fault.oneShotOpenError = "EACCES";
          }
        },
      })).toThrow(/Installed skill is missing/iu);

      const snapshotLoopRoot = join(directory, "snapshot-loop");
      fault.path = join(snapshotLoopRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      fault.oneShotOpenError = "ELOOP";
      expect(module.installConnector("cursor", "cli", snapshotLoopRoot, {
        configPath: join(snapshotLoopRoot, "config.json"),
        persistTransport: false,
      }).success).toBe(true);

      const snapshotErrorRoot = join(directory, "snapshot-error");
      fault.path = join(snapshotErrorRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      fault.oneShotOpenError = "EACCES";
      expect(() => module.installConnector("cursor", "cli", snapshotErrorRoot, {
        configPath: join(snapshotErrorRoot, "config.json"),
        persistTransport: false,
      })).toThrow(/EACCES/iu);

      const snapshotUnclassifiedRoot = join(directory, "snapshot-unclassified-error");
      fault.path = join(snapshotUnclassifiedRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      fault.oneShotOpenWithoutCode = true;
      expect(() => module.installConnector("cursor", "cli", snapshotUnclassifiedRoot, {
        configPath: join(snapshotUnclassifiedRoot, "config.json"),
        persistTransport: false,
      })).toThrow(/unclassified open failure/iu);

      const rollbackRoot = join(directory, "rollback-open-error");
      fault.path = join(rollbackRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      expect(() => module.installConnector("cursor", "cli", rollbackRoot, {
        configPath: join(rollbackRoot, "config.json"),
        persistTransport: false,
        failAt: "complete",
        onPhase: (phase) => {
          if (phase === "complete") {
            fault.openReadCount = 0;
            fault.openReadErrorAt = 1;
          }
        },
      })).toThrow(/Injected connector installer failure/iu);
      fault.openReadErrorAt = undefined;

      const rollbackMismatchRoot = join(directory, "rollback-path-mismatch");
      fault.path = join(rollbackMismatchRoot, ".cursor", "skills", "lcm-memory", "SKILL.md");
      const rollbackReplacement = join(rollbackMismatchRoot, "replacement.md");
      mkdirSync(dirname(rollbackReplacement), { recursive: true });
      writeFileSync(rollbackReplacement, "replacement\n");
      expect(() => module.installConnector("cursor", "cli", rollbackMismatchRoot, {
        configPath: join(rollbackMismatchRoot, "config.json"),
        persistTransport: false,
        failAt: "complete",
        onPhase: (phase) => {
          if (phase === "complete") fault.lstatReplacement = rollbackReplacement;
        },
      })).toThrow(/Injected connector installer failure/iu);
      fault.lstatReplacement = undefined;
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("installer descriptor edge branches", () => {
  it("rejects an unsafe descriptor size and short descriptor reads", async () => {
    let invalidSize = true;
    let returnZero = false;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fstatSync: ((descriptor: number) => {
          const stats = actual.fstatSync(descriptor);
          if (invalidSize) {
            return new Proxy(stats, {
              get(target, property) {
                if (property === "size") return Number.MAX_SAFE_INTEGER + 1;
                return Reflect.get(target, property, target);
              },
            });
          }
          return stats;
        }) as typeof actual.fstatSync,
        readSync: ((descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (returnZero) {
            returnZero = false;
            return 0;
          }
          return actual.readSync(descriptor, buffer, offset, length, position);
        }) as typeof actual.readSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      expect(() => module.installConnector("claude-code", "skill", directory))
        .toThrow(/invalid file size/iu);

      invalidSize = false;
      rmSync(join(directory, ".claude", "skills", "lcm-memory", "SKILL.md"), { force: true });
      returnZero = true;
      expect(() => module.installConnector("claude-code", "skill", directory))
        .toThrow(/failed ownership verification/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects descriptor writes that make no progress and non-EEXIST opens", async () => {
    const skillPath = join(directory, ".claude", "skills", "lcm-memory", "SKILL.md");
    let zeroWrite = true;
    let skillOpenCount = 0;
    let mcpOpenCount = 0;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          const pathname = String(path);
          if (pathname === skillPath) {
            skillOpenCount += 1;
            if (skillOpenCount === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            if (skillOpenCount === 2) throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          if (pathname === join(directory, ".mcp.json")) {
            mcpOpenCount += 1;
            if (mcpOpenCount === 1) throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
        writeSync: ((descriptor: number, data: Uint8Array, offset: number, length: number, position: number | null) => {
          if (zeroWrite) {
            zeroWrite = false;
            return 0;
          }
          return actual.writeSync(descriptor, data, offset, length, position);
        }) as typeof actual.writeSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      // The first install reaches writeDescriptor and exercises the no-progress guard.
      zeroWrite = true;
      expect(() => module.installConnector("cursor", "cli", directory, {
        configPath: join(directory, "zero-write-config.json"),
        persistTransport: false,
      })).toThrow(/made no progress/iu);

      // A non-EEXIST error from the create path must be propagated, and the
      // cleanup must not attempt to close an unassigned descriptor.
      skillOpenCount = 0;
      expect(() => module.installConnector("claude-code", "skill", directory))
        .toThrow(/denied/iu);

      // The same create-path contract applies to structured MCP targets.
      mcpOpenCount = 0;
      expect(() => module.installConnector("claude-code", "mcp", directory))
        .toThrow(/denied/iu);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("handles ELOOP opens for preflight, install, and both removal modes", async () => {
    const skillPath = join(directory, ".claude", "skills", "lcm-memory", "SKILL.md");
    let openCount = 0;
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
          if (String(path) === skillPath) {
            openCount += 1;
            if (openCount === 1 || openCount === 3) throw Object.assign(new Error("symlink"), { code: "ELOOP" });
            if (openCount === 2) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
        }) as typeof actual.openSync,
      };
    });
    try {
      const module = await import("../../src/connectors/installer.js");
      expect(() => module.installConnector("claude-code", "skill", directory))
        .toThrow(/unowned LCM skill|overwrite an unowned/iu);

      // Preflight now sees ENOENT, while the create attempt sees ELOOP.
      expect(() => module.installConnector("claude-code", "skill", directory))
        .toThrow(/unowned LCM skill|overwrite an unowned/iu);

      mkdirSync(dirname(skillPath), { recursive: true });
      fs.symlinkSync("missing-target", skillPath);
      expect(module.removeConnector("claude-code", "skill", directory)).toBe(false);
      const strict = module.removeConnector("claude-code", directory, {
        configPath: join(directory, "strict-symlink-config.json"),
      });
      expect(strict).toEqual(expect.objectContaining({ success: false }));
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
