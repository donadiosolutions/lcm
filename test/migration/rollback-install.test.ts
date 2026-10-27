/**
 * Tests for src/migration/rollback-install.ts.
 *
 * Per the epic's standing rule (plan-v2 section 0): every check names the
 * two independent observations it compares, and is proven breakable. The
 * order-matters checks here (pool release before rename, checkpoint
 * before move, witness before AND after the move) are each proven with a
 * real live connection, a real WAL database with real -wal/-shm siblings,
 * and a real content comparison -- not fixtures that assume the property
 * they are meant to prove.
 */

import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  getLcmConnection,
  isLcmConnectionOpen,
  closeLcmConnection,
} from "../../src/db/connection.js";
import {
  installRollbackGeneration,
  RollbackInstallError,
  checkCanonicalLiveExists,
  streamSha256,
  checkpointAndConvertToDelete,
  originalRollbackPreemption,
  readRollbackPreemptionRecord,
  rollbackPreemptionRecordPath,
} from "../../src/migration/rollback-install.js";
import { rollbackGenerationPath, rollbackGenerationsRoot } from "../../src/migration/rollback-generation.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
const renameSpy = vi.spyOn(fsModule, "renameSync");
/** The unmocked rename, bound to the actual module so a persistent mock implementation can call it. */
const realRenameSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
/** The last move of a rollback's move-aside record (the one a retry finishes). */
function lastMove(homeDir: string, rollbackGenerationId: string) {
  const record = readRollbackPreemptionRecord(homeDir, rollbackGenerationId)!;
  return record.moves[record.moves.length - 1]!;
}
/** The renames of the database files themselves; the durable move-aside record publishes through renames of its own. */
function databaseRenames(): number {
  return renameSpy.mock.calls.filter(([, to]) => String(to).endsWith(".sqlite")).length;
}

