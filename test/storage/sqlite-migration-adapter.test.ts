import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SQLITE_MIGRATION_SCHEMA_MANIFEST_SHA256,
  SQLITE_MIGRATION_TABLES,
  SQLITE_MIGRATION_TEST_SEAMS,
  SqliteMigrationReader,
  SqliteMigrationWriter,
  createSqliteMigrationSnapshot,
  lastCanonicalKey,
  type MigrationRow,
} from "../../src/storage/sqlite/migration-adapter.js";
import type { MigrationFileFingerprint } from "../../src/storage/migration-manifest.js";

const roots: string[] = [];
const now = "2026-08-01T12:00:00.000Z";
const partId = "018f1234-5678-7abc-8def-0123456789ab";
const memoryId = "018f1234-5678-7abc-8def-0123456789ac";

function privateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-sqlite-migration-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function migrationRows(): Readonly<Record<string, readonly MigrationRow[]>> {
  return {
    conversations: [{ conversation_id: 1, session_id: "session", title: null, bootstrapped_at: null, created_at: now, updated_at: now }],
    messages: [{ message_id: 1, conversation_id: 1, seq: 0, role: "user", content: "hello", token_count: 1, created_at: now }],
    message_parts: [{
      part_id: partId,
      message_id: 1,
      session_id: "session",
      part_type: "tool",
      ordinal: 0,
      text_content: "visible",
      is_ignored: false,
      is_synthetic: true,
      tool_call_id: "call",
      tool_name: "tool",
      tool_status: "completed",
      tool_input: "{}",
      tool_output: "ok",
      tool_error: null,
      tool_title: "title",
      patch_hash: "patch",
      patch_files: "[]",
      file_mime: "text/plain",
      file_name: "file.txt",
      file_url: "private://file",
      subtask_prompt: "prompt",
      subtask_desc: "description",
      subtask_agent: "agent",
      step_reason: "reason",
      step_cost: 1.5,
      step_tokens_in: 2,
      step_tokens_out: 3,
      snapshot_hash: "snapshot",
      compaction_auto: false,
      metadata: "{}",
    }, {
      part_id: "018f1234-5678-7abc-8def-0123456789ad",
      message_id: 1,
      session_id: "session",
      part_type: "text",
      ordinal: 1,
      text_content: null,
      is_ignored: null,
      is_synthetic: null,
      tool_call_id: null,
      tool_name: null,
      tool_status: null,
      tool_input: null,
      tool_output: null,
      tool_error: null,
      tool_title: null,
      patch_hash: null,
      patch_files: null,
      file_mime: null,
      file_name: null,
      file_url: null,
      subtask_prompt: null,
      subtask_desc: null,
      subtask_agent: null,
      step_reason: null,
      step_cost: null,
      step_tokens_in: null,
      step_tokens_out: null,
      snapshot_hash: null,
      compaction_auto: null,
      metadata: null,
    }],
    summaries: [
      { summary_id: "summary-parent", conversation_id: 1, kind: "leaf", depth: 0, content: "parent", token_count: 1, earliest_at: now, latest_at: now, descendant_count: 0, descendant_token_count: 0, source_message_token_count: 1, created_at: now },
      { summary_id: "summary-child", conversation_id: 1, kind: "condensed", depth: 1, content: "child", token_count: 1, earliest_at: now, latest_at: now, descendant_count: 1, descendant_token_count: 1, source_message_token_count: 1, created_at: now },
    ],
    summary_messages: [{ summary_id: "summary-parent", message_id: 1, ordinal: 0 }],
    summary_parents: [{ summary_id: "summary-child", parent_summary_id: "summary-parent", ordinal: 0 }],
    context_items: [
      { conversation_id: 1, ordinal: 0, item_type: "message", message_id: 1, summary_id: null, created_at: now },
      { conversation_id: 1, ordinal: 1, item_type: "summary", message_id: null, summary_id: "summary-parent", created_at: now },
    ],
    large_files: [{ file_id: "file-1", conversation_id: 1, file_name: "file.txt", mime_type: "text/plain", byte_size: 4, storage_uri: "private://file", exploration_summary: null, created_at: now }],
    summary_large_files: [{ summary_id: "summary-parent", file_ids: ["file-1"] }],
    promoted_memories: [{ memory_id: memoryId, content: "memory", metadata: { source: "test" }, source_summary_id: "summary-parent", source_project_id: "local", session_id: "session", depth: 1, confidence: 0.75, created_at: now, archived_at: null }],
    promoted_memory_tags: [{ memory_id: memoryId, tags: ["one", "two"] }],
    recall_surfacing: [{ surfacing_id: 1, memory_id: memoryId, session_id: null, surfaced_at: now }],
    redaction_counters: [{ project_id: "local", category: "built_in", count: 2 }],
    session_ingest_log: [{ session_id: "session", message_count: 1, completed_at: now }],
    session_instructions: [{ project_id: "local", scope_hash: "a".repeat(64), client_name: "codex", session_id: "session", worktree_path: "/workspace", cwd_path: "/workspace", content: "instructions", content_hash: "b".repeat(64), updated_at: now }],
  };
}

