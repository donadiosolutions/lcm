import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fsyncSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import {
  type BackendPublicationProjectRecord,
  type BackendPublicationRecoveryFile,
} from "../storage/backend-publication.js";
import { canonicalJson, canonicalSha256 } from "../storage/portable-record.js";
import {
  OWNER_ONLY_FILE_MODES,
  PRIVATE_FILE_MODE,
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  isOwnerOnlyFileMode,
  isPrivateFileCollisionFailure,
  openPrivateDirectory,
  readBoundedRegularFileWithStat,
  type BoundedFileResult,
  type PrivateDirectoryHandle,
} from "../security-files.js";
import { attributeNullableRead } from "./activation-absence.js";

/**
 * Crash-safe persistence for the recovery material a migration-activation
 * driver must durably write *before* it prepares a backend publication (see
 * PrepareBackendPublicationInput / BackendPublicationRecoveryMaterial in
 * ../storage/backend-publication.ts, whose material parsing and sealing code
 * is the authoritative shape this module was written against -- see the
 * gotchas below for exactly where this module's own record differs from it
 * and why).
 *
 * Part A: the immutable-artifact persistence discipline.
 *
 * publishActivationArtifact writes a record once and only once: to a
 * temporary file, fsynced, then linked into place (never a bare
 * O_EXCL-on-the-final-path create), and the containing directory is fsynced
 * afterward. This exact shape -- reusing security-files.ts's
 * atomicWritePrivateFileDurable with requireAbsent, the same durable
 * primitive backend-publication.ts's own sealMaterial calls -- is what makes
 * a crash mid-write converge on retry instead of stranding: the destination
 * path is only ever fully-written-and-synced or absent, never truncated. A
 * bare O_EXCL create straight at the final path does not have that
 * property: a crash between create and the final fsync leaves a truncated
 * body sitting at the name a later retry's read-back would (permanently)
 * refuse.
 *
 * The store key is the record's identity digest (computeActivationArtifact
 * IdentityDigest), never a generation id such as the publicationId embedded
 * inside the record. This is deliberate and load-bearing for the
 * publication-id reuse rule below: the digest is computed over {version,
 * source, target, projects} only, *excluding* publicationId, so recomputing
 * it from freshly observed source/target files and a freshly assembled
 * projects list -- with no publicationId decided yet -- always resolves to
 * the same on-disk path as a previous, not-yet-sealed attempt for the exact
 * same logical migration. Recovery therefore never needs to already know a
 * publicationId to find this record; it needs the record to find the
 * publicationId.
 *
 * On an existing entry, this module reads the stored bytes back and
 * requires byte-identity against the candidate it was asked to publish:
 * identical bytes is a successful idempotent reuse (safe to retry after a
 * crash with the exact same candidate); different bytes is a refusal, never
 * a silent overwrite. Because the digest excludes publicationId but the
 * serialized record includes it, this is exactly what makes "never refresh
 * the publication id on retry" enforceable rather than aspirational: a
 * caller that tried to mint a fresh publicationId for the same logical
 * migration would compute the identical digest (same source/target/
 * projects), collide with the record already on disk under that digest, and
 * get refused, because the two records' bytes differ only in the
 * publicationId field. A caller that instead reuses the publicationId
 * already recorded on disk (read back via readActivationArtifact) produces
 * byte-identical candidate bytes and is accepted as an idempotent reuse.
 * Whether a corresponding backend-publication ".material" file has already
 * been sealed for that publicationId is a fact this module does not
 * observe -- that comparison ("the driver additionally verifies the sealed
 * bytes against this record's copy") belongs to the driver that authenticat
 * es backend-publication.ts's own material, using the source/target file
 * bytes this module retained. This module's job ends at making the
 * publicationId durably, uniquely, and re-derivably available before that
 * driver ever calls prepareBackendPublication.
 *
 * Part B: the recovery-material record.
 *
 * The record carries the four files a later recovery needs to re-drive a
 * backend publication *from the bytes it reads back*, never from values it
 * recomputes: source config, source project map, target config, target
 * project map, each with its raw content plus the exact file-identity
 * fields backend-publication.ts's own BackendPublicationRecoveryFile
 * carries (mode, uid, gid, nlink, dev, ino, parentDev, parentIno) -- this
 * module reuses that exact type rather than inventing a parallel one, per
 * the file-identity conventions confirmed in backend-publication.ts. It
 * also carries the projects array (each entry's localProjectId,
 * remoteProjectId and evidenceSha256, mirroring the file-identity subset of
 * BackendPublicationProjectRecord this module actually needs -- the fence
 * is publication-time state this module never observes), and the
 * publicationId itself.
 *
 * Nullable reads. Every nullable read in this module -- the presence check
 * for an existing artifact at a computed identity-digest path, and the
 * optional per-file capture helper -- goes through activation-absence.ts's
 * attributeNullableRead, never a bare try/catch that folds "not found" and
 * "permission denied" into the same conclusion. A read that succeeded and
 * found nothing is reported as absent (safe to write); a read that could
 * not be completed (recognized as permission-denied) is reported as
 * unresolvable and this module refuses outright rather than guessing that
 * refusal means "nothing is there yet".
 */

