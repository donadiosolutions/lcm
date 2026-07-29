import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => ({
  from: "",
  to: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (path: Parameters<typeof actual.realpathSync>[0]) => {
      const real = actual.realpathSync(path);
      return String(path) === redirect.from ? redirect.to : real;
    },
  };
});

import {
  clearGitProjectAnchorCache,
  resolveGitProjectAnchor,
} from "../src/git-project.js";

describe("Git worktrees-directory realpath race", () => {
  const roots: string[] = [];

  afterEach(() => {
    redirect.from = "";
    redirect.to = "";
    clearGitProjectAnchorCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory retargeted after its non-symlink lstat", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-worktrees-race-"));
    roots.push(root);
    const primary = join(root, "primary");
    const commonDir = join(primary, ".git");
    const worktreesDir = join(commonDir, "worktrees");
    const gitDir = join(worktreesDir, "linked");
    const linked = join(root, "linked");
    const marker = join(linked, ".git");
    mkdirSync(join(commonDir, "objects"), { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(commonDir, "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(gitDir, "gitdir"), `${marker}\n`);
    writeFileSync(marker, `gitdir: ${gitDir}\n`);

    redirect.from = worktreesDir;
    redirect.to = join(root, "retargeted-worktrees");
    mkdirSync(redirect.to, { recursive: true });

    expect(() => resolveGitProjectAnchor(linked))
      .toThrow("invalid Git worktrees directory");
  });
});
