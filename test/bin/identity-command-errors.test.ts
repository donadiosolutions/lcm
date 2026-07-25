import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineIdentityPath } from "../../src/machine-identity.js";
import {
  clearProjectMapCache,
  projectMapPath,
  resolveProjectIdentity,
} from "../../src/project-map.js";

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

    expect(result.stderr).toEqual(["Usage: lcm project <create|link|unlink|list|show|reconcile-worktrees> [options]"]);
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

  it("distinguishes unknown and ambiguous remote UUID show targets", async () => {
    useTempHome();
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    const unknown = await runIdentityCommand("project", ["show", remoteProjectId, "--json"]);
    expect(JSON.parse(unknown.stdout[0])).toEqual({
      error: `unknown remote project UUIDv7: ${remoteProjectId}`,
    });
    expect(unknown.thrown?.message).toBe("exit:1");

    tempDir = mkdtempSync(join(tmpdir(), "lcm-project-cli-ambiguous-"));
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    mkdirSync(first);
    mkdirSync(second);
    const firstIdentity = resolveProjectIdentity(first);
    const secondIdentity = resolveProjectIdentity(second);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [firstIdentity.id]: {
        canonical: firstIdentity.canonical,
        aliases: [],
        remoteProjectId,
      },
      [secondIdentity.id]: {
        canonical: secondIdentity.canonical,
        aliases: [],
        remoteProjectId,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    clearProjectMapCache();

    const ambiguous = await runIdentityCommand("project", ["show", remoteProjectId]);
    expect(ambiguous.stderr[0]).toContain(
      `remote project UUIDv7 maps to multiple local hashes: ${remoteProjectId}`,
    );
    expect(ambiguous.stderr[0]).toContain(firstIdentity.id);
    expect(ambiguous.stderr[0]).toContain(secondIdentity.id);
    expect(ambiguous.thrown?.message).toBe("exit:1");
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

  it("shows positional-subcommand help before validating required arguments", async () => {
    const project = await runIdentityCommand("project", ["link", "--help"]);
    expect(printHelpMock).toHaveBeenCalledWith("project");
    expect(project.thrown?.message).toBe("exit:0");

    printHelpMock.mockClear();
    const machine = await runIdentityCommand("machine", ["recover", "--help"]);
    expect(printHelpMock).toHaveBeenCalledWith("machine");
    expect(machine.thrown?.message).toBe("exit:0");
  });

  it("reports missing required positional identity arguments outside help", async () => {
    const project = await runIdentityCommand("project", ["link"]);
    expect(project.stderr).toEqual(["Error: missing required argument 'target'"]);
    expect(project.thrown?.message).toBe("exit:1");

    const machine = await runIdentityCommand("machine", ["recover"]);
    expect(machine.stderr).toEqual(["Error: missing required argument 'machine-id'"]);
    expect(machine.thrown?.message).toBe("exit:1");
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

  it("prints file-recovery guidance for unsafe persisted machine names in text and JSON", async () => {
    useTempHome();
    const path = machineIdentityPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012",
      displayName: "unsafe\u202ename",
    }), { mode: 0o600 });
    const expected = "machine.json contains an invalid display name. "
      + "Run `lcm machine recover <machine-id> --force` to replace the invalid file.";

    const text = await runIdentityCommand("machine", ["show"]);
    expect(text.stderr).toEqual([`Error: ${expected}`]);
    expect(text.thrown?.message).toBe("exit:1");

    const json = await runIdentityCommand("machine", ["show", "--json"]);
    expect(JSON.parse(json.stdout[0])).toEqual({ error: expected });
    expect(json.thrown?.message).toBe("exit:1");
    expect(expected).not.toContain("machine register --name");
  });
});
