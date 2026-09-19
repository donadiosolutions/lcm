import { basename, join } from "node:path";
import { fsyncSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { canonicalJson, sha256 } from "../storage/portable-record.js";
import {
  BoundedFileIdentityChangedError,
  PRIVATE_FILE_MODE,
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  isPrivateFileCollisionFailure,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  type BoundedFileResult,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import {
  attributeNullableRead,
  classifyNodeFsAbsence,
  type NullableReadClassification,
} from "./activation-absence.js";

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
 * cross-check every write already performs and the storage-key cross-check
 * described below; it deliberately does NOT compare manifestRevision. The
 * key is witnessChecksumSha256 itself, and that digest does not cover
 * manifestRevision, so manifestRevision is the one field that can
 * legitimately differ between two writes under one key: a crash after the
 * first durable write, with other transitions sealing in between, produces
 * a legitimate rewrite of the same witness at a higher revision. A
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
 * The stored record is parsed with the same strictness a candidate is
 * validated with, not merely read for the four compared fields: exact
 * envelope keys, the module's own wire version, and a full
 * validateWitnessBinding pass on the binding object, which also requires
 * the stored binding's own embedded witnessChecksumSha256 to equal the key
 * its filename encodes. A stored record that is missing fields, carries
 * unknown keys, is at an unrecognised wire version, or whose embedded
 * checksum disagrees with its own storage key can never be silently
 * accepted as a match; anything that fails that parse is treated exactly
 * like a whole-record mismatch is for a selection -- a conflict, never a
 * silent reuse.
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
 * One specific crash window needs its own machinery rather than falling out
 * of that reconciliation for free. atomicWritePrivateFileDurable's
 * requireAbsent path publishes by linking the writer's scratch file onto the
 * final name and only afterward unlinks the scratch; a crash between those
 * two syscalls leaves the published name and its scratch twin as two links
 * to one inode, both nlink=2. The bounded reader's own requireSingleLink
 * check turns that state into a bare, code-less Error that this module's
 * default read classifier does not recognise. reconcileWriterScratchTwin
 * below is what makes the rewrite this module promises above actually
 * survive that specific window: it authenticates the scratch twin by full
 * content-and-metadata identity (never by name alone), completes the
 * interrupted unlink, and only then reconciles as it would for any ordinary
 * existing file. A multi-link state that cannot be authenticated as that
 * exact twin is refused as MigrationBindingUnresolvableError -- a state this
 * module could not resolve, never a conflict it did resolve.
 *
 * Every code-less integrity failure the bounded reader can throw --
 * oversize, a torn-read identity change, an untrusted mode or owner -- is
 * classified the same way, for the same reason: a failed integrity check
 * has not told this module what the stored content is, so it cannot
 * conclude two publications are claiming one authority. It can only
 * conclude the read could not be trusted. Only a genuinely unrecognised
 * throw -- one this module's classifier has no rule for at all -- still
 * propagates raw.
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
 * the suspend-across-await hazard the lock seam was closed against. The
 * crash-twin recovery above is synchronous too: every syscall it performs
 * (readdirSync, lstatSync, unlinkSync, and the bounded reads) is the
 * synchronous form.
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
 * per-generation directory beneath it are, and their creation is now
 * durable up the tree (see ensureSyncedPrivateChild): a selection binding
 * is written once, inside the fenced window, before the token is released,
 * so there is no later attempt that would otherwise recreate a directory
 * lost to power loss right after this module returned success.
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
 * digest-covered field (or a strict-parse failure of the stored record) for
 * a witness. Never overwritten; the caller must investigate rather than
 * have this module silently resolve it either way. */
export class MigrationBindingConflictError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationBindingConflictError";
  }
}

/** A read needed to decide whether a binding already exists could not be
 * completed and trusted (attributed by activation-absence.ts as
 * "unresolvable" -- e.g. permission denied -- or by this module's own
 * classifier as a code-less integrity failure, or as a multi-link state
 * that could not be authenticated as an interrupted durable-write scratch
 * twin) rather than genuinely finding nothing or finding a comparable
 * value. This module refuses instead of guessing that an untrustworthy read
 * means either absence or a conflict. */
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

