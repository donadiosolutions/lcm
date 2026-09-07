import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../storage/portable-record.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEQUENCE = /^\d{19}$/u;
const UTC_MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const MAX_EVENT_SEQUENCE = "9223372036854775807";
const MAX_EPOCH_SEQUENCE = "9223372036854775808";
const MAX_EFFECT_WITNESS_BYTES = 16 * 1024;

export const MIGRATION_RECEIPT_EPOCHS_DDL = `CREATE TABLE migration_receipt_v1_epochs (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  first_machine_sequence TEXT NOT NULL CHECK (
    length(first_machine_sequence) = 19
    AND first_machine_sequence NOT GLOB '*[^0-9]*'
    AND first_machine_sequence <= '9223372036854775808'
  ),
  established_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64
    AND checksum_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  PRIMARY KEY (project_id, machine_id),
  UNIQUE (epoch_id)
)`;

export const MIGRATION_RECEIPT_EVENTS_DDL = `CREATE TABLE migration_receipt_v1_events (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  event_uuid TEXT NOT NULL,
  machine_sequence TEXT NOT NULL CHECK (
    length(machine_sequence) = 19
    AND machine_sequence NOT GLOB '*[^0-9]*'
    AND machine_sequence <= '9223372036854775807'
  ),
  envelope_sha256 TEXT NOT NULL CHECK (
    length(envelope_sha256) = 64
    AND envelope_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no-effect')),
  effect_witness_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64
    AND checksum_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  PRIMARY KEY (project_id, machine_id, event_uuid),
  UNIQUE (project_id, machine_id, machine_sequence),
  FOREIGN KEY (epoch_id) REFERENCES migration_receipt_v1_epochs(epoch_id)
)`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nulFree(value: string, field: string): string {
  if (value.includes("\0")) throw new Error(`${field} contains NUL`);
  return value;
}

function canonicalUuid(value: string, field: string): string {
  nulFree(value, field);
  if (!UUID.test(value)) throw new Error(`${field} is not a canonical UUID`);
  return value;
}

function sequence(value: string, maximum: string, field: string): string {
  nulFree(value, field);
  if (!SEQUENCE.test(value) || value > maximum) throw new Error(`${field} is invalid`);
  return value;
}

