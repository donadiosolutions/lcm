import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  closeLcmConnection,
  getLcmConnection,
} from "../db/connection.js";
import { lcmHomeDir } from "../runtime-paths.js";
import { StorageOperationError } from "./errors.js";

export const TRANSCRIPT_QUARANTINE_REASONS = [
  "invalid-utf8",
  "binary-input",
  "record-too-large",
  "malformed-json",
  "non-container-json",
  "nul-character",
  "redacted-key-collision",
  "residual-secret",
  "nesting-too-deep",
] as const;

/**
 * Bump this whenever the table constraints or reason set changes. Schema
 * adoption validates the complete definition, but the version is the durable
 * migration discriminator for already-versioned databases.
 */
export const TRANSCRIPT_QUARANTINE_SCHEMA_VERSION = 1;

export type TranscriptQuarantineReason =
  (typeof TRANSCRIPT_QUARANTINE_REASONS)[number];

export interface LocalTranscriptQuarantineInput {
  readonly sourceLocator: string;
  readonly sourceOrdinal: number;
  readonly reason: TranscriptQuarantineReason;
  readonly contentSha256: string;
  readonly quarantinedAt: Date;
}

export interface LocalTranscriptQuarantineRecord
  extends LocalTranscriptQuarantineInput {
  readonly quarantineId: number;
}

export interface LocalTranscriptQuarantineListOptions {
  readonly reason?: TranscriptQuarantineReason;
  readonly limit?: number;
}

export interface LocalTranscriptQuarantineRepository {
  readonly clientName: "claude-code" | "codex";
  quarantine(
    input: LocalTranscriptQuarantineInput,
  ): Promise<LocalTranscriptQuarantineRecord>;
  get(quarantineId: number): Promise<LocalTranscriptQuarantineRecord | null>;
  list(
    options?: LocalTranscriptQuarantineListOptions,
  ): Promise<LocalTranscriptQuarantineRecord[]>;
  close(): Promise<void>;
}

type QuarantineRow = {
  quarantine_id: number | bigint;
  source_locator: string;
  source_ordinal: number | bigint;
  reason: string;
  content_sha256: string;
  quarantined_at: string;
};

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const QUARANTINE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS transcript_quarantine (
    quarantine_id INTEGER PRIMARY KEY,
    source_locator TEXT NOT NULL CHECK (source_locator <> ''),
    source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
    reason TEXT NOT NULL CHECK (reason IN (
      'invalid-utf8',
      'binary-input',
      'record-too-large',
      'malformed-json',
      'non-container-json',
      'nul-character',
      'redacted-key-collision',
      'residual-secret',
      'nesting-too-deep'
    )),
    content_sha256 TEXT NOT NULL CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    quarantined_at TEXT NOT NULL,
    UNIQUE (source_locator, source_ordinal, reason, content_sha256)
  ) STRICT
`;
const QUARANTINE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS transcript_quarantine_created_idx
  ON transcript_quarantine (quarantined_at DESC, quarantine_id DESC)
`;
const LEGACY_QUARANTINE_TABLE_SQL = `
  CREATE TABLE transcript_quarantine (
    quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_locator TEXT NOT NULL,
    source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
    reason TEXT NOT NULL CHECK (reason IN (
      'malformed-json',
      'non-container-json',
      'invalid-utf8',
      'binary-input',
      'nul-character',
      'record-too-large',
      'redacted-key-collision',
      'residual-secret'
    )),
    content_sha256 TEXT NOT NULL CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    quarantined_at TEXT NOT NULL,
    UNIQUE (source_locator, source_ordinal, content_sha256)
  )
`;

type SchemaRow = {
  readonly name: unknown;
  readonly sql: unknown;
};

type TableColumnRow = {
  readonly cid: unknown;
  readonly name: unknown;
  readonly type: unknown;
  readonly notnull: unknown;
  readonly dflt_value: unknown;
  readonly pk: unknown;
  readonly hidden: unknown;
};

type IndexListRow = {
  readonly name: unknown;
  readonly unique: unknown;
  readonly origin: unknown;
  readonly partial: unknown;
};

type IndexColumnRow = {
  readonly seqno: unknown;
  readonly cid: unknown;
  readonly name: unknown;
  readonly desc: unknown;
  readonly coll: unknown;
  readonly key: unknown;
};

