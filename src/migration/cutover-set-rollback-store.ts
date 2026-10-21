import { canonicalJson, canonicalSha256 } from "../storage/portable-record.js";
import {
  BACKEND_PUBLICATION_MAX_JOURNAL_BYTES,
  backendCutoverSetManifestSha256,
  backendPublicationCanonicalSha256,
  parseBackendCutoverSetManifest,
  parseBackendCutoverSetRollbackSelection,
  type BackendCutoverSetManifest,
  type BackendCutoverSetRollbackSelection,
} from "../storage/backend-publication.js";
import { readActivationGenerationLink } from "./activation-artifact-store.js";
import { deriveActivationPublicationId } from "./activation-publication-id.js";
import {
  generationScopedDirectory,
  readGenerationScopedFiles,
  recordGenerationScopedFile,
  validateGenerationId,
  validateHomeDir,
  type GenerationScopedReconciler,
  type GenerationScopedStore,
  type RecordMigrationSelectionBindingDependencies,
} from "./generation-binding-store.js";

/**
 * The durable records of a cutover-set rollback (#1550, plan-v2 D3 as
 * amended by C2, C3 and C5), keyed by the ORIGINAL activated set id under
 * <home>/.lcm/migration-cutover-set-rollback/<sha256hex(originalSetId)>/ on
 * generation-binding-store.ts's exported primitives (private directory
 * authentication, durable create-only writes, crash-twin recovery, read-only
 * scan), exactly as the activation records are.
 *
 * checkpoint.json is the rollback commitment, written after every pending
 * activation effect was settled and before the rollback hold archives the
 * completed activation publication: the rollback hold manifest (the original
 * members under the derived rollback set id), the activation records it
 * unwinds (checkpoint and selection digests, artifact identity, completed
 * journal checksum, operability fact), the sealed reverse artifact identity
 * and, per member in manifest order, the authenticated preserved snapshot,
 * the forward held binding, the activation epoch, attempt and witness, the
 * settled active head and the rollback lease evidence. From the moment it
 * exists every member's old activation evidence is fenced for replay.
 *
 * install-<index>.json is one member's installation evidence, written after
 * its new SQLite generation was installed at the canonical path and its
 * sidecars materialized: the selected physical candidate, its build witness,
 * the post-sidecar database witness, the preemption of the original file and
 * the sidecar outcome. The selection row references it by checksum (C2).
 *
 * selection.json is the thin reverse tuple storage defines
 * (BackendCutoverSetRollbackSelection), frozen once after every member is
 * installed and verified, and adopted exactly on every later call.
 *
 * Every record is strict, canonical, bounded and immutable: byte-identical
 * content is reuse, any other content under the same name is a conflict
 * (MigrationBindingConflictError), and a failed read is never absence. The
 * reader proves the association between the records (checkpoint digest,
 * ids, per-member rows, install references) before it reports any of them.
 *
 * resolveCutoverSetRollbackCommitment (C3) is the read-only path replay uses
 * to find a member's rollback commitment from its own activation link:
 * a link that names a set publication locates these records; positive
 * absence falls through to the activation behavior, anything unresolvable
 * refuses, and a stored checkpoint is the commitment whatever else exists.
 */

const CUTOVER_SET_ROLLBACK_SUBDIRECTORY = "migration-cutover-set-rollback";
const RECORD_WIRE_VERSION = 1 as const;
const CHECKPOINT_FILE = "checkpoint.json";
const SELECTION_FILE = "selection.json";
const INSTALL_FILE_PATTERN = /^install-([0-9]{6})\.json$/u;
/** The checkpoint and the thin tuple share the set journal's limit (C2); an installation record is small. */
export const MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES = BACKEND_PUBLICATION_MAX_JOURNAL_BYTES;
export const MAX_CUTOVER_SET_ROLLBACK_INSTALL_RECORD_BYTES = 64 * 1024;

