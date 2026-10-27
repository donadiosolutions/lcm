import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lcmHomeDir, projectsDir } from "../../src/runtime-paths.js";
import { projectMapPath, clearProjectMapCache } from "../../src/project-map.js";
import {
  checkActivationProjectCoverage,
  enumerateStoredDataProjectHashes,
  evaluateActivationSingleProjectCoverage,
} from "../../src/migration/activation-coverage.js";

const roots: string[] = [];

afterEach(() => {
  clearProjectMapCache();
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm", "projects"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm", "events"), 0o700); } catch { /* best-effort */ }
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

/** Give a hash real stored data in the events directory (<hash>.db only). */
function withEventsData(homeDir: string, hash: string): void {
  const dir = join(lcmHomeDir(homeDir), "events");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, hash + ".db"), "events-bytes");
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

  it("is unsatisfied for an events-only project (no projects/<hash> directory) with no map entry", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("unsatisfied");
    expect(result.reason).toBe("uncovered-project-directories");
    expect(result.coveredProjectCount).toBe(0);
    expect(result.uncoveredProjectDirectories).toEqual([
      { hash: HASH_A, detail: "project hash " + HASH_A + " has stored data but no current project-map entry covers it" },
    ]);
  });

  it("counts an events-only project covered by the map", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
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

  it("treats a project directory without db.sqlite as having stored data when events/<hash>.db exists", () => {
    const homeDir = home();
    projectDir(homeDir, HASH_A);
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, []);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("unsatisfied");
    expect(result.uncoveredProjectDirectories).toEqual([
      { hash: HASH_A, detail: expect.stringContaining(HASH_A) },
    ]);
  });

  it("counts a hash once when it has both db.sqlite and an events database", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, [HASH_A]);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("satisfied");
    expect(result.coveredProjectCount).toBe(1);
  });

  it("ignores events entries that are not <hash>.db files", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
    const events = join(lcmHomeDir(homeDir), "events");
    writeFileSync(join(events, ".machine-sequence.sqlite"), "x");
    writeFileSync(join(events, HASH_B + ".db-wal"), "x");
    writeFileSync(join(events, "short.db"), "x");
    writeMap(homeDir, [HASH_A]);
    const result = checkActivationProjectCoverage({ homeDir });
    expect(result.status).toBe("satisfied");
    expect(result.coveredProjectCount).toBe(1);
  });

  it("resolves the events directory against the supplied homeDir, not the ambient home", () => {
    const homeDir = home();
    const readEventsDirectoryEntries = vi.fn(() => [] as never[]);
    writeMap(homeDir, []);
    checkActivationProjectCoverage({ homeDir }, { readEventsDirectoryEntries });
    expect(readEventsDirectoryEntries).toHaveBeenCalledWith(join(lcmHomeDir(homeDir), "events"));
  });

  it("is unresolvable with events-directory-unresolvable when the events directory cannot be listed (injected)", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    writeMap(homeDir, [HASH_A]);
    const boom = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const result = checkActivationProjectCoverage(
      { homeDir },
      { readEventsDirectoryEntries: () => { throw boom; } },
    );
    expect(result.status).toBe("unresolvable");
    expect(result.reason).toBe("events-directory-unresolvable");
    expect(result.coveredProjectCount).toBe(0);
    expect(result.uncoveredProjectDirectories).toEqual([]);
  });

  it("is unresolvable with events-directory-unresolvable for a genuinely unreadable events directory", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, [HASH_A]);
    const events = join(lcmHomeDir(homeDir), "events");
    chmodSync(events, 0o000);
    try {
      const result = checkActivationProjectCoverage({ homeDir });
      expect(result.status).toBe("unresolvable");
      expect(result.reason).toBe("events-directory-unresolvable");
    } finally {
      chmodSync(events, 0o700);
    }
  });

  it("is unresolvable with events-file-unresolvable when events/<hash>.db cannot be examined (listable but not searchable events directory)", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, [HASH_A]);
    const events = join(lcmHomeDir(homeDir), "events");
    chmodSync(events, 0o400);
    try {
      const result = checkActivationProjectCoverage({ homeDir });
      expect(result.status).toBe("unresolvable");
      expect(result.reason).toBe("events-file-unresolvable");
      expect(result.detail).toContain(HASH_A);
    } finally {
      chmodSync(events, 0o700);
    }
  });

  it("keeps project-directory-unresolvable when db.sqlite cannot be examined even if the events database exists", () => {
    const homeDir = home();
    const dir = projectDir(homeDir, HASH_A);
    withStoredData(dir);
    withEventsData(homeDir, HASH_A);
    writeMap(homeDir, [HASH_A]);
    chmodSync(dir, 0o000);
    try {
      const result = checkActivationProjectCoverage({ homeDir });
      expect(result.status).toBe("unresolvable");
      expect(result.reason).toBe("project-directory-unresolvable");
    } finally {
      chmodSync(dir, 0o700);
    }
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


describe("enumerateStoredDataProjectHashes (G8 inventory from the same locked enumeration)", () => {
  it("is an empty enumeration when the projects directory does not exist yet", () => {
    const homeDir = home();
    expect(enumerateStoredDataProjectHashes({ homeDir })).toEqual({ status: "enumerated", projectHashes: [] });
  });

  it("returns the sorted union of db.sqlite directories and events-only <hash>.db files, skipping data-less hashes and strays", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_B));
    projectDir(homeDir, HASH_C); // no stored data
    withEventsData(homeDir, HASH_A); // events-only
    mkdirSync(join(projectsDir(homeDir), "not-a-hash"), { mode: 0o700 });
    writeFileSync(join(lcmHomeDir(homeDir), "events", "stray.txt"), "x");
    writeMap(homeDir, []);
    const result = enumerateStoredDataProjectHashes({ homeDir });
    expect(result).toEqual({ status: "enumerated", projectHashes: [HASH_A, HASH_B] });
    expect(Object.isFrozen((result as { projectHashes: readonly string[] }).projectHashes)).toBe(true);
  });

  it("reports the same set regardless of map coverage (the inventory is not a coverage verdict)", () => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    withStoredData(projectDir(homeDir, HASH_B));
    writeMap(homeDir, [HASH_A]);
    expect(enumerateStoredDataProjectHashes({ homeDir })).toEqual({ status: "enumerated", projectHashes: [HASH_A, HASH_B] });
    expect(checkActivationProjectCoverage({ homeDir }).status).toBe("unsatisfied");
  });

  it.each([
    ["projects-directory-unresolvable", { readProjectDirectoryEntries: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }],
    ["events-directory-unresolvable", { readEventsDirectoryEntries: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }],
  ] as const)("refuses with %s exactly as the coverage check does (injected)", (reason, dependencies) => {
    const homeDir = home();
    withStoredData(projectDir(homeDir, HASH_A));
    writeMap(homeDir, [HASH_A]);
    const enumeration = enumerateStoredDataProjectHashes({ homeDir }, dependencies);
    const coverage = checkActivationProjectCoverage({ homeDir }, dependencies);
    expect(enumeration).toEqual({ status: "unresolvable", reason, detail: expect.any(String) });
    expect(coverage).toMatchObject({ status: "unresolvable", reason, detail: (enumeration as { detail: string }).detail });
  });

  it("refuses with events-file-unresolvable for a listable but unsearchable events directory, like the coverage check", () => {
    const homeDir = home();
    withEventsData(homeDir, HASH_A);
    const events = join(lcmHomeDir(homeDir), "events");
    chmodSync(events, 0o400);
    try {
      expect(enumerateStoredDataProjectHashes({ homeDir })).toMatchObject({ status: "unresolvable", reason: "events-file-unresolvable" });
    } finally {
      chmodSync(events, 0o700);
    }
  });
});