const ACTIVATION_ARTIFACT_MATERIAL_VERSION = 1 as const;
const ACTIVATION_ARTIFACT_SUBDIRECTORY = "migration-activation-material";
/** Matches backend-publication.ts's MAX_RECOVERY_FILE_BYTES: these are the
 * same kind of artifact (a config.json or project map.json). */
const MAX_ACTIVATION_ARTIFACT_FILE_BYTES = 4 * 1024 * 1024;
/** Matches backend-publication.ts's MAX_MATERIAL_BYTES for the assembled
 * envelope of all four files plus the projects array. */
const MAX_ACTIVATION_ARTIFACT_BYTES = 8 * 1024 * 1024;
const IDENTITY_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVIDENCE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** The four-file identity subset of BackendPublicationProjectRecord this
 * module's recovery material actually needs. The fence is publication-time
 * state this module never observes (the record is written before a
 * publication is even prepared), so it is deliberately excluded rather than
 * carried as an always-null placeholder. */
export type ActivationArtifactProjectRecord = Readonly<
  Pick<BackendPublicationProjectRecord, "localProjectId" | "remoteProjectId" | "evidenceSha256">
>;

export type ActivationArtifactRecoveryMaterial = Readonly<{
  version: typeof ACTIVATION_ARTIFACT_MATERIAL_VERSION;
  publicationId: string;
  source: Readonly<{
    config: BackendPublicationRecoveryFile;
    projectMap: BackendPublicationRecoveryFile;
  }>;
  target: Readonly<{
    config: BackendPublicationRecoveryFile;
    projectMap: BackendPublicationRecoveryFile;
  }>;
  projects: readonly ActivationArtifactProjectRecord[];
}>;

/** Input shape accepted by both publishActivationArtifact and
 * computeActivationArtifactIdentityDigest: publicationId is optional here
 * because computing the identity digest never consumes it (see the module
 * doc comment for why that is load-bearing), while publishing requires one. */
export type ActivationArtifactMaterialInput = Readonly<{
  version?: typeof ACTIVATION_ARTIFACT_MATERIAL_VERSION;
  source: ActivationArtifactRecoveryMaterial["source"];
  target: ActivationArtifactRecoveryMaterial["target"];
  projects: readonly ActivationArtifactProjectRecord[];
}>;

export type ActivationArtifactPublishOutcome = "written" | "reused";

export type ActivationArtifactPublishResult = Readonly<{
  outcome: ActivationArtifactPublishOutcome;
  identityDigest: string;
  path: string;
  material: ActivationArtifactRecoveryMaterial;
}>;

/** The candidate record's shape (or a caller-supplied stored record being
 * parsed back) does not satisfy this module's schema. */
export class ActivationArtifactValidationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ActivationArtifactValidationError";
  }
}

/** An artifact already exists at the candidate's identity-digest path with
 * different bytes. Never overwritten; the caller must investigate rather
 * than have this module silently replace durable recovery material. */
export class ActivationArtifactIdentityMismatchError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ActivationArtifactIdentityMismatchError";
  }
}

/** A read needed to decide whether an artifact is present could not be
 * completed (attributed by activation-absence.ts as "unresolvable", e.g.
 * permission denied) rather than genuinely finding nothing. This module
 * refuses instead of guessing that the read failure means absence. */
export class ActivationArtifactPresenceUnresolvableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ActivationArtifactPresenceUnresolvableError";
  }
}

/** The private LCM root or the activation-artifact subdirectory beneath it
 * is missing or fails private-directory authentication. */
export class ActivationArtifactUnsafeStorageError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ActivationArtifactUnsafeStorageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

