import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));

vi.mock("../src/daemon/lifecycle.js", () => lifecycle);

const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("bootstrap default dependencies", () => {
  it("creates core files and reuses the default bootstrap flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-bootstrap-defaults-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    vi.resetModules();
    const { ensureBootstrapped, ensureCore } = await import("../src/bootstrap.js");
    await ensureCore();
    await ensureBootstrapped("unsafe/session:id");
    await ensureBootstrapped("unsafe/session:id");
    expect(lifecycle.ensureDaemon).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["stored cli", "cli", "cli"],
    ["stored mcp", "mcp", "mcp"],
    ["registry default", undefined, "mcp"],
  ] as const)("preserves the Claude transport during lazy bootstrap for %s", async (_label, stored, expected) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-bootstrap-transport-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    const lcmRoot = join(home, ".lcm");
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(lcmRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(lcmRoot, "config.json"), JSON.stringify({
      connectors: stored === undefined ? undefined : { transports: { "claude-code": stored } },
    }), { mode: 0o600 });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: "", hooks: [{
          type: "command",
          command: "lcm user-prompt --transport cli",
        }] }],
      },
    }), { mode: 0o600 });

    vi.resetModules();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped(`lazy-${_label}`);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.UserPromptSubmit.at(-1)?.hooks[0]?.command)
      .toContain(`user-prompt --transport ${expected}`);
  });

  it("keeps an explicit bootstrap transport override", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-bootstrap-explicit-transport-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    const lcmRoot = join(home, ".lcm");
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(lcmRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(lcmRoot, "config.json"), JSON.stringify({
      connectors: { transports: { "claude-code": "mcp" } },
    }), { mode: 0o600 });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: "", hooks: [{
          type: "command",
          command: "lcm user-prompt --transport mcp",
        }] }],
      },
    }), { mode: 0o600 });

    vi.resetModules();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    const ensureDaemon = vi.fn().mockResolvedValue({ connected: true });
    await ensureBootstrapped("explicit-transport", {
      configPath: join(lcmRoot, "config.json"),
      settingsPath,
      existsSync: (path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      },
      readFileSync: (path) => readFileSync(path, "utf8"),
      writeFileSync: (path, data) => writeFileSync(path, data),
      mkdirSync: (path, options) => mkdirSync(path, options),
      binaryPath: "/opt/npm/bin/lcm",
      transport: "cli",
      ensureDaemon,
      flagExists: () => false,
      writeFlag: vi.fn(),
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.UserPromptSubmit.at(-1)?.hooks[0]?.command)
      .toContain("user-prompt --transport cli");
  });
});
