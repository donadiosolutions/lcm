// Renewed-successor authentication must not depend on Git.
//
// `renewRetiredProjectIdentity` derives its canonical path through
// `normalizeProjectIdentityPath`, which falls back to a plain realpath when
// there is no Git anchor, so an ordinary directory can be renewed and carry a
// successor-keyed map entry exactly as a repository can. These tests pin the
// fail-closed rule for that case: an unauthenticated successor-shaped binding
// is refused before reconciliation or storage admission, a genuinely renewed
// one is recognized, and an ordinary never-renewed project is untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProjectMapCache,
  hashProjectPath,
  projectMapPath,
  readProjectMapSnapshot,
  renewRetiredProjectIdentity,
  resolveProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../src/project-map.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import {
  clearWorktreeReconciliationCache,
  ensureWorktreeProjectReconciled,
  reconcileWorktrees,
} from "../src/worktree-reconciliation.js";
import { serializeWorktreeReconciliationFence } from "../src/worktree-reconciliation-fence.js";
import { localProjectIdentity } from "../src/daemon/project.js";
import { withCliProjectStorage } from "../src/cli-storage.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MISSING_FENCE_REFUSAL =
  "renewed project identity is missing its predecessor reconciliation fence; refusing to reconcile";

function mkPrivateDir(path: string, options: { readonly recursive?: boolean } = {}): void {
  mkdirSync(path, { ...options, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("Git-independent renewed project successor authentication", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-renewed-successor-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkPrivateDir(join(home, ".lcm"));
    cwd = join(home, "nongit-project");
    mkPrivateDir(cwd);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    clearGitProjectAnchorCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    clearGitProjectAnchorCache();
    rmSync(home, { recursive: true, force: true });
  });

  function plantSuccessorMapEntry(canonical: string): { retiredId: string; successorId: string } {
    const retiredId = hashProjectPath(canonical);
    const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({ [successorId]: { canonical, aliases: [] } }, null, 2)}\n`,
    );
    clearProjectMapCache();
    return { retiredId, successorId };
  }

  it("refuses a non-Git successor binding whose predecessor fence is absent", () => {
    const { retiredId, successorId } = plantSuccessorMapEntry(cwd);

    expect(() => ensureWorktreeProjectReconciled(cwd)).toThrow(MISSING_FENCE_REFUSAL);

    // The hook path already refuses this binding Git-independently. The
    // refusal above is what makes reconciliation agree with it.
    expect(localProjectIdentity(cwd)).toEqual({ id: retiredId, canonical: cwd });
    // Nothing folded the live successor backwards onto the retired id.
    expect(readProjectMapSnapshot()).toEqual({
      [successorId]: { canonical: cwd, aliases: [] },
    });
  });

  it("refuses a non-Git successor binding whose predecessor fence is tampered", () => {
    const { retiredId } = plantSuccessorMapEntry(cwd);
    mkPrivateDir(join(home, ".lcm", "projects"), { recursive: true });
    writePrivateFile(
      join(home, ".lcm", "projects", retiredId),
      serializeWorktreeReconciliationFence("0".repeat(64), "project"),
    );
    clearWorktreeReconciliationCache();

    expect(() => ensureWorktreeProjectReconciled(cwd)).toThrow(MISSING_FENCE_REFUSAL);
  });

  // `ensureWorktreeProjectReconciled` is not the only non-Git face of
  // reconciliation: `lcm project reconcile-worktrees` on an ordinary
  // directory reaches `reconcileWorktrees` directly and supplies no
  // authenticated target identity. Without the fence check inside
  // `reconcileWorktrees` itself, that call returns the retired hash as a
  // perfectly ordinary `not-needed` target and hands every later caller the
  // pre-renewal identity of an already-renewed project.
  it("refuses a direct non-Git reconciliation of an unauthenticated successor", () => {
    const { retiredId, successorId } = plantSuccessorMapEntry(cwd);
    const mapBefore = readFileSync(projectMapPath(), "utf8");

    expect(() => reconcileWorktrees(cwd)).toThrow(MISSING_FENCE_REFUSAL);

    // Nothing was mutated and nothing was archived.
    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readProjectMapSnapshot()).toEqual({
      [successorId]: { canonical: cwd, aliases: [] },
    });
    expect(existsSync(join(home, ".lcm", "projects", retiredId))).toBe(false);
    expect(existsSync(join(home, ".lcm", "events", `${retiredId}.db`))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
  });

  it("refuses CLI storage admission under an unauthenticated non-Git successor", async () => {
    plantSuccessorMapEntry(cwd);

    await expect(withCliProjectStorage(cwd, { create: true }, async () => true))
      .rejects.toThrow(MISSING_FENCE_REFUSAL);
  });

  it("still refuses a Git-anchored successor binding whose predecessor fence is absent", () => {
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "user.name", "LCM Test");
    writeFileSync(join(cwd, "README.md"), "test\n", { mode: PRIVATE_FILE_MODE });
    git(cwd, "add", "README.md");
    git(cwd, "commit", "-qm", "initial");

    plantSuccessorMapEntry(cwd);
    clearGitProjectAnchorCache();

    expect(() => ensureWorktreeProjectReconciled(cwd)).toThrow(MISSING_FENCE_REFUSAL);
  });

  it("recognizes a genuinely renewed non-Git successor across every identity path", async () => {
    const oldId = hashProjectPath(cwd);
    mkPrivateDir(join(home, ".lcm", "projects"), { recursive: true });
    writePrivateFile(
      join(home, ".lcm", "projects", oldId),
      serializeWorktreeReconciliationFence(oldId, "project"),
    );
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({ [oldId]: { canonical: cwd, aliases: [] } }, null, 2)}\n`,
    );
    clearProjectMapCache();

    const renewal = renewRetiredProjectIdentity(cwd);
    expect(renewal.changed).toBe(true);
    const { newId } = renewal;
    clearProjectMapCache();
    clearWorktreeReconciliationCache();

    expect(ensureWorktreeProjectReconciled(cwd).targetHash).toBe(newId);
    expect(resolveProjectIdentity(cwd).id).toBe(newId);
    expect(localProjectIdentity(cwd)).toEqual({ id: newId, canonical: cwd });

    const seenIds: string[] = [];
    await withCliProjectStorage(cwd, { create: true }, async (context) => {
      seenIds.push(context.project.id);
      return true;
    });
    expect(seenIds).toEqual([newId]);
  });

  it("reconciles a genuinely renewed non-Git project reached through a symlinked path", async () => {
    const oldId = hashProjectPath(cwd);
    mkPrivateDir(join(home, ".lcm", "projects"), { recursive: true });
    writePrivateFile(
      join(home, ".lcm", "projects", oldId),
      serializeWorktreeReconciliationFence(oldId, "project"),
    );
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({ [oldId]: { canonical: cwd, aliases: [] } }, null, 2)}\n`,
    );
    clearProjectMapCache();
    const { newId } = renewRetiredProjectIdentity(cwd);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();

    const symlinked = join(home, "symlinked-project");
    symlinkSync(cwd, symlinked, "dir");

    // The authenticated successor identity carries the realpath that renewal
    // derived, so reconciliation has to normalize the entered path the same
    // way. Comparing a lexically resolved path against it rejected this
    // already-working flow outright.
    const result = ensureWorktreeProjectReconciled(symlinked);
    expect(result.status).toBe("not-needed");
    expect(result.targetHash).toBe(newId);
    expect(result.canonical).toBe(cwd);

    const seenIds: string[] = [];
    await withCliProjectStorage(symlinked, { create: true }, async (context) => {
      seenIds.push(context.project.id);
      return true;
    });
    expect(seenIds).toEqual([newId]);
  });

  it("leaves an ordinary non-Git project with no renewal history unaffected", async () => {
    const result = ensureWorktreeProjectReconciled(cwd);
    expect(result.status).toBe("not-needed");
    expect(result.targetHash).toBe(hashProjectPath(cwd));

    const seenIds: string[] = [];
    await withCliProjectStorage(cwd, { create: true }, async (context) => {
      seenIds.push(context.project.id);
      return true;
    });
    expect(seenIds).toEqual([hashProjectPath(cwd)]);
  });
});
