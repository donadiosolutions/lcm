import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync as fsChmodSync,
  existsSync,
  cpSync,
  mkdirSync as fsMkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { sessionInstructionsScopeHash } from "../src/storage/session-instructions.js";
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
import { projectDbPath, projectIdentity } from "../src/daemon/project.js";
import { recoverMachineIdentity } from "../src/machine-identity.js";
import type { ResolvedStorageConfig } from "../src/daemon/config.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { BackendPublicationJournalError } from "../src/storage/backend-publication.js";

const POSTGRESQL_STORAGE: ResolvedStorageConfig = {
  backend: "postgresql",
  postgresql: {
    url: "postgresql://user:secret@db.example/lcm",
    caFile: "/secure/ca.pem",
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
  },
};

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const CACHE_RECONCILIATION_TIMEOUT_MS = 10_000;
const FULL_SUITE_RECONCILIATION_TEST_TIMEOUT_MS = 15_000;
const FULL_SUITE_INSTRUCTION_CACHE_DIVERGENCE_TEST_TIMEOUT_MS = 15_000;
const FULL_SUITE_NOOP_JOURNAL_REDISCOVERY_TEST_TIMEOUT_MS = 15_000;
const FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS = 15_000;
const FULL_SUITE_SNAPSHOT_VALIDATION_TEST_TIMEOUT_MS = 15_000;
const FULL_SUITE_SOURCE_STORE_REFENCING_TEST_TIMEOUT_MS = 15_000;
// Full-suite child-process contention can exceed Vitest's 5-second default.
const FULL_SUITE_PROCESS_TEST_TIMEOUT_MS = 15_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Current-main readers intentionally reject ambient umask modes. Keep every
// ordinary fixture private; a test that exercises an unsafe mode must apply
// its chmod override after this helper creates the secure baseline.
function makePrivateFixtureDirectory(
  path: string,
  options: { readonly recursive?: boolean } = {},
): void {
  fsMkdirSync(path, { ...options, mode: PRIVATE_DIRECTORY_MODE });
  fsChmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function writePrivateFixtureFile(path: string, content: string): void {
  fsWriteFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  fsChmodSync(path, PRIVATE_FILE_MODE);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

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

function makeDatabase(path: string, sessionId: string, content: string, projectId: string): void {
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
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
  const instructionScope = {
    clientName: "codex",
    sessionId,
    worktreePath: `/repo/${sessionId}`,
    cwdPath: `/repo/${sessionId}`,
  } as const;
  db.prepare(
    `INSERT INTO session_instruction_cache(
       project_id, scope_hash, client_name, session_id, worktree_path,
       cwd_path, content, content_hash, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '2026-01-02')`,
  ).run(
    projectId,
    sessionInstructionsScopeHash(instructionScope),
    instructionScope.clientName,
    instructionScope.sessionId,
    instructionScope.worktreePath,
    instructionScope.cwdPath,
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

function removeLegacyMainMetadataColumns(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE conversations DROP COLUMN bootstrapped_at;
    ALTER TABLE summaries DROP COLUMN earliest_at;
    ALTER TABLE summaries DROP COLUMN latest_at;
    ALTER TABLE summaries DROP COLUMN descendant_count;
    ALTER TABLE summaries DROP COLUMN descendant_token_count;
    ALTER TABLE summaries DROP COLUMN source_message_token_count;
  `);
}

type InstructionCacheFixtureRow = {
  readonly content: string;
  readonly contentHash: string;
  readonly updatedAt: string | Uint8Array;
};

function makeMigratedDatabase(path: string): DatabaseSync {
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  runLcmMigrations(db);
  return db;
}

function makeScopedInstructionDatabase(
  path: string,
  projectId: string,
  scope: {
    readonly clientName: "codex";
    readonly sessionId: string;
    readonly worktreePath: string;
    readonly cwdPath: string;
  },
  row: InstructionCacheFixtureRow,
): void {
  const db = makeMigratedDatabase(path);
  db.prepare(
    `INSERT INTO session_instruction_cache(
       project_id, scope_hash, client_name, session_id, worktree_path,
       cwd_path, content, content_hash, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    sessionInstructionsScopeHash(scope),
    scope.clientName,
    scope.sessionId,
    scope.worktreePath,
    scope.cwdPath,
    row.content,
    row.contentHash,
    row.updatedAt,
  );
  db.close();
}

function makeLegacyInstructionDatabase(
  path: string,
  row: InstructionCacheFixtureRow | null,
): void {
  const db = makeMigratedDatabase(path);
  if (row !== null) {
    db.exec(`
      DROP TABLE session_instruction_cache;
      CREATE TABLE session_instruction_cache (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE session_instructions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    for (const table of [
      "session_instruction_cache",
      "session_instructions",
    ] as const) {
      db.prepare(
        `INSERT INTO ${table}(id, content, content_hash, updated_at)
         VALUES(1, ?, ?, ?)`,
      ).run(row.content, row.contentHash, row.updatedAt);
    }
  }
  db.close();
}

function makeInstructionCacheReconciliation(
  root: string,
  targetRow: InstructionCacheFixtureRow,
  sourceRow: InstructionCacheFixtureRow,
): {
  readonly main: string;
  readonly linked: string;
  readonly targetPath: string;
  readonly sourcePath: string;
} {
  const { main, linked } = makeRepository(root);
  const canonical = resolveGitProjectAnchor(main)!.canonical;
  const targetHash = hashProjectPath(canonical);
  const sourceHash = hashProjectPath(linked);
  writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
    [targetHash]: { canonical, aliases: [] },
    [sourceHash]: { canonical: linked, aliases: [] },
  }, null, 2)}\n`);
  clearProjectMapCache();
  const targetPath = join(root, ".lcm", "projects", targetHash, "db.sqlite");
  const sourcePath = join(root, ".lcm", "projects", sourceHash, "db.sqlite");
  const instructionScope = {
    clientName: "codex",
    sessionId: "shared-cache-scope",
    worktreePath: linked,
    cwdPath: linked,
  } as const;
  for (const [path, projectId, cacheRow] of [
    [targetPath, targetHash, targetRow],
    [sourcePath, sourceHash, sourceRow],
  ] as const) {
    makeScopedInstructionDatabase(
      path,
      projectId,
      instructionScope,
      cacheRow,
    );
  }
  return { main, linked, targetPath, sourcePath };
}

function makeLegacyInstructionReconciliation(
  root: string,
  targetRow: InstructionCacheFixtureRow | null,
  sourceRow: InstructionCacheFixtureRow,
): {
  readonly main: string;
  readonly targetPath: string;
} {
  const { main, linked } = makeRepository(root);
  const canonical = resolveGitProjectAnchor(main)!.canonical;
  const targetHash = hashProjectPath(canonical);
  const sourceHash = hashProjectPath(linked);
  writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
    [targetHash]: { canonical, aliases: [] },
    [sourceHash]: { canonical: linked, aliases: [] },
  }, null, 2)}\n`);
  clearProjectMapCache();
  const targetPath = join(root, ".lcm", "projects", targetHash, "db.sqlite");
  const sourcePath = join(root, ".lcm", "projects", sourceHash, "db.sqlite");
  for (const [path, instructionRow] of [
    [targetPath, targetRow],
    [sourcePath, sourceRow],
  ] as const) {
    makeLegacyInstructionDatabase(path, instructionRow);
  }
  return { main, targetPath };
}

function makeEvents(path: string, sessionId: string): void {
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
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
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
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

function makeLegacyEvents(
  path: string,
  sessionId: string,
  schemaVersion: "missing" | "empty" | { readonly value: number | string | null },
): void {
  makePrivateFixtureDirectory(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  if (schemaVersion !== "missing") {
    db.exec("CREATE TABLE schema_version(version)");
    if (schemaVersion !== "empty") {
      db.prepare("INSERT INTO schema_version VALUES(?)").run(schemaVersion.value);
    }
  }
  db.exec(`
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

function makeVersionedEvents(
  path: string,
  overrides: {
    readonly eventUuid?: string;
    readonly machineSequence?: string;
    readonly data?: string;
    readonly deliveryState?: "pending" | "retry" | "replicated" | "acknowledged" | "quarantined";
    readonly deliveryGeneration?: number;
    readonly deliveryAttempts?: number;
    readonly remoteInboxId?: string | null;
    readonly quarantineReason?: string | null;
  } = {},
): void {
  const events = new EventsDb(path);
  events.insertEvent(
    "shared-versioned-session",
    {
      type: "choice",
      category: "decision",
      data: overrides.data ?? "SQLite",
      priority: 1,
    },
    "PostToolUse",
  );
  events.close();
  const state = overrides.deliveryState ?? "pending";
  const db = new DatabaseSync(path);
  db.prepare(`
    UPDATE events
    SET event_uuid = ?,
        machine_id = ?,
        machine_sequence = ?,
        delivery_state = ?,
        delivery_generation = ?,
        delivery_attempts = ?,
        delivery_owner = NULL,
        delivery_claimed_at = NULL,
        delivery_next_attempt_at = '2026-07-29 12:00:00',
        remote_inbox_id = ?,
        quarantine_reason = ?,
        acknowledged_at = ?,
        created_at = '2026-07-29 12:00:00',
        delivery_updated_at = '2026-07-29 12:00:01'
  `).run(
    overrides.eventUuid ?? "12345678-1234-4abc-8def-123456789abc",
    MACHINE_ID,
    overrides.machineSequence ?? "0000000000000000007",
    state,
    overrides.deliveryGeneration ?? 0,
    overrides.deliveryAttempts ?? 0,
    overrides.remoteInboxId ?? null,
    state === "quarantined"
      ? overrides.quarantineReason ?? "poison"
      : null,
    state === "acknowledged" ? "2026-07-29 12:00:01" : null,
  );
  db.close();
}

function makeEventsReconciliation(root: string): {
  readonly main: string;
  readonly targetEvents: string;
  readonly sourceEvents: string;
} {
  const { main, linked } = makeRepository(root);
  const canonical = resolveGitProjectAnchor(main)!.canonical;
  const targetHash = hashProjectPath(canonical);
  const sourceHash = hashProjectPath(linked);
  writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
    [targetHash]: { canonical, aliases: [] },
    [sourceHash]: { canonical: linked, aliases: [] },
  }, null, 2)}\n`);
  clearProjectMapCache();
  return {
    main,
    targetEvents: join(root, ".lcm", "events", `${targetHash}.db`),
    sourceEvents: join(root, ".lcm", "events", `${sourceHash}.db`),
  };
}

function setMissingCwdState(
  path: string,
  observations: number,
  lastObservedAt: number,
  parkedAt: string | null,
): void {
  const db = new DatabaseSync(path);
  db.prepare(`
    INSERT INTO missing_cwd_state(id, observations, last_observed_at, parked_at)
    VALUES(1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observations = excluded.observations,
      last_observed_at = excluded.last_observed_at,
      parked_at = excluded.parked_at
  `).run(observations, lastObservedAt, parkedAt);
  db.close();
}

function missingCwdState(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`
      SELECT observations, last_observed_at, parked_at
      FROM missing_cwd_state WHERE id = 1
    `).get();
  } finally {
    db.close();
  }
}

function replaceMissingCwdStateWithUncheckedRows(
  path: string,
  states: ReadonlyArray<readonly [SQLInputValue, SQLInputValue, SQLInputValue, SQLInputValue]>,
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    DROP TABLE missing_cwd_state;
    CREATE TABLE missing_cwd_state(
      id,
      observations,
      last_observed_at,
      parked_at
    );
  `);
  const insert = db.prepare(`
    INSERT INTO missing_cwd_state(id, observations, last_observed_at, parked_at)
    VALUES(?, ?, ?, ?)
  `);
  states.forEach((state) => insert.run(...state));
  db.close();
}

function makeSeparatelyMigratedLegacyCopies(
  root: string,
  firstMigration: "target" | "source",
): ReturnType<typeof makeEventsReconciliation> {
  const fixture = makeEventsReconciliation(root);
  recoverMachineIdentity({
    version: 1,
    identityKey: `machine:${"a".repeat(64)}`,
    machineId: MACHINE_ID,
    displayName: "Test machine",
  }, { homeDir: root });
  makeEventsV1(fixture.targetEvents, "shared-legacy-session");
  cpSync(fixture.targetEvents, fixture.sourceEvents);
  const first = firstMigration === "target"
    ? fixture.targetEvents
    : fixture.sourceEvents;
  const second = firstMigration === "target"
    ? fixture.sourceEvents
    : fixture.targetEvents;
  new EventsDb(first).close();
  new EventsDb(second).close();
  return fixture;
}

function migratedLegacyEvent(path: string): {
  readonly event_id: number;
  readonly event_uuid: string;
  readonly machine_sequence: string;
  readonly delivery_state: string;
  readonly delivery_generation: number;
  readonly delivery_attempts: number;
  readonly delivery_next_attempt_at: string;
  readonly remote_inbox_id: string | null;
  readonly acknowledged_at: string | null;
  readonly quarantine_reason: string | null;
  readonly remote_pruned_at: string | null;
  readonly delivery_updated_at: string;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`
      SELECT event_id, event_uuid, machine_sequence, delivery_state,
             delivery_generation, delivery_attempts, delivery_next_attempt_at,
             remote_inbox_id, acknowledged_at, quarantine_reason,
             remote_pruned_at, delivery_updated_at
      FROM events
      WHERE session_id = 'shared-legacy-session'
    `).get() as ReturnType<typeof migratedLegacyEvent>;
  } finally {
    db.close();
  }
}