describe("evaluateActivationSingleProjectCoverage (G8: the set must equal exactly {localProjectId})", () => {
  it("is satisfied when the stored-data set is exactly this generation's project", () => {
    expect(evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: [HASH_A], localProjectId: HASH_A })).toEqual({
      status: "satisfied", reason: "single-project", detail: expect.stringContaining(HASH_A), otherProjectHashes: [],
    });
  });

  it("refuses when any other project holds data, listing every other hash sorted (whether or not it has its own generation)", () => {
    const verdict = evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: [HASH_C, HASH_A, HASH_B], localProjectId: HASH_A });
    expect(verdict).toEqual({
      status: "unsatisfied",
      reason: "other-projects-hold-data",
      detail: expect.stringContaining(HASH_B + ", " + HASH_C),
      otherProjectHashes: [HASH_B, HASH_C],
    });
    expect(verdict.detail).toContain("2 other projects");
  });

  it("singularizes one other project and notes when the local project itself has no data", () => {
    const verdict = evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: [HASH_B], localProjectId: HASH_A });
    expect(verdict).toMatchObject({ status: "unsatisfied", reason: "other-projects-hold-data", otherProjectHashes: [HASH_B] });
    expect(verdict.detail).toContain("1 other project under");
    expect(verdict.detail).toContain(HASH_A + " has none");
  });

  it("refuses an empty set: this generation's own project must hold data", () => {
    expect(evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: [], localProjectId: HASH_A })).toMatchObject({
      status: "unsatisfied", reason: "local-project-has-no-data", otherProjectHashes: [],
    });
  });

  it("is pure and tolerates a duplicated input hash", () => {
    expect(evaluateActivationSingleProjectCoverage({ storedDataProjectHashes: [HASH_A, HASH_A], localProjectId: HASH_A }).status).toBe("satisfied");
  });

  it.each([
    ["non-hash localProjectId", { storedDataProjectHashes: [], localProjectId: "project" }],
    ["non-object input", null],
    ["non-array set", { storedDataProjectHashes: "x", localProjectId: HASH_A }],
  ])("throws for a caller programming error (%s)", (_name, input) => {
    expect(() => evaluateActivationSingleProjectCoverage(input as unknown as Parameters<typeof evaluateActivationSingleProjectCoverage>[0])).toThrow();
  });
});

