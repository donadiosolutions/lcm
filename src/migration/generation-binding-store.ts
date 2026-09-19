import { join } from "node:path";
import { canonicalJson, sha256 } from "../storage/portable-record.js";
import {
  PRIVATE_FILE_MODE,
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  type BoundedFileResult,
} from "../security-files.js";
import { attributeNullableRead } from "./activation-absence.js";

/**
 * Crash-safe, idempotent, synchronous persistence for the two durable
 * artifacts contract section 14 introduced and sections 17 and 18 gave a
 * write side: a *selection* binding (authority -- who is allowed to answer
 * for a generation) and a *witness* binding (evidence -- that an attempt
 * happened). Both live beneath one per-generation directory and share every
 * mechanism below; they differ in shape, key, reconciliation comparison and
 * the file name each entry point derives that shared core with.
 *
 * Why one store, two entry points, one shared core. A selection binding is
 * keyed by (generation, kind): at most two files per generation, because
 * only one activation and one rollback selection can ever be authoritative
 * at a time. A witness binding is keyed by (generation, witnessChecksumSha256)
 * instead: several attempts can share a generation and a kind after a
 * takeover-and-retry, and each mints its own witness before its selection is
 * even prepared, so a kind-keyed store would silently overwrite an earlier
 * attempt's evidence with a later one's. Both keys resolve to a file name
 * inside the same per-generation directory, so recordMigrationSelectionBinding
 * and recordMigrationWitnessBinding are two thin callers over one
 * recordGenerationBindingFile core: directory layout, private-directory
 * authentication, the durable write and the existing-file presence check are
 * written once, parameterised by a file name and a reconciliation
 * comparator, never welded to one kind of binding.
 *
 * Directory-traversal safety. generationId is never interpolated into a path
 * raw; the per-generation directory name is sha256hex(generationId). The
 * wire content below always embeds the *same* generationId the caller
 * supplied, and every reconciliation comparator below cross-checks it
 * against whatever is already on disk before treating a match as reuse: a
 * caller-observable hash collision between two different generationId
 * strings would land in the same directory but fail that cross-check, and
 * is therefore reported as a conflict rather than silently accepted.
 *
 * Reconciliation is NOT the same comparison for both writers, and that
 * asymmetry is deliberate rather than an oversight to "unify" later.
 *
 * The selection writer compares the full serialized record byte-for-byte:
 * every field of a MigrationSelectionBinding is deterministic, so a retry
 * must always reproduce identical bytes, and any difference at all is two
 * publications claiming one authority -- always a conflict.
 *
 * The witness writer compares only the fields section 4's checksum preimage
 * actually covers -- kind, epochId and attemptId -- plus the generationId
 * cross-check every write already performs; it deliberately does NOT compare
 * manifestRevision. The key is witnessChecksumSha256 itself, and that digest
 * does not cover manifestRevision, so manifestRevision is the one field that
 * can legitimately differ between two writes under one key: a crash after
 * the first durable write, with other transitions sealing in between,
 * produces a legitimate rewrite of the same witness at a higher revision. A
 * whole-record comparison would refuse there, permanently, on exactly the
 * path recovery is supposed to take. So the witness writer treats
 * manifestRevision as first-write-wins lineage metadata: on a match of the
 * digest-covered fields, the stored file is left exactly as it is, never
 * rewritten, because section 14 already says witness ordering carries
 * lineage and never authority, and the first durable record sits closest to
 * the moment the witness was actually minted. Only a mismatch of a
 * digest-covered field (or the generationId cross-check) is a witness
 * conflict, and under a key that IS that digest, that can only mean two
 * different preimages produced one SHA-256 -- a collision or corruption,
 * genuinely exceptional, which is exactly why it still gets a
 * distinguishable error rather than being silently resolved either way.
 *
 * Idempotency and the crash window, restated for both writers together.
 * Recording the exact same binding a second time is the ordinary recovery
 * action, never an anomaly: reconciliation reads the existing file back and
 * returns normally when the writer's own comparison finds a match, while a
 * genuine mismatch is refused as MigrationBindingConflictError. The durable
 * write itself reuses atomicWritePrivateFileDurable with requireAbsent, so a
 * crash mid-write converges on retry instead of stranding: the destination
 * is only ever fully-written-and-synced or absent, never truncated, and a
 * benign concurrent-collision race is reconciled the same way a
 * crash-then-retry is, by re-reading and comparing rather than failing
 * outright.
 *
 * Ordering is a caller obligation, not something this module enforces. A
 * witness binding is written *before* its selection is prepared -- it is
 * evidence an attempt happened -- while a selection binding is written only
 * *after* its selection completes -- it is authority over what was
 * published. Section 14 drew that split after an earlier version of the
 * governing contract inferred authority from revision order and was wrong
 * in an ordinary crash state; this module preserves the split by keeping
 * the two writers as genuinely independent entry points rather than
 * collapsing them back into one call a caller could invoke out of order.
 *
 * Synchronous by requirement, not by style. Neither entry point contains an
 * await, a Promise or an async call anywhere in its call path. Both are
 * called from inside a retained fenced window right before that window's
 * barrier token is released, and an async writer there would reintroduce
 * the suspend-across-await hazard the lock seam was closed against.
 *
 * attemptId is validated for shape only, everywhere in this module, and
 * never asserted to be stable across a retry: its derivation is unsettled
 * upstream and owned by a separate item. This module's per-witness keying
 * contains that hazard's blast radius (two attempts with different
 * digest-covered observations simply land under two different keys and are
 * both stored, never refused), but it does not repair it: two attempts that
 * are genuinely indistinguishable under a colliding attemptId remain
 * indistinguishable here.
 *
 * Presence and unsafe-storage handling mirror the sibling activation-
 * artifact-store.ts exactly: every nullable read goes through
 * activation-absence.ts's attributeNullableRead so a read that found
 * nothing and a read that could not be completed are never folded into the
 * same conclusion, and the private LCM root is authenticated but never
 * created by this module -- only the store subdirectory and the
 * per-generation directory beneath it are.
 */

