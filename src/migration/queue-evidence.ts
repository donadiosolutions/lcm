import { constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, closeSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  assertPrivateDirectoryEntry, openPrivateDirectory, readBoundedRegularFileWithStat,
  syncPrivateDirectory,
} from "../security-files.js";
import { canonicalJson } from "../storage/portable-record.js";
import { backendPublicationCanonicalSha256, type BackendMaintenanceJournal } from "../storage/backend-publication.js";
import { getMigrationReceiptEpoch, iterateMigrationReceiptChecksums, findMatchingMigrationReceipt, migrationReceiptEnvelopeSha256, MIGRATION_RECEIPT_SCHEMA_SHA256, type MigrationReceiptEnvelope, type MigrationQueueRecord } from "./receipts.js";
import { inspectSqliteSnapshotArtifact, type SqliteSnapshotArtifactWitness } from "./sqlite-snapshot.js";

const PAGE_RECORDS = 128;
const PAGE_BYTES = 128 * 1024;
const MAX_ROWS = 100_000;
const MAX_PAGES = Math.ceil(MAX_ROWS / PAGE_RECORDS);
const MAX_INDEX_BYTES = 1024 * 1024;

type PageReference = Readonly<{ name: string; sha256: string; records: number; dev: string; ino: string }>;
export type MigrationReceiptReference = Readonly<{
  version: 1; projectId: string; machineId: string; epochId: string;
  firstMachineSequence: string; epochChecksumSha256: string;
  receiptSchemaSha256: string; receiptSetSha256: string; queueCutoff: string | null;
  queueSetSha256: string; sourceArtifactSha256: string; maintenanceChecksumSha256: string;
}>;
export type AuthenticatedSqliteMigrationSnapshot = Readonly<{
  version: 1;
  artifact: SqliteSnapshotArtifactWitness;
  receiptReference: MigrationReceiptReference;
  pages: readonly PageReference[];
  evidenceDirectory: Readonly<{ dev: string; ino: string }>;
  checksumSha256: string;
}>;

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function hash(value: unknown): string { return backendPublicationCanonicalSha256(value); }
function evidencePath(homeDir: string, generationId: string): string {
  return join(homeDir, ".lcm", "migration-evidence", generationId);
}

type ImmutableReaderOperations = Readonly<{
  openDatabase?: (path: string) => DatabaseSync;
  descriptors?: typeof descriptorIdentities;
}>;

