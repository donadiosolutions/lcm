import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathBoundary = vi.hoisted(() => ({
  redirectFrom: "",
  redirectTo: "",
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    dirname: (path: string): string => path === pathBoundary.redirectFrom
      ? pathBoundary.redirectTo
      : actual.dirname(path),
  };
});

import {
  clearGitProjectAnchorCache,
  resolveGitProjectAnchor,
} from "../src/git-project.js";

function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function makeRepository(root: string): string {
  makeDirectory(join(root, ".git"));
  makeDirectory(join(root, ".git", "objects"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
  return root;
}

function makeLinkedWorktree(primary: string, linked: string, name = "linked"): string {
  const gitDir = makeDirectory(join(primary, ".git", "worktrees", name));
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
  makeDirectory(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
  return linked;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

describe("Git project identity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-git-project-"));
    pathBoundary.redirectFrom = "";
    pathBoundary.redirectTo = "";
    clearGitProjectAnchorCache();
  });

  afterEach(() => {
    pathBoundary.redirectFrom = "";
    pathBoundary.redirectTo = "";
    clearGitProjectAnchorCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("maps a primary checkout, linked worktree, and nested directory to one anchor", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const nested = makeDirectory(join(linked, "src", "nested"));

    expect(resolveGitProjectAnchor(primary)).toEqual({
      canonical: primary,
      worktreeRoot: primary,
      commonDir: join(primary, ".git"),
    });
    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: primary,
      worktreeRoot: linked,
      commonDir: join(primary, ".git"),
    });
    expect(resolveGitProjectAnchor(nested)).toEqual({
      canonical: primary,
      worktreeRoot: linked,
      commonDir: join(primary, ".git"),
    });
    // Exercise the successful cache path.
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);
  });

  it("keeps separate clones distinct and returns null for non-Git directories", () => {
    const first = makeRepository(join(root, "first"));
    const second = makeRepository(join(root, "second"));
    const plain = makeDirectory(join(root, "plain"));

    expect(resolveGitProjectAnchor(first)?.canonical).toBe(first);
    expect(resolveGitProjectAnchor(second)?.canonical).toBe(second);
    expect(resolveGitProjectAnchor(plain)).toBeNull();
    expect(resolveGitProjectAnchor(plain)).toBeNull();
    makeRepository(plain);
    expect(resolveGitProjectAnchor(plain)?.canonical).toBe(plain);
    expect(resolveGitProjectAnchor(join(root, "missing"))).toBeNull();
  });

  it("anchors a real submodule at its checkout rather than superproject metadata", () => {
    const submoduleSource = join(root, "submodule-source");
    const superproject = join(root, "superproject");
    makeDirectory(submoduleSource);
    git(submoduleSource, "init", "-q");
    git(submoduleSource, "config", "user.email", "test@example.invalid");
    git(submoduleSource, "config", "user.name", "LCM Test");
    writeFileSync(join(submoduleSource, "README.md"), "submodule\n");
    git(submoduleSource, "add", "README.md");
    git(submoduleSource, "commit", "-qm", "initial");
    makeDirectory(superproject);
    git(superproject, "init", "-q");
    git(superproject, "config", "user.email", "test@example.invalid");
    git(superproject, "config", "user.name", "LCM Test");
    writeFileSync(join(superproject, "README.md"), "superproject\n");
    git(superproject, "add", "README.md");
    git(superproject, "commit", "-qm", "initial");
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "../submodule-source", "modules/sub");

    const submodule = join(superproject, "modules", "sub");
    makeDirectory(join(submodule, "nested"));
    const anchor = resolveGitProjectAnchor(join(submodule, "nested"));
    expect(anchor).toMatchObject({ canonical: submodule, worktreeRoot: submodule });
    expect(anchor?.commonDir).toContain(join(".git", "modules", "modules", "sub"));
    expect(resolveGitProjectAnchor(superproject)?.canonical).toBe(superproject);

    git(submodule, "config", "--unset", "core.worktree");
    git(submodule, "config", "extensions.worktreeConfig", "true");
    git(submodule, "config", "--worktree", "core.worktree", submodule);
    expect(git(submodule, "config", "--show-origin", "--get", "core.worktree"))
      .toContain("config.worktree");
    expect(git(submodule, "rev-parse", "--show-toplevel")).toBe(submodule);
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(join(submodule, "nested"))).toMatchObject({
      canonical: submodule,
      worktreeRoot: submodule,
    });
  });

  it("revalidates cached anchors when nearer or changed Git metadata appears", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const nested = makeDirectory(join(linked, "nested"));

    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    const nestedRepository = makeRepository(nested);
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(nestedRepository);

    rmSync(join(nested, ".git"), { recursive: true });
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    const replacement = makeRepository(join(root, "replacement"));
    const replacementWorktree = makeLinkedWorktree(
      replacement,
      join(root, "replacement-linked"),
      "replacement-linked",
    );
    writeFileSync(
      join(linked, ".git"),
      `gitdir: ${join(replacement, ".git", "worktrees", "replacement-linked")}\n`,
    );
    expect(resolveGitProjectAnchor(nested)).toEqual({
      canonical: replacement,
      worktreeRoot: linked,
      commonDir: join(replacement, ".git"),
    });

    rmSync(join(linked, ".git"));
    expect(resolveGitProjectAnchor(nested)).toBeNull();
    expect(resolveGitProjectAnchor(replacementWorktree)?.canonical).toBe(replacement);
  });

  it("terminates cached-anchor revalidation when the cached root is no longer an ancestor", () => {
    const primary = makeRepository(join(root, "primary"));
    const nested = makeDirectory(join(primary, "nested"));
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    rmSync(join(primary, ".git"), { recursive: true });
    pathBoundary.redirectFrom = nested;
    pathBoundary.redirectTo = makeDirectory(join(root, "unrelated"));

    expect(resolveGitProjectAnchor(nested)).toBeNull();
  });

  it("uses an unusual shared Git directory itself as the stable anchor", () => {
    const shared = makeDirectory(join(root, "shared.git"));
    makeDirectory(join(shared, "objects"));
    writeFileSync(join(shared, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(shared, "config"), "[core]\nrepositoryformatversion = 0\n");
    const gitDir = makeDirectory(join(shared, "worktrees", "one"));
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/one\n");
    const linked = makeDirectory(join(root, "linked"));
    writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);

    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: shared,
      worktreeRoot: linked,
      commonDir: shared,
    });
  });

  it("uses one external anchor for a separate-git-dir primary and its linked worktree", () => {
    const primary = makeDirectory(join(root, "separate-primary"));
    const shared = join(root, "separate-metadata");
    git(root, "init", "-q", "--separate-git-dir", shared, primary);
    git(primary, "config", "user.email", "test@example.invalid");
    git(primary, "config", "user.name", "LCM Test");
    writeFileSync(join(primary, "README.md"), "separate metadata\n");
    git(primary, "add", "README.md");
    git(primary, "commit", "-qm", "initial");
    const linked = join(root, "separate-linked");
    git(primary, "worktree", "add", "-q", "-b", "separate-linked", linked);

    expect(resolveGitProjectAnchor(primary)).toEqual({
      canonical: shared,
      worktreeRoot: primary,
      commonDir: shared,
    });
    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: shared,
      worktreeRoot: linked,
      commonDir: shared,
    });

    git(primary, "config", "extensions.worktreeConfig", "true");
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(primary)?.canonical).toBe(shared);
  });

  it("rejects malformed, oversized, symlinked, and invalid Git metadata", () => {
    const malformed = makeDirectory(join(root, "malformed"));
    writeFileSync(join(malformed, ".git"), "not-a-gitdir\n");
    expect(() => resolveGitProjectAnchor(malformed)).toThrow("expected one gitdir line");

    const oversized = makeDirectory(join(root, "oversized"));
    writeFileSync(join(oversized, ".git"), `gitdir: ${"x".repeat(70 * 1024)}`);
    expect(() => resolveGitProjectAnchor(oversized)).toThrow("size limit");

    const target = makeDirectory(join(root, "target"));
    const symlinked = makeDirectory(join(root, "symlinked"));
    symlinkSync(target, join(symlinked, ".git"));
    expect(() => resolveGitProjectAnchor(symlinked)).toThrow("refusing symlink");

    const fifoLike = makeDirectory(join(root, "invalid-type"));
    const fifoPath = join(fifoLike, ".git");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
    expect(() => resolveGitProjectAnchor(fifoLike)).toThrow("invalid Git metadata type");
  });

  it("rejects unsafe common-directory metadata and non-directory targets", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const commonPointer = join(primary, ".git", "worktrees", "linked", "commondir");
    writeFileSync(commonPointer, "\n");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    writeFileSync(commonPointer, "../..\nextra\n");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    writeFileSync(commonPointer, "../..\0suffix");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    rmSync(commonPointer);
    symlinkSync(primary, commonPointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("invalid Git common-directory");

    rmSync(commonPointer);
    makeDirectory(commonPointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("invalid Git common-directory");

    const missingGitDir = makeDirectory(join(root, "missing-gitdir"));
    writeFileSync(join(missingGitDir, ".git"), "gitdir: nowhere\n");
    expect(() => resolveGitProjectAnchor(missingGitDir)).toThrow();

    const fileTarget = join(root, "file-target");
    writeFileSync(fileTarget, "file");
    const filePointer = makeDirectory(join(root, "file-pointer"));
    writeFileSync(join(filePointer, ".git"), `gitdir: ${fileTarget}\n`);
    expect(() => resolveGitProjectAnchor(filePointer)).toThrow("not a directory");

    expect(() => resolveGitProjectAnchor(fileTarget)).toThrow("working directory is not a directory");
  });

  it("requires regular HEAD/config metadata and a real objects directory", () => {
    const missingHead = makeRepository(join(root, "missing-head"));
    rmSync(join(missingHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(missingHead)).toThrow("ENOENT");

    const directoryHead = makeRepository(join(root, "directory-head"));
    rmSync(join(directoryHead, ".git", "HEAD"));
    makeDirectory(join(directoryHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(directoryHead)).toThrow("invalid Git HEAD");

    const linkedHead = makeRepository(join(root, "linked-head"));
    rmSync(join(linkedHead, ".git", "HEAD"));
    symlinkSync(join(linkedHead, ".git", "config"), join(linkedHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(linkedHead)).toThrow("invalid Git HEAD");

    const linkedConfig = makeRepository(join(root, "linked-config"));
    rmSync(join(linkedConfig, ".git", "config"));
    symlinkSync(join(linkedConfig, ".git", "HEAD"), join(linkedConfig, ".git", "config"));
    expect(() => resolveGitProjectAnchor(linkedConfig)).toThrow("invalid Git config");

    const invalidObjects = makeRepository(join(root, "invalid-objects"));
    rmSync(join(invalidObjects, ".git", "objects"), { recursive: true });
    writeFileSync(join(invalidObjects, ".git", "objects"), "not a directory");
    expect(() => resolveGitProjectAnchor(invalidObjects)).toThrow("invalid Git objects");

    const symlinkObjects = makeRepository(join(root, "symlink-objects"));
    rmSync(join(symlinkObjects, ".git", "objects"), { recursive: true });
    symlinkSync(root, join(symlinkObjects, ".git", "objects"));
    expect(() => resolveGitProjectAnchor(symlinkObjects)).toThrow("invalid Git objects");
  });
});
