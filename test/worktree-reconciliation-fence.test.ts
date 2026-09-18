import {
  chmodSync,
  chownSync,
  closeSync,
  type Dirent,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertProjectStorageIdentityActive,
  isAuthenticatedRetiredProjectIdentityFence,
  RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
  RetiredProjectIdentityError,
  isWorktreeReconciliationFence,
  serializeWorktreeReconciliationFence,
} from "../src/worktree-reconciliation-fence.js";

describe("worktree reconciliation fences", () => {
  let root: string;
  const hash = "a".repeat(64);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-reconciliation-fence-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serializes and validates exact project fences", () => {
    const path = join(root, "project-fence");
    const content = serializeWorktreeReconciliationFence(hash, "project");
    expect(content).toBe(`${JSON.stringify({ version: 1, hash, kind: "project" })}\n`);
    writeFileSync(path, content);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(true);
    expect(isWorktreeReconciliationFence(path, "b".repeat(64), "project")).toBe(false);

    writeFileSync(path, `${JSON.stringify({ version: 2, hash, kind: "project" })}\n`);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    writeFileSync(path, "{");
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    writeFileSync(path, "x".repeat(1025));
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);

    rmSync(path);
    mkdirSync(path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    rmSync(path, { recursive: true });
    symlinkSync(join(root, "missing"), path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    rmSync(path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
  });

  it("classifies only an authenticated exact retired project fence", () => {
    const path = join(root, hash);
    const content = serializeWorktreeReconciliationFence(hash, "project");
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(true);
    expect(() => assertProjectStorageIdentityActive(path, hash)).toThrowError(
      expect.objectContaining({
        name: "RetiredProjectIdentityError",
        message: RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
      }),
    );
    expect(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC).toBe(
      "LCM found a retired local project identity. Run `lcm project renew-retired-identity` from this project, then retry. Do not remove the reconciliation fence.",
    );
    expect(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC.length).toBeLessThanOrEqual(240);
    expect(new RetiredProjectIdentityError()).toBeInstanceOf(Error);

    writeFileSync(path, `${JSON.stringify({ version: 1, hash: "b".repeat(64), kind: "project" })}\n`);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    writeFileSync(path, `${JSON.stringify({ version: 1, hash, kind: "events" })}\n`);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    writeFileSync(path, "{");
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);

    writeFileSync(path, content);
    chmodSync(path, 0o640);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    chmodSync(path, 0o600);

    const alias = join(root, "hard-link");
    linkSync(path, alias);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    rmSync(alias);

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(path, 1, 1);
      expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
      chownSync(path, 0, 0);
    }

    rmSync(path);
    mkdirSync(path);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    rmSync(path, { recursive: true });
    symlinkSync(join(root, "missing"), path);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    rmSync(path);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
  });

  it("rejects leaf, content, and retained-parent races", () => {
    const path = join(root, hash);
    const content = serializeWorktreeReconciliationFence(hash, "project");
    const replacement = join(root, "replacement");
    writeFileSync(path, content, { mode: 0o600 });
    writeFileSync(replacement, content, { mode: 0o600 });

    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash, {
      _afterStatForTesting: () => {
        rmSync(path);
        renameSync(replacement, path);
      },
    })).toBe(false);

    writeFileSync(replacement, content, { mode: 0o600 });
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash, {
      _beforeReadForTesting: () => writeFileSync(path, `${content}changed`),
    })).toBe(false);

    writeFileSync(path, content, { mode: 0o600 });
    const oldRoot = `${root}-old`;
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash, {
      _beforePostStatForTesting: () => {
        renameSync(root, oldRoot);
        mkdirSync(root, { mode: 0o700 });
      },
    })).toBe(false);
    rmSync(root, { recursive: true });
    renameSync(oldRoot, root);
  });

  it("refuses classification when the retained parent cannot be released", () => {
    const path = join(root, hash);
    writeFileSync(path, serializeWorktreeReconciliationFence(hash, "project"), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(true);

    const parent = statSync(root);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalCloseSync = nodeFs.closeSync as typeof closeSync;
    const originalFstatSync = nodeFs.fstatSync as typeof fstatSync;
    let retainedParentCloses = 0;
    nodeFs.closeSync = ((fd: number) => {
      let retainedParent: boolean;
      try {
        const observed = originalFstatSync(fd);
        retainedParent = observed.dev === parent.dev && observed.ino === parent.ino;
      } catch {
        retainedParent = false;
      }
      originalCloseSync(fd);
      if (!retainedParent) return;
      retainedParentCloses += 1;
      throw Object.assign(new Error("simulated retained parent release failure"), { code: "EIO" });
    }) as typeof closeSync;
    syncBuiltinESMExports();
    try {
      // An unreleasable retained parent leaves the directory evidence
      // unproven, so the byte-exact fence must still not be classified.
      expect(isAuthenticatedRetiredProjectIdentityFence(path, hash)).toBe(false);
    } finally {
      nodeFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
    }
    expect(retainedParentCloses).toBeGreaterThanOrEqual(1);
  });

  it("requires an exact private event-fence directory shape and marker", () => {
    const path = join(root, `${hash}.db`);
    const marker = join(path, "fence.json");
    mkdirSync(path);
    const content = serializeWorktreeReconciliationFence(hash, "events");
    expect(content).toBe(`${JSON.stringify({ version: 1, hash, kind: "events" })}\n`);
    writeFileSync(marker, content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(true);

    writeFileSync(join(path, "unexpected"), "entry");
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
    rmSync(join(path, "unexpected"));
    rmSync(marker);
    writeFileSync(join(path, "wrong-name"), content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);

    rmSync(path, { recursive: true });
    writeFileSync(path, content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
    rmSync(path);
    const target = join(root, "events-target");
    mkdirSync(target);
    writeFileSync(join(target, "fence.json"), content);
    symlinkSync(target, path, "dir");
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "wrong hash",
      `${JSON.stringify({ version: 1, hash: "b".repeat(64), kind: "events" })}\n`,
    ],
    [
      "wrong kind",
      `${JSON.stringify({ version: 1, hash, kind: "project" })}\n`,
    ],
    [
      "wrong version",
      `${JSON.stringify({ version: 2, hash, kind: "events" })}\n`,
    ],
  ])("rejects an events marker with %s", (_label, content) => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(join(path, "fence.json"), content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });

  it("rejects an oversized or symlinked event marker", () => {
    const path = join(root, `${hash}.db`);
    const marker = join(path, "fence.json");
    mkdirSync(path);
    writeFileSync(marker, "x".repeat(1025));
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);

    rmSync(marker);
    const target = join(root, "marker-target");
    writeFileSync(target, serializeWorktreeReconciliationFence(hash, "events"));
    symlinkSync(target, marker);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });

  it("bounds ordered directory reads and closes exact and huge contaminated event fences", () => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(
      join(path, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );

    const validateEntries = (entries: readonly (string | null)[]) => {
      let index = 0;
      let reads = 0;
      let closes = 0;
      const result = isWorktreeReconciliationFence(path, hash, "events", {
        _openDirectory: (directoryPath) => {
          expect(directoryPath).toBe(path);
          return {
            readSync: () => {
              reads++;
              const name = entries[index++] ?? null;
              return name === null ? null : ({ name } as Dirent);
            },
            closeSync: () => {
              closes++;
            },
          } as ReturnType<typeof opendirSync>;
        },
      });
      return { result, reads, closes };
    };

    expect(validateEntries(["fence.json", null])).toEqual({
      result: true,
      reads: 2,
      closes: 1,
    });
    const contaminants = Array.from(
      { length: 4_096 },
      (_, index) => `contaminant-${index.toString().padStart(4, "0")}`,
    );
    expect(validateEntries(["fence.json", ...contaminants])).toEqual({
      result: false,
      reads: 2,
      closes: 1,
    });
  });

  it("closes the events directory when the deadline expires between bounded reads", () => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(
      join(path, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );
    let deadlineChecks = 0;
    let reads = 0;
    let closes = 0;

    expect(isWorktreeReconciliationFence(path, hash, "events", {
      _deadlineReached: () => ++deadlineChecks === 3,
      _openDirectory: (directoryPath) => {
        const directory = opendirSync(directoryPath);
        return {
          readSync: () => {
            reads++;
            return directory.readSync();
          },
          closeSync: () => {
            closes++;
            directory.closeSync();
          },
        } as ReturnType<typeof opendirSync>;
      },
    })).toBe(false);
    expect(reads).toBe(1);
    expect(closes).toBe(1);
  });

  it("does not open an events directory after the deadline expires following lstat", () => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    let deadlineChecks = 0;
    let opens = 0;

    expect(isWorktreeReconciliationFence(path, hash, "events", {
      _deadlineReached: () => ++deadlineChecks === 2,
      _openDirectory: (directoryPath) => {
        opens++;
        return opendirSync(directoryPath);
      },
    })).toBe(false);
    expect(opens).toBe(0);
  });

  it("does not inspect an events fence when its deadline is already exhausted", () => {
    let opens = 0;

    expect(isWorktreeReconciliationFence(join(root, `${hash}.db`), hash, "events", {
      _deadlineReached: () => true,
      _openDirectory: (directoryPath) => {
        opens++;
        return opendirSync(directoryPath);
      },
    })).toBe(false);
    expect(opens).toBe(0);
  });

  it("closes the events directory when the deadline expires before marker validation", () => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(
      join(path, "fence.json"),
      serializeWorktreeReconciliationFence(hash, "events"),
    );
    let deadlineChecks = 0;
    let reads = 0;
    let closes = 0;

    expect(isWorktreeReconciliationFence(path, hash, "events", {
      _deadlineReached: () => ++deadlineChecks === 4,
      _openDirectory: (directoryPath) => {
        const directory = opendirSync(directoryPath);
        return {
          readSync: () => {
            reads++;
            return directory.readSync();
          },
          closeSync: () => {
            closes++;
            directory.closeSync();
          },
        } as ReturnType<typeof opendirSync>;
      },
    })).toBe(false);
    expect(reads).toBe(2);
    expect(closes).toBe(1);
  });
});
