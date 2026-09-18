import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  readProjectMapSnapshot,
  renewRetiredProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../src/project-map.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import { serializeWorktreeReconciliationFence } from "../src/worktree-reconciliation-fence.js";

// The retired-identity renewal fixtures mirror test/project-map.test.ts. Those
// helpers are file-local there, so the minimum needed shape is duplicated here
// instead of refactoring a file another owner is editing concurrently.
function resetLcmHome(): void {
  rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
  mkdirSync(join(homedir(), ".lcm"), { recursive: true });
  clearProjectMapCache();
  clearGitProjectAnchorCache();
}

function makeDir(name: string): string {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeProjectMapContent(content: string): void {
  writeFileSync(projectMapPath(), content, { mode: 0o600 });
  clearProjectMapCache();
}

function writeRetiredProjectFixture(canonical: string): string {
  const id = hashProjectPath(normalizeProjectPath(canonical));
  const projects = join(homedir(), ".lcm", "projects");
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  chmodSync(projects, 0o700);
  writeProjectMapContent(`${JSON.stringify({ [id]: { canonical, aliases: [] } })}\n`);
  writeFileSync(
    join(projects, id),
    serializeWorktreeReconciliationFence(id, "project"),
    { mode: 0o600 },
  );
  clearProjectMapCache();
  return id;
}

function makeEventsDir(): string {
  const events = join(homedir(), ".lcm", "events");
  mkdirSync(events, { recursive: true, mode: 0o700 });
  chmodSync(events, 0o700);
  return events;
}

type FsBinding = (...args: unknown[]) => unknown;
type FsPatches = Readonly<Record<string, (original: FsBinding) => FsBinding>>;

/**
 * Replace exact node:fs bindings for the duration of one call. The project map
 * imports these as ESM named bindings, so syncBuiltinESMExports() is required
 * for the replacement to be observable inside src/project-map.ts.
 */
function withPatchedNodeFs<T>(patches: FsPatches, body: () => T): T {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const names = Object.keys(patches);
  const originals = new Map<string, unknown>();
  for (const name of names) {
    const original = nodeFs[name] as FsBinding;
    originals.set(name, original);
    nodeFs[name] = patches[name]!(original);
  }
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    for (const name of names) nodeFs[name] = originals.get(name);
    syncBuiltinESMExports();
  }
}

function isBigIntStat(value: unknown): value is { readonly ino: bigint; readonly gid: bigint; readonly size: bigint } {
  return typeof value === "object"
    && value !== null
    && "ino" in value
    && typeof (value as { ino: unknown }).ino === "bigint";
}

function overrideStat<T extends object>(stat: T, overrides: Partial<Record<string, bigint>>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as T, stat, overrides);
}

function capture(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the renewal call to throw");
}