/**
 * Strictly parse a stored witness-binding envelope for the reconciler's
 * comparison: exact envelope keys, the module's own wire version, and a
 * full validateWitnessBinding pass on the binding object -- the same
 * strictness applied to a candidate, not merely a loose read of the four
 * compared fields. Any parse or shape failure returns undefined, which the
 * caller treats as "does not reconcile" (a conflict), the same fate a
 * whole-record mismatch gets in the selection writer. This module never
 * exposes a general-purpose reader of this wire format; a validated,
 * fully-typed read-back belongs to whichever future module resolves these
 * bindings, not to this writer's own reconciliation check.
 */
function parseStoredWitnessBinding(
  content: string,
): Readonly<{ generationId: string; binding: MigrationWitnessBinding }> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value)
    || !exactKeys(value, ["binding", "generationId", "version"])
    || value.version !== GENERATION_BINDING_WIRE_VERSION
    || typeof value.generationId !== "string"
  ) {
    return undefined;
  }
  try {
    return { generationId: value.generationId, binding: validateWitnessBinding(value.binding) };
  } catch {
    return undefined;
  }
}

/** A benign, expected collision: something already occupies the exclusive
 * destination this call tried to create. atomicWritePrivateFileDurable
 * signals both the pre-check collision and the concurrent-link race as a
 * typed PrivateFileCollisionError (see security-files.ts), so this module
 * recognizes them by class rather than by message text -- a reworded
 * message still reconciles, while an unrelated failure carrying similar
 * text is never mistaken for a benign race.
 * This is a local duplicate of activation-artifact-store.ts's identical
 * helper, per this codebase's established convention for small file-local
 * recognizers rather than a cross-module import. */
function isBenignCollisionRace(error: unknown): boolean {
  return isPrivateFileCollisionFailure(error);
}

const MULTIPLE_HARD_LINKS_MESSAGE = "file has multiple hard links";

function isMultipleHardLinksError(error: unknown): boolean {
  return error instanceof Error && error.message === MULTIPLE_HARD_LINKS_MESSAGE;
}

/** The other code-less integrity failures validateBoundedFileMetadata (and
 * its callers) in security-files.ts throw for a bounded read: no .code, so
 * activation-absence.ts's default classifier does not recognise them and
 * they would otherwise escape raw. Every one of them means the read could
 * not be trusted, never that a comparison ran and disagreed. */
const READ_INTEGRITY_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "path is not a regular file",
  "file owner is not trusted",
  "file mode is not trusted",
  "file exceeds the configured size limit",
  "file content hash does not match expected witness",
  "file is outside the permitted root",
]);

/**
 * Classify a bounded-read failure for this module's own reconciliation
 * reads. Extends activation-absence.ts's default Node-fs classifier
 * (ENOENT/ENOTDIR absent, EACCES/EPERM unresolvable) with the code-less
 * integrity failures readBoundedRegularFileWithStat itself throws: an
 * oversize file, a torn read reported as BoundedFileIdentityChangedError,
 * and the other bounded-read refusals above. None of these tell this
 * module what the stored content actually is -- a failed integrity check is
 * not a comparison that ran -- so every one of them is
 * MigrationBindingUnresolvableError, never a conflict and never a raw
 * escape. "file has multiple hard links" is deliberately left unclassified
 * here: it has its own authenticated-twin recovery path
 * (reconcileWriterScratchTwin) and only becomes unresolvable once that
 * recovery itself fails to authenticate a twin. Any other, genuinely
 * unrecognised error is left unclassified too and propagates raw,
 * unchanged.
 */
function classifyGenerationBindingReadFailure(error: unknown): NullableReadClassification | undefined {
  const base = classifyNodeFsAbsence()(error);
  if (base !== undefined) return base;
  if (!(error instanceof Error) || isMultipleHardLinksError(error)) return undefined;
  if (error instanceof BoundedFileIdentityChangedError) {
    return { kind: "unresolvable", cause: "identity-changed", detail: error.message };
  }
  if (READ_INTEGRITY_FAILURE_MESSAGES.has(error.message)) {
    return { kind: "unresolvable", cause: "integrity-check-failed", detail: error.message };
  }
  return undefined;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&");
}