const dirs: string[] = [];
afterEach(() => {
  closeLcmConnection();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-install-home-"));
  dirs.push(dir);
  return dir;
}

function makeGenerationDir(homeDir: string, generationId: string): string {
  mkdirSync(rollbackGenerationsRoot(homeDir), { recursive: true, mode: 0o700 });
  const dir = rollbackGenerationPath(homeDir, generationId);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** A canonical-shaped live LCM database, real WAL mode, real content. */
function liveCanonicalDatabase(homeDir: string, content: string): string {
  const dir = join(homeDir, ".lcm", "projects", "proj-1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db, { fts5Available: false });
    db.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (1,'rollback-install-test','${content}','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
  } finally { db.close(); }
  chmodSync(path, 0o600);
  return path;
}

/** A minimal "verified generation" db.sqlite standing in for buildRollbackGeneration's output. */
function verifiedGenerationDatabase(dir: string, marker: string): string {
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  try {
    runLcmMigrations(db, { fts5Available: false });
    db.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (1,'verified-generation','${marker}','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
  } finally { db.close(); }
  chmodSync(path, 0o600);
  return path;
}

function conversationTitles(path: string): readonly string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT title FROM conversations ORDER BY conversation_id").all() as { title: string }[])
      .map((row) => row.title);
  } finally { db.close(); }
}

/** Runs a first attempt and crashes it right after the real move-aside rename, before the chmod. */
function crashAfterMoveAsideOf(homeDir: string, canonicalPath: string, preemptedPath: string, attempt: string, rollbackGenerationId: string): void {
  const generationDir = makeGenerationDir(homeDir, attempt);
  const verifiedPath = verifiedGenerationDatabase(generationDir, "attempt-1-never-installed");
  renameSpy.mockImplementation((from, to) => {
    realRenameSync(from as string, to as string);
    if (to === preemptedPath) throw new Error("simulated crash right after the move-aside rename");
  });
  try {
    expect(() => installRollbackGeneration({
      homeDir, generationId: attempt, rollbackGenerationId, canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow("simulated crash right after the move-aside rename");
  } finally {
    renameSpy.mockReset();
    renameSpy.mockImplementation((from, to) => realRenameSync(from as string, to as string));
  }
  expect(existsSync(canonicalPath)).toBe(false);
  expect(statSync(preemptedPath).mode & 0o777).toBe(0o600);
  expect(readRollbackPreemptionRecord(homeDir, rollbackGenerationId)).toMatchObject({ version: 2, canonicalPath, moves: [{ preemptedPath, after: null }] });
}

describe("installRollbackGeneration", () => {
  it("releases the pool, checkpoints WAL away, witnesses, moves the live database aside, and installs the verified one", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
    // Prove there really is WAL state to convert: open via the pool (as
    // the runtime does), write through it so a real -wal file exists,
    // and leave the pooled connection open -- exactly the state this
    // function must release before touching the file.
    const pooled = getLcmConnection(canonicalPath);
    pooled.exec("PRAGMA journal_mode=WAL");
    pooled.exec(`INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at)
      VALUES (2,'wal-write','through-pool','2026-09-06 00:00:00','2026-09-06 00:00:00')`);
    expect(isLcmConnectionOpen(canonicalPath)).toBe(true);
    expect(existsSync(`${canonicalPath}-wal`) || existsSync(`${canonicalPath}-shm`)).toBe(true);

    const generationDir = makeGenerationDir(homeDir, "gen-install-happy");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "post-rollback-verified-data");

    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-install-happy", rollbackGenerationId: "gen-install-happy-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    });

    // Breakable independently: pool released (not merely "connection
    // still works because SQLite tolerates a stale handle").
    expect(isLcmConnectionOpen(canonicalPath)).toBe(false);
    // The canonical path now serves the VERIFIED generation's content,
    // not the pre-rollback live content.
    expect(conversationTitles(canonicalPath)).toEqual(["post-rollback-verified-data"]);
    // No stray WAL siblings at the canonical name.
    expect(existsSync(`${canonicalPath}-wal`)).toBe(false);
    expect(existsSync(`${canonicalPath}-shm`)).toBe(false);
    // The preempted (pre-rollback) content is preserved, not discarded,
    // and is immutable evidence (0400) at a path beside the generation.
    expect(outcome.preempted).not.toBeNull();
    const preempted = outcome.preempted!;
    expect(preempted.path).toBe(join(generationDir, "preempted-canonical.sqlite"));
    expect(conversationTitles(preempted.path)).toEqual(["pre-rollback-live-data", "through-pool"]);
    expect(statSync(preempted.path).mode & 0o777).toBe(0o400);
    // Move-aside integrity: the two witnesses (taken before and after the
    // rename) agree on content, proving the rename preserved bytes.
    expect(preempted.before.sha256).toBe(preempted.after.sha256);
    expect(preempted.before.size).toBe(preempted.after.size);
  });

  it("F3: flushes both directories after the move-aside and again after the install, before returning", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "live-for-sync");
    const generationDir = makeGenerationDir(homeDir, "gen-install-sync");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "verified-for-sync");
    const canonicalDir = join(homeDir, ".lcm", "projects", "proj-1");
    const events: string[] = [];
    const renamesBefore = databaseRenames();
    installRollbackGeneration({
      homeDir, generationId: "gen-install-sync", rollbackGenerationId: "gen-install-sync-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
      syncDirectory: (path) => {
        const renames = databaseRenames() - renamesBefore;
        events.push(`after-rename-${renames}:${path === canonicalDir ? "canonical" : path === generationDir ? "generation" : path}`);
      },
    });
    expect(events).toEqual([
      "after-rename-1:canonical", "after-rename-1:generation",
      "after-rename-2:generation", "after-rename-2:canonical",
    ]);
  });

  // F14: the preserved database is read-only before the first flush, so the flush covers its mode.
  it("F14: makes the preserved database read-only before any directory is flushed", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "live-for-mode");
    const generationDir = makeGenerationDir(homeDir, "gen-install-mode");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "verified-for-mode");
    const modes: number[] = [];
    installRollbackGeneration({
      homeDir, generationId: "gen-install-mode", rollbackGenerationId: "gen-install-mode-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
      syncDirectory: () => {
        const preempted = join(generationDir, "preempted-canonical.sqlite");
        if (modes.length === 0) modes.push(statSync(preempted).mode & 0o777);
      },
    });
    expect(modes).toEqual([0o400]);
  });

  it("F3: a failing directory flush after the move-aside refuses before the install rename", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "live-sync-fails");
    const generationDir = makeGenerationDir(homeDir, "gen-install-sync-fail-1");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "verified-sync-fails");
    const renamesBefore = databaseRenames();
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-install-sync-fail-1", rollbackGenerationId: "gen-install-sync-fail-1-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
      syncDirectory: () => { throw new Error("EIO: directory sync failed"); },
    })).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("flushed") }));
    expect(databaseRenames() - renamesBefore).toBe(1);
  });

  it("F3: a failing directory flush after the install rename refuses (the install does not return)", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "live-sync-fails-late");
    const generationDir = makeGenerationDir(homeDir, "gen-install-sync-fail-2");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "verified-sync-fails-late");
    let syncs = 0;
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-install-sync-fail-2", rollbackGenerationId: "gen-install-sync-fail-2-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
      syncDirectory: () => { syncs += 1; if (syncs === 3) throw new Error("EIO: second flush failed"); },
    })).toThrow(expect.objectContaining({ reason: "unsafe-storage" }));
    expect(syncs).toBe(3);
  });

  it("F3: the second directory of a flush pair is not flushed twice when both entries share a directory", () => {
    const homeDir = tempHome();
    const dir = join(homeDir, ".lcm", "projects", "proj-same");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const canonicalPath = join(dir, "db.sqlite");
    const verifiedPath = verifiedGenerationDatabase(dir, "same-dir");
    const flushed: string[] = [];
    // verified lives beside the canonical path here, so a single directory changes.
    realRenameSync(verifiedPath, join(dir, "staged.sqlite"));
    installRollbackGeneration({
      homeDir, generationId: "gen-install-same-dir", rollbackGenerationId: "gen-install-same-dir-rollback", canonicalPath, verifiedDatabasePath: join(dir, "staged.sqlite"),
      syncDirectory: (path) => { flushed.push(path); },
    });
    expect(flushed).toEqual([dir]);
  });

  it("installs directly with no preemption when nothing is live at the canonical path yet", async () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, ".lcm", "projects", "proj-2", "db.sqlite");
    mkdirSync(join(homeDir, ".lcm", "projects", "proj-2"), { recursive: true, mode: 0o700 });
    const generationDir = makeGenerationDir(homeDir, "gen-install-first-time");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "first-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-install-first-time", rollbackGenerationId: "gen-install-first-time-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    expect(outcome.preempted).toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["first-install"]);
  });

  it("is idempotent across a simulated crash between move-aside and install: retrying after the canonical path is already absent skips straight to install", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-crash-live-data");
    const generationDir = makeGenerationDir(homeDir, "gen-crash-retry");
    // Simulate the crash: move the canonical file aside by hand, exactly
    // as this function's own first phase would, then never install.
    const preemptedPath = join(generationDir, "preempted-canonical.sqlite");
    realRenameSync(canonicalPath, preemptedPath);
    chmodSync(preemptedPath, 0o400);
    expect(existsSync(canonicalPath)).toBe(false);

    const verifiedPath = verifiedGenerationDatabase(generationDir, "post-crash-retry-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-crash-retry", rollbackGenerationId: "gen-crash-retry-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    // No new preemption on the retry -- the canonical path was already
    // absent, so this call skipped straight to install.
    expect(outcome.preempted).toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["post-crash-retry-install"]);
    // The FIRST attempt's preserved evidence is still there, untouched.
    expect(conversationTitles(preemptedPath)).toEqual(["pre-crash-live-data"]);
  });

  // PR #1556 thread 4308518705: a crash between the move-aside rename and the chmod/flush/after-witness. The retry
  // builds into a different generation directory (every attempt does), so it can only find the preserved file
  // through the durable move-aside record written before the rename.
  describe("a crash between the move-aside rename and its completion (PR #1556 thread 4308518705)", () => {
    const ROLLBACK = "gen-crash-after-rename";
    /** Runs the first attempt and crashes it right after the real move-aside rename. */
    function crashAfterMoveAside(homeDir: string, canonicalPath: string, preemptedPath: string): void {
      crashAfterMoveAsideOf(homeDir, canonicalPath, preemptedPath, "gen-crash-after-rename-rb1-1", ROLLBACK);
    }

    it("finishes the crashed attempt's move-aside from its record on the retry: read-only, both directories flushed, witnessed again, record completed", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const firstDir = rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1");
      const preemptedPath = join(firstDir, "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      // The bytes the first attempt witnessed (after its checkpoint and journal-mode conversion), unchanged since.
      const liveSha256 = createHash("sha256").update(readFileSync(preemptedPath)).digest("hex");
      expect(lastMove(homeDir, ROLLBACK).before.sha256).toBe(liveSha256);

      // The retry builds attempt 2 under the next manifest revision, in its own directory.
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      const verifiedPath = verifiedGenerationDatabase(secondDir, "attempt-2-installed");
      const flushed: string[] = [];
      const modeAtFirstFlush: number[] = [];
      const outcome = installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath, verifiedDatabasePath: verifiedPath,
        syncDirectory: (path) => {
          if (flushed.length === 0) modeAtFirstFlush.push(statSync(preemptedPath).mode & 0o777);
          flushed.push(path);
        },
      });
      expect(outcome.preempted).toMatchObject({ path: preemptedPath, before: { sha256: liveSha256 }, after: { sha256: liveSha256, mode: 0o400 } });
      expect(modeAtFirstFlush).toEqual([0o400]);
      expect(flushed).toEqual([join(homeDir, ".lcm", "projects", "proj-1"), firstDir, secondDir, join(homeDir, ".lcm", "projects", "proj-1")]);
      expect(readRollbackPreemptionRecord(homeDir, ROLLBACK)).toMatchObject({ moves: [{ preemptedPath, after: { sha256: liveSha256, mode: 0o400 } }] });
      expect(conversationTitles(canonicalPath)).toEqual(["attempt-2-installed"]);
      expect(conversationTitles(preemptedPath)).toEqual(["pre-rollback-live-data"]);
      expect(existsSync(join(secondDir, "preempted-canonical.sqlite"))).toBe(false);
    });

    it("refuses the retry when the preserved file's bytes no longer match the record's before-witness", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const preemptedPath = join(rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1"), "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      const bytes = readFileSync(preemptedPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
      writeFileSync(preemptedPath, bytes);
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      expect(() => installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(secondDir, "must-not-install"),
      })).toThrow(expect.objectContaining({ reason: "move-aside-content-changed" }));
      expect(existsSync(canonicalPath)).toBe(false);
    });

    it("refuses when the canonical database is absent and the unfinished record's preserved file is absent too, or names another canonical path", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const preemptedPath = join(rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1"), "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      const verifiedPath = verifiedGenerationDatabase(secondDir, "must-not-install");
      const retry = (canonical: string) => () => installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath: canonical, verifiedDatabasePath: verifiedPath,
      });
      const otherCanonical = join(homeDir, ".lcm", "projects", "proj-other", "db.sqlite");
      mkdirSync(join(homeDir, ".lcm", "projects", "proj-other"), { recursive: true, mode: 0o700 });
      expect(retry(otherCanonical)).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("names another canonical database") }));
      realRenameSync(preemptedPath, preemptedPath + ".moved");
      expect(retry(canonicalPath)).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("does not account") }));
      expect(existsSync(canonicalPath)).toBe(false);
    });

    it("refuses a live canonical database beside an unfinished preserved file", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const preemptedPath = join(rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1"), "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      liveCanonicalDatabase(homeDir, "someone-restored-a-live-database");
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      expect(() => installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(secondDir, "must-not-install"),
      })).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("both exist") }));
      expect(conversationTitles(canonicalPath)).toEqual(["someone-restored-a-live-database"]);
    });

    it("proceeds over an unfinished record whose rename never became durable (the canonical file is back, the preserved file absent)", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const preemptedPath = join(rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1"), "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      // Power loss undid the unflushed rename: the canonical file is where it was.
      realRenameSync(preemptedPath, canonicalPath);
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      const outcome = installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(secondDir, "attempt-2-installed"),
      });
      const secondPreempted = join(secondDir, "preempted-canonical.sqlite");
      expect(outcome.preempted?.path).toBe(secondPreempted);
      // The undone move stays in the record as unfinished history; the new move is the first completed one, the original.
      expect(readRollbackPreemptionRecord(homeDir, ROLLBACK)).toMatchObject({ moves: [{ preemptedPath, after: null }, { preemptedPath: secondPreempted, after: { mode: 0o400 } }] });
      expect(conversationTitles(secondPreempted)).toEqual(["pre-rollback-live-data"]);
    });

    it("reports a completed record on a retry whose crash came after the move-aside completed but before the install rename", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const firstDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb1-1");
      const preemptedPath = join(firstDir, "preempted-canonical.sqlite");
      renameSpy.mockImplementation((from, to) => {
        if (to === canonicalPath) throw new Error("simulated crash right before the install rename");
        realRenameSync(from as string, to as string);
      });
      try {
        expect(() => installRollbackGeneration({
          homeDir, generationId: "gen-crash-after-rename-rb1-1", rollbackGenerationId: ROLLBACK, canonicalPath,
          verifiedDatabasePath: verifiedGenerationDatabase(firstDir, "attempt-1-never-installed"),
        })).toThrow("simulated crash right before the install rename");
      } finally {
        renameSpy.mockReset();
        renameSpy.mockImplementation((from, to) => realRenameSync(from as string, to as string));
      }
      const completed = lastMove(homeDir, ROLLBACK);
      expect(completed.after).not.toBeNull();
      const completedRecord = readFileSync(rollbackPreemptionRecordPath(homeDir, ROLLBACK), "utf8");
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      const outcome = installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(secondDir, "attempt-2-installed"),
      });
      expect(outcome.preempted).toEqual({ path: preemptedPath, before: completed.before, after: completed.after });
      expect(readFileSync(rollbackPreemptionRecordPath(homeDir, ROLLBACK), "utf8")).toBe(completedRecord);
      expect(conversationTitles(canonicalPath)).toEqual(["attempt-2-installed"]);
    });

    it.each([
      ["unreadable mode", (path: string) => chmodSync(path, 0o644), "could not be read"],
      ["malformed JSON", (path: string) => writeFileSync(path, "{", { mode: 0o600 }), "is malformed"],
      ["malformed shape", (path: string) => writeFileSync(path, JSON.stringify({ version: 2 }), { mode: 0o600 }), "is malformed"],
      ["no moves", (path: string) => writeFileSync(path, JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")), moves: [],
      }), { mode: 0o600 }), "is malformed"],
      ["a version-1 shape", (path: string) => writeFileSync(path, JSON.stringify({ version: 1, rollbackGenerationId: ROLLBACK, canonicalPath: "", preemptedPath: "", before: null, after: null }), { mode: 0o600 }), "is malformed"],
      ["a null before-witness", (path: string) => writeFileSync(path, JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")), moves: [{ preemptedPath: "x", before: null, after: null }],
      }), { mode: 0o600 }), "is malformed"],
      ["a move that is not an object", (path: string) => writeFileSync(path, JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")), moves: [null],
      }), { mode: 0o600 }), "is malformed"],
      ["another rollback's id", (path: string) => writeFileSync(path, JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")), rollbackGenerationId: "gen-other",
      }), { mode: 0o600 }), "is malformed"],
    ])("refuses a move-aside record with %s", (_label, damage, message) => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "pre-rollback-live-data");
      const preemptedPath = join(rollbackGenerationPath(homeDir, "gen-crash-after-rename-rb1-1"), "preempted-canonical.sqlite");
      crashAfterMoveAside(homeDir, canonicalPath, preemptedPath);
      damage(rollbackPreemptionRecordPath(homeDir, ROLLBACK));
      const secondDir = makeGenerationDir(homeDir, "gen-crash-after-rename-rb2-1");
      expect(() => installRollbackGeneration({
        homeDir, generationId: "gen-crash-after-rename-rb2-1", rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(secondDir, "must-not-install"),
      })).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining(message) }));
    });
  });

  // Escalation review 8 (E17, E18, E19): the record keeps the original attribution across later moves, a completed
  // move is trusted only when its preserved file is exactly what it witnessed, and a chmod never follows a symlink.
  describe("the move-aside record across later attempts and external interference (escalation review 8)", () => {
    const ROLLBACK = "gen-record-review";
    const ATTEMPT = (n: number, revision = 1) => `gen-record-review-rb${revision}-${n}`;
    function install(homeDir: string, canonicalPath: string, attempt: string, marker: string, extra: Partial<Parameters<typeof installRollbackGeneration>[0]> = {}) {
      const dir = makeGenerationDir(homeDir, attempt);
      return installRollbackGeneration({
        homeDir, generationId: attempt, rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: verifiedGenerationDatabase(dir, marker), ...extra,
      });
    }
    /** A completed first move whose install rename then failed: the canonical path is absent, the record complete. */
    function completedThenCrashedBeforeInstall(homeDir: string, canonicalPath: string) {
      const dir = makeGenerationDir(homeDir, ATTEMPT(1));
      expect(() => installRollbackGeneration({
        homeDir, generationId: ATTEMPT(1), rollbackGenerationId: ROLLBACK, canonicalPath,
        verifiedDatabasePath: join(dir, "missing.sqlite"),
      })).toThrow(/ENOENT/);
      const original = originalRollbackPreemption(readRollbackPreemptionRecord(homeDir, ROLLBACK)!)!;
      expect(existsSync(canonicalPath)).toBe(false);
      return original;
    }

    it("E17: a held resume that crashes inside its own move-aside, then a third attempt, leave the original attribution intact and record the intermediate move beside it", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const first = install(homeDir, canonicalPath, ATTEMPT(1), "installed-1");
      const originalPath = first.preempted!.path;
      const originalIno = statSync(originalPath, { bigint: true }).ino;
      expect(conversationTitles(canonicalPath)).toEqual(["installed-1"]);
      // The supported held resume after a crash between the install and the selection: a second attempt under the
      // next revision moves the installed generation aside, and dies at its first flush (after the chmod).
      expect(() => install(homeDir, canonicalPath, ATTEMPT(1, 2), "installed-2", {
        syncDirectory: () => { throw new Error("second attempt crash after chmod"); },
      })).toThrow("directory could not be flushed");
      const crashed = readRollbackPreemptionRecord(homeDir, ROLLBACK)!;
      expect(crashed.moves).toHaveLength(2);
      expect(crashed.moves[0]).toEqual(first.preempted === null ? null : { preemptedPath: originalPath, before: first.preempted.before, after: first.preempted.after });
      expect(crashed.moves[1]!.after).toBeNull();
      expect(conversationTitles(crashed.moves[1]!.preemptedPath)).toEqual(["installed-1"]);
      expect(existsSync(canonicalPath)).toBe(false);

      const third = install(homeDir, canonicalPath, ATTEMPT(2, 2), "installed-3");
      expect(conversationTitles(canonicalPath)).toEqual(["installed-3"]);
      // The outcome and the record still name the original; the intermediate move is completed beside it.
      expect(third.preempted).toEqual(first.preempted);
      const record = readRollbackPreemptionRecord(homeDir, ROLLBACK)!;
      expect(originalRollbackPreemption(record)).toEqual(record.moves[0]);
      expect(record.moves).toHaveLength(2);
      expect(record.moves[1]!.after).toMatchObject({ mode: 0o400, sha256: record.moves[1]!.before.sha256 });
      expect(conversationTitles(record.moves[1]!.preemptedPath)).toEqual(["installed-1"]);
      expect(statSync(record.moves[1]!.preemptedPath).mode & 0o777).toBe(0o400);
      expect(statSync(originalPath, { bigint: true }).ino).toBe(originalIno);
      expect(statSync(originalPath).mode & 0o777).toBe(0o400);
      expect(conversationTitles(originalPath)).toEqual(["original-pre-rollback"]);
    });

    it("E17: a plain reinstall (a retry after a crash past the install) moves the installed generation aside as a second move and still reports the original", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const first = install(homeDir, canonicalPath, ATTEMPT(1), "installed-1");
      const second = install(homeDir, canonicalPath, ATTEMPT(1, 2), "installed-2");
      expect(second.preempted).toEqual(first.preempted);
      const record = readRollbackPreemptionRecord(homeDir, ROLLBACK)!;
      expect(record.moves.map((move) => move.preemptedPath)).toEqual([
        join(rollbackGenerationPath(homeDir, ATTEMPT(1)), "preempted-canonical.sqlite"),
        join(rollbackGenerationPath(homeDir, ATTEMPT(1, 2)), "preempted-canonical.sqlite"),
      ]);
      expect(conversationTitles(record.moves[0]!.preemptedPath)).toEqual(["original-pre-rollback"]);
      expect(conversationTitles(record.moves[1]!.preemptedPath)).toEqual(["installed-1"]);
      expect(conversationTitles(canonicalPath)).toEqual(["installed-2"]);
    });

    it.each([
      ["missing", (path: string) => { chmodSync(path, 0o600); fsModule.unlinkSync(path); }, "is missing"],
      // The original is renamed aside rather than unlinked, so its inode stays allocated and the replacement
      // cannot reuse it (a filesystem that recycles a freed inode number would otherwise pass the identity check
      // and refuse on the bytes instead; the same-inode case is the "rewritten in place" test below).
      ["replaced by another database", (path: string) => {
        chmodSync(path, 0o600); fsModule.renameSync(path, path + ".original");
        verifiedGenerationDatabase(join(path, ".."), "replacement-after-crash"); fsModule.renameSync(join(path, "..", "db.sqlite"), path); chmodSync(path, 0o600);
      }, "no longer a plain single-link read-only file"],
      ["replaced by another read-only database", (path: string) => {
        chmodSync(path, 0o600); fsModule.renameSync(path, path + ".original");
        verifiedGenerationDatabase(join(path, ".."), "replacement-after-crash"); fsModule.renameSync(join(path, "..", "db.sqlite"), path); chmodSync(path, 0o400);
        expect(statSync(path, { bigint: true }).ino).not.toBe(statSync(path + ".original", { bigint: true }).ino);
      }, "not the file its move-aside record completed"],
      ["the same bytes in a different file", (path: string) => {
        fsModule.copyFileSync(path, path + ".copy"); chmodSync(path, 0o600); fsModule.unlinkSync(path); fsModule.renameSync(path + ".copy", path); chmodSync(path, 0o400);
      }, "not the file its move-aside record completed"],
      ["writable again", (path: string) => chmodSync(path, 0o600), "no longer a plain single-link read-only file"],
      ["hardlinked", (path: string) => linkSync(path, path + ".link"), "no longer a plain single-link read-only file"],
    ])("E18: a completed record whose preserved file is %s refuses without installing", (_label, damage, message) => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const original = completedThenCrashedBeforeInstall(homeDir, canonicalPath);
      damage(original.preemptedPath);
      expect(() => install(homeDir, canonicalPath, ATTEMPT(1, 2), "must-not-install"))
        .toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining(message) }));
      expect(existsSync(canonicalPath)).toBe(false);
    });

    it("E18: a completed record whose bytes were rewritten in place under the same identity refuses", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const original = completedThenCrashedBeforeInstall(homeDir, canonicalPath);
      const bytes = readFileSync(original.preemptedPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
      chmodSync(original.preemptedPath, 0o600);
      writeFileSync(original.preemptedPath, bytes);
      chmodSync(original.preemptedPath, 0o400);
      expect(() => install(homeDir, canonicalPath, ATTEMPT(1, 2), "must-not-install"))
        .toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("bytes differ") }));
      expect(existsSync(canonicalPath)).toBe(false);
    });

    it("E18: a completed record for another canonical path refuses, whether the canonical path is absent or live", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const original = completedThenCrashedBeforeInstall(homeDir, canonicalPath);
      const other = join(homeDir, ".lcm", "projects", "proj-other", "db.sqlite");
      mkdirSync(join(homeDir, ".lcm", "projects", "proj-other"), { recursive: true, mode: 0o700 });
      expect(() => install(homeDir, other, ATTEMPT(1, 2), "must-not-install"))
        .toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("names another canonical database") }));
      expect(existsSync(other)).toBe(false);
      // Live at the other path: still this rollback's record for a different canonical, refused before any move.
      writeFileSync(other, readFileSync(original.preemptedPath), { mode: 0o600 });
      expect(() => install(homeDir, other, ATTEMPT(2, 2), "must-not-install")).toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("names another canonical database") }));
      expect(conversationTitles(other)).toEqual(["original-pre-rollback"]);
    });

    it("E19: an unfinished move whose preserved path is a symlink refuses without touching the link's target", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const preemptedPath = join(rollbackGenerationPath(homeDir, ATTEMPT(1)), "preempted-canonical.sqlite");
      crashAfterMoveAsideOf(homeDir, canonicalPath, preemptedPath, ATTEMPT(1), ROLLBACK);
      const victim = join(homeDir, "victim.sqlite");
      fsModule.renameSync(preemptedPath, victim);
      chmodSync(victim, 0o600);
      fsModule.symlinkSync(victim, preemptedPath);
      expect(() => install(homeDir, canonicalPath, ATTEMPT(1, 2), "must-not-install"))
        .toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("not a plain single-link regular file") }));
      expect(statSync(victim).mode & 0o777).toBe(0o600);
      expect(existsSync(canonicalPath)).toBe(false);
      expect(lastMove(homeDir, ROLLBACK).after).toBeNull();
    });

    it("E19: an unfinished move whose preserved file is hardlinked refuses before the chmod", () => {
      const homeDir = tempHome();
      const canonicalPath = liveCanonicalDatabase(homeDir, "original-pre-rollback");
      const preemptedPath = join(rollbackGenerationPath(homeDir, ATTEMPT(1)), "preempted-canonical.sqlite");
      crashAfterMoveAsideOf(homeDir, canonicalPath, preemptedPath, ATTEMPT(1), ROLLBACK);
      linkSync(preemptedPath, preemptedPath + ".link");
      expect(() => install(homeDir, canonicalPath, ATTEMPT(1, 2), "must-not-install"))
        .toThrow(expect.objectContaining({ reason: "unsafe-storage", message: expect.stringContaining("not a plain single-link regular file") }));
      expect(statSync(preemptedPath).mode & 0o777).toBe(0o600);
    });
  });


  it("refuses when the canonical path is a symlink rather than a plain regular file", async () => {
    const homeDir = tempHome();
    const realPath = liveCanonicalDatabase(homeDir, "real-target");
    const linkDir = join(homeDir, ".lcm", "projects", "proj-symlink");
    mkdirSync(linkDir, { recursive: true, mode: 0o700 });
    const canonicalPath = join(linkDir, "db.sqlite");
    fsModule.symlinkSync(realPath, canonicalPath);
    const generationDir = makeGenerationDir(homeDir, "gen-symlink-refused");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-symlink-refused", rollbackGenerationId: "gen-symlink-refused-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

  it("discovers a real, honest fact: SQLite's own checkpoint-then-DELETE step already removes a stray -wal file, so assertNoWalSiblings has nothing left to catch by the time it runs through this real code path", async () => {
    // Verified directly (not assumed): writing a stray -wal file, running
    // the exact PRAGMA wal_checkpoint(TRUNCATE) + journal_mode=DELETE
    // sequence this module runs, and observing the file is gone
    // afterward -- SQLite deletes any file at the -wal name for a
    // database it is switching to DELETE mode, real WAL frames or not.
    // This means a genuine post-checkpoint stray-WAL refusal has no known
    // real trigger through this exact code path; the guard's own wiring
    // is proven correct below instead, with a controlled fake, following
    // the same disciplined pattern (and the same reasoning for keeping a
    // defence-in-depth check that a different layer already happens to
    // close) as rollback-generation.ts's content-mismatch test.
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "clean-delete-mode-data");
    writeFileSync(`${canonicalPath}-wal`, "stray leftover, not a real WAL frame");
    expect(existsSync(`${canonicalPath}-wal`)).toBe(true);
    const generationDir = makeGenerationDir(homeDir, "gen-stray-wal");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-stray-wal", rollbackGenerationId: "gen-stray-wal-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    // Real, observed outcome: the stray file is gone and the install
    // proceeds normally, not a refusal.
    expect(outcome.preempted).not.toBeNull();
  });

  it("proves assertNoWalSiblings's own refusal is wired correctly via a controlled fake existsSync, since no real post-checkpoint trigger was found (see the test above)", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "clean-delete-mode-data-2");
    const generationDir = makeGenerationDir(homeDir, "gen-stray-wal-mocked");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const existsSpy = vi.spyOn(fsModule, "existsSync");
    // assertNoWalSiblings short-circuits on the first existsSync call
    // (the -wal check) via ||, so a single mocked "true" here is
    // sufficient and never reaches the -shm check at all.
    existsSpy.mockImplementationOnce(() => true);
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-stray-wal-mocked", rollbackGenerationId: "gen-stray-wal-mocked-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
    existsSpy.mockRestore();
  });

  it("RED-PROOF: refuses when the move-aside rename does not preserve bytes -- proven with a real content mutation immediately after a real rename, not a fixture that assumes agreement", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-mutation-data");
    const generationDir = makeGenerationDir(homeDir, "gen-move-corrupted");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    const preemptedPath = join(generationDir, "preempted-canonical.sqlite");
    renameSpy.mockImplementation((from, to) => {
      // Let the real rename happen, and once it is the exact call this
      // module makes to move the canonical file aside, simulate a race
      // that corrupts a byte immediately afterward, before this
      // function's own "after" witness ever reads the file.
      realRenameSync(from as string, to as string);
      if (to !== preemptedPath) return;
      const bytes = readFileSync(preemptedPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
      writeFileSync(preemptedPath, bytes);
    });
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-move-corrupted", rollbackGenerationId: "gen-move-corrupted-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
    renameSpy.mockRestore();
  });

  it("positive control for the red-proof above: an unmocked rename (identical code path, no corruption) installs cleanly", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "pre-mutation-data-control");
    const generationDir = makeGenerationDir(homeDir, "gen-move-control");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "installs-cleanly");
    const outcome = installRollbackGeneration({
      homeDir, generationId: "gen-move-control", rollbackGenerationId: "gen-move-control-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    });
    expect(outcome.preempted).not.toBeNull();
    expect(conversationTitles(canonicalPath)).toEqual(["installs-cleanly"]);
  });

  it("refuses to witness a hardlinked canonical file -- a second path can still reference the same inode after the rename", async () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "hardlinked-data");
    const secondLinkPath = join(homeDir, ".lcm", "projects", "proj-1", "db-hardlink.sqlite");
    linkSync(canonicalPath, secondLinkPath);
    expect(lstatSync(canonicalPath).nlink).toBe(2);
    const generationDir = makeGenerationDir(homeDir, "gen-hardlinked");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-hardlinked", rollbackGenerationId: "gen-hardlinked-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

  it("refuses when the canonical path exists but is not a regular file -- a directory, distinct from the symlink case above", async () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, ".lcm", "projects", "proj-dir", "db.sqlite");
    mkdirSync(canonicalPath, { recursive: true, mode: 0o700 });
    const generationDir = makeGenerationDir(homeDir, "gen-directory-refused");
    const verifiedPath = verifiedGenerationDatabase(generationDir, "should-not-install");
    expect(() => installRollbackGeneration({
      homeDir, generationId: "gen-directory-refused", rollbackGenerationId: "gen-directory-refused-rollback", canonicalPath, verifiedDatabasePath: verifiedPath,
    })).toThrow(RollbackInstallError);
  });

});

