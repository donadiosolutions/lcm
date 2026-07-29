import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

const databases: DatabaseSync[] = [];
const tempDirs: string[] = [];

const LEGACY_CACHE_FIXTURE_SQL = `
  CREATE TABLE session_instruction_cache (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO session_instruction_cache
    (id, content, content_hash, updated_at)
  VALUES (1, 'private legacy cache', 'legacy-hash', '2026-07-29 00:00:00');
`;

const LEGACY_SOURCE_FIXTURE_SQL = `
  CREATE TABLE session_instructions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO session_instructions
    (id, content, content_hash, updated_at)
  VALUES (1, 'private legacy source', 'source-hash', '2026-07-29 00:00:00');
`;

const CURRENT_CACHE_FIXTURE_SQL = `
  CREATE TABLE session_instruction_cache (
    project_id TEXT NOT NULL,
    scope_hash TEXT NOT NULL CHECK (
      length(scope_hash) = 64
      AND scope_hash NOT GLOB '*[^a-f0-9]*'
    ),
    client_name TEXT NOT NULL CHECK (client_name IN ('claude', 'codex')),
    session_id TEXT NOT NULL CHECK (session_id <> ''),
    worktree_path TEXT NOT NULL CHECK (worktree_path <> ''),
    cwd_path TEXT NOT NULL CHECK (cwd_path <> ''),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, scope_hash)
  );
  INSERT INTO session_instruction_cache (
    project_id, scope_hash, client_name, session_id, worktree_path,
    cwd_path, content, content_hash, updated_at
  ) VALUES (
    'project', '${"a".repeat(64)}', 'codex', 'session', '/repo', '/repo/src',
    'private current cache', 'current-hash', '2026-07-29 00:00:00'
  );
`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function createLegacyTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_instruction_cache (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO session_instruction_cache
      (id, content, content_hash, updated_at)
    VALUES (1, 'cache secret', 'cache-hash', '2026-07-29 00:00:00');

    CREATE TABLE session_instructions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO session_instructions
      (id, content, content_hash, updated_at)
    VALUES (1, 'legacy secret', 'legacy-hash', '2026-07-28 00:00:00');
  `);
}

function schemaSnapshot(db: DatabaseSync): unknown[] {
  return db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
  ).all();
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("instruction-cache migration", () => {
  it("discards both process-global legacy caches and creates the fully scoped schema", () => {
    const db = database();
    createLegacyTables(db);

    runLcmMigrations(db, { fts5Available: false });

    expect(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'session_instructions'",
    ).get()).toBeUndefined();
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM session_instruction_cache",
    ).get()).toEqual({ count: 0 });
    const definition = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE name = 'session_instruction_cache'",
    ).get() as { sql: string };
    expect(definition.sql).toContain("PRIMARY KEY (project_id, scope_hash)");
    expect(definition.sql).toContain("client_name IN ('claude', 'codex')");
    expect(definition.sql).toContain("session_id <> ''");
    expect(definition.sql).toContain("worktree_path <> ''");
    expect(definition.sql).toContain("cwd_path <> ''");
    expect(db.prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE tbl_name = 'session_instruction_cache'
           AND name <> 'session_instruction_cache'
         ORDER BY type, name`,
    ).all()).toEqual([{
      type: "index",
      name: "sqlite_autoindex_session_instruction_cache_1",
      tbl_name: "session_instruction_cache",
      sql: null,
    }]);
  });

  it("accepts the oldest source-only schema and discards its unscoped row", () => {
    const db = database();
    db.exec(LEGACY_SOURCE_FIXTURE_SQL);

    runLcmMigrations(db, { fts5Available: false });

    expect(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'session_instructions'",
    ).get()).toBeUndefined();
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM session_instruction_cache",
    ).get()).toEqual({ count: 0 });
  });

  it("retains exact current rows and is idempotent", () => {
    const db = database();
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(
      `INSERT INTO session_instruction_cache (
         project_id, scope_hash, client_name, session_id, worktree_path,
         cwd_path, content, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "project",
      "a".repeat(64),
      "codex",
      "session",
      "/repo",
      "/repo/src",
      "private instructions",
      "content-hash",
    );

    runLcmMigrations(db, { fts5Available: false });

    expect(db.prepare(
      `SELECT project_id, client_name, session_id, worktree_path, cwd_path,
              content, content_hash
         FROM session_instruction_cache`,
    ).all()).toEqual([{
      project_id: "project",
      client_name: "codex",
      session_id: "session",
      worktree_path: "/repo",
      cwd_path: "/repo/src",
      content: "private instructions",
      content_hash: "content-hash",
    }]);
  });

  it.each([
    [
      "a current-shaped table without the required constraints",
      `CREATE TABLE session_instruction_cache (
         project_id TEXT NOT NULL,
         scope_hash TEXT NOT NULL,
         client_name TEXT NOT NULL,
         session_id TEXT NOT NULL,
         worktree_path TEXT NOT NULL,
         cwd_path TEXT NOT NULL,
         content TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (project_id, scope_hash)
       )`,
    ],
    [
      "a partial legacy source",
      `CREATE TABLE session_instructions (
         id INTEGER PRIMARY KEY,
         content TEXT NOT NULL
       )`,
    ],
    [
      "a relation of the wrong kind",
      "CREATE VIEW session_instruction_cache AS SELECT 1 AS id",
    ],
  ])("rejects %s before any database mutation", (_label, sql) => {
    const db = database();
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept')");
    db.exec(sql);
    const before = schemaSnapshot(db);

    expect(() => runLcmMigrations(db, { fts5Available: false }))
      .toThrow(/unsupported session_instruction/u);

    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "kept" });
    expect(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'conversations'",
    ).get()).toBeUndefined();
  });

  it.each([
    [
      "a fixed-slot source missing its id constraint",
      `CREATE TABLE session_instructions (
         id INTEGER PRIMARY KEY,
         content TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       );
       INSERT INTO session_instructions
         (id, content, content_hash, updated_at)
       VALUES (2, 'private source', 'source-hash', '2026-07-29 00:00:00')`,
      "session_instructions",
    ],
    [
      "a fixed-slot cache with an extra id constraint",
      `CREATE TABLE session_instruction_cache (
         id INTEGER PRIMARY KEY CHECK (id > 0),
         content TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       );
       INSERT INTO session_instruction_cache
         (id, content, content_hash, updated_at)
       VALUES (1, 'private cache', 'cache-hash', '2026-07-29 00:00:00')`,
      "session_instruction_cache",
    ],
    [
      "a fixed-slot cache with an unrecognized table option",
      `CREATE TABLE session_instruction_cache (
         id INTEGER PRIMARY KEY,
         content TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       ) STRICT;
       INSERT INTO session_instruction_cache
         (id, content, content_hash, updated_at)
       VALUES (1, 'private strict cache', 'strict-hash', '2026-07-29 00:00:00')`,
      "session_instruction_cache",
    ],
  ])("leaves database bytes, schema, and rows unchanged for %s", (
    _label,
    sql,
    table,
  ) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-cache-schema-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "cache.db");
    let db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept')");
    db.exec(sql);
    const beforeSchema = schemaSnapshot(db);
    const beforeRows = db.prepare(`SELECT * FROM ${table}`).all();
    db.close();
    const beforeBytes = readFileSync(dbPath);

    db = new DatabaseSync(dbPath);
    expect(() => runLcmMigrations(db, { fts5Available: false }))
      .toThrow(/unsupported session_instruction/u);
    expect(schemaSnapshot(db)).toEqual(beforeSchema);
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(beforeRows);
    expect(db.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "kept" });
    db.close();

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
  });

  it.each([
    [
      "an explicit legacy index",
      `${LEGACY_CACHE_FIXTURE_SQL}
       CREATE INDEX session_instruction_cache_content_idx
         ON session_instruction_cache(content)`,
    ],
    [
      "a legacy trigger",
      `${LEGACY_CACHE_FIXTURE_SQL}
       CREATE TRIGGER session_instruction_cache_legacy_trigger
       AFTER UPDATE ON session_instruction_cache
       BEGIN
         UPDATE sentinel SET value = 'triggered';
       END`,
    ],
    [
      "an explicit current index",
      `${CURRENT_CACHE_FIXTURE_SQL}
       CREATE INDEX session_instruction_cache_content_idx
         ON session_instruction_cache(content)`,
    ],
    [
      "a current trigger",
      `${CURRENT_CACHE_FIXTURE_SQL}
       CREATE TRIGGER session_instruction_cache_current_trigger
       AFTER UPDATE ON session_instruction_cache
       BEGIN
         UPDATE sentinel SET value = 'triggered';
       END`,
    ],
  ])("rejects %s without changing schema, rows, or database bytes", (
    _label,
    sql,
  ) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-cache-objects-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "cache.db");
    let db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept')");
    db.exec(sql);
    const beforeSchema = schemaSnapshot(db);
    const beforeRows = db.prepare("SELECT * FROM session_instruction_cache").all();
    db.close();
    const beforeBytes = readFileSync(dbPath);

    db = new DatabaseSync(dbPath);
    expect(() => runLcmMigrations(db, { fts5Available: false }))
      .toThrow(/unsupported (?:session_instruction_cache|instruction-cache)/u);
    expect(schemaSnapshot(db)).toEqual(beforeSchema);
    expect(db.prepare("SELECT * FROM session_instruction_cache").all())
      .toEqual(beforeRows);
    expect(db.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "kept" });
    db.close();

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
  });

  it("rejects a persisted dependent view before replacing an instruction table", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-cache-dependency-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "cache.db");
    let db = new DatabaseSync(dbPath);
    db.exec(CURRENT_CACHE_FIXTURE_SQL);
    db.exec(`
      CREATE VIEW persisted_instruction_view AS
      SELECT project_id, content
      FROM session_instruction_cache
    `);
    const beforeSchema = schemaSnapshot(db);
    const beforeRows = db.prepare("SELECT * FROM session_instruction_cache").all();
    db.close();
    const beforeBytes = readFileSync(dbPath);

    db = new DatabaseSync(dbPath);
    expect(() => runLcmMigrations(db, { fts5Available: false }))
      .toThrow("unsupported instruction-cache schema dependencies");
    expect(schemaSnapshot(db)).toEqual(beforeSchema);
    expect(db.prepare("SELECT * FROM session_instruction_cache").all())
      .toEqual(beforeRows);
    expect(db.prepare("SELECT * FROM persisted_instruction_view").all())
      .toEqual([{
        project_id: "project",
        content: "private current cache",
      }]);
    db.close();

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
  });

  it.each([
    [
      "a legacy cache without its historical source table",
      LEGACY_CACHE_FIXTURE_SQL,
    ],
    [
      "a current cache combined with a legacy source table",
      `${CURRENT_CACHE_FIXTURE_SQL}\n${LEGACY_SOURCE_FIXTURE_SQL}`,
    ],
  ])("rejects %s as a partial or ambiguous historical state", (_label, sql) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-cache-combination-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "cache.db");
    let db = new DatabaseSync(dbPath);
    db.exec(sql);
    const beforeSchema = schemaSnapshot(db);
    const beforeCacheRows = db.prepare(
      "SELECT * FROM session_instruction_cache",
    ).all();
    const beforeSourceRows = db.prepare(
      "SELECT * FROM sqlite_schema WHERE name = 'session_instructions'",
    ).get()
      ? db.prepare("SELECT * FROM session_instructions").all()
      : null;
    db.close();
    const beforeBytes = readFileSync(dbPath);

    db = new DatabaseSync(dbPath);
    expect(() => runLcmMigrations(db, { fts5Available: false }))
      .toThrow(/unsupported (?:partial legacy|ambiguous) instruction-cache schema/u);
    expect(schemaSnapshot(db)).toEqual(beforeSchema);
    expect(db.prepare("SELECT * FROM session_instruction_cache").all())
      .toEqual(beforeCacheRows);
    if (beforeSourceRows !== null) {
      expect(db.prepare("SELECT * FROM session_instructions").all())
        .toEqual(beforeSourceRows);
    }
    db.close();

    expect(readFileSync(dbPath)).toEqual(beforeBytes);
  });

  it.each([
    "after-begin",
    "after-drop",
    "after-create",
  ] as const)("rolls back a failure injected at %s", (injectedStage) => {
    const db = database();
    createLegacyTables(db);
    const before = schemaSnapshot(db);

    expect(() => runLcmMigrations(db, {
      fts5Available: false,
      _instructionCacheMigrationObserver: (stage) => {
        if (stage === injectedStage) throw new Error(`injected ${stage}`);
      },
    })).toThrow(`injected ${injectedStage}`);

    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.prepare(
      "SELECT content FROM session_instruction_cache",
    ).get()).toEqual({ content: "cache secret" });
    expect(db.prepare(
      "SELECT content FROM session_instructions",
    ).get()).toEqual({ content: "legacy secret" });
  });
});