const GENERATION_BINDING_SUBDIRECTORY = "migration-generation-bindings";
const GENERATION_BINDING_WIRE_VERSION = 1 as const;
/** A serialized binding line is a handful of short tokens plus small JSON
 * structure -- comfortably under a few hundred bytes even at every field's
 * maximum length (three 128-character tokens, a 64-character checksum, and
 * a 17-digit manifest revision). This bound is a generous multiple of that
 * worst case, matching the sibling store's convention of bounding reads well
 * above the largest legitimate record rather than tightly to it. */
const MAX_GENERATION_BINDING_FILE_BYTES = 4096;
const GENERATION_BINDING_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WITNESS_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;

const SELECTION_BINDING_KEYS = [
  "attemptId",
  "epochId",
  "kind",
  "manifestRevision",
  "publicationId",
  "witnessChecksumSha256",
] as const;
const WITNESS_BINDING_KEYS = [
  "attemptId",
  "epochId",
  "kind",
  "manifestRevision",
  "witnessChecksumSha256",
] as const;
const TOP_LEVEL_INPUT_KEYS = ["binding", "generationId", "homeDir"] as const;

/** Authority over a generation: who is allowed to answer for it, written
 * only after its selection completes. See section 14 of the coordinator-seam
 * contract for the full shape rationale; this module does not restate it. */
export type MigrationSelectionBinding = Readonly<{
  kind: "activation" | "rollback";
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
  publicationId: string;
}>;

/** Evidence that one attempt happened, written before its selection is
 * prepared. Deliberately has no publicationId: a witness is not authority. */
export type MigrationWitnessBinding = Readonly<{
  kind: "activation" | "rollback";
  epochId: string;
  attemptId: string;
  manifestRevision: number;
  witnessChecksumSha256: string;
}>;

/** The candidate input (or a caller-supplied binding within it) does not
 * satisfy this module's shape rules. Thrown strictly before any I/O. */
export class MigrationBindingValidationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationBindingValidationError";
  }
}

