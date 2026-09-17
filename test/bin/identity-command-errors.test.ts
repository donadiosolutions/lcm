import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineIdentityPath } from "../../src/machine-identity.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  projectMapPath,
  resolveProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../../src/project-map.js";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../../src/worktree-reconciliation.js";
import { runLcmMigrations } from "../../src/db/migration.js";

const MISSING_FENCE_REFUSAL =
  "renewed project identity is missing its predecessor reconciliation fence; refusing to reconcile";

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
  clearGitProjectAnchorCache();
  clearWorktreeReconciliationCache();
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Real Git repository with one linked worktree, the shape reconciliation folds. */
function makeRepository(root: string): { main: string; linked: string } {
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main, { recursive: true, mode: 0o700 });
  git(main, "init", "-q");
  git(main, "config", "user.email", "test@example.invalid");
  git(main, "config", "user.name", "LCM Test");
  writeFileSync(join(main, "README.md"), "test\n", { mode: 0o600 });
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-qb", "linked", linked);
  return { main, linked };
}

/** Minimal real migrated LCM database, large enough to be a fold source. */
function makeDatabase(path: string, sessionId: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  runLcmMigrations(db);
  db.prepare(
    `INSERT INTO conversations(
       session_id, title, bootstrapped_at, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?)`,
  ).run(sessionId, "title", "2026-01-01", "2026-01-01", "2026-01-02");
  db.close();
}

/** Minimal real event sidecar, large enough to be a fold source. */
function makeEvents(path: string, sessionId: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_version(version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(3);
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, category TEXT NOT NULL,
      data TEXT NOT NULL, priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL,
      prev_event_id INTEGER, processed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hook TEXT NOT NULL, error TEXT NOT NULL,
      session_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO events(
       session_id, seq, type, category, data, priority, source_hook, created_at
     ) VALUES(?, 1, 'decision', 'test', '{}', 1, 'PostToolUse', '2026-01-01')`,
  ).run(sessionId);
  db.close();
}

describe("identity command exits", () => {
  it("prints project root usage and exits when no subcommand is provided", async () => {
    const result = await runIdentityCommand("project", []);

    expect(result.stderr).toEqual(["Usage: lcm project <create|link|unlink|list|show|reconcile-worktrees|renew-retired-identity> [options]"]);
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

  // `lcm project reconcile-worktrees` calls `reconcileWorktrees` directly and
  // never supplies an authenticated target identity. A successor-shaped map key
  // is reachable only through renewal, so without the fail-closed rule inside
  // `reconcileWorktrees` this command would target the retired hash, classify
  // the live successor as a legacy source of the same repository, and fold its
  // database and event sidecar backwards into the retired id — silently undoing
  // the renewal with real data loss.
  it("refuses worktree reconciliation for a successor identity with no predecessor fence", async () => {
    useTempHome();
    const home = tempHome!;
    tempDir = mkdtempSync(join(tmpdir(), "lcm-project-cli-unauthenticated-successor-"));
    const { main, linked } = makeRepository(tempDir);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const retiredId = hashProjectPath(canonical);
    const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
    mkdirSync(join(home, ".lcm"), { recursive: true, mode: 0o700 });
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [successorId]: { canonical, aliases: [] },
    }, null, 2)}\n`, { mode: 0o600 });
    const successorDb = join(home, ".lcm", "projects", successorId, "db.sqlite");
    const successorEvents = join(home, ".lcm", "events", `${successorId}.db`);
    makeDatabase(successorDb, "renewed-session");
    makeEvents(successorEvents, "renewed-session");
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    const mapBefore = readFileSync(projectMapPath(), "utf8");
    const dbBefore = readFileSync(successorDb);
    const eventsBefore = readFileSync(successorEvents);

    const result = await runIdentityCommand("project", ["reconcile-worktrees", linked]);

    expect(result.stderr).toEqual([`Error: ${MISSING_FENCE_REFUSAL}`]);
    expect(result.stdout).toEqual([]);
    expect(result.thrown?.message).toBe("exit:1");
    expect(exitMock).toHaveBeenCalledWith(1);
    // Nothing was mutated and nothing was archived.
    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readFileSync(successorDb)).toEqual(dbBefore);
    expect(readFileSync(successorEvents)).toEqual(eventsBefore);
    expect(existsSync(join(home, ".lcm", "projects", retiredId))).toBe(false);
    expect(existsSync(join(home, ".lcm", "events", `${retiredId}.db`))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
    expect(listProjectMapEntries()).toEqual({
      [successorId]: { canonical, aliases: [] },
    });
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
