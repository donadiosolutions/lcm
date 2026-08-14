import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("fails closed when the retained root witness changes during metadata publication", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const originalAssert = securityFiles.assertPrivateDirectory;
    let calls = 0;
    const assert = vi.spyOn(securityFiles, "assertPrivateDirectory").mockImplementation((handle, path, expected) => {
      const actual = originalAssert(handle, path, expected);
      calls += 1;
      return calls === 2 ? { ...actual, ino: `${actual.ino}-changed` } : actual;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "b".repeat(64), canonical: "/project" }))
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