/** A binding already exists at the candidate's key with content that does
 * not reconcile with the candidate: a whole-record mismatch for a selection
 * (two publications claiming one authority), or a mismatch of a
 * digest-covered field for a witness (a checksum collision or corruption).
 * Never overwritten; the caller must investigate rather than have this
 * module silently resolve it either way. */
export class MigrationBindingConflictError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationBindingConflictError";
  }
}

/** A read needed to decide whether a binding already exists could not be
 * completed (attributed by activation-absence.ts as "unresolvable", e.g.
 * permission denied) rather than genuinely finding nothing. This module
 * refuses instead of guessing that the read failure means absence. */
export class MigrationBindingUnresolvableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationBindingUnresolvableError";
  }
}

/** The private LCM root, the generation-binding store subdirectory, or the
 * per-generation directory beneath it is missing or fails private-directory
 * authentication. The private LCM root itself is never created here. */
export class MigrationBindingUnsafeStorageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationBindingUnsafeStorageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

/** Matches security-files.ts's own internal currentUid helper (and its
 * repeated copies across manifest-store.ts, activation-artifact-store.ts,
 * and others): a local one-line duplicate rather than a cross-module
 * import, which is the established convention throughout this codebase. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function rootPath(homeDir: string): string {
  return join(homeDir, ".lcm");
}

/** The generation-binding store subdirectory beneath the private LCM root. */
export function migrationGenerationBindingStoreDirectory(homeDir: string): string {
  return join(rootPath(homeDir), GENERATION_BINDING_SUBDIRECTORY);
}

/** The per-generation directory both binding families share, named by
 * sha256hex(generationId) rather than the raw id so no caller-supplied
 * value can traverse or escape the store. */
export function migrationGenerationBindingDirectory(homeDir: string, generationId: string): string {
  return join(migrationGenerationBindingStoreDirectory(homeDir), sha256(generationId));
}

/** The path a selection binding of a given kind is stored at. At most one
 * file per (generation, kind) can ever exist. */
export function migrationSelectionBindingPath(
  homeDir: string,
  generationId: string,
  kind: "activation" | "rollback",
): string {
  return join(migrationGenerationBindingDirectory(homeDir, generationId), `selection-${kind}.binding`);
}

/** The path a witness binding for a given checksum is stored at. Several
 * witness files can coexist per (generation, kind); the key is the checksum,
 * never the kind alone. */
export function migrationWitnessBindingPath(
  homeDir: string,
  generationId: string,
  witnessChecksumSha256: string,
): string {
  return join(
    migrationGenerationBindingDirectory(homeDir, generationId),
    `witness-${witnessChecksumSha256}.binding`,
  );
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !GENERATION_BINDING_TOKEN_PATTERN.test(value)) {
    throw new MigrationBindingValidationError(field + " is invalid");
  }
}

function assertKind(value: unknown): asserts value is "activation" | "rollback" {
  if (value !== "activation" && value !== "rollback") {
    throw new MigrationBindingValidationError("binding kind is invalid");
  }
}

function assertManifestRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MigrationBindingValidationError("manifestRevision is invalid");
  }
}

function assertWitnessChecksum(value: unknown): asserts value is string {
  if (typeof value !== "string" || !WITNESS_CHECKSUM_PATTERN.test(value)) {
    throw new MigrationBindingValidationError("witnessChecksumSha256 is invalid");
  }
}

function validateHomeDir(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationBindingValidationError("homeDir is invalid");
  }
  return value;
}

function validateGenerationId(value: unknown): string {
  assertToken(value, "generationId");
  return value;
}

function validateTopLevelInput(input: unknown, functionName: string): Record<string, unknown> {
  if (!isRecord(input) || !exactKeys(input, TOP_LEVEL_INPUT_KEYS)) {
    throw new MigrationBindingValidationError(functionName + " input is invalid");
  }
  return input;
}

