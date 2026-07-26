import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ failingPath: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      if (String(path) === boundary.failingPath) {
        throw Object.assign(new Error("simulated ownership directory race"), { code: "EIO" });
      }
      return actual.readdirSync(path, options as never);
    }) as typeof actual.readdirSync,
  };
});

import { resolveCodexSessions } from "../src/codex-project-resolution.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import {
  clearProjectMapCache,
  resolveProjectIdentity,
} from "../src/project-map.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("Codex ownership-directory races", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home = "";

  afterEach(() => {
    boundary.failingPath = "";
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("skips a raced optional ownership directory while resolving an unrelated live session", () => {
    home = mkdtempSync(join(tmpdir(), "lcm-codex-owner-race-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const project = join(home, "project");
    mkdirSync(project);
    git(project, "init", "-q");
    git(project, "config", "user.email", "test@example.invalid");
    git(project, "config", "user.name", "LCM Test");
    writeFileSync(join(project, "README.md"), "test\n");
    git(project, "add", "README.md");
    git(project, "commit", "-qm", "initial");
    resolveProjectIdentity(project);
    const codexDir = join(home, ".codex");
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "valid.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: { id: "valid", cwd: project },
    })}\n`);
    boundary.failingPath = join(project, ".git", "worktrees");

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: project,
      evidence: "live-git",
    });
  });
});
