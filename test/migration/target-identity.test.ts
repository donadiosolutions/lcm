import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { lookupMigrationTargetProjectId, resolveMigrationTargetProjectId } from "../../src/migration/target-identity.js";
import {
  PostgreSqlIdentityAliasNormalizedPathConflictError,
  PostgreSqlIdentityAliasPathConflictError,
  PostgreSqlIdentityConflictError,
} from "../../src/storage/postgresql/identity-repository.js";
import { normalizeProjectPath, normalizeProjectIdentityPath } from "../../src/project-map.js";
import { localProjectIdentity } from "../../src/daemon/project.js";

const MACHINE_ID = "018f0b5d-1234-7abc-8def-1234567890ab";

function repositoryStub(overrides: { resolveProject?: unknown; createProject?: unknown; ensureProjectAliases?: unknown } = {}) {
  return {
    resolveProject: overrides.resolveProject ?? vi.fn(),
    createProject: overrides.createProject ?? vi.fn(),
    ensureProjectAliases: overrides.ensureProjectAliases ?? vi.fn(async () => ({ inserted: 0 })),
  } as never;
}

describe("lookupMigrationTargetProjectId: SELECT only, never creates", () => {
  it("returns the bound project id at the normalized alias key and never calls createProject", async () => {
    const createProject = vi.fn();
    const resolveProject = vi.fn(async () => ({ projectId: "project-1", alias: {} as never }));
    const result = await lookupMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toBe("project-1");
    expect(resolveProject).toHaveBeenCalledWith(MACHINE_ID, normalizeProjectPath("/tmp/project"));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns null for an absent key without minting one", async () => {
    const createProject = vi.fn();
    const result = await lookupMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject: vi.fn(async () => null), createProject }),
      machineId: MACHINE_ID, authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe("resolveMigrationTargetProjectId", () => {
  it("resolves via the fast path when the (machineId, normalizedPath) key already has a bound project -- never calling createProject", async () => {
    const createProject = vi.fn();
    const resolveProject = vi.fn(async () => ({ projectId: "project-1", alias: {} as never }));
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "project-1", effect: "reused" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("mints a project when the key is genuinely absent", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => ({ projectId: "project-2", displayName: "d", createdAt: "x", updatedAt: "x", aliases: [] }));
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "project-2", effect: "created" });
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      machineId: MACHINE_ID, path: "/tmp/project",
    }));
  });

  it("mints the canonical alias plus every authorized map alias in the one createProject call (#1678: the source stream carries them all)", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => ({ projectId: "project-2", displayName: "d", createdAt: "x", updatedAt: "x", aliases: [] }));
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
      aliases: ["/tmp/moved-project"],
    });
    expect(result).toEqual({ status: "resolved", projectId: "project-2", effect: "created" });
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      machineId: MACHINE_ID,
      aliases: [
        { path: "/tmp/project", normalizedPath: normalizeProjectPath("/tmp/project") },
        { path: "/tmp/moved-project", normalizedPath: normalizeProjectPath("/tmp/moved-project") },
      ],
    }));
  });

  describe("alias set (#1678)", () => {
    const created = { projectId: "project-2", displayName: "d", createdAt: "x", updatedAt: "x", aliases: [] };
    const conflict = { status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "alias-conflict" };
    const base = { machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project" };
    const rows = [
      { path: "/tmp/project", normalizedPath: normalizeProjectPath("/tmp/project") },
      { path: "/tmp/moved-project", normalizedPath: normalizeProjectPath("/tmp/moved-project") },
    ];

    it("refuses before any read or write when an alias normalizes to the canonical path (symlink collision)", async () => {
      const root = mkdtempSync(join(tmpdir(), "lcm-target-identity-collision-"));
      try {
        const real = join(root, "real");
        const link = join(root, "link");
        mkdirSync(real, { mode: 0o700 });
        symlinkSync(real, link);
        const resolveProject = vi.fn();
        const createProject = vi.fn();
        const ensureProjectAliases = vi.fn();
        const result = await resolveMigrationTargetProjectId({
          repository: repositoryStub({ resolveProject, createProject, ensureProjectAliases }),
          machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: real, aliases: [link],
        });
        expect(result).toEqual(conflict);
        expect(resolveProject).not.toHaveBeenCalled();
        expect(createProject).not.toHaveBeenCalled();
        expect(ensureProjectAliases).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses a repeated lexical path before any read or write", async () => {
      const resolveProject = vi.fn();
      const result = await resolveMigrationTargetProjectId({
        repository: repositoryStub({ resolveProject }), ...base, aliases: ["/tmp/project"],
      });
      expect(result).toEqual(conflict);
      expect(resolveProject).not.toHaveBeenCalled();
    });

    it("keeps the lexical path and the differing real path of an alias under a symlinked parent", async () => {
      const root = mkdtempSync(join(tmpdir(), "lcm-target-identity-parent-"));
      try {
        mkdirSync(join(root, "real", "moved"), { recursive: true, mode: 0o700 });
        symlinkSync(join(root, "real"), join(root, "link"));
        const alias = join(root, "link", "moved");
        const createProject = vi.fn(async (_input: unknown) => created);
        await resolveMigrationTargetProjectId({
          repository: repositoryStub({ resolveProject: vi.fn(async () => null), createProject }),
          ...base, aliases: [alias],
        });
        const sent = createProject.mock.calls[0]![0] as { aliases: Array<{ path: string; normalizedPath: string }> };
        expect(sent.aliases[1]).toEqual({ path: alias, normalizedPath: join(normalizeProjectPath(root), "real", "moved") });
        expect(sent.aliases[1]!.path).not.toBe(sent.aliases[1]!.normalizedPath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reuse: an equal alias set writes nothing and a missing subset is handed to one ensure call", async () => {
      for (const inserted of [0, 1]) {
        const createProject = vi.fn();
        const ensureProjectAliases = vi.fn(async () => ({ inserted }));
        const result = await resolveMigrationTargetProjectId({
          repository: repositoryStub({ resolveProject: vi.fn(async () => ({ projectId: "project-1", alias: {} as never })), createProject, ensureProjectAliases }),
          ...base, aliases: ["/tmp/moved-project"],
        });
        expect(result).toEqual({ status: "resolved", projectId: "project-1", effect: "reused" });
        expect(ensureProjectAliases).toHaveBeenCalledWith({ machineId: MACHINE_ID, projectId: "project-1", aliases: rows });
        expect(createProject).not.toHaveBeenCalled();
      }
    });

    it("reuse: a foreign or extra row (ensure returns null) refuses as alias-conflict", async () => {
      const result = await resolveMigrationTargetProjectId({
        repository: repositoryStub({
          resolveProject: vi.fn(async () => ({ projectId: "project-1", alias: {} as never })),
          ensureProjectAliases: vi.fn(async () => null),
        }),
        ...base,
      });
      expect(result).toEqual(conflict);
    });

    it.each([
      ["a lexical owner", new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/p", "other", "project-1")],
      ["a stored path", new PostgreSqlIdentityAliasPathConflictError(MACHINE_ID, "/tmp/p", "project-1", "/a", "/b")],
      ["a stored normalized path", new PostgreSqlIdentityAliasNormalizedPathConflictError(MACHINE_ID, "/tmp/p", "project-1", "/a", "/b")],
    ])("reuse: a concurrent race on %s inside ensure refuses as alias-conflict, other errors propagate", async (_label, error) => {
      const repository = (failure: Error) => repositoryStub({
        resolveProject: vi.fn(async () => ({ projectId: "project-1", alias: {} as never })),
        ensureProjectAliases: vi.fn(async () => { throw failure; }),
      });
      expect(await resolveMigrationTargetProjectId({ repository: repository(error), ...base })).toEqual(conflict);
      await expect(resolveMigrationTargetProjectId({ repository: repository(new Error("connection reset")), ...base }))
        .rejects.toThrow("connection reset");
    });

    it.each([
      ["a stored path", new PostgreSqlIdentityAliasPathConflictError(MACHINE_ID, "/tmp/p", "x", "/a", "/b")],
      ["a stored normalized path", new PostgreSqlIdentityAliasNormalizedPathConflictError(MACHINE_ID, "/tmp/p", "x", "/a", "/b")],
    ])("created: %s conflict on an alias rolls the mint back and refuses as alias-conflict", async (_label, error) => {
      const result = await resolveMigrationTargetProjectId({
        repository: repositoryStub({ resolveProject: vi.fn(async () => null), createProject: vi.fn(async () => { throw error; }) }),
        ...base, aliases: ["/tmp/moved-project"],
      });
      expect(result).toEqual(conflict);
    });

    it("created: losing the canonical race to a concurrent winner applies the reuse rules to the winner's project", async () => {
      const ensureProjectAliases = vi.fn(async () => ({ inserted: 1 }));
      const result = await resolveMigrationTargetProjectId({
        repository: repositoryStub({
          resolveProject: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ projectId: "winner", alias: {} as never }),
          createProject: vi.fn(async () => { throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/project", "winner", "loser"); }),
          ensureProjectAliases,
        }),
        ...base, aliases: ["/tmp/moved-project"],
      });
      expect(result).toEqual({ status: "resolved", projectId: "winner", effect: "reused" });
      expect(ensureProjectAliases).toHaveBeenCalledWith({ machineId: MACHINE_ID, projectId: "winner", aliases: rows });
    });

    it("created: an alias bound to another project (conflict with no canonical winner) refuses as alias-conflict", async () => {
      const result = await resolveMigrationTargetProjectId({
        repository: repositoryStub({
          resolveProject: vi.fn(async () => null),
          createProject: vi.fn(async () => { throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/moved-project", "other", "loser"); }),
        }),
        ...base, aliases: ["/tmp/moved-project"],
      });
      expect(result).toEqual(conflict);
    });
  });

  it("re-reads and resolves to the winner's id on a real PostgreSqlIdentityConflictError -- never refuses on a concurrent create (red: propagating this error as a refusal instead of re-reading would fail this test)", async () => {
    const resolveProject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ projectId: "winner-project", alias: {} as never });
    const createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/project", "winner-project", "loser-project");
    });
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({ status: "resolved", projectId: "winner-project", effect: "reused" });
    expect(resolveProject).toHaveBeenCalledTimes(2);
  });

  it("refuses migration-target-identity-unresolvable when a conflict error's own re-read still finds nothing (should be unreachable in practice, but must not be guessed as a fresh retry)", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => {
      throw new PostgreSqlIdentityConflictError(MACHINE_ID, "/tmp/project", "winner-project", "loser-project");
    });
    const result = await resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    });
    expect(result).toEqual({
      status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent",
    });
  });

  it("re-throws a non-conflict error from createProject rather than misclassifying it as a race", async () => {
    const resolveProject = vi.fn(async () => null);
    const createProject = vi.fn(async () => { throw new Error("connection reset"); });
    await expect(resolveMigrationTargetProjectId({
      repository: repositoryStub({ resolveProject, createProject }),
      machineId: MACHINE_ID, displayName: "d", authorityCanonicalPath: "/tmp/project",
    })).rejects.toThrow("connection reset");
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("the normalization hazard: authorityCanonicalPath converges with daemon/project.ts's own canonical for a real linked Git worktree", () => {
  it("normalizeProjectPath(authority.canonicalPath) equals normalizeProjectIdentityPath(worktreeCwd) for a real git worktree add fixture -- not a mocked path string, because the whole point is that the two normalizations genuinely differ for an unanchored input and only converge for an already-anchored one", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-target-identity-worktree-"));
    try {
      const main = join(root, "main");
      const linked = join(root, "linked");
      mkdirSync(main, { recursive: true, mode: 0o700 });
      git(main, "init", "-q");
      git(main, "config", "user.email", "test@example.invalid");
      git(main, "config", "user.name", "LCM Test");
      writeFileSync(join(main, "README.md"), "test\n", { mode: 0o600 });
      git(main, "add", "README.md");
      git(main, "commit", "-qm", "initial");
      git(main, "worktree", "add", "-qb", "linked", linked);

      // What authenticateSqliteMigrationSource's canonicalPath actually is
      // for a fresh (not yet project-map-registered) linked worktree: the
      // real code path (localProjectIdentity's fallback) that computes it
      // via normalizeProjectIdentityPath -- anchoring to the repository,
      // not the worktree.
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-target-identity-home-"));
      const local = localProjectIdentity(linked, homeDir);
      const authorityCanonicalPath = local.canonical;

      // This module's own internal computation.
      const thisModuleKey = normalizeProjectPath(authorityCanonicalPath);

      // What #625's own map-entry canonical would independently compute
      // for the *same worktree cwd*, via daemon/project.ts's real
      // production path (normalizeProjectIdentityPath, not
      // normalizeProjectPath).
      const mapEntryCanonical = normalizeProjectIdentityPath(linked);

      expect(thisModuleKey).toBe(mapEntryCanonical);
      // Positive control: the worktree and the repository really are
      // different real paths on disk, so this is not trivially true.
      expect(normalizeProjectPath(linked)).not.toBe(mapEntryCanonical);

      // Red-first: if this module's input were the raw worktree cwd
      // instead of the capture authority's already-anchored
      // canonicalPath, the two normalizations would disagree.
      const wrongInputKey = normalizeProjectPath(linked);
      expect(wrongInputKey).not.toBe(mapEntryCanonical);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