function validateSelectionBinding(value: unknown): MigrationSelectionBinding {
  if (!isRecord(value) || !exactKeys(value, SELECTION_BINDING_KEYS)) {
    throw new MigrationBindingValidationError("selection binding is invalid");
  }
  assertKind(value.kind);
  assertToken(value.epochId, "epochId");
  assertToken(value.attemptId, "attemptId");
  assertManifestRevision(value.manifestRevision);
  assertWitnessChecksum(value.witnessChecksumSha256);
  assertToken(value.publicationId, "publicationId");
  return {
    kind: value.kind,
    epochId: value.epochId,
    attemptId: value.attemptId,
    manifestRevision: value.manifestRevision,
    witnessChecksumSha256: value.witnessChecksumSha256,
    publicationId: value.publicationId,
  };
}

function validateWitnessBinding(value: unknown): MigrationWitnessBinding {
  if (!isRecord(value) || !exactKeys(value, WITNESS_BINDING_KEYS)) {
    throw new MigrationBindingValidationError("witness binding is invalid");
  }
  assertKind(value.kind);
  assertToken(value.epochId, "epochId");
  assertToken(value.attemptId, "attemptId");
  assertManifestRevision(value.manifestRevision);
  assertWitnessChecksum(value.witnessChecksumSha256);
  return {
    kind: value.kind,
    epochId: value.epochId,
    attemptId: value.attemptId,
    manifestRevision: value.manifestRevision,
    witnessChecksumSha256: value.witnessChecksumSha256,
  };
}

/** JSON-safe wire body shared identity: { version, generationId, binding }.
 * Both writers use this exact envelope shape so the two families read as one
 * store; only the inner binding object's own key set differs between them. */
function generationBindingWireContent(generationId: string, binding: Record<string, unknown>): string {
  return canonicalJson({
    version: GENERATION_BINDING_WIRE_VERSION,
    generationId,
    binding,
  }) + "\n";
}

function selectionWireContent(generationId: string, binding: MigrationSelectionBinding): string {
  return generationBindingWireContent(generationId, {
    attemptId: binding.attemptId,
    epochId: binding.epochId,
    kind: binding.kind,
    manifestRevision: binding.manifestRevision,
    publicationId: binding.publicationId,
    witnessChecksumSha256: binding.witnessChecksumSha256,
  });
}

function witnessWireContent(generationId: string, binding: MigrationWitnessBinding): string {
  return generationBindingWireContent(generationId, {
    attemptId: binding.attemptId,
    epochId: binding.epochId,
    kind: binding.kind,
    manifestRevision: binding.manifestRevision,
    witnessChecksumSha256: binding.witnessChecksumSha256,
  });
}

/** Best-effort field extraction from a stored generation-binding envelope,
 * for the witness reconciler's digest-covered-field comparison only. Never
 * throws: any parse or shape failure returns undefined, which the caller
 * below treats as "does not reconcile" (a conflict), the same fate a
 * whole-record mismatch gets in the selection writer. This module never
 * exposes a general-purpose reader of this wire format; a validated,
 * fully-typed read-back belongs to whichever future module resolves these
 * bindings, not to this writer's own reconciliation check. */
function extractStoredWitnessFields(
  content: string,
): Readonly<{ generationId: string; kind: unknown; epochId: unknown; attemptId: unknown }> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.generationId !== "string") return undefined;
  const binding = value.binding;
  if (!isRecord(binding)) return undefined;
  return { generationId: value.generationId, kind: binding.kind, epochId: binding.epochId, attemptId: binding.attemptId };
}

/** A benign, expected collision: something already occupies the exclusive
 * destination this call tried to create. atomicWritePrivateFileDurable
 * signals both the pre-check collision and the concurrent-link race this
 * way (see security-files.ts); neither is a distinct error class there, so
 * this module recognizes them by their exact, stable message text rather
 * than folding every durable-write failure into "go re-read and compare".
 * This is a local duplicate of activation-artifact-store.ts's identical
 * helper, per this codebase's established convention for small file-local
 * recognizers rather than a cross-module import. */
function isBenignCollisionRace(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "private file already exists" || error.message === "private file was created concurrently");
}