describe("retired project identity renewal evidence", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-renewal-evidence-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    resetLcmHome();
  });

  afterEach(() => {
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("refuses to derive a successor from a non-canonical retired identity", () => {
    expect(() => retiredProjectIdentitySuccessor("A".repeat(64), "/example/project"))
      .toThrow("retired project identity must be a lowercase sha256 hash");
    expect(() => retiredProjectIdentitySuccessor("a".repeat(63), "/example/project"))
      .toThrow("retired project identity must be a lowercase sha256 hash");
  });

  it("refuses to derive a successor from a relative canonical path", () => {
    expect(() => retiredProjectIdentitySuccessor("a".repeat(64), "example/project"))
      .toThrow("retired project canonical path must be absolute");
  });

  it.each([
    ["absent", () => join(homedir(), "renewal-absent-target")],
    ["regular file", () => {
      const path = join(homedir(), "renewal-file-target");
      writeFileSync(path, "not a directory", { mode: 0o600 });
      return path;
    }],
  ] as const)("refuses renewal for an %s target path", (_label, makeTarget) => {
    const target = makeTarget();

    expect(() => renewRetiredProjectIdentity(target))
      .toThrow("retired project identity renewal requires an existing local directory");
  });

  it("refuses renewal for a path no local map entry owns", () => {
    const canonical = makeDir("renewal-unowned");
    writeProjectMapContent("{}\n");

    expect(() => renewRetiredProjectIdentity(canonical))
      .toThrow("retired project path must have exactly one local map owner");
    expect(readProjectMapSnapshot()).toEqual({});
  });

  it("refuses renewal when the retired and successor identities are both mapped", () => {
    const canonical = makeDir("renewal-both-mapped");
    const oldId = writeRetiredProjectFixture(canonical);
    const newId = retiredProjectIdentitySuccessor(oldId, normalizeProjectPath(canonical));
    const foreign = makeDir("renewal-both-mapped-foreign");
    const beforeMap = `${JSON.stringify({
      [oldId]: { canonical: normalizeProjectPath(foreign), aliases: [] },
      [newId]: { canonical: normalizeProjectPath(canonical), aliases: [] },
    })}\n`;
    writeProjectMapContent(beforeMap);

    expect(() => renewRetiredProjectIdentity(canonical))
      .toThrow("retired and successor project identities are both mapped");
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
  });

  it("refuses renewal when the owning entry binds the path only as an alias", () => {
    const canonical = makeDir("renewal-alias-owner");
    const oldId = writeRetiredProjectFixture(canonical);
    const foreign = makeDir("renewal-alias-owner-foreign");
    const beforeMap = `${JSON.stringify({
      [oldId]: {
        canonical: normalizeProjectPath(foreign),
        aliases: [normalizeProjectPath(canonical)],
      },
    })}\n`;
    writeProjectMapContent(beforeMap);

    expect(() => renewRetiredProjectIdentity(canonical))
      .toThrow("retired project canonical binding changed");
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
  });

  it("refuses renewal when the initial snapshot read reports an absent map", () => {
    const canonical = makeDir("renewal-initial-snapshot-absent");
    const oldId = writeRetiredProjectFixture(canonical);
    const beforeMap = readFileSync(projectMapPath(), "utf8");

    expect(() => renewRetiredProjectIdentity(canonical, {
      _readMapFileForTesting: () => null,
    })).toThrow("retired project map disappeared before renewal");
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readProjectMapSnapshot()[oldId]).toMatchObject({
      canonical: normalizeProjectPath(canonical),
    });
  });

  it("refuses renewal when the reloaded map binding no longer owns the path", () => {
    const canonical = makeDir("renewal-reloaded-binding");
    const oldId = writeRetiredProjectFixture(canonical);
    const newId = retiredProjectIdentitySuccessor(oldId, normalizeProjectPath(canonical));

    expect(() => renewRetiredProjectIdentity(canonical, {
      _afterValidationBeforePublicationForTesting: () => {
        writeProjectMapContent("{}\n");
      },
    })).toThrow("retired project map binding changed before renewal");
    expect(readFileSync(projectMapPath(), "utf8")).toBe("{}\n");
    expect(existsSync(join(homedir(), ".lcm", "projects", newId))).toBe(false);
    expect(existsSync(join(homedir(), ".lcm", "projects", oldId))).toBe(true);
  });

  it("refuses renewal when the map disappears between validation and publication", () => {
    const canonical = makeDir("renewal-publication-absent");
    const oldId = writeRetiredProjectFixture(canonical);
    let fenceReads = 0;

    expect(() => renewRetiredProjectIdentity(canonical, {
      _afterFenceReadForTesting: () => {
        fenceReads += 1;
        // Admission, first validation, then the pre-publication validation.
        if (fenceReads === 3) rmSync(projectMapPath());
      },
    })).toThrow("retired project map disappeared before publication");
    expect(fenceReads).toBe(3);
    expect(existsSync(projectMapPath())).toBe(false);
    expect(readFileSync(join(homedir(), ".lcm", "projects", oldId), "utf8"))
      .toBe(serializeWorktreeReconciliationFence(oldId, "project"));
  });

  it("refuses target admission when the opened descriptor and path entry disagree", () => {
    const canonical = makeDir("renewal-target-admission");
    const oldId = writeRetiredProjectFixture(canonical);
    const normalized = normalizeProjectPath(canonical);
    const beforeMap = readFileSync(projectMapPath(), "utf8");

    const thrown = withPatchedNodeFs({
      lstatSync: original => (...args: unknown[]) => {
        const stat = original(...args);
        if (String(args[0]) === normalized && isBigIntStat(stat)) {
          return overrideStat(stat, { ino: stat.ino + 1n });
        }
        return stat;
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical)));

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message)
      .toBe("retired project target directory changed during admission");
    expect(thrown).not.toBeInstanceOf(AggregateError);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readProjectMapSnapshot()[oldId]).toMatchObject({ canonical: normalized });
  });

  it("aggregates a failed target admission with its failed descriptor cleanup", () => {
    const canonical = makeDir("renewal-target-admission-cleanup");
    const oldId = writeRetiredProjectFixture(canonical);
    const normalized = normalizeProjectPath(canonical);
    const cleanupError = new Error("injected target descriptor close failure");
    const beforeMap = readFileSync(projectMapPath(), "utf8");
    let targetFd: number | undefined;

    const thrown = withPatchedNodeFs({
      openSync: original => (...args: unknown[]) => {
        const fd = original(...args) as number;
        if (String(args[0]) === normalized) targetFd = fd;
        return fd;
      },
      lstatSync: original => (...args: unknown[]) => {
        const stat = original(...args);
        if (String(args[0]) === normalized && isBigIntStat(stat)) {
          return overrideStat(stat, { ino: stat.ino + 1n });
        }
        return stat;
      },
      closeSync: original => (...args: unknown[]) => {
        const result = original(...args);
        if (args[0] === targetFd) {
          // One shot: the descriptor is really closed, so the number is reusable.
          targetFd = undefined;
          throw cleanupError;
        }
        return result;
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical)));

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError & { cause: unknown };
    expect(aggregate.message).toBe("retired project target admission and cleanup failed");
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message)
      .toBe("retired project target directory changed during admission");
    expect(aggregate.errors[1]).toBe(cleanupError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readProjectMapSnapshot()[oldId]).toMatchObject({ canonical: normalized });
  });

  it("refuses renewal when a retained private directory witness drifts", () => {
    const canonical = makeDir("renewal-root-witness-drift");
    const oldId = writeRetiredProjectFixture(canonical);
    const rootStat = statSync(join(homedir(), ".lcm"), { bigint: true });
    const beforeMap = readFileSync(projectMapPath(), "utf8");
    let armed = false;

    const thrown = withPatchedNodeFs({
      fstatSync: original => (...args: unknown[]) => {
        const stat = original(...args);
        if (armed && isBigIntStat(stat) && stat.ino === rootStat.ino) {
          return overrideStat(stat, { gid: stat.gid + 1n });
        }
        return stat;
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical, {
      _afterValidationBeforePublicationForTesting: () => { armed = true; },
    })));

    expect((thrown as Error).message)
      .toBe("retired project private directory changed before renewal");
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readProjectMapSnapshot()[oldId]).toMatchObject({
      canonical: normalizeProjectPath(canonical),
    });
  });

  it("refuses renewal when a retained private parent entry becomes a symlink", () => {
    const canonical = makeDir("renewal-projects-symlink");
    const oldId = writeRetiredProjectFixture(canonical);
    const projects = join(homedir(), ".lcm", "projects");
    const displaced = join(homedir(), ".lcm", "projects-displaced");
    const beforeMap = readFileSync(projectMapPath(), "utf8");

    expect(() => renewRetiredProjectIdentity(canonical, {
      _afterValidationBeforePublicationForTesting: () => {
        renameSync(projects, displaced);
        symlinkSync(displaced, projects);
      },
    })).toThrow("retired project private parent changed before renewal");
    expect(lstatSync(projects).isSymbolicLink()).toBe(true);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readFileSync(join(displaced, oldId), "utf8"))
      .toBe(serializeWorktreeReconciliationFence(oldId, "project"));
  });

  it("propagates a non-ENOENT successor-absence probe failure", () => {
    const canonical = makeDir("renewal-successor-probe");
    const oldId = writeRetiredProjectFixture(canonical);
    const newId = retiredProjectIdentitySuccessor(oldId, normalizeProjectPath(canonical));
    const probeError = Object.assign(new Error("injected successor probe failure"), {
      code: "EACCES",
    });
    const beforeMap = readFileSync(projectMapPath(), "utf8");

    const thrown = withPatchedNodeFs({
      lstatSync: original => (...args: unknown[]) => {
        if (String(args[0]).endsWith(`/${newId}`)) throw probeError;
        return original(...args);
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical)));

    expect(thrown).toBe(probeError);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
    expect(readProjectMapSnapshot()[oldId]).toMatchObject({
      canonical: normalizeProjectPath(canonical),
    });
  });

  it("aggregates a failed fence admission with its failed descriptor cleanup", () => {
    const canonical = makeDir("renewal-fence-admission-cleanup");
    const oldId = writeRetiredProjectFixture(canonical);
    const cleanupError = new Error("injected fence descriptor close failure");
    const beforeMap = readFileSync(projectMapPath(), "utf8");
    let fenceFd: number | undefined;

    const thrown = withPatchedNodeFs({
      openSync: original => (...args: unknown[]) => {
        const fd = original(...args) as number;
        if (String(args[0]).endsWith(`/${oldId}`)) fenceFd = fd;
        return fd;
      },
      closeSync: original => (...args: unknown[]) => {
        const result = original(...args);
        if (args[0] === fenceFd) {
          fenceFd = undefined;
          throw cleanupError;
        }
        return result;
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical, {
      _fenceStatForTesting: (kind, _phase, stat) => (kind === "descriptor"
        ? overrideStat(stat, { size: stat.size + 1n })
        : stat),
    })));

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError & { cause: unknown };
    expect(aggregate.message).toBe("retired project fence admission and cleanup failed");
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message)
      .toBe("retired project fence changed before renewal");
    expect(aggregate.errors[1]).toBe(cleanupError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
  });

  it("aggregates a failed evidence admission with its failed evidence cleanup", () => {
    const canonical = makeDir("renewal-evidence-admission-cleanup");
    makeEventsDir();
    writeRetiredProjectFixture(canonical);
    const normalized = normalizeProjectPath(canonical);
    const cleanupError = new Error("injected evidence target close failure");
    const beforeMap = readFileSync(projectMapPath(), "utf8");
    let targetFd: number | undefined;

    const thrown = withPatchedNodeFs({
      openSync: original => (...args: unknown[]) => {
        const fd = original(...args) as number;
        if (String(args[0]) === normalized) targetFd = fd;
        return fd;
      },
      closeSync: original => (...args: unknown[]) => {
        const result = original(...args);
        if (args[0] === targetFd) {
          targetFd = undefined;
          throw cleanupError;
        }
        return result;
      },
    }, () => capture(() => renewRetiredProjectIdentity(canonical, {
      _fenceStatForTesting: (kind, _phase, stat) => (kind === "descriptor"
        ? overrideStat(stat, { size: stat.size + 1n })
        : stat),
    })));

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError & { cause: unknown };
    expect(aggregate.message)
      .toBe("retired project renewal evidence admission and cleanup failed");
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message)
      .toBe("retired project fence changed before renewal");
    expect(aggregate.errors[1]).toBe(cleanupError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(readFileSync(projectMapPath(), "utf8")).toBe(beforeMap);
  });
});
