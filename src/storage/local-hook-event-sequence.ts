import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { closeLcmConnection, getLcmConnection } from "../db/connection.js";
import { eventSequenceDbPath } from "../db/events-path.js";
import { ensurePrivateDirectory } from "../security-files.js";

const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;
const EXHAUSTED_SEQUENCE_CHECKPOINT = MAX_POSTGRESQL_BIGINT + 1n;
const PADDED_SEQUENCE_LENGTH = MAX_POSTGRESQL_BIGINT.toString().length;
const MAX_SEQUENCE_ALLOCATION_BATCH = 1_000_000;
const DECIMAL_SEQUENCE = /^\d+$/u;

function validateSequenceAllocationCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("local hook sequence count must be a non-negative safe integer");
  }
  if (count > MAX_SEQUENCE_ALLOCATION_BATCH) {
    throw new Error(
      `local hook sequence count must not exceed ${MAX_SEQUENCE_ALLOCATION_BATCH}`,
    );
  }
}

export interface LegacyLocalHookEventIdentity {
  readonly event_id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly type: string;
  readonly category: string;
  readonly data: string;
  readonly priority: number;
  readonly source_hook: string;
  readonly created_at: string;
}

function parseSequence(
  value: unknown,
  field: string,
  maximum = MAX_POSTGRESQL_BIGINT,
): bigint {
  if (typeof value !== "string" || !DECIMAL_SEQUENCE.test(value)) {
    throw new Error(`invalid local hook ${field}`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > maximum) {
    throw new Error(`local hook ${field} is outside the PostgreSQL bigint range`);
  }
  return parsed;
}

export function formatLocalHookMachineSequence(sequence: bigint): string {
  if (sequence < 0n || sequence > MAX_POSTGRESQL_BIGINT) {
    throw new Error("local hook machine sequence is outside the PostgreSQL bigint range");
  }
  return sequence.toString().padStart(PADDED_SEQUENCE_LENGTH, "0");
}

export function parseLocalHookMachineSequence(sequence: string): bigint {
  if (
    sequence.length !== PADDED_SEQUENCE_LENGTH
    || !DECIMAL_SEQUENCE.test(sequence)
  ) {
    throw new Error("invalid local hook machine sequence");
  }
  return parseSequence(sequence, "machine sequence");
}

/**
 * Keeps one initialized checkpoint connection alive for a caller-owned
 * lifecycle while committing every reservation independently.
 *
 * The sidecar insert happens after this reservation. A crash may therefore
 * leave a gap, which is safe; a committed event can never reuse a value.
 */
export class LocalHookEventSequenceAllocator {
  private readonly db: DatabaseSync;
  private readonly readCheckpoint: StatementSync;
  private readonly writeCheckpoint: StatementSync;
  private closed = false;

  constructor(private readonly sequencePath = eventSequenceDbPath()) {
    ensurePrivateDirectory(dirname(sequencePath));
    const db = getLcmConnection(sequencePath);
    this.db = db;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_hook_sequence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_sequence TEXT NOT NULL
            CHECK (next_sequence <> '' AND next_sequence NOT GLOB '*[^0-9]*')
        );
        INSERT INTO local_hook_sequence(singleton, next_sequence)
        VALUES(1, '0')
        ON CONFLICT(singleton) DO NOTHING;
      `);
      this.readCheckpoint = db.prepare(
        "SELECT next_sequence FROM local_hook_sequence WHERE singleton = 1",
      );
      this.writeCheckpoint = db.prepare(
        "UPDATE local_hook_sequence SET next_sequence = ? WHERE singleton = 1",
      );
    } catch (error) {
      closeLcmConnection(sequencePath, db);
      throw error;
    }
  }

  allocateSequences(count: number): bigint[] {
    if (this.closed) {
      throw new Error("local hook sequence allocator is closed");
    }
    validateSequenceAllocationCount(count);
    if (count === 0) return [];

    // Revalidate the persistent path before every reservation. A pooled handle
    // can remain usable after its file is unlinked or replaced; acquiring a
    // temporary lease makes the shared connection guard reject that rotation
    // before this allocator can advance the stale checkpoint.
    const validationLease = getLcmConnection(this.sequencePath);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.readCheckpoint.get() as
          { next_sequence?: unknown } | undefined;
        const start = parseSequence(
          row?.next_sequence,
          "sequence checkpoint",
          EXHAUSTED_SEQUENCE_CHECKPOINT,
        );
        const next = start + BigInt(count);
        if (start > MAX_POSTGRESQL_BIGINT || next - 1n > MAX_POSTGRESQL_BIGINT) {
          throw new Error("local hook machine sequence is exhausted");
        }
        this.writeCheckpoint.run(next.toString());
        this.db.exec("COMMIT");
        return Array.from({ length: count }, (_, index) => start + BigInt(index));
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve allocation failure */ }
        throw error;
      }
    } finally {
      closeLcmConnection(this.sequencePath, validationLease);
    }
  }

  allocateSequence(): bigint {
    return this.allocateSequences(1)[0]!;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeLcmConnection(this.sequencePath, this.db);
  }
}

/**
 * Reserves installation-global sequence values in one SQLite transaction.
 *
 * Callers that allocate repeatedly should own a
 * LocalHookEventSequenceAllocator for their lifecycle so the connection,
 * schema, and prepared statements are reused.
 */
export function allocateLocalHookEventSequences(
  count: number,
  sequencePath = eventSequenceDbPath(),
): bigint[] {
  validateSequenceAllocationCount(count);
  if (count === 0) return [];

  const allocator = new LocalHookEventSequenceAllocator(sequencePath);
  try {
    return allocator.allocateSequences(count);
  } finally {
    allocator.close();
  }
}

export function allocateLocalHookEventSequence(
  sequencePath = eventSequenceDbPath(),
): bigint {
  return allocateLocalHookEventSequences(1, sequencePath)[0]!;
}

/**
 * Legacy sidecars did not carry a transport UUID. Derive one from immutable
 * row content so copied sidecars converge on the same identity during upgrade.
 */
export function deriveLegacyLocalHookEventUuid(
  event: LegacyLocalHookEventIdentity,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      event.event_id,
      event.session_id,
      event.seq,
      event.type,
      event.category,
      event.data,
      event.priority,
      event.source_hook,
      event.created_at,
    ]))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
