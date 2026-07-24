import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProjectMapCache, resolveProjectIdentity } from "../../src/project-map.js";

const exitMock = vi.hoisted(() =>
  vi.fn((code?: string | number | null) => {
    throw new Error(`exit:${code ?? 0}`);
  }),
);
const printHelpMock = vi.hoisted(() => vi.fn());

vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return { ...actual, exit: exitMock };
});

vi.mock("../../src/cli-help.js", () => ({ printHelp: printHelpMock }));

const { registerMachineCommand, registerProjectCommand } = await import("../../bin/lcm.js");

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempHome: string | undefined;
let tempDir: string | undefined;

afterEach(() => {
  process.chdir(originalCwd);
  clearProjectMapCache();
  vi.restoreAllMocks();
  exitMock.mockClear();
  printHelpMock.mockClear();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempDir = undefined;
  tempHome = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

async function runIdentityCommand(
  command: "machine" | "project",
  args: string[],
): Promise<{ stdout: string[]; stderr: string[]; thrown?: Error }> {
  const program = new Command("lcm");
  program.exitOverride();
  registerMachineCommand(program);
  registerProjectCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => { stdout.push(String(message)); });
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => { stderr.push(String(message)); });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk).trimEnd());
    return true;
  });

  try {
    await program.parseAsync([command, ...args], { from: "user" });
    return { stdout, stderr };
  } catch (err) {
    return { stdout, stderr, thrown: err instanceof Error ? err : new Error(String(err)) };
  }
}

function useTempHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "lcm-identity-cli-error-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  clearProjectMapCache();
}

describe("identity command exits", () => {
  it("prints project root usage and exits when no subcommand is provided", async () => {
    const result = await runIdentityCommand("project", []);

    expect(result.stderr).toEqual(["Usage: lcm project <create|link|unlink|list|show> [options]"]);
    expect(result.thrown?.message).toBe("exit:1");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("prints custom help for the project root", async () => {
    const result = await runIdentityCommand("project", ["--help"]);

    expect(printHelpMock).toHaveBeenCalledWith("project");
    expect(result.thrown?.message).toBe("exit:0");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("prints JSON errors for project show failures", async () => {
    useTempHome();
    const result = await runIdentityCommand("project", ["show", "a".repeat(64), "--json"]);

    expect(JSON.parse(result.stdout[0])).toEqual({ error: `unknown project hash: ${"a".repeat(64)}` });
    expect(result.thrown?.message).toBe("exit:1");
  });

  it("prints text errors for project link collisions", async () => {
    useTempHome();
    tempDir = mkdtempSync(join(tmpdir(), "lcm-project-cli-error-"));
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    const alias = join(tempDir, "alias");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(alias);
    const firstHash = resolveProjectIdentity(first).id;
    const secondHash = resolveProjectIdentity(second).id;
    await runIdentityCommand("project", ["link", firstHash, alias]);

    const result = await runIdentityCommand("project", ["link", secondHash, alias]);

    expect(result.stderr[0]).toMatch(/^Error: alias is already mapped to /);
    expect(result.thrown?.message).toBe("exit:1");
  });

  it("prints errors from project unlink failures", async () => {
    useTempHome();
    const result = await runIdentityCommand("project", ["unlink", "/tmp/not-mapped"]);

    expect(result.stderr[0]).toMatch(/^Error: project is not mapped:/);
    expect(result.thrown?.message).toBe("exit:1");
  });

  it("covers machine root help, usage, and JSON errors", async () => {
    const usage = await runIdentityCommand("machine", []);
    expect(usage.stderr).toEqual(["Usage: lcm machine <register|show|recover> [options]"]);
    expect(usage.thrown?.message).toBe("exit:1");

    const help = await runIdentityCommand("machine", ["--help"]);
    expect(printHelpMock).toHaveBeenCalledWith("machine");
    expect(help.thrown?.message).toBe("exit:0");

    useTempHome();
    const missing = await runIdentityCommand("machine", ["show", "--json"]);
    expect(JSON.parse(missing.stdout[0])).toEqual({
      error: "machine identity is not registered; run `lcm machine register`",
    });
    expect(missing.thrown?.message).toBe("exit:1");
  });
});
