import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { clearGitProjectAnchorCache, resolveGitProjectAnchor } from "../src/git-project.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  listProjectMapEntries,
  projectMapPath,
} from "../src/project-map.js";
import {
  clearWorktreeReconciliationCache,
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

describe("worktree reconciliation", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-worktree-reconcile-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".lcm"), { recursive: true });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
  });

  afterEach(() => {
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
    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(join(home, ".lcm", "events", `${sourceHash}.db`))).toBe(false);
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
    db.close();

    const events = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(events.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 5 });
    expect(events.prepare("SELECT COUNT(*) AS count FROM error_log").get()).toEqual({ count: 3 });
    events.close();

    expect(listProjectMapEntries()).toEqual({
      [targetHash]: { canonical, aliases: [linked], remoteProjectId },
    });
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "completed",
      sourceHashes: [sourceHash],
    }]);
    const projectBackup = result.backupPaths.find((path) => path.includes("oldprojects"))!;
    const eventsBackup = result.backupPaths.find((path) => path.includes("oldevents"))!;
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
    expect(existsSync(join(home, ".lcm", "reconciliations", `${targetHash}.json`))).toBe(false);
  });

  it("reports no reconciliation work for a newly discovered Git project", () => {
    const { main } = makeRepository(home);
    expect(reconcileWorktrees(main)).toMatchObject({
      status: "not-needed",
      sourceHashes: [],
      aliases: [main],
    });
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

    expect(() => reconcileWorktrees(linked)).toThrow("no such table: error_log");
    const target = new DatabaseSync(targetEvents, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
    target.close();
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
});
