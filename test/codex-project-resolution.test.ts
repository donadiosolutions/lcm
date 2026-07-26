import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../src/git-project.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  projectMapPath,
  resolveProjectIdentity,
} from "../src/project-map.js";
import {
  historicalWorktreeEntriesForProject,
  resolveCodexSessions,
} from "../src/codex-project-resolution.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(
  root: string,
  name: string,
  remote?: string,
  mapProject = true,
): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "-q");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "LCM Test");
  if (remote) git(path, "remote", "add", "origin", remote);
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git(path, "add", "README.md");
  git(path, "commit", "-qm", "initial");
  if (mapProject) resolveProjectIdentity(path);
  return path;
}

function transcript(
  codexDir: string,
  id: string,
  cwd: string | undefined,
  repositoryUrl?: string,
): void {
  const root = join(codexDir, "archived_sessions");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${id}.jsonl`), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      ...(cwd ? { cwd } : {}),
      ...(repositoryUrl ? {
        git: {
          repository_url: repositoryUrl,
          commit_hash: "abc123",
          branch: "feature",
        },
      } : {}),
    },
  })}\n`);
}

describe("Codex project resolution", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;
  let codexDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-codex-resolution-"));
    codexDir = join(home, ".codex");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".lcm"), { recursive: true });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
  });

  afterEach(() => {
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("prefers live Git common-directory evidence", () => {
    const main = repository(home, "live-main", "https://example.invalid/live.git");
    const linked = join(home, "live-linked");
    git(main, "worktree", "add", "-qb", "linked", linked);
    transcript(codexDir, "live", linked, "https://wrong.invalid/repository.git");

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "live-git",
    });
  });

  it("skips malformed mapped Git paths while resolving a valid session", () => {
    const main = repository(home, "valid-with-bad-map", "https://example.invalid/valid.git");
    const validHash = resolveProjectIdentity(main).id;
    const malformed = join(home, "malformed-mapped-git");
    const outside = join(home, "outside-git-marker");
    mkdirSync(malformed);
    mkdirSync(outside);
    symlinkSync(outside, join(malformed, ".git"));
    const malformedHash = hashProjectPath(malformed);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [validHash]: { canonical: main, aliases: [] },
      [malformedHash]: { canonical: malformed, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    transcript(codexDir, "valid-session", main, "https://example.invalid/valid.git");

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "live-git",
    });
  });

  it("skips malformed live cwd Git metadata without aborting other Codex sessions", () => {
    const main = repository(home, "valid-live-cwd", "https://example.invalid/live-cwd.git");
    const malformed = join(home, "malformed-live-cwd");
    const outside = join(home, "malformed-live-cwd-target");
    mkdirSync(malformed);
    mkdirSync(outside);
    symlinkSync(outside, join(malformed, ".git"));
    transcript(codexDir, "bad-live-cwd", malformed);
    transcript(codexDir, "valid-live-cwd", main, "https://example.invalid/live-cwd.git");

    const resolutions = new Map(resolveCodexSessions(codexDir)
      .map((session) => [session.sessionId, session.resolution]));
    expect(resolutions.get("bad-live-cwd")).toEqual({
      status: "unresolved",
      reason: "session cwd has no live Git, thread-owner, or verified tombstone repository evidence",
    });
    expect(resolutions.get("valid-live-cwd")).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "live-git",
    });
  });

  it("indexes every mapped Git alias even when it is a separate clone", () => {
    const remote = "https://example.invalid/mapped-alias.git";
    const main = repository(home, "mapped-main", remote);
    const aliasClone = repository(home, "mapped-alias", remote, false);
    const projectHash = resolveProjectIdentity(main).id;
    addProjectAlias(aliasClone, { canonical: main });
    transcript(codexDir, "mapped-alias", aliasClone, remote);

    expect(resolveCodexSessions(codexDir)[0].resolution).toEqual({
      status: "resolved",
      canonical: aliasClone,
      projectHash,
      evidence: "live-git",
    });
  });

  it("uses exact codex-thread ownership before repository metadata", () => {
    const main = repository(home, "owned-main", "https://example.invalid/owned.git");
    const linked = join(home, "owned-linked");
    git(main, "worktree", "add", "-qb", "owned", linked);
    const commonDir = resolveGitProjectAnchor(main)!.commonDir;
    writeFileSync(
      join(commonDir, "worktrees", "owned-linked", "codex-thread.json"),
      '{"version":1,"ownerThreadId":"owned-thread"}\n',
    );
    transcript(
      codexDir,
      "owned-thread",
      join(codexDir, "worktrees", "missing", "owned-main"),
      "https://wrong.invalid/repository.git",
    );

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "thread-owner",
    });
  });

  it("uses a unique exact repository URL only for a Codex worktree tombstone", () => {
    const remote = "https://example.invalid/tombstone.git";
    const main = repository(home, "tombstone-main", remote);
    const tombstone = join(codexDir, "worktrees", "token");
    mkdirSync(tombstone, { recursive: true });
    transcript(codexDir, "tombstone", join(tombstone, "tombstone-main"), remote);

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "repository-tombstone",
    });
  });

  it("treats explicit alias clones of one mapped project as one tombstone candidate", () => {
    const remote = "https://example.invalid/alias-tombstone.git";
    const main = repository(home, "alias-tombstone-main", remote);
    const aliasClone = repository(home, "alias-tombstone-clone", remote, false);
    const projectHash = resolveProjectIdentity(main).id;
    addProjectAlias(aliasClone, { canonical: main });
    const tombstone = join(codexDir, "worktrees", "token");
    mkdirSync(tombstone, { recursive: true });
    transcript(codexDir, "alias-tombstone", join(tombstone, "deleted"), remote);

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      projectHash,
      evidence: "repository-tombstone",
    });
  });

  it("reports ambiguous same-remote clones and skips unverifiable paths", () => {
    const remote = "https://example.invalid/ambiguous.git";
    const cloneA = repository(home, "clone-a", remote);
    repository(home, "clone-b", remote);
    const tombstone = join(codexDir, "worktrees", "token");
    mkdirSync(tombstone, { recursive: true });
    transcript(codexDir, "ambiguous", join(tombstone, "clone"), remote);
    transcript(codexDir, "unresolved", join(home, "deleted", "clone"), remote);

    const resolutions = resolveCodexSessions(codexDir)
      .map((session) => session.resolution.status)
      .sort();
    expect(resolutions).toEqual(["ambiguous", "unresolved"]);
    const anchor = resolveGitProjectAnchor(cloneA)!;
    expect(historicalWorktreeEntriesForProject(
      anchor.canonical,
      anchor.commonDir,
      codexDir,
    )).toEqual({ hashes: [], aliases: [] });
  });

  it("fails closed when live Git is not mapped and handles tombstone-root cwd", () => {
    const untracked = repository(
      home,
      "untracked",
      "https://example.invalid/untracked.git",
      false,
    );
    mkdirSync(join(codexDir, "worktrees"), { recursive: true });
    transcript(codexDir, "live-untracked", untracked);
    transcript(
      codexDir,
      "tombstone-root",
      join(codexDir, "worktrees"),
      "https://example.invalid/untracked.git",
    );

    expect(resolveCodexSessions(codexDir).map((session) => session.resolution))
      .toEqual([
        {
          status: "unresolved",
          reason: "live-git did not match a verified local project",
        },
        {
          status: "unresolved",
          reason: "session cwd has no live Git, thread-owner, or verified tombstone repository evidence",
        },
      ]);
  });

  it("rejects missing and symlinked Codex worktree tombstones", () => {
    const remote = "https://example.invalid/unsafe-tombstones.git";
    repository(home, "unsafe-tombstones", remote);
    const worktrees = join(codexDir, "worktrees");
    const outside = join(home, "outside-tombstone");
    mkdirSync(outside, { recursive: true });
    mkdirSync(worktrees, { recursive: true });
    symlinkSync(outside, join(worktrees, "linked-token"));
    transcript(codexDir, "linked-token", join(worktrees, "linked-token", "project"), remote);
    transcript(codexDir, "missing-token", join(worktrees, "missing-token", "project"), remote);

    expect(resolveCodexSessions(codexDir).map((session) => session.resolution.status))
      .toEqual(["unresolved", "unresolved"]);
  });

  it("deduplicates exact owners and ignores unsafe or malformed ownership metadata", () => {
    const main = repository(home, "owner-boundaries", "https://example.invalid/owners.git");
    const first = join(home, "owner-first");
    const second = join(home, "owner-second");
    git(main, "worktree", "add", "-qb", "owner-first", first);
    git(main, "worktree", "add", "-qb", "owner-second", second);
    const root = join(resolveGitProjectAnchor(main)!.commonDir, "worktrees");
    for (const name of ["owner-first", "owner-second"]) {
      writeFileSync(
        join(root, name, "codex-thread.json"),
        '{"version":1,"ownerThreadId":"same-owner"}\n',
      );
    }
    writeFileSync(join(root, "plain-file"), "not a directory");
    mkdirSync(join(root, "without-metadata"));
    mkdirSync(join(root, "malformed"));
    writeFileSync(join(root, "malformed", "codex-thread.json"), "{");
    mkdirSync(join(root, "invalid-owner"));
    writeFileSync(
      join(root, "invalid-owner", "codex-thread.json"),
      '{"version":2,"ownerThreadId":""}',
    );
    symlinkSync(join(root, "without-metadata"), join(root, "linked-entry"));
    transcript(codexDir, "same-owner", undefined);

    expect(resolveCodexSessions(codexDir)[0].resolution).toMatchObject({
      status: "resolved",
      canonical: main,
      evidence: "thread-owner",
    });
  });

  it("reports an exact thread owner shared by separate projects as ambiguous", () => {
    for (const name of ["owner-a", "owner-b"]) {
      const main = repository(
        home,
        name,
        `https://example.invalid/${name}.git`,
      );
      const linked = join(home, `${name}-linked`);
      git(main, "worktree", "add", "-qb", `${name}-branch`, linked);
      writeFileSync(
        join(
          resolveGitProjectAnchor(main)!.commonDir,
          "worktrees",
          `${name}-linked`,
          "codex-thread.json",
        ),
        '{"version":1,"ownerThreadId":"shared-owner"}\n',
      );
    }
    transcript(codexDir, "shared-owner", undefined);
    expect(resolveCodexSessions(codexDir)[0].resolution).toEqual({
      status: "ambiguous",
      reason: "thread-owner matches multiple local projects",
    });
  });

  it("returns no historical sources when the verified project has no remote", () => {
    const main = repository(home, "no-remote");
    const anchor = resolveGitProjectAnchor(main)!;
    expect(historicalWorktreeEntriesForProject(
      anchor.canonical,
      anchor.commonDir,
      codexDir,
    )).toEqual({ hashes: [], aliases: [] });
  });

  it("reconciles a deleted worktree map entry through exact thread ownership without a remote", () => {
    const main = repository(home, "thread-history-main");
    const anchor = resolveGitProjectAnchor(main)!;
    const targetHash = resolveProjectIdentity(main).id;
    const deleted = join(codexDir, "worktrees", "deleted-token", "lcm");
    const legacyHash = hashProjectPath(deleted);
    const metadataDir = join(anchor.commonDir, "worktrees", "deleted-thread-worktree");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, "codex-thread.json"),
      '{"version":1,"ownerThreadId":"deleted-thread"}\n',
    );
    writeFileSync(join(metadataDir, "gitdir"), `${join(deleted, ".git")}\n`);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical: main, aliases: [] },
      [legacyHash]: { canonical: deleted, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    transcript(codexDir, "deleted-thread", join(codexDir, "worktrees", "other", "lcm"));

    expect(historicalWorktreeEntriesForProject(
      anchor.canonical,
      anchor.commonDir,
      codexDir,
    )).toEqual({ hashes: [legacyHash], aliases: [deleted] });
  });

  it("does not fold a deleted path when exact thread ownership is ambiguous", () => {
    const first = repository(home, "ambiguous-history-first");
    const second = repository(home, "ambiguous-history-second");
    const firstAnchor = resolveGitProjectAnchor(first)!;
    const secondAnchor = resolveGitProjectAnchor(second)!;
    const targetHash = resolveProjectIdentity(first).id;
    const deleted = join(codexDir, "worktrees", "ambiguous-token", "lcm");
    const legacyHash = hashProjectPath(deleted);
    for (const [anchor, name] of [[firstAnchor, "first"], [secondAnchor, "second"]] as const) {
      const metadataDir = join(anchor.commonDir, "worktrees", `ambiguous-${name}`);
      mkdirSync(metadataDir, { recursive: true });
      writeFileSync(
        join(metadataDir, "codex-thread.json"),
        '{"version":1,"ownerThreadId":"ambiguous-history-thread"}\n',
      );
      writeFileSync(join(metadataDir, "gitdir"), `${join(deleted, ".git")}\n`);
    }
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical: first, aliases: [] },
      [resolveProjectIdentity(second).id]: { canonical: second, aliases: [] },
      [legacyHash]: { canonical: deleted, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    transcript(codexDir, "ambiguous-history-thread", undefined);

    expect(historicalWorktreeEntriesForProject(
      firstAnchor.canonical,
      firstAnchor.commonDir,
      codexDir,
    )).toEqual({ hashes: [], aliases: [] });
  });

  it("fails closed for invalid thread gitdir metadata and uses the transcript filename owner", () => {
    const main = repository(home, "thread-owner-boundaries");
    const anchor = resolveGitProjectAnchor(main)!;
    const root = join(anchor.commonDir, "worktrees");
    const deleted = join(codexDir, "worktrees", "relative-token", "lcm");
    const entries: Array<[string, string, string]> = [
      ["empty", "empty-owner", ""],
      ["multiline", "multiline-owner", "/tmp/one\n/tmp/two"],
      ["non-git", "non-git-owner", join(home, "not-a-gitdir")],
      ["relative", "relative-owner", relative(join(root, "relative"), join(deleted, ".git"))],
      ["missing", "filename-owner", ""],
    ];
    for (const [name, ownerThreadId, gitdir] of entries) {
      const metadataDir = join(root, name);
      mkdirSync(metadataDir, { recursive: true });
      writeFileSync(
        join(metadataDir, "codex-thread.json"),
        `${JSON.stringify({ version: 1, ownerThreadId })}\n`,
      );
      if (name !== "missing") writeFileSync(join(metadataDir, "gitdir"), `${gitdir}\n`);
    }
    for (const [, ownerThreadId] of entries.slice(0, -1)) {
      transcript(codexDir, ownerThreadId, undefined);
    }
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "filename-owner.jsonl"), "");

    expect(historicalWorktreeEntriesForProject(
      anchor.canonical,
      anchor.commonDir,
      codexDir,
    ).aliases).toEqual([deleted]);
  });
});