const CUTOVER_SET_ROLLBACK_STORE: GenerationScopedStore = {
  subdirectory: CUTOVER_SET_ROLLBACK_SUBDIRECTORY,
  noun: "cutover-set rollback record",
  maxFileBytes: MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES,
  isFinalFileName: (name) => name === CHECKPOINT_FILE || name === SELECTION_FILE || INSTALL_FILE_PATTERN.test(name),
};

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUEUE_CUTOFF_PATTERN = /^[0-9]{1,19}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CHECKPOINT_KEYS = [
  "activationIdentityDigest", "activationJournalChecksumSha256", "checksumSha256", "identityDigest", "kind", "manifest", "members",
  "operabilityFactValueSha256", "originalCheckpointSha256", "originalSelectionSha256", "originalSetId", "publicationId", "setId", "version",
] as const;
const CHECKPOINT_MEMBER_KEYS = [
  "activationWitnessChecksumSha256", "attemptId", "epochId", "evidenceSha256", "generationId", "heldMemberChecksumSha256",
  "manifestChecksumSha256", "manifestRevision", "physicalProjectId", "queueCutoff", "queueEvidenceSha256", "remoteProjectId",
  "snapshotChecksumSha256", "sourceByteWitnessSha256", "sourceSelectionSha256",
] as const;
const INSTALL_KEYS = [
  "buildContentSha256", "buildManifestSha256", "buildWitnessChecksumSha256", "canonicalPath", "checksumSha256", "database",
  "exportEvidenceSha256", "generationId", "installedGenerationId", "kind", "mode", "originalSetId", "preemption", "setId", "sidecars", "version",
] as const;

/** The rollback hold's set id (also its publication id) for an original activated set: one terminal rollback per set. */
export function deriveCutoverSetRollbackSetId(originalSetId: string): string {
  return canonicalSha256(["cutover-set-rollback-publication-v1", originalSetId]);
}

/** The per-set directory the records of a rollback live in, keyed by the original set id. */
export function migrationCutoverSetRollbackDirectory(homeDir: string, originalSetId: string): string {
  return generationScopedDirectory(CUTOVER_SET_ROLLBACK_STORE, homeDir, originalSetId);
}

export type CutoverSetRollbackCheckpointMember = Readonly<{
  physicalProjectId: string;
  generationId: string;
  remoteProjectId: string;
  /** The forward held binding digest the activation checkpoint froze (C4: authenticated separately from the rollback hold). */
  heldMemberChecksumSha256: string;
  /** The authenticated preserved snapshot's checksum (its artifact, receipt and queue evidence). */
  snapshotChecksumSha256: string;
  sourceSelectionSha256: string;
  queueEvidenceSha256: string;
  queueCutoff: string | null;
  sourceByteWitnessSha256: string;
  epochId: string;
  attemptId: string;
  activationWitnessChecksumSha256: string;
  /** The settled active head the rollback's prepare inputs derive from (C5). */
  manifestRevision: number;
  manifestChecksumSha256: string;
  /** The rollback lease and publication project evidence of this member. */
  evidenceSha256: string;
}>;

export type CutoverSetRollbackCheckpoint = Readonly<{
  version: 1;
  kind: "cutover-set-rollback-checkpoint";
  originalSetId: string;
  /** The rollback hold's set id: deriveCutoverSetRollbackSetId(originalSetId). */
  setId: string;
  manifest: BackendCutoverSetManifest;
  publicationId: string;
  originalCheckpointSha256: string;
  originalSelectionSha256: string;
  activationIdentityDigest: string;
  activationJournalChecksumSha256: string;
  operabilityFactValueSha256: string;
  /** The sealed reverse artifact's identity digest. */
  identityDigest: string;
  /** Manifest order. */
  members: readonly CutoverSetRollbackCheckpointMember[];
  checksumSha256: string;
}>;

export type CreateCutoverSetRollbackCheckpointInput = Omit<CutoverSetRollbackCheckpoint, "version" | "kind" | "checksumSha256">;

export type CutoverSetRollbackInstallRecord = Readonly<{
  version: 1;
  kind: "cutover-set-rollback-install";
  originalSetId: string;
  setId: string;
  generationId: string;
  /** The verified physical SQLite candidate installed at the canonical path. */
  installedGenerationId: string;
  mode: "pre-write" | "post-write";
  buildWitnessChecksumSha256: string;
  buildManifestSha256: string;
  buildContentSha256: string;
  /** The digest of the export snapshot's delta and census (post-write), or null (pre-write). */
  exportEvidenceSha256: string | null;
  canonicalPath: string;
  /** The canonical database after the sidecars were materialized. */
  database: Readonly<{ sha256: string; size: string }>;
  /** The move-aside of the file the install preempted, or null when none existed. */
  preemption: Readonly<{ path: string; beforeSha256: string; afterSha256: string }> | null;
  sidecars: Readonly<{
    sessionInstructionsMaterialized: number;
    passiveEventsMaterialized: number;
    passiveEventsPreservedPending: number;
    reconciledUpTo: string | null;
  }>;
  checksumSha256: string;
}>;

