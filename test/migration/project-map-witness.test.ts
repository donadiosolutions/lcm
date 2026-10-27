import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  type ProjectMap,
} from "../../src/project-map.js";
import { canonicalSha256 } from "../../src/storage/portable-record.js";
import {
  MIGRATION_PROJECT_MAP_WITNESS_DOMAIN,
  MigrationProjectMapWitnessError,
  computeMigrationProjectMapWitnessSha256,
  migrationProjectMapWitnessDigest,
  type ComputeMigrationProjectMapWitnessInput,
} from "../../src/migration/project-map-witness.js";

const roots: string[] = [];

afterEach(() => {
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-project-map-witness-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

const REMOTE = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b";
const OTHER_REMOTE = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5c";

/** A real project directory under the temp home, its hash, and a map.json
 * written through the same path project-map.ts reads. */
function fixture(homeDir: string, options: { bound?: string | null } = {}) {
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const canonical = normalizeProjectPath(cwd);
  const localProjectId = hashProjectPath(canonical);
  const entry: ProjectMap[string] = { canonical, aliases: [] };
  if (options.bound !== undefined && options.bound !== null) entry.remoteProjectId = options.bound;
  writeMap(homeDir, { [localProjectId]: entry });
  return { cwd, canonical, localProjectId };
}

function writeMap(homeDir: string, map: ProjectMap): void {
  writeFileSync(projectMapPath(homeDir), JSON.stringify(map) + "\n", { mode: 0o600 });
  clearProjectMapCache();
}

function input(
  homeDir: string,
  localProjectId: string,
  mode: ComputeMigrationProjectMapWitnessInput["mode"],
  overrides: Partial<ComputeMigrationProjectMapWitnessInput> = {},
): ComputeMigrationProjectMapWitnessInput {
  return { homeDir, localProjectId, remoteProjectId: REMOTE, mode, ...overrides };
}

function expectDrift(callback: () => unknown, drift: MigrationProjectMapWitnessError["drift"]): void {
  try {
    callback();
    throw new Error("expected MigrationProjectMapWitnessError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationProjectMapWitnessError);
    expect((error as MigrationProjectMapWitnessError).reason).toBe("project-map-drift");
    expect((error as MigrationProjectMapWitnessError).drift).toBe(drift);
  }
}

describe("computeMigrationProjectMapWitnessSha256: one definition, two observations", () => {
  it("digests {localProjectId, caller remoteProjectId, normalized canonical path} under the v1 domain", () => {
    const homeDir = home();
    const { canonical, localProjectId } = fixture(homeDir);
    const witness = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    expect(witness).toMatch(/^[0-9a-f]{64}$/u);
    expect(witness).toBe(canonicalSha256([
      MIGRATION_PROJECT_MAP_WITNESS_DOMAIN,
      { localProjectId, remoteProjectId: REMOTE, canonicalPath: canonical },
    ]));
    expect(witness).toBe(migrationProjectMapWitnessDigest({ localProjectId, remoteProjectId: REMOTE, canonicalPath: canonical }));
  });

  it("pre-publication over an unbound entry equals post-publication over the same entry bound to exactly that remote", () => {
    const homeDir = home();
    const { localProjectId, canonical } = fixture(homeDir);
    const pre = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    // S13 binds the map; the readback must observe the same witness.
    writeMap(homeDir, { [localProjectId]: { canonical, aliases: [], remoteProjectId: REMOTE } });
    const post = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "post-publication"));
    expect(post).toBe(pre);
  });

  it("pre-publication also accepts an entry already bound to exactly that remote (re-entry), case-insensitively like the map", () => {
    const homeDir = home();
    const { localProjectId, canonical } = fixture(homeDir, { bound: REMOTE });
    const lower = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    const upper = computeMigrationProjectMapWitnessSha256(
      input(homeDir, localProjectId, "pre-publication", { remoteProjectId: REMOTE.toUpperCase() }),
    );
    expect(lower).toBe(upper);
    expect(lower).toBe(migrationProjectMapWitnessDigest({ localProjectId, remoteProjectId: REMOTE, canonicalPath: canonical }));
  });

  it("never reads remoteProjectId from the map: the digest changes with the caller's value, not the entry's", () => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir);
    const a = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    const b = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication", { remoteProjectId: OTHER_REMOTE }));
    expect(a).not.toBe(b);
  });

  it("changes when the canonical path changes (path drift is visible in the digest)", () => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir);
    const before = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    const moved = join(homeDir, "moved");
    mkdirSync(moved, { mode: 0o700 });
    writeMap(homeDir, { [localProjectId]: { canonical: normalizeProjectPath(moved), aliases: [] } });
    const after = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    expect(after).not.toBe(before);
  });

  it("does not write: map.json bytes and identity are unchanged by either observation", () => {
    const homeDir = home();
    const { localProjectId, canonical } = fixture(homeDir);
    // An orphaned project directory with meta.json would be backfilled
    // into the map by a writing read seam; the witness read must leave it
    // on disk only.
    const orphanCwd = join(homeDir, "orphan");
    mkdirSync(orphanCwd, { mode: 0o700 });
    const orphanId = hashProjectPath(normalizeProjectPath(orphanCwd));
    mkdirSync(join(homeDir, ".lcm", "projects", orphanId), { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "projects", orphanId, "meta.json"), JSON.stringify({ cwd: orphanCwd }), { mode: 0o600 });
    const path = projectMapPath(homeDir);
    const bytesBefore = readFileSync(path, "utf8");
    const statBefore = statSync(path, { bigint: true });
    computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
    const statAfterPre = statSync(path, { bigint: true });
    expect(readFileSync(path, "utf8")).toBe(bytesBefore);
    expect(statAfterPre.ino).toBe(statBefore.ino);
    expect(statAfterPre.mtimeNs).toBe(statBefore.mtimeNs);
    expect(bytesBefore).not.toContain(orphanId);
    writeMap(homeDir, { [localProjectId]: { canonical, aliases: [], remoteProjectId: REMOTE } });
    const boundBytes = readFileSync(path, "utf8");
    const statBound = statSync(path, { bigint: true });
    computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "post-publication"));
    expect(readFileSync(path, "utf8")).toBe(boundBytes);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(statBound.mtimeNs);
    expect(boundBytes).not.toContain(orphanId);
  });
});