/** atomicWritePrivateFileDurable's own scratch-naming convention (see
 * security-files.ts): a leading dot, the final basename, a dot, one or more
 * lowercase hex characters (the writer's randomBytes(N).toString("hex")
 * suffix -- its exact byte count is deliberately not pinned here, so a
 * future change to that byte count cannot silently stop this module's own
 * crash-twin recovery from recognising it), and a ".tmp" extension. The
 * structural shape is matched by name; full authentication is by content
 * and metadata identity (exactWriterLinkPair below), never by name alone,
 * so an unrelated dotfile that happens to fit this shape still cannot be
 * mistaken for a genuine scratch twin. */
function writerScratchNamePattern(finalFileName: string): RegExp {
  return new RegExp(`^\\.${escapeRegExpLiteral(finalFileName)}\\.[0-9a-f]+\\.tmp$`, "u");
}

/**
 * A local duplicate of manifest-store.ts's exactWriterLinkPair (there at
 * lines 759-774, module-private, cited here rather than imported per this
 * codebase's established convention for a small predicate): two reads of
 * the SAME published inode -- the final published name and its
 * not-yet-unlinked writer scratch twin -- agree on every field a legitimate
 * atomicWritePrivateFileDurable crash between linkSync and the scratch
 * unlink can produce. Full content and metadata equality, not just nlink,
 * is what tells an authentic post-link crash twin apart from an unrelated
 * multi-link collision.
 */
function exactWriterLinkPair(left: BoundedFileResult, right: BoundedFileResult): boolean {
  return left.nlink === "2"
    && right.nlink === "2"
    && left.exactDev === right.exactDev
    && left.exactIno === right.exactIno
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mtimeMs === right.mtimeMs
    && left.content === right.content;
}

/**
 * Remove the authenticated scratch twin, re-verifying its identity
 * immediately before removal rather than trusting the earlier read -- the
 * same minimal TOCTOU discipline security-files.ts's own
 * unlinkPrivateFileIfIdentityMatches applies (module-private there, so not
 * reused directly), and then report the published file's own link count so
 * the caller can assert the invariant this recovery claims: after the
 * interrupted unlink is completed, the published name must be single-link
 * again. The twin already being gone (ENOENT) is not an error: another
 * retry may have completed the unlink first. A published file that is
 * itself already gone (ENOENT) is reported as undefined rather than thrown,
 * so the caller can treat the key as genuinely absent. Any other failure
 * propagates raw rather than being swallowed, matching
 * atomicWritePrivateFileDurable's own treatment of this exact cleanup step
 * as part of the operation rather than a best-effort afterthought.
 */