export type CreateCutoverSetRollbackInstallRecordInput = Omit<CutoverSetRollbackInstallRecord, "version" | "kind" | "checksumSha256">;

export type CutoverSetRollbackRecordReason =
  | "invalid-input"
  | "checkpoint-missing"
  | "install-missing"
  | "selection-mismatch"
  | "record-unresolvable";

/** A record was refused before any write, or the stored records cannot be trusted. */
export class CutoverSetRollbackRecordError extends Error {
  constructor(readonly reason: CutoverSetRollbackRecordReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CutoverSetRollbackRecordError";
  }
}

function invalid(message: string): never {
  throw new CutoverSetRollbackRecordError("invalid-input", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The checkpoint digest: canonical sha256 over every field but its own checksum. */
export function cutoverSetRollbackCheckpointSha256(checkpoint: Omit<CutoverSetRollbackCheckpoint, "checksumSha256">): string {
  const { checksumSha256: _checksum, ...body } = checkpoint as
    Omit<CutoverSetRollbackCheckpoint, "checksumSha256"> & Partial<Pick<CutoverSetRollbackCheckpoint, "checksumSha256">>;
  return backendPublicationCanonicalSha256(body);
}

/**
 * Strictly parse a rollback checkpoint: the manifest through storage's own
 * validator with the derived rollback set id, the original set another
 * identifier, every digest well-formed, the members exactly the manifest's in
 * manifest order with distinct remote projects, and the checksum reproduced.
 */
export function parseCutoverSetRollbackCheckpoint(value: unknown): CutoverSetRollbackCheckpoint {
  if (
    !isRecord(value)
    || !exactKeys(value, CHECKPOINT_KEYS)
    || value.version !== 1
    || value.kind !== "cutover-set-rollback-checkpoint"
    || typeof value.originalSetId !== "string"
    || !IDENTIFIER_PATTERN.test(value.originalSetId)
    || !isHash(value.originalCheckpointSha256)
    || !isHash(value.originalSelectionSha256)
    || !isHash(value.activationIdentityDigest)
    || !isHash(value.activationJournalChecksumSha256)
    || !isHash(value.operabilityFactValueSha256)
    || !isHash(value.identityDigest)
    || !isHash(value.checksumSha256)
    || !Array.isArray(value.members)
  ) {
    invalid("cutover-set rollback checkpoint is malformed");
  }
  let manifest: BackendCutoverSetManifest;
  try {
    manifest = parseBackendCutoverSetManifest(value.manifest);
  } catch (error) {
    invalid("cutover-set rollback checkpoint manifest is malformed: " + (error as Error).message);
  }
  if (
    manifest.setId !== deriveCutoverSetRollbackSetId(value.originalSetId)
    || value.setId !== manifest.setId
    || value.publicationId !== manifest.setId
    || value.members.length !== manifest.members.length
  ) {
    invalid("cutover-set rollback checkpoint does not restate its manifest");
  }
  const members = value.members.map((item, index): CutoverSetRollbackCheckpointMember => {
    const expected = manifest.members[index]!;
    if (
      !isRecord(item)
      || !exactKeys(item, CHECKPOINT_MEMBER_KEYS)
      || item.physicalProjectId !== expected.physicalProjectId
      || item.generationId !== expected.generationId
      || item.sourceSelectionSha256 !== expected.sourceSelectionSha256
      || typeof item.remoteProjectId !== "string"
      || !CANONICAL_UUID.test(item.remoteProjectId)
      || !isHash(item.heldMemberChecksumSha256)
      || !isHash(item.snapshotChecksumSha256)
      || !isHash(item.queueEvidenceSha256)
      || (item.queueCutoff !== null && (typeof item.queueCutoff !== "string" || !QUEUE_CUTOFF_PATTERN.test(item.queueCutoff)))
      || !isHash(item.sourceByteWitnessSha256)
      || !isHash(item.epochId)
      || !isHash(item.attemptId)
      || !isHash(item.activationWitnessChecksumSha256)
      || !isCount(item.manifestRevision)
      || !isHash(item.manifestChecksumSha256)
      || !isHash(item.evidenceSha256)
    ) {
      invalid("cutover-set rollback checkpoint member[" + index + "] is malformed");
    }
    return {
      physicalProjectId: item.physicalProjectId,
      generationId: item.generationId,
      remoteProjectId: item.remoteProjectId,
      heldMemberChecksumSha256: item.heldMemberChecksumSha256,
      snapshotChecksumSha256: item.snapshotChecksumSha256,
      sourceSelectionSha256: expected.sourceSelectionSha256,
      queueEvidenceSha256: item.queueEvidenceSha256,
      queueCutoff: item.queueCutoff as string | null,
      sourceByteWitnessSha256: item.sourceByteWitnessSha256,
      epochId: item.epochId,
      attemptId: item.attemptId,
      activationWitnessChecksumSha256: item.activationWitnessChecksumSha256,
      manifestRevision: item.manifestRevision,
      manifestChecksumSha256: item.manifestChecksumSha256,
      evidenceSha256: item.evidenceSha256,
    };
  });
  if (new Set(members.map((member) => member.remoteProjectId)).size !== members.length) {
    invalid("cutover-set rollback checkpoint remote projects are not unique");
  }
  const checkpoint: CutoverSetRollbackCheckpoint = {
    version: 1,
    kind: "cutover-set-rollback-checkpoint",
    originalSetId: value.originalSetId,
    setId: manifest.setId,
    manifest,
    publicationId: manifest.setId,
    originalCheckpointSha256: value.originalCheckpointSha256,
    originalSelectionSha256: value.originalSelectionSha256,
    activationIdentityDigest: value.activationIdentityDigest,
    activationJournalChecksumSha256: value.activationJournalChecksumSha256,
    operabilityFactValueSha256: value.operabilityFactValueSha256,
    identityDigest: value.identityDigest,
    members,
    checksumSha256: value.checksumSha256,
  };
  if (cutoverSetRollbackCheckpointSha256(checkpoint) !== checkpoint.checksumSha256) {
    invalid("cutover-set rollback checkpoint checksum does not match");
  }
  return checkpoint;
}

/** Seal a checkpoint from its body; the result is re-parsed, so a malformed body throws before any write. */
export function createCutoverSetRollbackCheckpoint(input: CreateCutoverSetRollbackCheckpointInput): CutoverSetRollbackCheckpoint {
  const body = { version: 1 as const, kind: "cutover-set-rollback-checkpoint" as const, ...input };
  return parseCutoverSetRollbackCheckpoint({ ...body, checksumSha256: cutoverSetRollbackCheckpointSha256(body) });
}

/** The installation record digest: canonical sha256 over every field but its own checksum. */
export function cutoverSetRollbackInstallRecordSha256(record: Omit<CutoverSetRollbackInstallRecord, "checksumSha256">): string {
  const { checksumSha256: _checksum, ...body } = record as
    Omit<CutoverSetRollbackInstallRecord, "checksumSha256"> & Partial<Pick<CutoverSetRollbackInstallRecord, "checksumSha256">>;
  return backendPublicationCanonicalSha256(body);
}

/** Strictly parse one member's installation record and reproduce its checksum. */
export function parseCutoverSetRollbackInstallRecord(value: unknown): CutoverSetRollbackInstallRecord {
  if (
    !isRecord(value)
    || !exactKeys(value, INSTALL_KEYS)
    || value.version !== 1
    || value.kind !== "cutover-set-rollback-install"
    || typeof value.originalSetId !== "string"
    || !IDENTIFIER_PATTERN.test(value.originalSetId)
    || value.setId !== deriveCutoverSetRollbackSetId(value.originalSetId)
    || typeof value.generationId !== "string"
    || !IDENTIFIER_PATTERN.test(value.generationId)
    || typeof value.installedGenerationId !== "string"
    || !IDENTIFIER_PATTERN.test(value.installedGenerationId)
    || value.installedGenerationId === value.generationId
    || (value.mode !== "pre-write" && value.mode !== "post-write")
    || !isHash(value.buildWitnessChecksumSha256)
    || !isHash(value.buildManifestSha256)
    || !isHash(value.buildContentSha256)
    || (value.exportEvidenceSha256 !== null && !isHash(value.exportEvidenceSha256))
    || (value.mode === "post-write") !== (value.exportEvidenceSha256 !== null)
    || typeof value.canonicalPath !== "string"
    || value.canonicalPath.length === 0
    || !isRecord(value.database)
    || !exactKeys(value.database, ["sha256", "size"])
    || !isHash(value.database.sha256)
    || typeof value.database.size !== "string"
    || !QUEUE_CUTOFF_PATTERN.test(value.database.size)
    || (value.preemption !== null && (
      !isRecord(value.preemption)
      || !exactKeys(value.preemption, ["afterSha256", "beforeSha256", "path"])
      || typeof value.preemption.path !== "string"
      || value.preemption.path.length === 0
      || !isHash(value.preemption.beforeSha256)
      || !isHash(value.preemption.afterSha256)
    ))
    || !isRecord(value.sidecars)
    || !exactKeys(value.sidecars, ["passiveEventsMaterialized", "passiveEventsPreservedPending", "reconciledUpTo", "sessionInstructionsMaterialized"])
    || !isCount(value.sidecars.sessionInstructionsMaterialized)
    || !isCount(value.sidecars.passiveEventsMaterialized)
    || !isCount(value.sidecars.passiveEventsPreservedPending)
    || (value.sidecars.reconciledUpTo !== null
      && (typeof value.sidecars.reconciledUpTo !== "string" || !QUEUE_CUTOFF_PATTERN.test(value.sidecars.reconciledUpTo)))
    || !isHash(value.checksumSha256)
  ) {
    invalid("cutover-set rollback installation record is malformed");
  }
  const preemption = value.preemption as Record<string, string> | null;
  const sidecars = value.sidecars as Record<string, number | string | null>;
  const record: CutoverSetRollbackInstallRecord = {
    version: 1,
    kind: "cutover-set-rollback-install",
    originalSetId: value.originalSetId,
    setId: value.setId as string,
    generationId: value.generationId,
    installedGenerationId: value.installedGenerationId,
    mode: value.mode,
    buildWitnessChecksumSha256: value.buildWitnessChecksumSha256,
    buildManifestSha256: value.buildManifestSha256,
    buildContentSha256: value.buildContentSha256,
    exportEvidenceSha256: value.exportEvidenceSha256 as string | null,
    canonicalPath: value.canonicalPath,
    database: { sha256: value.database.sha256, size: value.database.size },
    preemption: preemption === null ? null : { path: preemption.path!, beforeSha256: preemption.beforeSha256!, afterSha256: preemption.afterSha256! },
    sidecars: {
      sessionInstructionsMaterialized: sidecars.sessionInstructionsMaterialized as number,
      passiveEventsMaterialized: sidecars.passiveEventsMaterialized as number,
      passiveEventsPreservedPending: sidecars.passiveEventsPreservedPending as number,
      reconciledUpTo: sidecars.reconciledUpTo as string | null,
    },
    checksumSha256: value.checksumSha256,
  };
  if (cutoverSetRollbackInstallRecordSha256(record) !== record.checksumSha256) {
    invalid("cutover-set rollback installation record checksum does not match");
  }
  return record;
}

/** Seal an installation record from its body; re-parsed before any write. */
export function createCutoverSetRollbackInstallRecord(input: CreateCutoverSetRollbackInstallRecordInput): CutoverSetRollbackInstallRecord {
  const body = { version: 1 as const, kind: "cutover-set-rollback-install" as const, ...input };
  return parseCutoverSetRollbackInstallRecord({ ...body, checksumSha256: cutoverSetRollbackInstallRecordSha256(body) });
}

function installFileName(index: number): string {
  return "install-" + String(index).padStart(6, "0") + ".json";
}

/**
 * Prove the thin tuple descends from the checkpoint and the installation
 * records: same checkpoint digest, hold, publication, original set, original
 * selection, artifact identity and manifest, and every member row restating
 * the checkpoint's remote project, epoch and attempt and referencing its
 * stored installation record by checksum, with the record's mode. Throws
 * selection-mismatch (or install-missing) otherwise.
 */
export function assertCutoverSetRollbackSelectionDescendsFromRecords(
  checkpoint: CutoverSetRollbackCheckpoint,
  installs: ReadonlyMap<string, CutoverSetRollbackInstallRecord>,
  selection: BackendCutoverSetRollbackSelection,
): void {
  const mismatch = (detail: string): never => {
    throw new CutoverSetRollbackRecordError("selection-mismatch", "cutover-set rollback selection does not descend from the checkpoint: " + detail);
  };
  if (selection.checkpointSha256 !== checkpoint.checksumSha256) mismatch("checkpoint digest");
  if (selection.setId !== checkpoint.setId || selection.publicationId !== checkpoint.publicationId) mismatch("set or publication id");
  if (selection.originalSetId !== checkpoint.originalSetId) mismatch("original set id");
  if (selection.originalSelectionSha256 !== checkpoint.originalSelectionSha256) mismatch("original selection digest");
  if (selection.identityDigest !== checkpoint.identityDigest) mismatch("reverse artifact identity digest");
  if (selection.manifestSha256 !== backendCutoverSetManifestSha256(checkpoint.manifest)) mismatch("manifest digest");
  if (selection.members.length !== checkpoint.members.length) mismatch("member count");
  selection.members.forEach((member, index) => {
    const expected = checkpoint.members[index]!;
    if (
      member.physicalProjectId !== expected.physicalProjectId
      || member.generationId !== expected.generationId
      || member.remoteProjectId !== expected.remoteProjectId
      || member.epochId !== expected.epochId
      || member.attemptId !== expected.attemptId
    ) {
      mismatch("member " + expected.generationId);
    }
    const install = installs.get(member.generationId);
    if (install === undefined) {
      throw new CutoverSetRollbackRecordError("install-missing", "no installation record is stored for member " + member.generationId);
    }
    if (install.checksumSha256 !== member.installEvidenceSha256 || install.mode !== member.mode) mismatch("member " + expected.generationId + " installation");
  });
}

function wireContent(originalSetId: string, record: unknown): string {
  return canonicalJson({ version: RECORD_WIRE_VERSION, originalSetId, record }) + "\n";
}

function recordFile(
  homeDir: string,
  originalSetId: string,
  fileName: string,
  record: unknown,
  maxBytes: number,
  dependencies: RecordMigrationSelectionBindingDependencies,
): void {
  const serialized = wireContent(originalSetId, record);
  if (Buffer.byteLength(serialized) > maxBytes) {
    invalid("cutover-set rollback record " + fileName + " exceeds " + maxBytes + " bytes");
  }
  const reconcile: GenerationScopedReconciler = (stored) => (stored === serialized ? "reused" : "conflict");
  recordGenerationScopedFile(CUTOVER_SET_ROLLBACK_STORE, homeDir, originalSetId, fileName, serialized, reconcile, dependencies);
}

export type CutoverSetRollbackRecords =
  | Readonly<{
    state: "resolved";
    checkpoint: CutoverSetRollbackCheckpoint;
    /** Keyed by the ORIGINAL member generation id. */
    installs: ReadonlyMap<string, CutoverSetRollbackInstallRecord>;
    selection: BackendCutoverSetRollbackSelection | null;
  }>
  | Readonly<{ state: "authoritatively-absent" }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

function parseStoredRecord(name: string, content: string, originalSetId: string): unknown {
  const envelope: unknown = JSON.parse(content);
  if (
    !isRecord(envelope)
    || !exactKeys(envelope, ["originalSetId", "record", "version"])
    || envelope.version !== RECORD_WIRE_VERSION
    || envelope.originalSetId !== originalSetId
  ) {
    invalid(name + " envelope is invalid");
  }
  if (content !== wireContent(originalSetId, envelope.record)) invalid(name + " content is not canonical");
  return envelope.record;
}

/**
 * Read and verify the records of one rollback: "authoritatively-absent" has
 * the binding store's meaning (positively no store, no set directory, or an
 * authenticated empty one); any record without its checkpoint, a record that
 * does not re-derive its checksum, an envelope naming another set, an
 * installation record whose index or member is not the checkpoint's, or a
 * selection that does not descend from the records is "unresolvable".
 * Synchronous and read-only.
 */
export function readCutoverSetRollbackRecords(
  input: Readonly<{ homeDir: string; originalSetId: string }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): CutoverSetRollbackRecords {
  const homeDir = validateHomeDir(input.homeDir);
  const originalSetId = validateGenerationId(input.originalSetId);
  const read = readGenerationScopedFiles(CUTOVER_SET_ROLLBACK_STORE, { homeDir, generationId: originalSetId }, dependencies);
  if (read.kind === "absent") return { state: "authoritatively-absent" };
  if (read.kind === "unresolvable") return { state: "unresolvable", reason: read.reason };
  let currentFile = "";
  try {
    let checkpoint: CutoverSetRollbackCheckpoint | null = null;
    const others: { name: string; record: unknown }[] = [];
    for (const file of read.files) {
      currentFile = file.name;
      const record = parseStoredRecord(file.name, file.content, originalSetId);
      if (file.name === CHECKPOINT_FILE) {
        checkpoint = parseCutoverSetRollbackCheckpoint(record);
        if (checkpoint.originalSetId !== originalSetId) invalid("checkpoint names another set");
      } else {
        others.push({ name: file.name, record });
      }
    }
    if (checkpoint === null) {
      // A present read holds at least one file, and none of them was the checkpoint.
      currentFile = others[0]!.name;
      throw new CutoverSetRollbackRecordError("checkpoint-missing", "a rollback record is stored without its checkpoint");
    }
    const installs = new Map<string, CutoverSetRollbackInstallRecord>();
    let selectionValue: unknown;
    let selectionPresent = false;
    for (const { name, record } of others) {
      currentFile = name;
      if (name === SELECTION_FILE) {
        selectionValue = record;
        selectionPresent = true;
        continue;
      }
      const index = Number(INSTALL_FILE_PATTERN.exec(name)![1]);
      const install = parseCutoverSetRollbackInstallRecord(record);
      const expected = checkpoint.members[index];
      if (expected === undefined || install.generationId !== expected.generationId || install.originalSetId !== originalSetId) {
        invalid("installation record names a member that is not the checkpoint's member at its index");
      }
      installs.set(install.generationId, install);
    }
    if (!selectionPresent) return { state: "resolved", checkpoint, installs, selection: null };
    currentFile = SELECTION_FILE;
    const selection = parseBackendCutoverSetRollbackSelection(selectionValue, checkpoint.manifest);
    assertCutoverSetRollbackSelectionDescendsFromRecords(checkpoint, installs, selection);
    return { state: "resolved", checkpoint, installs, selection };
  } catch (error) {
    return { state: "unresolvable", reason: currentFile + " cannot be trusted: " + (error as Error).message };
  }
}

function requireRecords(
  homeDir: string,
  originalSetId: string,
  dependencies: RecordMigrationSelectionBindingDependencies,
): Extract<CutoverSetRollbackRecords, { state: "resolved" }> {
  const stored = readCutoverSetRollbackRecords({ homeDir, originalSetId }, dependencies);
  if (stored.state === "unresolvable") {
    throw new CutoverSetRollbackRecordError("record-unresolvable", "stored cutover-set rollback records cannot be trusted: " + stored.reason);
  }
  if (stored.state === "authoritatively-absent") {
    throw new CutoverSetRollbackRecordError("checkpoint-missing", "no rollback checkpoint is stored for set " + originalSetId);
  }
  return stored;
}

/**
 * Durably record the rollback checkpoint, or reuse a byte-identical stored
 * one. The input is re-parsed (the checksum is re-derived) before any write;
 * different stored bytes are a MigrationBindingConflictError, never an
 * overwrite. Synchronous. First record of the rollback.
 */
export function recordCutoverSetRollbackCheckpoint(
  input: Readonly<{ homeDir: string; checkpoint: CutoverSetRollbackCheckpoint }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const checkpoint = parseCutoverSetRollbackCheckpoint(input.checkpoint);
  recordFile(homeDir, checkpoint.originalSetId, CHECKPOINT_FILE, checkpoint, MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES, dependencies);
}

/**
 * Durably record one member's installation evidence, or reuse a byte-identical
 * stored one. The checkpoint must already be stored and name the member
 * (checkpoint-missing / invalid-input otherwise); the record is written under
 * the member's manifest index. Synchronous.
 */
export function recordCutoverSetRollbackInstall(
  input: Readonly<{ homeDir: string; record: CutoverSetRollbackInstallRecord }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const record = parseCutoverSetRollbackInstallRecord(input.record);
  const stored = requireRecords(homeDir, record.originalSetId, dependencies);
  const index = stored.checkpoint.members.findIndex((member) => member.generationId === record.generationId);
  if (index < 0) invalid("the installation record names a member the checkpoint does not");
  recordFile(homeDir, record.originalSetId, installFileName(index), record, MAX_CUTOVER_SET_ROLLBACK_INSTALL_RECORD_BYTES, dependencies);
}

/**
 * Durably record the frozen thin tuple, or reuse a byte-identical stored one.
 * The checkpoint and every member's installation record must already be
 * stored, and the tuple must parse against the hold manifest and descend
 * from them. Synchronous. Last record of the rollback.
 */
export function recordCutoverSetRollbackSelection(
  input: Readonly<{ homeDir: string; selection: BackendCutoverSetRollbackSelection }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const originalSetId = validateGenerationId(input.selection?.originalSetId);
  const stored = requireRecords(homeDir, originalSetId, dependencies);
  let selection: BackendCutoverSetRollbackSelection;
  try {
    selection = parseBackendCutoverSetRollbackSelection(input.selection, stored.checkpoint.manifest);
  } catch (error) {
    invalid("cutover-set rollback selection is malformed: " + (error as Error).message);
  }
  assertCutoverSetRollbackSelectionDescendsFromRecords(stored.checkpoint, stored.installs, selection);
  recordFile(homeDir, originalSetId, SELECTION_FILE, selection, MAX_CUTOVER_SET_ROLLBACK_RECORD_BYTES, dependencies);
}

export type CutoverSetRollbackCommitmentResolution =
  | Readonly<{
    state: "resolved";
    originalSetId: string;
    records: Extract<CutoverSetRollbackRecords, { state: "resolved" }>;
    /** The member's checkpoint row. */
    member: CutoverSetRollbackCheckpointMember;
  }>
  /** The generation has no link, its link names its single-generation publication, or no rollback record exists for its set. */
  | Readonly<{ state: "absent"; cause: "unlinked" | "single-generation" | "no-rollback"; detail: string }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

export type ResolveCutoverSetRollbackCommitmentDependencies = Readonly<{
  readLink?: typeof readActivationGenerationLink;
  readRecords?: typeof readCutoverSetRollbackRecords;
}>;

/**
 * The rollback commitment a generation is under, from its own activation
 * link (C3): a link whose publication id is not the generation's own
 * single-generation id names a set, whose rollback records are read directly;
 * a stored checkpoint whose manifest names this generation is the commitment,
 * with or without a frozen selection. Nothing is inferred from a missing
 * record, no other generation's row is consulted and nothing is scanned.
 */
export function resolveCutoverSetRollbackCommitment(
  input: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: ResolveCutoverSetRollbackCommitmentDependencies = {},
): CutoverSetRollbackCommitmentResolution {
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const readLink = dependencies.readLink ?? readActivationGenerationLink;
  const readRecords = dependencies.readRecords ?? readCutoverSetRollbackRecords;
  const link = readLink({ homeDir, generationId });
  if (link.state === "unresolvable") return { state: "unresolvable", reason: "the generation link is unresolvable: " + link.detail };
  if (link.state === "authoritatively-absent") return { state: "absent", cause: "unlinked", detail: "the generation has no activation link" };
  if (link.link.publicationId === deriveActivationPublicationId(generationId)) {
    return { state: "absent", cause: "single-generation", detail: "the generation link names its single-generation publication" };
  }
  const originalSetId = link.link.publicationId;
  const records = readRecords({ homeDir, originalSetId });
  if (records.state === "unresolvable") return { state: "unresolvable", reason: "the set rollback records are unresolvable: " + records.reason };
  if (records.state === "authoritatively-absent") return { state: "absent", cause: "no-rollback", detail: "no rollback checkpoint is stored for set " + originalSetId };
  const member = records.checkpoint.members.find((candidate) => candidate.generationId === generationId);
  if (member === undefined) return { state: "unresolvable", reason: "the rollback checkpoint of set " + originalSetId + " has no row for generation " + generationId };
  return { state: "resolved", originalSetId, records, member };
}