function createPopulatedDatabase(path: string): ReturnType<SqliteMigrationWriter["verify"]> {
  const writer = new SqliteMigrationWriter(path);
  for (const { name } of SQLITE_MIGRATION_TABLES) writer.writeBatch(name, migrationRows()[name]!);
  const inventory = writer.verify();
  writer.checkpointAndClose();
  writer.checkpointAndClose();
  return inventory;
}

function fingerprint(overrides: Partial<MigrationFileFingerprint> = {}): MigrationFileFingerprint {
  return { path: "/private/file", device: 1, inode: 2, size: 3, mtimeMs: 4, sha256: "a".repeat(64), ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite migration normalization", () => {
  it("normalizes supported values and rejects malformed SQLite data", () => {
    const seam = SQLITE_MIGRATION_TEST_SEAMS;
    expect(seam.text("text", "field")).toBe("text");
    expect(seam.nullableText(null, "field")).toBeNull();
    expect(seam.nullableText("text", "field")).toBe("text");
    expect(seam.integer(1, "field")).toBe(1);
    expect(seam.nullableInteger(null, "field")).toBeNull();
    expect(seam.nullableInteger(1, "field")).toBe(1);
    expect(seam.finite(1.5, "field")).toBe(1.5);
    expect(seam.nullableBoolean(null, "field")).toBeNull();
    expect(seam.nullableBoolean(0, "field")).toBe(false);
    expect(seam.nullableBoolean(1, "field")).toBe(true);
    expect(seam.timestamp(null, "field")).toBeNull();
    expect(seam.timestamp("2026-08-01 12:00:00", "field")).toBe(now);
    expect(seam.timestamp(now, "field")).toBe(now);
    expect(seam.json('{"z":1,"a":2}', "field")).toEqual({ a: 2, z: 1 });
    expect(seam.baseRow({ nil: null, text: "x", boolean: true, number: 1 })).toEqual({ nil: null, text: "x", boolean: true, number: 1 });
    expect(seam.sqliteValue(null)).toBeNull();
    expect(seam.sqliteValue("text")).toBe("text");
    expect(seam.sqliteValue(1)).toBe(1);
    expect(seam.sqliteValue(false)).toBe(0);
    expect(seam.sqliteValue(true)).toBe(1);
    expect(seam.sqliteValue({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');

    expect(() => seam.text(1, "field")).toThrow("field is not valid text");
    expect(() => seam.text("bad\0text", "field")).toThrow("field is not valid text");
    expect(() => seam.integer(1.5, "field")).toThrow("field is not a safe integer");
    expect(() => seam.integer(Number.MAX_SAFE_INTEGER + 1, "field")).toThrow("field is not a safe integer");
    expect(() => seam.finite(Number.NaN, "field")).toThrow("field is not finite");
    expect(() => seam.finite("1", "field")).toThrow("field is not finite");
    expect(() => seam.nullableBoolean(2, "field")).toThrow("field is not a SQLite boolean");
    expect(() => seam.timestamp("not-a-date", "field")).toThrow("field is not a valid timestamp");
    expect(() => seam.json("not-json", "field")).toThrow();
    expect(() => seam.baseRow({ bad: 1n })).toThrow("bad has an unsupported SQLite migration value");
    expect(() => seam.baseRow({ bad: Number.POSITIVE_INFINITY })).toThrow("bad has an unsupported SQLite migration value");
  });

  it("routes logical source tables and rejects unknown descriptors", () => {
    const seam = SQLITE_MIGRATION_TEST_SEAMS;
    expect(seam.sourceTable("session_instructions")).toBe("session_instruction_cache");
    expect(seam.sourceTable("redaction_counters")).toBe("redaction_stats");
    expect(seam.sourceTable("promoted_memories")).toBe("promoted");
    expect(seam.sourceTable("promoted_memory_tags")).toBe("promoted");
    expect(seam.sourceTable("summary_large_files")).toBe("summaries");
    expect(seam.sourceTable("messages")).toBe("messages");
    expect(seam.descriptor("messages").name).toBe("messages");
    expect(() => seam.descriptor("unknown")).toThrow("unknown migration table: unknown");
    expect(SQLITE_MIGRATION_SCHEMA_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("detects source main and WAL drift deterministically", () => {
    const seam = SQLITE_MIGRATION_TEST_SEAMS;
    const main = fingerprint();
    const wal = fingerprint({ path: "/private/file-wal", inode: 3 });
    expect(() => seam.assertSourceUnchanged(main, wal, main, wal)).not.toThrow();
    expect(() => seam.assertSourceUnchanged(main, null, main, null)).not.toThrow();
    expect(() => seam.assertSourceUnchanged(main, wal, { ...main, sha256: "b".repeat(64) }, wal)).toThrow("SQLite source changed during backup");
    expect(() => seam.assertSourceUnchanged(main, wal, main, { ...wal, size: 9 })).toThrow("SQLite source changed during backup");
  });

  it("verifies integrity and foreign keys through deterministic database seams", () => {
    const database = (integrity: unknown[], foreignKeys: unknown[]) => ({
      prepare: vi.fn((sql: string) => ({ all: () => sql.includes("integrity") ? integrity : foreignKeys })),
    }) as unknown as DatabaseSync;
    expect(() => SQLITE_MIGRATION_TEST_SEAMS.assertSqliteIntegrity(database([{ integrity_check: "ok" }], []))).not.toThrow();
    expect(() => SQLITE_MIGRATION_TEST_SEAMS.assertSqliteIntegrity(database([], []))).toThrow("SQLite integrity verification failed");
    expect(() => SQLITE_MIGRATION_TEST_SEAMS.assertSqliteIntegrity(database([{ integrity_check: "bad" }], []))).toThrow("SQLite integrity verification failed");
    expect(() => SQLITE_MIGRATION_TEST_SEAMS.assertSqliteIntegrity(database([{ integrity_check: "ok" }], [{}]))).toThrow("SQLite foreign-key verification failed");
  });

  it("derives stable checkpoint keys for scalars and composite values", () => {
    expect(lastCanonicalKey({ key: null })).toEqual([null]);
    expect(lastCanonicalKey({ key: "text" })).toEqual(["text"]);
    expect(lastCanonicalKey({ key: 1 })).toEqual([1]);
    expect(lastCanonicalKey({ key: true })).toEqual([true]);
    expect(lastCanonicalKey({ key: { $integer: "123" } })).toEqual([{ $integer: "123" }]);
    expect(lastCanonicalKey({ key: ["composite"] })[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(lastCanonicalKey({ key: { nested: "value" } })[0]).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("SQLite migration reader and writer", () => {
  it("copies every logical table in dependency order with exact canonical inventory", () => {
    const root = privateDirectory();
    const path = join(root, "reverse.sqlite");
    const expected = createPopulatedDatabase(path);
    expect(expected.map(({ table }) => table)).toEqual(SQLITE_MIGRATION_TABLES.map(({ name }) => name));
    expect(expected.reduce((sum, table) => sum + table.rows, 0)).toBe(19);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}-wal`)).toBe(false);

    const reader = new SqliteMigrationReader(path);
    expect(reader.inventory()).toEqual(expected);
    expect(reader.readBatch("conversations", 0, 1)).toEqual(migrationRows().conversations);
    expect(reader.sample("messages", 1)).toEqual(migrationRows().messages);
    expect([...reader.iterate("summary_large_files")]).toEqual([
      { summary_id: "summary-child", file_ids: [] },
      ...migrationRows().summary_large_files!,
    ]);
    expect(reader.readBatch("messages", 99, 1)).toEqual([]);
    expect(() => reader.readBatch("messages", -1, 1)).toThrow("offset must be non-negative");
    expect(() => reader.readBatch("messages", 0.5, 1)).toThrow("offset must be non-negative");
    expect(() => reader.readBatch("messages", 0, 0)).toThrow("limit must be positive");
    expect(() => reader.readBatch("messages", 0, 1.5)).toThrow("limit must be positive");
    expect(() => reader.readBatch("unknown", 0, 1)).toThrow("unknown migration table: unknown");
    reader.close();
    reader.close();
    expect(() => reader.inventory()).toThrow("SQLite migration reader is closed");
    expect(() => reader.readBatch("messages", 0, 1)).toThrow("SQLite migration reader is closed");
    expect(() => [...reader.iterate("messages")]).toThrow("SQLite migration reader is closed");
  });

  it("rolls back divergent inserts and fails closed for unsupported mappings", () => {
    const root = privateDirectory();
    const path = join(root, "reverse.sqlite");
    const writer = new SqliteMigrationWriter(path);
    writer.writeBatch("conversations", []);
    writer.writeBatch("conversations", migrationRows().conversations!);
    expect(() => writer.writeBatch("conversations", migrationRows().conversations!)).toThrow();
    expect(() => writer.writeBatch("unknown", [{ value: "x" }])).toThrow("unsupported reverse SQLite table: unknown");
    expect(() => writer.writeBatch("promoted_memories", [{ memory_id: memoryId }])).toThrow("invalid column mapping for promoted_memories");
    expect(writer.verify().find(({ table }) => table === "conversations")?.rows).toBe(1);
    writer.close();
    writer.close();
    expect(() => writer.writeBatch("messages", [])).toThrow("SQLite migration writer is closed");
    expect(() => writer.verify()).toThrow("SQLite migration writer is closed");
  });

  it("rejects existing destinations and unsafe reverse directories", () => {
    const root = privateDirectory();
    const existing = join(root, "existing.sqlite");
    writeFileSync(existing, "occupied", { mode: 0o600 });
    expect(() => new SqliteMigrationWriter(existing)).toThrow("reverse SQLite destination already exists");
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o755 });
    expect(() => new SqliteMigrationWriter(join(unsafe, "reverse.sqlite"))).toThrow("reverse SQLite directory must use mode 0700");
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const symbolic = join(root, "symbolic");
    symlinkSync(target, symbolic);
    expect(() => new SqliteMigrationWriter(join(symbolic, "reverse.sqlite"))).toThrow("reverse SQLite directory must use mode 0700");
  });
});

describe("online SQLite migration snapshots", () => {
  it("backs up a populated source without altering its bytes", async () => {
    const root = privateDirectory();
    const source = join(root, "source.sqlite");
    const expected = createPopulatedDatabase(source);
    const before = readFileSync(source);
    const destination = join(root, "snapshot.sqlite");
    const snapshot = await createSqliteMigrationSnapshot(source, destination);
    expect(snapshot.pages).toBeGreaterThan(0);
    expect(snapshot.tables).toEqual(expected);
    expect(snapshot.sourceFingerprint.main.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.sourceFingerprint.wal).toBeNull();
    expect(snapshot.snapshotFingerprint.path).toBe(destination);
    expect(readFileSync(source)).toEqual(before);
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    await expect(createSqliteMigrationSnapshot(source, destination)).rejects.toThrow("migration backup destination already exists");
  });

  it("backs up a live WAL source and detects an observer mutation", async () => {
    const root = privateDirectory();
    const source = join(root, "wal-source.sqlite");
    createPopulatedDatabase(source);
    const live = new DatabaseSync(source);
    live.exec("PRAGMA journal_mode = WAL; UPDATE conversations SET title = 'wal' WHERE conversation_id = 1");
    try {
      const snapshot = await createSqliteMigrationSnapshot(source, join(root, "wal-snapshot.sqlite"));
      expect(snapshot.sourceFingerprint.wal).not.toBeNull();
    } finally { live.close(); }

    const driftSource = join(root, "drift-source.sqlite");
    createPopulatedDatabase(driftSource);
    await expect(createSqliteMigrationSnapshot(driftSource, join(root, "drift-snapshot.sqlite"), {
      _afterBackupForTesting: () => {
        const writer = new DatabaseSync(driftSource);
        try { writer.exec("UPDATE conversations SET title = 'changed' WHERE conversation_id = 1"); }
        finally { writer.close(); }
      },
    })).rejects.toThrow("SQLite source changed during backup");
  });

  it("runs legacy migrations only on the private copy", async () => {
    const root = privateDirectory();
    const source = join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(source);
    legacy.exec(`
      CREATE TABLE session_instructions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO session_instructions VALUES (1, 'legacy', '${"a".repeat(64)}', '${now}');
    `);
    legacy.close();
    chmodSync(source, 0o600);
    const before = readFileSync(source);
    const result = await createSqliteMigrationSnapshot(source, join(root, "legacy-copy.sqlite"));
    expect(result.tables.every(({ rows }) => rows === 0)).toBe(true);
    expect(readFileSync(source)).toEqual(before);
    const original = new DatabaseSync(source, { readOnly: true });
    try {
      expect(original.prepare("SELECT name FROM sqlite_master WHERE name = 'session_instructions'").get()).toBeDefined();
      expect(original.prepare("SELECT name FROM sqlite_master WHERE name = 'session_instruction_cache'").get()).toBeUndefined();
    } finally { original.close(); }
  });

  it("refuses unsafe snapshot destinations and source links", async () => {
    const root = privateDirectory();
    const source = join(root, "source.sqlite");
    createPopulatedDatabase(source);
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o755 });
    await expect(createSqliteMigrationSnapshot(source, join(unsafe, "snapshot.sqlite"))).rejects.toThrow("migration generation directory must use mode 0700");
    const directoryDestination = join(root, "directory-destination.sqlite");
    await expect(createSqliteMigrationSnapshot(source, directoryDestination, {
      _afterBackupForTesting: () => {
        rmSync(directoryDestination);
        mkdirSync(directoryDestination, { mode: 0o700 });
      },
    })).rejects.toThrow("SQLite backup destination is not a private single-link file");
    const hardLinkDestination = join(root, "hard-link-destination.sqlite");
    const anchor = join(root, "hard-link-anchor.sqlite");
    await expect(createSqliteMigrationSnapshot(source, hardLinkDestination, {
      _afterBackupForTesting: () => {
        rmSync(hardLinkDestination);
        writeFileSync(anchor, "unsafe", { mode: 0o600 });
        linkSync(anchor, hardLinkDestination);
      },
    })).rejects.toThrow("SQLite backup destination is not a private single-link file");
    const sourceLink = join(root, "source-link.sqlite");
    symlinkSync(source, sourceLink);
    await expect(createSqliteMigrationSnapshot(sourceLink, join(root, "linked-snapshot.sqlite"))).rejects.toThrow();
  });
});
