import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { PromotedStore } from "../src/db/promoted.js";
import {
  EXPORT_VERSION,
  exportKnowledge,
  importKnowledge,
  type ExportDocument,
} from "../src/portable-knowledge.js";
import {
  addProjectAlias,
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  projectMapPath,
} from "../src/project-map.js";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import { lcmHomeDir } from "../src/runtime-paths.js";
import { isLcmConnectionOpen } from "../src/db/connection.js";
import { ScrubEngine } from "../src/scrub.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";
import { createPublicationConvergence } from "../src/storage/publication-convergence.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tempHome: string | undefined;

function makeTempDir() {
  const d = mkdtempSync(join(tmpdir(), "lcm-portable-knowledge-"));
  tempDirs.push(d);
  return d;
}

function makeRepository(): { main: string; linked: string } {
  const root = makeTempDir();
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main);
  const git = (cwd: string, ...args: string[]) => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
  git(main, "init", "-q");
  git(main, "config", "user.email", "test@example.invalid");
  git(main, "config", "user.name", "LCM Test");
  writeFileSync(join(main, "README.md"), "test\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-qb", "linked", linked);
  return { main, linked };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "lcm-portable-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  mkdirSync(join(tempHome, ".lcm"), { mode: 0o700 });
  clearProjectMapCache();
  clearGitProjectAnchorCache();
  clearWorktreeReconciliationCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearProjectMapCache();
  clearGitProjectAnchorCache();
  clearWorktreeReconciliationCache();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

/**
 * Compute the project ID the same way the real code does.
 */
function toProjectId(cwd: string): string {
  let real: string;
  try { real = realpathSync(cwd); } catch { real = cwd; }
  return createHash("sha256").update(real).digest("hex");
}

/**
 * Set up a fake ~/.lcm project at `baseDir`
 * seeded with the given entries, and return the project dir.
 */
function seedProject(
  baseDir: string,
  cwd: string,
  entries: Array<{ content: string; tags?: string[]; confidence?: number; sessionId?: string }>,
) {
  const projId = toProjectId(cwd);
  const projDir = join(baseDir, "projects", projId);
  mkdirSync(projDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projDir, "meta.json"), JSON.stringify({ cwd }), { mode: 0o600 });

  const dbPath = join(projDir, "db.sqlite");
  writeFileSync(dbPath, "", { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  runLcmMigrations(db);
  const store = new PromotedStore(db);

  for (const e of entries) {
    store.insert({
      content: e.content,
      tags: e.tags ?? [],
      projectId: projId,
      sessionId: e.sessionId,
      depth: 0,
      confidence: e.confidence ?? 1.0,
    });
  }
  db.close();

  return { projDir, projId, dbPath };
}

function configurePostgreSqlBackend(): void {
  const home = lcmHomeDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const caPath = join(home, "postgres-ca.crt");
  writeFileSync(caPath, "trusted-ca", { mode: 0o600 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ storage: { backend: "postgresql" } }), { mode: 0o600 });
  vi.stubEnv("LCM_POSTGRES_URL", "postgresql://user:password@db.example.com/lcm");
  vi.stubEnv("LCM_POSTGRES_CA_FILE", caPath);
  vi.stubEnv("LCM_POSTGRES_MIGRATION_ROLE", "lcm_test_migrator");
}

it("fails closed before portable export or import can access SQLite under PostgreSQL", async () => {
  configurePostgreSqlBackend();
  const baseDir = makeTempDir();
  const cwd = makeTempDir();
  const projectDir = join(baseDir, "projects", toProjectId(cwd));
  const output = join(baseDir, "export.json");
  const doc: ExportDocument = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projectCwd: cwd,
    entries: [],
  };

  await expect(exportKnowledge(cwd, { output, skipScrub: true, _lcmBaseDir: baseDir }))
    .rejects.toBeInstanceOf(BackendPublicationJournalError);
  await expect(importKnowledge(cwd, doc, { _lcmBaseDir: baseDir }))
    .rejects.toBeInstanceOf(BackendPublicationJournalError);

  expect(existsSync(output)).toBe(false);
  expect(existsSync(projectDir)).toBe(false);
  expect(isLcmConnectionOpen(join(projectDir, "db.sqlite"))).toBe(false);
});

