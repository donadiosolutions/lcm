import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { runDoctor as runDoctorProduction } from "../../src/doctor/doctor.js";
import { mergeClaudeSettings, REQUIRED_HOOKS } from "../../installer/install.js";
import { join } from "node:path";
import type { DoctorDeps } from "../../src/doctor/types.js";

// Mock ensureDaemon to prevent spawning real processes when daemon appears down
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

const LCM_BLOCK = "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
const BINARY = join(process.cwd(), "dist", "lcm.mjs");
let homeCounter = 0;
const homes: string[] = [];

function doctorHome(): string {
  homeCounter += 1;
  const home = `/tmp/lcm-doctor-hooks-${process.pid}-${homeCounter}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
  homes.push(home);
  return home;
}

function runDoctor(deps: Omit<DoctorDeps, "_assertBackendPublication">): ReturnType<typeof runDoctorProduction> {
  return runDoctorProduction({ ...deps, _assertBackendPublication: () => undefined });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function baseReadFileSync(p: string, settings: string) {
  if (p.endsWith("config.json")) return JSON.stringify({ llm: { provider: "claude-process" } });
  if (p.endsWith("settings.json")) return settings;
  if (p.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
  if (p.endsWith("CLAUDE.md")) return LCM_BLOCK;
  return "{}";
}

describe("doctor hook validation", () => {
  it("repairs hooks when they are absent from settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: { "lcm": {} } });
    const writeFileSync = vi.fn();
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync,
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult).toMatchObject({ status: "warn", fixApplied: true });
    const settingsWrite = writeFileSync.mock.calls.find(([path]) =>
      path === `${home}/.claude/settings.json`
    );
    const written = JSON.parse(settingsWrite![1]);
    expect(Object.keys(written.hooks)).toEqual(REQUIRED_HOOKS.map(({ event }) => event));
  });

  it("reports pass when native hooks and mcpServers.lcm use the installed binary", async () => {
    const settings = JSON.stringify({
      ...mergeClaudeSettings({}, BINARY),
      mcpServers: { lcm: { type: "stdio", command: process.execPath, args: [BINARY, "mcp"] } },
    });
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("pass");
    expect(mcpResult?.message).toContain("npm-installed runtime");
  });

  it("re-adds mcpServers.lcm when missing from settings.json", async () => {
    const settings = JSON.stringify({ ...mergeClaudeSettings({}, BINARY), theme: "dark", mcpServers: {} });
    const writtenFiles = new Map<string, string>();
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("warn");
    expect(mcpResult?.message).toContain("missing or stale");
    // doctor should have written the entry back to settings.json
    const settingsWritten = writtenFiles.get(`${home}/.claude/settings.json`);
    expect(settingsWritten).toBeDefined();
    const written = JSON.parse(settingsWritten!);
    expect(written.mcpServers?.lcm).toBeDefined();
    expect(written.theme).toBe("dark");
  });

  it("removes only the owned MCP entry for stored Claude CLI transport", async () => {
    const home = doctorHome();
    const settings = JSON.stringify({
      ...mergeClaudeSettings({}, BINARY),
      mcpServers: {
        lcm: { type: "stdio", command: process.execPath, args: [BINARY, "mcp"] },
        unrelated: { command: "other" },
      },
    });
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      _claudeTransport: "cli",
      existsSync: () => true,
      readFileSync: (p: string) => p.endsWith("settings.json") ? settings : baseReadFileSync(p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    expect(results.find(r => r.name === "mcp-lcm")).toMatchObject({ status: "warn", fixApplied: true });
    const repaired = JSON.parse(writtenFiles.get(`${home}/.claude/settings.json`)!);
    expect(repaired.mcpServers).toEqual({ unrelated: { command: "other" } });
    expect(repaired.hooks.UserPromptSubmit.at(-1).hooks[0].command)
      .toContain("user-prompt --transport cli");
  });

  it("does not adopt unrelated Claude settings as a managed LCM installation", async () => {
    const settings = JSON.stringify({
      theme: "dark",
      hooks: { SessionStart: [{ hooks: [{ command: "other restore" }] }] },
      mcpServers: { unrelated: { command: "other" } },
    });
    const writeFileSync = vi.fn();
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync,
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });

    expect(writeFileSync).not.toHaveBeenCalled();
    for (const name of ["hooks", "mcp-lcm", "lcm-md"]) {
      expect(results.find((result) => result.name === name)?.message)
        .toBe("Claude Code integration is not installed");
    }
  });

  it("reports a native MCP repair write failure", async () => {
    const settings = JSON.stringify({
      ...mergeClaudeSettings({}, BINARY),
      mcpServers: { lcm: { command: "/old/lcm", args: ["mcp"] } },
    });
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: () => { throw new Error("write failed"); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    expect(results.find(r => r.name === "hooks")?.status).toBe("pass");
    expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
  });

  it("stringifies a non-Error Claude settings read failure", async () => {
    const home = doctorHome();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => {
        if (p.endsWith("settings.json")) throw "plain settings failure";
        return baseReadFileSync(p, "{}");
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: home,
      platform: "darwin",
    });
    expect(results.find(r => r.name === "hooks")?.message).toContain("plain settings failure");
    expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
  });

  it.each(["null", "false", "0", '"invalid-root"', "[]"])(
    "fails closed for a non-object settings root: %s",
    async (settings) => {
      const writtenFiles = new Map<string, string>();
      const home = doctorHome();
      const results = await runDoctor({
        existsSync: () => true,
        readFileSync: (p: string) => baseReadFileSync(p, settings),
        writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
        mkdirSync: vi.fn(),
        spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
        fetch: vi.fn().mockResolvedValue({ ok: false }),
        homedir: home,
        platform: "darwin",
      });

      expect(results.find(r => r.name === "hooks")?.status).toBe("fail");
      expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
      expect(writtenFiles.has(`${home}/.claude/settings.json`)).toBe(false);
    },
  );
});
