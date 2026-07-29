import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { mergeClaudeSettings, REQUIRED_HOOKS } from "../../installer/install.js";
import { join } from "node:path";

// Mock ensureDaemon to prevent spawning real processes when daemon appears down
vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));

const LCM_BLOCK = "<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n";
const BINARY = join(process.cwd(), "dist", "lcm.mjs");

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
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync,
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult).toMatchObject({ status: "warn", fixApplied: true });
    const settingsWrite = writeFileSync.mock.calls.find(([path]) =>
      path === "/tmp/test-home/.claude/settings.json"
    );
    const written = JSON.parse(settingsWrite![1]);
    expect(Object.keys(written.hooks)).toEqual(REQUIRED_HOOKS.map(({ event }) => event));
  });

  it("reports pass when native hooks and mcpServers.lcm use the installed binary", async () => {
    const settings = JSON.stringify({
      ...mergeClaudeSettings({}, BINARY),
      mcpServers: { lcm: { type: "stdio", command: process.execPath, args: [BINARY, "mcp"] } },
    });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("pass");
    expect(mcpResult?.message).toContain("npm-installed runtime");
  });

  it("re-adds mcpServers.lcm when missing from settings.json", async () => {
    const settings = JSON.stringify({ ...mergeClaudeSettings({}, BINARY), theme: "dark", mcpServers: {} });
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const mcpResult = results.find(r => r.name === "mcp-lcm");
    expect(mcpResult?.status).toBe("warn");
    expect(mcpResult?.message).toContain("missing or stale");
    // doctor should have written the entry back to settings.json
    const settingsWritten = writtenFiles.get("/tmp/test-home/.claude/settings.json");
    expect(settingsWritten).toBeDefined();
    const written = JSON.parse(settingsWritten!);
    expect(written.mcpServers?.lcm).toBeDefined();
    expect(written.theme).toBe("dark");
  });

  it("does not adopt unrelated Claude settings as a managed LCM installation", async () => {
    const settings = JSON.stringify({
      theme: "dark",
      hooks: { SessionStart: [{ hooks: [{ command: "other restore" }] }] },
      mcpServers: { unrelated: { command: "other" } },
    });
    const writeFileSync = vi.fn();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync,
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
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
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: () => { throw new Error("write failed"); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    expect(results.find(r => r.name === "hooks")?.status).toBe("pass");
    expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
  });

  it("stringifies a non-Error Claude settings read failure", async () => {
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
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    expect(results.find(r => r.name === "hooks")?.message).toContain("plain settings failure");
    expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
  });

  it.each(["null", "false", "0", '"invalid-root"', "[]"])(
    "fails closed for a non-object settings root: %s",
    async (settings) => {
      const writtenFiles = new Map<string, string>();
      const results = await runDoctor({
        existsSync: () => true,
        readFileSync: (p: string) => baseReadFileSync(p, settings),
        writeFileSync: (p: string, data: string) => { writtenFiles.set(p, data); },
        mkdirSync: vi.fn(),
        spawnSync: () => ({ status: 0, stdout: "/usr/local/bin/lcm\n", stderr: "" }),
        fetch: vi.fn().mockResolvedValue({ ok: false }),
        homedir: "/tmp/test-home",
        platform: "darwin",
      });

      expect(results.find(r => r.name === "hooks")?.status).toBe("fail");
      expect(results.find(r => r.name === "mcp-lcm")?.status).toBe("fail");
      expect(writtenFiles.has("/tmp/test-home/.claude/settings.json")).toBe(false);
    },
  );
});