// ─── Export tests ────────────────────────────────────────────────────────────

describe("portable-knowledge — export", () => {
  it("exports entries to stdout (captured)", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    seedProject(baseDir, cwd, [
      { content: "We use TypeScript everywhere", tags: ["decision"] },
      { content: "Database is SQLite", tags: ["decision", "db"] },
    ]);

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any): boolean => { chunks.push(String(chunk)); return true; };

    try {
      const result = await exportKnowledge(cwd, { skipScrub: true, _lcmBaseDir: baseDir });
      expect(result.exported).toBe(2);
      expect(result.projectCwd).toBe(cwd);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    const doc: ExportDocument = JSON.parse(output);
    expect(doc.version).toBe(EXPORT_VERSION);
    expect(doc.projectCwd).toBe(cwd);
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0].content).toBe("We use TypeScript everywhere");
    expect(doc.entries[0].tags).toContain("decision");
    expect(typeof doc.entries[0].confidence).toBe("number");
    expect(typeof doc.entries[0].createdAt).toBe("string");
  });

  it("exports to a file when --output is specified", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "out.json");

    seedProject(baseDir, cwd, [{ content: "Entry one", tags: ["note"] }]);

    const result = await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });
    expect(result.exported).toBe(1);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].content).toBe("Entry one");
  });

  it("supports an internal convergence runner while persisting once", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "converged.json");
    seedProject(baseDir, cwd, [{ content: "Converged entry", tags: ["note"] }]);

    const result = await exportKnowledge(cwd, {
      output: outFile,
      skipScrub: true,
      _lcmBaseDir: baseDir,
      _publicationConvergence: createPublicationConvergence({ port: 3737 }),
    });

    expect(result.exported).toBe(1);
    expect(JSON.parse(readFileSync(outFile, "utf-8")).entries).toHaveLength(1);
  });

  it("retries export gathering and writes only the winning document", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "retried.json");
    seedProject(baseDir, cwd, [{ content: "Retried entry", tags: ["note"] }]);
    const { SqliteStorageBackendFactory } = await import("../src/storage/sqlite/factory.js");
    const contention = new (await import("../src/private-mutation-lock.js")).PrivateMutationLockContentionError("busy");
    const runMigration = vi.spyOn(SqliteStorageBackendFactory.prototype, "openExistingProject");
    runMigration.mockImplementationOnce(() => { throw contention; });
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "test", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      deps: {
        now: (() => { let value = 0; return () => value; })(),
        sleep: async () => undefined,
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth",
        lockPath: join(baseDir, "publication.lock"),
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "test", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    });
    try {
      const result = await exportKnowledge(cwd, {
        output: outFile,
        skipScrub: true,
        _lcmBaseDir: baseDir,
        _publicationConvergence: convergence,
      });
      expect(result.exported).toBe(1);
      expect(runMigration).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(outFile, "utf-8")).entries).toHaveLength(1);
    } finally {
      runMigration.mockRestore();
    }
  });

  it("retries export gathering before emitting one stdout document", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    seedProject(baseDir, cwd, [{ content: "stdout retry", tags: ["note"] }]);
    const { SqliteStorageBackendFactory } = await import("../src/storage/sqlite/factory.js");
    const contention = new (await import("../src/private-mutation-lock.js")).PrivateMutationLockContentionError("busy");
    const runMigration = vi.spyOn(SqliteStorageBackendFactory.prototype, "openExistingProject");
    runMigration.mockImplementationOnce(() => { throw contention; });
    let now = 0;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "test", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      deps: {
        now: () => now, sleep: async (delayMs: number) => { now += delayMs; },
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: 42, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth", lockPath: join(baseDir, "publication.lock"),
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "test", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await exportKnowledge(cwd, { skipScrub: true, _lcmBaseDir: baseDir, _publicationConvergence: convergence });
      const documents = output.mock.calls.map(([value]) => String(value)).filter(value => value.includes('"version"'));
      expect(documents).toHaveLength(1);
      expect(JSON.parse(documents[0]!).entries).toHaveLength(1);
      expect(runMigration).toHaveBeenCalledTimes(2);
    } finally {
      runMigration.mockRestore();
    }
  });

  it.each([
    ["stdout", "exhausted", false, true],
    ["file", "exhausted", true, true],
    ["stdout", "unauthenticated", false, false],
    ["file", "unauthenticated", true, false],
  ])("preserves %s on %s gather admission", async (_mode, _reason, toFile, authenticated) => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "existing.json");
    writeFileSync(outFile, "previous export");
    seedProject(baseDir, cwd, [{ content: "blocked entry", tags: ["note"] }]);
    const { SqliteStorageBackendFactory } = await import("../src/storage/sqlite/factory.js");
    const { PrivateMutationLockContentionError } = await import("../src/private-mutation-lock.js");
    const contention = new PrivateMutationLockContentionError("publication busy");
    const runMigration = vi.spyOn(SqliteStorageBackendFactory.prototype, "openExistingProject").mockImplementation(() => { throw contention; });
    let now = 0;
    const convergence = createPublicationConvergence({
      port: 3737,
      identity: { pid: 42, version: "test", storageBackend: "sqlite", entrypoint: "/daemon", runtimeDigest: "runtime" },
      deps: {
        now: () => now, sleep: async (delayMs: number) => { now += delayMs; },
        readToken: () => "token",
        readOwner: () => ({ version: 1, pid: authenticated ? 42 : 99, processStartTime: "birth", nonce: "a".repeat(32) }),
        processBirth: () => "birth", lockPath: join(baseDir, "publication.lock"),
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({
          status: "ok", pid: 42, version: "test", storageBackend: "sqlite",
          entrypoint: "/daemon", runtimeDigest: "runtime",
        }) })) as unknown as typeof globalThis.fetch,
      },
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(exportKnowledge(cwd, {
        output: toFile ? outFile : undefined,
        skipScrub: true, _lcmBaseDir: baseDir, _publicationConvergence: convergence,
      })).rejects.toBe(contention);
      expect(output).not.toHaveBeenCalled();
      expect(readFileSync(outFile, "utf-8")).toBe("previous export");
      expect(runMigration).toHaveBeenCalledTimes(authenticated ? 40 : 1);
      expect(now).toBe(authenticated ? 2000 : 0);
    } finally {
      runMigration.mockRestore();
      output.mockRestore();
    }
  });

  it("scrubs secrets by default", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "scrubbed.json");
    seedProject(baseDir, cwd, [
      { content: "token: sk-abcdefghijklmnopqrstuvwxyz123456", tags: ["secret"] },
    ]);

    await exportKnowledge(cwd, { output: outFile, _lcmBaseDir: baseDir });

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries[0].content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("applies global patterns to exported content and tags", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "global-scrubbed.json");
    seedProject(baseDir, cwd, [{ content: "private GLOBAL-1234", tags: ["token:GLOBAL-1234"] }]);
    await exportKnowledge(cwd, {
      output: outFile,
      _lcmBaseDir: baseDir,
      _globalPatterns: ["GLOBAL-[0-9]{4}"],
    });
    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries[0]).toMatchObject({ content: "private [REDACTED]", tags: ["[REDACTED]"] });
  });

  it("exports canonical project knowledge when invoked from an alias", async () => {
    const baseDir = lcmHomeDir();
    const canonical = makeTempDir();
    const alias = makeTempDir();
    const outFile = join(makeTempDir(), "alias-export.json");
    seedProject(baseDir, canonical, [{ content: "Canonical memory", tags: ["decision"] }]);
    addProjectAlias(alias, { canonical });

    const result = await exportKnowledge(alias, { output: outFile, skipScrub: true });

    expect(result.exported).toBe(1);
    expect(result.projectCwd).toBe(realpathSync(canonical));
  });

  it("reconciles and exports promoted knowledge from a legacy linked-worktree store", { timeout: 10_000 }, async () => {
    const { main, linked } = makeRepository();
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const baseDir = lcmHomeDir();
    const outFile = join(makeTempDir(), "legacy-worktree-export.json");
    seedProject(baseDir, linked, [{
      content: "Legacy linked-worktree memory",
      tags: ["decision"],
    }]);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`, { mode: 0o600 });
    clearProjectMapCache();

    const result = await exportKnowledge(linked, {
      output: outFile,
      skipScrub: true,
    });

    expect(result).toEqual({ exported: 1, projectCwd: canonical });
    const exported: ExportDocument = JSON.parse(readFileSync(outFile, "utf8"));
    expect(exported.entries).toEqual([
      expect.objectContaining({ content: "Legacy linked-worktree memory" }),
    ]);
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
    expect(JSON.parse(readFileSync(
      join(baseDir, "projects", targetHash, "meta.json"),
      "utf8",
    ))).toMatchObject({ cwd: canonical });
  });

  it("filters by tags", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "tagged.json");

    seedProject(baseDir, cwd, [
      { content: "Architecture decision", tags: ["decision", "architecture"] },
      { content: "Random note", tags: ["note"] },
    ]);

    const result = await exportKnowledge(cwd, {
      tags: ["decision"],
      output: outFile,
      skipScrub: true,
      _lcmBaseDir: baseDir,
    });
    expect(result.exported).toBe(1);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries[0].content).toBe("Architecture decision");
  });

  it("filters by since date (future date returns empty)", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "since.json");

    seedProject(baseDir, cwd, [{ content: "Old entry", tags: [] }]);

    const result = await exportKnowledge(cwd, {
      since: "2099-01-01",
      output: outFile,
      skipScrub: true,
      _lcmBaseDir: baseDir,
    });
    expect(result.exported).toBe(0);

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.entries).toHaveLength(0);
  });

  it("throws if no database found", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    await expect(
      exportKnowledge(cwd, { skipScrub: true, _lcmBaseDir: baseDir }),
    ).rejects.toThrow("No LCM storage found");
  });

  it("export document has the correct shape", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const outFile = join(makeTempDir(), "shape.json");

    seedProject(baseDir, cwd, [
      { content: "Shape test", tags: ["test"], confidence: 0.75, sessionId: "sess-abc" },
    ]);

    await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });

    const doc: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(doc.version).toBe(1);
    expect(typeof doc.exportedAt).toBe("string");
    expect(doc.projectCwd).toBe(cwd);
    const e = doc.entries[0];
    expect(e.content).toBe("Shape test");
    expect(e.tags).toEqual(["test"]);
    expect(e.confidence).toBe(0.75);
    // sessionId is nullified on export so cross-project imports don't create
    // dead references pointing at sessions that don't exist in the new context.
    expect(e.sessionId).toBeNull();
  });
});

// ─── Import tests ─────────────────────────────────────────────────────────────

describe("portable-knowledge — import", () => {
  function makeDoc(entries: ExportDocument["entries"]): ExportDocument {
    return {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      projectCwd: "/some/other/project",
      entries,
    };
  }

  it("imports entries into an empty project", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Imported insight",
        tags: ["decision"],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const result = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    expect(result.total).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.dryRun).toBe(false);

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    expect(existsSync(dbPath)).toBe(true);

    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("retries a document after scrub patterns change without new rows", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const doc = makeDoc([{ content: "knowledge SECRETWORD details", tags: ["note"], confidence: 0.8, createdAt: "2026-01-01T00:00:00Z", sessionId: null }]);
    await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir, _globalPatterns: [] });
    const retry = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir, _globalPatterns: ["SECRETWORD"] });
    expect(retry).toMatchObject({ imported: 0, skipped: 1 });
    const db = new DatabaseSync(join(baseDir, "projects", toProjectId(cwd), "db.sqlite"));
    try { expect(new PromotedStore(db).getAll()).toHaveLength(1); } finally { db.close(); }
  });

  it("rolls back the whole document when a later insert fails", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const { dbPath } = seedProject(baseDir, cwd, []);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON promoted WHEN NEW.content = 'rejected second entry' BEGIN SELECT RAISE(ABORT, 'postgresql://CANARY:secret@host/db SQL'); END");
    const doc = makeDoc([
      { content: "accepted first entry", tags: [], confidence: 1, createdAt: "2026-01-01", sessionId: null },
      { content: "rejected second entry", tags: [], confidence: 1, createdAt: "2026-01-01", sessionId: null },
    ]);
    try {
      const failure = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir }).then(
        () => { throw new Error("Import unexpectedly succeeded"); },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(/CANARY|secret|postgresql:\/\/|SQL/);
      expect(failure).not.toHaveProperty("cause");
      expect(new PromotedStore(db).getAll()).toHaveLength(0);
      db.exec("DROP TRIGGER reject_import");
      await expect(importKnowledge(cwd, doc, { _lcmBaseDir: baseDir })).resolves.toMatchObject({ imported: 2 });
      expect(new PromotedStore(db).getAll()).toHaveLength(2);
    } finally { db.close(); }
  });

  it("skips invalid entries before SQL while committing valid entries", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const doc = makeDoc([
      { content: "bad\0value", tags: [], confidence: 1, createdAt: "2026-01-01", sessionId: null },
      { content: "valid entry", tags: [], confidence: 1, createdAt: "2026-01-01", sessionId: null },
    ]);
    expect(await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir })).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("preserves metadata and retry identities when duplicate rows collapse", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const doc = makeDoc([
      { content: "first imported note", tags: ["first"], confidence: 0.8, createdAt: "2026-01-01", sessionId: null },
      { content: "second imported note", tags: ["second"], confidence: 0.9, createdAt: "2026-01-01", sessionId: "source-session" },
    ]);
    await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    const db = new DatabaseSync(join(baseDir, "projects", toProjectId(cwd), "db.sqlite"));
    try {
      const store = new PromotedStore(db);
      const rows = store.getAll();
      store.update(rows[0].id, { metadata: { ...JSON.parse(rows[0].metadata), canonicalNote: "keep", ...JSON.parse('{"__proto__":{"preserved":"metadata"}}') } });
      store.update(rows[1].id, { metadata: { ...JSON.parse(rows[1].metadata), collapsedNote: "retain" } });
      const search = vi.spyOn(PromotedStore.prototype, "search").mockImplementation(() => rows.map((row) => ({
        id: row.id, content: row.content, tags: JSON.parse(row.tags), projectId: row.project_id,
        sessionId: row.session_id, confidence: row.confidence, createdAt: row.created_at, rank: -20,
      })));
      const merge = makeDoc([{ content: "combined note", tags: ["combined"], confidence: 1, createdAt: "2026-01-01", sessionId: null }]);
      await importKnowledge(cwd, merge, { _lcmBaseDir: baseDir });
      search.mockRestore();
      expect(store.getAll()).toHaveLength(1);
      const metadata = JSON.parse(store.getAll()[0].metadata);
      expect(metadata).toMatchObject({ canonicalNote: "keep", collapsedNote: "retain" });
      expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
      expect(metadata["__proto__"]).toEqual({ preserved: "metadata" });
      expect(await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir, _globalPatterns: ["imported"] })).toMatchObject({ imported: 0, skipped: 2 });
      expect(await importKnowledge(cwd, merge, { _lcmBaseDir: baseDir })).toMatchObject({ imported: 0, skipped: 1 });
    } finally { db.close(); }
  });

  it("indexes many source entries deduplicated into one memory for retry", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const search = vi.spyOn(PromotedStore.prototype, "search").mockImplementation(function (this: PromotedStore) {
      return this.getAll().map((row) => ({
        id: row.id, content: row.content, tags: JSON.parse(row.tags), projectId: row.project_id,
        sessionId: row.session_id, confidence: row.confidence, createdAt: row.created_at, rank: -20,
      }));
    });
    const doc = makeDoc(Array.from({ length: 40 }, (_, ordinal) => ({
      content: "duplicate common content", tags: [`source-${ordinal}`], confidence: 0.8,
      createdAt: "2026-01-01", sessionId: null,
    })));
    expect(await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir })).toMatchObject({ imported: 40, skipped: 0 });
    search.mockRestore();
    const db = new DatabaseSync(join(baseDir, "projects", toProjectId(cwd), "db.sqlite"));
    try {
      const rows = new PromotedStore(db).getAll();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].tags)).toHaveLength(40);
    } finally { db.close(); }
    expect(await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir, _globalPatterns: ["common"] }))
      .toMatchObject({ imported: 0, skipped: 40 });
  });

  it.each([null, {}, { version: 1 }, { version: 1, projectCwd: "source", exportedAt: "now", entries: {} }])(
    "rejects malformed documents without creating project storage: %j", async (document) => {
      const baseDir = makeTempDir();
      await expect(importKnowledge("/missing", document as ExportDocument, { _lcmBaseDir: baseDir })).rejects.toThrow();
      expect(existsSync(join(baseDir, "projects"))).toBe(false);
    },
  );

  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid confidence override %s without storage", async (confidence) => {
    const baseDir = makeTempDir();
    await expect(importKnowledge("/missing", makeDoc([]), { confidence, _lcmBaseDir: baseDir })).rejects.toThrow("Invalid import confidence");
    expect(existsSync(join(baseDir, "projects"))).toBe(false);
  });

  it.each([
    { content: 1 }, { content: "" }, { tags: [1] }, { tags: null }, { confidence: NaN }, { confidence: 2 },
    { createdAt: "invalid-date" }, { sessionId: 1 }, { content: "\ud800" },
  ])("classifies invalid entry before dry-run storage: %j", async (invalid) => {
    const baseDir = makeTempDir();
    const entry = { content: "valid", tags: [], confidence: 1, createdAt: "2026-01-01", sessionId: null, ...invalid };
    expect(await importKnowledge("/missing", makeDoc([entry as ExportDocument["entries"][number]]), { dryRun: true, _lcmBaseDir: baseDir }))
      .toMatchObject({ total: 1, imported: 0, skipped: 1, errors: ["Invalid knowledge entry at index 0"] });
    expect(existsSync(join(baseDir, "projects"))).toBe(false);
  });

  it("imports alias-invoked knowledge into the canonical project", async () => {
    const canonical = makeTempDir();
    const alias = makeTempDir();
    addProjectAlias(alias, { canonical });
    const canonicalId = toProjectId(canonical);

    const doc = makeDoc([
      {
        content: "Imported through alias",
        tags: ["decision"],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const result = await importKnowledge(alias, doc);
    const canonicalDbPath = join(lcmHomeDir(), "projects", canonicalId, "db.sqlite");
    const aliasDbPath = join(lcmHomeDir(), "projects", toProjectId(alias), "db.sqlite");

    expect(result.imported).toBe(1);
    expect(existsSync(canonicalDbPath)).toBe(true);
    expect(existsSync(aliasDbPath)).toBe(false);
  });

  it(
    "reconciles a legacy linked-worktree store before importing portable knowledge",
    { timeout: 10_000 },
    async () => {
    const { main, linked } = makeRepository();
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const baseDir = lcmHomeDir();
    seedProject(baseDir, linked, [{
      content: "Existing legacy memory",
      tags: ["existing"],
    }]);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`, { mode: 0o600 });
    clearProjectMapCache();
    const doc = makeDoc([{
      content: "Imported after reconciliation",
      tags: ["decision"],
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      sessionId: null,
    }]);

    await expect(importKnowledge(linked, doc)).resolves.toMatchObject({
      imported: 1,
      dryRun: false,
    });

    const targetPath = join(baseDir, "projects", targetHash, "db.sqlite");
    const target = new DatabaseSync(targetPath, { readOnly: true });
    const rows = new PromotedStore(target).getAll({ projectId: targetHash });
    expect(rows.map(({ content }) => content).sort()).toEqual([
      "Existing legacy memory",
      "Imported after reconciliation",
    ]);
    target.close();
    expect(existsSync(join(baseDir, "projects", sourceHash, "db.sqlite"))).toBe(false);
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
  });

  it("dry-run returns expected counts without writing", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Should not be written",
        tags: [],
        confidence: 1,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const result = await importKnowledge(cwd, doc, { dryRun: true, _lcmBaseDir: baseDir });
    expect(result.dryRun).toBe(true);
    expect(result.total).toBe(1);
    // dry-run must return imported: 0 — nothing was actually written
    expect(result.imported).toBe(0);

    // Nothing should be written
    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("keeps a legacy worktree import dry-run entirely read-only", async () => {
    const { main, linked } = makeRepository();
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const baseDir = lcmHomeDir();
    seedProject(baseDir, linked, [{ content: "Legacy dry-run memory" }]);
    const mapPath = projectMapPath();
    writeFileSync(mapPath, `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`, { mode: 0o600 });
    clearProjectMapCache();
    const mapBefore = readFileSync(mapPath, "utf8");

    await expect(importKnowledge(linked, makeDoc([]), { dryRun: true }))
      .resolves.toMatchObject({ dryRun: true });

    expect(readFileSync(mapPath, "utf8")).toBe(mapBefore);
    expect(existsSync(join(baseDir, "projects", sourceHash, "db.sqlite"))).toBe(true);
    expect(existsSync(join(baseDir, "projects", targetHash))).toBe(false);
    expect(existsSync(join(baseDir, "reconciliations"))).toBe(false);
  });

  it("rejects unsupported export versions", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const doc = { version: 999, exportedAt: "", projectCwd: "", entries: [] } as any;
    await expect(importKnowledge(cwd, doc, { _lcmBaseDir: baseDir })).rejects.toThrow(
      /Unsupported export version/,
    );
  });

  it("does not acquire a pooled connection when scrubber setup fails", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const projDir = join(baseDir, "projects", toProjectId(cwd));
    const dbPath = join(projDir, "db.sqlite");
    const setupFailure = new Error("scrubber setup failed");
    vi.spyOn(ScrubEngine, "forProject").mockRejectedValueOnce(setupFailure);

    await expect(importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir }))
      .rejects.toBe(setupFailure);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("overrides confidence when option is provided", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      {
        content: "Override confidence test",
        tags: [],
        confidence: 1.0,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    await importKnowledge(cwd, doc, { confidence: 0.3, _lcmBaseDir: baseDir });

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].confidence).toBe(0.3);
    db.close();
  });

  it("imports multiple entries and returns correct counts", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    const doc = makeDoc([
      { content: "TypeScript is the primary language", tags: ["decision"], confidence: 0.8, createdAt: new Date().toISOString(), sessionId: null },
      { content: "PostgreSQL for the data layer", tags: ["decision"], confidence: 0.9, createdAt: new Date().toISOString(), sessionId: null },
      { content: "React for the frontend", tags: ["decision"], confidence: 0.7, createdAt: new Date().toISOString(), sessionId: null },
    ]);

    const result = await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const projId = toProjectId(cwd);
    const dbPath = join(baseDir, "projects", projId, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    const store = new PromotedStore(db);
    const rows = store.getAll({ projectId: projId });
    expect(rows.length).toBe(3);
    db.close();
  });

  it("privately writes meta.json on import so the project is visible to export --all", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();

    // Import into a brand-new project (no prior meta.json)
    const doc = makeDoc([
      {
        content: "Round-trip test entry",
        tags: ["decision"],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        sessionId: null,
      },
    ]);

    const originalUmask = process.umask(0o022);
    try {
      await importKnowledge(cwd, doc, { _lcmBaseDir: baseDir });
    } finally {
      process.umask(originalUmask);
    }

    // meta.json must exist so export --all can discover this project
    const projId = toProjectId(cwd);
    const metaPath = join(baseDir, "projects", projId, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    expect(readFileSync(metaPath, "utf-8")).toBe(`{\n  "cwd": ${JSON.stringify(cwd)}\n}\n`);
    expect(statSync(metaPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(baseDir, "projects", projId)).mode & 0o777).toBe(0o700);

    // Verify the round-trip: export using the same project directory enumeration
    // that `lcm export --all` uses (scan projects/ for meta.json files).
    const projectsDir = join(baseDir, "projects");
    const discoveredCwds: string[] = [];
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mp = join(projectsDir, entry.name, "meta.json");
      if (!existsSync(mp)) continue;
      try {
        const m = JSON.parse(readFileSync(mp, "utf-8"));
        if (m.cwd) discoveredCwds.push(m.cwd);
      } catch { /* skip */ }
    }

    expect(discoveredCwds).toContain(cwd);

    // Full round-trip: export the imported project and verify the entry is there
    const outFile = join(makeTempDir(), "roundtrip.json");
    const { exportKnowledge } = await import("../src/portable-knowledge.js");
    const exportResult = await exportKnowledge(cwd, { output: outFile, skipScrub: true, _lcmBaseDir: baseDir });
    expect(exportResult.exported).toBe(1);

    const exported: ExportDocument = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(exported.entries[0].content).toBe("Round-trip test entry");
  });

  it("retains a nonexistent project path when canonicalization is unavailable", async () => {
    const baseDir = makeTempDir();
    const cwd = join(baseDir, "missing-project");

    await importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir, _globalPatterns: [] });

    const metaPath = join(baseDir, "projects", toProjectId(cwd), "meta.json");
    expect(JSON.parse(readFileSync(metaPath, "utf-8"))).toEqual({ cwd });
  });

  it("preserves existing meta.json bytes and mode", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const { projDir } = seedProject(baseDir, cwd, []);
    const metaPath = join(projDir, "meta.json");
    const existing = `${JSON.stringify({ cwd, marker: "keep malformed bytes" })}\ntrailing`;
    writeFileSync(metaPath, existing);
    chmodSync(metaPath, 0o640);

    await importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir });

    expect(readFileSync(metaPath, "utf-8")).toBe(existing);
    expect(statSync(metaPath).mode & 0o777).toBe(0o640);
  });

  it("leaves a legacy fixed metadata temp file untouched", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const projDir = join(baseDir, "projects", toProjectId(cwd));
    mkdirSync(projDir, { recursive: true, mode: 0o700 });
    const legacyTempPath = join(projDir, "meta.json.tmp");
    const sentinel = "legacy temporary metadata owner\n";
    writeFileSync(legacyTempPath, sentinel, { mode: 0o600 });
    const preservedTime = new Date("2000-01-02T03:04:05.000Z");
    utimesSync(legacyTempPath, preservedTime, preservedTime);
    const beforeMtimeMs = statSync(legacyTempPath).mtimeMs;

    await importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir });

    expect(readFileSync(legacyTempPath, "utf-8")).toBe(sentinel);
    expect(statSync(legacyTempPath).mtimeMs).toBe(beforeMtimeMs);
  });

  it("leaves a legacy fixed metadata temp symlink and its target untouched", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const projDir = join(baseDir, "projects", toProjectId(cwd));
    mkdirSync(projDir, { recursive: true, mode: 0o700 });
    const externalTarget = join(makeTempDir(), "external-target");
    const sentinel = "external private fixture\n";
    writeFileSync(externalTarget, sentinel, { mode: 0o600 });
    const preservedTime = new Date("2001-02-03T04:05:06.000Z");
    utimesSync(externalTarget, preservedTime, preservedTime);
    const beforeMtimeMs = statSync(externalTarget).mtimeMs;
    const legacyTempPath = join(projDir, "meta.json.tmp");
    symlinkSync(externalTarget, legacyTempPath);

    await importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir });

    expect(existsSync(legacyTempPath)).toBe(true);
    expect(lstatSync(legacyTempPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(legacyTempPath)).toBe(externalTarget);
    expect(readFileSync(externalTarget, "utf-8")).toBe(sentinel);
    expect(statSync(externalTarget).mtimeMs).toBe(beforeMtimeMs);
  });

  it("preserves a dangling meta.json symlink and completes the import", async () => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const projDir = join(baseDir, "projects", toProjectId(cwd));
    mkdirSync(projDir, { recursive: true, mode: 0o700 });
    const metaPath = join(projDir, "meta.json");
    const danglingTarget = join(makeTempDir(), "missing-meta-target");
    symlinkSync(danglingTarget, metaPath);
    expect(existsSync(metaPath)).toBe(false);

    const result = await importKnowledge(cwd, makeDoc([]), { _lcmBaseDir: baseDir });

    expect(result).toEqual({
      total: 0,
      imported: 0,
      skipped: 0,
      dryRun: false,
    });
    expect(lstatSync(metaPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(metaPath)).toBe(danglingTarget);
    expect(existsSync(danglingTarget)).toBe(false);
  });

  it.each([
    ["Error objects", new Error("failed entry"), "failed entry"],
    ["non-Error values", "plain failure", "plain failure"],
  ])("records %s thrown while importing an entry", async (_label, thrown, _message) => {
    const baseDir = makeTempDir();
    const cwd = makeTempDir();
    const entry = {
      get content(): string { throw thrown; },
      tags: [],
      confidence: 1,
      createdAt: new Date().toISOString(),
      sessionId: "source-session",
    };

    const result = await importKnowledge(cwd, makeDoc([entry]), { _lcmBaseDir: baseDir });

    expect(result).toMatchObject({ total: 1, imported: 0, skipped: 1, errors: ["Invalid knowledge entry at index 0"] });
  });
});