/** Matches security-files.ts's own internal currentUid helper (and its
 * repeated copies across manifest-store.ts, home-lock-topology.ts, and
 * others): a local one-line duplicate rather than a cross-module import,
 * which is the established convention throughout this codebase. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function rootPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".lcm");
}

export function activationArtifactDirectory(homeDir?: string): string {
  return join(rootPath(homeDir), ACTIVATION_ARTIFACT_SUBDIRECTORY);
}

export function activationArtifactPath(homeDir: string | undefined, identityDigest: string): string {
  return join(activationArtifactDirectory(homeDir), identityDigest + ".material");
}

/**
 * Authenticate (and create if absent) the private activation-artifact
 * subdirectory beneath an already-existing private LCM root. The root must
 * already exist and authenticate as a private directory (this module never
 * creates ~/.lcm itself); the subdirectory itself is created and
 * mode-tightened via security-files.ts's own ensurePrivateDirectory (reused
 * rather than reimplemented) if missing, and then opened and authenticated.
 * When this call is the one that actually creates the subdirectory, both
 * the fresh directory's own descriptor and the parent root's descriptor
 * are fsynced before returning -- mirroring generation-binding-store.ts's
 * ensureSyncedPrivateChild -- so the new directory entry durably survives
 * a crash immediately after this call returns. atomicWritePrivateFileDurable
 * only fsyncs the file's immediate parent on publish, which is this
 * directory itself, never this directory's own entry in ~/.lcm: without
 * the creation-path fsync here, a first write's directories could be lost
 * to power loss even though the file's contents were durable.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureActivationArtifactDirectory(homeDir: string | undefined, expectedUid: number | undefined): void {
  const root = rootPath(homeDir);
  let rootHandle;
  try {
    rootHandle = openPrivateDirectory(root, { expectedUid });
  } catch (error) {
    throw new ActivationArtifactUnsafeStorageError(
      "private LCM root cannot be opened: " + (error as Error).message,
      { cause: error },
    );
  }
  const directory = activationArtifactDirectory(homeDir);
  try {
    const alreadyExisted = pathExists(directory);
    ensurePrivateDirectory(directory);
    const handle: PrivateDirectoryHandle = openPrivateDirectory(directory, { expectedUid });
    try {
      if (!alreadyExisted) {
        fsyncSync(handle.fd);
        fsyncSync(rootHandle.fd);
      }
    } finally {
      handle.close();
    }
  } catch (error) {
    throw new ActivationArtifactUnsafeStorageError(
      "activation artifact directory is unsafe: " + (error as Error).message,
      { cause: error },
    );
  } finally {
    rootHandle.close();
  }
}

function assertRecoveryFileShape(file: unknown, field: string): asserts file is BackendPublicationRecoveryFile {
  if (!isRecord(file) || (file.presence !== "absent" && file.presence !== "present")) {
    throw new ActivationArtifactValidationError(field + " recovery file is invalid");
  }
  if (file.presence === "absent") {
    if (!exactKeys(file, ["presence"])) {
      throw new ActivationArtifactValidationError(field + " absent recovery file has unknown fields");
    }
    return;
  }
  if (
    !exactKeys(file, ["content", "dev", "gid", "ino", "mode", "nlink", "parentDev", "parentIno", "presence", "uid"])
    || !(file.content instanceof Uint8Array)
    || file.content.byteLength === 0
    || file.content.byteLength > MAX_ACTIVATION_ARTIFACT_FILE_BYTES
    || !isOwnerOnlyFileMode(file.mode as number)
    || !Number.isSafeInteger(file.uid)
    || (file.uid as number) < 0
    || !Number.isSafeInteger(file.gid)
    || (file.gid as number) < 0
    || typeof file.nlink !== "string"
    || file.nlink !== "1"
    || typeof file.dev !== "string"
    || !/^\d+$/u.test(file.dev)
    || typeof file.ino !== "string"
    || !/^\d+$/u.test(file.ino)
    || typeof file.parentDev !== "string"
    || !/^\d+$/u.test(file.parentDev)
    || typeof file.parentIno !== "string"
    || !/^\d+$/u.test(file.parentIno)
  ) {
    throw new ActivationArtifactValidationError(field + " present recovery file is invalid");
  }
}

type NormalizedMaterial = ActivationArtifactRecoveryMaterial;

function normalizeProjects(
  projects: readonly ActivationArtifactProjectRecord[],
): readonly ActivationArtifactProjectRecord[] {
  const localIds = new Set<string>();
  const remoteIds = new Set<string>();
  for (const project of projects) {
    if (
      !isRecord(project)
      || !exactKeys(project, ["evidenceSha256", "localProjectId", "remoteProjectId"])
      || typeof project.localProjectId !== "string"
      || project.localProjectId.length === 0
      || project.localProjectId.length > 256
      || typeof project.remoteProjectId !== "string"
      || project.remoteProjectId.length === 0
      || project.remoteProjectId.length > 256
      || typeof project.evidenceSha256 !== "string"
      || !EVIDENCE_SHA256_PATTERN.test(project.evidenceSha256)
      || localIds.has(project.localProjectId)
      || remoteIds.has(project.remoteProjectId)
    ) {
      throw new ActivationArtifactValidationError("activation artifact project coverage is invalid");
    }
    localIds.add(project.localProjectId);
    remoteIds.add(project.remoteProjectId);
  }
  return [...projects].sort((left, right) => left.localProjectId.localeCompare(right.localProjectId));
}

/** Validate and normalize a candidate material's identity-bearing fields
 * (source, target, projects), independent of whether a publicationId is
 * present. Shared by computeActivationArtifactIdentityDigest (which never
 * sees a publicationId) and validateActivationArtifactMaterial (which
 * requires one for publication). */