function progressMigratedLegacyEvent(path: string, remoteInboxId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      UPDATE events
      SET delivery_state = 'replicated',
          delivery_generation = 3,
          delivery_attempts = 2,
          delivery_owner = NULL,
          delivery_claimed_at = NULL,
          delivery_last_error = NULL,
          remote_inbox_id = ?,
          quarantine_reason = NULL,
          acknowledged_at = NULL,
          remote_pruned_at = NULL,
          delivery_updated_at = '2026-07-30 08:00:00'
      WHERE session_id = 'shared-legacy-session'
    `).run(remoteInboxId);
  } finally {
    db.close();
  }
}

type PassiveEventTransportState =
  | "claimed"
  | "retry"
  | "replicated"
  | "acknowledged"
  | "quarantined"
  | "remote-pruned";

function setPassiveEventTransportState(
  path: string,
  eventId: number,
  state: PassiveEventTransportState,
): void {
  const values = {
    claimed: {
      deliveryState: "claimed",
      owner: "worker",
      claimedAt: "2026-07-30 08:00:00",
      lastError: null,
      remoteInboxId: null,
      quarantineReason: null,
      acknowledgedAt: null,
      remotePrunedAt: null,
    },
    retry: {
      deliveryState: "retry",
      owner: null,
      claimedAt: null,
      lastError: "readback unavailable",
      remoteInboxId: null,
      quarantineReason: null,
      acknowledgedAt: null,
      remotePrunedAt: null,
    },
    replicated: {
      deliveryState: "replicated",
      owner: null,
      claimedAt: null,
      lastError: null,
      remoteInboxId: "42",
      quarantineReason: null,
      acknowledgedAt: null,
      remotePrunedAt: null,
    },
    acknowledged: {
      deliveryState: "acknowledged",
      owner: null,
      claimedAt: null,
      lastError: null,
      remoteInboxId: "42",
      quarantineReason: null,
      acknowledgedAt: "2026-07-30 08:01:00",
      remotePrunedAt: null,
    },
    quarantined: {
      deliveryState: "quarantined",
      owner: null,
      claimedAt: null,
      lastError: null,
      remoteInboxId: null,
      quarantineReason: "poison payload",
      acknowledgedAt: null,
      remotePrunedAt: null,
    },
    "remote-pruned": {
      deliveryState: "acknowledged",
      owner: null,
      claimedAt: null,
      lastError: null,
      remoteInboxId: "42",
      quarantineReason: null,
      acknowledgedAt: "2026-07-30 08:01:00",
      remotePrunedAt: "2026-07-30 08:02:00",
    },
  } as const;
  const value = values[state];
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      UPDATE events
      SET delivery_state = ?,
          delivery_generation = delivery_generation + 1,
          delivery_attempts = 1,
          delivery_owner = ?,
          delivery_claimed_at = ?,
          delivery_last_error = ?,
          remote_inbox_id = ?,
          quarantine_reason = ?,
          acknowledged_at = ?,
          remote_pruned_at = ?,
          delivery_updated_at = '2026-07-30 08:03:00'
      WHERE event_id = ?
    `).run(
      value.deliveryState,
      value.owner,
      value.claimedAt,
      value.lastError,
      value.remoteInboxId,
      value.quarantineReason,
      value.acknowledgedAt,
      value.remotePrunedAt,
      eventId,
    );
  } finally {
    db.close();
  }
}

function readSourceEventIdentities(
  path: string,
): Array<{ event_id: number; event_uuid: string }> {
  const db = new DatabaseSync(path, { readOnly: true });
  let queryFailed = false;
  try {
    return db.prepare(
      "SELECT event_id, event_uuid FROM events ORDER BY event_id",
    ).all() as Array<{ event_id: number; event_uuid: string }>;
  } catch (error) {
    queryFailed = true;
    throw error;
  } finally {
    try {
      db.close();
    } catch (closeError) {
      if (!queryFailed) throw closeError;
    }
  }
}

function makeVersionedPredecessorRemap(
  root: string,
  occupyTarget = true,
): ReturnType<typeof makeEventsReconciliation> & {
  readonly parentId: number;
  readonly childId: number;
  readonly parentUuid: string;
  readonly childUuid: string;
} {
  const fixture = makeEventsReconciliation(root);
  recoverMachineIdentity({
    version: 1,
    identityKey: `machine:${"a".repeat(64)}`,
    machineId: MACHINE_ID,
    displayName: "Test machine",
  }, { homeDir: root });
  if (occupyTarget) {
    const target = new EventsDb(fixture.targetEvents);
    target.insertEvent(
      "target",
      { type: "choice", category: "decision", data: "occupy id 1", priority: 1 },
      "PostToolUse",
    );
    target.close();
  }
  const source = new EventsDb(fixture.sourceEvents);
  const parentId = source.insertEvent(
    "source",
    { type: "choice", category: "decision", data: "parent", priority: 1 },
    "PostToolUse",
  );
  const childId = source.insertEvent(
    "source",
    { type: "choice", category: "decision", data: "child", priority: 1 },
    "PostToolUse",
  );
  source.setPrevEventId(childId, parentId);
  source.close();
  const events = readSourceEventIdentities(fixture.sourceEvents);
  return {
    ...fixture,
    parentId,
    childId,
    parentUuid: events[0]!.event_uuid,
    childUuid: events[1]!.event_uuid,
  };
}

function makeVersionedPredecessorCollision(
  root: string,
  targetPreviousId: number | null,
  sourcePreviousId: number | null,
): ReturnType<typeof makeEventsReconciliation> {
  const fixture = makeEventsReconciliation(root);
  for (const path of [fixture.targetEvents, fixture.sourceEvents]) {
    const events = new EventsDb(path);
    events.insertEvent(
      "shared",
      { type: "choice", category: "decision", data: "parent", priority: 1 },
      "PostToolUse",
    );
    events.insertEvent(
      "shared",
      { type: "choice", category: "decision", data: "child", priority: 1 },
      "PostToolUse",
    );
    events.close();
  }
  for (const [path, previousId] of [
    [fixture.targetEvents, targetPreviousId],
    [fixture.sourceEvents, sourcePreviousId],
  ] as const) {
    const db = new DatabaseSync(path);
    db.prepare(`
      UPDATE events
      SET event_uuid = CASE event_id
            WHEN 1 THEN '11111111-1111-4111-8111-111111111111'
            ELSE '22222222-2222-4222-8222-222222222222'
          END,
          machine_id = ?,
          machine_sequence = CASE event_id
            WHEN 1 THEN '0000000000000000007'
            ELSE '0000000000000000008'
          END,
          prev_event_id = CASE event_id WHEN 2 THEN ? ELSE NULL END,
          created_at = CASE event_id
            WHEN 1 THEN '2026-07-30 07:00:00'
            ELSE '2026-07-30 07:00:01'
          END,
          delivery_next_attempt_at = CASE event_id
            WHEN 1 THEN '2026-07-30 07:00:00'
            ELSE '2026-07-30 07:00:01'
          END,
          delivery_updated_at = CASE event_id
            WHEN 1 THEN '2026-07-30 07:00:00'
            ELSE '2026-07-30 07:00:01'
          END
    `).run(MACHINE_ID, previousId);
    db.close();
  }
  return fixture;
}

function withEventsSqlite<T>(
  path: string,
  readOnly: boolean,
  operation: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(path, { readOnly });
  let operationFailed = false;
  try {
    return operation(db);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      db.close();
    } catch (closeError) {
      if (!operationFailed) throw closeError;
    }
  }
}

