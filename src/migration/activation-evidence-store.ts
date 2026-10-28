import { canonicalJson } from "../storage/portable-record.js";
import {
  MigrationActivationWitnessError,
  createMigrationActivationWitness,
  migrationWitnessSha256,
  parseMigrationActivationAttempt,
  parseMigrationActivationEpoch,
  parseMigrationActivationWitness,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationActivationWitness,
} from "./activation-witness.js";
import {
  generationScopedDirectory,
  readGenerationScopedFiles,
  recordGenerationScopedFile,
  type GenerationScopedPendingWrite,
  validateGenerationId,
  validateHomeDir,
  type GenerationScopedReconciler,
  type GenerationScopedStore,
  type RecordMigrationSelectionBindingDependencies,
} from "./generation-binding-store.js";

/**
 * Durable, immutable storage for the activation evidence records that the
 * rollback path must be able to read back later: the activation epoch, each
 * activation attempt, and each witness (activation or rollback). They are
 * the records activation-witness.ts defines; this module only persists and
 * re-reads them, and it re-derives every identity on both sides so a record
 * whose id or checksum does not match its own preimage can never be stored
 * or trusted.
 *
 * Layout. <home>/.lcm/migration-activation-evidence/<sha256hex(generationId)>/
 * holds epoch-<epochId>.json, attempt-<attemptId>.json and
 * witness-<checksumSha256>.json. The directory scheme, the private-directory
 * authentication, the durable create-only write, the post-link scratch-twin
 * recovery and the read-only scan are generation-binding-store.ts's own
 * (one implementation, shared through its exported GenerationScopedStore
 * primitives), so the two stores cannot drift apart. Errors from those
 * primitives (MigrationBindingConflictError, MigrationBindingUnresolvableError,
 * MigrationBindingUnsafeStorageError) are this module's too.
 *
 * Immutability. A record is written once with a create-only durable write.
 * Writing byte-identical content again is reuse (the ordinary crash-retry
 * path); any other content under an existing key is a
 * MigrationBindingConflictError and is never overwritten.
 *
 * Ordering contract. An activation driver MUST durably record the epoch,
 * then the attempt, then the witness, then the witness binding, all before it
 * prepares the activation selection; the selection binding follows selection
 * completion (coordinator-seam-FROZEN.md sections 17-18). This module
 * enforces the part it can: an attempt requires its epoch to be stored, and a
 * witness requires its epoch and the attempt it names, and must be exactly
 * what createMigrationActivationWitness mints from those stored records plus
 * the witness's own kind, post-epoch evidence and rollback mode -- so a
 * mutated witness whose checksum was merely recomputed is refused. The
 * reader repeats every one of these checks.
 *
 * What rollback concludes from this store. Rollback's "unactivated" (which it refuses) needs
 * three independent observations to agree (rollback-eligibility.ts): this
 * store authoritatively absent (or holding an epoch with no selection), the
 * binding store free of any activation selection, and the operability fact
 * not completed. Corrupting any one of them alone refuses.
 */

const ACTIVATION_EVIDENCE_SUBDIRECTORY = "migration-activation-evidence";
const ACTIVATION_EVIDENCE_WIRE_VERSION = 1 as const;
/** Generous multiple of the largest legitimate record: a census vector or
 * canonical delta is a few hundred bytes per portable domain, while an
 * attempt additionally carries two opaque evidence envelopes. */
const MAX_ACTIVATION_EVIDENCE_FILE_BYTES = 256 * 1024;
const ACTIVATION_EVIDENCE_FILE_NAME_PATTERN = /^(?:epoch|attempt|witness)-[0-9a-f]{64}\.json$/u;

const ACTIVATION_EVIDENCE_STORE: GenerationScopedStore = {
  subdirectory: ACTIVATION_EVIDENCE_SUBDIRECTORY,
  noun: "activation evidence record",
  maxFileBytes: MAX_ACTIVATION_EVIDENCE_FILE_BYTES,
  isFinalFileName: (name) => ACTIVATION_EVIDENCE_FILE_NAME_PATTERN.test(name),
};