function validateIdentityFields(
  input: ActivationArtifactMaterialInput,
): Readonly<{
  version: typeof ACTIVATION_ARTIFACT_MATERIAL_VERSION;
  source: ActivationArtifactRecoveryMaterial["source"];
  target: ActivationArtifactRecoveryMaterial["target"];
  projects: readonly ActivationArtifactProjectRecord[];
}> {
  if (!isRecord(input) || !isRecord(input.source) || !isRecord(input.target) || !Array.isArray(input.projects)) {
    throw new ActivationArtifactValidationError("activation artifact material is invalid");
  }
  if (input.version !== undefined && input.version !== ACTIVATION_ARTIFACT_MATERIAL_VERSION) {
    throw new ActivationArtifactValidationError("activation artifact material version is unsupported");
  }
  assertRecoveryFileShape(input.source.config, "source config");
  assertRecoveryFileShape(input.source.projectMap, "source project map");
  assertRecoveryFileShape(input.target.config, "target config");
  assertRecoveryFileShape(input.target.projectMap, "target project map");
  return {
    version: ACTIVATION_ARTIFACT_MATERIAL_VERSION,
    source: { config: input.source.config, projectMap: input.source.projectMap },
    target: { config: input.target.config, projectMap: input.target.projectMap },
    projects: normalizeProjects(input.projects as ActivationArtifactProjectRecord[]),
  };
}

function validateActivationArtifactMaterial(material: ActivationArtifactRecoveryMaterial): NormalizedMaterial {
  if (typeof material?.publicationId !== "string" || !PUBLICATION_ID_PATTERN.test(material.publicationId)) {
    throw new ActivationArtifactValidationError("activation artifact publicationId is invalid");
  }
  const identity = validateIdentityFields(material);
  return { ...identity, publicationId: material.publicationId };
}

function recoveryFileWireJson(file: BackendPublicationRecoveryFile): Record<string, unknown> {
  if (file.presence === "absent") return { presence: "absent" };
  return {
    presence: "present",
    contentBase64: Buffer.from(file.content).toString("base64"),
    mode: file.mode,
    uid: file.uid,
    gid: file.gid,
    nlink: file.nlink,
    dev: file.dev,
    ino: file.ino,
    parentDev: file.parentDev,
    parentIno: file.parentIno,
  };
}

function recoveryFileFromWireJson(value: unknown, field: string): BackendPublicationRecoveryFile {
  if (!isRecord(value)) {
    throw new ActivationArtifactValidationError(field + " material is malformed");
  }
  if (value.presence === "absent") {
    if (!exactKeys(value, ["presence"])) {
      throw new ActivationArtifactValidationError(field + " material is malformed");
    }
    return { presence: "absent" };
  }
  if (
    !exactKeys(value, ["contentBase64", "dev", "gid", "ino", "mode", "nlink", "parentDev", "parentIno", "presence", "uid"])
    || value.presence !== "present"
    || typeof value.contentBase64 !== "string"
    || !Number.isSafeInteger(value.mode)
    || !Number.isSafeInteger(value.uid)
    || !Number.isSafeInteger(value.gid)
    || typeof value.nlink !== "string"
    || typeof value.dev !== "string"
    || typeof value.ino !== "string"
    || typeof value.parentDev !== "string"
    || typeof value.parentIno !== "string"
  ) {
    throw new ActivationArtifactValidationError(field + " material is malformed");
  }
  const file: BackendPublicationRecoveryFile = {
    presence: "present",
    content: Buffer.from(value.contentBase64, "base64"),
    mode: value.mode as number,
    uid: value.uid as number,
    gid: value.gid as number,
    nlink: value.nlink as string,
    dev: value.dev as string,
    ino: value.ino as string,
    parentDev: value.parentDev as string,
    parentIno: value.parentIno as string,
  };
  assertRecoveryFileShape(file, field);
  return file;
}

