import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCliProjectStorage } from "../src/cli-storage.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../src/git-project.js";
import { clearProjectMapCache, hashProjectPath, projectMapPath } from "../src/project-map.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";
import {
  RETIRED_PROJECT_IDENTITY_DIAGNOSTIC,
  RetiredProjectIdentityError,
  serializeWorktreeReconciliationFence,
} from "../src/worktree-reconciliation-fence.js";
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../src/storage/identity-context.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function makePrivateFixtureDirectory(path: string, options: { readonly recursive?: boolean } = {}): void {
  mkdirSync(path, { ...options, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function writePrivateFixtureFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Real Git repository with one linked worktree, used to build a sibling-source shape. */
function makeRepository(root: string): { main: string; linked: string } {
  const main = join(root, "main");
  const linked = join(root, "linked");
  makePrivateFixtureDirectory(main);
  git(main, "init", "-q");
  git(main, "config", "user.email", "test@example.invalid");
  git(main, "config", "user.name", "LCM Test");
  git(main, "remote", "add", "origin", "https://example.invalid/lcm.git");
  writePrivateFixtureFile(join(main, "README.md"), "test\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-qb", "linked", linked);
  return { main, linked };
}

/** Minimal real migrated LCM SQLite database, sufficient to act as a reconciliation source. */
function makeDatabase(path: string, sessionId: string): void {
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  runLcmMigrations(db);
  db.prepare(
    "INSERT INTO conversations(session_id, title, bootstrapped_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  ).run(sessionId, "title", "2026-01-01", "2026-01-01", "2026-01-02");
  db.close();
}

describe("CLI selected project storage — retired identity fence before backend resolution", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-cli-storage-retired-fence-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    cwd = join(home, "project");
    mkdirSync(cwd);
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

  function selectPostgresqlBackend(): void {
    const config = configModule.loadDaemonConfig(join(home, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    // Bypass real PostgreSQL publication-journal verification; the retired
    // local fence must be classified before any backend access is attempted.
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
  }

  function plantRetiredFence(): ReturnType<typeof projectPaths> {
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    rmSync(paths.dir, { recursive: true });
    writeFileSync(paths.dir, serializeWorktreeReconciliationFence(paths.id, "project"), { mode: 0o600 });
    clearWorktreeReconciliationCache();
    return paths;
  }

  it("surfaces the retired-identity renewal diagnostic for a PostgreSQL-selected config instead of the generic unbound-project message", async () => {
    plantRetiredFence();
    selectPostgresqlBackend();

    const attempt = withCliProjectStorage(cwd, { create: false }, async () => true);
    await expect(attempt).rejects.toBeInstanceOf(RetiredProjectIdentityError);
    await expect(attempt).rejects.toThrow(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
    // The bug this regresses: PostgreSQL's remote-identity lookup used to
    // throw the generic unbound-project message before the SQLite-only fence
    // check ever ran, hiding the renewal diagnostic entirely.
    await expect(attempt).rejects.not.toThrow(UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("still reports the generic unbound-project message for PostgreSQL when no fence is present", async () => {
    // Control case: an ordinary unbound PostgreSQL project (no retired local
    // fence at all) keeps its existing, unrelated diagnostic.
    selectPostgresqlBackend();

    await expect(withCliProjectStorage(cwd, { create: false }, async () => true))
      .rejects.toThrow(UNBOUND_POSTGRESQL_PROJECT_MESSAGE);
  });

  it("still classifies the same retired fence for the default SQLite backend", async () => {
    plantRetiredFence();

    await expect(withCliProjectStorage(cwd, { create: false }, async () => true))
      .rejects.toThrow(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
  });

  it("classifies a retired anchor fence before reconciliation discovers a sibling worktree source", async () => {
    // Finding 1 reproduction: a Git anchor whose hash is fenced (retired),
    // with a linked worktree still mapped under its own hash and holding a
    // real migrated database. Before the fix, ensureWorktreeProjectReconciled
    // ran first, discovered the linked worktree as a pending source, and
    // tried to open the fenced path as a directory — raising a generic
    // ENOTDIR failure instead of the renewal diagnostic.
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const anchorHash = hashProjectPath(canonical);
    const linkedHash = hashProjectPath(linked);

    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [anchorHash]: { canonical, aliases: [] },
      [linkedHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(join(home, ".lcm", "projects", linkedHash, "db.sqlite"), "sibling-source");

    makePrivateFixtureDirectory(join(home, ".lcm", "projects"), { recursive: true });
    writePrivateFixtureFile(
      join(home, ".lcm", "projects", anchorHash),
      serializeWorktreeReconciliationFence(anchorHash, "project"),
    );
    clearWorktreeReconciliationCache();

    const attempt = withCliProjectStorage(main, { create: false }, async () => true);
    await expect(attempt).rejects.toBeInstanceOf(RetiredProjectIdentityError);
    await expect(attempt).rejects.toThrow(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
  });
});
