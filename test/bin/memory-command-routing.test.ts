import { afterEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMapCommand, registerMemoryCommands, shouldRunMain } from "../../bin/lcm.js";
import { clearProjectMapCache, hashProjectPath, normalizeProjectPath } from "../../src/project-map.js";

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

async function runMapCommand(args: string[]): Promise<{ stdout: string[]; stderr: string[] }> {
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

  await program.parseAsync(["map", ...args], { from: "user" });

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

describe("map command registration", () => {
  it("registers map subcommands", () => {
    const program = new Command("lcm");
    registerMapCommand(program);

    const mapCommand = program.commands.find((command) => command.name() === "map");
    expect(mapCommand).toBeDefined();
    expect(mapCommand?.commands.map((command) => command.name()).sort()).toEqual(["add", "list", "remove", "show"]);
  });

  it("adds, lists, shows, and removes aliases through CLI actions", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-map-cli-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    clearProjectMapCache();
    const dir = mkdtempSync(join(tmpdir(), "lcm-map-cli-"));
    const canonical = join(dir, "canonical");
    const alias = join(dir, "alias");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(alias);
    process.chdir(canonical);

    try {
      const add = await runMapCommand(["add", alias, "--canonical", canonical]);
      const hash = hashProjectPath(normalizeProjectPath(canonical));
      expect(add.stderr).toEqual([]);
      expect(add.stdout).toEqual([`Added alias to ${hash}`]);

      const list = await runMapCommand(["list", "--json"]);
      const listed = JSON.parse(list.stdout[0]) as { entries: Record<string, { canonical: string; aliases: string[] }> };
      expect(listed.entries[hash].canonical).toBe(normalizeProjectPath(canonical));
      expect(listed.entries[hash].aliases).toEqual([normalizeProjectPath(alias)]);

      const show = await runMapCommand(["show", hash]);
      expect(show.stdout).toContain(hash);
      expect(show.stdout).toContain(`  canonical: ${normalizeProjectPath(canonical)}`);
      expect(show.stdout).toContain(`  alias: ${normalizeProjectPath(alias)}`);

      const remove = await runMapCommand(["remove", alias, "--hash", hash, "--json"]);
      const removed = JSON.parse(remove.stdout[0]) as { hash: string; removed: boolean };
      expect(removed).toMatchObject({ hash, removed: true });

      const addJson = await runMapCommand(["add", alias, "--hash", hash, "--json"]);
      const added = JSON.parse(addJson.stdout[0]) as { added: boolean; hash: string };
      expect(added.added).toBe(true);
      expect(added.hash).toBe(hash);

      const showJson = await runMapCommand(["show", alias, "--json"]);
      const shown = JSON.parse(showJson.stdout[0]) as { hash: string; entry: { aliases: string[] } };
      expect(shown.hash).toBe(hash);
      expect(shown.entry.aliases).toEqual([normalizeProjectPath(alias)]);

      const listText = await runMapCommand(["list"]);
      expect(listText.stdout).toContain(hash);
      expect(listText.stdout).toContain(`  alias: ${normalizeProjectPath(alias)}`);

      const removeText = await runMapCommand(["remove", alias, "--hash", hash]);
      expect(removeText.stdout).toEqual([`Removed alias from ${hash}`]);

      const existingAlias = join(dir, "existing-alias");
      mkdirSync(existingAlias);
      const addExisting = await runMapCommand(["add", existingAlias, "--hash", hash]);
      expect(addExisting.stderr).toEqual([]);
      expect(addExisting.stdout).toEqual([`Added alias to ${hash}`]);

      const absentAlias = join(dir, "absent-alias");
      const removeAbsent = await runMapCommand(["remove", absentAlias, "--hash", hash]);
      expect(removeAbsent.stdout).toEqual([`Alias was not present on ${hash}`]);
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