/** JSON-safe form of the identity-bearing fields only (never publicationId),
 * shared by the identity digest and the wire serialization so the two can
 * never silently drift apart. */
function identityJson(material: {
  version: typeof ACTIVATION_ARTIFACT_MATERIAL_VERSION;
  source: ActivationArtifactRecoveryMaterial["source"];
  target: ActivationArtifactRecoveryMaterial["target"];
  projects: readonly ActivationArtifactProjectRecord[];
}): Record<string, unknown> {
  return {
    version: material.version,
    source: {
      config: recoveryFileWireJson(material.source.config),
      projectMap: recoveryFileWireJson(material.source.projectMap),
    },
    target: {
      config: recoveryFileWireJson(material.target.config),
      projectMap: recoveryFileWireJson(material.target.projectMap),
    },
    projects: material.projects.map((project) => ({
      localProjectId: project.localProjectId,
      remoteProjectId: project.remoteProjectId,
      evidenceSha256: project.evidenceSha256,
    })),
  };
}

/**
 * Compute the store key for a candidate (or freshly re-observed, during
 * recovery) material: a canonical digest over {version, source, target,
 * projects}, deliberately excluding publicationId. See the module doc
 * comment for why this exclusion is what makes the publication-id reuse
 * rule enforceable rather than aspirational. Accepts the same input shape
 * publishActivationArtifact does (publicationId optional) so a recovery
 * caller that has not yet decided a publicationId can compute the identical
 * digest an earlier, successful (but not-yet-sealed) attempt already used.
 */
export function computeActivationArtifactIdentityDigest(input: ActivationArtifactMaterialInput): string {
  const identity = validateIdentityFields(input);
  return canonicalSha256(identityJson(identity));
}

function materialWireContent(material: NormalizedMaterial): string {
  return canonicalJson({
    ...identityJson(material),
    publicationId: material.publicationId,
  }) + "\n";
}

function parseActivationArtifactMaterial(content: string, path: string): ActivationArtifactRecoveryMaterial {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ActivationArtifactValidationError(
      "activation artifact material at " + path + " is not JSON",
      { cause: error },
    );
  }
  if (
    !isRecord(value)
    || !exactKeys(value, ["projects", "publicationId", "source", "target", "version"])
    || value.version !== ACTIVATION_ARTIFACT_MATERIAL_VERSION
    || typeof value.publicationId !== "string"
    || !PUBLICATION_ID_PATTERN.test(value.publicationId)
    || !isRecord(value.source)
    || !isRecord(value.target)
    || !exactKeys(value.source, ["config", "projectMap"])
    || !exactKeys(value.target, ["config", "projectMap"])
    || !Array.isArray(value.projects)
  ) {
    throw new ActivationArtifactValidationError("activation artifact material at " + path + " envelope is malformed");
  }
  const projects = value.projects.map((project, index) => {
    if (
      !isRecord(project)
      || !exactKeys(project, ["evidenceSha256", "localProjectId", "remoteProjectId"])
      || typeof project.localProjectId !== "string"
      || typeof project.remoteProjectId !== "string"
      || typeof project.evidenceSha256 !== "string"
      || !EVIDENCE_SHA256_PATTERN.test(project.evidenceSha256)
    ) {
      throw new ActivationArtifactValidationError("activation artifact material projects[" + index + "] is malformed");
    }
    return {
      localProjectId: project.localProjectId,
      remoteProjectId: project.remoteProjectId,
      evidenceSha256: project.evidenceSha256,
    };
  });
  return validateActivationArtifactMaterial({
    version: ACTIVATION_ARTIFACT_MATERIAL_VERSION,
    publicationId: value.publicationId,
    source: {
      config: recoveryFileFromWireJson(value.source.config, "source config"),
      projectMap: recoveryFileFromWireJson(value.source.projectMap, "source project map"),
    },
    target: {
      config: recoveryFileFromWireJson(value.target.config, "target config"),
      projectMap: recoveryFileFromWireJson(value.target.projectMap, "target project map"),
    },
    projects: normalizeProjects(projects),
  });
}

/** A benign, expected collision: something already occupies the exclusive
 * destination this call tried to create. atomicWritePrivateFileDurable
 * signals both the pre-check collision and the concurrent-link race as a
 * typed PrivateFileCollisionError (see security-files.ts), so this module
 * recognizes them by class rather than by message text -- a reworded
 * message still reconciles, while an unrelated failure carrying similar
 * text is never mistaken for a benign race. */