describe("checkCanonicalLiveExists", () => {
  // installRollbackGeneration's own precondition call, and also
  // getExistingLcmConnection's, both call the real node:fs lstatSync for
  // the same path in the same invocation, so mocking lstatSync through
  // the full installRollbackGeneration pipeline cannot deterministically
  // target "this function's own call" without depending on connection.ts's
  // internal call count. Testing the extracted, named function directly
  // avoids that fragility entirely.
  it("returns false for a positively observed ENOENT", () => {
    expect(checkCanonicalLiveExists("/nonexistent/path/that/should/not/exist/db.sqlite")).toBe(false);
  });

  it("re-throws a precondition-check failure that is not itself a missing-file case", () => {
    const homeDir = tempHome();
    const canonicalPath = liveCanonicalDatabase(homeDir, "eacces-data");
    const lstatSpy = vi.spyOn(fsModule, "lstatSync");
    lstatSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    });
    expect(() => checkCanonicalLiveExists(canonicalPath)).toThrow("simulated EACCES");
    lstatSpy.mockRestore();
  });

  it("refuses a path that exists, is not a symlink, but is also not a regular file", () => {
    const homeDir = tempHome();
    const canonicalPath = join(homeDir, "a-directory");
    mkdirSync(canonicalPath, { mode: 0o700 });
    expect(() => checkCanonicalLiveExists(canonicalPath)).toThrow(RollbackInstallError);
  });
});

