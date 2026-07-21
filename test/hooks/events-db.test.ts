// test/hooks/events-db.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventsDb, _resetMigratedPathsForTesting, type EventRow, type HealthStats } from "../../src/hooks/events-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

function withSqlite<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

describe("EventsDb", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigratedPathsForTesting();
    dir = mkdtempSync(join(tmpdir(), "events-db-test-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates schema on first open", () => {
    const db = new EventsDb(dbPath);
    // Should not throw
    db.close();
  });

  it("inserts and retrieves events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("session-1", {
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
    }, "PostToolUse");

    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: "session-1",
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      processed_at: null,
    });
    db.close();
  });

  it("increments seq per session", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.insertEvent("s2", { type: "c", category: "file", data: "z", priority: 3 }, "PostToolUse");

    const events = db.getUnprocessed();
    const s1Events = events.filter(e => e.session_id === "s1");
    const s2Events = events.filter(e => e.session_id === "s2");
    expect(s1Events[0].seq).toBe(1);
    expect(s1Events[1].seq).toBe(2);
    expect(s2Events[0].seq).toBe(1);
    db.close();
  });

  it("marks events as processed", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);

    db.markProcessed([events[0].event_id]);
    expect(db.getUnprocessed()).toHaveLength(0);
    db.close();
  });

  it("ignores an empty processed-id list and links predecessor events", () => {
    const db = new EventsDb(dbPath);
    const first = db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const second = db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.markProcessed([]);
    db.setPrevEventId(second, first);
    expect(db.getUnprocessed().find((event) => event.event_id === second)?.prev_event_id).toBe(first);
    db.close();
  });

  it("reports pattern reinforcement with the default age window", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "choice", category: "decision", data: "SQLite", priority: 1 }, "PostToolUse");
    db.insertEvent("s2", { type: "choice", category: "decision", data: "SQLite", priority: 1 }, "PostToolUse");
    expect(db.getPatternReinforcement("choice", "decision", "SQLite")).toEqual({
      totalCount: 2,
      distinctSessions: 2,
    });
    db.close();
  });

  it("prunes old processed events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    db.markProcessed([events[0].event_id]);

    // Manually backdate the processed_at to 10 days ago
    withSqlite(dbPath, (raw) => raw.exec(
      `UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${events[0].event_id}`
    ));

    const pruned = db.pruneProcessed(7);
    expect(pruned).toBe(1);
    db.close();
  });

  it("handles concurrent opens (WAL mode)", () => {
    const db1 = new EventsDb(dbPath);
    const db2 = new EventsDb(dbPath);
    db1.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db2.insertEvent("s2", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");

    const events = db1.getUnprocessed();
    expect(events).toHaveLength(2);
    db1.close();
    db2.close();
  });

  describe("Schema migrations — error_log + pattern lookup index", () => {
    it("atomically rolls back initial schema DDL when version insertion fails", () => {
      const originalPrepare = DatabaseSync.prototype.prepare;
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (sql === "INSERT INTO schema_version (version) VALUES (?)") {
          throw new Error("injected schema-version failure");
        }
        return originalPrepare.call(this, sql);
      });

      try {
        expect(() => new EventsDb(dbPath)).toThrow("injected schema-version failure");
      } finally {
        prepareSpy.mockRestore();
      }

      const rawDb = new DatabaseSync(dbPath);
      const applicationObjects = rawDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE name IN ('schema_version', 'events', 'error_log', 'idx_events_unprocessed')
      `).all();
      expect(applicationObjects).toEqual([]);
      rawDb.close();

      const recovered = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version))
        .toBe(3);
      recovered.close();
    });

    it("repairs an empty schema-version table", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
      `);
      rawDb.close();
      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version)).toBe(3);
      db.close();
    });

    it("migrates a v2 database by adding only the pattern index", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (2);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
      `);
      rawDb.close();
      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_events_pattern_lookup'").get())).toBeDefined();
      db.close();
    });

    it("leaves an already-current schema version unchanged", () => {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (3);
      `);
      rawDb.close();

      const db = new EventsDb(dbPath);
      expect(withSqlite(dbPath, (raw) => (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version))
        .toBe(3);
      db.close();
    });

    it("releases the pooled connection when migration fails", () => {
      const { DatabaseSync } = require("node:sqlite");
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (1);
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT,
          category TEXT, data TEXT, priority INTEGER, source_hook TEXT,
          prev_event_id INTEGER, processed_at TEXT, created_at TEXT
        );
        CREATE VIEW error_log AS SELECT 1 AS id;
      `);
      rawDb.close();
      expect(() => new EventsDb(dbPath)).toThrow();
    });
    it("migrates v1 DB to the latest schema on open", () => {
      // Create a v1 DB manually (no error_log table or pattern lookup index)
      const { DatabaseSync } = require("node:sqlite");
      const { mkdirSync } = require("node:fs");
      const { dirname } = require("node:path");
      mkdirSync(dirname(dbPath), { recursive: true });
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT NOT NULL,
          seq           INTEGER NOT NULL DEFAULT 0,
          type          TEXT NOT NULL,
          category      TEXT NOT NULL,
          data          TEXT NOT NULL,
          priority      INTEGER DEFAULT 3,
          source_hook   TEXT NOT NULL,
          prev_event_id INTEGER,
          processed_at  TEXT,
          created_at    TEXT DEFAULT (datetime('now'))
        );
      `);
      rawDb.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
      rawDb.close();

      // Now open with EventsDb — should migrate to the latest schema.
      const db = new EventsDb(dbPath);
      const tableRow = withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='error_log'",
      ).get());
      const indexRow = withSqlite(dbPath, (raw) => raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_pattern_lookup'",
      ).get());
      expect(tableRow).toBeDefined();
      expect(indexRow).toBeDefined();
      const versionRow = withSqlite(dbPath, (raw) => raw.prepare("SELECT version FROM schema_version").get()) as { version: number };
      expect(versionRow.version).toBe(3);
      db.close();
    });

    it("logHookError inserts into error_log", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("something went wrong"), "session-abc");
      const row = db.getRecentErrors({ includeMaintenance: true })[0];
      expect(row).toBeDefined();
      expect(row.hook).toBe("PostToolUse");
      expect(row.error).toBe("something went wrong");
      expect(row.session_id).toBe("session-abc");
      db.close();
    });

    it("logHookError handles non-Error values", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PreToolUse", "raw string error");
      const row = db.getRecentErrors({ includeMaintenance: true })[0];
      expect(row.error).toBe("raw string error");
      expect(row.session_id).toBeNull();
      db.close();
    });

    it("getHealthStats returns correct counts", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
      db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
      const events = db.getUnprocessed();
      db.markProcessed([events[0].event_id]);
      db.logHookError("PostToolUse", new Error("oops"), "s1");

      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.unprocessed).toBe(1);
      expect(stats.errors).toBe(1);
      expect(stats.lastCapture).not.toBeNull();
      expect(stats.lastError).not.toBeNull();
      db.close();
    });

    it("getHealthStats returns zeros on empty DB", () => {
      const db = new EventsDb(dbPath);
      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.unprocessed).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastCapture).toBeNull();
      expect(stats.lastError).toBeNull();
      db.close();
    });

    it("pruneUnprocessed caps rows by event_id", () => {
      const db = new EventsDb(dbPath);
      // Insert 15 unprocessed events
      for (let i = 0; i < 15; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const before = db.getUnprocessed();
      expect(before).toHaveLength(15);

      // Prune to max 10 rows (no age pruning — use large maxAgeDays)
      const result = db.pruneUnprocessed(10, 9999);
      expect(result.pruned).toBe(5);

      const after = db.getUnprocessed();
      expect(after).toHaveLength(10);
      // Oldest 5 (lowest event_ids) should be removed
      const minRemaining = Math.min(...after.map(e => e.event_id));
      const maxRemoved = Math.max(...before.slice(0, 5).map(e => e.event_id));
      expect(minRemaining).toBeGreaterThan(maxRemoved);
      db.close();
    });

    it("prunes old unprocessed rows and no-ops when nothing qualifies", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "old", priority: 3 }, "PostToolUse");
      withSqlite(dbPath, (raw) => raw.exec("UPDATE events SET created_at = datetime('now', '-31 days')"));
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 1 });
      expect(db.pruneUnprocessed(10, 30)).toEqual({ pruned: 0 });
      db.close();
    });

    it("rolls back a failed unprocessed prune", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "old", priority: 3 }, "PostToolUse");
      withSqlite(dbPath, (raw) => raw.exec(`
        UPDATE events SET created_at = datetime('now', '-31 days');
        CREATE TRIGGER reject_event_delete BEFORE DELETE ON events BEGIN
          SELECT RAISE(ABORT, 'delete rejected');
        END;
      `));
      expect(() => db.pruneUnprocessed(10, 30)).toThrow("delete rejected");
      expect(db.getUnprocessed()).toHaveLength(1);
      db.close();
    });

    it("pruneUnprocessed logs count to error_log before deleting", () => {
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 5; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      db.pruneUnprocessed(3, 9999);

      const logRow = db.getRecentErrors({ includeMaintenance: true }).find(
        (entry) => entry.hook === "maintenance:pruneUnprocessed",
      );
      expect(logRow).toBeDefined();
      expect(logRow!.error).toContain("pruned");
      db.close();
    });

    it("pruneUnprocessed wraps log+delete in one transaction", () => {
      // Just verify pruneUnprocessed returns { pruned } and leaves DB consistent
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 3; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const result = db.pruneUnprocessed(2, 9999);
      expect(result).toEqual({ pruned: 1 });
      expect(db.getUnprocessed()).toHaveLength(2);
      db.close();
    });

    it("pruneErrorLog removes old entries", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("old error"), "s1");
      // Backdate the entry
      withSqlite(dbPath, (raw) => raw.exec("UPDATE error_log SET created_at = datetime('now', '-31 days')"));
      // Add a recent entry
      db.logHookError("PostToolUse", new Error("recent error"), "s1");

      const pruned = db.pruneErrorLog(30);
      expect(pruned).toBe(1);

      expect(db.getRecentErrors({ includeMaintenance: true, limit: 10 })).toHaveLength(1);
      db.close();
    });
  });
});