function isBenignCollisionRace(error: unknown): boolean {
  return isPrivateFileCollisionFailure(error);
}

export type ActivationArtifactPublishDependencies = Readonly<{
  /** Override the durable single-directory publication primitive. Defaults
   * to atomicWritePrivateFileDurable. Exists to exercise this module's own
   * defensive handling of an unrecognized durable-write failure. */
  writeDurable?: typeof atomicWritePrivateFileDurable;
  /** Override the bounded, descriptor-bound reader used for the presence
   * check and idempotent-reuse comparison. Defaults to
   * readBoundedRegularFileWithStat. */
  readWithStat?: typeof readBoundedRegularFileWithStat;
  expectedUid?: number;
}>;

type ReconcileOutcome =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "reused" }>;

const MULTIPLE_HARD_LINKS_MESSAGE = "file has multiple hard links";

function isMultipleHardLinksError(error: unknown): boolean {
  return error instanceof Error && error.message === MULTIPLE_HARD_LINKS_MESSAGE;
}

/** Match atomicWritePrivateFileDurable's own scratch-naming convention (see
 * security-files.ts): a leading dot, the final basename, a dot, one or more
 * lowercase hex characters (the writer's random suffix -- its exact byte
 * count is deliberately not pinned here, so a future change to that byte
 * count cannot silently stop this module's own crash-twin recovery from
 * recognising it), and a ".tmp" extension. The structural shape is matched
 * by name; full authentication is by content and metadata identity
 * (exactWriterLinkPair below), never by name alone, so an unrelated file
 * that happens to fit this shape still cannot be mistaken for a genuine
 * scratch twin. */
function isWriterScratchName(entry: string, finalFileName: string): boolean {
  const prefix = "." + finalFileName + ".";
  const suffix = ".tmp";
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false;
  const middle = entry.slice(prefix.length, entry.length - suffix.length);
  return middle.length > 0
    && [...middle].every((character) => (character >= "0" && character <= "9") || (character >= "a" && character <= "f"));
}

/**
 * A local duplicate of generation-binding-store.ts's exactWriterLinkPair:
 * two reads of the SAME published inode -- the final published name and
 * its not-yet-unlinked writer scratch twin -- agree on every field a
 * legitimate atomicWritePrivateFileDurable crash between linkSync and the
 * scratch unlink can produce. Full content and metadata equality, not just
 * nlink, is what tells an authentic post-link crash twin apart from an
 * unrelated multi-link collision.
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

/**
 * Remove the authenticated scratch twin, re-verifying its identity
 * immediately before removal rather than trusting the earlier read, and
 * then report the published file's own link count so the caller can assert
 * the single-link invariant this recovery claims. The twin already being
 * gone (ENOENT) is not an error: another retry may have completed the
 * unlink first. Any other failure propagates raw rather than being
 * swallowed.
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return publishedLinkCount(publishedPath);
    throw error;
  }
  return publishedLinkCount(publishedPath);
}

/**
 * Authenticate and, if found, complete an interrupted durable-write crash
 * twin: atomicWritePrivateFileDurable's requireAbsent path publishes by
 * linking the writer's scratch file onto the final name and only afterward
 * unlinks the scratch, so a crash between those two syscalls leaves the
 * published name and its scratch twin as two links to one inode. A twin is
 * accepted only when a scratch file matching the writer's exact naming
 * convention in the same directory is byte-and-metadata identical to the
 * published name via exactWriterLinkPair. On a match, the interrupted
 * unlink is completed and the published file is asserted single-link again
 * before reconciliation proceeds against the published content exactly as
 * it would for any ordinary existing file: byte-identical content is an
 * idempotent reuse, different content is an identity mismatch, never a
 * silent overwrite. A post-unlink count other than exactly 1, or a twin
 * search that cannot authenticate exactly one twin, refuses as
 * ActivationArtifactPresenceUnresolvableError: a multi-link state this
 * module could not resolve is not evidence of a conflict, because no
 * comparison against a trustworthy read ever ran. A published file that
 * vanished entirely in that same window is reported as absent instead.
 */
