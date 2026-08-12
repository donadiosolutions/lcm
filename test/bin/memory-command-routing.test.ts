import { afterEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMachineCommand, registerMemoryCommands, registerProjectCommand, shouldRunMain } from "../../bin/lcm.js";
import { clearProjectMapCache, normalizeProjectPath, resolveProjectIdentity } from "../../src/project-map.js";

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempHome: string | undefined;

afterEach(() => {
  process.chdir(originalCwd);
  clearProjectMapCache();
  vi.restoreAllMocks();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

async function runProjectCommand(args: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
  const program = new Command("lcm");
  program.exitOverride();
  registerProjectCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => { stdout.push(String(message)); });
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => { stderr.push(String(message)); });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk).trimEnd());
    return true;
  });

  await program.parseAsync(["project", ...args], { from: "user" });

  return { stdout, stderr };
}

describe("memory command registration", () => {
  it("registers all daemon-backed memory commands", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program);

    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain("search");
    expect(commandNames).toContain("grep");
    expect(commandNames).toContain("describe");
    expect(commandNames).toContain("expand");
    expect(commandNames).toContain("store");
  });

  it("search keeps the repeatable layer and tag options", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program);

    const searchCommand = program.commands.find((command) => command.name() === "search");
    expect(searchCommand).toBeDefined();

    const optionFlags = searchCommand?.options.map((option) => option.flags) ?? [];
    expect(optionFlags).toContain("--layer <name>");
    expect(optionFlags).toContain("--tag <tag>");
    expect(optionFlags).toContain("--limit <n>");
  });

  it("registers one ordered store tag option with both long aliases", () => {
    const program = new Command("lcm");
    registerMemoryCommands(program);

    const storeCommand = program.commands.find((command) => command.name() === "store");
    expect(storeCommand).toBeDefined();

    const tagOptions = storeCommand?.options.filter((option) =>
      option.flags.includes("--tag") || option.flags.includes("--tags"));
    expect(tagOptions).toHaveLength(1);
    expect(tagOptions?.[0]?.flags).toBe("--tag, --tags <tag>");
  });

  it("treats symlinked invocation as the same entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-argv-"));
    const target = join(dir, "lcm.js");
    const link = join(dir, "lcm-link.js");

    try {
      writeFileSync(target, "#!/usr/bin/env node\n");
      symlinkSync(target, link);
      expect(shouldRunMain(link, target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("identity command registration", () => {
  it("registers project and machine subcommands", () => {
    const program = new Command("lcm");
    registerProjectCommand(program);
    registerMachineCommand(program);

    const projectCommand = program.commands.find((command) => command.name() === "project");
    expect(projectCommand?.commands.map((command) => command.name()).sort()).toEqual([
      "create",
      "link",
      "list",
      "reconcile-worktrees",
      "show",
      "unlink",
    ]);
    const machineCommand = program.commands.find((command) => command.name() === "machine");
    expect(machineCommand?.commands.map((command) => command.name()).sort()).toEqual([
      "recover",
      "register",
      "show",
    ]);
  });

  it("links, lists, shows, and unlinks local aliases through project CLI actions", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-project-cli-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    clearProjectMapCache();
    const dir = mkdtempSync(join(tmpdir(), "lcm-project-cli-"));
    const canonical = join(dir, "canonical");
    const alias = join(dir, "alias");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(alias);
    process.chdir(canonical);

    try {
      const hash = resolveProjectIdentity(canonical).id;
      const link = await runProjectCommand(["link", hash, alias]);
      expect(link.stderr).toEqual([]);
      expect(link.stdout).toContain(`  local hash: ${hash}`);

      const list = await runProjectCommand(["list", "--json"]);
      const listed = JSON.parse(list.stdout[0]) as {
        local: Array<{ hash: string; canonical: string; aliases: string[] }>;
      };
      expect(listed.local).toContainEqual({
        hash,
        canonical: normalizeProjectPath(canonical),
        aliases: [normalizeProjectPath(alias)],
      });

      const show = await runProjectCommand(["show", hash]);
      expect(show.stdout).toContain(hash);
      expect(show.stdout).toContain(`  canonical: ${normalizeProjectPath(canonical)}`);
      expect(show.stdout).toContain(`  alias: ${normalizeProjectPath(alias)}`);

      const unlink = await runProjectCommand(["unlink", alias, "--json"]);
      const unlinked = JSON.parse(unlink.stdout[0]) as { hash: string; aliasRemoved: boolean };
      expect(unlinked).toMatchObject({ hash, aliasRemoved: true });

      const linkJson = await runProjectCommand(["link", canonical, alias, "--json"]);
      const linked = JSON.parse(linkJson.stdout[0]) as { local: { id: string } };
      expect(linked.local.id).toBe(hash);

      const showJson = await runProjectCommand(["show", alias, "--json"]);
      const shown = JSON.parse(showJson.stdout[0]) as { hash: string; entry: { aliases: string[] } };
      expect(shown.hash).toBe(hash);
      expect(shown.entry.aliases).toEqual([normalizeProjectPath(alias)]);

      const listText = await runProjectCommand(["list"]);
      expect(listText.stdout).toContain(hash);
      expect(listText.stdout).toContain(`  alias: ${normalizeProjectPath(alias)}`);

      const unlinkText = await runProjectCommand(["unlink", alias]);
      expect(unlinkText.stdout).toEqual([`Removed project alias from ${hash}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shouldRunMain", () => {
  it("returns true when the same path is invoked", () => {
    expect(shouldRunMain("/tmp/lcm.js", "/tmp/lcm.js")).toBe(true);
  });

  it("falls back to direct path comparison when realpath resolution fails", () => {
    expect(shouldRunMain("/nonexistent/lcm.js", "/nonexistent/lcm.js")).toBe(true);
    expect(shouldRunMain("/nonexistent/a.js", "/nonexistent/b.js")).toBe(false);
  });
});
