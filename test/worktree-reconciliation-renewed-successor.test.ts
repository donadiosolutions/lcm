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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedStorageConfig } from "../src/daemon/config.js";
import { linkProject, type IdentityServiceDependencies } from "../src/identity-service.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectIdentityPath,
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

/**
 * A renewed entry may also carry a distinct local alias. `renewRetiredProjectIdentity`
 * refuses aliases, but `linkProject` reaches `linkLocalAlias` for a non-UUID
 * target and adds one without PostgreSQL, so this is an ordinary SQLite-backend
 * shape rather than a hand-edited curiosity.
 *
 * Both reconciliation helpers used to derive the expected successor from the
 * ENTERED path. Through an alias that derives an unrelated id, so the fence was
 * never consulted: reconciliation accepted the binding, returned a third
 * unrelated path hash as its target, and CLI storage admitted writes under the
 * unauthenticated successor while hooks kept using the retired id. These tests
 * pin authentication against the MATCHED ENTRY's own canonical path, which is
 * the path renewal hashed to mint the successor id.
 */
describe("Renewed project successor authentication through a local alias", () => {
  const SQLITE_CONFIG: ResolvedStorageConfig = { backend: "sqlite" };
  const DIFFERENT_REPOSITORY_REFUSAL =
    "renewed project identity alias belongs to a different repository; refusing to reconcile";
  const AMBIGUOUS_ALIAS_REFUSAL =
    "project path is an alias of multiple renewed project identities; refusing to reconcile";
  const MISMATCHED_SUCCESSOR_REFUSAL =
    "renewed project identity target is bound to a different project; refusing to reconcile";

  let home: string;
  let canonical: string;
  let aliasPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-renewed-alias-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkPrivateDir(join(home, ".lcm"));
    canonical = join(home, "nongit-project");
    aliasPath = join(home, "nongit-alias");
    mkPrivateDir(canonical);
    mkPrivateDir(aliasPath);
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

  function identityDependencies(): Partial<IdentityServiceDependencies> {
    return {
      homeDir: home,
      openSession: () => Promise.reject(
        new Error("local alias linking must not open a remote identity session"),
      ),
      _assertBackendPublication: () => undefined,
    };
  }

  type PlantedAlias = {
    readonly retiredId: string;
    readonly successorId: string;
    readonly successorDb: string;
    readonly successorEvents: string;
  };

  /** Successor-keyed entry carrying a distinct alias, with live project data. */
  function plantAliasedSuccessor(entryCanonical: string, alias: string): PlantedAlias {
    const retiredId = hashProjectPath(entryCanonical);
    const successorId = retiredProjectIdentitySuccessor(retiredId, entryCanonical);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({ [successorId]: { canonical: entryCanonical, aliases: [alias] } }, null, 2)}\n`,
    );
    mkPrivateDir(join(home, ".lcm", "projects", successorId), { recursive: true });
    mkPrivateDir(join(home, ".lcm", "events"), { recursive: true });
    const successorDb = join(home, ".lcm", "projects", successorId, "db.sqlite");
    const successorEvents = join(home, ".lcm", "events", `${successorId}.db`);
    writePrivateFile(successorDb, "renewed-project-database");
    writePrivateFile(successorEvents, "renewed-project-sidecar");
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    return { retiredId, successorId, successorDb, successorEvents };
  }

  function writeFence(retiredId: string, recordedId: string): void {
    mkPrivateDir(join(home, ".lcm", "projects"), { recursive: true });
    writePrivateFile(
      join(home, ".lcm", "projects", retiredId),
      serializeWorktreeReconciliationFence(recordedId, "project"),
    );
    clearWorktreeReconciliationCache();
  }

  function successorBytes(planted: PlantedAlias): {
    readonly map: string;
    readonly db: Buffer;
    readonly events: Buffer;
    readonly fence: string | null;
  } {
    const fencePath = join(home, ".lcm", "projects", planted.retiredId);
    return {
      map: readFileSync(projectMapPath(), "utf8"),
      db: readFileSync(planted.successorDb),
      events: readFileSync(planted.successorEvents),
      fence: existsSync(fencePath) ? readFileSync(fencePath, "utf8") : null,
    };
  }

  function expectNothingFolded(
    planted: PlantedAlias,
    before: ReturnType<typeof successorBytes>,
  ): void {
    expect(readFileSync(projectMapPath(), "utf8")).toBe(before.map);
    expect(readFileSync(planted.successorDb)).toEqual(before.db);
    expect(readFileSync(planted.successorEvents)).toEqual(before.events);
    expect(readProjectMapSnapshot()).toEqual({
      [planted.successorId]: { canonical, aliases: [aliasPath] },
    });
    // The retired id never becomes a project directory again, and a retained
    // fence file is neither repaired nor removed by the refusal.
    const fencePath = join(home, ".lcm", "projects", planted.retiredId);
    if (before.fence === null) {
      expect(existsSync(fencePath)).toBe(false);
    } else {
      expect(statSync(fencePath).isFile()).toBe(true);
      expect(readFileSync(fencePath, "utf8")).toBe(before.fence);
    }
    expect(existsSync(join(home, ".lcm", "events", `${planted.retiredId}.db`))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
  }

  /** Renew for real, then add the alias through the real link command. */
  async function renewAndLinkAlias(alias: string): Promise<string> {
    const oldId = hashProjectPath(canonical);
    writeFence(oldId, oldId);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({ [oldId]: { canonical, aliases: [] } }, null, 2)}\n`,
    );
    clearProjectMapCache();
    const { newId } = renewRetiredProjectIdentity(canonical);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    await linkProject(SQLITE_CONFIG, newId, alias, {}, identityDependencies());
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    return newId;
  }

  it("refuses ensureWorktreeProjectReconciled through an alias when the predecessor fence is absent", () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    const before = successorBytes(planted);

    expect(() => ensureWorktreeProjectReconciled(aliasPath)).toThrow(MISSING_FENCE_REFUSAL);

    // The hook path already authenticated this binding through the matched
    // entry's own canonical path and fell back to the retired id. Reconciliation
    // silently disagreed with it, which is what split the identity.
    expect(localProjectIdentity(aliasPath)).toEqual({ id: planted.retiredId, canonical });
    expectNothingFolded(planted, before);
  });

  it("refuses ensureWorktreeProjectReconciled through an alias when the predecessor fence is tampered", () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    writeFence(planted.retiredId, "0".repeat(64));
    const before = successorBytes(planted);

    expect(() => ensureWorktreeProjectReconciled(aliasPath)).toThrow(MISSING_FENCE_REFUSAL);

    expectNothingFolded(planted, before);
  });

  // `lcm project reconcile-worktrees /alias` reaches this directly and supplies
  // no authenticated target identity, so the choke point has to refuse too.
  it("refuses a direct reconcileWorktrees through an alias when the predecessor fence is absent", () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    const before = successorBytes(planted);

    expect(() => reconcileWorktrees(aliasPath)).toThrow(MISSING_FENCE_REFUSAL);

    expectNothingFolded(planted, before);
  });

  it("refuses a direct reconcileWorktrees through an alias when the predecessor fence is tampered", () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    writeFence(planted.retiredId, "0".repeat(64));
    const before = successorBytes(planted);

    expect(() => reconcileWorktrees(aliasPath)).toThrow(MISSING_FENCE_REFUSAL);

    expectNothingFolded(planted, before);
  });

  it("refuses CLI storage admission through an alias when the predecessor fence is absent", async () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    const before = successorBytes(planted);

    await expect(withCliProjectStorage(aliasPath, { create: true }, async () => true))
      .rejects.toThrow(MISSING_FENCE_REFUSAL);

    expectNothingFolded(planted, before);
  });

  it("refuses CLI storage admission through an alias when the predecessor fence is tampered", async () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    writeFence(planted.retiredId, "0".repeat(64));
    const before = successorBytes(planted);

    await expect(withCliProjectStorage(aliasPath, { create: true }, async () => true))
      .rejects.toThrow(MISSING_FENCE_REFUSAL);

    expectNothingFolded(planted, before);
  });

  // An authenticated alias may adopt the successor only because a path with no
  // Git anchor returns before any discovery. `discoverSources` classifies
  // candidates by common directory, so adopting it for an alias that anchors
  // its own repository would fold that repository's worktree entries into this
  // renewed project.
  it("refuses an authenticated renewed alias that anchors a different repository", async () => {
    const aliasRepository = join(home, "alias-repository");
    mkPrivateDir(aliasRepository);
    git(aliasRepository, "init", "-q");
    git(aliasRepository, "config", "user.email", "test@example.invalid");
    git(aliasRepository, "config", "user.name", "LCM Test");
    writeFileSync(join(aliasRepository, "README.md"), "test\n", { mode: PRIVATE_FILE_MODE });
    git(aliasRepository, "add", "README.md");
    git(aliasRepository, "commit", "-qm", "initial");
    clearGitProjectAnchorCache();

    const newId = await renewAndLinkAlias(aliasRepository);
    const mapBefore = readFileSync(projectMapPath(), "utf8");

    expect(() => reconcileWorktrees(aliasRepository)).toThrow(DIFFERENT_REPOSITORY_REFUSAL);
    expect(() => ensureWorktreeProjectReconciled(aliasRepository))
      .toThrow(DIFFERENT_REPOSITORY_REFUSAL);

    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readProjectMapSnapshot()).toEqual({
      [newId]: { canonical, aliases: [aliasRepository] },
    });
    // The project's own canonical path keeps reconciling normally.
    expect(ensureWorktreeProjectReconciled(canonical).targetHash).toBe(newId);
  });

  // A hand-edited map can bind one path as an alias of two renewed entries.
  // Choosing either one would pick a project arbitrarily, so refuse.
  it("refuses a path bound as an alias by multiple renewed identities", () => {
    const second = join(home, "nongit-project-two");
    mkPrivateDir(second);
    const firstRetired = hashProjectPath(canonical);
    const secondRetired = hashProjectPath(second);
    const firstSuccessor = retiredProjectIdentitySuccessor(firstRetired, canonical);
    const secondSuccessor = retiredProjectIdentitySuccessor(secondRetired, second);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({
        [firstSuccessor]: { canonical, aliases: [aliasPath] },
        [secondSuccessor]: { canonical: second, aliases: [aliasPath] },
      }, null, 2)}\n`,
    );
    writeFence(firstRetired, firstRetired);
    writeFence(secondRetired, secondRetired);
    clearProjectMapCache();
    const mapBefore = readFileSync(projectMapPath(), "utf8");

    expect(() => reconcileWorktrees(aliasPath)).toThrow(AMBIGUOUS_ALIAS_REFUSAL);

    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readProjectMapSnapshot()).toEqual({
      [firstSuccessor]: { canonical, aliases: [aliasPath] },
      [secondSuccessor]: { canonical: second, aliases: [aliasPath] },
    });
  });

  it("refuses a path that is canonical for one renewed identity and an alias of another", () => {
    const second = join(home, "nongit-project-two");
    mkPrivateDir(second);
    const firstRetired = hashProjectPath(canonical);
    const secondRetired = hashProjectPath(second);
    const firstSuccessor = retiredProjectIdentitySuccessor(firstRetired, canonical);
    const secondSuccessor = retiredProjectIdentitySuccessor(secondRetired, second);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({
        [firstSuccessor]: { canonical, aliases: [] },
        [secondSuccessor]: { canonical: second, aliases: [canonical] },
      }, null, 2)}\n`,
    );
    writeFence(firstRetired, firstRetired);
    writeFence(secondRetired, secondRetired);
    clearProjectMapCache();
    const mapBefore = readFileSync(projectMapPath(), "utf8");

    expect(() => reconcileWorktrees(canonical)).toThrow(AMBIGUOUS_ALIAS_REFUSAL);

    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readProjectMapSnapshot()).toEqual({
      [firstSuccessor]: { canonical, aliases: [] },
      [secondSuccessor]: { canonical: second, aliases: [canonical] },
    });
  });

  it("refuses a path-derived successor key bound to a different project", () => {
    git(canonical, "init", "-q");
    git(canonical, "config", "user.email", "test@example.invalid");
    git(canonical, "config", "user.name", "LCM Test");
    writeFileSync(join(canonical, "README.md"), "test\n", { mode: PRIVATE_FILE_MODE });
    git(canonical, "add", "README.md");
    git(canonical, "commit", "-qm", "initial");
    clearGitProjectAnchorCache();

    const enteredCanonical = normalizeProjectIdentityPath(canonical);
    const foreign = join(home, "foreign-project");
    mkPrivateDir(foreign);
    const retiredId = hashProjectPath(enteredCanonical);
    const successorId = retiredProjectIdentitySuccessor(retiredId, enteredCanonical);
    writePrivateFile(
      projectMapPath(),
      `${JSON.stringify({
        [successorId]: { canonical: foreign, aliases: [] },
      }, null, 2)}\n`,
    );
    writeFence(retiredId, retiredId);
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    const mapBefore = readFileSync(projectMapPath(), "utf8");

    expect(() => reconcileWorktrees(canonical)).toThrow(MISMATCHED_SUCCESSOR_REFUSAL);

    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(readProjectMapSnapshot()).toEqual({
      [successorId]: { canonical: foreign, aliases: [] },
    });
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
  });

  it("keeps a genuinely renewed project usable through an alias added by lcm project link", async () => {
    const newId = await renewAndLinkAlias(aliasPath);

    expect(readProjectMapSnapshot()).toEqual({
      [newId]: { canonical, aliases: [aliasPath] },
    });

    // The alias authenticates and reconciles to the renewed project itself,
    // never to its own path hash.
    expect(ensureWorktreeProjectReconciled(aliasPath)).toEqual({
      status: "not-needed",
      targetHash: newId,
      canonical: aliasPath,
      sourceHashes: [],
      aliases: [aliasPath],
      backupPaths: [],
    });
    clearWorktreeReconciliationCache();
    expect(reconcileWorktrees(aliasPath)).toEqual({
      status: "not-needed",
      targetHash: newId,
      canonical: aliasPath,
      sourceHashes: [],
      aliases: [aliasPath],
      backupPaths: [],
    });

    // Entering by the project's own canonical path is unchanged.
    clearWorktreeReconciliationCache();
    expect(ensureWorktreeProjectReconciled(canonical)).toEqual({
      status: "not-needed",
      targetHash: newId,
      canonical,
      sourceHashes: [],
      aliases: [canonical],
      backupPaths: [],
    });

    expect(resolveProjectIdentity(aliasPath)).toEqual({ id: newId, canonical });
    expect(localProjectIdentity(aliasPath)).toEqual({ id: newId, canonical });

    const seenIds: string[] = [];
    await withCliProjectStorage(aliasPath, { create: true }, async (context) => {
      seenIds.push(context.project.id);
      return true;
    });
    expect(seenIds).toEqual([newId]);
  });

  it("leaves an ordinary never-renewed project reached through its alias unaffected", async () => {
    const ordinaryId = resolveProjectIdentity(canonical).id;
    expect(ordinaryId).toBe(hashProjectPath(canonical));
    await linkProject(SQLITE_CONFIG, ordinaryId, aliasPath, {}, identityDependencies());
    clearProjectMapCache();
    clearWorktreeReconciliationCache();

    expect(ensureWorktreeProjectReconciled(aliasPath)).toEqual({
      status: "not-needed",
      targetHash: hashProjectPath(aliasPath),
      canonical: aliasPath,
      sourceHashes: [],
      aliases: [aliasPath],
      backupPaths: [],
    });

    const seenIds: string[] = [];
    await withCliProjectStorage(aliasPath, { create: true }, async (context) => {
      seenIds.push(context.project.id);
      return true;
    });
    expect(seenIds).toEqual([ordinaryId]);
  });

  it("leaves an unmapped path unaffected while an unauthenticated successor is mapped elsewhere", () => {
    const planted = plantAliasedSuccessor(canonical, aliasPath);
    const before = successorBytes(planted);
    const unmapped = join(home, "unmapped-project");
    mkPrivateDir(unmapped);

    expect(ensureWorktreeProjectReconciled(unmapped)).toEqual({
      status: "not-needed",
      targetHash: hashProjectPath(unmapped),
      canonical: unmapped,
      sourceHashes: [],
      aliases: [unmapped],
      backupPaths: [],
    });

    expectNothingFolded(planted, before);
  });
});
