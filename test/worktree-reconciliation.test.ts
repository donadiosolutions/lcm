import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  closeLcmConnection,
  getPoolStats,
} from "../src/db/connection.js";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../src/git-project.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  projectMapPath,
  setRemoteProjectBinding,
} from "../src/project-map.js";
import {
  clearWorktreeReconciliationCache,
  ensureWorktreeProjectReconciled,
  listWorktreeReconciliationJournals,
  reconcileWorktrees,
} from "../src/worktree-reconciliation.js";
import { projectDbPath } from "../src/daemon/project.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepository(root: string): { main: string; linked: string } {
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "config", "user.email", "test@example.invalid");
  git(main, "config", "user.name", "LCM Test");
  git(main, "remote", "add", "origin", "https://example.invalid/lcm.git");
  writeFileSync(join(main, "README.md"), "test\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-qb", "linked", linked);
  return { main, linked };
}

function makeDatabase(path: string, sessionId: string, content: string, projectId: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  runLcmMigrations(db);
  db.prepare(
    `INSERT INTO conversations(
       session_id, title, bootstrapped_at, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?)`,
  ).run(sessionId, "title", "2026-01-01", "2026-01-01", "2026-01-02");
  const conversationId = Number(
    (db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?")
      .get(sessionId) as { conversation_id: number }).conversation_id,
  );
  db.prepare(
    `INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at)
     VALUES(?, 1, 'user', ?, 3, '2026-01-01')`,
  ).run(conversationId, content);
  const messageId = Number(
    (db.prepare("SELECT message_id FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { message_id: number }).message_id,
  );
  db.prepare(
    `INSERT INTO message_parts(
       part_id, message_id, session_id, part_type, ordinal, text_content
     ) VALUES(?, ?, ?, 'text', 0, ?)`,
  ).run(`part-${sessionId}`, messageId, sessionId, content);
  db.prepare(
    `INSERT INTO summaries(
       summary_id, conversation_id, kind, depth, content, token_count, created_at
     ) VALUES(?, ?, 'leaf', 0, ?, 2, '2026-01-02')`,
  ).run(`summary-${sessionId}`, conversationId, `summary ${content}`);
  db.prepare(
    `INSERT INTO summaries(
       summary_id, conversation_id, kind, depth, content, token_count, created_at
     ) VALUES(?, ?, 'condensed', 1, ?, 1, '2026-01-03')`,
  ).run(`summary-parent-${sessionId}`, conversationId, `parent ${content}`);
  db.prepare(
    "INSERT INTO summary_messages(summary_id, message_id, ordinal) VALUES(?, ?, 0)",
  ).run(`summary-${sessionId}`, messageId);
  db.prepare(
    "INSERT INTO summary_parents(summary_id, parent_summary_id, ordinal) VALUES(?, ?, 0)",
  ).run(`summary-${sessionId}`, `summary-parent-${sessionId}`);
  db.prepare(
    `INSERT INTO context_items(
       conversation_id, ordinal, item_type, message_id, summary_id, created_at
     ) VALUES(?, 0, 'message', ?, NULL, '2026-01-02')`,
  ).run(conversationId, messageId);
  db.prepare(
    `INSERT INTO context_items(
       conversation_id, ordinal, item_type, message_id, summary_id, created_at
     ) VALUES(?, 1, 'summary', NULL, ?, '2026-01-03')`,
  ).run(conversationId, `summary-${sessionId}`);
  db.prepare(
    `INSERT INTO large_files(
       file_id, conversation_id, file_name, mime_type, byte_size, storage_uri,
       exploration_summary, created_at
     ) VALUES(?, ?, 'file.txt', 'text/plain', 4, 'memory://file', 'seen', '2026-01-02')`,
  ).run(`file-${sessionId}`, conversationId);
  db.prepare(
    `INSERT INTO promoted(
       id, content, tags, source_summary_id, project_id, session_id, depth,
       confidence, created_at
     ) VALUES(?, ?, '["test"]', ?, ?, ?, 0, 1, '2026-01-02')`,
  ).run(`memory-${sessionId}`, `memory ${content}`, `summary-${sessionId}`, projectId, sessionId);
  db.prepare(
    "INSERT INTO redaction_stats(project_id, category, count) VALUES(?, 'built_in', 2)",
  ).run(projectId);
  db.prepare(
    `INSERT INTO session_instruction_cache(id, content, content_hash, updated_at)
     VALUES(?, ?, ?, '2026-01-02')`,
  ).run(
    1_000 + [...sessionId].reduce(
      (hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0,
      0,
    ),
    `instructions ${content}`,
    `hash-${sessionId}`,
  );
  db.prepare(
    `INSERT INTO session_ingest_log(session_id, completed_at, message_count)
     VALUES(?, '2026-01-02', 1)`,
  ).run(sessionId);
  db.prepare(
    `INSERT OR IGNORE INTO session_ingest_log(session_id, completed_at, message_count)
     VALUES('shared-ingest', '2026-01-02', 7)`,
  ).run();
  db.prepare(
    `INSERT INTO recall_surfacing(memory_id, session_id, surfaced_at)
     VALUES(?, ?, '2026-01-03')`,
  ).run(`memory-${sessionId}`, sessionId);
  db.prepare(
    `INSERT INTO recall_surfacing(memory_id, session_id, surfaced_at)
     VALUES('shared-memory', NULL, '2026-01-04')`,
  ).run();
  db.prepare("INSERT INTO messages_fts(rowid, content) VALUES(?, ?)").run(messageId, content);
  db.prepare(
    "INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, content, tags FROM promoted",
  ).run();
  runLcmMigrations(db);
  db.close();
}

function makeEvents(path: string, sessionId: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_version(version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(3);
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, category TEXT NOT NULL,
      data TEXT NOT NULL, priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL,
      prev_event_id INTEGER, processed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hook TEXT NOT NULL, error TEXT NOT NULL,
      session_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO events(
       session_id, seq, type, category, data, priority, source_hook, created_at
     ) VALUES(?, 1, 'decision', 'test', '{}', 1, 'PostToolUse', '2026-01-01')`,
  ).run(sessionId);
  db.prepare(
    `INSERT INTO error_log(hook, error, session_id, created_at)
     VALUES('hook', 'error', ?, '2026-01-02')`,
  ).run(sessionId);
  db.prepare(
    `INSERT INTO error_log(hook, error, session_id, created_at)
     VALUES('shared', 'same', NULL, '2026-01-03')`,
  ).run();
  db.prepare(
    `INSERT INTO events(
       session_id, seq, type, category, data, priority, source_hook,
       prev_event_id, created_at
     ) VALUES(?, 2, 'decision', 'test', '{"child":true}', 1, 'PostToolUse',
       1, '2026-01-02')`,
  ).run(sessionId);
  db.prepare(
    `INSERT INTO events(
       session_id, seq, type, category, data, priority, source_hook, created_at
     ) VALUES('shared', 1, 'decision', 'shared', '{}', 1, 'PostToolUse',
       '2026-01-03')`,
  ).run();
  db.close();
}

function makeEventsV1(path: string, sessionId: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_version(version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(1);
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, category TEXT NOT NULL,
      data TEXT NOT NULL, priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL,
      prev_event_id INTEGER, processed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO events(
       session_id, seq, type, category, data, priority, source_hook, created_at
     ) VALUES(?, 1, 'decision', 'legacy', '{}', 1, 'PostToolUse', '2026-01-01')`,
  ).run(sessionId);
  db.close();
}

describe("worktree reconciliation", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;

  beforeEach(() => {
    closeLcmConnection();
    home = mkdtempSync(join(tmpdir(), "lcm-worktree-reconcile-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".lcm"), { recursive: true });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
  });

  afterEach(() => {
    closeLcmConnection();
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("transactionally merges complete state, archives sources, and folds aliases", () => {
    const { linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(linked)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [], remoteProjectId },
      [sourceHash]: { canonical: linked, aliases: [], remoteProjectId },
    }, null, 2)}\n`);
    clearProjectMapCache();

    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(targetDir, "db.sqlite"), "main", "main content", targetHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "linked", "linked content", sourceHash);
    makeEvents(join(home, ".lcm", "events", `${targetHash}.db`), "main");
    makeEvents(join(home, ".lcm", "events", `${sourceHash}.db`), "linked");
    writeFileSync(join(targetDir, "sensitive-patterns.txt"), "MAIN_PATTERN\n");
    writeFileSync(join(sourceDir, "sensitive-patterns.txt"), "LINKED_PATTERN\n");

    const preview = reconcileWorktrees(linked, { dryRun: true });
    expect(preview).toMatchObject({
      status: "planned",
      targetHash,
      sourceHashes: [sourceHash],
    });
    expect(existsSync(join(home, ".lcm", "reconciliations", `${targetHash}.json`))).toBe(false);

    const result = reconcileWorktrees(linked, { now: new Date("2026-07-25T12:00:00Z") });
    expect(result.status).toBe("completed");
    expect(result.backupPaths).toHaveLength(3);
    expect(statSync(sourceDir).isFile()).toBe(true);
    expect(statSync(join(home, ".lcm", "events", `${sourceHash}.db`)).isDirectory()).toBe(true);
    expect(readdirSync(join(home, ".lcm", "oldprojects"))).toHaveLength(1);
    expect(readdirSync(join(home, ".lcm", "oldevents"))).toHaveLength(1);
    expect(readFileSync(join(targetDir, "sensitive-patterns.txt"), "utf8"))
      .toBe("MAIN_PATTERN\nLINKED_PATTERN\n");

    const db = new DatabaseSync(join(targetDir, "db.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages_fts").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM summaries_fts").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM promoted_fts").get()).toEqual({ count: 2 });
    expect(db.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = ? AND category = 'built_in'",
    ).get(targetHash)).toEqual({ count: 4 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();

    const events = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(events.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 5 });
    expect(events.prepare("SELECT COUNT(*) AS count FROM error_log").get()).toEqual({ count: 3 });
    expect(events.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    events.close();
    expect(getPoolStats()).toMatchObject({ totalConnections: 0 });

    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked], remoteProjectId },
    });
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "completed",
      sourceHashes: [sourceHash],
    }]);
    const projectBackup = result.backupPaths.find((path) => path.includes("oldprojects"))!;
    const eventsBackup = result.backupPaths.find((path) => path.includes("oldevents"))!;
    rmSync(sourceDir, { force: true });
    rmSync(join(home, ".lcm", "events", `${sourceHash}.db`), {
      recursive: true,
      force: true,
    });
    cpSync(projectBackup, sourceDir, { recursive: true });
    cpSync(eventsBackup, join(home, ".lcm", "events", `${sourceHash}.db`));
    const journalPath = join(home, ".lcm", "reconciliations", `${targetHash}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.phase = "planned";
    journal.backupPaths = [];
    writeFileSync(journalPath, JSON.stringify(journal));
    expect(reconcileWorktrees(linked, { now: new Date("2026-07-26T12:00:00Z") }).status)
      .toBe("completed");
    expect(reconcileWorktrees(linked).status).toBe("completed");
    const retried = new DatabaseSync(join(targetDir, "db.sqlite"), { readOnly: true });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM conversations").get())
      .toEqual({ count: 2 });
    retried.close();

    rmSync(sourceDir, { recursive: true, force: true });
    writeFileSync(
      sourceDir,
      `${JSON.stringify({ version: 1, hash: sourceHash, kind: "project" })}\n`,
    );
    const restoredEventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
    rmSync(restoredEventsPath, { recursive: true, force: true });
    mkdirSync(restoredEventsPath);
    writeFileSync(
      join(restoredEventsPath, "fence.json"),
      `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
    );
    const completedJournal = JSON.parse(readFileSync(journalPath, "utf8"));
    completedJournal.phase = "merged";
    completedJournal.pendingSourceHashes = [sourceHash];
    writeFileSync(journalPath, JSON.stringify(completedJournal));
    expect(reconcileWorktrees(linked).status).toBe("completed");
  });

  it("reconciles a late source generation exactly once after a completed generation", () => {
    const { main, linked: linkedA } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceAHash = hashProjectPath(linkedA);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceAHash]: { canonical: linkedA, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceADir = join(home, ".lcm", "projects", sourceAHash);
    makeDatabase(join(sourceADir, "db.sqlite"), "generation-a", "content a", sourceAHash);
    makeEvents(join(home, ".lcm", "events", `${sourceAHash}.db`), "generation-a");
    writeFileSync(join(sourceADir, "sensitive-patterns.txt"), "GENERATION_A\n");

    expect(reconcileWorktrees(main, {
      now: new Date("2026-07-25T12:00:00Z"),
    }).status).toBe("completed");

    const linkedB = join(home, "linked-b");
    git(main, "worktree", "add", "-qb", "linked-b", linkedB);
    const sourceBHash = hashProjectPath(linkedB);
    const targetEntry = listProjectMapEntries()[targetHash]!;
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: targetEntry,
      [sourceBHash]: { canonical: linkedB, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceBDir = join(home, ".lcm", "projects", sourceBHash);
    makeDatabase(join(sourceBDir, "db.sqlite"), "generation-b", "content b", sourceBHash);
    makeEvents(join(home, ".lcm", "events", `${sourceBHash}.db`), "generation-b");
    writeFileSync(join(sourceBDir, "sensitive-patterns.txt"), "GENERATION_B\n");

    let crashed = false;
    expect(() => reconcileWorktrees(main, {
      now: new Date("2026-07-26T12:00:00Z"),
      _observer: (event) => {
        if (!crashed && event === "after-merge-before-archive") {
          crashed = true;
          throw new Error("injected late-generation crash");
        }
      },
    })).toThrow("injected late-generation crash");
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "merged",
      sourceHashes: [sourceAHash, sourceBHash],
      pendingSourceHashes: [sourceBHash],
    }]);

    const result = reconcileWorktrees(main);
    expect(result.status).toBe("completed");
    expect(result.sourceHashes).toEqual([sourceAHash, sourceBHash]);
    expect(result.aliases).toEqual(expect.arrayContaining([canonical, linkedA, linkedB]));
    expect(result.backupPaths.filter((path) => path.includes("oldprojects"))).toHaveLength(2);
    expect(result.backupPaths.filter((path) => path.includes("oldevents"))).toHaveLength(2);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "completed",
      sourceHashes: [sourceAHash, sourceBHash],
      pendingSourceHashes: [],
    }]);
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const target = new DatabaseSync(join(targetDir, "db.sqlite"), { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM conversations").get()).toEqual({ count: 2 });
    expect(target.prepare(
      "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
    ).get()).toEqual({ count: 2 });
    expect(target.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = ? AND category = 'built_in'",
    ).get(targetHash)).toEqual({ count: 4 });
    target.close();
    const events = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(events.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 5 });
    expect(events.prepare(
      "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
    ).get()).toEqual({ count: 2 });
    events.close();
    expect(readFileSync(join(targetDir, "sensitive-patterns.txt"), "utf8"))
      .toBe("GENERATION_A\nGENERATION_B\n");
    expect(readdirSync(join(home, ".lcm", "oldprojects"))).toHaveLength(2);
    expect(readdirSync(join(home, ".lcm", "oldevents"))).toHaveLength(2);
  });

  it("keeps dry-run read-only while previewing legacy metadata backfill", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const mapPath = projectMapPath();
    writeFileSync(mapPath, `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "legacy-metadata", "content", sourceHash);
    writeFileSync(join(sourceDir, "meta.json"), JSON.stringify({ cwd: linked }));
    const mapBefore = readFileSync(mapPath, "utf8");

    expect(reconcileWorktrees(main, { dryRun: true })).toMatchObject({
      status: "planned",
      sourceHashes: [sourceHash],
    });
    expect(readFileSync(mapPath, "utf8")).toBe(mapBefore);
    expect(existsSync(join(home, ".lcm", "oldmaps"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "reconciliations"))).toBe(false);
    expect(existsSync(`${mapPath}.lock`)).toBe(false);

    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
    expect(existsSync(join(home, ".lcm", "oldmaps"))).toBe(true);
  });

  it("does not reconcile a separate clone merely because it owns an explicit alias", () => {
    const { main } = makeRepository(home);
    const clone = join(home, "separate-clone");
    execFileSync("git", ["clone", "-q", main, clone], { stdio: "ignore" });
    git(clone, "remote", "set-url", "origin", "https://example.invalid/lcm.git");
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const cloneCanonical = resolveGitProjectAnchor(clone)!.canonical;
    const cloneHash = hashProjectPath(cloneCanonical);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    const mapPath = projectMapPath();
    writeFileSync(mapPath, `${JSON.stringify({
      [cloneHash]: {
        canonical: cloneCanonical,
        aliases: [canonical],
        remoteProjectId,
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const cloneDbPath = join(home, ".lcm", "projects", cloneHash, "db.sqlite");
    makeDatabase(cloneDbPath, "explicit-clone-alias", "separate clone", cloneHash);
    const cloneStoreInode = statSync(cloneDbPath).ino;
    const mapBefore = readFileSync(mapPath, "utf8");

    expect(projectDbPath(main)).toBe(cloneDbPath);
    expect(readFileSync(mapPath, "utf8")).toBe(mapBefore);
    expect(statSync(cloneDbPath).ino).toBe(cloneStoreInode);
    expect(existsSync(join(home, ".lcm", "projects", targetHash))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(listProjectMapEntries()).toEqual({
      [cloneHash]: {
        canonical: cloneCanonical,
        aliases: [canonical],
        remoteProjectId,
      },
    });
    const cloneStore = new DatabaseSync(cloneDbPath, { readOnly: true });
    expect(cloneStore.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'explicit-clone-alias'",
    ).get()).toEqual({ session_id: "explicit-clone-alias" });
    cloneStore.close();
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      targetHash,
      phase: "completed",
      sourceHashes: [],
    }]);
    expect(listWorktreeReconciliationJournals()[0]).not.toHaveProperty("remoteProjectId");
  });

  it("blocks conflicting remote identities without changing state", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
      [sourceHash]: {
        canonical: linked,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      },
    }, null, 2)}\n`);
    clearProjectMapCache();

    expect(() => reconcileWorktrees(linked)).toThrow(
      "conflicting PostgreSQL project bindings",
    );
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "planned",
      pendingSourceHashes: [],
      reason: expect.stringContaining("conflicting PostgreSQL project bindings"),
    }]);

    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
      [sourceHash]: {
        canonical: linked,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(reconcileWorktrees(linked).status).toBe("completed");
  });

  it("reports no reconciliation work for a newly discovered Git project", () => {
    const { main } = makeRepository(home);
    expect(reconcileWorktrees(main)).toMatchObject({
      status: "not-needed",
      sourceHashes: [],
      aliases: [main],
      journalPath: join(
        home,
        ".lcm",
        "reconciliations",
        `${hashProjectPath(main)}.json`,
      ),
    });
    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    const targetHash = hashProjectPath(main);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical: main,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(reconcileWorktrees(main).status).toBe("not-needed");
  });

  it("rolls back and journals a divergent session collision", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "collision", "target", targetHash);
    makeDatabase(sourcePath, "collision", "source", sourceHash);

    expect(() => reconcileWorktrees(linked)).toThrow("divergent conversation collision");
    const target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM conversations").get()).toEqual({ count: 1 });
    expect(target.prepare("SELECT count FROM redaction_stats").get()).toEqual({ count: 2 });
    target.close();
    expect(existsSync(sourcePath)).toBe(true);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      reason: expect.stringContaining("divergent conversation collision"),
    }]);
    expect(reconcileWorktrees(linked, { dryRun: true }).status).toBe("blocked");

    rmSync(join(home, ".lcm", "projects", sourceHash), { recursive: true, force: true });
    makeDatabase(sourcePath, "recovered", "source", sourceHash);
    const blockedJournalPath = join(
      home,
      ".lcm",
      "reconciliations",
      `${targetHash}.json`,
    );
    const legacyBlocked = JSON.parse(readFileSync(blockedJournalPath, "utf8"));
    delete legacyBlocked.blockedFrom;
    writeFileSync(blockedJournalPath, JSON.stringify(legacyBlocked));
    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "completed",
    }]);
  });

  it("fails closed on divergent global bookkeeping identities", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "global-target", "target", targetHash);
    makeDatabase(sourcePath, "global-source", "source", sourceHash);
    const source = new DatabaseSync(sourcePath);
    source.prepare(
      "UPDATE session_ingest_log SET message_count = 8 WHERE session_id = 'shared-ingest'",
    ).run();
    source.close();

    expect(() => reconcileWorktrees(linked)).toThrow(
      "divergent session_ingest_log collision for shared-ingest",
    );
  });

  it("deduplicates a byte-equivalent conversation and its global identities", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "duplicate", "same", targetHash);
    makeDatabase(sourcePath, "duplicate", "same", sourceHash);

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM conversations").get())
      .toEqual({ count: 1 });
    expect(target.prepare("SELECT COUNT(*) AS count FROM promoted").get())
      .toEqual({ count: 1 });
    expect(target.prepare(
      "SELECT COUNT(*) AS count FROM recall_surfacing WHERE memory_id = 'shared-memory'",
    ).get()).toEqual({ count: 1 });
    target.close();
  });

  it("recovers a deleted Codex worktree from tombstone and session metadata", () => {
    const { main } = makeRepository(home);
    const codexDir = join(home, ".codex");
    const tokenDir = join(codexDir, "worktrees", "deadbeef");
    const deletedWorktree = join(tokenDir, "lcm");
    mkdirSync(tokenDir, { recursive: true });
    git(main, "worktree", "add", "-qb", "historical", deletedWorktree);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(deletedWorktree);
    const unrelated = join(home, "unrelated");
    mkdirSync(unrelated);
    const unrelatedHash = hashProjectPath(unrelated);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: deletedWorktree, aliases: [] },
      [unrelatedHash]: { canonical: unrelated, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "historical",
      "deleted worktree",
      sourceHash,
    );
    git(main, "worktree", "remove", "--force", deletedWorktree);
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "historical.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "historical",
        cwd: deletedWorktree,
        git: { repository_url: "https://example.invalid/lcm.git" },
      },
    })}\n`);
    writeFileSync(join(archived, "no-cwd.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: { id: "no-cwd", git: { repository_url: "https://example.invalid/lcm.git" } },
    })}\n`);
    writeFileSync(join(archived, "wrong-repository.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "wrong-repository",
        cwd: deletedWorktree,
        git: { repository_url: "https://example.invalid/other.git" },
      },
    })}\n`);
    writeFileSync(join(archived, "missing-tombstone.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "missing-tombstone",
        cwd: join(codexDir, "worktrees", "missing", "lcm"),
        git: { repository_url: "https://example.invalid/lcm.git" },
      },
    })}\n`);

    expect(reconcileWorktrees(main, { _codexDir: codexDir })).toMatchObject({
      status: "completed",
      sourceHashes: [sourceHash],
    });
    expect(listProjectMapEntries()[targetHash].aliases).toContain(deletedWorktree);
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'historical'",
    ).get()).toEqual({ session_id: "historical" });
    target.close();
  });

  it("does not certify a Codex catalogue generation that arrived during merge", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceAHash = hashProjectPath(linked);
    const codexDir = join(home, ".codex");
    const tokenDir = join(codexDir, "worktrees", "late-token");
    const deletedWorktree = join(tokenDir, "lcm");
    const sourceBHash = hashProjectPath(deletedWorktree);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceAHash]: { canonical: linked, aliases: [] },
      [sourceBHash]: { canonical: deletedWorktree, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceAHash, "db.sqlite"),
      "catalogue-generation-a",
      "generation a",
      sourceAHash,
    );
    makeDatabase(
      join(home, ".lcm", "projects", sourceBHash, "db.sqlite"),
      "catalogue-generation-b",
      "generation b",
      sourceBHash,
    );
    let introduced = false;
    const first = reconcileWorktrees(main, {
      _codexDir: codexDir,
      _observer: (event) => {
        if (introduced || event !== "after-merge-before-archive") return;
        introduced = true;
        mkdirSync(tokenDir, { recursive: true });
        const archived = join(codexDir, "archived_sessions");
        mkdirSync(archived, { recursive: true });
        writeFileSync(join(archived, "late.jsonl"), `${JSON.stringify({
          type: "session_meta",
          payload: {
            id: "late",
            cwd: deletedWorktree,
            git: { repository_url: "https://example.invalid/lcm.git" },
          },
        })}\n`);
      },
    });
    expect(first).toMatchObject({
      status: "completed",
      sourceHashes: [sourceAHash],
    });
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    let target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare(
      "SELECT session_id FROM conversations ORDER BY session_id",
    ).all()).toEqual([{ session_id: "catalogue-generation-a" }]);
    target.close();
    expect(listProjectMapEntries()).toHaveProperty(sourceBHash);

    const second = reconcileWorktrees(main, { _codexDir: codexDir });
    expect(second).toMatchObject({
      status: "completed",
      sourceHashes: [sourceAHash, sourceBHash],
    });
    const third = reconcileWorktrees(main, { _codexDir: codexDir });
    expect(third.sourceHashes).toEqual([sourceAHash, sourceBHash]);
    expect(third.backupPaths.filter((path) => path.includes("oldprojects"))).toHaveLength(2);
    target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare(
      "SELECT session_id FROM conversations ORDER BY session_id",
    ).all()).toEqual([
      { session_id: "catalogue-generation-a" },
      { session_id: "catalogue-generation-b" },
    ]);
    expect(target.prepare(
      "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
    ).get()).toEqual({ count: 2 });
    target.close();
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: {
        canonical,
        aliases: expect.arrayContaining([linked, deletedWorktree]),
      },
    });
  });

  it("runs automatically on first local project storage access", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "automatic",
      "first access",
      sourceHash,
    );

    expect(projectDbPath(linked))
      .toBe(join(home, ".lcm", "projects", targetHash, "db.sqlite"));
    expect(listWorktreeReconciliationJournals()).toMatchObject([{ phase: "completed" }]);
    expect(listProjectMapEntries()).not.toHaveProperty(sourceHash);
    expect(projectDbPath(linked))
      .toBe(join(home, ".lcm", "projects", targetHash, "db.sqlite"));
  });

  it("re-resolves storage paths after folding a legacy source-hash alias", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [canonical] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "legacy-alias",
      "legacy source hash",
      sourceHash,
    );

    const path = projectDbPath(linked);

    expect(path).toBe(join(home, ".lcm", "projects", targetHash, "db.sqlite"));
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
    const target = new DatabaseSync(path, { readOnly: true });
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'legacy-alias'",
    ).get()).toEqual({ session_id: "legacy-alias" });
    target.close();
  });

  it("merges equal instruction identities by newest timestamp and rejects divergent content", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "instruction-target", "target", targetHash);
    makeDatabase(sourcePath, "instruction-source", "source", sourceHash);
    const target = new DatabaseSync(targetPath);
    const source = new DatabaseSync(sourcePath);
    for (const db of [target, source]) {
      db.prepare(
        `INSERT INTO session_instruction_cache(id, content, content_hash, updated_at)
         VALUES(42, 'same', 'same-hash', ?)`,
      ).run(db === target ? "2026-01-01" : "2026-02-01");
      db.prepare(
        `INSERT INTO session_instruction_cache(id, content, content_hash, updated_at)
         VALUES(43, 'exact', 'exact-hash', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO session_instruction_cache(id, content, content_hash, updated_at)
         VALUES(44, 'older', 'older-hash', ?)`,
      ).run(db === target ? "2026-02-01" : "2026-01-01");
    }
    target.close();
    source.close();

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    const merged = new DatabaseSync(targetPath, { readOnly: true });
    expect(merged.prepare(
      "SELECT updated_at FROM session_instruction_cache WHERE id = 42",
    ).get()).toEqual({ updated_at: "2026-02-01" });
    expect(merged.prepare(
      "SELECT updated_at FROM session_instruction_cache WHERE id = 44",
    ).get()).toEqual({ updated_at: "2026-02-01" });
    merged.close();
  });

  it("fails closed on divergent instruction identities and invalid foreign keys", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "instruction-target", "target", targetHash);
    makeDatabase(sourcePath, "instruction-source", "source", sourceHash);
    const target = new DatabaseSync(targetPath);
    const source = new DatabaseSync(sourcePath);
    target.prepare(
      `INSERT INTO session_instruction_cache(id, content, content_hash)
       VALUES(42, 'target', 'target-hash')`,
    ).run();
    source.prepare(
      `INSERT INTO session_instruction_cache(id, content, content_hash)
       VALUES(42, 'source', 'source-hash')`,
    ).run();
    target.close();
    source.close();
    expect(() => reconcileWorktrees(linked)).toThrow(
      "divergent session_instruction_cache collision",
    );

    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    rmSync(sourceDir, { recursive: true, force: true });
    makeDatabase(sourcePath, "foreign-source", "source", sourceHash);
    const invalid = new DatabaseSync(targetPath);
    invalid.exec("PRAGMA foreign_keys = OFF");
    invalid.prepare(
      `INSERT INTO messages(conversation_id, seq, role, content, token_count)
       VALUES(999999, 999, 'user', 'invalid', 1)`,
    ).run();
    invalid.close();
    expect(() => reconcileWorktrees(linked)).toThrow("foreign-key verification failed");
  });

  it("rolls back a sidecar merge failure", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetEvents = join(home, ".lcm", "events", `${targetHash}.db`);
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(targetEvents, "target");
    makeEvents(sourceEvents, "source");
    const broken = new DatabaseSync(sourceEvents);
    broken.exec("DROP TABLE error_log");
    broken.close();

    expect(() => reconcileWorktrees(linked)).toThrow(
      "legacy events database schema 3 is missing error_log",
    );
    const target = new DatabaseSync(targetEvents, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
    target.close();
  });

  it("merges a valid events schema v1 sidecar without migrating the source", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEventsV1(sourceEvents, "legacy-v1");

    const result = reconcileWorktrees(main);
    expect(result.status).toBe("completed");
    const target = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(target.prepare("SELECT session_id FROM events").all())
      .toEqual([{ session_id: "legacy-v1" }]);
    expect(target.prepare("SELECT COUNT(*) AS count FROM error_log").get())
      .toEqual({ count: 0 });
    target.close();

    const sourceBackup = result.backupPaths.find((path) => path.includes("oldevents"))!;
    const evidence = new DatabaseSync(sourceBackup, { readOnly: true });
    expect(evidence.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
    expect(evidence.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'error_log'",
    ).get()).toBeUndefined();
    expect(evidence.prepare("SELECT session_id FROM events").all())
      .toEqual([{ session_id: "legacy-v1" }]);
    evidence.close();
  });

  it("fails closed instead of severing an unknown event predecessor", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetEvents = join(home, ".lcm", "events", `${targetHash}.db`);
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(targetEvents, "target");
    makeEvents(sourceEvents, "source");
    const source = new DatabaseSync(sourceEvents);
    source.prepare(
      `INSERT INTO events(
         session_id, seq, type, category, data, priority, source_hook,
         prev_event_id, created_at
       ) VALUES('source', 4, 'decision', 'orphan', '{}', 1, 'PostToolUse',
         999, '2026-01-04')`,
    ).run();
    source.close();

    expect(() => reconcileWorktrees(linked)).toThrow(
      "event 4 references unknown predecessor 999",
    );
    const target = new DatabaseSync(targetEvents, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
    target.close();
  });

  it("archives event WAL and SHM sidecars when resuming after a verified merge", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    mkdirSync(join(sourceEvents, ".."), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(`${sourceEvents}${suffix}`, suffix || "db");
    }
    const reconciliationRoot = join(home, ".lcm", "reconciliations");
    mkdirSync(reconciliationRoot, { recursive: true });
    writeFileSync(join(reconciliationRoot, `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "merged",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: false, eventsDb: true, patterns: false },
      },
    }));

    const result = reconcileWorktrees(main, { now: new Date("2026-07-25T12:00:00Z") });
    expect(result).toMatchObject({ status: "completed" });
    expect(result.backupPaths.filter((path) => path.includes("oldevents"))).toHaveLength(3);
    expect(readdirSync(join(home, ".lcm", "oldevents")).sort()).toEqual([
      expect.stringMatching(/\.db$/u),
      expect.stringMatching(/\.db-shm$/u),
      expect.stringMatching(/\.db-wal$/u),
    ]);
  });

  it("rejects symlink source state and malformed journals", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(home, "outside.db"), "not sqlite");
    symlinkSync(join(home, "outside.db"), join(sourceDir, "db.sqlite"));
    expect(() => reconcileWorktrees(linked)).toThrow("refusing to reconcile symlink");

    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    mkdirSync(join(home, ".lcm", "reconciliations"), { recursive: true });
    writeFileSync(
      join(home, ".lcm", "reconciliations", `${targetHash}.json`),
      "{}",
    );
    expect(() => reconcileWorktrees(linked)).toThrow("journal is malformed");
    writeFileSync(
      join(home, ".lcm", "reconciliations", `${targetHash}.json`),
      JSON.stringify({
        version: 1,
        targetHash,
        canonical: join(home, "different-project"),
        sourceHashes: [sourceHash],
        aliases: [linked],
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        phase: "planned",
        backupPaths: [],
      }),
    );
    expect(() => reconcileWorktrees(linked)).toThrow(
      "journal does not match the requested project",
    );
    writeFileSync(join(home, ".lcm", "reconciliations", "ignored.txt"), "{}");
    mkdirSync(join(home, ".lcm", "reconciliations", `${"f".repeat(64)}.json`));
    writeFileSync(
      join(home, ".lcm", "reconciliations", `${"e".repeat(64)}.json`),
      "{}",
    );
    expect(() => listWorktreeReconciliationJournals()).toThrow("journal is malformed");
  });

  it("merges an empty pattern file without database state", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "sensitive-patterns.txt"), "\n");

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    expect(readFileSync(
      join(home, ".lcm", "projects", targetHash, "sensitive-patterns.txt"),
      "utf8",
    )).toBe("");
  });

  it("creates a missing target pattern file from effective source patterns", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "sensitive-patterns.txt"),
      "# source heading\n  SOURCE_PATTERN  \n",
    );

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    expect(readFileSync(
      join(home, ".lcm", "projects", targetHash, "sensitive-patterns.txt"),
      "utf8",
    )).toBe("SOURCE_PATTERN\n");
  });

  it("preserves target pattern formatting and deduplicates effective patterns", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    const targetPath = join(targetDir, "sensitive-patterns.txt");
    writeFileSync(targetPath, "# target heading\n  DUPLICATE  ");
    writeFileSync(
      join(sourceDir, "sensitive-patterns.txt"),
      "# source heading\nDUPLICATE\n  NEW_PATTERN  \n\n",
    );

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    expect(readFileSync(targetPath, "utf8"))
      .toBe("# target heading\n  DUPLICATE  \nNEW_PATTERN\n");
  });

  it("does not rewrite a target pattern file when no effective pattern is added", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    const targetPath = join(targetDir, "sensitive-patterns.txt");
    writeFileSync(targetPath, "# keep formatting\n  SAME_PATTERN  \n");
    writeFileSync(
      join(sourceDir, "sensitive-patterns.txt"),
      "# ignored\nSAME_PATTERN\n\n",
    );
    const targetInode = statSync(targetPath).ino;

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
    expect(statSync(targetPath).ino).toBe(targetInode);
    expect(readFileSync(targetPath, "utf8")).toBe("# keep formatting\n  SAME_PATTERN  \n");
  });

  it("fails closed when an already-published map disagrees with an archived journal", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const root = join(home, ".lcm", "reconciliations");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "archived",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: false, eventsDb: false, patterns: false },
      },
    }));

    expect(() => reconcileWorktrees(main)).toThrow(
      "published worktree reconciliation map does not match",
    );
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
    }]);
  });

  it("rejects every malformed reconciliation journal field", () => {
    const root = join(home, ".lcm", "reconciliations");
    const path = join(root, `${"a".repeat(64)}.json`);
    expect(listWorktreeReconciliationJournals()).toEqual([]);
    mkdirSync(root, { recursive: true });
    const valid = {
      version: 1,
      targetHash: "a".repeat(64),
      canonical: "/project",
      sourceHashes: ["b".repeat(64)],
      aliases: ["/project"],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "completed",
      backupPaths: [],
    };
    const malformed = [
      { ...valid, version: 2 },
      { ...valid, targetHash: 42 },
      { ...valid, targetHash: "bad" },
      { ...valid, targetHash: "b".repeat(64) },
      { ...valid, canonical: 42 },
      { ...valid, canonical: "relative" },
      { ...valid, sourceHashes: "bad" },
      { ...valid, sourceHashes: [42] },
      { ...valid, sourceHashes: ["bad"] },
      { ...valid, sourceHashes: ["b".repeat(64), "b".repeat(64)] },
      { ...valid, sourceHashes: ["a".repeat(64)] },
      { ...valid, aliases: "bad" },
      { ...valid, aliases: [42] },
      { ...valid, aliases: ["relative"] },
      { ...valid, backupPaths: "bad" },
      { ...valid, backupPaths: [42] },
      { ...valid, backupPaths: ["relative"] },
      { ...valid, createdAt: 42 },
      { ...valid, updatedAt: 42 },
      { ...valid, remoteProjectId: 42 },
      { ...valid, remoteProjectId: "not-a-uuid" },
      { ...valid, reason: 42 },
      {
        ...valid,
        discovery: {
          mapFingerprint: "b".repeat(64),
          codexFingerprint: "c".repeat(64),
        },
      },
      {
        ...valid,
        discovery: {
          mapFingerprint: "b".repeat(64),
          codexFingerprint: "c".repeat(64),
          complete: "yes",
        },
      },
      { ...valid, phase: undefined },
      { ...valid, phase: "unknown" },
    ];
    for (const journal of malformed) {
      writeFileSync(path, JSON.stringify(journal));
      expect(() => listWorktreeReconciliationJournals()).toThrow("journal is malformed");
    }
    writeFileSync(path, "{");
    expect(() => listWorktreeReconciliationJournals()).toThrow(SyntaxError);
  });

  it("accepts a legacy empty database without optional bookkeeping tables", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    mkdirSync(join(sourcePath, ".."), { recursive: true });
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    source.close();

    expect(reconcileWorktrees(linked)).toMatchObject({ status: "completed" });
  });

  it("fences already-open legacy writers before archiving their database inodes", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "legacy-writer", "before fence", sourceHash);
    const legacyWriter = new DatabaseSync(sourcePath);
    let observed = false;

    const result = reconcileWorktrees(main, {
      _observer: (event) => {
        if (event !== "after-merge-before-archive") return;
        observed = true;
        expect(() => legacyWriter.prepare(
          `INSERT INTO session_ingest_log(session_id, completed_at, message_count)
           VALUES('late-write', '2026-01-03', 1)`,
        ).run()).toThrow("LCM source retired by worktree reconciliation");
      },
    });

    expect(observed).toBe(true);
    expect(result.status).toBe("completed");
    expect(() => legacyWriter.prepare(
      "UPDATE conversations SET title = 'late' WHERE session_id = 'legacy-writer'",
    ).run()).toThrow("LCM source retired by worktree reconciliation");
    legacyWriter.close();
    expect(statSync(join(home, ".lcm", "projects", sourceHash)).isFile()).toBe(true);
    expect(() => new DatabaseSync(sourcePath)).toThrow();
    const backup = result.backupPaths.find((path) => path.includes("oldprojects"))!;
    const evidence = new DatabaseSync(join(backup, "db.sqlite"), { readOnly: true });
    expect(evidence.prepare(
      "SELECT COUNT(*) AS count FROM session_ingest_log WHERE session_id = 'late-write'",
    ).get()).toEqual({ count: 0 });
    evidence.close();
  });

  it("commits the source fence before making the target marker durable", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "commit-order", "source", sourceHash);
    const legacyWriter = new DatabaseSync(sourcePath);
    let injected = false;

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event !== "after-source-fence-commit-before-target-commit" || injected) return;
        injected = true;
        expect(() => legacyWriter.prepare(
          "UPDATE conversations SET title = 'late' WHERE session_id = 'commit-order'",
        ).run()).toThrow("LCM source retired by worktree reconciliation");
        const target = new DatabaseSync(targetPath, { readOnly: true });
        expect(target.prepare(
          `SELECT COUNT(*) AS count FROM worktree_reconciliation_sources
             WHERE source_hash = ?`,
        ).get(sourceHash)).toEqual({ count: 0 });
        target.close();
        throw new Error("injected target commit boundary failure");
      },
    })).toThrow("injected target commit boundary failure");
    legacyWriter.close();

    const rolledBack = new DatabaseSync(targetPath, { readOnly: true });
    expect(rolledBack.prepare(
      "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources WHERE source_hash = ?",
    ).get(sourceHash)).toEqual({ count: 0 });
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM conversations").get())
      .toEqual({ count: 0 });
    rolledBack.close();

    expect(reconcileWorktrees(main).status).toBe("completed");
    const merged = new DatabaseSync(targetPath, { readOnly: true });
    expect(merged.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'commit-order'",
    ).get()).toEqual({ session_id: "commit-order" });
    merged.close();
  });

  it("fails closed while a legacy writer transaction is active and retries after quiescence", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "held-writer", "held", sourceHash);
    const held = new DatabaseSync(sourcePath);
    held.exec("BEGIN IMMEDIATE");
    held.prepare("UPDATE conversations SET title = 'uncommitted'").run();

    expect(() => reconcileWorktrees(main, { _sourceBusyTimeoutMs: 1 }))
      .toThrow(/database is locked/u);
    expect(statSync(join(home, ".lcm", "projects", sourceHash)).isDirectory()).toBe(true);
    held.exec("ROLLBACK");
    held.close();

    expect(reconcileWorktrees(main, { _sourceBusyTimeoutMs: 50 }).status).toBe("completed");
  });

  it.each([
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { label: "negative", value: -1 },
    { label: "fractional", value: 1.5 },
    { label: "zero", value: 0 },
    { label: "positive integer", value: 25 },
  ])("sanitizes a $label source busy timeout before applying SQLite PRAGMA", ({
    label,
    value,
  }) => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      `busy-timeout-${label}`,
      "content",
      sourceHash,
    );

    expect(reconcileWorktrees(main, {
      _sourceBusyTimeoutMs: value,
    }).status).toBe("completed");
  });

  it("rediscovers mapped sources after a completed no-op journal", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();

    expect(reconcileWorktrees(main).status).toBe("not-needed");
    expect(reconcileWorktrees(main).status).toBe("not-needed");
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "completed",
      sourceHashes: [],
      discovery: {
        mapFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        codexFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    }]);

    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "late-mapped",
      "late",
      sourceHash,
    );

    expect(reconcileWorktrees(main)).toMatchObject({
      status: "completed",
      sourceHashes: [sourceHash],
    });
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'late-mapped'",
    ).get()).toEqual({ session_id: "late-mapped" });
    target.close();
  });

  it("invalidates tombstone discovery without rescanning unchanged Codex history", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const deleted = join(home, ".codex", "worktrees", "late-token", "lcm");
    const sourceHash = hashProjectPath(deleted);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: deleted, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "late-tombstone",
      "late",
      sourceHash,
    );
    let scans = 0;
    const historical = () => {
      scans += 1;
      return existsSync(deleted)
        ? { hashes: [sourceHash, "f".repeat(64)], aliases: [deleted] }
        : { hashes: [], aliases: [] };
    };

    expect(reconcileWorktrees(main, {
      _codexDir: join(home, ".codex"),
      _historicalResolver: historical,
    }).status).toBe("not-needed");
    expect(scans).toBe(1);

    mkdirSync(deleted, { recursive: true });
    expect(reconcileWorktrees(main, {
      _codexDir: join(home, ".codex"),
      _historicalResolver: historical,
    }).status).toBe("completed");
    expect(scans).toBe(2);

    const lock = join(home, ".lcm", "reconciliations", `${targetHash}.lock`);
    writeFileSync(lock, "malformed lock that must remain unread\n");
    expect(reconcileWorktrees(main, {
      _codexDir: join(home, ".codex"),
      _historicalResolver: () => {
        throw new Error("unchanged discovery must not enumerate transcripts");
      },
    }).status).toBe("completed");
    expect(scans).toBe(2);
    rmSync(lock);
  });

  it("never reuses an incomplete catalogue fingerprint", () => {
    const { main } = makeRepository(home);
    const codexDir = join(home, ".codex");
    mkdirSync(join(codexDir, "worktrees"), { recursive: true });
    let scans = 0;
    const historical = () => {
      scans += 1;
      return { hashes: [], aliases: [] };
    };

    const first = reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
      _maxDiscoveryEntries: 1,
    });
    expect(first.status).toBe("not-needed");
    expect(listWorktreeReconciliationJournals()[0].discovery).toMatchObject({
      complete: false,
    });
    expect(reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
      _maxDiscoveryEntries: 1,
    }).status).toBe("not-needed");
    expect(scans).toBe(2);
  });

  it("does not invalidate discovery on transcript append but detects a remounted mapped path", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const remounted = join(home, "remounted-worktree");
    const sourceHash = hashProjectPath(remounted);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: remounted, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "remounted-source",
      "content",
      sourceHash,
    );
    const codexDir = join(home, ".codex");
    const sessions = join(codexDir, "sessions", "2026", "07", "25");
    mkdirSync(sessions, { recursive: true });
    const transcript = join(sessions, "session.jsonl");
    writeFileSync(transcript, "first\n");
    let scans = 0;
    const historical = () => {
      scans += 1;
      return { hashes: [], aliases: [] };
    };
    expect(reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
    }).status).toBe("not-needed");
    writeFileSync(transcript, "first\nsecond\n");
    expect(reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
    }).status).toBe("not-needed");
    expect(scans).toBe(1);

    git(main, "worktree", "add", "-qb", "remounted", remounted);
    expect(reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
    }).status).toBe("completed");
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'remounted-source'",
    ).get()).toEqual({ session_id: "remounted-source" });
    target.close();
  });

  it("uses one explicit home for the coordinated project-map lock and fold", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const alternateHome = join(home, "alternate-home");
    mkdirSync(join(alternateHome, ".lcm"), { recursive: true });
    writeFileSync(projectMapPath(alternateHome), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    makeDatabase(
      join(alternateHome, ".lcm", "projects", sourceHash, "db.sqlite"),
      "alternate-home",
      "source",
      sourceHash,
    );

    expect(reconcileWorktrees(main, { homeDir: alternateHome }).status).toBe("completed");
    expect(listProjectMapEntries(alternateHome)).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
    expect(existsSync(
      join(alternateHome, ".lcm", "projects", targetHash, "db.sqlite"),
    )).toBe(true);
  });

  it("merges without rebuilding FTS tables when the runtime lacks FTS5", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "without-fts",
      "content",
      sourceHash,
    );

    expect(reconcileWorktrees(main, { _fts5Available: false }).status).toBe("completed");
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'messages_fts'",
    ).get()).toBeUndefined();
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'without-fts'",
    ).get()).toEqual({ session_id: "without-fts" });
    target.close();
  });

  it("journals each archive rename and resumes from the failed phase", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "archive-crash",
      "content",
      sourceHash,
    );
    makeEvents(join(home, ".lcm", "events", `${sourceHash}.db`), "archive-crash");
    let failed = false;

    expect(() => reconcileWorktrees(main, {
      now: new Date("2026-07-25T12:00:00Z"),
      _observer: (event, _source, detailPath) => {
        if (
          !failed
          && event === "after-source-archive-rename"
          && detailPath?.includes("oldprojects")
        ) {
          failed = true;
          throw new Error("injected crash after project archive rename");
        }
      },
    })).toThrow("injected crash after project archive rename");
    const blocked = listWorktreeReconciliationJournals()[0];
    expect(blocked).toMatchObject({
      phase: "blocked",
      blockedFrom: "merged",
      backupPaths: [expect.stringContaining("oldprojects")],
    });
    expect(existsSync(blocked.backupPaths[0])).toBe(true);

    const result = reconcileWorktrees(main);
    expect(result.status).toBe("completed");
    expect(result.backupPaths.some((path) => path.includes("oldevents"))).toBe(true);
    expect(listWorktreeReconciliationJournals()[0].blockedFrom).toBeUndefined();
  });

  it("never archives a component that appeared after the merge snapshot", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "late-component",
      "content",
      sourceHash,
    );
    let failed = false;
    expect(() => reconcileWorktrees(main, {
      _observer: (event, _source, detailPath) => {
        if (
          !failed
          && event === "after-source-archive-rename"
          && detailPath?.includes("oldprojects")
        ) {
          failed = true;
          throw new Error("crash before absent events fence");
        }
      },
    })).toThrow("crash before absent events fence");

    const recreatedEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(recreatedEvents, "late-component-events");
    expect(() => reconcileWorktrees(main)).toThrow(
      "eventsDb component appeared after the reconciliation snapshot",
    );
    expect(existsSync(recreatedEvents)).toBe(true);
  });

  it("never archives patterns that changed after they were merged", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writeFileSync(sourcePatterns, "ORIGINAL_PATTERN\n");

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "after-merge-before-archive") {
          writeFileSync(sourcePatterns, "CHANGED_PATTERN\n");
        }
      },
    })).toThrow("patterns component changed after the reconciliation snapshot");

    expect(readFileSync(sourcePatterns, "utf8")).toBe("CHANGED_PATTERN\n");
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "merged",
      reason: expect.stringContaining("patterns component changed"),
    }]);
    expect(readFileSync(
      join(home, ".lcm", "projects", targetHash, "sensitive-patterns.txt"),
      "utf8",
    )).toBe("ORIGINAL_PATTERN\n");
  });

  it("verifies journaled patterns before writing them into the canonical project", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    const targetPatterns = join(targetDir, "sensitive-patterns.txt");
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writeFileSync(targetPatterns, "TARGET_PATTERN\n");
    writeFileSync(sourcePatterns, "ORIGINAL_PATTERN\n");
    let mutated = false;

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (!mutated && event === "before-source-patterns-merge") {
          mutated = true;
          writeFileSync(sourcePatterns, "CHANGED_PATTERN\n");
        }
      },
    })).toThrow("patterns component changed after the reconciliation snapshot");

    expect(readFileSync(targetPatterns, "utf8")).toBe("TARGET_PATTERN\n");
    expect(readFileSync(sourcePatterns, "utf8")).toBe("CHANGED_PATTERN\n");
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "planned",
      reason: expect.stringContaining("patterns component changed"),
    }]);

    writeFileSync(sourcePatterns, "ORIGINAL_PATTERN\n");
    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(readFileSync(targetPatterns, "utf8"))
      .toBe("TARGET_PATTERN\nORIGINAL_PATTERN\n");
    expect(readFileSync(targetPatterns, "utf8")).not.toContain("CHANGED_PATTERN");
  });

  it.each([
    {
      name: "appeared",
      initial: undefined,
      expectedError: "patterns component appeared after the reconciliation snapshot",
    },
    {
      name: "disappeared",
      initial: "ORIGINAL_PATTERN\n",
      expectedError: "source component disappeared before merge",
    },
  ])("fails before the canonical write when patterns $name after snapshot", ({
    initial,
    expectedError,
  }) => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    const targetPatterns = join(targetDir, "sensitive-patterns.txt");
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writeFileSync(targetPatterns, "TARGET_PATTERN\n");
    if (initial !== undefined) writeFileSync(sourcePatterns, initial);

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event !== "before-source-patterns-merge") return;
        if (initial === undefined) writeFileSync(sourcePatterns, "LATE_PATTERN\n");
        else rmSync(sourcePatterns);
      },
    })).toThrow(expectedError);

    expect(readFileSync(targetPatterns, "utf8")).toBe("TARGET_PATTERN\n");
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  });

  it("verifies journaled patterns again after archiving the source directory", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writeFileSync(sourcePatterns, "ORIGINAL_PATTERN\n");
    let mutated = false;

    expect(() => reconcileWorktrees(main, {
      now: new Date("2026-07-25T12:00:00Z"),
      _observer: (event, _source, detailPath) => {
        if (
          !mutated
          && event === "before-source-archive-rename"
          && detailPath?.includes("oldprojects")
        ) {
          mutated = true;
          writeFileSync(sourcePatterns, "LATE_PATTERN\n");
        }
      },
    })).toThrow("archived patterns component changed during worktree reconciliation");

    const journal = listWorktreeReconciliationJournals()[0];
    const projectBackup = journal.backupPaths.find((path) => path.includes("oldprojects"))!;
    expect(journal).toMatchObject({
      phase: "blocked",
      blockedFrom: "merged",
      backupPaths: [projectBackup],
      reason: expect.stringContaining("archived patterns component changed"),
    });
    expect(readFileSync(
      join(home, ".lcm", "projects", targetHash, "sensitive-patterns.txt"),
      "utf8",
    )).toBe("ORIGINAL_PATTERN\n");
    expect(readFileSync(join(projectBackup, "sensitive-patterns.txt"), "utf8"))
      .toBe("LATE_PATTERN\n");
    expect(statSync(sourceDir).isFile()).toBe(true);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    expect(() => reconcileWorktrees(main)).toThrow(
      "archived patterns component changed during worktree reconciliation",
    );
  });

  it.each([
    {
      name: "appeared",
      initial: undefined,
      expectedError: "patterns component appeared after the reconciliation snapshot",
    },
    {
      name: "disappeared",
      initial: "ORIGINAL_PATTERN\n",
      expectedError: "archived patterns component disappeared during worktree reconciliation",
    },
  ])("blocks when patterns $name during source retirement", ({
    initial,
    expectedError,
  }) => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    if (initial !== undefined) writeFileSync(sourcePatterns, initial);

    expect(() => reconcileWorktrees(main, {
      _observer: (event, _source, detailPath) => {
        if (
          event !== "before-source-archive-rename"
          || !detailPath?.includes("oldprojects")
        ) return;
        if (initial === undefined) writeFileSync(sourcePatterns, "LATE_PATTERN\n");
        else rmSync(sourcePatterns);
      },
    })).toThrow(expectedError);

    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "merged",
      reason: expect.stringContaining(expectedError),
    }]);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  });

  it("recovers a prepared events fence after a crash before marker publication", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "prepared-events-fence",
      "content",
      sourceHash,
    );
    let failed = false;
    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (!failed && event === "after-events-fence-directory-prepared") {
          failed = true;
          throw new Error("crash before prepared fence marker");
        }
      },
    })).toThrow("crash before prepared fence marker");

    const eventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
    const prepared = `${eventsPath}.lcm-fence-pending`;
    expect(existsSync(prepared)).toBe(true);
    expect(existsSync(join(prepared, "fence.json"))).toBe(false);
    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(statSync(eventsPath).isDirectory()).toBe(true);
    expect(existsSync(join(eventsPath, "fence.json"))).toBe(true);
  });

  it.each(["valid", "unreadable", "malformed", "unexpected-entry"])(
    "handles a %s prepared events fence marker",
    (markerState) => {
      const { main, linked } = makeRepository(home);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writeFileSync(projectMapPath(), `${JSON.stringify({
        [targetHash]: { canonical, aliases: [] },
        [sourceHash]: { canonical: linked, aliases: [] },
      }, null, 2)}\n`);
      clearProjectMapCache();
      makeDatabase(
        join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
        `prepared-events-${markerState}`,
        "content",
        sourceHash,
      );
      expect(() => reconcileWorktrees(main, {
        _observer: (event) => {
          if (event === "after-events-fence-directory-prepared") {
            throw new Error("crash before prepared fence marker");
          }
        },
      })).toThrow("crash before prepared fence marker");
      const prepared = join(
        home,
        ".lcm",
        "events",
        `${sourceHash}.db.lcm-fence-pending`,
      );
      if (markerState === "valid") {
        writeFileSync(
          join(prepared, "fence.json"),
          `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
        );
      } else if (markerState === "unreadable") {
        mkdirSync(join(prepared, "fence.json"));
      } else if (markerState === "malformed") {
        writeFileSync(join(prepared, "fence.json"), "{");
      } else {
        writeFileSync(join(prepared, "unexpected"), "unexpected");
      }

      if (markerState === "valid") {
        expect(reconcileWorktrees(main).status).toBe("completed");
      } else {
        expect(() => reconcileWorktrees(main)).toThrow("invalid prepared events fence");
        expect(listProjectMapEntries()).toHaveProperty(sourceHash);
      }
    },
  );

  it("journals the map backup before publishing the folded project map", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "map-publication-crash",
      "content",
      sourceHash,
    );
    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "after-project-map-published") {
          throw new Error("crash after map publication");
        }
      },
    })).toThrow("crash after map publication");

    const journal = listWorktreeReconciliationJournals()[0];
    const mapBackup = journal.backupPaths.find((path) => path.includes("oldmaps"));
    expect(mapBackup).toBeDefined();
    expect(existsSync(mapBackup!)).toBe(true);
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked] },
    });
    expect(reconcileWorktrees(main).status).toBe("completed");
  });

  it("waits for a competing first-use reconciliation and then re-reads state", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "lock-wait",
      "content",
      sourceHash,
    );
    const lock = join(home, ".lcm", "reconciliations", `${targetHash}.lock`);
    mkdirSync(join(lock, ".."), { recursive: true });
    const holder = spawn(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        const lock = process.argv[1];
        const fields = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8")
          .slice(fs.readFileSync("/proc/" + process.pid + "/stat", "utf8").lastIndexOf(")") + 2)
          .split(" ");
        fs.writeFileSync(lock, JSON.stringify({
          version: 1,
          pid: process.pid,
          processStartTime: fields[19] || null,
          nonce: "a".repeat(32),
          createdAtMs: Date.now()
        }) + "\\n", { mode: 0o600 });
        setTimeout(() => fs.unlinkSync(lock), 150);
      `,
      lock,
    ], { stdio: "ignore" });
    const waitDeadline = Date.now() + 2_000;
    while (!existsSync(lock) && Date.now() < waitDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    expect(existsSync(lock)).toBe(true);

    expect(reconcileWorktrees(main, {
      _lockWaitMs: 2_000,
      _lockRetryDelayMs: 10,
    }).status).toBe("completed");
    expect(holder.exitCode === 0 || holder.exitCode === null).toBe(true);
  });

  it("holds the project-map mutation fence from preflight through publication", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "binding-race", "content", sourceHash);

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event !== "after-map-preflight") return;
        expect(() => setRemoteProjectBinding(
          "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
          { hash: targetHash },
        )).toThrow("project map mutation is already in progress");
        throw new Error("abort after verified map fence");
      },
    })).toThrow("abort after verified map fence");
    expect(existsSync(sourcePath)).toBe(true);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  });

  it("handles bounded catalogue entries, non-Git paths, and catalogue failures", () => {
    const nonGit = join(home, "not-git");
    mkdirSync(nonGit);
    expect(reconcileWorktrees(nonGit)).toMatchObject({
      status: "not-needed",
      canonical: nonGit,
    });
    expect(projectDbPath(nonGit)).toBe(
      join(home, ".lcm", "projects", hashProjectPath(nonGit), "db.sqlite"),
    );

    const { main } = makeRepository(home);
    const codexDir = join(home, ".codex");
    const worktrees = join(codexDir, "worktrees");
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(worktrees, "plain"), "plain");
    symlinkSync(join(worktrees, "plain"), join(worktrees, "link"));
    mkdirSync(join(worktrees, "one", "two", "three"), { recursive: true });
    symlinkSync(join(worktrees, "plain"), join(codexDir, "sessions"));
    writeFileSync(join(codexDir, "archived_sessions"), "plain");
    expect(reconcileWorktrees(main, {
      dryRun: true,
      _codexDir: codexDir,
      _historicalResolver: () => ({ hashes: [], aliases: [] }),
      _maxDiscoveryEntries: 1,
    }).status).toBe("not-needed");
    expect(reconcileWorktrees(main, {
      dryRun: true,
      _codexDir: codexDir,
      _historicalResolver: () => ({ hashes: [], aliases: [] }),
      _maxDiscoveryEntries: 100,
    }).status).toBe("not-needed");
    const failure = Object.assign(new Error("catalogue unavailable"), { code: "EACCES" });
    expect(() => reconcileWorktrees(main, {
      dryRun: true,
      _codexDir: codexDir,
      _discoveryObserver: (path) => {
        if (path.endsWith("worktrees")) throw failure;
      },
    })).toThrow("catalogue unavailable");
  });

  it("propagates unexpected map-path metadata failures", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const regularFile = join(home, "regular-file");
    writeFileSync(regularFile, "not a directory");
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [join(regularFile, "child")] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main, { dryRun: true })).toThrow("ENOTDIR");
  });

  it("fingerprints symlink, file, and missing project-map paths", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const file = join(home, "map-file");
    const link = join(home, "map-link");
    writeFileSync(file, "file");
    symlinkSync(file, link);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical,
        aliases: [file, link, join(home, "missing-map-path")],
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(reconcileWorktrees(main, { dryRun: true }).status).toBe("not-needed");
  });

  it("bounds catalogue cache freshness and invalidates on state, identity, and clear", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const identity = { id: targetHash, canonical };
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const codexDir = join(home, ".codex");
    let catalogueWalks = 0;
    const discoveryObserver = (path: string) => {
      if (path === join(codexDir, "worktrees")) catalogueWalks += 1;
    };
    const first = ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 0,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    });
    expect(first.status).toBe("not-needed");
    const afterFirst = catalogueWalks;
    expect(afterFirst).toBeGreaterThan(0);

    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 100,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("completed");
    expect(catalogueWalks).toBe(afterFirst);

    const journalPath = first.journalPath!;
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.updatedAt = "2026-07-26T00:00:00.000Z";
    writeFileSync(journalPath, JSON.stringify(journal));
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 200,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    const afterJournalChange = catalogueWalks;
    expect(afterJournalChange).toBeGreaterThan(afterFirst);

    const journalBeforeGuardRace = readFileSync(journalPath, "utf8");
    let removedJournalDuringWalk = false;
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 1_200,
      _codexDir: codexDir,
      _discoveryObserver: (path) => {
        discoveryObserver(path);
        if (
          !removedJournalDuringWalk
          && path === join(codexDir, "worktrees")
        ) {
          removedJournalDuringWalk = true;
          rmSync(journalPath);
        }
      },
    }).status).toBe("completed");
    expect(existsSync(journalPath)).toBe(false);
    writeFileSync(journalPath, journalBeforeGuardRace);
    const afterExpiration = catalogueWalks;
    expect(afterExpiration).toBeGreaterThan(afterJournalChange);
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 1_201,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    const afterGuardRecovery = catalogueWalks;
    expect(afterGuardRecovery).toBeGreaterThan(afterExpiration);
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 2_201,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("completed");
    const afterStableExpiration = catalogueWalks;
    expect(afterStableExpiration).toBeGreaterThan(afterGuardRecovery);

    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [linked] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 2_202,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    const afterMapChange = catalogueWalks;
    expect(afterMapChange).toBeGreaterThan(afterStableExpiration);

    expect(ensureWorktreeProjectReconciled(main, {
      id: targetHash,
      canonical: linked,
    }, {
      _cacheTtlMs: 1_000,
      _nowMs: 2_203,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    const afterIdentityChange = catalogueWalks;
    expect(afterIdentityChange).toBeGreaterThan(afterMapChange);

    clearWorktreeReconciliationCache();
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 2_204,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    expect(catalogueWalks).toBeGreaterThan(afterIdentityChange);
  });

  it("observes a late Codex generation after the bounded cache lifetime", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const identity = { id: targetHash, canonical };
    const codexDir = join(home, ".codex");
    const tokenDir = join(codexDir, "worktrees", "cache-late-token");
    const deletedWorktree = join(tokenDir, "lcm");
    const sourceHash = hashProjectPath(deletedWorktree);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: deletedWorktree, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "cache-late-generation",
      "late generation",
      sourceHash,
    );
    let catalogueWalks = 0;
    const discoveryObserver = (path: string) => {
      if (path === join(codexDir, "worktrees")) catalogueWalks += 1;
    };
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 0,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("not-needed");
    const afterInitial = catalogueWalks;
    mkdirSync(tokenDir, { recursive: true });
    const archived = join(codexDir, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "cache-late.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "cache-late",
        cwd: deletedWorktree,
        git: { repository_url: "https://example.invalid/lcm.git" },
      },
    })}\n`);

    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 999,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("completed");
    expect(catalogueWalks).toBe(afterInitial);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);

    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 1_000,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    })).toMatchObject({
      status: "completed",
      sourceHashes: [sourceHash],
    });
    const afterLateGeneration = catalogueWalks;
    expect(afterLateGeneration).toBeGreaterThan(afterInitial);
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 1_000,
      _nowMs: 1_001,
      _codexDir: codexDir,
      _discoveryObserver: discoveryObserver,
    }).status).toBe("completed");
    expect(catalogueWalks).toBe(afterLateGeneration);
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
    ).get()).toEqual({ count: 1 });
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'cache-late-generation'",
    ).get()).toEqual({ session_id: "cache-late-generation" });
    target.close();
  });

  it("does not cache first-use reconciliation while the Codex catalogue is incomplete", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const identity = { id: hashProjectPath(canonical), canonical };
    const worktrees = join(home, ".codex", "worktrees");
    mkdirSync(worktrees, { recursive: true });
    for (let index = 0; index < 50_000; index += 1) {
      mkdirSync(join(worktrees, `entry-${index}`));
    }
    expect(ensureWorktreeProjectReconciled(main, identity).status).toBe("not-needed");
    expect(ensureWorktreeProjectReconciled(main, identity).status).toBe("not-needed");
  }, 15_000);

  it("re-fences source stores when target merge markers already exist", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "marker-target", "target", targetHash);
    makeDatabase(sourcePath, "marker-source", "source", sourceHash);
    const target = new DatabaseSync(targetPath);
    target.exec(`
      CREATE TABLE worktree_reconciliation_sources (
        source_hash TEXT PRIMARY KEY,
        merged_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    target.prepare(
      "INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)",
    ).run(sourceHash);
    target.close();
    const targetEvents = join(home, ".lcm", "events", `${targetHash}.db`);
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(targetEvents, "marker-target");
    makeEvents(sourceEvents, "marker-source");
    const events = new DatabaseSync(targetEvents);
    events.exec(`
      CREATE TABLE worktree_reconciliation_sources (
        source_hash TEXT PRIMARY KEY,
        merged_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    events.prepare(
      "INSERT INTO worktree_reconciliation_sources(source_hash) VALUES(?)",
    ).run(sourceHash);
    events.close();

    expect(reconcileWorktrees(main).status).toBe("completed");
    const merged = new DatabaseSync(targetPath, { readOnly: true });
    expect(merged.prepare("SELECT COUNT(*) AS count FROM conversations").get())
      .toEqual({ count: 1 });
    merged.close();
  });

  it("fails closed when a planned source disappears or its binding changes", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    const root = join(home, ".lcm", "reconciliations");
    mkdirSync(root, { recursive: true });
    const baseJournal = {
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "planned",
      backupPaths: [],
    };
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    writeFileSync(join(root, `${targetHash}.json`), JSON.stringify(baseJournal));
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main)).toThrow("source disappeared before merge");

    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [], remoteProjectId },
      [sourceHash]: { canonical: linked, aliases: [], remoteProjectId },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main)).toThrow(
      "PostgreSQL project binding changed during worktree reconciliation",
    );
  });

  it("refreshes the reason when a blocked preflight retry encounters a new failure", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const root = join(home, ".lcm", "reconciliations");
    mkdirSync(root, { recursive: true });
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    writeFileSync(join(root, `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [],
      pendingSourceHashes: [],
      aliases: [canonical],
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "blocked",
      blockedFrom: "planned",
      reason: "old failure",
      backupPaths: [],
    }));
    clearProjectMapCache();

    expect(() => reconcileWorktrees(main)).toThrow(
      "PostgreSQL project binding changed during worktree reconciliation",
    );
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "planned",
      reason: expect.stringContaining("PostgreSQL project binding changed"),
    }]);
  });

  it("journals a discovery failure without a project-map target entry", () => {
    const { main } = makeRepository(home);
    expect(() => reconcileWorktrees(main, {
      _discoveryObserver: () => {
        throw new Error("catalogue failure");
      },
    })).toThrow("catalogue failure");
    expect(listWorktreeReconciliationJournals()[0]).toMatchObject({ phase: "blocked" });
  });

  it("fails closed if a source vanishes after discovery or a retired path is recreated", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "disappearing", "content", sourceHash);
    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "before-source-main-merge") {
          rmSync(sourceDir, { recursive: true, force: true });
        }
      },
    })).toThrow("worktree reconciliation source disappeared");

    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    makeDatabase(join(sourceDir, "db.sqlite"), "recreated", "content", sourceHash);
    expect(() => reconcileWorktrees(main, {
      _observer: (event, source) => {
        if (event === "before-project-path-fence") {
          writeFileSync(source!.projectDir, "raced");
        }
      },
    })).toThrow("legacy project path was recreated");

    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
    makeDatabase(join(sourceDir, "db.sqlite"), "events-recreated", "content", sourceHash);
    expect(() => reconcileWorktrees(main, {
      _observer: (event, source) => {
        if (event === "before-events-path-fence") {
          mkdirSync(source!.eventsPath, { recursive: true });
        }
      },
    })).toThrow("legacy events path was recreated");
  });

  it("validates journal component snapshots before merging", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    const root = join(home, ".lcm", "reconciliations");
    mkdirSync(root, { recursive: true });
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    makeDatabase(join(sourceDir, "db.sqlite"), "snapshot", "content", sourceHash);
    const journalPath = join(root, `${targetHash}.json`);
    const base = {
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      pendingSourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "merged",
      backupPaths: [],
      sourceComponents: {},
    };
    writeFileSync(journalPath, JSON.stringify(base));
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main)).toThrow("lacks a component snapshot");

    writeFileSync(join(sourceDir, "sensitive-patterns.txt"), "PATTERN\n");
    writeFileSync(journalPath, JSON.stringify({
      ...base,
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: true } },
    }));
    expect(() => reconcileWorktrees(main)).toThrow("lacks a patterns digest");

    rmSync(join(sourceDir, "db.sqlite"));
    rmSync(join(sourceDir, "sensitive-patterns.txt"));
    writeFileSync(journalPath, JSON.stringify({
      ...base,
      phase: "planned",
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: false } },
    }));
    expect(() => reconcileWorktrees(main)).toThrow("component disappeared before merge");

    makeDatabase(join(sourceDir, "db.sqlite"), "snapshot", "content", sourceHash);
    writeFileSync(join(sourceDir, "sensitive-patterns.txt"), "PATTERN\n");
    writeFileSync(journalPath, JSON.stringify({
      ...base,
      phase: "planned",
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: true } },
    }));
    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(listWorktreeReconciliationJournals()[0].sourceComponents?.[sourceHash])
      .toMatchObject({ patternsDigest: expect.any(String) });
  });

  it("accepts complete planned component snapshots before merging", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "merged-snapshot", "content", sourceHash);
    makeEvents(join(home, ".lcm", "events", `${sourceHash}.db`), "merged-snapshot");
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    mkdirSync(join(home, ".lcm", "reconciliations"), { recursive: true });
    writeFileSync(join(home, ".lcm", "reconciliations", `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      pendingSourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "planned",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: true, eventsDb: true, patterns: false },
      },
    }));
    clearProjectMapCache();
    expect(reconcileWorktrees(main).status).toBe("completed");
  });

  it("rejects invalid retired project and events fence paths on archive resume", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writeFileSync(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const root = join(home, ".lcm", "reconciliations");
    mkdirSync(root, { recursive: true });
    const journalPath = join(root, `${targetHash}.json`);
    const journal = {
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      archiveAt: "2026-07-25T12:00:00.000Z",
      phase: "merged",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: false, eventsDb: false, patterns: false },
      },
    };
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    mkdirSync(join(sourceDir, ".."), { recursive: true });
    writeFileSync(sourceDir, "invalid project fence");
    writeFileSync(journalPath, JSON.stringify(journal));
    expect(() => reconcileWorktrees(main)).toThrow("invalid legacy project state path");

    rmSync(sourceDir, { force: true });
    const eventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
    for (const markerState of ["missing", "unreadable", "malformed"]) {
      rmSync(eventsPath, { recursive: true, force: true });
      mkdirSync(eventsPath, { recursive: true });
      if (markerState === "unreadable") {
        mkdirSync(join(eventsPath, "fence.json"));
      } else if (markerState === "malformed") {
        writeFileSync(join(eventsPath, "fence.json"), "{");
      }
      writeFileSync(journalPath, JSON.stringify(journal));
      expect(() => reconcileWorktrees(main)).toThrow("invalid legacy events state path");
    }
  });

  it("rejects retired paths recreated between archival and fence publication", () => {
    const setup = (suffix: string) => {
      const root = join(home, suffix);
      mkdirSync(root);
      const { main, linked } = makeRepository(root);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writeFileSync(projectMapPath(), `${JSON.stringify({
        [targetHash]: { canonical, aliases: [] },
        [sourceHash]: { canonical: linked, aliases: [] },
      }, null, 2)}\n`);
      clearProjectMapCache();
      const sourceDir = join(home, ".lcm", "projects", sourceHash);
      const eventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
      makeDatabase(join(sourceDir, "db.sqlite"), `race-${suffix}`, "content", sourceHash);
      return { main, sourceDir, eventsPath };
    };

    const projectRace = setup("project-path-race");
    makeEvents(projectRace.eventsPath, "project-path-race");
    expect(() => reconcileWorktrees(projectRace.main, {
      _observer: (event, source, detailPath) => {
        if (event === "after-source-archive-rename" && detailPath?.includes("oldevents")) {
          writeFileSync(source!.projectDir, "recreated after archive");
        }
      },
    })).toThrow("legacy project path remained writable");

    rmSync(join(home, ".lcm"), { recursive: true, force: true });
    mkdirSync(join(home, ".lcm"), { recursive: true });
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    const eventsRace = setup("events-path-race");
    expect(() => reconcileWorktrees(eventsRace.main, {
      _observer: (event, source) => {
        if (event === "before-project-path-fence") {
          mkdirSync(source!.eventsPath, { recursive: true });
          writeFileSync(join(source!.eventsPath, "fence.json"), "recreated after archive");
        }
      },
    })).toThrow("legacy events path remained writable");
  });
});