function openArtifactDatabase(homeDir: string, artifact: SqliteSnapshotArtifactWitness, role: string, operations: ImmutableReaderOperations): DatabaseSync | null {
  const file = artifact.roles.find((value) => value.role === role)?.normalizedMain;
  if (file === undefined) return null;
  const path = join(homeDir, ".lcm", "migration-snapshots", "generations", artifact.generationId, file.relativePath);
  // Immutable mode never creates or updates a WAL/SHM, even if an adversary
  // replaces a pathname with a live source. Revalidate the artifact after reads.
  const descriptors = operations.descriptors ?? descriptorIdentities;
  const before = descriptors();
  const uri = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
  const database = operations.openDatabase === undefined ? new DatabaseSync(uri, { readOnly: true }) : operations.openDatabase(uri);
  try {
    const opened = descriptors().filter(([fd]) => !before.some(([previous]) => previous === fd));
    if (opened.length !== 1 || opened[0]![1].dev !== file.dev || opened[0]![1].ino !== file.ino) {
      throw new Error("migration immutable reader opened a replaced artifact");
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

function descriptorIdentities(): Array<readonly [number, Readonly<{ dev: string; ino: string }>]> {
  const result: Array<readonly [number, Readonly<{ dev: string; ino: string }>]> = [];
  for (const name of readdirSync("/dev/fd")) {
    const fd = Number(name);
    try {
      const stat = fstatSync(fd, { bigint: true });
      result.push([fd, { dev: stat.dev.toString(), ino: stat.ino.toString() }]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
  return result;
}

function assertBoundedRows(database: DatabaseSync, table: string): void {
  const row = database.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM ${table} LIMIT ${MAX_ROWS + 1})`).get() as { count: number };
  if (row.count > MAX_ROWS) throw new Error("migration evidence exceeds bounded row capacity");
}

export async function withMigrationQueueEvidence<T>(
  homeDir: string,
  artifact: SqliteSnapshotArtifactWitness,
  maintenance: Pick<BackendMaintenanceJournal, "roster" | "sourceSelectionSha256" | "checksumSha256">,
  consume: (reference: Omit<MigrationReceiptReference, "queueSetSha256">, records: Iterable<MigrationQueueRecord>) => Promise<T>,
  _operationsForTesting: ImmutableReaderOperations = {},
): Promise<T> {
  const verified = await inspectSqliteSnapshotArtifact(artifact.generationId, { homeDir });
  if (canonicalJson(verified) !== canonicalJson(artifact)) throw new Error("migration artifact authority is invalid");
  const authority = artifact.authority;
  if (authority.projectIdentity.scope !== "local" || maintenance.roster.length !== 1
    || maintenance.roster[0]!.machineId !== authority.machineIdentity.machineId
    || maintenance.roster[0]!.evidenceSha256 !== artifact.sourceByteWitnessSha256
    || maintenance.sourceSelectionSha256 !== artifact.sourceSelectionSha256
    || maintenance.checksumSha256 !== artifact.maintenanceChecksumSha256) {
    throw new Error("migration participant authority is incomplete or disconnected");
  }
  const project = openArtifactDatabase(homeDir, artifact, "project", _operationsForTesting)!;
  let sequence: DatabaseSync | null = null;
  let events: DatabaseSync | null = null;
  try {
    sequence = openArtifactDatabase(homeDir, artifact, "machine-sequence", _operationsForTesting)!;
    events = openArtifactDatabase(homeDir, artifact, "passive-events", _operationsForTesting);
    const sequenceRows = sequence.prepare("SELECT singleton, next_sequence FROM local_hook_sequence LIMIT 2").all();
    const next = sequenceRows[0]?.next_sequence;
    if (sequenceRows.length !== 1 || sequenceRows[0]!.singleton !== 1 || typeof next !== "string"
      || !/^(0|[1-9][0-9]{0,18})$/u.test(next) || BigInt(next) > 9223372036854775808n) {
      throw new Error("migration sequence cutoff is malformed");
    }
    const queueCutoff = next === "0" ? null : (BigInt(next) - 1n).toString().padStart(19, "0");
    if (maintenance.roster[0]!.queueCutoff !== queueCutoff) throw new Error("migration cutoff differs from immutable sequence");
    assertBoundedRows(project, "migration_receipt_v1_epochs");
    assertBoundedRows(project, "migration_receipt_v1_events");
    const foreign = project.prepare(`SELECT 1 FROM migration_receipt_v1_epochs WHERE project_id != ? OR machine_id != ?
      UNION ALL SELECT 1 FROM migration_receipt_v1_events WHERE project_id != ? OR machine_id != ? LIMIT 1`)
      .get(authority.physicalProjectId, authority.machineIdentity.machineId, authority.physicalProjectId, authority.machineIdentity.machineId);
    if (foreign !== undefined) throw new Error("migration receipt has an uncovered participant");
    if (events !== null) {
      assertBoundedRows(events, "events");
      const invalid = events.prepare(`SELECT 1 FROM events WHERE machine_id IS NULL OR machine_id != ?
        OR machine_sequence IS NULL OR typeof(machine_sequence) != 'text' OR length(machine_sequence) != 19
        OR machine_sequence GLOB '*[^0-9]*' OR ? IS NULL OR machine_sequence > ? LIMIT 1`)
        .get(authority.machineIdentity.machineId, queueCutoff, queueCutoff);
      if (invalid !== undefined) throw new Error("migration queue contains unknown identity or unsealed sequence");
    }
    const epoch = getMigrationReceiptEpoch(project, authority.physicalProjectId, authority.machineIdentity.machineId);
    if (epoch === null) throw new Error("migration receipt epoch is missing");
    const beyond = project.prepare("SELECT 1 FROM migration_receipt_v1_events WHERE ? IS NULL OR machine_sequence > ? LIMIT 1")
      .get(queueCutoff, queueCutoff);
    if (beyond !== undefined) throw new Error("migration receipt lies beyond the sealed cutoff");
    const receiptHash = canonicalListHash();
    for (const checksum of iterateMigrationReceiptChecksums(project, epoch)) receiptHash.add(checksum);
    const receiptReference = {
      version: 1 as const, projectId: authority.physicalProjectId, machineId: authority.machineIdentity.machineId,
      epochId: epoch.epochId, firstMachineSequence: epoch.firstMachineSequence,
      epochChecksumSha256: epoch.checksumSha256, receiptSchemaSha256: MIGRATION_RECEIPT_SCHEMA_SHA256,
      receiptSetSha256: receiptHash.finish(), queueCutoff,
      sourceArtifactSha256: artifact.artifactSha256, maintenanceChecksumSha256: maintenance.checksumSha256,
    };
    if (events !== null) {
      const duplicate = events.prepare("SELECT 1 FROM events GROUP BY event_uuid HAVING count(*) > 1 LIMIT 1").get();
      const oversized = events.prepare("SELECT 1 FROM events WHERE length(CAST(data AS BLOB)) > 1048576 LIMIT 1").get();
      if (duplicate !== undefined || oversized !== undefined) throw new Error("migration queue row is malformed or oversized");
    }
    project.exec("BEGIN");
    const records = function* (): Generator<MigrationQueueRecord> {
      let previousSequence: string | undefined;
      if (events === null) return;
      for (const row of events.prepare(`SELECT event_uuid, event_version, machine_id, machine_sequence, session_id,
        seq, type, category, data, priority, source_hook, processed_at, created_at
        FROM events ORDER BY machine_sequence COLLATE BINARY, event_uuid COLLATE BINARY`).iterate()) {
        const envelope: MigrationReceiptEnvelope = {
          eventUuid: row.event_uuid as string, eventVersion: row.event_version as number,
          machineId: row.machine_id as string, machineSequence: row.machine_sequence as string,
          sessionId: row.session_id as string, sessionSequence: row.seq as number,
          type: row.type as string, category: row.category as string, data: row.data as string,
          priority: row.priority as number, sourceHook: row.source_hook as string, createdAt: row.created_at as string,
        };
        const envelopeSha256 = migrationReceiptEnvelopeSha256(envelope);
        if (previousSequence === envelope.machineSequence) throw new Error("migration queue sequence is duplicated");
        previousSequence = envelope.machineSequence;
        if (envelope.machineSequence < epoch.firstMachineSequence) throw new Error("migration queue refused: legacy-effect-ambiguous");
        const receipt = findMatchingMigrationReceipt(project, { projectId: epoch.projectId, epochId: epoch.epochId, envelope });
        if (receipt === null && row.processed_at !== null) throw new Error("migration queue refused: receipt-era-processed-without-receipt");
        yield {
          eventUuid: envelope.eventUuid, machineSequence: envelope.machineSequence, envelopeSha256,
          disposition: receipt === null ? "retained" : "represented",
          receiptChecksumSha256: receipt?.checksumSha256 ?? null,
        };
      }
    };
    const result = await consume(receiptReference, records());
    const verifiedAfter = await inspectSqliteSnapshotArtifact(artifact.generationId, { homeDir });
    if (verifiedAfter.checksumSha256 !== artifact.checksumSha256) throw new Error("migration artifact changed during evidence read");
    return result;
  } finally {
    // SQLite readonly closes have no source recovery or checkpoint capability.
    try { events?.close(); } finally { try { sequence?.close(); } finally { project.close(); } }
  }
}

function canonicalListHash(): Readonly<{ add(value: unknown): void; finish(): string }> {
  const digest = createHash("sha256").update("[");
  let first = true;
  return {
    add(value) { digest.update(`${first ? "" : ","}${canonicalJson(value)}`); first = false; },
    finish() { return digest.update("]").digest("hex"); },
  };
}

function writeEvidence(path: string, value: unknown, maximum: number): Readonly<{ dev: string; ino: string }> {
  const bytes = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(bytes) > maximum) throw new Error("migration evidence page exceeds byte bound");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try {
    const identity = fstatSync(fd, { bigint: true });
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    return { dev: identity.dev.toString(), ino: identity.ino.toString() };
  } finally { closeSync(fd); }
}

export async function sealMigrationQueueEvidence(
  homeDir: string,
  artifact: SqliteSnapshotArtifactWitness,
  reference: Omit<MigrationReceiptReference, "queueSetSha256">,
  records: Iterable<MigrationQueueRecord>,
  revalidateAuthority: () => void,
): Promise<AuthenticatedSqliteMigrationSnapshot> {
  const root = join(homeDir, ".lcm", "migration-evidence");
  try { mkdirSync(root, { mode: 0o700 }); syncPrivateDirectory(join(homeDir, ".lcm")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const rootHandle = openPrivateDirectory(root);
  try {
    const path = evidencePath(homeDir, artifact.generationId);
    if (existsSync(path)) {
      const existing = await inspectAuthenticatedSqliteMigrationSnapshot(artifact.generationId, homeDir);
      const queueHash = canonicalListHash();
      for (const record of records) queueHash.add(record);
      if (existing.artifact.checksumSha256 !== artifact.checksumSha256
        || canonicalJson(existing.receiptReference) !== canonicalJson({ ...reference, queueSetSha256: queueHash.finish() })) throw new Error("migration evidence retry identity conflict");
      revalidateAuthority();
      return existing;
    }
    mkdirSync(path, { mode: 0o700 });
    syncPrivateDirectory(root);
    const handle = openPrivateDirectory(path);
    try {
      const pages: PageReference[] = [];
      const queueHash = canonicalListHash();
      const publish = (chunk: MigrationQueueRecord[]): void => {
        assertPrivateDirectoryEntry(rootHandle, root);
        assertPrivateDirectoryEntry(handle, path);
        const page = { version: 1, artifactSha256: artifact.artifactSha256, ordinal: pages.length, records: chunk };
        const name = `${pages.length.toString().padStart(6, "0")}.json`;
        const identity = writeEvidence(`/dev/fd/${handle.fd}/${name}`, page, PAGE_BYTES);
        assertPrivateDirectoryEntry(handle, path);
        pages.push({ name, sha256: hash(page), records: chunk.length, ...identity });
      };
      let chunk: MigrationQueueRecord[] = [];
      let recordCount = 0;
      for (const record of records) {
        if (++recordCount > MAX_ROWS || Buffer.byteLength(canonicalJson(record)) > 1024) throw new Error("migration evidence record exceeds bound");
        queueHash.add(record);
        chunk.push(record);
        if (chunk.length === PAGE_RECORDS) { publish(chunk); chunk = []; }
      }
      if (chunk.length > 0) publish(chunk);
      const receiptReference = { ...reference, queueSetSha256: queueHash.finish() };
      revalidateAuthority();
      const verified = await inspectSqliteSnapshotArtifact(artifact.generationId, { homeDir });
      if (verified.checksumSha256 !== artifact.checksumSha256) throw new Error("migration artifact changed before evidence seal");
      revalidateAuthority();
      assertPrivateDirectoryEntry(rootHandle, root);
      const directory = assertPrivateDirectoryEntry(handle, path);
      const body = {
        version: 1 as const, artifact, receiptReference, pages,
        evidenceDirectory: { dev: String(directory.dev), ino: String(directory.ino) },
      };
      const result = { ...body, checksumSha256: hash(body) };
      writeEvidence(`/dev/fd/${handle.fd}/witness.json`, result, MAX_INDEX_BYTES);
      fsyncSync(handle.fd);
      assertPrivateDirectoryEntry(handle, path);
      revalidateAuthority();
      return await inspectAuthenticatedSqliteMigrationSnapshot(artifact.generationId, homeDir);
    } finally { handle.close(); }
  } finally { rootHandle.close(); }
}

export async function inspectAuthenticatedSqliteMigrationSnapshot(
  generationId: string,
  homeDir: string,
): Promise<AuthenticatedSqliteMigrationSnapshot> {
  // The physical inspector authenticates generation syntax and all original
  // artifact identities before the evidence path is constructed.
  const artifact = await inspectSqliteSnapshotArtifact(generationId, { homeDir });
  const path = evidencePath(homeDir, generationId);
  const root = join(homeDir, ".lcm", "migration-evidence");
  const rootHandle = openPrivateDirectory(root);
  try {
    const handle = openPrivateDirectory(path);
    try {
      const read = (name: string, maximum: number) => readBoundedRegularFileWithStat(join(path, name), {
        allowedRoot: path, maxBytes: maximum, allowedModes: [0o400], requireSingleLink: true,
        expectedUid: process.getuid!(),
      });
      const value = JSON.parse(read("witness.json", MAX_INDEX_BYTES).content) as AuthenticatedSqliteMigrationSnapshot;
      const { checksumSha256, ...body } = value;
      const directory = assertPrivateDirectoryEntry(handle, path);
      if (!exactKeys(value, ["version", "artifact", "receiptReference", "pages", "evidenceDirectory", "checksumSha256"])
        || !exactKeys(value.evidenceDirectory, ["dev", "ino"])
        || value.version !== 1 || hash(body) !== checksumSha256
        || canonicalJson(value.artifact) !== canonicalJson(artifact)
        || value.evidenceDirectory.dev !== String(directory.dev) || value.evidenceDirectory.ino !== String(directory.ino)
        || !Array.isArray(value.pages) || value.pages.length > MAX_PAGES) throw new Error("migration evidence witness is invalid");
      const queueHash = canonicalListHash();
      for (const [ordinal, page] of value.pages.entries()) {
        if (!exactKeys(page, ["name", "sha256", "records", "dev", "ino"])
          || !Number.isSafeInteger(page.records) || page.name !== `${ordinal.toString().padStart(6, "0")}.json` || page.records < 1 || page.records > PAGE_RECORDS) {
          throw new Error("migration evidence page reference is invalid");
        }
        const file = read(page.name, PAGE_BYTES);
        const content = JSON.parse(file.content) as { version: number; artifactSha256: string; ordinal: number; records: MigrationQueueRecord[] };
        if (!exactKeys(content, ["version", "artifactSha256", "ordinal", "records"])
          || hash(content) !== page.sha256 || String(file.dev) !== page.dev || String(file.ino) !== page.ino
          || content.version !== 1 || content.artifactSha256 !== artifact.artifactSha256 || content.ordinal !== ordinal
          || !Array.isArray(content.records) || content.records.length !== page.records) throw new Error("migration evidence page is invalid");
        for (const record of content.records) queueHash.add(record);
      }
      if (readdirSync(path).length !== value.pages.length + 1 || queueHash.finish() !== value.receiptReference.queueSetSha256
        || value.receiptReference.sourceArtifactSha256 !== artifact.artifactSha256
        || value.receiptReference.maintenanceChecksumSha256 !== artifact.maintenanceChecksumSha256) throw new Error("migration evidence root is invalid");
      await withMigrationQueueEvidence(homeDir, artifact, {
        sourceSelectionSha256: artifact.sourceSelectionSha256,
        checksumSha256: artifact.maintenanceChecksumSha256,
        roster: [{ machineId: artifact.authority.machineIdentity.machineId,
          queueCutoff: value.receiptReference.queueCutoff, evidenceSha256: artifact.sourceByteWitnessSha256 }],
      }, async (reference, records) => {
        const recomputed = canonicalListHash();
        for (const record of records) recomputed.add(record);
        if (canonicalJson(value.receiptReference) !== canonicalJson({ ...reference, queueSetSha256: recomputed.finish() })) {
          throw new Error("migration evidence differs from immutable receipt and queue authority");
        }
      });
      assertPrivateDirectoryEntry(rootHandle, root);
      assertPrivateDirectoryEntry(handle, path);
      return value;
    } finally { handle.close(); }
  } finally { rootHandle.close(); }
}
