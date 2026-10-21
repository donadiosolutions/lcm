import { canonicalJson } from "../storage/portable-record.js";
import {
  BACKEND_PUBLICATION_MAX_JOURNAL_BYTES,
  backendCutoverSetManifestSha256,
  backendPublicationCanonicalSha256,
  parseBackendCutoverSetManifest,
  parseBackendCutoverSetSelection,
  type BackendCutoverSetManifest,
  type BackendCutoverSetSelection,
  type BackendCutoverSetSelectionMember,
} from "../storage/backend-publication.js";
import {
  readActivationArtifact,
  readActivationGenerationLink,
  type ActivationArtifactRecoveryMaterial,
  type ActivationGenerationLink,
} from "./activation-artifact-store.js";
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
 * The two durable records a cutover-set activation (#1549) writes before it
 * touches any member manifest and before it selects: the frozen activation
 * checkpoint and the frozen selection tuple. They live under
 * <home>/.lcm/migration-cutover-set-activation/<sha256hex(setId)>/ as
 * checkpoint.json and selection.json, on generation-binding-store.ts's
 * exported primitives (private directory authentication, durable create-only
 * writes, crash-twin recovery, read-only scan), exactly as the activation
 * evidence store is: the layout and crash discipline are written once.
 *
 * checkpoint.json (plan-v2 D3) is the authoritative pre-effect association:
 * the full set manifest, the held journal checksum, the shared publication id
 * (the set id) and artifact identity digest, and one row per member in
 * manifest order with its remote project, held member binding digest, copy
 * binding digest, frozen verified manifest revision/checksum and verification
 * report digest. A crash after it never recomposes publication material: a
 * resume reads the checkpoint and the artifact it names. It is not terminal
 * authority: it never revives an aborted set or authorizes a backend.
 *
 * selection.json (D4) is the complete terminal tuple storage defines
 * (BackendCutoverSetSelection): it names the checkpoint it descends from and
 * every member's selected epoch, attempt and witness. Once written, a retry
 * adopts exactly these attempts even if the journal never reached
 * selection-prepared; the journal's selection phases carry the same tuple.
 *
 * Both records are strict, canonical, bounded and immutable: byte-identical
 * content is reuse, any other content under the same name is a conflict
 * (MigrationBindingConflictError), and a failed read is never absence. The
 * reader proves the association between the two (checkpoint digest, set id,
 * identity, per-member rows) before it reports either.
 *
 * resolveCutoverSetActivationSelection (D7) is the read-only path replay and
 * recovery use to find a member's set selection from its own generation
 * link: a link whose publication id is not the generation's single-generation
 * id names a set publication and requires this store's aggregate; it never
 * falls back to an individual historical binding, and it never scans.
 */

const CUTOVER_SET_ACTIVATION_SUBDIRECTORY = "migration-cutover-set-activation";
const RECORD_WIRE_VERSION = 1 as const;
const CHECKPOINT_FILE = "checkpoint.json";
const SELECTION_FILE = "selection.json";
/**
 * Both records are bounded by the readable set journal: the selection tuple is
 * embedded verbatim in the journal at the selection phases, and the checkpoint
 * carries the same manifest with narrower member rows, so neither can exceed
 * the journal limit a set was admitted under (C6), shared from the storage
 * module rather than spelled twice. The single generation binding's
 * 4096-byte cap is not inherited.
 */
export const MAX_CUTOVER_SET_ACTIVATION_RECORD_BYTES = BACKEND_PUBLICATION_MAX_JOURNAL_BYTES;

const CUTOVER_SET_ACTIVATION_STORE: GenerationScopedStore = {
  subdirectory: CUTOVER_SET_ACTIVATION_SUBDIRECTORY,
  noun: "cutover-set activation record",
  maxFileBytes: MAX_CUTOVER_SET_ACTIVATION_RECORD_BYTES,
  isFinalFileName: (name) => name === CHECKPOINT_FILE || name === SELECTION_FILE,
};

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHECKPOINT_KEYS = [
  "checksumSha256", "heldJournalChecksumSha256", "identityDigest", "kind", "manifest", "members", "publicationId", "setId", "version",
] as const;
const CHECKPOINT_MEMBER_KEYS = [
  "copyBindingSha256", "epochManifestChecksumSha256", "epochManifestRevision", "generationId", "heldMemberChecksumSha256",
  "physicalProjectId", "remoteProjectId", "verificationReportSha256",
] as const;

/** The per-set directory the two records of a set live in. */
export function migrationCutoverSetActivationDirectory(homeDir: string, setId: string): string {
  return generationScopedDirectory(CUTOVER_SET_ACTIVATION_STORE, homeDir, setId);
}

export type CutoverSetActivationCheckpointMember = Readonly<{
  physicalProjectId: string;
  generationId: string;
  remoteProjectId: string;
  /** The member's held binding digest (phase maintenance-held), kept for post-selection snapshot checks (C10). */
  heldMemberChecksumSha256: string;
  copyBindingSha256: string;
  epochManifestRevision: number;
  epochManifestChecksumSha256: string;
  verificationReportSha256: string;
}>;

export type CutoverSetActivationCheckpoint = Readonly<{
  version: 1;
  kind: "cutover-set-activation-checkpoint";
  setId: string;
  manifest: BackendCutoverSetManifest;
  heldJournalChecksumSha256: string;
  publicationId: string;
  identityDigest: string;
  /** Manifest order. */
  members: readonly CutoverSetActivationCheckpointMember[];
  checksumSha256: string;
}>;

export type CreateCutoverSetActivationCheckpointInput = Omit<CutoverSetActivationCheckpoint, "version" | "kind" | "checksumSha256">;

export type CutoverSetActivationRecordReason =
  | "invalid-input"
  | "checkpoint-missing"
  | "selection-mismatch"
  | "record-unresolvable";

/** A record was refused before any write, or the stored records cannot be trusted. */
export class CutoverSetActivationRecordError extends Error {
  constructor(readonly reason: CutoverSetActivationRecordReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CutoverSetActivationRecordError";
  }
}

function invalid(message: string): never {
  throw new CutoverSetActivationRecordError("invalid-input", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

/** The checkpoint digest: canonical sha256 over every field but its own checksum. */
export function cutoverSetActivationCheckpointSha256(
  checkpoint: Omit<CutoverSetActivationCheckpoint, "checksumSha256">,
): string {
  const { checksumSha256: _checksum, ...body } = checkpoint as
    Omit<CutoverSetActivationCheckpoint, "checksumSha256"> & Partial<Pick<CutoverSetActivationCheckpoint, "checksumSha256">>;
  return backendPublicationCanonicalSha256(body);
}

/**
 * Strictly parse a checkpoint: the manifest through storage's own validator,
 * the set and publication ids those of the manifest, the members exactly the
 * manifest's in manifest order with well-formed digests, distinct remote
 * projects and safe revisions, and the checksum reproduced.
 */
export function parseCutoverSetActivationCheckpoint(value: unknown): CutoverSetActivationCheckpoint {
  if (
    !isRecord(value)
    || !exactKeys(value, CHECKPOINT_KEYS)
    || value.version !== 1
    || value.kind !== "cutover-set-activation-checkpoint"
    || !HASH_PATTERN.test(String(value.heldJournalChecksumSha256))
    || !HASH_PATTERN.test(String(value.identityDigest))
    || !HASH_PATTERN.test(String(value.checksumSha256))
    || !Array.isArray(value.members)
  ) {
    invalid("cutover-set activation checkpoint is malformed");
  }
  let manifest: BackendCutoverSetManifest;
  try {
    manifest = parseBackendCutoverSetManifest(value.manifest);
  } catch (error) {
    invalid("cutover-set activation checkpoint manifest is malformed: " + (error as Error).message);
  }
  if (value.setId !== manifest.setId || value.publicationId !== manifest.setId || value.members.length !== manifest.members.length) {
    invalid("cutover-set activation checkpoint does not restate its manifest");
  }
  const members = value.members.map((item, index): CutoverSetActivationCheckpointMember => {
    const expected = manifest.members[index]!;
    if (
      !isRecord(item)
      || !exactKeys(item, CHECKPOINT_MEMBER_KEYS)
      || item.physicalProjectId !== expected.physicalProjectId
      || item.generationId !== expected.generationId
      || typeof item.remoteProjectId !== "string"
      || !CANONICAL_UUID.test(item.remoteProjectId)
      || !HASH_PATTERN.test(String(item.heldMemberChecksumSha256))
      || !HASH_PATTERN.test(String(item.copyBindingSha256))
      || !HASH_PATTERN.test(String(item.epochManifestChecksumSha256))
      || !HASH_PATTERN.test(String(item.verificationReportSha256))
      || typeof item.epochManifestRevision !== "number"
      || !Number.isSafeInteger(item.epochManifestRevision)
      || item.epochManifestRevision < 0
    ) {
      invalid("cutover-set activation checkpoint member[" + index + "] is malformed");
    }
    return {
      physicalProjectId: item.physicalProjectId,
      generationId: item.generationId,
      remoteProjectId: item.remoteProjectId,
      heldMemberChecksumSha256: item.heldMemberChecksumSha256 as string,
      copyBindingSha256: item.copyBindingSha256 as string,
      epochManifestRevision: item.epochManifestRevision,
      epochManifestChecksumSha256: item.epochManifestChecksumSha256 as string,
      verificationReportSha256: item.verificationReportSha256 as string,
    };
  });
  if (new Set(members.map((member) => member.remoteProjectId)).size !== members.length) {
    invalid("cutover-set activation checkpoint remote projects are not unique");
  }
  const checkpoint: CutoverSetActivationCheckpoint = {
    version: 1,
    kind: "cutover-set-activation-checkpoint",
    setId: manifest.setId,
    manifest,
    heldJournalChecksumSha256: value.heldJournalChecksumSha256 as string,
    publicationId: manifest.setId,
    identityDigest: value.identityDigest as string,
    members,
    checksumSha256: value.checksumSha256 as string,
  };
  if (cutoverSetActivationCheckpointSha256(checkpoint) !== checkpoint.checksumSha256) {
    invalid("cutover-set activation checkpoint checksum does not match");
  }
  return checkpoint;
}

/** Seal a checkpoint from its body; the result is re-parsed, so a malformed body throws before any write. */
export function createCutoverSetActivationCheckpoint(input: CreateCutoverSetActivationCheckpointInput): CutoverSetActivationCheckpoint {
  const body = { version: 1 as const, kind: "cutover-set-activation-checkpoint" as const, ...input };
  return parseCutoverSetActivationCheckpoint({ ...body, checksumSha256: cutoverSetActivationCheckpointSha256(body) });
}

/**
 * Prove the selection tuple descends from the checkpoint: same checkpoint
 * digest, set, publication and artifact identity, and every member row
 * restating the checkpoint's remote project, copy binding and frozen
 * manifest pair. Throws selection-mismatch otherwise.
 */
export function assertCutoverSetSelectionDescendsFromCheckpoint(
  checkpoint: CutoverSetActivationCheckpoint,
  selection: BackendCutoverSetSelection,
): void {
  const mismatch = (detail: string): never => {
    throw new CutoverSetActivationRecordError("selection-mismatch", "cutover-set selection does not descend from the checkpoint: " + detail);
  };
  if (selection.checkpointSha256 !== checkpoint.checksumSha256) mismatch("checkpoint digest");
  if (selection.setId !== checkpoint.setId || selection.publicationId !== checkpoint.publicationId) mismatch("set or publication id");
  if (selection.identityDigest !== checkpoint.identityDigest) mismatch("artifact identity digest");
  if (selection.manifestSha256 !== backendCutoverSetManifestSha256(checkpoint.manifest)) mismatch("manifest digest");
  if (selection.members.length !== checkpoint.members.length) mismatch("member count");
  selection.members.forEach((member, index) => {
    const expected = checkpoint.members[index]!;
    if (
      member.physicalProjectId !== expected.physicalProjectId
      || member.generationId !== expected.generationId
      || member.remoteProjectId !== expected.remoteProjectId
      || member.copyBindingSha256 !== expected.copyBindingSha256
      || member.epochManifestRevision !== expected.epochManifestRevision
      || member.epochManifestChecksumSha256 !== expected.epochManifestChecksumSha256
    ) {
      mismatch("member " + expected.generationId);
    }
  });
}

function wireContent(setId: string, record: unknown): string {
  return canonicalJson({ version: RECORD_WIRE_VERSION, setId, record }) + "\n";
}

function recordFile(
  homeDir: string,
  setId: string,
  fileName: string,
  record: unknown,
  dependencies: RecordMigrationSelectionBindingDependencies,
): void {
  const serialized = wireContent(setId, record);
  if (Buffer.byteLength(serialized) > CUTOVER_SET_ACTIVATION_STORE.maxFileBytes) {
    invalid("cutover-set activation record " + fileName + " exceeds " + CUTOVER_SET_ACTIVATION_STORE.maxFileBytes + " bytes");
  }
  const reconcile: GenerationScopedReconciler = (stored) => (stored === serialized ? "reused" : "conflict");
  recordGenerationScopedFile(CUTOVER_SET_ACTIVATION_STORE, homeDir, setId, fileName, serialized, reconcile, dependencies);
}

export type CutoverSetActivationRecords =
  | Readonly<{ state: "resolved"; checkpoint: CutoverSetActivationCheckpoint; selection: BackendCutoverSetSelection | null }>
  | Readonly<{ state: "authoritatively-absent" }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

function parseStoredRecord(name: string, content: string, setId: string): unknown {
  const envelope: unknown = JSON.parse(content);
  if (
    !isRecord(envelope)
    || !exactKeys(envelope, ["record", "setId", "version"])
    || envelope.version !== RECORD_WIRE_VERSION
    || envelope.setId !== setId
  ) {
    invalid(name + " envelope is invalid");
  }
  if (content !== wireContent(setId, envelope.record)) invalid(name + " content is not canonical");
  return envelope.record;
}

/**
 * Read and verify the records of one set: "authoritatively-absent" has the
 * binding store's meaning (positively no store, no set directory, or an
 * authenticated empty one); a selection without its checkpoint, a record
 * that does not re-derive its checksum, an envelope naming another set or a
 * selection that does not descend from the checkpoint is "unresolvable".
 * Synchronous and read-only.
 */
export function readCutoverSetActivationRecords(
  input: Readonly<{ homeDir: string; setId: string }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): CutoverSetActivationRecords {
  const homeDir = validateHomeDir(input.homeDir);
  const setId = validateGenerationId(input.setId);
  const read = readGenerationScopedFiles(CUTOVER_SET_ACTIVATION_STORE, { homeDir, generationId: setId }, dependencies);
  if (read.kind === "absent") return { state: "authoritatively-absent" };
  if (read.kind === "unresolvable") return { state: "unresolvable", reason: read.reason };
  let currentFile = "";
  try {
    let checkpoint: CutoverSetActivationCheckpoint | null = null;
    let selectionValue: unknown;
    let selectionPresent = false;
    for (const file of read.files) {
      currentFile = file.name;
      const record = parseStoredRecord(file.name, file.content, setId);
      if (file.name === CHECKPOINT_FILE) {
        checkpoint = parseCutoverSetActivationCheckpoint(record);
        if (checkpoint.setId !== setId) invalid("checkpoint names another set");
      } else {
        selectionValue = record;
        selectionPresent = true;
      }
    }
    if (checkpoint === null) {
      currentFile = SELECTION_FILE;
      throw new CutoverSetActivationRecordError("checkpoint-missing", "a selection is stored without its checkpoint");
    }
    if (!selectionPresent) return { state: "resolved", checkpoint, selection: null };
    currentFile = SELECTION_FILE;
    const selection = parseBackendCutoverSetSelection(selectionValue, checkpoint.manifest);
    assertCutoverSetSelectionDescendsFromCheckpoint(checkpoint, selection);
    return { state: "resolved", checkpoint, selection };
  } catch (error) {
    return { state: "unresolvable", reason: currentFile + " cannot be trusted: " + (error as Error).message };
  }
}

function requireRecords(
  homeDir: string,
  setId: string,
  dependencies: RecordMigrationSelectionBindingDependencies,
): Extract<CutoverSetActivationRecords, { state: "resolved" }> | null {
  const stored = readCutoverSetActivationRecords({ homeDir, setId }, dependencies);
  if (stored.state === "unresolvable") {
    throw new CutoverSetActivationRecordError("record-unresolvable", "stored cutover-set activation records cannot be trusted: " + stored.reason);
  }
  return stored.state === "resolved" ? stored : null;
}

/**
 * Durably record the activation checkpoint, or reuse a byte-identical stored
 * one. The input is re-parsed (the checksum is re-derived) before any write;
 * different stored bytes are a MigrationBindingConflictError, never an
 * overwrite. Synchronous. First record of the set.
 */
export function recordCutoverSetActivationCheckpoint(
  input: Readonly<{ homeDir: string; checkpoint: CutoverSetActivationCheckpoint }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const checkpoint = parseCutoverSetActivationCheckpoint(input.checkpoint);
  recordFile(homeDir, checkpoint.setId, CHECKPOINT_FILE, checkpoint, dependencies);
}

/**
 * Durably record the frozen selection tuple, or reuse a byte-identical stored
 * one. The checkpoint must already be stored (checkpoint-missing otherwise)
 * and the tuple must parse against its manifest and descend from it
 * (selection-mismatch). Synchronous. Second and last record of the set.
 */
export function recordCutoverSetActivationSelection(
  input: Readonly<{ homeDir: string; selection: BackendCutoverSetSelection }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const setId = validateGenerationId(input.selection?.setId);
  const stored = requireRecords(homeDir, setId, dependencies);
  if (stored === null) {
    throw new CutoverSetActivationRecordError("checkpoint-missing", "no activation checkpoint is stored for set " + setId);
  }
  let selection: BackendCutoverSetSelection;
  try {
    selection = parseBackendCutoverSetSelection(input.selection, stored.checkpoint.manifest);
  } catch (error) {
    invalid("cutover-set selection is malformed: " + (error as Error).message);
  }
  assertCutoverSetSelectionDescendsFromCheckpoint(stored.checkpoint, selection);
  recordFile(homeDir, setId, SELECTION_FILE, selection, dependencies);
}

export type CutoverSetActivationSelectionResolution =
  | Readonly<{
    state: "resolved";
    setId: string;
    link: ActivationGenerationLink;
    checkpoint: CutoverSetActivationCheckpoint;
    selection: BackendCutoverSetSelection;
    /** The row of the generation that was asked about. */
    member: BackendCutoverSetSelectionMember;
    artifact: ActivationArtifactRecoveryMaterial;
  }>
  /** The generation has no link (unlinked), or its link names its own single-generation publication. */
  | Readonly<{ state: "absent"; cause: "unlinked" | "single-generation"; detail: string }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

export type ResolveCutoverSetActivationSelectionDependencies = Readonly<{
  readLink?: typeof readActivationGenerationLink;
  readArtifact?: typeof readActivationArtifact;
  readRecords?: typeof readCutoverSetActivationRecords;
}>;

/**
 * The set selection a generation belongs to, from its own generation link
 * (D7): a link whose publication id equals deriveActivationPublicationId
 * (generationId) is a single-generation activation and is "absent" here; any
 * other linked publication id is a set id and REQUIRES this store's
 * checkpoint and selection, the member's own row (matching the link's frozen
 * manifest pair) and the artifact the selection names, whose project rows
 * must be exactly the selection's members. Nothing is inferred from a
 * missing record, and no other generation's row is consulted. When
 * publicationId is supplied the link must name it.
 */
export function resolveCutoverSetActivationSelection(
  input: Readonly<{ homeDir: string; generationId: string; publicationId?: string }>,
  dependencies: ResolveCutoverSetActivationSelectionDependencies = {},
): CutoverSetActivationSelectionResolution {
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const readLink = dependencies.readLink ?? readActivationGenerationLink;
  const readArtifact = dependencies.readArtifact ?? readActivationArtifact;
  const readRecords = dependencies.readRecords ?? readCutoverSetActivationRecords;
  const unresolvable = (reason: string): CutoverSetActivationSelectionResolution => ({ state: "unresolvable", reason });

  const link = readLink({ homeDir, generationId });
  if (link.state === "unresolvable") return unresolvable("the generation link is unresolvable: " + link.detail);
  if (link.state === "authoritatively-absent") return { state: "absent", cause: "unlinked", detail: "the generation has no activation link" };
  if (link.link.publicationId === deriveActivationPublicationId(generationId)) {
    return { state: "absent", cause: "single-generation", detail: "the generation link names its single-generation publication" };
  }
  if (input.publicationId !== undefined && link.link.publicationId !== input.publicationId) {
    return unresolvable("the generation link names publication " + link.link.publicationId + ", not " + input.publicationId);
  }
  const setId = link.link.publicationId;
  const records = readRecords({ homeDir, setId });
  if (records.state === "unresolvable") return unresolvable("the set activation records are unresolvable: " + records.reason);
  if (records.state === "authoritatively-absent") return unresolvable("the generation is linked to set publication " + setId + " but no set activation checkpoint is stored");
  if (records.selection === null) return unresolvable("set " + setId + " has a checkpoint but no frozen selection");
  const { checkpoint, selection } = records;
  const member = selection.members.find((candidate) => candidate.generationId === generationId);
  if (member === undefined) return unresolvable("the set selection has no row for generation " + generationId);
  if (
    member.epochManifestRevision !== link.link.epochManifestRevision
    || member.epochManifestChecksumSha256 !== link.link.epochManifestChecksumSha256
    || selection.identityDigest !== link.link.identityDigest
  ) {
    return unresolvable("the generation link does not agree with the set selection row");
  }
  let artifact: ActivationArtifactRecoveryMaterial | null;
  try {
    artifact = readArtifact({ homeDir, identityDigest: selection.identityDigest });
  } catch (error) {
    return unresolvable("the set artifact is unresolvable: " + (error as Error).message);
  }
  if (artifact === null) return unresolvable("the set artifact at " + selection.identityDigest + " is absent");
  if (artifact.publicationId !== setId) return unresolvable("the set artifact was sealed under another publication");
  // The artifact's rows are canonically sorted by local project id, as the manifest's members are.
  const rows = artifact.projects;
  const coverageMatches = rows.length === selection.members.length && rows.every((row, index) => {
    const expected = selection.members[index]!;
    return row.localProjectId === expected.physicalProjectId
      && row.remoteProjectId === expected.remoteProjectId
      && row.evidenceSha256 === expected.copyBindingSha256;
  });
  if (!coverageMatches) return unresolvable("the set artifact does not cover exactly the selection's members");
  return { state: "resolved", setId, link: link.link, checkpoint, selection, member, artifact };
}