describe("streamSha256", () => {
  it("hashes a real file's real bytes, matching an independently computed digest", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "hash-me.bin");
    const content = Buffer.from("deterministic content for a hash comparison");
    writeFileSync(path, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(streamSha256(path, content.byteLength)).toBe(expected);
  });

  it("refuses when the file has fewer bytes than the size it was witnessed at -- a real truncation, not a fixture", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "shrinks.bin");
    writeFileSync(path, Buffer.from("twenty bytes exactly"));
    // Ask for more bytes than the file actually has.
    expect(() => streamSha256(path, 1000)).toThrow(RollbackInstallError);
  });

  it("refuses when the file has grown past the size it was witnessed at -- distinct from the truncation case above", () => {
    const homeDir = tempHome();
    const path = join(homeDir, "grows.bin");
    const content = Buffer.from("this file is longer than the size argument");
    writeFileSync(path, content);
    // Ask for fewer bytes than the file actually has: the final
    // extra-byte probe finds more data than expected.
    expect(() => streamSha256(path, 4)).toThrow(RollbackInstallError);
  });
});

describe("checkpointAndConvertToDelete", () => {
  it("refuses when the journal mode does not report delete after the conversion -- proven with a controlled fake PRAGMA result, since SQLite's own conversion has no known real failure trigger through this code path", () => {
    // Why a mock, stated rather than hidden: PRAGMA journal_mode=DELETE
    // reliably succeeds for any database this function is given (proven
    // by every other test in this file, which all rely on it succeeding
    // for real). No real trigger for a post-PRAGMA "still not delete"
    // state was found. This guard is kept as defence in depth against a
    // future SQLite/driver change that could silently fail the
    // conversion, and is proven wired correctly with a fake result
    // rather than left uncovered or given a misleading "real"
    // reproduction it does not have.
    const homeDir = tempHome();
    const path = liveCanonicalDatabase(homeDir, "checkpoint-mock-data");
    const realPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    prepareSpy.mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      const statement = realPrepare.call(this, sql);
      if (sql === "PRAGMA journal_mode") {
        return { ...statement, get: () => ({ journal_mode: "wal" }) } as unknown as ReturnType<typeof realPrepare>;
      }
      return statement;
    });
    expect(() => checkpointAndConvertToDelete(path)).toThrow(RollbackInstallError);
    prepareSpy.mockRestore();
  });
});