const QUARANTINE_COLUMNS = [
  [0, "quarantine_id", "INTEGER", 0, null, 1, 0],
  [1, "source_locator", "TEXT", 1, null, 0, 0],
  [2, "source_ordinal", "INTEGER", 1, null, 0, 0],
  [3, "reason", "TEXT", 1, null, 0, 0],
  [4, "content_sha256", "TEXT", 1, null, 0, 0],
  [5, "quarantined_at", "TEXT", 1, null, 0, 0],
] as const;

function fail(operation: string): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_OPERATION_FAILED",
    "sqlite",
    undefined,
    "native-transcripts",
    operation,
  );
}

function assertSafeNonnegative(value: number, operation: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw fail(operation);
  return value;
}

function assertText(value: string, operation: string): string {
  if (value.length === 0 || value.includes("\0")) throw fail(operation);
  return value;
}

function assertClientName(
  value: string,
  operation: string,
): "claude-code" | "codex" {
  if (value !== "claude-code" && value !== "codex") throw fail(operation);
  return value;
}

function assertDigest(value: string, operation: string): string {
  if (!DIGEST_PATTERN.test(value)) throw fail(operation);
  return value;
}

function assertReason(
  value: string,
  operation: string,
): TranscriptQuarantineReason {
  if (
    !(TRANSCRIPT_QUARANTINE_REASONS as readonly string[]).includes(value)
  ) {
    throw fail(operation);
  }
  return value as TranscriptQuarantineReason;
}

function dateText(value: Date, operation: string): string {
  if (!Number.isFinite(value.getTime())) throw fail(operation);
  return value.toISOString();
}

function rowToRecord(
  row: QuarantineRow,
  operation: string,
): LocalTranscriptQuarantineRecord {
  const quarantineId = Number(row.quarantine_id);
  const sourceOrdinal = Number(row.source_ordinal);
  if (
    !Number.isSafeInteger(quarantineId)
    || quarantineId <= 0
    || !Number.isSafeInteger(sourceOrdinal)
    || sourceOrdinal < 0
  ) {
    throw fail(operation);
  }
  const quarantinedAt = new Date(row.quarantined_at);
  if (!Number.isFinite(quarantinedAt.getTime())) throw fail(operation);
  return {
    quarantineId,
    sourceLocator: assertText(row.source_locator, operation),
    sourceOrdinal,
    reason: assertReason(row.reason, operation),
    contentSha256: assertDigest(row.content_sha256, operation),
    quarantinedAt,
  };
}