function completeInterruptedScratchUnlink(
  scratchPath: string,
  publishedPath: string,
  publishedIdentity: BoundedFileResult,
): bigint | undefined {
  let current;
  try {
    current = lstatSync(scratchPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return publishedLinkCount(publishedPath);
    throw error;
  }
  if (
    !current.isFile()
    || current.dev.toString(10) !== publishedIdentity.exactDev
    || current.ino.toString(10) !== publishedIdentity.exactIno
  ) {
    return publishedLinkCount(publishedPath);
  }
  try {
    unlinkSync(scratchPath);
  } catch (error) {
    // The twin already being gone (ENOENT) here is not an error either --
    // another retry may have completed the unlink in the window between
    // this function's own lstat above and this unlink, the exact
    // invariant this function's doc comment states. Any other failure
    // propagates raw rather than being swallowed, mirroring
    // consumeBoundedRegularFile's identical ENOENT-after-unlink handling
    // in security-files.ts.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return publishedLinkCount(publishedPath);
    throw error;
  }
  return publishedLinkCount(publishedPath);
}

/**
 * Read the published file's current link count after the interrupted
 * scratch unlink is completed (or already complete). Returns undefined when
 * the published file itself is already gone, so the caller treats the key
 * as genuinely absent rather than guessing. Any other lookup failure
 * propagates raw.
 */
function publishedLinkCount(publishedPath: string): bigint | undefined {
  try {
    return lstatSync(publishedPath, { bigint: true }).nlink;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type ReconcileDecision = "reused" | "conflict";
/** Decide, from an existing stored file's raw content, whether it reconciles
 * with the candidate this write is for (see the module doc comment for why
 * this comparison differs between the two writers). */
type GenerationBindingReconciler = (storedContent: string) => ReconcileDecision;

/**
 * Authenticate and, if found, complete an interrupted durable-write crash
 * twin (see the module doc comment for the exact crash window this
 * recovers). A twin is accepted only when a scratch file matching the
 * writer's exact naming convention in the same directory is byte-and-
 * metadata identical to the published name via exactWriterLinkPair. On a
 * match, the interrupted unlink is completed and the published file is
 * asserted single-link again -- the same expectedNlink discipline
 * security-files.ts's own unlinkPrivateFileIfIdentityMatches applies --
 * before reconciliation proceeds against the published content exactly as
 * it would for any ordinary existing file. A third hard link appearing
 * between the authenticated read and the unlink would otherwise leave
 * this call returning "reused" while the file stays multi-link, so a
 * post-unlink count other than exactly 1 refuses as
 * MigrationBindingUnresolvableError rather than being silently accepted.
 * A published file that vanished entirely in that same window is reported
 * as "absent" instead: the key is genuinely gone, and the caller's
 * requireAbsent write converges by publishing fresh. Zero matches, more
 * than one match, or a final nlink that is not exactly 2 cannot be
 * authenticated as this specific crash shape and refuse as
 * MigrationBindingUnresolvableError: a multi-link state this module could
 * not resolve is not evidence of a conflict, because no comparison
 * against a trustworthy read ever ran.
 */
function reconcileWriterScratchTwin(
  path: string,
  directory: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
  reconcile: GenerationBindingReconciler,
): "absent" | "reused" {
  const unresolvable = (): never => {
    throw new MigrationBindingUnresolvableError(
      "a multi-link generation binding at " + path +
        " could not be authenticated as an interrupted durable-write scratch twin",
    );
  };
  const readAt = (candidatePath: string) =>
    attributeNullableRead<BoundedFileResult>(
      () => readWithStat(candidatePath, {
        allowedRoot: directory,
        maxBytes: MAX_GENERATION_BINDING_FILE_BYTES,
        expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
      }),
      { classifyError: classifyGenerationBindingReadFailure },
    );

  const finalOutcome = readAt(path);
  if (finalOutcome.kind !== "present" || finalOutcome.value.nlink !== "2") {
    return unresolvable();
  }

  const namePattern = writerScratchNamePattern(basename(path));
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return unresolvable();
  }

  let twinPath: string | undefined;
  for (const entry of entries) {
    if (!namePattern.test(entry)) continue;
    // A scan candidate is a directory entry this module did not create and
    // cannot vouch for, so its error surface is open-ended: a symlink
    // raises ELOOP at open(2) (O_NOFOLLOW), and a socket or any other
    // exotic file type could raise something else again. Enumerating
    // codes or messages can never cover an open-ended surface, so any
    // read of a scan candidate that does not produce a trusted
    // present-or-absent outcome -- recognised or not -- is fail-closed
    // here rather than left to escape raw.
    let candidateOutcome: ReturnType<typeof readAt>;
    try {
      candidateOutcome = readAt(join(directory, entry));
    } catch {
      return unresolvable();
    }
    if (candidateOutcome.kind === "unresolvable") return unresolvable();
    if (candidateOutcome.kind === "absent") continue;
    if (!exactWriterLinkPair(finalOutcome.value, candidateOutcome.value)) continue;
    if (twinPath !== undefined) return unresolvable();
    twinPath = join(directory, entry);
  }
  if (twinPath === undefined) return unresolvable();

  const publishedNlink = completeInterruptedScratchUnlink(twinPath, path, finalOutcome.value);
  if (publishedNlink === undefined) return "absent";
  if (publishedNlink !== 1n) return unresolvable();

  if (reconcile(finalOutcome.value.content) === "reused") return "reused";
  throw new MigrationBindingConflictError(
    "a generation binding already exists at " + path +
      " and does not reconcile with the candidate; refusing to overwrite durable authority",
  );
}

function reconcileGenerationBindingFile(
  path: string,
  directory: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
  reconcile: GenerationBindingReconciler,
): "absent" | "reused" {
  let outcome;
  try {
    outcome = attributeNullableRead<BoundedFileResult>(
      () => readWithStat(path, {
        allowedRoot: directory,
        maxBytes: MAX_GENERATION_BINDING_FILE_BYTES,
        expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
        requireSingleLink: true,
      }),
      { classifyError: classifyGenerationBindingReadFailure },
    );
  } catch (error) {
    if (isMultipleHardLinksError(error)) {
      return reconcileWriterScratchTwin(path, directory, expectedUid, readWithStat, reconcile);
    }
    throw error;
  }
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Create (if absent) and authenticate a private child directory beneath an
 * already-open, already-authenticated parent handle. When this call is the
 * one that actually creates the child, fsync both the fresh child's own
 * descriptor and the parent's descriptor before returning -- mirroring
 * manifest-store.ts's ensurePrivateChild (there at lines 395-424,
 * module-private, duplicated locally per this codebase's convention rather
 * than imported) -- so the new directory entry durably survives a crash
 * immediately after this call returns. This matters here specifically
 * because a selection binding is written once, inside the fenced window,
 * before the barrier token is released: unlike the sibling
 * activation-artifact-store.ts's republishable recovery material, there is
 * no later attempt that would otherwise recreate a directory a crash right
 * after a successful return silently took with it.
 *
 * An already-existing child is only authenticated, never re-synced:
 * nothing new was durably created, so there is nothing new to flush, and
 * re-chmod-healing an existing directory's mode is ensurePrivateDirectory's
 * own concern, not this helper's.
 */
function ensureSyncedPrivateChild(
  parentHandle: PrivateDirectoryHandle,
  childPath: string,
  expectedUid: number | undefined,
): PrivateDirectoryHandle {
  const alreadyExisted = pathExists(childPath);
  ensurePrivateDirectory(childPath);
  const childHandle = openPrivateDirectory(childPath, { expectedUid });
  if (!alreadyExisted) {
    fsyncSync(childHandle.fd);
    fsyncSync(parentHandle.fd);
  }
  return childHandle;
}

/**
 * Authenticate (and create if absent) the private generation-binding store
 * subdirectory and the per-generation directory beneath it, atop an
 * already-existing private LCM root this module never creates. See
 * ensureSyncedPrivateChild for the creation-path durability guarantee.
 */
function ensureGenerationBindingDirectories(
  homeDir: string,
  generationId: string,
  expectedUid: number | undefined,
): string {
  const root = rootPath(homeDir);
  let rootHandle: PrivateDirectoryHandle;
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
    let storeHandle: PrivateDirectoryHandle;
    try {
      storeHandle = ensureSyncedPrivateChild(rootHandle, store, expectedUid);
    } catch (error) {
      throw new MigrationBindingUnsafeStorageError(
        "generation binding store directory is unsafe: " + (error as Error).message,
        { cause: error },
      );
    }
    try {
      const generationDirectory = migrationGenerationBindingDirectory(homeDir, generationId);
      let generationHandle: PrivateDirectoryHandle;
      try {
        generationHandle = ensureSyncedPrivateChild(storeHandle, generationDirectory, expectedUid);
      } catch (error) {
        throw new MigrationBindingUnsafeStorageError(
          "per-generation binding directory is unsafe: " + (error as Error).message,
          { cause: error },
        );
      }
      generationHandle.close();
      return generationDirectory;
    } finally {
      storeHandle.close();
    }
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
    const parsed = parseStoredWitnessBinding(stored);
    if (
      parsed === undefined
      || parsed.generationId !== generationId
      || parsed.binding.witnessChecksumSha256 !== binding.witnessChecksumSha256
      || parsed.binding.kind !== binding.kind
      || parsed.binding.epochId !== binding.epochId
      || parsed.binding.attemptId !== binding.attemptId
    ) {
      return "conflict";
    }
    return "reused";
  };
  recordGenerationBindingFile(homeDir, generationId, fileName, serialized, reconcile, dependencies);
}