function timestamp(value: string, field: string): string {
  nulFree(value, field);
  if (!UTC_MICROSECONDS.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} is not a UTC timestamp with microseconds`);
  }
  return value;
}

export type MigrationReceiptEffectWitness =
  | Readonly<{ version: 1; outcome: "applied"; promotedMemoryId: string }>
  | Readonly<{ version: 1; outcome: "no-effect"; reason: "unreinforced-pattern" }>;

export type MigrationReceiptEnvelope = Readonly<{
  eventUuid: string;
  eventVersion: number;
  machineId: string;
  machineSequence: string;
  sessionId: string;
  sessionSequence: number;
  type: string;
  category: string;
  data: string;
  priority: number;
  sourceHook: string;
  createdAt: string;
}>;

export type MigrationReceiptEpoch = Readonly<{
  projectId: string;
  machineId: string;
  epochId: string;
  firstMachineSequence: string;
  establishedAt: string;
  checksumSha256: string;
}>;

export type MigrationReceipt = Readonly<{
  projectId: string;
  machineId: string;
  epochId: string;
  eventUuid: string;
  machineSequence: string;
  envelopeSha256: string;
  outcome: MigrationReceiptEffectWitness["outcome"];
  effectWitness: MigrationReceiptEffectWitness;
  committedAt: string;
  checksumSha256: string;
}>;

export type MigrationReceiptEvidence = Readonly<{
  epoch: MigrationReceiptEpoch;
  receipts: readonly MigrationReceipt[];
  receiptSchemaSha256: string;
  receiptSetSha256: string;
}>;

export const MIGRATION_RECEIPT_SCHEMA_SHA256 = sha256(canonicalJson([
  MIGRATION_RECEIPT_EPOCHS_DDL,
  MIGRATION_RECEIPT_EVENTS_DDL,
]));

function epochBody(input: Omit<MigrationReceiptEpoch, "checksumSha256">) {
  return {
    version: 1,
    projectId: input.projectId,
    machineId: input.machineId,
    epochId: input.epochId,
    firstMachineSequence: input.firstMachineSequence,
    establishedAt: input.establishedAt,
  } as const;
}

function validateEpochInput(input: Omit<MigrationReceiptEpoch, "checksumSha256">): void {
  nulFree(input.projectId, "projectId");
  canonicalUuid(input.machineId, "machineId");
  canonicalUuid(input.epochId, "epochId");
  sequence(input.firstMachineSequence, MAX_EPOCH_SEQUENCE, "firstMachineSequence");
  timestamp(input.establishedAt, "establishedAt");
}

function exactReceiptTables(db: DatabaseSync): readonly string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE (type = 'table' OR type = 'view') AND name LIKE 'migration_receipt_v1_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
}

function assertExactReceiptSchema(db: DatabaseSync): void {
  const tables = exactReceiptTables(db);
  if (
    tables.length !== 2
    || tables[0] !== "migration_receipt_v1_epochs"
    || tables[1] !== "migration_receipt_v1_events"
  ) {
    throw new Error("migration receipt schema is partial or malformed");
  }
  const triggers = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN (
      'migration_receipt_v1_epochs', 'migration_receipt_v1_events'
    )
  `).all();
  if (triggers.length !== 0) throw new Error("migration receipt schema has unexpected triggers");
  const definitions = [
    ["migration_receipt_v1_epochs", MIGRATION_RECEIPT_EPOCHS_DDL],
    ["migration_receipt_v1_events", MIGRATION_RECEIPT_EVENTS_DDL],
  ] as const;
  for (const [table, expected] of definitions) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    const actual = row?.sql.trim().replace(/;$/u, "").trim();
    if (actual !== expected) throw new Error(`migration receipt ${table} schema is malformed`);
  }
}

function hasActiveTransaction(db: DatabaseSync): boolean {
  if (typeof db.isTransaction === "boolean") return db.isTransaction;
  // Node 22.12-22.15 lacks isTransaction. BEGIN DEFERRED changes no data and
  // only the exact nested-transaction error proves a transaction already owns
  // this connection. A successful probe is rolled back and is not admission.
  try { db.exec("BEGIN DEFERRED"); } catch (error) {
    const sqlite = error as { code?: string; errcode?: number; message?: string };
    if (sqlite.code === "ERR_SQLITE_ERROR" && sqlite.errcode === 1
      && sqlite.message === "cannot start a transaction within a transaction") return true;
    throw error;
  }
  db.exec("ROLLBACK");
  return false;
}

