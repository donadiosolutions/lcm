import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readRace = vi.hoisted(() => ({
  count: 0,
  mutateAfter: Number.POSITIVE_INFINITY,
  mutation: (): void => undefined,
}));

const filesystemFailure = vi.hoisted(() => ({
  lstatPath: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0]) => {
      if (String(path) === filesystemFailure.lstatPath) {
        throw new Error("synthetic lstat failure");
      }
      return actual.lstatSync(path);
    },
  };
});

vi.mock("../src/security-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security-files.js")>();
  return {
    ...actual,
    readBoundedRegularFile: (
      path: string,
      options: Parameters<typeof actual.readBoundedRegularFile>[1],
    ): string => {
      const value = actual.readBoundedRegularFile(path, options);
      readRace.count += 1;
      if (readRace.count === readRace.mutateAfter) readRace.mutation();
      return value;
    },
  };
});

import {
  clearGitProjectAnchorCache,
  resolveGitProjectAnchor,
} from "../src/git-project.js";

function directory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function repository(path: string): string {
  directory(join(path, ".git", "objects"));
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(path, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
  return path;
}

function linkedWorktree(
  primary: string,
  worktree: string,
  name = "linked",
): { gitDir: string; marker: string } {
  const gitDir = directory(join(primary, ".git", "worktrees", name));
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
  const marker = join(directory(worktree), ".git");
  writeFileSync(marker, `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "gitdir"), `${marker}\n`);
  return { gitDir, marker };
}

describe("Git linked-worktree topology authentication", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-git-topology-"));
    readRace.count = 0;
    readRace.mutateAfter = Number.POSITIVE_INFINITY;
    readRace.mutation = (): void => undefined;
    filesystemFailure.lstatPath = "";
    clearGitProjectAnchorCache();
  });

  afterEach(() => {
    readRace.mutateAfter = Number.POSITIVE_INFINITY;
    readRace.mutation = (): void => undefined;
    filesystemFailure.lstatPath = "";
    clearGitProjectAnchorCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects missing, malformed, oversized, and non-regular backpointers", () => {
    const primary = repository(join(root, "primary"));
    const linked = linkedWorktree(primary, join(root, "linked"));
    const backpointer = join(linked.gitDir, "gitdir");

    rmSync(backpointer);
    expect(() => resolveGitProjectAnchor(linked.marker.replace(/\/\.git$/u, "")))
      .toThrow("Git worktree backpointer");

    for (const malformed of ["\n", "one\nother\n", "one\0other"]) {
      writeFileSync(backpointer, malformed);
      clearGitProjectAnchorCache();
      expect(() => resolveGitProjectAnchor(linked.marker.replace(/\/\.git$/u, "")))
        .toThrow("expected one path");
    }

    writeFileSync(backpointer, "x".repeat(70 * 1024));
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked.marker.replace(/\/\.git$/u, "")))
      .toThrow("size limit");

    rmSync(backpointer);
    directory(backpointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked.marker.replace(/\/\.git$/u, "")))
      .toThrow("Git worktree backpointer");

    rmSync(backpointer, { recursive: true });
    const pointerSource = join(root, "pointer-source");
    writeFileSync(pointerSource, `${linked.marker}\n`);
    symlinkSync(pointerSource, backpointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked.marker.replace(/\/\.git$/u, "")))
      .toThrow("Git worktree backpointer");
  });

  it("rejects a foreign or non-regular backpointer target", () => {
    const primary = repository(join(root, "primary"));
    const linked = linkedWorktree(primary, join(root, "linked"));
    const backpointer = join(linked.gitDir, "gitdir");
    const foreign = join(directory(join(root, "foreign")), ".git");
    writeFileSync(foreign, "foreign\n");

    writeFileSync(backpointer, `${foreign}\n`);
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("topology does not point");

    const symlinkTarget = join(root, "symlink-marker");
    symlinkSync(foreign, symlinkTarget);
    writeFileSync(backpointer, `${symlinkTarget}\n`);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("backpointer target or worktree marker is not a regular file");

    const directoryTarget = directory(join(root, "directory-marker"));
    writeFileSync(backpointer, `${directoryTarget}\n`);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("backpointer target or worktree marker is not a regular file");
  });

  it("requires a direct, non-symlink worktrees directory entry", () => {
    const primary = repository(join(root, "primary"));
    const commonDir = join(primary, ".git");
    const linkedRoot = directory(join(root, "linked"));
    const marker = join(linkedRoot, ".git");
    const nestedGitDir = directory(join(commonDir, "worktrees", "container", "nested"));
    writeFileSync(join(nestedGitDir, "commondir"), "../../..\n");
    writeFileSync(join(nestedGitDir, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(nestedGitDir, "gitdir"), `${marker}\n`);
    writeFileSync(marker, `gitdir: ${nestedGitDir}\n`);

    expect(() => resolveGitProjectAnchor(linkedRoot))
      .toThrow("is not a direct worktree entry");

    filesystemFailure.lstatPath = join(commonDir, "worktrees");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linkedRoot))
      .toThrow(`invalid Git worktrees directory at ${filesystemFailure.lstatPath}`);

    filesystemFailure.lstatPath = "";
    rmSync(join(commonDir, "worktrees"), { recursive: true });
    const externalWorktrees = directory(join(root, "external-worktrees"));
    const externalGitDir = directory(join(externalWorktrees, "linked"));
    writeFileSync(join(externalGitDir, "commondir"), `${commonDir}\n`);
    writeFileSync(join(externalGitDir, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(externalGitDir, "gitdir"), `${marker}\n`);
    writeFileSync(marker, `gitdir: ${externalGitDir}\n`);
    symlinkSync(externalWorktrees, join(commonDir, "worktrees"));
    clearGitProjectAnchorCache();

    expect(() => resolveGitProjectAnchor(linkedRoot))
      .toThrow("invalid Git worktrees directory");
  });

  it("fails closed when any topology pointer changes during validation", () => {
    const primary = repository(join(root, "primary"));
    const linked = linkedWorktree(primary, join(root, "linked"));

    const replacement = linkedWorktree(primary, join(root, "replacement"), "replacement");
    readRace.mutateAfter = 3;
    readRace.mutation = () => {
      writeFileSync(linked.marker, `gitdir: ${replacement.gitDir}\n`);
    };
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("Git worktree metadata changed");

    writeFileSync(linked.marker, `gitdir: ${linked.gitDir}\n`);
    const other = repository(join(root, "other"));
    readRace.count = 0;
    readRace.mutateAfter = 4;
    readRace.mutation = () => {
      writeFileSync(join(linked.gitDir, "commondir"), `${join(other, ".git")}\n`);
    };
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("Git common-directory metadata changed");

    writeFileSync(join(linked.gitDir, "commondir"), "../..\n");
    const foreignMarker = join(root, "foreign-marker");
    writeFileSync(foreignMarker, "foreign\n");
    readRace.count = 0;
    readRace.mutateAfter = 5;
    readRace.mutation = () => {
      writeFileSync(join(linked.gitDir, "gitdir"), `${foreignMarker}\n`);
    };
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("Git worktree backpointer changed");

    writeFileSync(join(linked.gitDir, "gitdir"), `${linked.marker}\n`);
    writeFileSync(linked.marker, `gitdir: ${linked.gitDir}\n`);
    const replacementMarker = join(root, "replacement-marker");
    writeFileSync(replacementMarker, `gitdir: ${linked.gitDir}\n`);
    readRace.count = 0;
    readRace.mutateAfter = 6;
    readRace.mutation = () => {
      rmSync(linked.marker);
      symlinkSync(replacementMarker, linked.marker);
    };
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("Git worktree backpointer changed");
  });

  it("rejects a worktree entry moved outside the authenticated common directory", () => {
    const primary = repository(join(root, "primary"));
    const linked = linkedWorktree(primary, join(root, "linked"));
    const moved = join(root, "moved-entry");
    renameSync(linked.gitDir, moved);
    writeFileSync(linked.marker, `gitdir: ${moved}\n`);
    writeFileSync(join(moved, "commondir"), `${join(primary, ".git")}\n`);

    expect(() => resolveGitProjectAnchor(join(root, "linked")))
      .toThrow("is not a direct worktree entry");
  });
});