/** The per-generation directory the evidence records of a generation live in. */
export function migrationActivationEvidenceDirectory(homeDir: string, generationId: string): string {
  return generationScopedDirectory(ACTIVATION_EVIDENCE_STORE, homeDir, generationId);
}

export type MigrationActivationEvidenceRefusalReason =
  | "evidence-unresolvable"
  | "epoch-missing"
  | "attempt-missing"
  | "witness-does-not-reproduce";

/** A writer refused because the stored evidence does not support the
 * record, or because the stored evidence could not be read. Nothing was
 * written. */
export class MigrationActivationEvidenceRefusalError extends Error {
  constructor(
    readonly reason: MigrationActivationEvidenceRefusalReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationActivationEvidenceRefusalError";
  }
}

export type MigrationActivationEvidenceResolution =
  | Readonly<{
    state: "resolved";
    /** Every list is ascending by id (checksum for witnesses). A resolved
     * store always holds at least one epoch: an attempt or witness without
     * its epoch makes the store unresolvable. */
    epochs: readonly MigrationActivationEpoch[];
    attempts: readonly MigrationActivationAttempt[];
    witnesses: readonly MigrationActivationWitness[];
  }>
  | Readonly<{ state: "authoritatively-absent" }>
  | Readonly<{ state: "unresolvable"; reason: string }>;

