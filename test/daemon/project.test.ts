import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, fchmodSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

function withPatchedFs<T>(name: string, replacement: unknown, callback: () => T): T {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const original = nodeFs[name];
  nodeFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return callback();
  } finally {
    nodeFs[name] = original;
    syncBuiltinESMExports();
  }
}

function captureThrown(callback: () => unknown): unknown {
  let didThrow = false;
  let thrown: unknown = Symbol("not thrown");
  try {
    callback();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  expect(didThrow).toBe(true);
  return thrown;
}

function trackedDirectoryHandle(
  path: string,
  handle: securityFiles.PrivateDirectoryHandle,
  closeCounts: Map<string, number>,
  closeFailures: Map<string, unknown> = new Map(),
): securityFiles.PrivateDirectoryHandle {
  return {
    ...handle,
    close: () => {
      closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
      handle.close();
      if (closeFailures.has(path)) throw closeFailures.get(path);
    },
  };
}

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

  it("rejects a pre-existing projects symlink before touching its target", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const outside = join(home, "outside-projects");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, join(home, ".lcm", "projects"));

    expect(() => ensureProjectDirForIdentity({ id: "d".repeat(64), canonical: "/project" }, { writeMetadata: false }))
      .toThrow();
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  it("rejects a non-directory project leaf without pathname chmod", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const projects = join(home, ".lcm", "projects");
    const leaf = join(projects, "0".repeat(64));
    mkdirSync(projects, { mode: 0o700 });
    writeFileSync(leaf, "sentinel", { mode: 0o644 });
    let chmodCalls = 0;
    const originalChmod = chmodSync;
    withPatchedFs("chmodSync", ((...args: Parameters<typeof chmodSync>) => {
      chmodCalls++;
      return originalChmod(...args);
    }) as typeof chmodSync, () => {
      expect(() => ensureProjectDirForIdentity({ id: "0".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow();
    });
    expect(readFileSync(leaf, "utf8")).toBe("sentinel");
    expect(chmodCalls).toBe(0);
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

  it.each([
    ["metadata", {}],
    ["directory-only", { writeMetadata: false }],
  ] as const)("rejects injected matching-entry drift without changing metadata on %s early return", (_label, options) => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "b".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const metaPath = join(dir, "meta.json");
    const content = '{"cwd":"/project","extra":"preserve"}\n';
    writeFileSync(metaPath, content, { mode: 0o600 });
    const before = statSync(metaPath, { bigint: true });
    let leafAssertions = 0;
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === dir) {
        leafAssertions++;
        if (leafAssertions === 3) throw new Error("injected matching-entry drift");
      }
      return originalEntry(handle, path, uid);
    });

    try {
      expect(() => ensureProjectDirForIdentity(identity, options)).toThrow("injected matching-entry drift");
    } finally {
      entrySpy.mockRestore();
    }

    const after = statSync(metaPath, { bigint: true });
    expect(readFileSync(metaPath, "utf8")).toBe(content);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it("converges created children under umask 077", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const previousUmask = process.umask(0o077);
    try {
      const identity = { id: "c".repeat(64), canonical: "/project" };
      const dir = ensureProjectDirForIdentity(identity, { writeMetadata: false });
      expect(statSync(join(home, ".lcm", "projects")).mode & 0o777).toBe(0o700);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails closed when created-child descriptor opening returns EACCES", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const openError = Object.assign(new Error("owner-read-stripping umask"), { code: "EACCES" });
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation").mockImplementation(() => {
      throw openError;
    });
    try {
      expect(captureThrown(() => ensureProjectDirForIdentity(
        { id: "a".repeat(64), canonical: "/project" },
        { writeMetadata: false },
      ))).toBe(openError);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects an existing unsafe child under a restrictive umask", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const projects = join(home, ".lcm", "projects");
    const leaf = join(projects, "6".repeat(64));
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    chmodSync(leaf, 0o755);
    const previousUmask = process.umask(0o077);
    try {
      expect(() => ensureProjectDirForIdentity({ id: "6".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow();
      expect(statSync(leaf).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("authenticates an EEXIST child without fchmod or creation admission", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const projects = join(home, ".lcm", "projects");
    const id = "2".repeat(64);
    const leaf = join(projects, id);
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const originalMkdir = mkdirSync;
    const originalFchmod = fchmodSync;
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      if (path === leaf) return undefined;
      return originalProbe(path, options);
    });
    const strictOpen = vi.spyOn(securityFiles, "openPrivateDirectory");
    const creationSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation");
    let fchmodCalls = 0;
    try {
      withPatchedFs("mkdirSync", ((path: string, options: Parameters<typeof mkdirSync>[1]) => {
        if (path === leaf) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        return originalMkdir(path, options);
      }) as typeof mkdirSync, () => withPatchedFs(
        "fchmodSync",
        ((...args: Parameters<typeof fchmodSync>) => {
          fchmodCalls++;
          return originalFchmod(...args);
        }) as typeof fchmodSync,
        () => ensureProjectDirForIdentity({ id, canonical: "/project" }, { writeMetadata: false }),
      ));
      expect(strictOpen.mock.calls.some(([path]) => path === leaf)).toBe(true);
      expect(creationSpy).not.toHaveBeenCalled();
      expect(fchmodCalls).toBe(0);
    } finally {
      creationSpy.mockRestore();
      strictOpen.mockRestore();
      probeSpy.mockRestore();
    }
  });

  it("rejects an EEXIST child when strict authentication fails and closes ancestors", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projects = join(rootPath, "projects");
    const id = "3".repeat(64);
    const leaf = join(projects, id);
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    const closeCounts = new Map<string, number>();
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const originalMkdir = mkdirSync;
    const wrap = (path: string, handle: securityFiles.PrivateDirectoryHandle): securityFiles.PrivateDirectoryHandle => ({
      ...handle,
      close: () => {
        closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
        handle.close();
      },
    });
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      if (path === leaf) throw new Error("strict EEXIST authentication failed");
      return wrap(path, originalOpen(path, options));
    });
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      if (path === leaf) return undefined;
      const handle = originalProbe(path, options);
      return handle === undefined ? handle : wrap(path, handle);
    });
    try {
      withPatchedFs("mkdirSync", ((path: string, options: Parameters<typeof mkdirSync>[1]) => {
        if (path === leaf) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        return originalMkdir(path, options);
      }) as typeof mkdirSync, () => {
        expect(() => ensureProjectDirForIdentity({ id, canonical: "/project" }, { writeMetadata: false }))
          .toThrow("strict EEXIST authentication failed");
      });
      expect(closeCounts.get(rootPath)).toBe(1);
      expect(closeCounts.get(projects)).toBe(1);
    } finally {
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("closes an existing child when entry authentication fails", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const projects = join(home, ".lcm", "projects");
    const id = "7".repeat(64);
    mkdirSync(join(projects, id), { recursive: true, mode: 0o700 });
    const closeCounts = new Map<string, number>();
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalOpenIfExists = securityFiles.openPrivateDirectoryIfExists;
    const originalOpenCreation = securityFiles.openPrivateDirectoryForCreation;
    const wrap = (path: string, handle: securityFiles.PrivateDirectoryHandle): securityFiles.PrivateDirectoryHandle => ({
      ...handle,
      close: () => {
        closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
        handle.close();
      },
    });
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      wrap(path, originalOpen(path, options)));
    const optionalSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalOpenIfExists(path, options);
      return handle === undefined ? handle : wrap(path, handle);
    });
    const creationSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation").mockImplementation((path, options) =>
      wrap(path, originalOpenCreation(path, options)));
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const admissionError = new Error("existing child authentication failed");
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === join(projects, id)) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    try {
      expect(captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ))).toBe(admissionError);
      expect(closeCounts.get(join(home, ".lcm"))).toBe(1);
      expect(closeCounts.get(projects)).toBe(1);
      expect(closeCounts.get(join(projects, id))).toBe(1);
    } finally {
      entrySpy.mockRestore();
      creationSpy.mockRestore();
      optionalSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("preserves a non-EEXIST child mkdir failure", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const closeCounts = new Map<string, number>();
    const originalOpen = securityFiles.openPrivateDirectory;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      return {
        ...handle,
        close: () => {
          closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
          handle.close();
        },
      };
    });
    withPatchedFs("mkdirSync", ((..._args: Parameters<typeof mkdirSync>) => {
      throw Object.assign(new Error("child mkdir denied"), { code: "EACCES" });
    }) as typeof mkdirSync, () => {
      expect(() => ensureProjectDirForIdentity({ id: "8".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow("child mkdir denied");
    });
    expect(closeCounts.get(rootPath)).toBe(1);
    openSpy.mockRestore();
  });

  it("preserves a created-child descriptor authentication failure", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "9".repeat(64);
    const leafPath = join(projectsPath, id);
    const closeCounts = new Map<string, number>();
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalOpenIfExists = securityFiles.openPrivateDirectoryIfExists;
    const wrap = (path: string, handle: securityFiles.PrivateDirectoryHandle): securityFiles.PrivateDirectoryHandle => ({
      ...handle,
      close: () => {
        closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
        handle.close();
      },
    });
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      wrap(path, originalOpen(path, options)));
    const optionalSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalOpenIfExists(path, options);
      return handle === undefined ? handle : wrap(path, handle);
    });
    const originalOpenCreation = securityFiles.openPrivateDirectoryForCreation;
    const creationSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation").mockImplementation((path, options) =>
      wrap(path, originalOpenCreation(path, options)));
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const admissionError = new Error("created child authentication failed");
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath && existsSync(leafPath)) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    try {
      expect(captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ))).toBe(admissionError);
      expect(closeCounts.get(rootPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(leafPath)).toBe(1);
    } finally {
      entrySpy.mockRestore();
      creationSpy.mockRestore();
      optionalSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("aggregates existing-child admission and cleanup failures before metadata", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "d".repeat(64);
    const leafPath = join(projectsPath, id);
    mkdirSync(leafPath, { recursive: true, mode: 0o700 });
    const admissionError = new Error("existing leaf admission failed");
    const childCloseError = new Error("existing leaf close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([[leafPath, childCloseError]]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    const metadataSpy = vi.spyOn(securityFiles, "atomicWritePrivateFile");
    try {
      const thrown = captureThrown(() => ensureProjectDirForIdentity({ id, canonical: "/project" }));
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.message).toBe("project child admission and cleanup failed");
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(admissionError);
      expect(aggregate.errors[1]).toBe(childCloseError);
      expect(aggregate.cause).toBe(admissionError);
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
      expect(metadataSpy).not.toHaveBeenCalled();
    } finally {
      metadataSpy.mockRestore();
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("aggregates created-child fchmod and cleanup failures", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "e".repeat(64);
    const leafPath = join(projectsPath, id);
    const chmodError = Object.assign(new Error("leaf fchmod failed"), { code: "EIO" });
    const childCloseError = new Error("created leaf close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([[leafPath, childCloseError]]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const originalCreation = securityFiles.openPrivateDirectoryForCreation;
    const originalFchmod = fchmodSync;
    let leafFd: number | undefined;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const creationSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation").mockImplementation((path, options) => {
      const handle = originalCreation(path, options);
      if (path === leafPath) leafFd = handle.fd;
      return trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    try {
      const thrown = withPatchedFs("fchmodSync", ((fd: number, mode: number) => {
        if (fd === leafFd) throw chmodError;
        return originalFchmod(fd, mode);
      }) as typeof fchmodSync, () => captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      )));
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(chmodError);
      expect(aggregate.errors[1]).toBe(childCloseError);
      expect(aggregate.cause).toBe(chmodError);
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
    } finally {
      creationSpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("aggregates EEXIST admission and cleanup failures without fchmod", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "f".repeat(64);
    const leafPath = join(projectsPath, id);
    mkdirSync(leafPath, { recursive: true, mode: 0o700 });
    const admissionError = new Error("EEXIST leaf admission failed");
    const childCloseError = new Error("EEXIST leaf close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([[leafPath, childCloseError]]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const originalMkdir = mkdirSync;
    const originalFchmod = fchmodSync;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      if (path === leafPath) return undefined;
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    const metadataSpy = vi.spyOn(securityFiles, "atomicWritePrivateFile");
    let fchmodCalls = 0;
    try {
      const thrown = withPatchedFs("mkdirSync", ((path: string, options: Parameters<typeof mkdirSync>[1]) => {
        if (path === leafPath) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        return originalMkdir(path, options);
      }) as typeof mkdirSync, () => withPatchedFs("fchmodSync", ((...args: Parameters<typeof fchmodSync>) => {
        fchmodCalls++;
        return originalFchmod(...args);
      }) as typeof fchmodSync, () => captureThrown(() => ensureProjectDirForIdentity({ id, canonical: "/project" }))));
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(admissionError);
      expect(aggregate.errors[1]).toBe(childCloseError);
      expect(aggregate.cause).toBe(admissionError);
      expect(fchmodCalls).toBe(0);
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
      expect(metadataSpy).not.toHaveBeenCalled();
    } finally {
      metadataSpy.mockRestore();
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("closes only the root after projects-child admission and cleanup fail", () => {
    mkdirSync(join(home, ".lcm", "projects"), { recursive: true, mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "1".repeat(64);
    const admissionError = new Error("projects admission failed");
    const childCloseError = new Error("projects close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([[projectsPath, childCloseError]]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === projectsPath) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    const creationSpy = vi.spyOn(securityFiles, "openPrivateDirectoryForCreation");
    try {
      const thrown = captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ));
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(admissionError);
      expect(aggregate.errors[1]).toBe(childCloseError);
      expect(aggregate.cause).toBe(admissionError);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
      expect(closeCounts.has(join(projectsPath, id))).toBe(false);
      expect(creationSpy).not.toHaveBeenCalled();
    } finally {
      creationSpy.mockRestore();
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("retains nested aggregate identities across child and ancestor cleanup failures", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "2".repeat(64);
    const leafPath = join(projectsPath, id);
    mkdirSync(leafPath, { recursive: true, mode: 0o700 });
    const admissionError = new AggregateError([new Error("original detail")], "original aggregate");
    const childCloseError = new Error("leaf close failed");
    const ancestorCloseError = new Error("projects close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([
      [leafPath, childCloseError],
      [projectsPath, ancestorCloseError],
    ]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath) throw admissionError;
      return originalEntry(handle, path, uid);
    });
    try {
      const thrown = captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ));
      expect(thrown).toBeInstanceOf(AggregateError);
      const outer = thrown as AggregateError;
      expect(outer.message).toBe("project directory operation and cleanup failed");
      expect(outer.errors).toHaveLength(2);
      expect(outer.errors[1]).toBe(ancestorCloseError);
      expect(outer.cause).toBe(outer.errors[0]);
      const inner = outer.errors[0] as AggregateError;
      expect(inner).toBeInstanceOf(AggregateError);
      expect(inner.message).toBe("project child admission and cleanup failed");
      expect(inner.errors).toHaveLength(2);
      expect(inner.errors[0]).toBe(admissionError);
      expect(inner.errors[1]).toBe(childCloseError);
      expect(inner.cause).toBe(admissionError);
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
    } finally {
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it.each([
    ["successful cleanup", false],
    ["failed cleanup", true],
  ] as const)("preserves an undefined child admission failure with %s", (_label, failChildClose) => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "3".repeat(64);
    const leafPath = join(projectsPath, id);
    mkdirSync(leafPath, { recursive: true, mode: 0o700 });
    const childCloseError = new Error("leaf close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = failChildClose
      ? new Map<string, unknown>([[leafPath, childCloseError]])
      : new Map<string, unknown>();
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath) throw undefined;
      return originalEntry(handle, path, uid);
    });
    try {
      const thrown = captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ));
      if (failChildClose) {
        expect(thrown).toBeInstanceOf(AggregateError);
        const aggregate = thrown as AggregateError;
        expect(aggregate.errors).toHaveLength(2);
        expect(aggregate.errors[0]).toBeUndefined();
        expect(aggregate.errors[1]).toBe(childCloseError);
        expect(Object.hasOwn(aggregate, "cause")).toBe(true);
        expect(aggregate.cause).toBeUndefined();
      } else {
        expect(thrown).toBeUndefined();
      }
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
    } finally {
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("retains an undefined child failure when ancestor cleanup also fails", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projectsPath = join(rootPath, "projects");
    const id = "4".repeat(64);
    const leafPath = join(projectsPath, id);
    mkdirSync(leafPath, { recursive: true, mode: 0o700 });
    const ancestorCloseError = new Error("projects close failed");
    const closeCounts = new Map<string, number>();
    const closeFailures = new Map<string, unknown>([[projectsPath, ancestorCloseError]]);
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalProbe = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) =>
      trackedDirectoryHandle(path, originalOpen(path, options), closeCounts, closeFailures));
    const probeSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalProbe(path, options);
      return handle === undefined
        ? undefined
        : trackedDirectoryHandle(path, handle, closeCounts, closeFailures);
    });
    const originalEntry = securityFiles.assertPrivateDirectoryEntry;
    const entrySpy = vi.spyOn(securityFiles, "assertPrivateDirectoryEntry").mockImplementation((handle, path, uid) => {
      if (path === leafPath) throw undefined;
      return originalEntry(handle, path, uid);
    });
    try {
      const thrown = captureThrown(() => ensureProjectDirForIdentity(
        { id, canonical: "/project" },
        { writeMetadata: false },
      ));
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBeUndefined();
      expect(aggregate.errors[1]).toBe(ancestorCloseError);
      expect(Object.hasOwn(aggregate, "cause")).toBe(true);
      expect(aggregate.cause).toBeUndefined();
      expect(closeCounts.get(leafPath)).toBe(1);
      expect(closeCounts.get(projectsPath)).toBe(1);
      expect(closeCounts.get(rootPath)).toBe(1);
    } finally {
      entrySpy.mockRestore();
      probeSpy.mockRestore();
      openSpy.mockRestore();
    }
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

  it.each([
    ["the canonical cwd", "/project"],
    ["a different cwd", "/old-project"],
  ])("rejects hard-linked metadata containing %s", (_description, storedCwd) => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "d".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    const targetPath = join(home, "linked-project-metadata.json");
    const metaPath = join(dir, "meta.json");
    const original = JSON.stringify({ cwd: storedCwd, extra: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, original);
    linkSync(targetPath, metaPath);

    expect(() => ensureProjectDirForIdentity(identity)).toThrow("multiple hard links");
    expect(readFileSync(metaPath, "utf8")).toBe(original);
    expect(readFileSync(targetPath, "utf8")).toBe(original);
    expect(statSync(metaPath).ino).toBe(statSync(targetPath).ino);
  });

  it("rejects foreign-owned metadata before parsing or rewriting it", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "e".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    const metaPath = join(dir, "meta.json");
    const original = JSON.stringify({ cwd: "/old-project", extra: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(metaPath, original);
    const metadataStat = statSync(metaPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalFstat = nodeFs.fstatSync as typeof fstatSync;
    const parseSpy = vi.spyOn(JSON, "parse");
    const writeSpy = vi.spyOn(securityFiles, "atomicWritePrivateFile");
    try {
      expect(() => withPatchedFs("fstatSync", ((fd: number, options?: unknown) => {
        const observed = originalFstat(fd, options as never);
        if (observed.dev !== metadataStat.dev || observed.ino !== metadataStat.ino) return observed;
        const foreign = Object.create(observed) as typeof observed;
        Object.defineProperty(foreign, "uid", { value: metadataStat.uid + 1 });
        return foreign;
      }) as typeof fstatSync, () => ensureProjectDirForIdentity(identity)))
        .toThrow("file owner is not trusted");
      expect(parseSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(readFileSync(metaPath, "utf8")).toBe(original);
    } finally {
      writeSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });

  it.each(["null", "[]", "42"])("falls back for a parsed non-object metadata value %s", (content) => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "5".repeat(64), canonical: "/project" };
    const dir = join(home, ".lcm", "projects", identity.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "meta.json"), content);

    expect(() => ensureProjectDirForIdentity(identity)).not.toThrow();
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual({ cwd: "/project" });
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
    const capturedHandles: securityFiles.PrivateDirectoryHandle[] = [];
    const originalOpen = securityFiles.openPrivateDirectory;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      if (path === rootPath) capturedHandles.push(handle);
      return path === rootPath
        ? {
          ...handle,
          close: () => {
            handle.close();
            throw closeError;
          },
        }
        : handle;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "7".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(closeError);
      expect(capturedHandles).toHaveLength(1);
      for (const handle of capturedHandles) {
        let fstatError: unknown;
        try {
          fstatSync(handle.fd);
        } catch (error) {
          fstatError = error;
        }
        expect(fstatError).toMatchObject({ code: "EBADF" });
      }
    } finally {
      try {
        for (const handle of capturedHandles) handle.close();
      } finally {
        openSpy.mockRestore();
      }
    }
  });

  it("aggregates multiple descriptor close failures after admission", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    mkdirSync(join(rootPath, "projects"), { mode: 0o700 });
    const closeError = new Error("directory close failed");
    const capturedHandles: securityFiles.PrivateDirectoryHandle[] = [];
    const originalOpen = securityFiles.openPrivateDirectory;
    const originalOpenIfExists = securityFiles.openPrivateDirectoryIfExists;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      if (path === rootPath) capturedHandles.push(handle);
      return path === rootPath
        ? {
          ...handle,
          close: () => {
            handle.close();
            throw closeError;
          },
        }
        : handle;
    });
    const optionalSpy = vi.spyOn(securityFiles, "openPrivateDirectoryIfExists").mockImplementation((path, options) => {
      const handle = originalOpenIfExists(path, options);
      if (handle !== undefined) capturedHandles.push(handle);
      return handle === undefined
        ? handle
        : {
          ...handle,
          close: () => {
            handle.close();
            throw closeError;
          },
        };
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "9".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(AggregateError);
      expect(capturedHandles).toHaveLength(2);
      for (const handle of capturedHandles) {
        let fstatError: unknown;
        try {
          fstatSync(handle.fd);
        } catch (error) {
          fstatError = error;
        }
        expect(fstatError).toMatchObject({ code: "EBADF" });
      }
    } finally {
      try {
        for (const handle of capturedHandles) handle.close();
      } finally {
        optionalSpy.mockRestore();
        openSpy.mockRestore();
      }
    }
  });

  it("preserves an admission error when descriptor cleanup also fails", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const rootPath = join(home, ".lcm");
    const projects = join(rootPath, "projects");
    const leaf = join(projects, "8".repeat(64));
    mkdirSync(leaf, { recursive: true, mode: 0o755 });
    const closeError = new Error("root close failed");
    const capturedHandles: securityFiles.PrivateDirectoryHandle[] = [];
    const originalOpen = securityFiles.openPrivateDirectory;
    const openSpy = vi.spyOn(securityFiles, "openPrivateDirectory").mockImplementation((path, options) => {
      const handle = originalOpen(path, options);
      if (path === rootPath) capturedHandles.push(handle);
      return path === rootPath
        ? {
          ...handle,
          close: () => {
            handle.close();
            throw closeError;
          },
        }
        : handle;
    });
    try {
      expect(() => ensureProjectDirForIdentity({ id: "8".repeat(64), canonical: "/project" }, { writeMetadata: false }))
        .toThrow(AggregateError);
      expect(capturedHandles).toHaveLength(1);
      for (const handle of capturedHandles) {
        let fstatError: unknown;
        try {
          fstatSync(handle.fd);
        } catch (error) {
          fstatError = error;
        }
        expect(fstatError).toMatchObject({ code: "EBADF" });
      }
    } finally {
      try {
        for (const handle of capturedHandles) handle.close();
      } finally {
        openSpy.mockRestore();
      }
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

  it("preserves an explicitly thrown undefined metadata-read failure", () => {
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const identity = { id: "a".repeat(64), canonical: "/project" };
    const readSpy = vi.spyOn(securityFiles, "readBoundedRegularFile").mockImplementationOnce(() => {
      throw undefined;
    });
    try {
      let didThrow = false;
      let caught: unknown = "sentinel";
      try {
        ensureProjectDirForIdentity(identity);
      } catch (error) {
        didThrow = true;
        caught = error;
      }
      expect(didThrow).toBe(true);
      expect(caught).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
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
