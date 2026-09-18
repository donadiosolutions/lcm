import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UnauthenticatedProjectIdentityError,
  addProjectAlias,
  isAuthenticatedProjectIdentity,
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  resolveExistingProjectIdentity,
  resolveProjectIdentity,
  retiredProjectIdentitySuccessor,
} from "../src/project-map.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import { serializeWorktreeReconciliationFence } from "../src/worktree-reconciliation-fence.js";
import { listCliProjects, withCliProjectStorage } from "../src/cli-storage.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MISSING_PREDECESSOR_FENCE_REFUSAL =
  "renewed project identity is missing its predecessor reconciliation fence; refusing to reconcile";

describe("project-map identity authentication", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-identity-auth-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(join(home, ".lcm"), PRIVATE_DIRECTORY_MODE);
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    rmSync(home, { recursive: true, force: true });
  });

  function makeProject(name: string): string {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    return normalizeProjectPath(path);
  }

  function writeMap(map: Record<string, { canonical: string; aliases: string[] }>): void {
    writeFileSync(projectMapPath(), `${JSON.stringify(map)}\n`, { mode: PRIVATE_FILE_MODE });
    clearProjectMapCache();
  }

  function writeProjectMetadata(id: string, cwd: string): void {
    const dir = join(home, ".lcm", "projects", id);
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(dir, PRIVATE_DIRECTORY_MODE);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd }), { mode: PRIVATE_FILE_MODE });
  }

  function plantPredecessorFence(retiredId: string): void {
    const projects = join(home, ".lcm", "projects");
    mkdirSync(projects, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(projects, PRIVATE_DIRECTORY_MODE);
    writeFileSync(
      join(projects, retiredId),
      serializeWorktreeReconciliationFence(retiredId, "project"),
      { mode: PRIVATE_FILE_MODE },
    );
    clearWorktreeReconciliationCache();
  }

  describe("#1356 unauthenticated map keys", () => {
    it("refuses to resolve a non-Git project under a map key that is not its canonical path hash", () => {
      const canonical = makeProject("arbitrary-key-project");
      const arbitrary = "b".repeat(64);
      expect(arbitrary).not.toBe(hashProjectPath(canonical));
      writeMap({ [arbitrary]: { canonical, aliases: [] } });

      expect(() => resolveExistingProjectIdentity(canonical))
        .toThrow(UnauthenticatedProjectIdentityError);
      expect(() => resolveProjectIdentity(canonical))
        .toThrow(UnauthenticatedProjectIdentityError);
    });

    it("refuses to admit CLI storage writes under an unauthenticated map key", async () => {
      const canonical = makeProject("arbitrary-key-storage");
      writeMap({ ["c".repeat(64)]: { canonical, aliases: [] } });

      await expect(withCliProjectStorage(canonical, { create: true }, async () => true))
        .rejects.toThrow(UnauthenticatedProjectIdentityError);
    });

    it("refuses an unauthenticated key that binds the path only as an alias", () => {
      const canonical = makeProject("alias-owner-canonical");
      const alias = makeProject("alias-owner-alias");
      writeMap({ ["d".repeat(64)]: { canonical, aliases: [alias] } });

      expect(() => resolveExistingProjectIdentity(alias))
        .toThrow(UnauthenticatedProjectIdentityError);
    });

    it("resolves a legacy key corroborated by its own project metadata", () => {
      const canonical = makeProject("legacy-metadata-project");
      const legacyId = "a".repeat(64);
      writeProjectMetadata(legacyId, canonical);
      writeMap({ [legacyId]: { canonical, aliases: [] } });

      expect(resolveExistingProjectIdentity(canonical)).toEqual({ id: legacyId, canonical });
    });

    it("still authenticates legacy metadata when process.getuid is unavailable", () => {
      const canonical = makeProject("legacy-metadata-no-getuid");
      const legacyId = "a".repeat(64);
      writeProjectMetadata(legacyId, canonical);
      writeMap({ [legacyId]: { canonical, aliases: [] } });
      const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
      try {
        Object.defineProperty(process, "getuid", { value: undefined, configurable: true });

        expect(resolveExistingProjectIdentity(canonical)).toEqual({ id: legacyId, canonical });
      } finally {
        if (getuid === undefined) delete (process as { getuid?: unknown }).getuid;
        else Object.defineProperty(process, "getuid", getuid);
      }
    });

    it("refuses a legacy key whose project metadata binds a different path", () => {
      const canonical = makeProject("legacy-metadata-mismatch");
      const other = makeProject("legacy-metadata-other");
      const legacyId = "a".repeat(64);
      writeProjectMetadata(legacyId, other);
      writeMap({ [legacyId]: { canonical, aliases: [] } });

      expect(() => resolveExistingProjectIdentity(canonical))
        .toThrow(UnauthenticatedProjectIdentityError);
    });

    it("refuses a legacy key whose project metadata is unreadable", () => {
      const canonical = makeProject("legacy-metadata-corrupt");
      const legacyId = "a".repeat(64);
      const dir = join(home, ".lcm", "projects", legacyId);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      chmodSync(dir, PRIVATE_DIRECTORY_MODE);
      writeFileSync(join(dir, "meta.json"), "{ not json", { mode: PRIVATE_FILE_MODE });
      writeMap({ [legacyId]: { canonical, aliases: [] } });

      expect(() => resolveExistingProjectIdentity(canonical))
        .toThrow(UnauthenticatedProjectIdentityError);
    });

    it("refuses a legacy key whose project metadata omits a usable cwd", () => {
      const canonical = makeProject("legacy-metadata-no-cwd");
      const legacyId = "a".repeat(64);
      const dir = join(home, ".lcm", "projects", legacyId);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      chmodSync(dir, PRIVATE_DIRECTORY_MODE);
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: "" }), { mode: PRIVATE_FILE_MODE });
      writeMap({ [legacyId]: { canonical, aliases: [] } });

      expect(() => resolveExistingProjectIdentity(canonical))
        .toThrow(UnauthenticatedProjectIdentityError);
    });

    it("resolves a project whose map key is its canonical path hash", () => {
      const canonical = makeProject("canonical-key-project");
      const id = hashProjectPath(canonical);
      writeMap({ [id]: { canonical, aliases: [] } });

      expect(resolveExistingProjectIdentity(canonical)).toEqual({ id, canonical });
    });

    it("resolves a renewed identity whose predecessor fence authenticates it", () => {
      const canonical = makeProject("renewed-authentic");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      writeMap({ [successorId]: { canonical, aliases: [] } });
      plantPredecessorFence(retiredId);

      expect(resolveExistingProjectIdentity(canonical)).toEqual({ id: successorId, canonical });
    });

    it("leaves an unauthenticated successor to the specific renewal refusal instead of a generic one", async () => {
      const canonical = makeProject("renewed-unauthenticated");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      writeMap({ [successorId]: { canonical, aliases: [] } });

      // Resolution stays permissive for a successor shape so admission and
      // reconciliation can refuse it with their own diagnostic. Pre-empting
      // them here would replace actionable renewal guidance with a generic
      // message; test/worktree-reconciliation-renewed-successor.ts locks that
      // refusal.
      expect(resolveExistingProjectIdentity(canonical)).toEqual({ id: successorId, canonical });
      await expect(withCliProjectStorage(canonical, { create: true }, async () => true))
        .rejects.toThrow(MISSING_PREDECESSOR_FENCE_REFUSAL);
    });
  });

    it("refuses to add an alias under an unauthenticated key without mutating the map", () => {
      // The gate must fire before publication. Refusing only when the alias is
      // read back would leave a failed link having already published one more
      // claimed path. Reported by exact-SHA review of the previous candidate.
      const canonical = makeProject("alias-unauthenticated");
      const aliasPath = makeProject("alias-unauthenticated-target");
      const arbitrary = "e".repeat(64);
      writeMap({ [arbitrary]: { canonical, aliases: [] } });
      const before = readFileSync(projectMapPath(), "utf8");

      expect(() => addProjectAlias(aliasPath, { hash: arbitrary }))
        .toThrow(UnauthenticatedProjectIdentityError);
      expect(readFileSync(projectMapPath(), "utf8")).toBe(before);
    });

    it("adds an alias under a key the canonical path hash authenticates", () => {
      const canonical = makeProject("alias-authenticated");
      const aliasPath = makeProject("alias-authenticated-target");
      const id = hashProjectPath(canonical);
      writeMap({ [id]: { canonical, aliases: [] } });

      expect(addProjectAlias(aliasPath, { hash: id }).entry.aliases).toEqual([aliasPath]);
    });

  describe("#1357 enumeration and preview", () => {
    it("omits a successor whose predecessor fence is missing from project enumeration", async () => {
      const canonical = makeProject("listed-unauthenticated");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      const otherCanonical = makeProject("listed-ordinary");
      const otherId = hashProjectPath(otherCanonical);
      writeMap({
        [successorId]: { canonical, aliases: [] },
        [otherId]: { canonical: otherCanonical, aliases: [] },
      });

      const listed = await listCliProjects();
      expect(listed).toEqual([{ id: otherId, canonical: otherCanonical, aliases: [otherCanonical] }]);
    });

    it("enumerates a successor whose predecessor fence authenticates it", async () => {
      const canonical = makeProject("listed-authentic");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      writeMap({ [successorId]: { canonical, aliases: [] } });
      plantPredecessorFence(retiredId);

      const listed = await listCliProjects();
      expect(listed).toEqual([{ id: successorId, canonical, aliases: [canonical] }]);
    });

    it("propagates an ambiguous project map instead of skipping the entry", async () => {
      // Only an unauthenticated key is skipped. Every other resolution failure
      // must still abort enumeration rather than quietly shrink the inventory.
      const canonical = makeProject("listed-ambiguous");
      const other = makeProject("listed-ambiguous-other");
      writeMap({
        [hashProjectPath(canonical)]: { canonical, aliases: [] },
        [hashProjectPath(other)]: { canonical: other, aliases: [canonical] },
      });

      await expect(listCliProjects()).rejects.toThrow("project path maps to multiple hashes");
    });

    it("omits a used successor whose predecessor fence is gone, even with its own metadata", async () => {
      // A renewed project writes projects/<successorId>/meta.json the first
      // time storage opens it. That metadata must not stand in for the lost
      // predecessor fence, or enumeration re-admits exactly the identity
      // admission refuses. Reported by exact-SHA review of the first
      // candidate, whose fixture never created the successor metadata.
      const canonical = makeProject("listed-used-successor");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      writeProjectMetadata(successorId, canonical);
      writeMap({ [successorId]: { canonical, aliases: [] } });

      expect(isAuthenticatedProjectIdentity(successorId, canonical)).toBe(false);
      await expect(listCliProjects()).resolves.toEqual([]);
    });

    it("enumerates a used successor while its predecessor fence authenticates it", async () => {
      const canonical = makeProject("listed-used-successor-authentic");
      const retiredId = hashProjectPath(canonical);
      const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
      writeProjectMetadata(successorId, canonical);
      writeMap({ [successorId]: { canonical, aliases: [] } });
      plantPredecessorFence(retiredId);

      expect(isAuthenticatedProjectIdentity(successorId, canonical)).toBe(true);
      const listed = await listCliProjects();
      expect(listed.map((entry) => entry.id)).toEqual([successorId]);
    });

    it("omits an arbitrary unauthenticated map key from project enumeration", async () => {
      const canonical = makeProject("listed-arbitrary");
      writeMap({ ["e".repeat(64)]: { canonical, aliases: [] } });

      await expect(listCliProjects()).resolves.toEqual([]);
    });
  });
});