/** Full records for one activation attempt (Boundary E, amendment A4). */
export type RollbackAuthoritativeContext = Readonly<{
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  /** The stored witness the caller named, or null when none was named. */
  witness: MigrationActivationWitness | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceWireContent(generationId: string, record: unknown): string {
  return canonicalJson({
    version: ACTIVATION_EVIDENCE_WIRE_VERSION,
    generationId,
    record,
  }) + "\n";
}

type ParsedEvidenceFile =
  | Readonly<{ epoch: MigrationActivationEpoch }>
  | Readonly<{ attempt: MigrationActivationAttempt }>
  | Readonly<{ witness: MigrationActivationWitness }>;

/**
 * Parse one stored file: the envelope, the generationId cross-check, the
 * record through activation-witness.ts's own parser (which re-derives the id
 * or checksum), the file name's key against the parsed record, and finally
 * the writer's canonical bytes. Throws on any deviation.
 */
function parseStoredEvidenceFile(name: string, content: string, generationId: string): ParsedEvidenceFile {
  const envelope: unknown = JSON.parse(content);
  if (
    !isRecord(envelope)
    || Object.keys(envelope).sort().join(",") !== "generationId,record,version"
    || envelope.version !== ACTIVATION_EVIDENCE_WIRE_VERSION
    || envelope.generationId !== generationId
  ) {
    throw new MigrationActivationWitnessError("malformed-record", "evidence envelope is invalid");
  }
  let parsed: ParsedEvidenceFile;
  let expectedName: string;
  if (name.startsWith("epoch-")) {
    const epoch = parseMigrationActivationEpoch(envelope.record);
    if (epoch.generationId !== generationId) {
      throw new MigrationActivationWitnessError("unexpected-state", "epoch belongs to another generation");
    }
    parsed = { epoch };
    expectedName = "epoch-" + epoch.epochId + ".json";
  } else if (name.startsWith("attempt-")) {
    const attempt = parseMigrationActivationAttempt(envelope.record);
    parsed = { attempt };
    expectedName = "attempt-" + attempt.attemptId + ".json";
  } else {
    const witness = parseMigrationActivationWitness(envelope.record);
    parsed = { witness };
    expectedName = "witness-" + witness.checksumSha256 + ".json";
  }
  if (name !== expectedName) {
    throw new MigrationActivationWitnessError("unexpected-state", "file name does not match the stored record key");
  }
  const record = "epoch" in parsed ? parsed.epoch : "attempt" in parsed ? parsed.attempt : parsed.witness;
  if (content !== evidenceWireContent(generationId, record)) {
    throw new MigrationActivationWitnessError("unexpected-state", "content is not canonical");
  }
  return parsed;
}

/**
 * True only when the witness is exactly what createMigrationActivationWitness
 * mints from the stored epoch and attempt plus the witness's own kind,
 * post-epoch evidence and rollback mode: every field and the checksum. The
 * minter throws when the pieces do not fit together (for example a rollback
 * mode its evidence does not classify to); a witness that cannot be minted
 * is not reproduced.
 */
function witnessReproduces(
  epoch: MigrationActivationEpoch,
  attempt: MigrationActivationAttempt,
  witness: MigrationActivationWitness,
): boolean {
  try {
    const minted = createMigrationActivationWitness({
      kind: witness.kind,
      epoch,
      attempt,
      postEpochDelta: witness.postEpochDelta,
      postEpochCensus: witness.postEpochCensus,
      rollbackMode: witness.rollbackMode,
    });
    return migrationWitnessSha256(minted) === migrationWitnessSha256(witness);
  } catch {
    return false;
  }
}

/**
 * Read and verify everything recorded for a generation. "authoritatively-
 * absent" has generation-binding-store.ts's meaning: a positively absent
 * store or generation directory under an authenticated parent, or an
 * authenticated directory with no record. Every other failure -- an
 * unreadable or unauthenticated entry, an unknown name, a record that does
 * not re-derive its own id or checksum, a key that disagrees with its
 * content, an attempt whose epoch is not stored, or a witness that
 * createMigrationActivationWitness does not reproduce from its stored epoch
 * and attempt -- is "unresolvable". Synchronous and read-only.
 */
export function readMigrationActivationEvidence(
  input: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): MigrationActivationEvidenceResolution {
  return readStoredEvidence(input, dependencies, []);
}

/**
 * readMigrationActivationEvidence plus the records a writer is about to
 * write. A lone writer scratch of exactly one of those records, with its
 * final absent, is the writer's own interrupted write: it is ignored (and
 * never reported as stored) so the retry can publish the final and clear the
 * scratch. The exported reader passes none and stays strict.
 */
function readStoredEvidence(
  input: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: RecordMigrationSelectionBindingDependencies,
  pending: readonly GenerationScopedPendingWrite[],
): MigrationActivationEvidenceResolution {
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const read = readGenerationScopedFiles(ACTIVATION_EVIDENCE_STORE, { homeDir, generationId }, dependencies, pending);
  if (read.kind === "absent") return { state: "authoritatively-absent" };
  if (read.kind === "unresolvable") return { state: "unresolvable", reason: read.reason };
  const epochs = new Map<string, MigrationActivationEpoch>();
  const attempts = new Map<string, MigrationActivationAttempt>();
  const witnesses = new Map<string, MigrationActivationWitness>();
  let currentFile = "";
  try {
    for (const file of read.files) {
      currentFile = file.name;
      const parsed = parseStoredEvidenceFile(file.name, file.content, generationId);
      if ("epoch" in parsed) epochs.set(parsed.epoch.epochId, parsed.epoch);
      else if ("attempt" in parsed) attempts.set(parsed.attempt.attemptId, parsed.attempt);
      else witnesses.set(parsed.witness.checksumSha256, parsed.witness);
    }
    for (const attempt of attempts.values()) {
      currentFile = "attempt-" + attempt.attemptId + ".json";
      if (!epochs.has(attempt.epochId)) {
        throw new MigrationActivationWitnessError("unexpected-state", "attempt names an epoch that is not stored");
      }
    }
    for (const witness of witnesses.values()) {
      currentFile = "witness-" + witness.checksumSha256 + ".json";
      const epoch = epochs.get(witness.epochId);
      const attempt = attempts.get(witness.attemptId);
      if (epoch === undefined || attempt === undefined) {
        throw new MigrationActivationWitnessError("unexpected-state", "witness names an epoch or attempt that is not stored");
      }
      if (!witnessReproduces(epoch, attempt, witness)) {
        throw new MigrationActivationWitnessError("unexpected-state", "witness is not what its stored epoch and attempt mint");
      }
    }
  } catch (error) {
    return { state: "unresolvable", reason: currentFile + " cannot be trusted: " + (error as Error).message };
  }
  return {
    state: "resolved",
    epochs: [...epochs.values()],
    attempts: [...attempts.values()],
    witnesses: [...witnesses.values()],
  };
}

function requireStoredEvidence(
  homeDir: string,
  generationId: string,
  dependencies: RecordMigrationSelectionBindingDependencies,
  pending: readonly GenerationScopedPendingWrite[] = [],
): Extract<MigrationActivationEvidenceResolution, { state: "resolved" }> | null {
  const stored = readStoredEvidence({ homeDir, generationId }, dependencies, pending);
  if (stored.state === "unresolvable") {
    throw new MigrationActivationEvidenceRefusalError(
      "evidence-unresolvable",
      "stored activation evidence cannot be trusted: " + stored.reason,
    );
  }
  return stored.state === "resolved" ? stored : null;
}

function recordEvidence(
  homeDir: string,
  generationId: string,
  fileName: string,
  serialized: string,
  dependencies: RecordMigrationSelectionBindingDependencies,
): void {
  const reconcile: GenerationScopedReconciler = (stored) => (stored === serialized ? "reused" : "conflict");
  recordGenerationScopedFile(
    ACTIVATION_EVIDENCE_STORE, homeDir, generationId, fileName, serialized, reconcile, dependencies,
  );
}

/**
 * Durably record an activation epoch, or reuse a byte-identical stored one.
 * The input is re-parsed, which recomputes epochId, so a record whose id
 * does not match its preimage is refused (MigrationActivationWitnessError)
 * before any write. Synchronous. First step of the ordering contract.
 */
export function recordMigrationActivationEpoch(
  input: Readonly<{ homeDir: string; epoch: MigrationActivationEpoch }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const epoch = parseMigrationActivationEpoch(input.epoch);
  recordEvidence(
    homeDir, epoch.generationId, "epoch-" + epoch.epochId + ".json", evidenceWireContent(epoch.generationId, epoch), dependencies,
  );
}

/**
 * Durably record an activation attempt, or reuse a byte-identical stored
 * one. Requires the epoch the attempt names to be stored for this
 * generation already (MigrationActivationEvidenceRefusalError
 * "epoch-missing" otherwise). Synchronous. Second step of the ordering
 * contract.
 *
 * Crash recovery. A lone writer scratch of this very attempt (final absent,
 * byte-identical to the bytes about to be written) is an interrupted first
 * write: the retry publishes the final and clears the scratch. An activation
 * driver that also holds the witness it will record next passes it as
 * nextWitness: a lone scratch of exactly that witness (an interrupted witness
 * write, which leaves the attempt final and a witness scratch) then does not
 * block this idempotent re-entry either. nextWitness is parsed and must name
 * this attempt and its epoch (MigrationActivationWitnessError
 * "unexpected-state" otherwise, before any read or write); it is never
 * written here -- the witness writer alone records it, with its full checks.
 * Any other lone scratch still makes the store unresolvable.
 */
export function recordMigrationActivationAttempt(
  input: Readonly<{
    homeDir: string;
    generationId: string;
    attempt: MigrationActivationAttempt;
    nextWitness?: MigrationActivationWitness;
  }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const attempt = parseMigrationActivationAttempt(input.attempt);
  const fileName = "attempt-" + attempt.attemptId + ".json";
  const serialized = evidenceWireContent(generationId, attempt);
  const pending: GenerationScopedPendingWrite[] = [{ fileName, content: serialized }];
  if (input.nextWitness !== undefined) {
    const nextWitness = parseMigrationActivationWitness(input.nextWitness);
    if (nextWitness.attemptId !== attempt.attemptId || nextWitness.epochId !== attempt.epochId) {
      throw new MigrationActivationWitnessError(
        "unexpected-state",
        "the next witness does not name the attempt being recorded and its epoch",
      );
    }
    pending.push({
      fileName: "witness-" + nextWitness.checksumSha256 + ".json",
      content: evidenceWireContent(generationId, nextWitness),
    });
  }
  const stored = requireStoredEvidence(homeDir, generationId, dependencies, pending);
  if (stored === null || !stored.epochs.some((epoch) => epoch.epochId === attempt.epochId)) {
    throw new MigrationActivationEvidenceRefusalError(
      "epoch-missing",
      "the activation epoch " + attempt.epochId + " is not stored for this generation",
    );
  }
  recordEvidence(homeDir, generationId, fileName, serialized, dependencies);
}

/**
 * Durably record a witness (activation or rollback), or reuse a
 * byte-identical stored one. The generation's epoch and the attempt the
 * witness names must be stored already, and the witness must equal what
 * createMigrationActivationWitness mints from them and the witness's own
 * kind, post-epoch evidence and rollback mode -- every field and the
 * checksum. Refusals are typed and nothing is written. Synchronous. Third
 * step of the ordering contract. A lone writer scratch of this very witness
 * (final absent, byte-identical) is an interrupted first write and is
 * finished by the retry, as for the attempt.
 */
export function recordMigrationActivationWitness(
  input: Readonly<{ homeDir: string; generationId: string; witness: MigrationActivationWitness }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const homeDir = validateHomeDir(input.homeDir);
  const generationId = validateGenerationId(input.generationId);
  const witness = parseMigrationActivationWitness(input.witness);
  const fileName = "witness-" + witness.checksumSha256 + ".json";
  const serialized = evidenceWireContent(generationId, witness);
  const stored = requireStoredEvidence(homeDir, generationId, dependencies, [{ fileName, content: serialized }]);
  const epoch = stored?.epochs.find((candidate) => candidate.epochId === witness.epochId);
  if (epoch === undefined) {
    throw new MigrationActivationEvidenceRefusalError(
      "epoch-missing",
      "the activation epoch " + witness.epochId + " is not stored for this generation",
    );
  }
  const attempt = stored!.attempts.find((candidate) => candidate.attemptId === witness.attemptId);
  if (attempt === undefined) {
    throw new MigrationActivationEvidenceRefusalError(
      "attempt-missing",
      "the activation attempt " + witness.attemptId + " is not stored for this generation",
    );
  }
  if (!witnessReproduces(epoch, attempt, witness)) {
    throw new MigrationActivationEvidenceRefusalError(
      "witness-does-not-reproduce",
      "the witness is not what its stored epoch and attempt mint",
    );
  }
  recordEvidence(homeDir, generationId, fileName, serialized, dependencies);
}

/**
 * Boundary E (amendment A4): the full epoch and attempt records an
 * authoritative selection names, plus the named witness when a checksum is
 * supplied. Returns null only for a resolved store that lacks the pair (or
 * the named witness, or whose witness names a different pair); an absent
 * store returns null as well, since nothing in it can be authoritative. An
 * unresolvable store throws MigrationActivationEvidenceRefusalError
 * ("evidence-unresolvable"): refusal, never null.
 */
export async function resolveRollbackAuthoritativeContext(
  input: Readonly<{
    homeDir: string;
    generationId: string;
    epochId: string;
    attemptId: string;
    witnessChecksumSha256?: string;
  }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): Promise<RollbackAuthoritativeContext | null> {
  const stored = requireStoredEvidence(input.homeDir, input.generationId, dependencies);
  if (stored === null) return null;
  const epoch = stored.epochs.find((candidate) => candidate.epochId === input.epochId);
  const attempt = stored.attempts.find((candidate) => candidate.attemptId === input.attemptId);
  if (epoch === undefined || attempt === undefined || attempt.epochId !== epoch.epochId) return null;
  if (input.witnessChecksumSha256 === undefined) return { epoch, attempt, witness: null };
  const witness = stored.witnesses.find((candidate) => candidate.checksumSha256 === input.witnessChecksumSha256);
  if (witness === undefined || witness.epochId !== epoch.epochId || witness.attemptId !== attempt.attemptId) return null;
  return { epoch, attempt, witness };
}