export function adoptMigrationReceiptEpoch(
  db: DatabaseSync,
  input: Omit<MigrationReceiptEpoch, "checksumSha256">,
): MigrationReceiptEpoch {
  validateEpochInput(input);
  if (hasActiveTransaction(db)) throw new Error("migration receipt epoch adoption owns its transaction");
  db.exec("BEGIN IMMEDIATE");
  try {
    const tables = exactReceiptTables(db);
    if (tables.length === 0) {
      db.exec(`${MIGRATION_RECEIPT_EPOCHS_DDL};${MIGRATION_RECEIPT_EVENTS_DDL};`);
    } else {
      assertExactReceiptSchema(db);
    }
    const existing = db.prepare(`
      SELECT project_id, machine_id, epoch_id, first_machine_sequence,
             established_at, checksum_sha256
      FROM migration_receipt_v1_epochs
      WHERE project_id = ? AND machine_id = ?
    `).get(input.projectId, input.machineId) as Record<string, string> | undefined;
    let epoch: MigrationReceiptEpoch;
    if (existing === undefined) {
      const checksumSha256 = sha256(canonicalJson(epochBody(input)));
      db.prepare(`
        INSERT INTO migration_receipt_v1_epochs(
          project_id, machine_id, epoch_id, first_machine_sequence,
          established_at, checksum_sha256
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.projectId, input.machineId, input.epochId, input.firstMachineSequence,
        input.establishedAt, checksumSha256);
      epoch = { ...input, checksumSha256 };
    } else {
      epoch = parseEpochRow(existing);
    }
    db.exec("COMMIT");
    return epoch;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve adoption failure */ }
    throw error;
  }
}

function parseEpochRow(row: Record<string, string>): MigrationReceiptEpoch {
  const epoch = {
    projectId: nulFree(row.project_id!, "project_id"),
    machineId: canonicalUuid(row.machine_id!, "machine_id"),
    epochId: canonicalUuid(row.epoch_id!, "epoch_id"),
    firstMachineSequence: sequence(row.first_machine_sequence!, MAX_EPOCH_SEQUENCE, "first_machine_sequence"),
    establishedAt: timestamp(row.established_at!, "established_at"),
    checksumSha256: row.checksum_sha256!,
  };
  if (!HASH.test(epoch.checksumSha256) || sha256(canonicalJson(epochBody(epoch))) !== epoch.checksumSha256) {
    throw new Error("migration receipt epoch checksum is invalid");
  }
  return epoch;
}

export function getMigrationReceiptEpoch(
  db: DatabaseSync,
  projectId: string,
  machineId: string,
): MigrationReceiptEpoch | null {
  nulFree(projectId, "projectId");
  canonicalUuid(machineId, "machineId");
  const tables = exactReceiptTables(db);
  if (tables.length === 0) return null;
  assertExactReceiptSchema(db);
  const row = db.prepare(`
    SELECT project_id, machine_id, epoch_id, first_machine_sequence,
           established_at, checksum_sha256
    FROM migration_receipt_v1_epochs
    WHERE project_id = ? AND machine_id = ?
  `).get(projectId, machineId) as Record<string, string> | undefined;
  return row === undefined ? null : parseEpochRow(row);
}

function validateEnvelope(envelope: MigrationReceiptEnvelope): void {
  canonicalUuid(envelope.eventUuid, "eventUuid");
  canonicalUuid(envelope.machineId, "machineId");
  sequence(envelope.machineSequence, MAX_EVENT_SEQUENCE, "machineSequence");
  for (const [field, value] of Object.entries({
    sessionId: envelope.sessionId,
    type: envelope.type,
    category: envelope.category,
    data: envelope.data,
    sourceHook: envelope.sourceHook,
    createdAt: envelope.createdAt,
  })) nulFree(value, field);
  if (!Number.isSafeInteger(envelope.eventVersion) || envelope.eventVersion <= 0
    || !Number.isSafeInteger(envelope.sessionSequence) || envelope.sessionSequence < 0
    || !Number.isSafeInteger(envelope.priority)) {
    throw new Error("migration receipt envelope integer is invalid");
  }
}

export function migrationReceiptEnvelopeSha256(envelope: MigrationReceiptEnvelope): string {
  validateEnvelope(envelope);
  return sha256(canonicalJson({
    version: 1,
    eventUuid: envelope.eventUuid,
    eventVersion: envelope.eventVersion,
    machineId: envelope.machineId,
    machineSequence: envelope.machineSequence,
    sessionId: envelope.sessionId,
    sessionSequence: envelope.sessionSequence,
    type: envelope.type,
    category: envelope.category,
    data: envelope.data,
    priority: envelope.priority,
    sourceHook: envelope.sourceHook,
    createdAt: envelope.createdAt,
  }));
}

function validateEffectWitness(value: MigrationReceiptEffectWitness): void {
  if (value.version !== 1) throw new Error("migration receipt effect witness version is invalid");
  const keys = value.outcome === "applied" ? ["outcome", "promotedMemoryId", "version"] : ["outcome", "reason", "version"];
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys)) throw new Error("migration receipt effect witness shape is invalid");
  if (value.outcome === "applied") {
    nulFree(value.promotedMemoryId, "promotedMemoryId");
    if (value.promotedMemoryId.length === 0) throw new Error("promotedMemoryId is blank");
    return;
  }
  if (value.outcome !== "no-effect" || value.reason !== "unreinforced-pattern") {
    throw new Error("migration receipt effect witness is invalid");
  }
}

export function recordMigrationReceipt(
  db: DatabaseSync,
  input: Readonly<{
    projectId: string;
    epochId: string;
    envelope: MigrationReceiptEnvelope;
    effectWitness: MigrationReceiptEffectWitness;
    committedAt: string;
  }>,
): MigrationReceipt {
  if (!hasActiveTransaction(db)) throw new Error("migration receipt requires an active project transaction");
  nulFree(input.projectId, "projectId");
  canonicalUuid(input.epochId, "epochId");
  validateEnvelope(input.envelope);
  validateEffectWitness(input.effectWitness);
  timestamp(input.committedAt, "committedAt");
  const epochRow = db.prepare(`
    SELECT project_id, machine_id, epoch_id, first_machine_sequence,
           established_at, checksum_sha256
    FROM migration_receipt_v1_epochs
    WHERE project_id = ? AND machine_id = ? AND epoch_id = ?
  `).get(input.projectId, input.envelope.machineId, input.epochId) as Record<string, string> | undefined;
  if (epochRow === undefined) throw new Error("migration receipt epoch is missing");
  const epoch = parseEpochRow(epochRow);
  if (input.envelope.machineSequence < epoch.firstMachineSequence) {
    throw new Error("migration receipt event predates its enforced epoch");
  }
  const envelopeDigest = migrationReceiptEnvelopeSha256(input.envelope);
  const effectWitnessJson = canonicalJson(input.effectWitness);
  if (Buffer.byteLength(effectWitnessJson) > MAX_EFFECT_WITNESS_BYTES) {
    throw new Error("migration receipt effect witness is too large");
  }
  const body = {
    version: 1,
    projectId: input.projectId,
    machineId: input.envelope.machineId,
    epochId: input.epochId,
    eventUuid: input.envelope.eventUuid,
    machineSequence: input.envelope.machineSequence,
    envelopeSha256: envelopeDigest,
    outcome: input.effectWitness.outcome,
    effectWitness: input.effectWitness,
    committedAt: input.committedAt,
  } as const;
  const receipt: MigrationReceipt = { ...body, checksumSha256: sha256(canonicalJson(body)) };
  try {
    db.prepare(`
      INSERT INTO migration_receipt_v1_events(
        project_id, machine_id, epoch_id, event_uuid, machine_sequence,
        envelope_sha256, outcome, effect_witness_json, committed_at, checksum_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(receipt.projectId, receipt.machineId, receipt.epochId, receipt.eventUuid,
      receipt.machineSequence, receipt.envelopeSha256, receipt.outcome,
      effectWitnessJson, receipt.committedAt, receipt.checksumSha256);
    return receipt;
  } catch (error) {
    const existing = readReceiptRow(db, receipt.projectId, receipt.machineId, receipt.eventUuid);
    if (existing !== null && canonicalJson(existing) === canonicalJson(receipt)) return existing;
    throw new Error("migration receipt conflict", { cause: error });
  }
}

function readReceiptRow(
  db: DatabaseSync,
  projectId: string,
  machineId: string,
  eventUuid: string,
): MigrationReceipt | null {
  const row = db.prepare(`
    SELECT project_id, machine_id, epoch_id, event_uuid, machine_sequence,
           envelope_sha256, outcome, effect_witness_json, committed_at, checksum_sha256
    FROM migration_receipt_v1_events
    WHERE project_id = ? AND machine_id = ? AND event_uuid = ?
  `).get(projectId, machineId, eventUuid) as Record<string, string> | undefined;
  return row === undefined ? null : parseReceiptRow(row);
}

/** Authenticate an already committed outcome before repeating any project effect. */
export function findMatchingMigrationReceipt(
  db: DatabaseSync,
  input: Readonly<{
    projectId: string;
    epochId: string;
    envelope: MigrationReceiptEnvelope;
  }>,
): MigrationReceipt | null {
  if (!hasActiveTransaction(db)) throw new Error("migration receipt lookup requires an active project transaction");
  canonicalUuid(input.epochId, "epochId");
  const envelopeDigest = migrationReceiptEnvelopeSha256(input.envelope);
  const epoch = getMigrationReceiptEpoch(db, input.projectId, input.envelope.machineId);
  if (epoch === null || epoch.epochId !== input.epochId
    || input.envelope.machineSequence < epoch.firstMachineSequence) {
    throw new Error("migration receipt epoch conflict");
  }
  const rows = db.prepare(`
    SELECT project_id, machine_id, epoch_id, event_uuid, machine_sequence,
           envelope_sha256, outcome, effect_witness_json, committed_at, checksum_sha256
    FROM migration_receipt_v1_events
    WHERE project_id = ? AND machine_id = ?
      AND (event_uuid = ? OR machine_sequence = ?) LIMIT 2
  `).all(input.projectId, input.envelope.machineId,
    input.envelope.eventUuid, input.envelope.machineSequence) as Array<Record<string, string>>;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("migration receipt identity conflict");
  const receipt = parseReceiptRow(rows[0]);
  if (receipt.epochId !== epoch.epochId
    || receipt.eventUuid !== input.envelope.eventUuid
    || receipt.machineSequence !== input.envelope.machineSequence
    || receipt.envelopeSha256 !== envelopeDigest) {
    throw new Error("migration receipt envelope conflict");
  }
  return receipt;
}

function parseReceiptRow(row: Record<string, string>): MigrationReceipt {
  for (const [field, value] of Object.entries(row)) nulFree(value, field);
  let effectWitness: MigrationReceiptEffectWitness;
  try {
    effectWitness = JSON.parse(row.effect_witness_json!) as MigrationReceiptEffectWitness;
  } catch {
    throw new Error("migration receipt effect witness JSON is invalid");
  }
  validateEffectWitness(effectWitness);
  if (canonicalJson(effectWitness) !== row.effect_witness_json) {
    throw new Error("migration receipt effect witness JSON is not canonical");
  }
  const body = {
    version: 1,
    projectId: row.project_id!,
    machineId: canonicalUuid(row.machine_id!, "machine_id"),
    epochId: canonicalUuid(row.epoch_id!, "epoch_id"),
    eventUuid: canonicalUuid(row.event_uuid!, "event_uuid"),
    machineSequence: sequence(row.machine_sequence!, MAX_EVENT_SEQUENCE, "machine_sequence"),
    envelopeSha256: row.envelope_sha256!,
    outcome: row.outcome as MigrationReceiptEffectWitness["outcome"],
    effectWitness,
    committedAt: timestamp(row.committed_at!, "committed_at"),
  } as const;
  if (!HASH.test(body.envelopeSha256) || body.outcome !== effectWitness.outcome
    || !HASH.test(row.checksum_sha256!) || sha256(canonicalJson(body)) !== row.checksum_sha256) {
    throw new Error("migration receipt checksum is invalid");
  }
  return { ...body, checksumSha256: row.checksum_sha256! };
}

export function readMigrationReceiptEvidence(
  db: DatabaseSync,
  projectId: string,
  machineId: string,
): MigrationReceiptEvidence {
  nulFree(projectId, "projectId");
  canonicalUuid(machineId, "machineId");
  assertExactReceiptSchema(db);
  const nul = db.prepare(`
    SELECT 1 AS found FROM migration_receipt_v1_epochs
    WHERE instr(project_id, char(0)) > 0 OR instr(machine_id, char(0)) > 0
       OR instr(epoch_id, char(0)) > 0 OR instr(first_machine_sequence, char(0)) > 0
       OR instr(established_at, char(0)) > 0 OR instr(checksum_sha256, char(0)) > 0
    UNION ALL
    SELECT 1 FROM migration_receipt_v1_events
    WHERE instr(project_id, char(0)) > 0 OR instr(machine_id, char(0)) > 0
       OR instr(epoch_id, char(0)) > 0 OR instr(event_uuid, char(0)) > 0
       OR instr(machine_sequence, char(0)) > 0 OR instr(envelope_sha256, char(0)) > 0
       OR instr(outcome, char(0)) > 0 OR instr(effect_witness_json, char(0)) > 0
       OR instr(committed_at, char(0)) > 0 OR instr(checksum_sha256, char(0)) > 0
    LIMIT 1
  `).get();
  if (nul !== undefined) throw new Error("migration receipt table contains NUL text");
  const epochRow = db.prepare(`
    SELECT project_id, machine_id, epoch_id, first_machine_sequence,
           established_at, checksum_sha256
    FROM migration_receipt_v1_epochs WHERE project_id = ? AND machine_id = ?
  `).get(projectId, machineId) as Record<string, string> | undefined;
  if (epochRow === undefined) throw new Error("migration receipt epoch is missing");
  const epoch = parseEpochRow(epochRow);
  const receipts = (db.prepare(`
    SELECT project_id, machine_id, epoch_id, event_uuid, machine_sequence,
           envelope_sha256, outcome, effect_witness_json, committed_at, checksum_sha256
    FROM migration_receipt_v1_events
    WHERE project_id = ? AND machine_id = ?
    ORDER BY machine_sequence, event_uuid
  `).all(projectId, machineId) as Array<Record<string, string>>).map(parseReceiptRow);
  if (receipts.some((receipt) => receipt.epochId !== epoch.epochId)) {
    throw new Error("migration receipt epoch identity is inconsistent");
  }
  return {
    epoch,
    receipts,
    receiptSchemaSha256: MIGRATION_RECEIPT_SCHEMA_SHA256,
    receiptSetSha256: sha256(canonicalJson(receipts.map(({ checksumSha256 }) => checksumSha256))),
  };
}

/** Stream canonical receipt checksums without materializing the receipt set. */
export function* iterateMigrationReceiptChecksums(
  db: DatabaseSync,
  epoch: MigrationReceiptEpoch,
): Generator<string> {
  assertExactReceiptSchema(db);
  const oversized = db.prepare(`SELECT 1 FROM migration_receipt_v1_events
    WHERE length(CAST(effect_witness_json AS BLOB)) > ? LIMIT 1`).get(MAX_EFFECT_WITNESS_BYTES);
  if (oversized !== undefined) throw new Error("migration receipt effect witness is too large");
  for (const value of db.prepare(`SELECT project_id, machine_id, epoch_id, event_uuid, machine_sequence,
    envelope_sha256, outcome, effect_witness_json, committed_at, checksum_sha256
    FROM migration_receipt_v1_events ORDER BY machine_sequence COLLATE BINARY, event_uuid COLLATE BINARY`).iterate()) {
    const receipt = parseReceiptRow(value as Record<string, string>);
    if (receipt.projectId !== epoch.projectId || receipt.machineId !== epoch.machineId
      || receipt.epochId !== epoch.epochId || receipt.machineSequence < epoch.firstMachineSequence) {
      throw new Error("migration receipt epoch identity is inconsistent");
    }
    yield receipt.checksumSha256;
  }
}

export type MigrationQueueRecord = Readonly<{
  eventUuid: string;
  machineSequence: string;
  envelopeSha256: string;
  disposition: "represented" | "retained";
  receiptChecksumSha256: string | null;
}>;

export type MigrationQueueClassification =
  | Readonly<{
      state: "ready";
      records: readonly MigrationQueueRecord[];
      queueSetSha256: string;
      receiptEvidence: MigrationReceiptEvidence;
    }>
  | Readonly<{
      state: "refused";
      reason:
        | "legacy-effect-ambiguous"
        | "receipt-era-processed-without-receipt"
        | "receipt-conflict"
        | "machine-identity-ambiguous"
        | "queue-row-malformed";
      eventUuid: string | null;
    }>;

export function classifyMigrationQueue(
  projectDb: DatabaseSync,
  eventsDb: DatabaseSync,
  input: Readonly<{ projectId: string; machineId: string; queueCutoff: string | null }>,
): MigrationQueueClassification {
  nulFree(input.projectId, "projectId");
  canonicalUuid(input.machineId, "machineId");
  if (input.queueCutoff !== null) sequence(input.queueCutoff, MAX_EVENT_SEQUENCE, "queueCutoff");
  const receiptEvidence = readMigrationReceiptEvidence(projectDb, input.projectId, input.machineId);
  const rawRows = input.queueCutoff === null ? [] : eventsDb.prepare(`
    SELECT event_uuid, event_version, machine_id, machine_sequence, session_id,
           seq, type, category, data, priority, source_hook, processed_at, created_at
    FROM events
    WHERE machine_sequence <= ?
    ORDER BY machine_sequence, event_uuid
  `).all(input.queueCutoff) as Array<Record<string, unknown>>;
  const receipts = new Map(receiptEvidence.receipts.map((receipt) => [receipt.eventUuid, receipt]));
  const records: MigrationQueueRecord[] = [];
  const seenSequences = new Set<string>();
  const seenEvents = new Set<string>();
  for (const row of rawRows) {
    const eventUuid = typeof row.event_uuid === "string" ? row.event_uuid : null;
    try {
      if (eventUuid === null) throw new Error("event UUID is missing");
      canonicalUuid(eventUuid, "event_uuid");
      if (row.machine_id !== input.machineId) {
        return { state: "refused", reason: "machine-identity-ambiguous", eventUuid };
      }
      const machineSequence = sequence(
        row.machine_sequence as string,
        MAX_EVENT_SEQUENCE,
        "machine_sequence",
      );
      if (seenSequences.has(machineSequence) || seenEvents.has(eventUuid)) {
        return { state: "refused", reason: "queue-row-malformed", eventUuid };
      }
      seenSequences.add(machineSequence);
      seenEvents.add(eventUuid);
      const envelope: MigrationReceiptEnvelope = {
        eventUuid,
        eventVersion: row.event_version as number,
        machineId: row.machine_id,
        machineSequence,
        sessionId: row.session_id as string,
        sessionSequence: row.seq as number,
        type: row.type as string,
        category: row.category as string,
        data: row.data as string,
        priority: row.priority as number,
        sourceHook: row.source_hook as string,
        createdAt: row.created_at as string,
      };
      const envelopeDigest = migrationReceiptEnvelopeSha256(envelope);
      const receipt = receipts.get(eventUuid);
      if (receipt !== undefined) {
        if (
          receipt.machineSequence !== machineSequence
          || receipt.envelopeSha256 !== envelopeDigest
          || receipt.epochId !== receiptEvidence.epoch.epochId
        ) {
          return { state: "refused", reason: "receipt-conflict", eventUuid };
        }
        records.push({
          eventUuid,
          machineSequence,
          envelopeSha256: envelopeDigest,
          disposition: "represented",
          receiptChecksumSha256: receipt.checksumSha256,
        });
        continue;
      }
      if (machineSequence < receiptEvidence.epoch.firstMachineSequence) {
        return { state: "refused", reason: "legacy-effect-ambiguous", eventUuid };
      }
      if (row.processed_at !== null) {
        return {
          state: "refused",
          reason: "receipt-era-processed-without-receipt",
          eventUuid,
        };
      }
      records.push({
        eventUuid,
        machineSequence,
        envelopeSha256: envelopeDigest,
        disposition: "retained",
        receiptChecksumSha256: null,
      });
    } catch {
      return { state: "refused", reason: "queue-row-malformed", eventUuid };
    }
  }
  return {
    state: "ready",
    records,
    queueSetSha256: sha256(canonicalJson(records)),
    receiptEvidence,
  };
}