/**
 * Authenticate (and create if absent) the private generation-binding store
 * subdirectory and the per-generation directory beneath it, atop an
 * already-existing private LCM root this module never creates. Both
 * directories are created and mode-tightened via security-files.ts's own
 * ensurePrivateDirectory (reused rather than reimplemented) if missing, then
 * opened and authenticated. A freshly created directory's own durability is
 * not separately forced here: atomicWritePrivateFileDurable already fsyncs
 * a file's immediate parent -- the per-generation directory -- on every
 * write, and if the directory-creation step itself did not survive an
 * earlier crash, the next attempt simply recreates it, which is idempotent.
 */
function ensureGenerationBindingDirectories(
  homeDir: string,
  generationId: string,
  expectedUid: number | undefined,
): string {
  const root = rootPath(homeDir);
  let rootHandle;
  try {
    rootHandle = openPrivateDirectory(root, { expectedUid });
  } catch (error) {
    throw new MigrationBindingUnsafeStorageError(
      "private LCM root cannot be opened: " + (error as Error).message,
      { cause: error },
    );
  }
  try {
    const store = migrationGenerationBindingStoreDirectory(homeDir);
    try {
      ensurePrivateDirectory(store);
      const storeHandle = openPrivateDirectory(store, { expectedUid });
      storeHandle.close();
    } catch (error) {
      throw new MigrationBindingUnsafeStorageError(
        "generation binding store directory is unsafe: " + (error as Error).message,
        { cause: error },
      );
    }
    const generationDirectory = migrationGenerationBindingDirectory(homeDir, generationId);
    try {
      ensurePrivateDirectory(generationDirectory);
      const generationHandle = openPrivateDirectory(generationDirectory, { expectedUid });
      generationHandle.close();
    } catch (error) {
      throw new MigrationBindingUnsafeStorageError(
        "per-generation binding directory is unsafe: " + (error as Error).message,
        { cause: error },
      );
    }
    return generationDirectory;
  } finally {
    rootHandle.close();
  }
}

/** Shared dependency-injection shape for both writers: override the durable
 * write primitive or the bounded reader to exercise this module's own
 * defensive handling of an unrecognized failure, or override the expected
 * owning uid. Defaults to atomicWritePrivateFileDurable and
 * readBoundedRegularFileWithStat respectively. */
export type RecordMigrationSelectionBindingDependencies = Readonly<{
  writeDurable?: typeof atomicWritePrivateFileDurable;
  readWithStat?: typeof readBoundedRegularFileWithStat;
  expectedUid?: number;
}>;

/** See RecordMigrationSelectionBindingDependencies; identical shape, kept as
 * its own named type so each entry point's signature is self-describing. */
export type RecordMigrationWitnessBindingDependencies = RecordMigrationSelectionBindingDependencies;

type ReconcileDecision = "reused" | "conflict";
/** Decide, from an existing stored file's raw content, whether it reconciles
 * with the candidate this write is for (see the module doc comment for why
 * this comparison differs between the two writers). */
type GenerationBindingReconciler = (storedContent: string) => ReconcileDecision;

function reconcileGenerationBindingFile(
  path: string,
  directory: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
  reconcile: GenerationBindingReconciler,
): "absent" | "reused" {
  const outcome = attributeNullableRead<BoundedFileResult>(() =>
    readWithStat(path, {
      allowedRoot: directory,
      maxBytes: MAX_GENERATION_BINDING_FILE_BYTES,
      expectedUid,
      allowedModes: [PRIVATE_FILE_MODE],
      requireSingleLink: true,
    }),
  );
  if (outcome.kind === "unresolvable") {
    throw new MigrationBindingUnresolvableError(
      "cannot determine whether a generation binding already exists at " + path + ": " + outcome.detail,
    );
  }
  if (outcome.kind === "absent") return "absent";
  if (reconcile(outcome.value.content) === "reused") return "reused";
  throw new MigrationBindingConflictError(
    "a generation binding already exists at " + path +
      " and does not reconcile with the candidate; refusing to overwrite durable authority",
  );
}

/**
 * The shared core both entry points call: authenticate the per-generation
 * directory, reconcile against whatever already sits at fileName using the
 * caller-supplied comparator, and durably write only when the key is
 * genuinely absent. A reconciled match never rewrites the stored file --
 * this is what makes the witness writer's first-write-wins manifestRevision
 * rule real rather than nominal. See the module doc comment for the full
 * crash-safety and idempotency rationale.
 */
