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
  CREATE TABLE transcript_quarantine (
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

function ensureQuarantineSchema(db: DatabaseSync): void {
  const existing = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'transcript_quarantine'
  `).get() as { sql?: unknown } | undefined;
  if (!existing) {
    db.exec(QUARANTINE_TABLE_SQL);
    db.exec(QUARANTINE_INDEX_SQL);
    return;
  }
  if (
    typeof existing.sql === "string"
    && existing.sql.includes("'nesting-too-deep'")
  ) {
    db.exec(QUARANTINE_INDEX_SQL);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
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