function reconcileArtifactScratchTwin(
  path: string,
  directory: string,
  serialized: string,
  identityDigest: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
): ReconcileOutcome {
  const unresolvable = (): never => {
    throw new ActivationArtifactPresenceUnresolvableError(
      "a multi-link activation artifact at " + path +
        " could not be authenticated as an interrupted durable-write scratch twin",
    );
  };
  const readTwinAt = (candidatePath: string) =>
    attributeNullableRead<BoundedFileResult>(
      () => readWithStat(candidatePath, {
        allowedRoot: directory,
        maxBytes: MAX_ACTIVATION_ARTIFACT_BYTES,
        expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
      }),
    );

  const finalOutcome = readTwinAt(path);
  if (finalOutcome.kind !== "present" || finalOutcome.value.nlink !== "2") {
    return unresolvable();
  }

  const finalFileName = basename(path);
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return unresolvable();
  }

  let twinPath: string | undefined;
  for (const entry of entries) {
    if (!isWriterScratchName(entry, finalFileName)) continue;
    // A scan candidate is a directory entry this module did not create and
    // cannot vouch for, so its error surface is open-ended: any read of a
    // scan candidate that does not produce a trusted present-or-absent
    // outcome -- recognised or not -- is fail-closed here rather than left
    // to escape raw.
    let candidateOutcome: ReturnType<typeof readTwinAt>;
    try {
      candidateOutcome = readTwinAt(join(directory, entry));
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
  if (publishedNlink === undefined) return { kind: "absent" };
  if (publishedNlink !== 1n) return unresolvable();

  if (finalOutcome.value.content === serialized) {
    return { kind: "reused" };
  }
  throw new ActivationArtifactIdentityMismatchError(
    "an activation artifact already exists at " + path + " for identity digest " + identityDigest +
      " with different content; refusing to overwrite durable recovery material",
  );
}

function reconcileExisting(
  path: string,
  directory: string,
  serialized: string,
  identityDigest: string,
  expectedUid: number | undefined,
  readWithStat: typeof readBoundedRegularFileWithStat,
): ReconcileOutcome {
  let outcome;
  try {
    outcome = attributeNullableRead<BoundedFileResult>(
      () => readWithStat(path, {
        allowedRoot: directory,
        maxBytes: MAX_ACTIVATION_ARTIFACT_BYTES,
        expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
        requireSingleLink: true,
      }),
    );
  } catch (error) {
    if (isMultipleHardLinksError(error)) {
      return reconcileArtifactScratchTwin(path, directory, serialized, identityDigest, expectedUid, readWithStat);
    }
    throw error;
  }
  if (outcome.kind === "unresolvable") {
    throw new ActivationArtifactPresenceUnresolvableError(
      "cannot determine whether an activation artifact already exists at " + path + ": " + outcome.detail,
    );
  }
  if (outcome.kind === "absent") {
    return { kind: "absent" };
  }
  if (outcome.value.content === serialized) {
    return { kind: "reused" };
  }
  throw new ActivationArtifactIdentityMismatchError(
    "an activation artifact already exists at " + path + " for identity digest " + identityDigest +
      " with different content; refusing to overwrite durable recovery material",
  );
}

/**
 * Durably publish a recovery-material record, or reuse an already-published
 * one with byte-identical content. See the module doc comment for the full
 * persistence-discipline and identity-digest contract; this is the entry
 * point that implements it.
 */
export function publishActivationArtifact(
  input: Readonly<{ homeDir?: string; material: ActivationArtifactRecoveryMaterial }>,
  dependencies: ActivationArtifactPublishDependencies = {},
): ActivationArtifactPublishResult {
  const material = validateActivationArtifactMaterial(input.material);
  const identityDigest = computeActivationArtifactIdentityDigest(material);
  const directory = activationArtifactDirectory(input.homeDir);
  const path = activationArtifactPath(input.homeDir, identityDigest);
  const serialized = materialWireContent(material);
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;
  const writeDurable = dependencies.writeDurable ?? atomicWritePrivateFileDurable;

  ensureActivationArtifactDirectory(input.homeDir, expectedUid);

  const attempt = (): ReconcileOutcome =>
    reconcileExisting(path, directory, serialized, identityDigest, expectedUid, readWithStat);

  const first = attempt();
  if (first.kind === "reused") {
    return { outcome: "reused", identityDigest, path, material };
  }

  try {
    writeDurable(path, serialized, {
      requireAbsent: true,
      maxExistingBytes: MAX_ACTIVATION_ARTIFACT_BYTES,
      expectedUid,
    });
  } catch (error) {
    if (!isBenignCollisionRace(error)) throw error;
    // A concurrent writer published (or a leftover debris file blocked, then
    // cleared) between our presence check and this write attempt. Re-read
    // and reconcile exactly as above rather than treating a race as failure:
    // this is the "retry converges" property applied to true concurrency,
    // not just sequential crash-then-retry.
    const retry = attempt();
    if (retry.kind === "absent") {
      // The collision this module observed is already gone. Surface the
      // original error rather than loop indefinitely against a filesystem
      // that keeps changing out from under this call.
      throw error;
    }
    return { outcome: "reused", identityDigest, path, material };
  }

  return { outcome: "written", identityDigest, path, material };
}

export type ActivationArtifactReadDependencies = Readonly<{
  readWithStat?: typeof readBoundedRegularFileWithStat;
  expectedUid?: number;
}>;

/**
  * Read back a previously published recovery-material record by its identity
  * digest. Returns null only for an attributed absence (a genuinely missing
  * file); a permission-denied or otherwise unresolvable read throws rather
  * than being reported as "nothing here yet". A multi-link stored file --
  * the post-link crash state publishActivationArtifact's own retry
  * converges out of -- is reported as unresolvable here, never silently
  * repaired: reads never mutate, so converging that state is the writer
  * retry's job, not this reader's.
  */
 export function readActivationArtifact(
  input: Readonly<{ homeDir?: string; identityDigest: string }>,
  dependencies: ActivationArtifactReadDependencies = {},
): ActivationArtifactRecoveryMaterial | null {
  if (!IDENTITY_DIGEST_PATTERN.test(input.identityDigest)) {
    throw new ActivationArtifactValidationError("activation artifact identity digest is invalid");
  }
  const directory = activationArtifactDirectory(input.homeDir);
  const path = activationArtifactPath(input.homeDir, input.identityDigest);
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;

  let outcome;
  try {
    outcome = attributeNullableRead<BoundedFileResult>(
      () => readWithStat(path, {
        allowedRoot: directory,
        maxBytes: MAX_ACTIVATION_ARTIFACT_BYTES,
        expectedUid,
        allowedModes: [PRIVATE_FILE_MODE],
        requireSingleLink: true,
      }),
    );
  } catch (error) {
    if (isMultipleHardLinksError(error)) {
      throw new ActivationArtifactPresenceUnresolvableError(
        "activation artifact at " + path +
          " has multiple hard links and cannot be authenticated by a read; retry publication to converge the interrupted durable write",
      );
    }
    throw error;
  }
  if (outcome.kind === "unresolvable") {
    throw new ActivationArtifactPresenceUnresolvableError(
      "cannot determine whether an activation artifact exists at " + path + ": " + outcome.detail,
    );
  }
  if (outcome.kind === "absent") {
    return null;
  }
  return parseActivationArtifactMaterial(outcome.value.content, path);
}

export type ActivationArtifactCaptureDependencies = Readonly<{
  readWithStat?: typeof readBoundedRegularFileWithStat;
  expectedUid?: number;
}>;

/**
 * Capture one of the four files a recovery-material record carries (source
 * config, source project map, target config, target project map) from a
 * real path into the exact BackendPublicationRecoveryFile shape this
 * module's record stores it in. Reuses readBoundedRegularFileWithStat --
 * the same descriptor-bound, bounded, single-link reader
 * captureBackendPublicationFileWitness in backend-publication.ts uses --
 * rather than reimplementing bounded file reading; unlike that witness-only
 * helper, this one retains the raw content a later recovery actually needs
 * to re-drive a publication from bytes, not from a recomputed hash.
 */
export function captureActivationRecoveryFile(
  path: string,
  allowedRoot: string,
  dependencies: ActivationArtifactCaptureDependencies = {},
): BackendPublicationRecoveryFile {
  const expectedUid = dependencies.expectedUid ?? currentUid();
  const readWithStat = dependencies.readWithStat ?? readBoundedRegularFileWithStat;
  const outcome = attributeNullableRead<BoundedFileResult>(
    () => readWithStat(path, {
      allowedRoot,
      maxBytes: MAX_ACTIVATION_ARTIFACT_FILE_BYTES,
      expectedUid,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
    }),
  );
  if (outcome.kind === "unresolvable") {
    throw new ActivationArtifactPresenceUnresolvableError(
      "cannot determine whether " + path + " exists: " + outcome.detail,
    );
  }
  if (outcome.kind === "absent") {
    return { presence: "absent" };
  }
  const observed = outcome.value;
  return {
    presence: "present",
    content: Buffer.from(observed.content, "utf8"),
    mode: observed.mode,
    uid: observed.uid,
    gid: observed.gid,
    nlink: observed.nlink,
    dev: observed.exactDev,
    ino: observed.exactIno,
    parentDev: observed.parentDev,
    parentIno: observed.parentIno,
  };
}