function recordGenerationBindingFile(
  homeDir: string,
  generationId: string,
  fileName: string,
  serialized: string,
  reconcile: GenerationBindingReconciler,
  dependencies: RecordMigrationSelectionBindingDependencies,
): void {
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;
  const writeDurable = dependencies.writeDurable ?? atomicWritePrivateFileDurable;

  const directory = ensureGenerationBindingDirectories(homeDir, generationId, expectedUid);
  const path = join(directory, fileName);

  const attempt = (): "absent" | "reused" =>
    reconcileGenerationBindingFile(path, directory, expectedUid, readWithStat, reconcile);

  if (attempt() === "reused") return;

  try {
    writeDurable(path, serialized, {
      requireAbsent: true,
      maxExistingBytes: MAX_GENERATION_BINDING_FILE_BYTES,
      expectedUid,
    });
  } catch (error) {
    if (!isBenignCollisionRace(error)) throw error;
    // A concurrent writer published (or leftover debris blocked, then
    // cleared) between our presence check and this write attempt. Re-read
    // and reconcile exactly as above rather than treating a race as a
    // failure: this is the "retry converges" property applied to true
    // concurrency, not just sequential crash-then-retry.
    if (attempt() === "absent") {
      // The collision this call observed is already gone. Surface the
      // original error rather than loop indefinitely against a filesystem
      // that keeps changing out from under this call.
      throw error;
    }
  }
}

/**
 * Durably record a selection binding, or reuse an already-recorded
 * byte-identical one. Synchronous: no await, no Promise, and no async call
 * anywhere in its call path, by requirement rather than style (see the
 * module doc comment). Call this after the maintenance selection completes
 * and before the retained local barrier token is released.
 */
export function recordMigrationSelectionBinding(
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationSelectionBinding }>,
  dependencies: RecordMigrationSelectionBindingDependencies = {},
): void {
  const validatedInput = validateTopLevelInput(input, "recordMigrationSelectionBinding");
  const homeDir = validateHomeDir(validatedInput.homeDir);
  const generationId = validateGenerationId(validatedInput.generationId);
  const binding = validateSelectionBinding(validatedInput.binding);
  const serialized = selectionWireContent(generationId, binding);
  const fileName = `selection-${binding.kind}.binding`;
  const reconcile: GenerationBindingReconciler = (stored) => (stored === serialized ? "reused" : "conflict");
  recordGenerationBindingFile(homeDir, generationId, fileName, serialized, reconcile, dependencies);
}

/**
 * Durably record a witness binding, or reuse an already-recorded one whose
 * digest-covered fields (kind, epochId, attemptId) and generationId match
 * the candidate -- manifestRevision is deliberately excluded from that
 * comparison and the stored file is never rewritten on a match; see the
 * module doc comment for why. Synchronous for the same load-bearing reason
 * as recordMigrationSelectionBinding. Call this before the selection it
 * documents is prepared, never after.
 */
export function recordMigrationWitnessBinding(
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationWitnessBinding }>,
  dependencies: RecordMigrationWitnessBindingDependencies = {},
): void {
  const validatedInput = validateTopLevelInput(input, "recordMigrationWitnessBinding");
  const homeDir = validateHomeDir(validatedInput.homeDir);
  const generationId = validateGenerationId(validatedInput.generationId);
  const binding = validateWitnessBinding(validatedInput.binding);
  const serialized = witnessWireContent(generationId, binding);
  const fileName = `witness-${binding.witnessChecksumSha256}.binding`;
  const reconcile: GenerationBindingReconciler = (stored) => {
    const parsed = extractStoredWitnessFields(stored);
    if (
      parsed === undefined
      || parsed.generationId !== generationId
      || parsed.kind !== binding.kind
      || parsed.epochId !== binding.epochId
      || parsed.attemptId !== binding.attemptId
    ) {
      return "conflict";
    }
    return "reused";
  };
  recordGenerationBindingFile(homeDir, generationId, fileName, serialized, reconcile, dependencies);
}
