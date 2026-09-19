import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectsDir } from "../../src/runtime-paths.js";
import { projectMapPath, clearProjectMapCache } from "../../src/project-map.js";
import { checkActivationProjectCoverage } from "../../src/migration/activation-coverage.js";

const roots: string[] = [];

afterEach(() => {
  clearProjectMapCache();
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm", "projects"), 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-coverage-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);
const HASH_C = "3".repeat(64);

/** Create a real hash-named project storage directory. */
function projectDir(homeDir: string, hash: string): string {
  const dir = join(projectsDir(homeDir), hash);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Give a project directory real stored data (a db.sqlite file). */
function withStoredData(dir: string): void {
  writeFileSync(join(dir, "db.sqlite"), "sqlite-bytes");
}

/** Write a real, valid map.json covering exactly the given hashes. Each
 * hash's canonical path does not need to exist on disk: parseProjectMap
 * only validates shape (absolute path strings), confirmed by reading
 * project-map.ts's parseProjectMap directly. */
function writeMap(homeDir: string, hashes: readonly string[]): void {
  const map: Record<string, { canonical: string; aliases: string[] }> = {};
  for (const hash of hashes) {
    map[hash] = { canonical: `/tmp/lcm-activation-coverage-fixture-${hash.slice(0, 8)}`, aliases: [] };
  }
  writeFileSync(projectMapPath(homeDir), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

describe("checkActivationProjectCoverage", () => {
  it("is satisfied with zero covered projects when the projects directory does not exist yet", () => {
    const homeDir = home();
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result).toEqual({
      status: "satisfied",
      reason: "complete-coverage",
      detail: expect.stringContaining("0"),
      coveredProjectCount: 0,
      uncoveredProjectDirectories: [],
    });
  });

  it("is satisfied when every project directory with stored data has a covering map entry", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    writeMap(homeDir, [HASH_A]);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result).toEqual({
      status: "satisfied",
      reason: "complete-coverage",
      detail: expect.any(String),
      coveredProjectCount: 1,
      uncoveredProjectDirectories: [],
    });
  });

  it("is unsatisfied when a project directory has stored data but no map entry (the fold trap)", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("unsatisfied");
    expect(result.reason).toBe("uncovered-project-directories");
    expect(result.coveredProjectCount).toBe(0);
    expect(result.uncoveredProjectDirectories).toEqual([
      { hash: HASH_A, detail: expect.stringContaining(HASH_A) },
    ]);
  });

  it("reports every uncovered directory, not just the first, and still counts covered ones", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    withStoredData(projectDir(homeDir, HASH_B));
    writeMap(homeDir, [HASH_A]);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("unsatisfied");
    expect(result.coveredProjectCount).toBe(1);
    expect(result.uncoveredProjectDirectories).toEqual([
      { hash: HASH_B, detail: expect.stringContaining(HASH_B) },
    ]);
  });

  it("pluralizes the detail message when more than one directory is uncovered", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_B));
    withStoredData(projectDir(homeDir, HASH_C));
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("unsatisfied");
    expect(result.detail).toContain("ies have");
    expect(result.uncoveredProjectDirectories).toHaveLength(2);
  });

  it("skips a hash-named directory with no stored data (nothing there to leave uncovered)", () => {
    const homeDir = home();
    projectDir(homeDir, HASH_A);
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result).toEqual({
      status: "satisfied",
      reason: "complete-coverage",
      detail: expect.any(String),
      coveredProjectCount: 0,
      uncoveredProjectDirectories: [],
    });
  });

  it("skips a stray file and a non-hash-named directory inside the projects directory", () => {
    const homeDir = home();
    mkdirSync(projectsDir(homeDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(projectsDir(homeDir), "stray-file"), "not a project");
    mkdirSync(join(projectsDir(homeDir), "not-a-hash"), { mode: 0o700 });
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result).toEqual({
      status: "satisfied",
      reason: "complete-coverage",
      detail: expect.any(String),
      coveredProjectCount: 0,
      uncoveredProjectDirectories: [],
    });
  });

  it("is unresolvable when the projects directory itself cannot be listed (injected: chmod'ing the" +
    " real projects directory to 0o000 breaks withProjectMapReconciliationLock's own unguarded" +
    " readdirSync of the same directory during map load, before this module's own read would ever" +
    " run -- there is no synchronous fixture that fails only this module's read; this exercises" +
    " this module's own attribution branch via dependency injection instead)", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    writeMap(homeDir, [HASH_A]);
    const boom = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const result = checkActivationProjectCoverage(
      { homeDir },
      { readProjectDirectoryEntries: () => { throw boom; } },
    );
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("projects-directory-unresolvable");
    expect(result.coveredProjectCount).toBe(0);
    expect(result.uncoveredProjectDirectories).toEqual([]);
  });

  it("is unresolvable when one specific project directory cannot be read (genuine EACCES fixture)", () => {
    const homeDir = home();
    const dir = projectDir(homeDir, HASH_A);
    withStoredData(dir);
    writeMap(homeDir, [HASH_A]);
    chmodSync(dir, 0o000);
    try {
      const result = checkActivationProjectCoverage({ homeDir });
      expect(result.status).toBe("unresolvable");
      expect(result.reason).toBe("project-directory-unresolvable");
      expect(result.detail).toContain(HASH_A);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
