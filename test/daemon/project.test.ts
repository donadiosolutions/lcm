import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureProjectDirForIdentity,
  localProjectIdentity,
  localProjectDir,
  localProjectId,
  projectId,
  projectIdentity,
  projectDbPath,
  projectMetaPath,
} from "../../src/daemon/project.js";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, resolveProjectIdentity, setRemoteProjectBinding } from "../../src/project-map.js";
import * as securityFiles from "../../src/security-files.js";

const POSTGRESQL_STORAGE = {
  backend: "postgresql",
  postgresql: {},
} as unknown as ResolvedStorageConfig;
const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const REMOTE_PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";

describe("secure project-root handoff", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-project-root-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    clearProjectMapCache();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("retains the resolved nested selected path at the storage identity boundary", () => {
    const project = join(home, "projects", "nested");
    mkdirSync(project, { recursive: true });
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Test machine",
    }, { homeDir: home });
    const local = resolveProjectIdentity(project);
    setRemoteProjectBinding(REMOTE_PROJECT_ID, { hash: local.id });

    const identity = projectIdentity(project, POSTGRESQL_STORAGE);

    expect(identity.selectedPath).toBe(resolve(project));
    expect(identity.canonical).toBe(resolve(project));
  });

  it("retains the selected symlink spelling instead of canonicalizing it", () => {
    const target = join(home, "target");
    const selected = join(home, "selected-link");
    mkdirSync(target);
    symlinkSync(target, selected);
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"b".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Test machine",
    }, { homeDir: home });
    const local = resolveProjectIdentity(selected);
    setRemoteProjectBinding(REMOTE_PROJECT_ID, { hash: local.id });

    const identity = projectIdentity(selected, POSTGRESQL_STORAGE);

    expect(identity.selectedPath).toBe(resolve(selected));
    expect(identity.selectedPath).not.toBe(resolve(target));
  });

  it("retains a linked worktree path when the local canonical identity is the Git anchor", () => {
    const main = join(home, "main");
    const linked = join(home, "linked");
    mkdirSync(main);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: main });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: main });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: main });
    writeFileSync(join(main, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: main });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: main });
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"c".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Test machine",
    }, { homeDir: home });
    const local = resolveProjectIdentity(linked);
    setRemoteProjectBinding(REMOTE_PROJECT_ID, { hash: local.id });

    const identity = projectIdentity(linked, POSTGRESQL_STORAGE);

    expect(identity.canonical).toBe(resolve(main));
    expect(identity.selectedPath).toBe(resolve(linked));
    expect(identity.selectedPath).not.toBe(identity.canonical);
  });

  it("does not create ~/.lcm when the operator has not bootstrapped it", () => {
    expect(() => ensureProjectDirForIdentity({ id: "a".repeat(64), canonical: "/project" })).toThrow();
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("creates a private project directory without metadata when requested", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "c".repeat(64), canonical: "/project" };
    const previousUmask = process.umask(0o022);
    try {
      const dir = ensureProjectDirForIdentity(identity, { writeMetadata: false });

      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(existsSync(join(dir, "meta.json"))).toBe(false);

      expect(ensureProjectDirForIdentity(identity)).toBe(dir);
      expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual({ cwd: "/project" });
      expect(statSync(join(dir, "meta.json")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("rejects a pre-existing project symlink without changing its target", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const outside = join(home, "outside");
    mkdirSync(outside, { mode: 0o755 });
    const projects = join(home, ".lcm", "projects");
    mkdirSync(projects, { mode: 0o700 });
    symlinkSync(outside, join(projects, "e".repeat(64)));

    expect(() => ensureProjectDirForIdentity({ id: "e".repeat(64), canonical: "/project" }, { writeMetadata: false }))
      .toThrow();
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  it("rejects an existing project directory with a non-private mode", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const projects = join(home, ".lcm", "projects");
    const leaf = join(projects, "f".repeat(64));
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    chmodSync(leaf, 0o755);

    expect(() => ensureProjectDirForIdentity({ id: "f".repeat(64), canonical: "/project" }, { writeMetadata: false }))
      .toThrow();
    expect(statSync(leaf).mode & 0o777).toBe(0o755);
  });

  it("rejects an invalid project identity before opening the LCM root", () => {
    expect(() => ensureProjectDirForIdentity({ id: "bad", canonical: "/project" })).toThrow(/valid hash/);
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("preserves metadata keys while replacing a stale canonical cwd", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "1".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: "/old", extra: true }));

    ensureProjectDirForIdentity(identity);

    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toMatchObject({
      cwd: "/project",
      extra: true,
    });
  });

  it("uses the default metadata for a syntax-error snapshot", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "2".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), "{");

    ensureProjectDirForIdentity(identity);

    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual({ cwd: "/project" });
  });

  it("returns early when metadata already has the canonical cwd", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "4".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: "/project", extra: true }));

    expect(ensureProjectDirForIdentity(identity)).toBe(dir);
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual({ cwd: "/project", extra: true });
  });

  it("rejects a parsed non-object metadata value", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "5".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), "null");

    expect(() => ensureProjectDirForIdentity(identity)).toThrow("invalid project metadata");
  });

  it("propagates non-syntax parser failures", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "6".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), "{}");
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new Error("parser failed");
    });
    try {
      expect(() => ensureProjectDirForIdentity(identity)).toThrow("parser failed");
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("reports a descriptor close failure after a successful admission", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const closeError = new Error("root close failed");
    const originalOpen = securityFiles.openPrivateDirectory;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      return path === rootPath ? { ...handle, close: () => { throw closeError; } } : handle;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "7".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(closeError);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("aggregates multiple descriptor close failures after admission", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    mkdirSync(join(rootPath, "projects"), { mode: 0o700 });
    const closeError = new Error("directory close failed");
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalOpenIfExists = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      return path === rootPath ? { ...handle, close: () => { throw closeError; } } : handle;
    });
    const optionalSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalOpenIfExists(path, options);
      return handle === undefined ? handle : { ...handle, close: () => { throw closeError; } };
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "9".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(AggregateError);
    } finally {
      optionalSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("preserves an admission error when descriptor cleanup also fails", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projects = join(rootPath, "projects");
    const leaf = join(projects, "8".repeat(64));
    mkdirSync(leaf, { recursive: true, mode: 0o755 });
    const closeError = new Error("root close failed");
    const originalOpen = securityFiles.openPrivateDirectory;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      return path === rootPath ? { ...handle, close: () => { throw closeError; } } : handle;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "8".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(AggregateError);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("propagates bounded metadata policy failures instead of overwriting them", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "3".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(join(home, "outside-meta"), join(dir, "meta.json"));

    expect(() => ensureProjectDirForIdentity(identity)).toThrow();
  });

  it("falls back to the normalized path for malformed compatibility entries", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
      "not-a-hash": { canonical: "/ignored", aliases: [] },
      ["a".repeat(64)]: null,
      ["b".repeat(64)]: { canonical: 42, aliases: [] },
      ["c".repeat(64)]: { canonical: "\u0000", aliases: [] },
    }));
    expect(localProjectIdentity("/project", home).canonical).toBe("/project");
    expect(localProjectIdentity("/project", home).id).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("falls back when the compatibility snapshot is not an object", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    writeFileSync(join(home, ".lcm", "map.json"), "null");

    const identity = localProjectIdentity("/project", home);

    expect(identity.canonical).toBe("/project");
    expect(identity.id).toBe(localProjectIdentity("/project", join(home, "other-home")).id);
  });

  it("preserves a valid compatibility-map identity and derives its sidecar path", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const mappedId = "d".repeat(64);
    writeFileSync(join(home, ".lcm", "map.json"), JSON.stringify({
      [mappedId]: { canonical: "/project", aliases: ["/project-alias"] },
    }));

    const identity = localProjectIdentity("/project", home);

    expect(identity.canonical).toBe(resolve("/project"));
    expect(identity.id).toBe(localProjectId("/project", home));
    expect(localProjectDir("/project", home)).toContain(join("projects", identity.id));
  });

  it.each([
    ["metadata publication", undefined],
    ["directory-only creation", { writeMetadata: false }],
  ] as const)("fails closed when the retained root witness changes during %s", (_label, options) => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const originalAssert = securityFiles.assertPrivateDirectory;
    let calls = 0;
    const assert = vi.spyOn(securityFiles, "assertPrivateDirectory").mockImplementation((handle, path, expected) => {
      const actual = originalAssert(handle, path, expected);
      calls += 1;
      return calls === 2 ? { ...actual, ino: `${actual.ino}-changed` } : actual;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "b".repeat(64), canonical: "/project" }, options))
        .toThrow("private directory witness changed");
    } finally {
      assert.mockRestore();
    }
  });
});

describe("projectId", () => {
  it("returns sha256 hex of absolute path", () => expect(projectId("/foo")).toMatch(/^[a-f0-9]{64}$/));
  it("is deterministic", () => expect(projectId("/foo")).toBe(projectId("/foo")));
  it("differs for different paths", () => expect(projectId("/foo")).not.toBe(projectId("/bar")));
});

describe("projectDbPath", () => {
  it("returns path under .lcm/projects/<id>/db.sqlite", () => {
    const p = projectDbPath("/foo/bar");
    expect(p).toContain(".lcm");
    expect(p).toContain("projects");
    expect(p).toContain("db.sqlite");
  });
});

describe("projectMetaPath", () => {
  it("returns path ending in meta.json", () => {
    expect(projectMetaPath("/foo")).toContain("meta.json");
  });
});