describe("computeMigrationProjectMapWitnessSha256: predicate before digest (typed project-map-drift)", () => {
  it.each(["pre-publication", "post-publication"] as const)("%s: an absent entry is entry-absent drift", (mode) => {
    const homeDir = home();
    fixture(homeDir);
    expectDrift(() => computeMigrationProjectMapWitnessSha256(input(homeDir, "f".repeat(64), mode)), "entry-absent");
  });

  it.each(["pre-publication", "post-publication"] as const)("%s: an entry bound to another remote is bound-to-other-remote drift", (mode) => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir, { bound: OTHER_REMOTE });
    expectDrift(() => computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, mode)), "bound-to-other-remote");
  });

  it("post-publication: an entry still unbound is unbound-after-publication drift (S13 did not bind what was verified)", () => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir);
    expectDrift(
      () => computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "post-publication")),
      "unbound-after-publication",
    );
  });

  it("a predicate failure is never reported as a differing digest (collapse check)", () => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir);
    let digest: string | undefined;
    try {
      digest = computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "post-publication"));
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationProjectMapWitnessError);
    }
    expect(digest).toBeUndefined();
  });
});

describe("computeMigrationProjectMapWitnessSha256: unresolvable and invalid input", () => {
  it("wraps a failing map read as project-map-unresolvable with the cause attached, never as drift", () => {
    const homeDir = home();
    const { localProjectId } = fixture(homeDir);
    writeFileSync(projectMapPath(homeDir), "{not json\n", { mode: 0o600 });
    clearProjectMapCache();
    try {
      computeMigrationProjectMapWitnessSha256(input(homeDir, localProjectId, "pre-publication"));
      throw new Error("expected MigrationProjectMapWitnessError");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationProjectMapWitnessError);
      expect((error as MigrationProjectMapWitnessError).reason).toBe("project-map-unresolvable");
      expect((error as MigrationProjectMapWitnessError).drift).toBeNull();
      expect((error as MigrationProjectMapWitnessError).cause).toBeInstanceOf(Error);
    }
  });

  it("uses an injected map reader and forwards homeDir and the publication lock token to it", () => {
    const homeDir = home();
    const { localProjectId, canonical } = fixture(homeDir);
    const token = { kind: "test" } as unknown as NonNullable<ComputeMigrationProjectMapWitnessInput["publicationLockToken"]>;
    const calls: unknown[][] = [];
    const readProjectMap = (...args: unknown[]): ProjectMap => {
      calls.push(args);
      return { [localProjectId]: { canonical, aliases: [], remoteProjectId: REMOTE } };
    };
    const witness = computeMigrationProjectMapWitnessSha256(
      input(homeDir, localProjectId, "post-publication", { publicationLockToken: token }),
      { readProjectMap },
    );
    expect(calls).toEqual([[homeDir, token]]);
    expect(witness).toBe(migrationProjectMapWitnessDigest({ localProjectId, remoteProjectId: REMOTE, canonicalPath: canonical }));
  });

  it.each([
    ["non-object input", null],
    ["empty homeDir", { homeDir: "", localProjectId: "a".repeat(64), remoteProjectId: REMOTE, mode: "pre-publication" }],
    ["non-hash localProjectId", { homeDir: "/tmp", localProjectId: "project", remoteProjectId: REMOTE, mode: "pre-publication" }],
    ["empty remoteProjectId", { homeDir: "/tmp", localProjectId: "a".repeat(64), remoteProjectId: "", mode: "pre-publication" }],
    ["non-UUIDv7 remoteProjectId", { homeDir: "/tmp", localProjectId: "a".repeat(64), remoteProjectId: "remote-project-1", mode: "pre-publication" }],
    ["non-string remoteProjectId", { homeDir: "/tmp", localProjectId: "a".repeat(64), remoteProjectId: 7, mode: "pre-publication" }],
    ["unknown mode", { homeDir: "/tmp", localProjectId: "a".repeat(64), remoteProjectId: REMOTE, mode: "during" }],
  ])("rejects %s as invalid-input before any read", (_name, value) => {
    let read = false;
    try {
      computeMigrationProjectMapWitnessSha256(value as unknown as ComputeMigrationProjectMapWitnessInput, {
        readProjectMap: () => { read = true; return {}; },
      });
      throw new Error("expected MigrationProjectMapWitnessError");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationProjectMapWitnessError);
      expect((error as MigrationProjectMapWitnessError).reason).toBe("invalid-input");
    }
    expect(read).toBe(false);
  });
});