function normalizedSchemaSql(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(/\bIF\s+NOT\s+EXISTS\b/giu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim()
    .toLowerCase();
}

function schemaSql(
  db: DatabaseSync,
  type: "index" | "table",
  name: string,
): unknown {
  return (db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = ? AND name = ?
  `).get(type, name) as { sql?: unknown } | undefined)?.sql;
}

function tableDefinitionMatches(
  db: DatabaseSync,
  expectedSql: string,
): boolean {
  if (
    normalizedSchemaSql(schemaSql(db, "table", "transcript_quarantine"))
    !== normalizedSchemaSql(expectedSql)
  ) {
    return false;
  }
  const columns = db.prepare(
    "PRAGMA table_xinfo('transcript_quarantine')",
  ).all() as TableColumnRow[];
  return columns.length === QUARANTINE_COLUMNS.length
    && columns.every((column, index) => {
      const expected = QUARANTINE_COLUMNS[index]!;
      return column.cid === expected[0]
        && column.name === expected[1]
        && column.type === expected[2]
        && column.notnull === expected[3]
        && column.dflt_value === expected[4]
        && column.pk === expected[5]
        && column.hidden === expected[6];
    });
}

function indexDefinitionMatches(db: DatabaseSync): boolean {
  const indexes = db.prepare(
    "PRAGMA index_list('transcript_quarantine')",
  ).all() as IndexListRow[];
  const indexShape = indexes.map((index) =>
    JSON.stringify([
      index.name,
      index.unique,
      index.origin,
      index.partial,
    ])).sort();
  if (JSON.stringify(indexShape) !== JSON.stringify([
    JSON.stringify([
      "sqlite_autoindex_transcript_quarantine_1",
      1,
      "u",
      0,
    ]),
    JSON.stringify([
      "transcript_quarantine_created_idx",
      0,
      "c",
      0,
    ]),
  ])) return false;
  const columns = db.prepare(
    "PRAGMA index_xinfo('transcript_quarantine_created_idx')",
  ).all() as IndexColumnRow[];
  return JSON.stringify(columns.map((column) => [
    column.seqno,
    column.cid,
    column.name,
    column.desc,
    column.coll,
    column.key,
  ])) === JSON.stringify([
    [0, 5, "quarantined_at", 1, "BINARY", 1],
    [1, 0, "quarantine_id", 1, "BINARY", 1],
    [2, -1, null, 0, "BINARY", 0],
  ]);
}

function legacyIndexDefinitionMatches(db: DatabaseSync): boolean {
  const indexes = db.prepare(
    "PRAGMA index_list('transcript_quarantine')",
  ).all() as IndexListRow[];
  return indexes.length === 1
    && indexes[0]?.name === "sqlite_autoindex_transcript_quarantine_1"
    && indexes[0]?.unique === 1
    && indexes[0]?.origin === "u"
    && indexes[0]?.partial === 0;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: unknown;
  } | undefined;
  if (!Number.isSafeInteger(row?.user_version)) throw fail("schema");
  return row?.user_version as number;
}

function ensureCurrentQuarantineSchema(db: DatabaseSync): void {
  if (!tableDefinitionMatches(db, QUARANTINE_TABLE_SQL)) {
    throw fail("schema");
  }
  const indexRows = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'transcript_quarantine'
      AND name = 'transcript_quarantine_created_idx'
  `).all() as SchemaRow[];
  if (indexRows.length === 0) {
    db.exec(QUARANTINE_INDEX_SQL);
  } else if (
    indexRows.length !== 1
    || indexRows[0]?.name !== "transcript_quarantine_created_idx"
    || normalizedSchemaSql(indexRows[0].sql)
      !== normalizedSchemaSql(QUARANTINE_INDEX_SQL)
  ) {
    throw fail("schema");
  }
  if (!indexDefinitionMatches(db)) throw fail("schema");
}

function ensureQuarantineSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = userVersion(db);
    if (version > TRANSCRIPT_QUARANTINE_SCHEMA_VERSION) {
      throw fail("schema");
    }
    const existingSql = schemaSql(
      db,
      "table",
      "transcript_quarantine",
    );
    if (version === TRANSCRIPT_QUARANTINE_SCHEMA_VERSION) {
      if (existingSql === undefined) throw fail("schema");
      ensureCurrentQuarantineSchema(db);
      db.exec("COMMIT");
      return;
    }
    if (version !== 0) throw fail("schema");
    if (existingSql === undefined) {
      db.exec(QUARANTINE_TABLE_SQL);
      db.exec(QUARANTINE_INDEX_SQL);
    } else if (tableDefinitionMatches(db, QUARANTINE_TABLE_SQL)) {
      ensureCurrentQuarantineSchema(db);
    } else if (
      tableDefinitionMatches(db, LEGACY_QUARANTINE_TABLE_SQL)
      && legacyIndexDefinitionMatches(db)
    ) {
      db.exec(`
        ALTER TABLE transcript_quarantine
        RENAME TO transcript_quarantine_legacy
      `);
      db.exec(QUARANTINE_TABLE_SQL);
      db.exec(`
        INSERT INTO transcript_quarantine (
          quarantine_id,
          source_locator,
          source_ordinal,
          reason,
          content_sha256,
          quarantined_at
        )
        SELECT
          quarantine_id,
          source_locator,
          source_ordinal,
          reason,
          content_sha256,
          quarantined_at
        FROM transcript_quarantine_legacy
      `);
      db.exec("DROP TABLE transcript_quarantine_legacy");
      db.exec(QUARANTINE_INDEX_SQL);
    } else {
      throw fail("schema");
    }
    ensureCurrentQuarantineSchema(db);
    db.exec(
      `PRAGMA user_version = ${TRANSCRIPT_QUARANTINE_SCHEMA_VERSION}`,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export function localTranscriptQuarantinePath(
  projectId: string,
  clientName: string,
  homeDir?: string,
): string {
  const opaqueProjectId = createHash("sha256")
    .update(assertText(projectId, "path"), "utf8")
    .digest("hex");
  const opaqueClientName = createHash("sha256")
    .update(assertClientName(clientName, "path"), "utf8")
    .digest("hex");
  return join(
    lcmHomeDir(homeDir),
    "transcript-quarantine",
    opaqueProjectId,
    `${opaqueClientName}.db`,
  );
}

export class SQLiteLocalTranscriptQuarantineRepository
implements LocalTranscriptQuarantineRepository {
  private closed = false;

  constructor(
    private readonly dbPath: string,
    private readonly db: DatabaseSync,
    readonly clientName: "claude-code" | "codex",
  ) {
    ensureQuarantineSchema(db);
  }

  async quarantine(
    input: LocalTranscriptQuarantineInput,
  ): Promise<LocalTranscriptQuarantineRecord> {
    this.assertOpen("quarantine");
    const sourceLocator = assertText(input.sourceLocator, "quarantine");
    const sourceOrdinal = assertSafeNonnegative(
      input.sourceOrdinal,
      "quarantine",
    );
    const reason = assertReason(input.reason, "quarantine");
    const contentSha256 = assertDigest(
      input.contentSha256,
      "quarantine",
    );
    const quarantinedAt = dateText(input.quarantinedAt, "quarantine");
    this.db.prepare(`
      INSERT INTO transcript_quarantine (
        source_locator,
        source_ordinal,
        reason,
        content_sha256,
        quarantined_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_locator, source_ordinal, reason, content_sha256)
      DO NOTHING
    `).run(
      sourceLocator,
      sourceOrdinal,
      reason,
      contentSha256,
      quarantinedAt,
    );
    const row = this.db.prepare(`
      SELECT
        quarantine_id,
        source_locator,
        source_ordinal,
        reason,
        content_sha256,
        quarantined_at
      FROM transcript_quarantine
      WHERE source_locator = ?
        AND source_ordinal = ?
        AND reason = ?
        AND content_sha256 = ?
    `).get(
      sourceLocator,
      sourceOrdinal,
      reason,
      contentSha256,
    ) as QuarantineRow | undefined;
    if (!row) throw fail("quarantine");
    return rowToRecord(row, "quarantine");
  }

  async get(
    quarantineId: number,
  ): Promise<LocalTranscriptQuarantineRecord | null> {
    this.assertOpen("get");
    assertSafeNonnegative(quarantineId, "get");
    if (quarantineId === 0) return null;
    const row = this.db.prepare(`
      SELECT
        quarantine_id,
        source_locator,
        source_ordinal,
        reason,
        content_sha256,
        quarantined_at
      FROM transcript_quarantine
      WHERE quarantine_id = ?
    `).get(quarantineId) as QuarantineRow | undefined;
    return row ? rowToRecord(row, "get") : null;
  }

  async list(
    options: LocalTranscriptQuarantineListOptions = {},
  ): Promise<LocalTranscriptQuarantineRecord[]> {
    this.assertOpen("list");
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_LIST_LIMIT
    ) {
      throw fail("list");
    }
    const rows = options.reason === undefined
      ? this.db.prepare(`
          SELECT
            quarantine_id,
            source_locator,
            source_ordinal,
            reason,
            content_sha256,
            quarantined_at
          FROM transcript_quarantine
          ORDER BY quarantined_at DESC, quarantine_id DESC
          LIMIT ?
        `).all(limit)
      : this.db.prepare(`
          SELECT
            quarantine_id,
            source_locator,
            source_ordinal,
            reason,
            content_sha256,
            quarantined_at
          FROM transcript_quarantine
          WHERE reason = ?
          ORDER BY quarantined_at DESC, quarantine_id DESC
          LIMIT ?
        `).all(assertReason(options.reason, "list"), limit);
    return (rows as QuarantineRow[]).map((row) =>
      rowToRecord(row, "list"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    closeLcmConnection(this.dbPath, this.db);
  }

  private assertOpen(operation: string): void {
    if (!this.closed) return;
    throw new StorageOperationError(
      "STORAGE_CLOSED",
      "sqlite",
      undefined,
      "native-transcripts",
      operation,
    );
  }
}

export function openLocalTranscriptQuarantine(
  projectId: string,
  clientName: string,
  homeDir?: string,
): SQLiteLocalTranscriptQuarantineRepository {
  const validatedClientName = assertClientName(clientName, "open");
  const dbPath = localTranscriptQuarantinePath(
    projectId,
    validatedClientName,
    homeDir,
  );
  const db = getLcmConnection(dbPath);
  try {
    return new SQLiteLocalTranscriptQuarantineRepository(
      dbPath,
      db,
      validatedClientName,
    );
  } catch (error) {
    closeLcmConnection(dbPath, db);
    throw error;
  }
}