function pruneVersionedPredecessor(
  fixture: ReturnType<typeof makeEventsReconciliation>,
  eventId = 1,
): void {
  for (const path of [fixture.targetEvents, fixture.sourceEvents]) {
    withEventsSqlite(path, false, (db) => {
      db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    });
  }
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
    makePrivateFixtureDirectory(join(home, ".lcm"), { recursive: true });
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(join(targetDir, "sensitive-patterns.txt"), "MAIN_PATTERN\n");
    writePrivateFixtureFile(join(sourceDir, "sensitive-patterns.txt"), "LINKED_PATTERN\n");

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
    writePrivateFixtureFile(journalPath, JSON.stringify(journal));
    expect(reconcileWorktrees(linked, { now: new Date("2026-07-26T12:00:00Z") }).status)
      .toBe("completed");
    expect(reconcileWorktrees(linked).status).toBe("completed");
    const retried = new DatabaseSync(join(targetDir, "db.sqlite"), { readOnly: true });
    expect(retried.prepare("SELECT COUNT(*) AS count FROM conversations").get())
      .toEqual({ count: 2 });
    retried.close();

    rmSync(sourceDir, { recursive: true, force: true });
    writePrivateFixtureFile(
      sourceDir,
      `${JSON.stringify({ version: 1, hash: sourceHash, kind: "project" })}\n`,
    );
    const restoredEventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
    rmSync(restoredEventsPath, { recursive: true, force: true });
    makePrivateFixtureDirectory(restoredEventsPath);
    writePrivateFixtureFile(
      join(restoredEventsPath, "fence.json"),
      `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
    );
    const completedJournal = JSON.parse(readFileSync(journalPath, "utf8"));
    completedJournal.phase = "merged";
    completedJournal.pendingSourceHashes = [sourceHash];
    writePrivateFixtureFile(journalPath, JSON.stringify(completedJournal));
    expect(reconcileWorktrees(linked).status).toBe("completed");
  }, 15_000);

  it("reconciles a late source generation exactly once after a completed generation", () => {
    const { main, linked: linkedA } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceAHash = hashProjectPath(linkedA);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceAHash]: { canonical: linkedA, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceADir = join(home, ".lcm", "projects", sourceAHash);
    makeDatabase(join(sourceADir, "db.sqlite"), "generation-a", "content a", sourceAHash);
    makeEvents(join(home, ".lcm", "events", `${sourceAHash}.db`), "generation-a");
    writePrivateFixtureFile(join(sourceADir, "sensitive-patterns.txt"), "GENERATION_A\n");

    expect(reconcileWorktrees(main, {
      now: new Date("2026-07-25T12:00:00Z"),
    }).status).toBe("completed");

    const linkedB = join(home, "linked-b");
    git(main, "worktree", "add", "-qb", "linked-b", linkedB);
    const sourceBHash = hashProjectPath(linkedB);
    const targetEntry = listProjectMapEntries()[targetHash]!;
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: targetEntry,
      [sourceBHash]: { canonical: linkedB, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceBDir = join(home, ".lcm", "projects", sourceBHash);
    makeDatabase(join(sourceBDir, "db.sqlite"), "generation-b", "content b", sourceBHash);
    makeEvents(join(home, ".lcm", "events", `${sourceBHash}.db`), "generation-b");
    writePrivateFixtureFile(join(sourceBDir, "sensitive-patterns.txt"), "GENERATION_B\n");

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
  }, 15_000);

  it("keeps dry-run read-only while previewing legacy metadata backfill", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const mapPath = projectMapPath();
    writePrivateFixtureFile(mapPath, `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "legacy-metadata", "content", sourceHash);
    writePrivateFixtureFile(join(sourceDir, "meta.json"), JSON.stringify({ cwd: linked }));
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
  }, FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS);

  it("normalizes a legacy main snapshot with WAL state without migrating source evidence", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "legacy-duplicate", "same content", targetHash);
    makeDatabase(sourcePath, "legacy-duplicate", "same content", sourceHash);
    const targetBefore = new DatabaseSync(targetPath);
    targetBefore.prepare(
      "UPDATE conversations SET bootstrapped_at = NULL WHERE session_id = 'legacy-duplicate'",
    ).run();
    targetBefore.close();
    const legacyWriter = new DatabaseSync(sourcePath);
    legacyWriter.prepare(
      "UPDATE conversations SET bootstrapped_at = NULL WHERE session_id = 'legacy-duplicate'",
    ).run();
    removeLegacyMainMetadataColumns(legacyWriter);
    expect(legacyWriter.prepare("PRAGMA journal_mode = WAL").get())
      .toEqual({ journal_mode: "wal" });
    legacyWriter.exec("PRAGMA wal_autocheckpoint = 0");
    legacyWriter.prepare(
      `INSERT INTO conversations(session_id, title, created_at, updated_at)
       VALUES('wal-only', 'WAL', '2026-01-04', '2026-01-04')`,
    ).run();
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);

    let closedWriter = false;
    const result = reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "before-source-main-merge") {
          expect(existsSync(`${sourcePath}-wal`)).toBe(true);
        }
        if (event === "after-merge-before-archive") {
          legacyWriter.close();
          closedWriter = true;
        }
      },
    });
    if (!closedWriter) legacyWriter.close();
    expect(result.status).toBe("completed");

    const target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare(
      "SELECT session_id FROM conversations ORDER BY session_id",
    ).all()).toEqual([
      { session_id: "legacy-duplicate" },
      { session_id: "wal-only" },
    ]);
    expect(target.prepare(
      "SELECT COUNT(*) AS count FROM conversations WHERE session_id = 'legacy-duplicate'",
    ).get()).toEqual({ count: 1 });
    expect(target.prepare(
      `SELECT bootstrapped_at FROM conversations
       WHERE session_id = 'legacy-duplicate'`,
    ).get()).toEqual({ bootstrapped_at: null });
    expect(target.prepare(
      `SELECT earliest_at, latest_at, descendant_count,
              descendant_token_count, source_message_token_count
         FROM summaries WHERE summary_id = 'summary-legacy-duplicate'`,
    ).get()).toEqual({
      earliest_at: "2026-01-01T00:00:00.000Z",
      latest_at: "2026-01-01T00:00:00.000Z",
      descendant_count: 0,
      descendant_token_count: 0,
      source_message_token_count: 3,
    });
    target.close();

    const sourceBackup = result.backupPaths.find((path) => path.includes("oldprojects"))!;
    const evidence = new DatabaseSync(join(sourceBackup, "db.sqlite"), { readOnly: true });
    const conversationColumns = evidence.prepare("PRAGMA table_info(conversations)").all()
      .map((column) => String((column as { name: string }).name));
    const summaryColumns = evidence.prepare("PRAGMA table_info(summaries)").all()
      .map((column) => String((column as { name: string }).name));
    expect(conversationColumns).not.toContain("bootstrapped_at");
    expect(summaryColumns).not.toContain("earliest_at");
    expect(summaryColumns).not.toContain("source_message_token_count");
    evidence.close();
    expect(readdirSync(join(home, ".lcm", "projects", targetHash))
      .some((name) => name.startsWith(".lcm-reconciliation-snapshot-"))).toBe(false);
  }, FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS);

  it("keeps target and legacy evidence clean when snapshot migration fails, then retries", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "target-before-failure", "target", targetHash);
    makeDatabase(sourcePath, "legacy-migration-failure", "source", sourceHash);
    const legacy = new DatabaseSync(sourcePath);
    removeLegacyMainMetadataColumns(legacy);
    legacy.exec(`
      CREATE TRIGGER reject_legacy_snapshot_migration
      BEFORE UPDATE ON summaries
      BEGIN
        SELECT RAISE(ABORT, 'legacy snapshot migration blocked');
      END
    `);
    legacy.close();

    expect(() => reconcileWorktrees(main)).toThrow("legacy snapshot migration blocked");
    const unchangedTarget = new DatabaseSync(targetPath, { readOnly: true });
    expect(unchangedTarget.prepare(
      "SELECT session_id FROM conversations ORDER BY session_id",
    ).all()).toEqual([{ session_id: "target-before-failure" }]);
    expect(unchangedTarget.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name = 'worktree_reconciliation_sources'`,
    ).get()).toBeUndefined();
    unchangedTarget.close();
    const unchangedSource = new DatabaseSync(sourcePath);
    expect(unchangedSource.prepare("PRAGMA table_info(conversations)").all()
      .map((column) => (column as { name: string }).name)).not.toContain("bootstrapped_at");
    unchangedSource.exec("DROP TRIGGER reject_legacy_snapshot_migration");
    unchangedSource.close();
    expect(readdirSync(join(home, ".lcm", "projects", targetHash))
      .some((name) => name.startsWith(".lcm-reconciliation-snapshot-"))).toBe(false);

    const result = reconcileWorktrees(main);
    expect(result.status).toBe("completed");
    const merged = new DatabaseSync(targetPath, { readOnly: true });
    expect(merged.prepare(
      "SELECT session_id FROM conversations ORDER BY session_id",
    ).all()).toEqual([
      { session_id: "legacy-migration-failure" },
      { session_id: "target-before-failure" },
    ]);
    expect(merged.prepare(
      `SELECT COUNT(*) AS count FROM worktree_reconciliation_sources
       WHERE source_hash = ?`,
    ).get(sourceHash)).toEqual({ count: 1 });
    merged.close();
    const sourceBackup = result.backupPaths.find((path) => path.includes("oldprojects"))!;
    const evidence = new DatabaseSync(join(sourceBackup, "db.sqlite"), { readOnly: true });
    expect(evidence.prepare("PRAGMA table_info(conversations)").all()
      .map((column) => (column as { name: string }).name)).not.toContain("bootstrapped_at");
    evidence.close();
  }, FULL_SUITE_SNAPSHOT_MIGRATION_TEST_TIMEOUT_MS);

  it("uses stable per-table fence triggers across schema-drift retries", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeMigratedDatabase(sourcePath).close();
    const failAfterFence = () => {
      throw new Error("stop after durable source fence");
    };

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "after-source-fence-commit-before-target-commit") failAfterFence();
      },
    })).toThrow("stop after durable source fence");
    const first = new DatabaseSync(sourcePath);
    const firstConversationTriggers = first.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name = 'conversations'
         AND name LIKE 'lcm_reconciliation_fence_%'
       ORDER BY name`,
    ).all();
    first.exec(`CREATE TABLE "AAA odd table""name" ("value" TEXT)`);
    first.close();

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "after-source-fence-commit-before-target-commit") failAfterFence();
      },
    })).toThrow("stop after durable source fence");
    const second = new DatabaseSync(sourcePath);
    expect(second.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name = 'conversations'
         AND name LIKE 'lcm_reconciliation_fence_%'
       ORDER BY name`,
    ).all()).toEqual(firstConversationTriggers);
    const driftTriggers = second.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name = 'AAA odd table"name'
         AND name LIKE 'lcm_reconciliation_fence_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const driftTableHash = createHash("sha256").update('AAA odd table"name').digest("hex");
    expect(driftTriggers).toEqual([
      { name: `lcm_reconciliation_fence_${driftTableHash}_delete` },
      { name: `lcm_reconciliation_fence_${driftTableHash}_insert` },
      { name: `lcm_reconciliation_fence_${driftTableHash}_update` },
    ]);
    expect(() => second.prepare(
      `INSERT INTO "AAA odd table""name" ("value") VALUES('blocked')`,
    ).run()).toThrow("LCM source retired by worktree reconciliation");
    second.close();
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
    writePrivateFixtureFile(mapPath, `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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

    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(blockedJournalPath, JSON.stringify(legacyBlocked));
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(tokenDir, { recursive: true });
    git(main, "worktree", "add", "-qb", "historical", deletedWorktree);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(deletedWorktree);
    const unrelated = join(home, "unrelated");
    makePrivateFixtureDirectory(unrelated);
    const unrelatedHash = hashProjectPath(unrelated);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(archived, { recursive: true });
    writePrivateFixtureFile(join(archived, "historical.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "historical",
        cwd: deletedWorktree,
        git: { repository_url: "https://example.invalid/lcm.git" },
      },
    })}\n`);
    writePrivateFixtureFile(join(archived, "no-cwd.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: { id: "no-cwd", git: { repository_url: "https://example.invalid/lcm.git" } },
    })}\n`);
    writePrivateFixtureFile(join(archived, "wrong-repository.jsonl"), `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "wrong-repository",
        cwd: deletedWorktree,
        git: { repository_url: "https://example.invalid/other.git" },
      },
    })}\n`);
    writePrivateFixtureFile(join(archived, "missing-tombstone.jsonl"), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
        makePrivateFixtureDirectory(tokenDir, { recursive: true });
        const archived = join(codexDir, "archived_sessions");
        makePrivateFixtureDirectory(archived, { recursive: true });
        writePrivateFixtureFile(join(archived, "late.jsonl"), `${JSON.stringify({
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
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("runs automatically on first local project storage access", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    expect(JSON.parse(readFileSync(
      join(home, ".lcm", "projects", targetHash, "meta.json"),
      "utf8",
    ))).toMatchObject({ cwd: canonical });
    const exportAllCwds = readdirSync(join(home, ".lcm", "projects"), {
      withFileTypes: true,
    }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const metaPath = join(home, ".lcm", "projects", entry.name, "meta.json");
      if (!existsSync(metaPath)) return [];
      return [JSON.parse(readFileSync(metaPath, "utf8")).cwd];
    });
    expect(exportAllCwds).toContain(canonical);
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("preserves safe canonical project metadata while publishing canonical cwd", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    writePrivateFixtureFile(join(targetDir, "meta.json"), JSON.stringify({
      cwd: linked,
      lastIngest: "2026-07-25T00:00:00.000Z",
      custom: { retained: true },
    }));
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "metadata-preservation",
      "content",
      sourceHash,
    );

    expect(reconcileWorktrees(linked).status).toBe("completed");
    expect(JSON.parse(readFileSync(join(targetDir, "meta.json"), "utf8"))).toEqual({
      cwd: canonical,
      lastIngest: "2026-07-25T00:00:00.000Z",
      custom: { retained: true },
    });
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("does not rewrite already-canonical target metadata", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    const metaPath = join(targetDir, "meta.json");
    const metadata = `${JSON.stringify({ cwd: canonical, retained: "exact" })}\n`;
    writePrivateFixtureFile(metaPath, metadata);
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "metadata-noop",
      "content",
      sourceHash,
    );

    expect(reconcileWorktrees(linked).status).toBe("completed");
    expect(readFileSync(metaPath, "utf8")).toBe(metadata);
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("rejects a non-file canonical metadata path before map publication", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    makePrivateFixtureDirectory(join(targetDir, "meta.json"), { recursive: true });
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "metadata-directory",
      "content",
      sourceHash,
    );

    expect(() => reconcileWorktrees(linked)).toThrow(
      "invalid canonical project metadata path",
    );
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it.each(["\"invalid\"", "null", "[]"])(
    "rejects unsafe canonical metadata value %s before map publication",
    (metadata) => {
      const { main, linked } = makeRepository(home);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
        [sourceHash]: { canonical: linked, aliases: [] },
      }, null, 2)}\n`);
      clearProjectMapCache();
      const targetDir = join(home, ".lcm", "projects", targetHash);
      makePrivateFixtureDirectory(targetDir, { recursive: true });
      writePrivateFixtureFile(join(targetDir, "meta.json"), metadata);
      makeDatabase(
        join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
        `metadata-${createHash("sha256").update(metadata).digest("hex").slice(0, 8)}`,
        "content",
        sourceHash,
      );

      expect(() => reconcileWorktrees(linked)).toThrow(
        "invalid canonical project metadata",
      );
      expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    },
  );

  it("carries a legacy linked-worktree binding to canonical identity before PostgreSQL admission", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [sourceHash]: {
        canonical: linked,
        aliases: [],
        remoteProjectId,
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeDatabase(
      join(home, ".lcm", "projects", sourceHash, "db.sqlite"),
      "legacy-postgresql-binding",
      "bound before admission",
      sourceHash,
    );
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Test machine",
    }, { homeDir: home });

    expect(projectIdentity(linked, POSTGRESQL_STORAGE)).toEqual({
      id: remoteProjectId,
      localProjectId: targetHash,
      canonical,
      remoteProjectId,
      machineId: MACHINE_ID,
    });
    expect(listProjectMapEntries()).toEqual({
      [targetHash]: {
        canonical,
        aliases: [linked],
        remoteProjectId,
      },
    });
    const target = new DatabaseSync(
      join(home, ".lcm", "projects", targetHash, "db.sqlite"),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT session_id FROM conversations WHERE session_id = 'legacy-postgresql-binding'",
    ).get()).toEqual({ session_id: "legacy-postgresql-binding" });
    target.close();
  });

  it("rejects conflicting legacy bindings before PostgreSQL admission mutates project state", () => {
    const { main, linked } = makeRepository(home);
    const secondLinked = join(home, "linked-two");
    git(main, "worktree", "add", "-qb", "linked-two", secondLinked);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const secondSourceHash = hashProjectPath(secondLinked);
    const mapPath = projectMapPath();
    writePrivateFixtureFile(mapPath, `${JSON.stringify({
      [sourceHash]: {
        canonical: linked,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
      [secondSourceHash]: {
        canonical: secondLinked,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const mapBefore = readFileSync(mapPath, "utf8");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    const secondSourcePath = join(home, ".lcm", "projects", secondSourceHash, "db.sqlite");
    makeDatabase(sourcePath, "conflicting-binding-a", "source a", sourceHash);
    makeDatabase(secondSourcePath, "conflicting-binding-b", "source b", secondSourceHash);

    expect(() => projectIdentity(linked, POSTGRESQL_STORAGE)).toThrow(
      "conflicting PostgreSQL project bindings",
    );
    expect(readFileSync(mapPath, "utf8")).toBe(mapBefore);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(secondSourcePath)).toBe(true);
    expect(existsSync(join(home, ".lcm", "projects", targetHash))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
  });

  it("re-resolves storage paths after folding a legacy source-hash alias", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, CACHE_RECONCILIATION_TIMEOUT_MS);

  it.each([
    {
      label: "newer source",
      target: {
        content: "target",
        contentHash: "target-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      source: {
        content: "source",
        contentHash: "source-hash",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      expected: {
        content: "source",
        content_hash: "source-hash",
        updated_at: "2026-02-01T00:00:00.000Z",
      },
    },
    {
      label: "newer target",
      target: {
        content: "target",
        contentHash: "target-hash",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      source: {
        content: "source",
        contentHash: "source-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expected: {
        content: "target",
        content_hash: "target-hash",
        updated_at: "2026-02-01T00:00:00.000Z",
      },
    },
    {
      label: "exact duplicate",
      target: {
        content: "exact",
        contentHash: "exact-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      source: {
        content: "exact",
        contentHash: "exact-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expected: {
        content: "exact",
        content_hash: "exact-hash",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
  ])("rejects a scoped instruction-cache divergence or deduplicates the $label case", ({
    target,
    source,
    expected,
  }) => {
    const fixture = makeInstructionCacheReconciliation(home, target, source);

    if (target.content !== source.content) {
      expect(() => reconcileWorktrees(fixture.linked)).toThrow(
        "divergent session_instruction_cache collision",
      );
      return;
    }
    expect(reconcileWorktrees(fixture.linked)).toMatchObject({ status: "completed" });
    const merged = new DatabaseSync(fixture.targetPath, { readOnly: true });
    expect(merged.prepare(
      `SELECT content, content_hash, updated_at
       FROM session_instruction_cache WHERE session_id = 'shared-cache-scope'`,
    ).get()).toEqual(expected);
    merged.close();
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("does not arbitrate scoped cache content by timestamps or process timezone", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "America/Sao_Paulo";
    try {
      const fixture = makeInstructionCacheReconciliation(
        home,
        {
          content: "sqlite target",
          contentHash: "sqlite-target-hash",
          updatedAt: "2026-01-01 00:00:00",
        },
        {
          content: "offset source",
          contentHash: "offset-source-hash",
          updatedAt: "2026-01-01T01:30:00+01:00",
        },
      );

      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "divergent session_instruction_cache collision",
      );
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("fails closed on instruction-cache divergence", () => {
    const fixture = makeInstructionCacheReconciliation(
      home,
      {
        content: "target",
        contentHash: "target-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        content: "source",
        contentHash: "source-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    );

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent session_instruction_cache collision",
    );
    const target = new DatabaseSync(fixture.targetPath, { readOnly: true });
    expect(target.prepare(
      "SELECT content FROM session_instruction_cache WHERE session_id = 'shared-cache-scope'",
    ).get()).toEqual({ content: "target" });
    target.close();
    expect(existsSync(fixture.sourcePath)).toBe(true);
  }, FULL_SUITE_INSTRUCTION_CACHE_DIVERGENCE_TEST_TIMEOUT_MS);

  it("fails closed when a digest candidate matches different scope residuals", () => {
    const exact = {
      content: "same",
      contentHash: "same-hash",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fixture = makeInstructionCacheReconciliation(home, exact, exact);
    const source = new DatabaseSync(fixture.sourcePath);
    source.prepare(
      `UPDATE session_instruction_cache
       SET client_name = 'claude'
       WHERE session_id = 'shared-cache-scope'`,
    ).run();
    source.close();

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent session_instruction_cache collision",
    );
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  it("moves a source-only cache row into the canonical project without broadening scope", () => {
    const exact = {
      content: "source only",
      contentHash: "source-only-hash",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fixture = makeInstructionCacheReconciliation(home, exact, exact);
    const target = new DatabaseSync(fixture.targetPath);
    target.prepare(
      "DELETE FROM session_instruction_cache WHERE session_id = 'shared-cache-scope'",
    ).run();
    target.close();

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const merged = new DatabaseSync(fixture.targetPath, { readOnly: true });
    expect(merged.prepare(
      `SELECT project_id, client_name, session_id, worktree_path, cwd_path,
              content, content_hash
       FROM session_instruction_cache
       WHERE session_id = 'shared-cache-scope'`,
    ).get()).toEqual({
      project_id: hashProjectPath(resolveGitProjectAnchor(fixture.main)!.canonical),
      client_name: "codex",
      session_id: "shared-cache-scope",
      worktree_path: fixture.linked,
      cwd_path: fixture.linked,
      content: "source only",
      content_hash: "source-only-hash",
    });
    merged.close();
  });

  it.each([
    {
      label: "source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "not-a-timestamp",
    },
    {
      label: "target",
      targetUpdatedAt: new Uint8Array([1, 2, 3]),
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      label: "calendar-invalid source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-02-30T00:00:00.000Z",
    },
    {
      label: "shorthand source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "0",
    },
    {
      label: "timezone-less ISO source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-02-01T00:00:00",
    },
    {
      label: "zoned SQLite source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-02-01 00:00:00Z",
    },
    {
      label: "fractional SQLite source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-02-01 00:00:00.1",
    },
    {
      label: "out-of-range month source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-13-01T00:00:00Z",
    },
    {
      label: "zero day source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-00T00:00:00Z",
    },
    {
      label: "non-leap-year source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2025-02-29T00:00:00Z",
    },
    {
      label: "out-of-range hour source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T24:00:00Z",
    },
    {
      label: "out-of-range minute source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:60:00Z",
    },
    {
      label: "out-of-range second source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:00:60Z",
    },
    {
      label: "out-of-range zone hour source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:00:00+24:00",
    },
    {
      label: "out-of-range zone minute source",
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:00:00+00:60",
    },
  ])("rejects divergent cache rows independently of $label timestamp syntax", ({
    targetUpdatedAt,
    sourceUpdatedAt,
  }) => {
    const fixture = makeInstructionCacheReconciliation(
      home,
      {
        content: "target",
        contentHash: "target-hash",
        updatedAt: targetUpdatedAt,
      },
      {
        content: "source",
        contentHash: "source-hash",
        updatedAt: sourceUpdatedAt,
      },
    );

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent session_instruction_cache collision",
    );
    expect(existsSync(fixture.sourcePath)).toBe(true);
  }, FULL_SUITE_RECONCILIATION_TEST_TIMEOUT_MS);

  it("never delegates cache ownership to Date.parse", () => {
    const fixture = makeInstructionCacheReconciliation(
      home,
      {
        content: "target",
        contentHash: "target-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        content: "source",
        contentHash: "source-hash",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    );
    const parse = vi.spyOn(Date, "parse").mockReturnValue(Number.NaN);
    try {
      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "divergent session_instruction_cache collision",
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(existsSync(fixture.sourcePath)).toBe(true);
  });

  it("deduplicates an exact cache row without arbitrating its malformed timestamp", () => {
    const malformed = {
      content: "legacy exact",
      contentHash: "legacy-exact-hash",
      updatedAt: "not-a-timestamp",
    };
    const fixture = makeInstructionCacheReconciliation(home, malformed, malformed);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetPath, { readOnly: true });
    expect(target.prepare(
      `SELECT content, updated_at FROM session_instruction_cache
       WHERE session_id = 'shared-cache-scope'`,
    ).get()).toEqual({
      content: "legacy exact",
      updated_at: "not-a-timestamp",
    });
    target.close();
  }, CACHE_RECONCILIATION_TIMEOUT_MS);

  it.each([
    {
      label: "source-only row",
      target: null,
      source: {
        content: "source-only",
        contentHash: "source-only-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      label: "exact duplicate",
      target: {
        content: "exact",
        contentHash: "exact-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      source: {
        content: "exact",
        contentHash: "exact-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      label: "newer source timestamp",
      target: {
        content: "same",
        contentHash: "same-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      source: {
        content: "same",
        contentHash: "same-hash",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      expectedUpdatedAt: "2026-02-01T00:00:00.000Z",
    },
    {
      label: "newer target timestamp",
      target: {
        content: "same",
        contentHash: "same-hash",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      source: {
        content: "same",
        contentHash: "same-hash",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expectedUpdatedAt: "2026-02-01T00:00:00.000Z",
    },
  ])("discards unscoped legacy instruction caches for a $label", ({
    target,
    source,
  }) => {
    const fixture = makeLegacyInstructionReconciliation(home, target, source);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const merged = new DatabaseSync(fixture.targetPath, { readOnly: true });
    expect(merged.prepare(
      `SELECT 1 FROM sqlite_schema
       WHERE type = 'table' AND name = 'session_instructions'`,
    ).get()).toBeUndefined();
    expect(merged.prepare(
      `SELECT COUNT(*) AS count FROM session_instruction_cache
       WHERE content IN (?, ?)`,
    ).get(source.content, target?.content ?? source.content)).toEqual({ count: 0 });
    merged.close();
  }, CACHE_RECONCILIATION_TIMEOUT_MS);

  it("fails closed on invalid foreign keys", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetPath = join(home, ".lcm", "projects", targetHash, "db.sqlite");
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(targetPath, "instruction-target", "target", targetHash);
    makeDatabase(sourcePath, "instruction-source", "source", sourceHash);
    const invalid = new DatabaseSync(targetPath);
    invalid.exec("PRAGMA foreign_keys = OFF");
    invalid.prepare(
      `INSERT INTO messages(conversation_id, seq, role, content, token_count)
       VALUES(999999, 999, 'user', 'invalid', 1)`,
    ).run();
    invalid.close();
    expect(() => reconcileWorktrees(linked)).toThrow("foreign-key verification failed");
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("rolls back a sidecar merge failure", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEventsV1(sourceEvents, "legacy-v1");
    const nullableLegacy = new DatabaseSync(sourceEvents);
    nullableLegacy.exec(`
      UPDATE events
      SET created_at = NULL,
          processed_at = '2026-07-29 12:00:00'
    `);
    nullableLegacy.close();

    const result = reconcileWorktrees(main);
    expect(result.status).toBe("completed");
    const target = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(target.prepare(`
      SELECT session_id, processed_at, created_at, delivery_state,
             acknowledged_at, remote_inbox_id
      FROM events
    `).all())
      .toEqual([{
        session_id: "legacy-v1",
        processed_at: "2026-07-29 12:00:00",
        created_at: "1970-01-01 00:00:00",
        delivery_state: "pending",
        acknowledged_at: null,
        remote_inbox_id: null,
      }]);
    expect(target.prepare("SELECT COUNT(*) AS count FROM error_log").get())
      .toEqual({ count: 0 });
    target.close();

    const sourceBackup = result.backupPaths.find((path) => path.includes("oldevents"))!;
    const evidence = new DatabaseSync(sourceBackup, { readOnly: true });
    expect(evidence.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
    expect(evidence.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'error_log'",
    ).get()).toBeUndefined();
    expect(evidence.prepare(`
      SELECT session_id, processed_at, created_at
      FROM events
    `).all()).toEqual([{
      session_id: "legacy-v1",
      processed_at: "2026-07-29 12:00:00",
      created_at: null,
    }]);
    evidence.close();
  });

  it.each(["missing", "empty"] as const)(
    "treats a %s schema_version table as legacy events schema v1",
    (schemaVersion) => {
      const { main, linked } = makeRepository(home);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
        [targetHash]: { canonical, aliases: [] },
        [sourceHash]: { canonical: linked, aliases: [] },
      }, null, 2)}\n`);
      clearProjectMapCache();
      const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
      makeLegacyEvents(sourceEvents, `legacy-${schemaVersion}`, schemaVersion);

      const result = reconcileWorktrees(main);
      expect(result.status).toBe("completed");
      const target = new DatabaseSync(
        join(home, ".lcm", "events", `${targetHash}.db`),
        { readOnly: true },
      );
      expect(target.prepare("SELECT session_id FROM events").all())
        .toEqual([{ session_id: `legacy-${schemaVersion}` }]);
      expect(target.prepare("SELECT COUNT(*) AS count FROM error_log").get())
        .toEqual({ count: 0 });
      target.close();

      const sourceBackup = result.backupPaths.find((path) => path.includes("oldevents"))!;
      const evidence = new DatabaseSync(sourceBackup, { readOnly: true });
      if (schemaVersion === "missing") {
        expect(evidence.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'",
        ).get()).toBeUndefined();
      } else {
        expect(evidence.prepare("SELECT version FROM schema_version").get()).toBeUndefined();
      }
      expect(evidence.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'error_log'",
      ).get()).toBeUndefined();
      evidence.close();
    },
  );

  it.each([
    ["non-numeric", "v2"],
    ["fractional", 1.5],
    ["non-positive", 0],
    ["null", null],
  ] as const)("rejects a %s legacy events schema version without NaN diagnostics", (
    _label,
    value,
  ) => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    makeLegacyEvents(
      join(home, ".lcm", "events", `${sourceHash}.db`),
      "invalid-version",
      { value },
    );

    expect(() => reconcileWorktrees(main)).toThrow(
      `legacy events database has invalid schema_version: ${String(value)}`,
    );
    const journal = listWorktreeReconciliationJournals()[0];
    expect(journal).toMatchObject({ phase: "blocked" });
    expect(journal.reason).not.toContain("NaN");
  });

  it.each(["target", "source"] as const)(
    "converges copied legacy sidecars when the %s copy migrates first",
    (firstMigration) => {
      const fixture = makeSeparatelyMigratedLegacyCopies(home, firstMigration);
      const targetBefore = migratedLegacyEvent(fixture.targetEvents);
      const sourceBefore = migratedLegacyEvent(fixture.sourceEvents);
      expect(targetBefore.event_uuid).toBe(sourceBefore.event_uuid);
      expect(targetBefore.machine_sequence).not.toBe(sourceBefore.machine_sequence);
      const expectedSequence = [
        targetBefore.machine_sequence,
        sourceBefore.machine_sequence,
      ].sort()[0]!;

      expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
      expect(migratedLegacyEvent(fixture.targetEvents).machine_sequence)
        .toBe(expectedSequence);

      expect(() => reconcileWorktrees(fixture.main)).not.toThrow();
      const merged = new DatabaseSync(fixture.targetEvents, { readOnly: true });
      expect(merged.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE event_uuid = ?
      `).get(targetBefore.event_uuid)).toEqual({ count: 1 });
      expect(merged.prepare(`
        SELECT machine_sequence
        FROM events
        WHERE event_uuid = ?
      `).get(targetBefore.event_uuid)).toEqual({ machine_sequence: expectedSequence });
      merged.close();
    },
  );

  it.each([
    { progressed: "target" as const, firstMigration: "source" as const },
    { progressed: "source" as const, firstMigration: "target" as const },
  ])("preserves the sole progressed $progressed legacy copy and its sequence", ({
    progressed,
    firstMigration,
  }) => {
    const fixture = makeSeparatelyMigratedLegacyCopies(home, firstMigration);
    const progressedPath = progressed === "target"
      ? fixture.targetEvents
      : fixture.sourceEvents;
    progressMigratedLegacyEvent(progressedPath, "41");
    const expected = migratedLegacyEvent(progressedPath);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    expect(migratedLegacyEvent(fixture.targetEvents)).toMatchObject({
      event_uuid: expected.event_uuid,
      machine_sequence: expected.machine_sequence,
      delivery_state: "replicated",
      delivery_generation: 3,
      delivery_attempts: 2,
      delivery_next_attempt_at: expected.delivery_next_attempt_at,
      remote_inbox_id: "41",
      acknowledged_at: null,
      quarantine_reason: null,
      remote_pruned_at: null,
      delivery_updated_at: "2026-07-30 08:00:00",
    });
  });

  it("fails closed when both separately migrated copies made remote progress", () => {
    const fixture = makeSeparatelyMigratedLegacyCopies(home, "target");
    progressMigratedLegacyEvent(fixture.targetEvents, "41");
    progressMigratedLegacyEvent(fixture.sourceEvents, "42");
    const targetBefore = migratedLegacyEvent(fixture.targetEvents);

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event UUID collision",
    );
    expect(migratedLegacyEvent(fixture.targetEvents)).toEqual(targetBefore);
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it.each(["target", "source"] as const)(
    "accepts a copied legacy pair when only the %s local event id was remapped",
    (remapped) => {
      const fixture = makeSeparatelyMigratedLegacyCopies(home, "target");
      const path = remapped === "target"
        ? fixture.targetEvents
        : fixture.sourceEvents;
      const db = new DatabaseSync(path);
      db.prepare(`
        UPDATE events
        SET event_id = 17
        WHERE session_id = 'shared-legacy-session'
      `).run();
      db.close();
      const expectedSequence = [
        migratedLegacyEvent(fixture.targetEvents).machine_sequence,
        migratedLegacyEvent(fixture.sourceEvents).machine_sequence,
      ].sort()[0]!;

      expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
      expect(migratedLegacyEvent(fixture.targetEvents).machine_sequence)
        .toBe(expectedSequence);
    },
  );

  it("fails closed when neither remapped event id proves legacy derivation", () => {
    const fixture = makeSeparatelyMigratedLegacyCopies(home, "target");
    for (const [path, eventId] of [
      [fixture.targetEvents, 17],
      [fixture.sourceEvents, 18],
    ] as const) {
      const db = new DatabaseSync(path);
      db.prepare(`
        UPDATE events
        SET event_id = ?
        WHERE session_id = 'shared-legacy-session'
      `).run(eventId);
      db.close();
    }

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event UUID collision",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("rolls back when canonical sequence selection collides with another event", () => {
    const fixture = makeSeparatelyMigratedLegacyCopies(home, "target");
    progressMigratedLegacyEvent(fixture.sourceEvents, "41");
    const sourceSequence = migratedLegacyEvent(fixture.sourceEvents).machine_sequence;
    const targetEvents = new EventsDb(fixture.targetEvents);
    const otherEventId = targetEvents.insertEvent(
      "other-session",
      { type: "choice", category: "decision", data: "other", priority: 1 },
      "PostToolUse",
    );
    targetEvents.close();
    const target = new DatabaseSync(fixture.targetEvents);
    target.prepare("UPDATE events SET machine_sequence = ? WHERE event_id = ?")
      .run(sourceSequence, otherEventId);
    const targetBefore = target.prepare(
      "SELECT event_id, event_uuid, machine_sequence FROM events ORDER BY event_id",
    ).all();
    target.close();

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event machine sequence collision",
    );
    const after = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(after.prepare(
      "SELECT event_id, event_uuid, machine_sequence FROM events ORDER BY event_id",
    ).all()).toEqual(targetBefore);
    after.close();
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it.each([1, 2])(
    "does not collapse arbitrary versioned rows at event version %i that only share a UUID",
    (eventVersion) => {
      const fixture = makeEventsReconciliation(home);
      makeVersionedEvents(fixture.targetEvents, {
        machineSequence: "0000000000000000007",
      });
      makeVersionedEvents(fixture.sourceEvents, {
        machineSequence: "0000000000000000008",
      });
      if (eventVersion !== 1) {
        for (const path of [fixture.targetEvents, fixture.sourceEvents]) {
          const db = new DatabaseSync(path);
          db.prepare("UPDATE events SET event_version = ?").run(eventVersion);
          db.close();
        }
      }

      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "divergent passive event UUID collision",
      );
      expect(existsSync(fixture.sourceEvents)).toBe(true);
    },
  );

  it("preserves the newest versioned passive-event delivery checkpoint", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents, {
      deliveryState: "replicated",
      deliveryGeneration: 1,
      deliveryAttempts: 1,
      remoteInboxId: "41",
    });
    makeVersionedEvents(fixture.sourceEvents, {
      deliveryState: "quarantined",
      deliveryGeneration: 2,
      deliveryAttempts: 5,
      remoteInboxId: "41",
      quarantineReason: "poison payload",
    });

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT event_uuid, event_version, machine_id, machine_sequence,
             delivery_state, delivery_generation, delivery_attempts,
             remote_inbox_id, quarantine_reason
      FROM events
    `).get()).toEqual({
      event_uuid: "12345678-1234-4abc-8def-123456789abc",
      event_version: 1,
      machine_id: MACHINE_ID,
      machine_sequence: "0000000000000000007",
      delivery_state: "quarantined",
      delivery_generation: 2,
      delivery_attempts: 5,
      remote_inbox_id: "41",
      quarantine_reason: "poison payload",
    });
    target.close();
  });

  it("preserves a newer target passive-event delivery checkpoint", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents, {
      deliveryState: "replicated",
      deliveryGeneration: 2,
      deliveryAttempts: 5,
      remoteInboxId: "41",
    });
    makeVersionedEvents(fixture.sourceEvents, {
      deliveryState: "replicated",
      deliveryGeneration: 1,
      deliveryAttempts: 1,
      remoteInboxId: "41",
    });

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT delivery_state, delivery_generation, delivery_attempts,
             remote_inbox_id, delivery_updated_at
      FROM events
    `).get()).toEqual({
      delivery_state: "replicated",
      delivery_generation: 2,
      delivery_attempts: 5,
      remote_inbox_id: "41",
      delivery_updated_at: "2026-07-29 12:00:01",
    });
    target.close();
  });

  it("deduplicates an exact versioned passive-event envelope", () => {
    const fixture = makeEventsReconciliation(home);
    const checkpoint = {
      deliveryState: "replicated" as const,
      deliveryGeneration: 2,
      deliveryAttempts: 1,
      remoteInboxId: "41",
    };
    makeVersionedEvents(fixture.targetEvents, checkpoint);
    makeVersionedEvents(fixture.sourceEvents, checkpoint);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare("SELECT COUNT(*) AS count FROM events").get())
      .toEqual({ count: 1 });
    target.close();
  });

  it("merges independent processing metadata without erasing machine identity", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.exec(`
      UPDATE events
      SET machine_id = NULL,
          processed_at = '2026-07-29 12:00:02',
          delivery_updated_at = '2026-07-29 12:00:02'
    `);
    source.close();

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT machine_id, processed_at, delivery_generation, delivery_updated_at
      FROM events
    `).get()).toEqual({
      machine_id: MACHINE_ID,
      processed_at: "2026-07-29 12:00:02",
      delivery_generation: 0,
      delivery_updated_at: "2026-07-29 12:00:02",
    });
    target.close();
  });

  it.each([
    ["target-only", "2026-07-29 12:00:01", null, "2026-07-29 12:00:01"],
    ["target-earlier", "2026-07-29 12:00:01", "2026-07-29 12:00:02", "2026-07-29 12:00:01"],
    ["source-earlier", "2026-07-29 12:00:03", "2026-07-29 12:00:02", "2026-07-29 12:00:02"],
  ] as const)("keeps the earliest %s processed checkpoint", (
    _label,
    targetProcessedAt,
    sourceProcessedAt,
    expected,
  ) => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    for (const [path, processedAt] of [
      [fixture.targetEvents, targetProcessedAt],
      [fixture.sourceEvents, sourceProcessedAt],
    ] as const) {
      const db = new DatabaseSync(path);
      db.prepare("UPDATE events SET processed_at = ?").run(processedAt);
      db.close();
    }

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare("SELECT processed_at FROM events").get())
      .toEqual({ processed_at: expected });
    target.close();
  });

  it("maps present and pruned predecessors for versioned passive events", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.sourceEvents);
    const sourceEvents = new EventsDb(fixture.sourceEvents);
    sourceEvents.insertEvent(
      "shared-versioned-session",
      { type: "choice", category: "decision", data: "child", priority: 1 },
      "PostToolUse",
    );
    sourceEvents.close();
    const source = new DatabaseSync(fixture.sourceEvents);
    source.exec(`
      UPDATE events SET prev_event_id = 999 WHERE event_id = 1;
      UPDATE events SET prev_event_id = 1 WHERE event_id = 2;
    `);
    source.close();

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    const rows = target.prepare(
      "SELECT event_id, prev_event_id FROM events ORDER BY event_id",
    ).all() as Array<{ event_id: number; prev_event_id: number | null }>;
    expect(rows[0].prev_event_id).toBeNull();
    expect(rows[1].prev_event_id).toBe(rows[0].event_id);
    target.close();
  });

  it("remaps a v4 predecessor before the first delivery attempt", () => {
    const fixture = makeVersionedPredecessorRemap(home);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.prepare(`
      UPDATE events
      SET delivery_next_attempt_at = '2026-07-30 09:00:00',
          delivery_updated_at = '2026-07-30 09:00:01'
      WHERE event_id = ?
    `).run(fixture.childId);
    source.close();

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    const parent = target.prepare(
      "SELECT event_id FROM events WHERE event_uuid = ?",
    ).get(fixture.parentUuid) as { event_id: number };
    expect(target.prepare(`
      SELECT prev_event_id, delivery_state, delivery_generation,
             delivery_attempts, delivery_next_attempt_at,
             remote_inbox_id, delivery_updated_at
      FROM events
      WHERE event_uuid = ?
    `).get(fixture.childUuid)).toEqual({
      prev_event_id: parent.event_id,
      delivery_state: "pending",
      delivery_generation: 1,
      delivery_attempts: 0,
      delivery_next_attempt_at: "2026-07-30 09:00:00",
      remote_inbox_id: null,
      delivery_updated_at: "2026-07-30 09:00:01",
    });
    target.close();
  });

  it("closes the source identity reader without masking its query failure", () => {
    const queryFailure = new Error("injected source identity query failure");
    const closeFailure = new Error("injected source identity close failure");
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalClose = DatabaseSync.prototype.close;
    let failedDatabase: DatabaseSync | undefined;
    let closeAttempts = 0;
    const prepareSpy = vi.spyOn(
      DatabaseSync.prototype,
      "prepare",
    ).mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "SELECT event_id, event_uuid FROM events ORDER BY event_id") {
        failedDatabase = this;
        throw queryFailure;
      }
      return originalPrepare.call(this, sql);
    });
    const closeSpy = vi.spyOn(
      DatabaseSync.prototype,
      "close",
    ).mockImplementation(function (this: DatabaseSync) {
      if (this === failedDatabase) {
        closeAttempts += 1;
        originalClose.call(this);
        throw closeFailure;
      }
      return originalClose.call(this);
    });

    let caught: unknown;
    try {
      makeVersionedPredecessorRemap(home);
    } catch (error) {
      caught = error;
    } finally {
      closeSpy.mockRestore();
      prepareSpy.mockRestore();
    }

    expect(DatabaseSync.prototype.prepare).toBe(originalPrepare);
    expect(DatabaseSync.prototype.close).toBe(originalClose);
    expect(caught).toBe(queryFailure);
    expect(closeAttempts).toBe(1);
  });

  it.each([
    "claimed",
    "retry",
    "replicated",
    "acknowledged",
    "quarantined",
    "remote-pruned",
  ] as const)(
    "fails closed before remapping a %s v4 predecessor",
    (transportState) => {
      const fixture = makeVersionedPredecessorRemap(home);
      setPassiveEventTransportState(
        fixture.sourceEvents,
        fixture.childId,
        transportState,
      );
      const targetBefore = new DatabaseSync(fixture.targetEvents, { readOnly: true });
      const expectedTarget = targetBefore.prepare(
        "SELECT event_id, event_uuid, data FROM events ORDER BY event_id",
      ).all();
      targetBefore.close();
      const sourceBefore = new DatabaseSync(fixture.sourceEvents, { readOnly: true });
      const expectedSource = sourceBefore.prepare(
        `SELECT event_id, event_uuid, prev_event_id, delivery_state,
                delivery_attempts, remote_inbox_id
         FROM events ORDER BY event_id`,
      ).all();
      sourceBefore.close();

      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "cannot remap delivered passive event predecessor",
      );
      const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
      expect(target.prepare(
        "SELECT event_id, event_uuid, data FROM events ORDER BY event_id",
      ).all()).toEqual(expectedTarget);
      expect(target.prepare(
        "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
      ).get()).toEqual({ count: 0 });
      target.close();
      const source = new DatabaseSync(fixture.sourceEvents);
      expect(source.prepare(
        `SELECT event_id, event_uuid, prev_event_id, delivery_state,
                delivery_attempts, remote_inbox_id
         FROM events ORDER BY event_id`,
      ).all()).toEqual(expectedSource);
      expect(() => source.prepare(
        "UPDATE events SET data = data WHERE event_id = ?",
      ).run(fixture.childId)).not.toThrow();
      source.close();
    },
  );

  it("fails closed when a delivered v4 predecessor was already pruned locally", () => {
    const fixture = makeVersionedPredecessorRemap(home, false);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.prepare("UPDATE events SET prev_event_id = 999 WHERE event_id = ?")
      .run(fixture.childId);
    source.close();
    setPassiveEventTransportState(
      fixture.sourceEvents,
      fixture.childId,
      "replicated",
    );

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "cannot remap delivered passive event predecessor",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("preserves an identical delivered predecessor that is dangling in both copies", () => {
    const fixture = makeVersionedPredecessorCollision(home, 1, 1);
    setPassiveEventTransportState(fixture.targetEvents, 2, "replicated");
    setPassiveEventTransportState(fixture.sourceEvents, 2, "replicated");
    pruneVersionedPredecessor(fixture);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const expected = {
      prev_event_id: 1,
      delivery_state: "replicated",
      delivery_generation: 1,
      remote_inbox_id: "42",
    };
    withEventsSqlite(fixture.targetEvents, true, (target) => {
      expect(target.prepare(`
        SELECT prev_event_id, delivery_state, delivery_generation, remote_inbox_id
        FROM events
        WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
      `).get()).toEqual(expected);
      expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
        count: 1,
      });
    });

    clearWorktreeReconciliationCache();
    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    withEventsSqlite(fixture.targetEvents, true, (target) => {
      expect(target.prepare(`
        SELECT prev_event_id, delivery_state, delivery_generation, remote_inbox_id
        FROM events
        WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
      `).get()).toEqual(expected);
      expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
        count: 1,
      });
    });
  });

  it.each([
    { label: "source", progressed: "sourceEvents" },
    { label: "destination", progressed: "targetEvents" },
  ] as const)(
    "preserves the dangling predecessor when only the $label copy has delivery progress",
    ({ progressed }) => {
      const fixture = makeVersionedPredecessorCollision(home, 1, 1);
      setPassiveEventTransportState(fixture[progressed], 2, "replicated");
      pruneVersionedPredecessor(fixture);

      expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
      withEventsSqlite(fixture.targetEvents, true, (target) => {
        expect(target.prepare(`
          SELECT prev_event_id, delivery_state, delivery_generation, remote_inbox_id
          FROM events
          WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
        `).get()).toEqual({
          prev_event_id: 1,
          delivery_state: "replicated",
          delivery_generation: 1,
          remote_inbox_id: "42",
        });
      });
    },
  );

  it("preserves an identical dangling predecessor while both copies are pristine", () => {
    const fixture = makeVersionedPredecessorCollision(home, 1, 1);
    pruneVersionedPredecessor(fixture);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    withEventsSqlite(fixture.targetEvents, true, (target) => {
      expect(target.prepare(`
        SELECT prev_event_id, delivery_state, delivery_generation, remote_inbox_id
        FROM events
        WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
      `).get()).toEqual({
        prev_event_id: 1,
        delivery_state: "pending",
        delivery_generation: 0,
        remote_inbox_id: null,
      });
    });
  });

  it("fails closed when delivered duplicates retain different dangling predecessors", () => {
    const fixture = makeVersionedPredecessorCollision(home, 1, 999);
    setPassiveEventTransportState(fixture.targetEvents, 2, "replicated");
    setPassiveEventTransportState(fixture.sourceEvents, 2, "replicated");
    pruneVersionedPredecessor(fixture);

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "cannot remap delivered passive event predecessor",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("fails closed when the dangling predecessor ID is occupied in the destination", () => {
    const fixture = makeVersionedPredecessorCollision(home, 1, 1);
    setPassiveEventTransportState(fixture.targetEvents, 2, "replicated");
    setPassiveEventTransportState(fixture.sourceEvents, 2, "replicated");
    withEventsSqlite(fixture.sourceEvents, false, (source) => {
      source.prepare("DELETE FROM events WHERE event_id = 1").run();
    });
    const expectedTarget = withEventsSqlite(
      fixture.targetEvents,
      false,
      (targetBefore) => {
        targetBefore.prepare(`
          UPDATE events
          SET event_uuid = '99999999-9999-4999-8999-999999999999',
              data = 'unrelated occupant'
          WHERE event_id = 1
        `).run();
        return targetBefore.prepare(
          "SELECT * FROM events ORDER BY event_id",
        ).all();
      },
    );

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "cannot remap delivered passive event predecessor",
    );
    withEventsSqlite(fixture.targetEvents, true, (targetAfter) => {
      expect(targetAfter.prepare(
        "SELECT * FROM events ORDER BY event_id",
      ).all()).toEqual(expectedTarget);
      expect(targetAfter.prepare(
        "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
      ).get()).toEqual({ count: 0 });
    });
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it.each([
    {
      label: "payload",
      sql: "UPDATE events SET data = 'divergent' WHERE event_id = 2",
    },
    {
      label: "machine identity",
      sql: `UPDATE events
            SET machine_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            WHERE event_id = 2`,
    },
    {
      label: "machine sequence",
      sql: "UPDATE events SET machine_sequence = '0000000000000000999' WHERE event_id = 2",
    },
  ])(
    "fails closed before preserving a dangling predecessor with divergent $label",
    ({ sql }) => {
      const fixture = makeVersionedPredecessorCollision(home, 1, 1);
      setPassiveEventTransportState(fixture.sourceEvents, 2, "replicated");
      pruneVersionedPredecessor(fixture);
      const expectedTarget = withEventsSqlite(
        fixture.targetEvents,
        false,
        (targetBefore) => {
          targetBefore.exec(sql);
          return targetBefore.prepare(
            "SELECT * FROM events ORDER BY event_id",
          ).all();
        },
      );

      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "cannot remap delivered passive event predecessor",
      );
      withEventsSqlite(fixture.targetEvents, true, (targetAfter) => {
        expect(targetAfter.prepare(
          "SELECT * FROM events ORDER BY event_id",
        ).all()).toEqual(expectedTarget);
        expect(targetAfter.prepare(
          "SELECT COUNT(*) AS count FROM worktree_reconciliation_sources",
        ).get()).toEqual({ count: 0 });
      });
      expect(existsSync(fixture.sourceEvents)).toBe(true);
    },
  );

  it("keeps an unchanged delivered v4 predecessor", () => {
    const fixture = makeVersionedPredecessorRemap(home, false);
    setPassiveEventTransportState(
      fixture.sourceEvents,
      fixture.childId,
      "replicated",
    );

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT prev_event_id, delivery_state, remote_inbox_id
      FROM events
      WHERE event_uuid = ?
    `).get(fixture.childUuid)).toEqual({
      prev_event_id: fixture.parentId,
      delivery_state: "replicated",
      remote_inbox_id: "42",
    });
    target.close();
  });

  it.each([
    {
      label: "destination",
      targetPreviousId: null,
      sourcePreviousId: 1,
      lockedPath: "target",
    },
    {
      label: "source",
      targetPreviousId: 1,
      sourcePreviousId: null,
      lockedPath: "source",
    },
  ] as const)(
    "fails closed on null-asymmetric predecessor collision with a locked $label",
    ({ targetPreviousId, sourcePreviousId, lockedPath }) => {
      const fixture = makeVersionedPredecessorCollision(
        home,
        targetPreviousId,
        sourcePreviousId,
      );
      setPassiveEventTransportState(
        lockedPath === "target" ? fixture.targetEvents : fixture.sourceEvents,
        2,
        "replicated",
      );

      expect(() => reconcileWorktrees(fixture.main)).toThrow(
        "cannot reconcile delivered passive event predecessor",
      );
      expect(existsSync(fixture.sourceEvents)).toBe(true);
    },
  );

  it("coalesces a null-asymmetric predecessor while both copies are pre-delivery", () => {
    const fixture = makeVersionedPredecessorCollision(home, null, 1);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT prev_event_id, delivery_state, delivery_attempts, remote_inbox_id
      FROM events
      WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
    `).get()).toEqual({
      prev_event_id: 1,
      delivery_state: "pending",
      delivery_attempts: 0,
      remote_inbox_id: null,
    });
    target.close();
  });

  it("merges matching delivered predecessors without weakening checkpoint merge", () => {
    const fixture = makeVersionedPredecessorCollision(home, 1, 1);
    setPassiveEventTransportState(fixture.targetEvents, 2, "replicated");
    setPassiveEventTransportState(fixture.sourceEvents, 2, "replicated");

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    const target = new DatabaseSync(fixture.targetEvents, { readOnly: true });
    expect(target.prepare(`
      SELECT prev_event_id, delivery_state, delivery_attempts, remote_inbox_id
      FROM events
      WHERE event_uuid = '22222222-2222-4222-8222-222222222222'
    `).get()).toEqual({
      prev_event_id: 1,
      delivery_state: "replicated",
      delivery_attempts: 1,
      remote_inbox_id: "42",
    });
    target.close();
  });

  it("fails closed on an invalid passive-event delivery generation", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.exec(`
      PRAGMA ignore_check_constraints = ON;
      UPDATE events SET delivery_generation = -1;
    `);
    source.close();

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "invalid passive event delivery generation",
    );
  });

  it("fails closed on a divergent mapped passive-event predecessor", () => {
    const fixture = makeEventsReconciliation(home);
    const configure = (
      path: string,
      parentUuid: string,
      parentSequence: string,
    ): void => {
      makeVersionedEvents(path, {
        eventUuid: parentUuid,
        machineSequence: parentSequence,
      });
      const events = new EventsDb(path);
      events.insertEvent(
        "shared-versioned-session",
        { type: "choice", category: "decision", data: "child", priority: 1 },
        "PostToolUse",
      );
      events.close();
      const db = new DatabaseSync(path);
      db.prepare(`
        UPDATE events
        SET event_uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            machine_id = ?,
            machine_sequence = '0000000000000000009',
            prev_event_id = 1,
            created_at = '2026-07-29 12:00:02',
            delivery_updated_at = '2026-07-29 12:00:02'
        WHERE event_id = 2
      `).run(MACHINE_ID);
      db.close();
    };
    configure(
      fixture.targetEvents,
      "11111111-1111-4111-8111-111111111111",
      "0000000000000000007",
    );
    configure(
      fixture.sourceEvents,
      "22222222-2222-4222-8222-222222222222",
      "0000000000000000008",
    );

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event predecessor",
    );
  });

  it("fails closed on equal-generation divergent passive-event delivery state", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents, {
      deliveryState: "replicated",
      deliveryGeneration: 2,
      deliveryAttempts: 1,
      remoteInboxId: "41",
    });
    makeVersionedEvents(fixture.sourceEvents, {
      deliveryState: "quarantined",
      deliveryGeneration: 2,
      deliveryAttempts: 1,
      remoteInboxId: "41",
      quarantineReason: "poison",
    });

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event delivery state",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("fails closed on a divergent immutable passive-event UUID collision", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents, { data: "SQLite" });
    makeVersionedEvents(fixture.sourceEvents, { data: "PostgreSQL" });

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "divergent passive event UUID collision",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("rejects a future passive-event sidecar schema before importing rows", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.sourceEvents);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.exec("UPDATE schema_version SET version = 6");
    source.close();

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "unsupported legacy events database schema: 6",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("rejects a target event schema above the separately audited v5 ceiling", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    let raisedTargetVersion = false;

    expect(() => reconcileWorktrees(fixture.main, {
      _observer: (event) => {
        if (event !== "after-target-events-migration" || raisedTargetVersion) return;
        raisedTargetVersion = true;
        const target = new DatabaseSync(fixture.targetEvents);
        target.exec("UPDATE schema_version SET version = 6");
        target.close();
      },
    })).toThrow("unsupported target events database schema: 6");
    expect(raisedTargetVersion).toBe(true);
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("merges schema-v5 missing-CWD evidence before retiring the source", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    setMissingCwdState(fixture.sourceEvents, 2, 1_200_000, null);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    expect(missingCwdState(fixture.targetEvents)).toEqual({
      observations: 2,
      last_observed_at: 1_200_000,
      parked_at: null,
    });
    expect(statSync(fixture.sourceEvents).isDirectory()).toBe(true);
  });

  it("converges copied missing-CWD evidence idempotently without adding observations", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    setMissingCwdState(fixture.targetEvents, 2, 1_200_000, null);
    setMissingCwdState(fixture.sourceEvents, 2, 1_200_000, null);

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    expect(missingCwdState(fixture.targetEvents)).toEqual({
      observations: 2,
      last_observed_at: 1_200_000,
      parked_at: null,
    });
    expect(reconcileWorktrees(fixture.main).status).toBe("completed");
    expect(missingCwdState(fixture.targetEvents)).toEqual({
      observations: 2,
      last_observed_at: 1_200_000,
      parked_at: null,
    });
  });

  it("resolves divergent missing-CWD checkpoints with a deterministic monotonic join", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.targetEvents);
    makeVersionedEvents(fixture.sourceEvents);
    setMissingCwdState(
      fixture.targetEvents,
      3,
      1_200_000,
      "2026-08-06 12:05:00",
    );
    setMissingCwdState(
      fixture.sourceEvents,
      3,
      2_400_000,
      "2026-08-06 12:00:00",
    );

    expect(reconcileWorktrees(fixture.main)).toMatchObject({ status: "completed" });
    expect(missingCwdState(fixture.targetEvents)).toEqual({
      observations: 3,
      last_observed_at: 2_400_000,
      parked_at: "2026-08-06 12:00:00",
    });
  });

  it("fails closed when a schema-v5 source omits durable missing-CWD state storage", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.sourceEvents);
    const source = new DatabaseSync(fixture.sourceEvents);
    source.exec("DROP TABLE missing_cwd_state");
    source.close();

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "source events schema v5 is missing missing_cwd_state",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("fails closed on conflicting schema-v5 missing-CWD state rows", () => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.sourceEvents);
    replaceMissingCwdStateWithUncheckedRows(fixture.sourceEvents, [
      [1, 1, 0, null],
      [2, 1, 300_000, null],
    ]);

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "source events schema v5 has conflicting missing-CWD state rows",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it.each([
    { label: "invalid id", state: [2, 1, 0, null] },
    { label: "non-numeric observations", state: [1, "one", 0, null] },
    { label: "fractional observations", state: [1, 1.5, 0, null] },
    { label: "non-positive observations", state: [1, 0, 0, null] },
    { label: "unsafe observations", state: [1, Number.MAX_SAFE_INTEGER + 1, 0, null] },
    { label: "non-numeric timestamp", state: [1, 1, "now", null] },
    { label: "fractional timestamp", state: [1, 1, 0.5, null] },
    { label: "negative timestamp", state: [1, 1, -1, null] },
    { label: "non-text parked timestamp", state: [1, 3, 600_000, 42] },
    { label: "non-date parked timestamp", state: [1, 3, 600_000, "not-a-timestamp"] },
    { label: "timezone-suffixed parked timestamp", state: [1, 3, 600_000, "2026-08-06T12:00:00Z"] },
    { label: "fractional parked timestamp", state: [1, 3, 600_000, "2026-08-06 12:00:00.000"] },
    { label: "parked before confirmation threshold", state: [1, 2, 600_000, "2026-08-06 12:00:00"] },
  ] as const)("fails closed on $label in schema-v5 missing-CWD state", ({ state }) => {
    const fixture = makeEventsReconciliation(home);
    makeVersionedEvents(fixture.sourceEvents);
    replaceMissingCwdStateWithUncheckedRows(fixture.sourceEvents, [state]);

    expect(() => reconcileWorktrees(fixture.main)).toThrow(
      "source events schema v5 has invalid missing-CWD state",
    );
    expect(existsSync(fixture.sourceEvents)).toBe(true);
  });

  it("preserves surviving events whose pruned predecessor is no longer present", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
         session_id, seq, type, category, data, priority, source_hook, created_at
       ) VALUES('source', 4, 'decision', 'surviving-parent', '{}', 1,
         'PostToolUse', '2026-01-04')`,
    ).run();
    const survivingParentId = Number(
      (source.prepare(
        "SELECT event_id FROM events WHERE session_id = 'source' AND seq = 4",
      ).get() as { event_id: number }).event_id,
    );
    source.prepare(
      `INSERT INTO events(
         session_id, seq, type, category, data, priority, source_hook,
         prev_event_id, created_at
       ) VALUES('source', 5, 'decision', 'surviving-child', '{}', 1,
         'PostToolUse', ?, '2026-01-05')`,
    ).run(survivingParentId);
    source.prepare(
      "DELETE FROM events WHERE session_id = 'source' AND seq = 1",
    ).run();
    source.close();

    expect(reconcileWorktrees(linked).status).toBe("completed");
    const target = new DatabaseSync(targetEvents, { readOnly: true });
    expect(target.prepare(
      "SELECT prev_event_id FROM events WHERE session_id = 'source' AND seq = 2",
    ).get()).toEqual({ prev_event_id: null });
    expect(target.prepare(
      `SELECT child.prev_event_id, parent.event_id
         FROM events child
         JOIN events parent
           ON parent.session_id = child.session_id
          AND parent.seq = 4
        WHERE child.session_id = 'source' AND child.seq = 5`,
    ).get()).toEqual(expect.objectContaining({
      prev_event_id: expect.any(Number),
      event_id: expect.any(Number),
    }));
    const internal = target.prepare(
      `SELECT child.prev_event_id, parent.event_id
         FROM events child
         JOIN events parent
           ON parent.session_id = child.session_id
          AND parent.seq = 4
        WHERE child.session_id = 'source' AND child.seq = 5`,
    ).get() as { prev_event_id: number; event_id: number };
    expect(internal.prev_event_id).toBe(internal.event_id);
    expect(target.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 6 });
    target.close();
  });

  it("fails closed when a present predecessor has not been mapped yet", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(sourceEvents, "future-predecessor");
    const source = new DatabaseSync(sourceEvents);
    source.prepare(
      "UPDATE events SET prev_event_id = 2 WHERE event_id = 1",
    ).run();
    source.close();

    expect(() => reconcileWorktrees(main)).toThrow(
      "event 1 references an unmapped predecessor 2",
    );
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  });

  it("archives event WAL and SHM sidecars when resuming after a verified merge", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makePrivateFixtureDirectory(join(sourceEvents, ".."), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writePrivateFixtureFile(`${sourceEvents}${suffix}`, suffix || "db");
    }
    const reconciliationRoot = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(reconciliationRoot, { recursive: true });
    writePrivateFixtureFile(join(reconciliationRoot, `${targetHash}.json`), JSON.stringify({
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

  it("preserves an archived event database when a hook recreates the retired source", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makeEvents(sourceEvents, "archived-generation");
    let recreated = false;

    expect(() => reconcileWorktrees(main, {
      now: new Date("2026-07-25T12:00:00Z"),
      _observer: (event, _source, detailPath) => {
        if (
          !recreated
          && event === "after-source-archive-rename"
          && detailPath?.includes("oldevents")
          && detailPath.endsWith(".db")
        ) {
          recreated = true;
          makeEvents(sourceEvents, "recreated-generation");
          throw new Error("crash after event archive before fence publication");
        }
      },
    })).toThrow("crash after event archive before fence publication");
    const blocked = listWorktreeReconciliationJournals()[0];
    const backup = blocked.backupPaths.find((path) => path.includes("oldevents"))!;
    const backupBefore = readFileSync(backup);
    const backupInode = statSync(backup).ino;
    expect(blocked).toMatchObject({
      phase: "blocked",
      blockedFrom: "merged",
      backupPaths: [backup],
    });

    expect(() => reconcileWorktrees(main)).toThrow(
      "legacy events archive destination is already occupied",
    );
    expect(statSync(backup).ino).toBe(backupInode);
    expect(readFileSync(backup).equals(backupBefore)).toBe(true);
    expect(statSync(sourceEvents).isFile()).toBe(true);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    const evidence = new DatabaseSync(backup, { readOnly: true });
    expect(evidence.prepare(
      "SELECT session_id FROM events WHERE session_id = 'archived-generation'",
    ).get()).toEqual({ session_id: "archived-generation" });
    expect(evidence.prepare(
      "SELECT session_id FROM events WHERE session_id = 'recreated-generation'",
    ).get()).toBeUndefined();
    evidence.close();
    const target = new DatabaseSync(
      join(home, ".lcm", "events", `${targetHash}.db`),
      { readOnly: true },
    );
    expect(target.prepare(
      "SELECT session_id FROM events WHERE session_id = 'archived-generation'",
    ).get()).toEqual({ session_id: "archived-generation" });
    expect(target.prepare(
      "SELECT session_id FROM events WHERE session_id = 'recreated-generation'",
    ).get()).toBeUndefined();
    target.close();
  });

  it.each(["", "-wal", "-shm"])(
    "never replaces an occupied journaled event backup for sidecar %s",
    (suffix) => {
      const { main, linked } = makeRepository(home);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
        [targetHash]: { canonical, aliases: [] },
        [sourceHash]: { canonical: linked, aliases: [] },
      }, null, 2)}\n`);
      clearProjectMapCache();
      const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
      const archiveAt = "2026-07-25T12:00:00.000Z";
      const destination = join(
        home,
        ".lcm",
        "oldevents",
        `${sourceHash}-2026-07-25T12-00-00-000Z.db${suffix}`,
      );
      makePrivateFixtureDirectory(join(sourceEvents, ".."), { recursive: true });
      makePrivateFixtureDirectory(join(destination, ".."), { recursive: true });
      writePrivateFixtureFile(`${sourceEvents}${suffix}`, `recreated${suffix}`);
      writePrivateFixtureFile(destination, `preserved${suffix}`);
      const destinationInode = statSync(destination).ino;
      const reconciliationRoot = join(home, ".lcm", "reconciliations");
      makePrivateFixtureDirectory(reconciliationRoot, { recursive: true });
      writePrivateFixtureFile(join(reconciliationRoot, `${targetHash}.json`), JSON.stringify({
        version: 1,
        targetHash,
        canonical,
        sourceHashes: [sourceHash],
        pendingSourceHashes: [sourceHash],
        aliases: [canonical, linked],
        createdAt: archiveAt,
        updatedAt: archiveAt,
        archiveAt,
        phase: "merged",
        backupPaths: [destination],
        sourceComponents: {
          [sourceHash]: {
            projectDb: false,
            eventsDb: suffix === "",
            patterns: false,
          },
        },
      }));

      expect(() => reconcileWorktrees(main)).toThrow(
        "legacy events archive destination is already occupied",
      );
      expect(statSync(destination).ino).toBe(destinationInode);
      expect(readFileSync(destination, "utf8")).toBe(`preserved${suffix}`);
      expect(readFileSync(`${sourceEvents}${suffix}`, "utf8")).toBe(`recreated${suffix}`);
      expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    },
  );

  it.each([
    {
      state: "invalid source",
      expectedError: "invalid legacy events state path",
    },
    {
      state: "invalid destination",
      expectedError: "legacy events archive destination is already occupied",
    },
    {
      state: "raced destination",
      expectedError: "legacy events archive destination is already occupied",
    },
  ])("fails closed for an $state event sidecar archive", ({
    state,
    expectedError,
  }) => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    const sourceSidecar = `${sourceEvents}-wal`;
    const archiveAt = "2026-07-25T12:00:00.000Z";
    const destination = join(
      home,
      ".lcm",
      "oldevents",
      `${sourceHash}-2026-07-25T12-00-00-000Z.db-wal`,
    );
    makePrivateFixtureDirectory(join(sourceSidecar, ".."), { recursive: true });
    makePrivateFixtureDirectory(join(destination, ".."), { recursive: true });
    if (state === "invalid source") makePrivateFixtureDirectory(sourceSidecar);
    else writePrivateFixtureFile(sourceSidecar, "source wal");
    if (state === "invalid destination") makePrivateFixtureDirectory(destination);
    const reconciliationRoot = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(reconciliationRoot, { recursive: true });
    writePrivateFixtureFile(join(reconciliationRoot, `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      pendingSourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: archiveAt,
      updatedAt: archiveAt,
      archiveAt,
      phase: "merged",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: false, eventsDb: false, patterns: false },
      },
    }));

    expect(() => reconcileWorktrees(main, {
      _observer: (event, _source, detailPath) => {
        if (
          state === "raced destination"
          && event === "before-source-archive-rename"
          && detailPath === destination
        ) {
          writePrivateFixtureFile(destination, "raced backup");
        }
      },
    })).toThrow(expectedError);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
    if (state === "raced destination") {
      expect(readFileSync(destination, "utf8")).toBe("raced backup");
      expect(readFileSync(sourceSidecar, "utf8")).toBe("source wal");
    }
  });

  it("resumes an event archive interrupted after the exclusive backup link", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceEvents = join(home, ".lcm", "events", `${sourceHash}.db`);
    makePrivateFixtureDirectory(join(sourceEvents, ".."), { recursive: true });
    writePrivateFixtureFile(sourceEvents, "event evidence");
    const archiveAt = "2026-07-25T12:00:00.000Z";
    const reconciliationRoot = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(reconciliationRoot, { recursive: true });
    writePrivateFixtureFile(join(reconciliationRoot, `${targetHash}.json`), JSON.stringify({
      version: 1,
      targetHash,
      canonical,
      sourceHashes: [sourceHash],
      pendingSourceHashes: [sourceHash],
      aliases: [canonical, linked],
      createdAt: archiveAt,
      updatedAt: archiveAt,
      archiveAt,
      phase: "merged",
      backupPaths: [],
      sourceComponents: {
        [sourceHash]: { projectDb: false, eventsDb: true, patterns: false },
      },
    }));
    let interrupted = false;
    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (!interrupted && event === "after-source-archive-link") {
          interrupted = true;
          throw new Error("crash after exclusive event archive link");
        }
      },
    })).toThrow("crash after exclusive event archive link");
    const backup = listWorktreeReconciliationJournals()[0].backupPaths
      .find((path) => path.includes("oldevents"))!;
    expect(statSync(sourceEvents).ino).toBe(statSync(backup).ino);

    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(readFileSync(backup, "utf8")).toBe("event evidence");
    expect(statSync(sourceEvents).isDirectory()).toBe(true);
    expect(listProjectMapEntries()).not.toHaveProperty(sourceHash);
  });

  it("rejects symlink source state and malformed journals", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    writePrivateFixtureFile(join(home, "outside.db"), "not sqlite");
    symlinkSync(join(home, "outside.db"), join(sourceDir, "db.sqlite"));
    expect(() => reconcileWorktrees(linked)).toThrow("refusing to reconcile symlink");

    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    makePrivateFixtureDirectory(join(home, ".lcm", "reconciliations"), { recursive: true });
    writePrivateFixtureFile(
      join(home, ".lcm", "reconciliations", `${targetHash}.json`),
      "{}",
    );
    expect(() => reconcileWorktrees(linked)).toThrow("journal is malformed");
    writePrivateFixtureFile(
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
    writePrivateFixtureFile(join(home, ".lcm", "reconciliations", "ignored.txt"), "{}");
    makePrivateFixtureDirectory(join(home, ".lcm", "reconciliations", `${"f".repeat(64)}.json`));
    writePrivateFixtureFile(
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    writePrivateFixtureFile(join(sourceDir, "sensitive-patterns.txt"), "\n");

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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    writePrivateFixtureFile(
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const targetPath = join(targetDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(targetPath, "# target heading\n  DUPLICATE  ");
    writePrivateFixtureFile(
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const targetPath = join(targetDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(targetPath, "# keep formatting\n  SAME_PATTERN  \n");
    writePrivateFixtureFile(
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const root = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(root, { recursive: true });
    writePrivateFixtureFile(join(root, `${targetHash}.json`), JSON.stringify({
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
    makePrivateFixtureDirectory(root, { recursive: true });
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
      writePrivateFixtureFile(path, JSON.stringify(journal));
      expect(() => listWorktreeReconciliationJournals()).toThrow("journal is malformed");
    }
    writePrivateFixtureFile(path, "{");
    expect(() => listWorktreeReconciliationJournals()).toThrow(SyntaxError);
  });

  it("filters a journal removed after directory enumeration", async () => {
    const root = join(home, ".lcm", "reconciliations");
    const targetHash = "a".repeat(64);
    const path = join(root, `${targetHash}.json`);
    makePrivateFixtureDirectory(root, { recursive: true });
    writePrivateFixtureFile(path, JSON.stringify({
      version: 1,
      targetHash,
      canonical: "/project",
      sourceHashes: [],
      aliases: ["/project"],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      phase: "completed",
      backupPaths: [],
    }));

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      let removed = false;
      return {
        ...actual,
        readdirSync: ((directory: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
          const entries = actual.readdirSync(directory, options as never);
          if (!removed && String(directory) === root) {
            removed = true;
            actual.rmSync(path);
          }
          return entries;
        }) as typeof actual.readdirSync,
      };
    });
    try {
      const isolated = await import("../src/worktree-reconciliation.js");
      expect(isolated.listWorktreeReconciliationJournals()).toEqual([]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("accepts a legacy empty database without optional bookkeeping tables", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makePrivateFixtureDirectory(join(sourcePath, ".."), { recursive: true });
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
  }, 15_000);

  it("fences already-open legacy writers before archiving their database inodes", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("commits the source fence before making the target marker durable", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("fails closed while a legacy writer transaction is active and retries after quiescence", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, 10_000);

  it("rediscovers mapped sources after a completed no-op journal", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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

    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, FULL_SUITE_NOOP_JOURNAL_REDISCOVERY_TEST_TIMEOUT_MS);

  it("invalidates tombstone discovery without rescanning unchanged Codex history", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const deleted = join(home, ".codex", "worktrees", "late-token", "lcm");
    const sourceHash = hashProjectPath(deleted);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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

    makePrivateFixtureDirectory(deleted, { recursive: true });
    expect(reconcileWorktrees(main, {
      _codexDir: join(home, ".codex"),
      _historicalResolver: historical,
    }).status).toBe("completed");
    expect(scans).toBe(2);

    const lock = join(home, ".lcm", "reconciliations", `${targetHash}.lock`);
    writePrivateFixtureFile(lock, "malformed lock that must remain unread\n");
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
    makePrivateFixtureDirectory(join(codexDir, "worktrees"), { recursive: true });
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(sessions, { recursive: true });
    const transcript = join(sessions, "session.jsonl");
    writePrivateFixtureFile(transcript, "first\n");
    let scans = 0;
    const historical = () => {
      scans += 1;
      return { hashes: [], aliases: [] };
    };
    expect(reconcileWorktrees(main, {
      _codexDir: codexDir,
      _historicalResolver: historical,
    }).status).toBe("not-needed");
    writePrivateFixtureFile(transcript, "first\nsecond\n");
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
    makePrivateFixtureDirectory(join(alternateHome, ".lcm"), { recursive: true });
    writePrivateFixtureFile(projectMapPath(alternateHome), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("never archives a component that appeared after the merge snapshot", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(sourcePatterns, "ORIGINAL_PATTERN\n");

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "after-merge-before-archive") {
          writePrivateFixtureFile(sourcePatterns, "CHANGED_PATTERN\n");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const targetPatterns = join(targetDir, "sensitive-patterns.txt");
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(targetPatterns, "TARGET_PATTERN\n");
    writePrivateFixtureFile(sourcePatterns, "ORIGINAL_PATTERN\n");
    let mutated = false;

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (!mutated && event === "before-source-patterns-merge") {
          mutated = true;
          writePrivateFixtureFile(sourcePatterns, "CHANGED_PATTERN\n");
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

    writePrivateFixtureFile(sourcePatterns, "ORIGINAL_PATTERN\n");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const targetDir = join(home, ".lcm", "projects", targetHash);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(targetDir, { recursive: true });
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const targetPatterns = join(targetDir, "sensitive-patterns.txt");
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(targetPatterns, "TARGET_PATTERN\n");
    if (initial !== undefined) writePrivateFixtureFile(sourcePatterns, initial);

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event !== "before-source-patterns-merge") return;
        if (initial === undefined) writePrivateFixtureFile(sourcePatterns, "LATE_PATTERN\n");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    writePrivateFixtureFile(sourcePatterns, "ORIGINAL_PATTERN\n");
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
          writePrivateFixtureFile(sourcePatterns, "LATE_PATTERN\n");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makePrivateFixtureDirectory(sourceDir, { recursive: true });
    const sourcePatterns = join(sourceDir, "sensitive-patterns.txt");
    if (initial !== undefined) writePrivateFixtureFile(sourcePatterns, initial);

    expect(() => reconcileWorktrees(main, {
      _observer: (event, _source, detailPath) => {
        if (
          event !== "before-source-archive-rename"
          || !detailPath?.includes("oldprojects")
        ) return;
        if (initial === undefined) writePrivateFixtureFile(sourcePatterns, "LATE_PATTERN\n");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
      writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
        writePrivateFixtureFile(
          join(prepared, "fence.json"),
          `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
        );
      } else if (markerState === "unreadable") {
        makePrivateFixtureDirectory(join(prepared, "fence.json"));
      } else if (markerState === "malformed") {
        writePrivateFixtureFile(join(prepared, "fence.json"), "{");
      } else {
        writePrivateFixtureFile(join(prepared, "unexpected"), "unexpected");
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(join(lock, ".."), { recursive: true });
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
        )).toThrow("backend publication mutation is already in progress");
        throw new Error("abort after verified map fence");
      },
    })).toThrow("abort after verified map fence");
    expect(existsSync(sourcePath)).toBe(true);
    expect(listProjectMapEntries()).toHaveProperty(sourceHash);
  });

  it("rethrows publication errors without converting reconciliation state to blocked", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "publication-error", "content", sourceHash);
    const publicationError = new BackendPublicationJournalError(
      "unresolved-publication",
      "reconciliation publication state is unresolved",
    );

    expect(() => reconcileWorktrees(main, {
      _observer: (event) => {
        if (event === "before-source-main-merge") throw publicationError;
      },
    })).toThrow("reconciliation publication state is unresolved");
    expect(listWorktreeReconciliationJournals()).toEqual(expect.any(Array));
  });

  it("handles bounded catalogue entries, non-Git paths, and catalogue failures", () => {
    const nonGit = join(home, "not-git");
    makePrivateFixtureDirectory(nonGit);
    expect(reconcileWorktrees(nonGit)).toMatchObject({
      status: "not-needed",
      canonical: nonGit,
    });
    expect(projectDbPath(nonGit)).toBe(
      join(home, ".lcm", "projects", hashProjectPath(nonGit), "db.sqlite"),
    );
    expect(ensureWorktreeProjectReconciled(nonGit, {
      id: hashProjectPath(nonGit),
      canonical: nonGit,
    }).status).toBe("not-needed");

    const { main } = makeRepository(home);
    const codexDir = join(home, ".codex");
    const worktrees = join(codexDir, "worktrees");
    makePrivateFixtureDirectory(worktrees, { recursive: true });
    writePrivateFixtureFile(join(worktrees, "plain"), "plain");
    symlinkSync(join(worktrees, "plain"), join(worktrees, "link"));
    makePrivateFixtureDirectory(join(worktrees, "one", "two", "three"), { recursive: true });
    symlinkSync(join(worktrees, "plain"), join(codexDir, "sessions"));
    writePrivateFixtureFile(join(codexDir, "archived_sessions"), "plain");
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
    writePrivateFixtureFile(regularFile, "not a directory");
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [join(regularFile, "child")] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main, { dryRun: true })).toThrow("ENOTDIR");
  });

  it("fingerprints a foreign ENOTDIR path as unavailable and invalidates on repair", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const identity = { id: targetHash, canonical };
    const regularFile = join(home, "foreign-regular-file");
    const foreign = join(regularFile, "child");
    const foreignHash = hashProjectPath(foreign);
    writePrivateFixtureFile(regularFile, "not a directory");
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [foreignHash]: { canonical: foreign, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();

    expect(reconcileWorktrees(main, {
      _historicalResolver: () => ({ hashes: [], aliases: [] }),
    }).status).toBe("not-needed");
    const unavailableFingerprint = listWorktreeReconciliationJournals()[0]
      .discovery!.mapFingerprint;

    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 10,
      _nowMs: 0,
    }).status).toBe("not-needed");
    rmSync(regularFile);
    makePrivateFixtureDirectory(foreign, { recursive: true });
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 10,
      _nowMs: 20,
    }).status).toBe("not-needed");
    expect(listWorktreeReconciliationJournals()[0].discovery!.mapFingerprint)
      .not.toBe(unavailableFingerprint);
  });

  it("strictly validates ENOTDIR aliases for a related source before merging it", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const regularFile = join(home, "related-regular-file");
    const invalidAlias = join(regularFile, "child");
    writePrivateFixtureFile(regularFile, "not a directory");
    const mapBefore = `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [invalidAlias] },
    }, null, 2)}\n`;
    writePrivateFixtureFile(projectMapPath(), mapBefore);
    clearProjectMapCache();
    const sourcePath = join(home, ".lcm", "projects", sourceHash, "db.sqlite");
    makeDatabase(sourcePath, "related-enotdir", "source", sourceHash);

    expect(() => reconcileWorktrees(main)).toThrow("ENOTDIR");

    expect(readFileSync(projectMapPath(), "utf8")).toBe(mapBefore);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(join(home, ".lcm", "projects", targetHash))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldprojects"))).toBe(false);
    expect(existsSync(join(home, ".lcm", "oldevents"))).toBe(false);
    expect(listWorktreeReconciliationJournals()).toMatchObject([{
      phase: "blocked",
      blockedFrom: "planned",
      sourceHashes: [],
    }]);
  });

  it("isolates malformed foreign Git metadata and invalidates its cached fingerprint on repair", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const identity = { id: targetHash, canonical };
    const foreign = join(home, "foreign-malformed");
    const foreignGitTarget = join(home, "foreign-git-target");
    makePrivateFixtureDirectory(foreign);
    makePrivateFixtureDirectory(foreignGitTarget);
    symlinkSync(foreignGitTarget, join(foreign, ".git"));
    const foreignHash = hashProjectPath(foreign);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [foreignHash]: { canonical: foreign, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();

    expect(reconcileWorktrees(main, {
      _historicalResolver: () => ({ hashes: [], aliases: [] }),
    }).status).toBe("not-needed");
    const malformedFingerprint = listWorktreeReconciliationJournals()[0]
      .discovery!.mapFingerprint;

    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 10,
      _nowMs: 0,
    }).status).toBe("not-needed");
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 10,
      _nowMs: 20,
    }).status).toBe("completed");
    expect(listWorktreeReconciliationJournals()[0].discovery!.mapFingerprint)
      .toBe(malformedFingerprint);

    rmSync(join(foreign, ".git"));
    git(foreign, "init", "-q");
    clearGitProjectAnchorCache();
    expect(ensureWorktreeProjectReconciled(main, identity, {
      _cacheTtlMs: 10,
      _nowMs: 40,
    }).status).toBe("not-needed");
    expect(listWorktreeReconciliationJournals()[0].discovery!.mapFingerprint)
      .not.toBe(malformedFingerprint);
  });

  it("continues to reject malformed Git metadata for the current project", () => {
    const current = join(home, "current-malformed");
    const gitTarget = join(home, "current-git-target");
    makePrivateFixtureDirectory(current);
    makePrivateFixtureDirectory(gitTarget);
    symlinkSync(gitTarget, join(current, ".git"));

    expect(() => reconcileWorktrees(current)).toThrow(/refusing symlink/u);
    expect(() => ensureWorktreeProjectReconciled(current)).toThrow(/refusing symlink/u);
    expect(() => projectIdentity(current)).toThrow(/refusing symlink/u);
  });

  it("fingerprints symlink, file, and missing project-map paths", () => {
    const { main } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const file = join(home, "map-file");
    const link = join(home, "map-link");
    writePrivateFixtureFile(file, "file");
    symlinkSync(file, link);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(journalPath, JSON.stringify(journal));
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
    writePrivateFixtureFile(journalPath, journalBeforeGuardRace);
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

    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(tokenDir, { recursive: true });
    const archived = join(codexDir, "archived_sessions");
    makePrivateFixtureDirectory(archived, { recursive: true });
    writePrivateFixtureFile(join(archived, "cache-late.jsonl"), `${JSON.stringify({
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
    makePrivateFixtureDirectory(worktrees, { recursive: true });
    for (let index = 0; index < 50_000; index += 1) {
      makePrivateFixtureDirectory(join(worktrees, `entry-${index}`));
    }
    expect(ensureWorktreeProjectReconciled(main, identity).status).toBe("not-needed");
    expect(ensureWorktreeProjectReconciled(main, identity).status).toBe("not-needed");
  }, 15_000);

  it("re-fences source stores when target merge markers already exist", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
  }, FULL_SUITE_SOURCE_STORE_REFENCING_TEST_TIMEOUT_MS);

  it("fails closed when a planned source disappears or its binding changes", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const remoteProjectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
    const root = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(root, { recursive: true });
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
    }, null, 2)}\n`);
    writePrivateFixtureFile(join(root, `${targetHash}.json`), JSON.stringify(baseJournal));
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main)).toThrow("source disappeared before merge");

    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    makePrivateFixtureDirectory(root, { recursive: true });
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: {
        canonical,
        aliases: [],
        remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    writePrivateFixtureFile(join(root, `${targetHash}.json`), JSON.stringify({
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
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
          writePrivateFixtureFile(source!.projectDir, "raced");
        }
      },
    })).toThrow("legacy project path was recreated");

    rmSync(join(home, ".lcm", "reconciliations"), { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
    makeDatabase(join(sourceDir, "db.sqlite"), "events-recreated", "content", sourceHash);
    expect(() => reconcileWorktrees(main, {
      _observer: (event, source) => {
        if (event === "before-events-path-fence") {
          makePrivateFixtureDirectory(source!.eventsPath, { recursive: true });
        }
      },
    })).toThrow("legacy events path was recreated");
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);

  it("validates journal component snapshots before merging", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    const root = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(root, { recursive: true });
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
    writePrivateFixtureFile(journalPath, JSON.stringify(base));
    clearProjectMapCache();
    expect(() => reconcileWorktrees(main)).toThrow("lacks a component snapshot");

    writePrivateFixtureFile(join(sourceDir, "sensitive-patterns.txt"), "PATTERN\n");
    writePrivateFixtureFile(journalPath, JSON.stringify({
      ...base,
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: true } },
    }));
    expect(() => reconcileWorktrees(main)).toThrow("lacks a patterns digest");

    rmSync(join(sourceDir, "db.sqlite"));
    rmSync(join(sourceDir, "sensitive-patterns.txt"));
    writePrivateFixtureFile(journalPath, JSON.stringify({
      ...base,
      phase: "planned",
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: false } },
    }));
    expect(() => reconcileWorktrees(main)).toThrow("component disappeared before merge");

    makeDatabase(join(sourceDir, "db.sqlite"), "snapshot", "content", sourceHash);
    writePrivateFixtureFile(join(sourceDir, "sensitive-patterns.txt"), "PATTERN\n");
    writePrivateFixtureFile(journalPath, JSON.stringify({
      ...base,
      phase: "planned",
      sourceComponents: { [sourceHash]: { projectDb: true, eventsDb: false, patterns: true } },
    }));
    expect(reconcileWorktrees(main).status).toBe("completed");
    expect(listWorktreeReconciliationJournals()[0].sourceComponents?.[sourceHash])
      .toMatchObject({ patternsDigest: expect.any(String) });
  }, FULL_SUITE_SNAPSHOT_VALIDATION_TEST_TIMEOUT_MS);

  it("accepts complete planned component snapshots before merging", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    const sourceDir = join(home, ".lcm", "projects", sourceHash);
    makeDatabase(join(sourceDir, "db.sqlite"), "merged-snapshot", "content", sourceHash);
    makeEvents(join(home, ".lcm", "events", `${sourceHash}.db`), "merged-snapshot");
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    makePrivateFixtureDirectory(join(home, ".lcm", "reconciliations"), { recursive: true });
    writePrivateFixtureFile(join(home, ".lcm", "reconciliations", `${targetHash}.json`), JSON.stringify({
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
  }, FULL_SUITE_SNAPSHOT_VALIDATION_TEST_TIMEOUT_MS);

  it("rejects invalid retired project and events fence paths on archive resume", () => {
    const { main, linked } = makeRepository(home);
    const canonical = resolveGitProjectAnchor(main)!.canonical;
    const targetHash = hashProjectPath(canonical);
    const sourceHash = hashProjectPath(linked);
    writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
      [targetHash]: { canonical, aliases: [] },
      [sourceHash]: { canonical: linked, aliases: [] },
    }, null, 2)}\n`);
    clearProjectMapCache();
    const root = join(home, ".lcm", "reconciliations");
    makePrivateFixtureDirectory(root, { recursive: true });
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
    makePrivateFixtureDirectory(join(sourceDir, ".."), { recursive: true });
    writePrivateFixtureFile(sourceDir, "invalid project fence");
    writePrivateFixtureFile(journalPath, JSON.stringify(journal));
    expect(() => reconcileWorktrees(main)).toThrow("invalid legacy project state path");

    rmSync(sourceDir, { force: true });
    const eventsPath = join(home, ".lcm", "events", `${sourceHash}.db`);
    for (const markerState of [
      "missing",
      "unreadable",
      "malformed",
      "unexpected-entry",
      "oversized",
      "symlinked",
    ]) {
      rmSync(eventsPath, { recursive: true, force: true });
      makePrivateFixtureDirectory(eventsPath, { recursive: true });
      if (markerState === "unreadable") {
        makePrivateFixtureDirectory(join(eventsPath, "fence.json"));
      } else if (markerState === "malformed") {
        writePrivateFixtureFile(join(eventsPath, "fence.json"), "{");
      } else if (markerState === "unexpected-entry") {
        writePrivateFixtureFile(
          join(eventsPath, "fence.json"),
          `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
        );
        writePrivateFixtureFile(join(eventsPath, "unexpected"), "entry");
      } else if (markerState === "oversized") {
        writePrivateFixtureFile(join(eventsPath, "fence.json"), "x".repeat(1025));
      } else if (markerState === "symlinked") {
        const markerTarget = join(home, `${sourceHash}-fence-target`);
        writePrivateFixtureFile(
          markerTarget,
          `${JSON.stringify({ version: 1, hash: sourceHash, kind: "events" })}\n`,
        );
        symlinkSync(markerTarget, join(eventsPath, "fence.json"));
      }
      writePrivateFixtureFile(journalPath, JSON.stringify(journal));
      expect(() => reconcileWorktrees(main)).toThrow("invalid legacy events state path");
    }
  });

  it("rejects retired paths recreated between archival and fence publication", () => {
    const setup = (suffix: string) => {
      const root = join(home, suffix);
      makePrivateFixtureDirectory(root);
      const { main, linked } = makeRepository(root);
      const canonical = resolveGitProjectAnchor(main)!.canonical;
      const targetHash = hashProjectPath(canonical);
      const sourceHash = hashProjectPath(linked);
      writePrivateFixtureFile(projectMapPath(), `${JSON.stringify({
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
          writePrivateFixtureFile(source!.projectDir, "recreated after archive");
        }
      },
    })).toThrow("legacy project path remained writable");

    rmSync(join(home, ".lcm"), { recursive: true, force: true });
    makePrivateFixtureDirectory(join(home, ".lcm"), { recursive: true });
    clearProjectMapCache();
    clearWorktreeReconciliationCache();
    const eventsRace = setup("events-path-race");
    expect(() => reconcileWorktrees(eventsRace.main, {
      _observer: (event, source) => {
        if (event === "before-project-path-fence") {
          makePrivateFixtureDirectory(source!.eventsPath, { recursive: true });
          writePrivateFixtureFile(join(source!.eventsPath, "fence.json"), "recreated after archive");
        }
      },
    })).toThrow("legacy events path remained writable");
  }, FULL_SUITE_PROCESS_TEST_TIMEOUT_MS);
});
