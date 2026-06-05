import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath } from "../../src/project-map.js";

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

const { registerMapCommand } = await import("../../bin/lcm.js");

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

async function runMapCommand(args: string[]): Promise<{ stdout: string[]; stderr: string[]; thrown?: Error }> {
  const program = new Command("lcm");
  program.exitOverride();
  registerMapCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => { stdout.push(String(message)); });
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => { stderr.push(String(message)); });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk).trimEnd());
    return true;
  });

  try {
    await program.parseAsync(["map", ...args], { from: "user" });
    return { stdout, stderr };
  } catch (err) {
    return { stdout, stderr, thrown: err instanceof Error ? err : new Error(String(err)) };
  }
}

function useTempHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "lcm-map-cli-error-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  clearProjectMapCache();
}

describe("map command exits", () => {
  it("prints root usage and exits when no map subcommand is provided", async () => {
    const result = await runMapCommand([]);

    expect(result.stderr).toEqual(["Usage: lcm map <list|show|add|remove> [options]"]);
    expect(result.thrown?.message).toBe("exit:1");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("prints custom help for the map root", async () => {
    const result = await runMapCommand(["--help"]);

    expect(printHelpMock).toHaveBeenCalledWith("map");
    expect(result.thrown?.message).toBe("exit:0");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("prints JSON errors for map show failures", async () => {
    useTempHome();
    const result = await runMapCommand(["show", "a".repeat(64), "--json"]);

    expect(JSON.parse(result.stdout[0])).toEqual({ error: `unknown project hash: ${"a".repeat(64)}` });
    expect(result.thrown?.message).toBe("exit:1");
  });

  it("prints text errors for map add failures", async () => {
    useTempHome();
    tempDir = mkdtempSync(join(tmpdir(), "lcm-map-cli-error-"));
    const canonical = join(tempDir, "canonical");
    const alias = join(tempDir, "alias");
    mkdirSync(canonical);
    mkdirSync(alias);
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    await runMapCommand(["add", alias, "--canonical", canonical]);

    const result = await runMapCommand(["add", alias, "--hash", hash]);

    expect(result.stderr[0]).toMatch(/^Error: alias is already mapped to /);
    expect(result.thrown?.message).toBe("exit:1");
  });

  it("prints errors from map remove failures", async () => {
    useTempHome();
    const result = await runMapCommand(["remove", "/tmp/alias", "--hash", "not-a-hash"]);

    expect(result.stderr).toEqual(["Error: invalid project hash: not-a-hash"]);
    expect(result.thrown?.message).toBe("exit:1");
  });
});
