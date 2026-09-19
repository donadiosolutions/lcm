import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  chmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lcmHomeDir, projectsDir } from "./runtime-paths.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileDurable,
  assertPrivateDirectory,
  consumeBoundedRegularFile,
  ensurePrivateDirectory,
  openPrivateDirectory,
  openPrivateDirectoryIfExists,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  retainedDirectoryDescriptorPath,
  requireSupportedProcessUid,
  syncPrivateDirectory,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
  writePrivateFileExclusive,
} from "./security-files.js";
import { normalizeUuidV7 } from "./machine-identity.js";
import {
  PrivateMutationPermit,
  PrivateMutationLockContentionError,
  withPrivateMutationLock,
  type PrivateMutationLockObserver,
} from "./private-mutation-lock.js";
import { resolveGitProjectAnchor } from "./git-project.js";
import {
  assertBackendPublicationProjectMapAccess,
  assertBackendPublicationProjectMapMutation,
  assertBackendPublicationPermit,
  BackendPublicationJournalError,
  captureBackendPublicationState,
  withBackendPublicationConsumerLock,
  type BackendPublicationFileMutationContext,
  type BackendPublicationFileWitness,
  type BackendPublicationLockToken,
  type BackendPublicationRecoveryFile,
} from "./storage/backend-publication.js";
import { isAuthenticatedRetiredProjectIdentityFence } from "./worktree-reconciliation-fence.js";

export type ProjectMapEntry = {
  canonical: string;
  aliases: string[];
  remoteProjectId?: string;
};

export type ProjectMap = Record<string, ProjectMapEntry>;

function projectMapEntriesEqual(left: ProjectMapEntry, right: ProjectMapEntry): boolean {
  const leftAliases = left.aliases.map((path) => resolve(path)).sort();
  const rightAliases = right.aliases.map((path) => resolve(path)).sort();
  return left.remoteProjectId === right.remoteProjectId
    && resolve(left.canonical) === resolve(right.canonical)
    && leftAliases.length === rightAliases.length
    && leftAliases.every((path, index) => path === rightAliases[index]);
}

function assertExpectedProjectMapEntry(
  hash: string,
  actual: ProjectMapEntry,
  expected: ProjectMapEntry | undefined,
): void {
  if (expected && !projectMapEntriesEqual(actual, expected)) {
    throw new Error(`project map entry ${hash} changed during coordinated mutation`);
  }
}

export type ProjectIdentity = {
  id: string;
  canonical: string;
  remoteProjectId?: string;
};

export type ProjectMapValidation = {
  ok: boolean;
  map: ProjectMap | null;
  path: string;
  errors: string[];
  warnings: string[];
  fixApplied: boolean;
  backupPath?: string;
};

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_PROJECT_MAP_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_MAP_BACKUP_ATTEMPTS = 1_000;
let cache: { path: string; mtimeMs: number | null; map: ProjectMap; metadataPopulated: boolean } | null = null;
const activeProjectMapMutationLocks = new Set<string>();

export type ProjectMapLockObserver = PrivateMutationLockObserver;

function projectMapMutationLockPath(homeDir?: string): string {
  return `${projectMapPath(homeDir)}.lock`;
}

function withProjectMapMutationLock<T>(
  callback: (publicationLockToken: BackendPublicationLockToken) => T,
  homeDir?: string,
  observer?: ProjectMapLockObserver,
  publicationLockToken?: BackendPublicationLockToken,
  permit?: PrivateMutationPermit,
): T {
  const lockPath = projectMapMutationLockPath(homeDir);
  return withBackendPublicationConsumerLock(homeDir, (activePublicationLockToken) =>
    withPrivateMutationLock(lockPath, "project map", () => {
      activeProjectMapMutationLocks.add(lockPath);
      try {
        return callback(activePublicationLockToken);
      } finally {
        activeProjectMapMutationLocks.delete(lockPath);
      }
    }, observer), {
    lockToken: publicationLockToken,
    permit,
  });
}

/**
 * Hold the project-map mutation fence across a coordinated state migration.
 * The callback receives the single strict snapshot that remains authoritative
 * until it returns.
 */
export function withProjectMapReconciliationLock<T>(
  callback: (
    map: ProjectMap,
    homeDir: string | undefined,
    publicationLockToken: BackendPublicationLockToken,
  ) => T,
  homeDir?: string,
  publicationLockToken?: BackendPublicationLockToken,
): T {
  return withProjectMapMutationLock(
    (nestedPublicationLockToken) => callback(
      loadProjectMapWithMetadata({
        strict: true,
        reload: true,
        homeDir,
        _publicationLockToken: nestedPublicationLockToken,
      }),
      homeDir,
      nestedPublicationLockToken,
    ),
    homeDir,
    undefined,
    publicationLockToken,
  );
}

export function projectMapPath(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "map.json");
}

export function oldMapsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "oldmaps");
}

export function normalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Resolve linked Git worktrees to one local repository anchor. */
export function normalizeProjectIdentityPath(path: string): string {
  return resolveGitProjectAnchor(path)?.canonical ?? normalizeProjectPath(path);
}

export function hashProjectPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

const RETIRED_PROJECT_SUCCESSOR_DOMAIN =
  "lcm:retired-project-identity-successor:v1\0";

/** Derive the stable local successor without consulting or mutating state. */
export function retiredProjectIdentitySuccessor(
  retiredId: string,
  canonicalPath: string,
): string {
  if (!HASH_RE.test(retiredId)) {
    throw new Error("retired project identity must be a lowercase sha256 hash");
  }
  if (!isAbsolute(canonicalPath)) {
    throw new Error("retired project canonical path must be absolute");
  }
  return createHash("sha256")
    .update(RETIRED_PROJECT_SUCCESSOR_DOMAIN)
    .update(retiredId)
    .update("\0")
    .update(canonicalPath)
    .digest("hex");
}

/** Recognize the only successor shape created by retired-identity renewal. */
export function isRetiredProjectIdentitySuccessor(
  identityId: string,
  retiredId: string,
  canonicalPath: string,
): boolean {
  return identityId === retiredProjectIdentitySuccessor(retiredId, canonicalPath);
}

/** Authenticate a successor-shaped identity with its retained predecessor fence. */
export function isAuthenticatedRetiredProjectIdentitySuccessor(
  identityId: string,
  retiredId: string,
  canonicalPath: string,
  homeDir?: string,
): boolean {
  return isRetiredProjectIdentitySuccessor(identityId, retiredId, canonicalPath)
    && isAuthenticatedRetiredProjectIdentityFence(
      join(projectsDir(homeDir), retiredId),
      retiredId,
    );
}

export type PersistedRetiredProjectIdentitySuccessor = Readonly<{
  id: string;
  retiredId: string;
  canonical: string;
}>;

/**
 * Report every persisted successor-shaped identity that one entry path reaches.
 *
 * Renewal itself refuses aliases, but `linkLocalAlias` may add one afterwards
 * without PostgreSQL, so a renewed entry is legitimately reachable both by its
 * own canonical path and by a distinct alias directory. A caller that derives
 * the expected successor from the ENTERED path recognizes only the canonical
 * case: for an alias it derives an unrelated id, concludes the project was
 * never renewed, and acts on the entry with no proof of renewal at all.
 *
 * Matching the map instead reports the entries that are actually bound to this
 * path, each keyed by its own canonical path — the only path that can
 * authenticate it, because that is the path renewal hashed to mint the id.
 * `existingEventsDbPath` and `parseLocalProjectMapCompatibility` already
 * authenticate a matched entry this way; this keeps reconciliation consistent
 * with them.
 */
export function persistedRetiredProjectIdentitySuccessors(
  map: ProjectMap,
  path: string,
): readonly PersistedRetiredProjectIdentitySuccessor[] {
  const reached: PersistedRetiredProjectIdentitySuccessor[] = [];
  for (const id of findPathMatches(map, path)) {
    // `resolve` always yields an absolute path, so successor derivation cannot
    // reject the entry and this stays a total, side-effect-free query.
    const canonical = resolve(map[id].canonical);
    const retiredId = hashProjectPath(canonical);
    if (!isRetiredProjectIdentitySuccessor(id, retiredId, canonical)) continue;
    reached.push({ id, retiredId, canonical });
  }
  return reached;
}

export type RetiredProjectIdentityRenewal = Readonly<{
  oldId: string;
  newId: string;
  canonical: string;
  changed: boolean;
}>;

type RetiredProjectIdentityRenewalOptions = Readonly<{
  /** @internal Deterministic post-validation/pre-publication race seam. */
  _afterValidationBeforePublicationForTesting?: () => void;
  /** @internal Deterministic evidence-cleanup failure seam. */
  _closeEvidenceForTesting?: (
    kind: "fence" | "events" | "projects" | "root" | "target",
    close: () => void,
  ) => void;
  /** @internal Deterministic retained-fence short-read seam. */
  _fenceReadForTesting?: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  /** @internal Deterministic retained-fence metadata seam. */
  _fenceStatForTesting?: (
    kind: "descriptor" | "path",
    phase: "before" | "after",
    stat: RetainedFenceIdentity,
  ) => RetainedFenceIdentity;
  /** @internal Deterministic mutation seam between read and post-stat. */
  _afterFenceReadForTesting?: () => void;
  /** @internal Deterministic project-map snapshot read failure seam. */
  _readMapFileForTesting?: typeof readMapFile;
  /** @internal Observe or race the retained-root replacement boundary. */
  _beforeMapReplaceForTesting?: (phase: "publish") => void;
  /** @internal Deterministic writer failure after the publishing rename landed. */
  _afterMapReplaceForTesting?: () => void;
  /** @internal Deterministic failure after map publication and before readback. */
  _afterMapPublicationForTesting?: () => void;
}>;

type RetainedDirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  isDirectory: () => boolean;
}>;

type RetainedFenceIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile: () => boolean;
}>;

type RetainedFenceIo = Readonly<{
  read: NonNullable<RetiredProjectIdentityRenewalOptions["_fenceReadForTesting"]>;
  stat: NonNullable<RetiredProjectIdentityRenewalOptions["_fenceStatForTesting"]>;
  afterRead?: () => void;
}>;

type RetainedTargetDirectory = Readonly<{
  fd: number;
  path: string;
  witness: RetainedDirectoryIdentity;
}>;

type RetainedFenceFile = Readonly<{
  fd: number;
  name: string;
  expectedContent: Buffer;
  witness: RetainedFenceIdentity;
  io: RetainedFenceIo;
}>;

type RetiredIdentityRenewalEvidence = Readonly<{
  target: RetainedTargetDirectory;
  root: PrivateDirectoryHandle;
  rootPath: string;
  projects: PrivateDirectoryHandle;
  projectsPath: string;
  events?: PrivateDirectoryHandle;
  eventsPath: string;
  fence: RetainedFenceFile;
  successorId: string;
  expectedUid: number;
}>;

type MutableRetiredIdentityRenewalEvidence = {
  -readonly [Key in keyof RetiredIdentityRenewalEvidence]?: RetiredIdentityRenewalEvidence[Key];
};

const RETAINED_DIRECTORY_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK;
const RETAINED_FILE_FLAGS = constants.O_RDONLY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK;

function sameRetainedDirectory(
  left: RetainedDirectoryIdentity,
  right: RetainedDirectoryIdentity,
): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function openRetainedTargetDirectory(path: string): RetainedTargetDirectory {
  const fd = openSync(path, RETAINED_DIRECTORY_FLAGS);
  try {
    const witness = fstatSync(fd, { bigint: true }) as unknown as RetainedDirectoryIdentity;
    const entry = lstatSync(path, { bigint: true }) as unknown as RetainedDirectoryIdentity;
    if (!sameRetainedDirectory(witness, entry)) {
      throw new Error("retired project target directory changed during admission");
    }
    return { fd, path, witness };
  } catch (error) {
    try { closeSync(fd); } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "retired project target admission and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function assertRetainedTargetDirectory(target: RetainedTargetDirectory): void {
  const descriptor = fstatSync(target.fd, { bigint: true }) as unknown as RetainedDirectoryIdentity;
  const entry = lstatSync(target.path, { bigint: true }) as unknown as RetainedDirectoryIdentity;
  if (
    !sameRetainedDirectory(target.witness, descriptor)
    || !sameRetainedDirectory(target.witness, entry)
  ) {
    throw new Error("retired project target directory changed before renewal");
  }
}

function assertRetainedPrivateChild(
  parent: PrivateDirectoryHandle,
  name: string,
  expected: PrivateDirectoryWitness,
): void {
  const entry = lstatSync(
    join(retainedDirectoryDescriptorPath(parent.fd), name),
    { bigint: true },
  ) as unknown as RetainedDirectoryIdentity;
  if (
    !entry.isDirectory()
    || entry.dev.toString(10) !== expected.dev
    || entry.ino.toString(10) !== expected.ino
    || Number(entry.mode & 0o7777n) !== expected.mode
    || Number(entry.uid) !== expected.uid
    || Number(entry.gid) !== expected.gid
  ) {
    throw new Error("retired project private parent changed before renewal");
  }
}

function assertStableRetainedPrivateDirectory(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
  expectedUid: number,
): void {
  const actual = assertPrivateDirectory(handle, path, undefined, expectedUid);
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("retired project private directory changed before renewal");
  }
}

function assertRetainedChildAbsent(parent: PrivateDirectoryHandle, name: string): void {
  try {
    lstatSync(join(retainedDirectoryDescriptorPath(parent.fd), name));
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  throw new Error("retired project successor storage is occupied");
}

function readRetainedFenceBytes(fence: RetainedFenceFile): Buffer {
  const bytes = Buffer.alloc(fence.expectedContent.length);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fence.io.read(
      fence.fd,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
      throw new Error("retired project fence read ended before exact content was available");
    }
    offset += count;
  }
  const extra = Buffer.alloc(1);
  const extraCount = fence.io.read(fence.fd, extra, 0, 1, bytes.length);
  if (extraCount !== 0) {
    throw new Error("retired project fence has trailing content");
  }
  return bytes;
}

function sameRetainedFence(left: RetainedFenceIdentity, right: RetainedFenceIdentity): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRetainedFenceFile(
  projects: PrivateDirectoryHandle,
  fence: RetainedFenceFile,
  expectedUid: number,
): void {
  const path = join(retainedDirectoryDescriptorPath(projects.fd), fence.name);
  const descriptorBefore = fence.io.stat(
    "descriptor",
    "before",
    fstatSync(fence.fd, { bigint: true }) as unknown as RetainedFenceIdentity,
  );
  const entryBefore = fence.io.stat(
    "path",
    "before",
    lstatSync(path, { bigint: true }) as unknown as RetainedFenceIdentity,
  );
  const expectedSize = BigInt(fence.expectedContent.length);
  if (
    !sameRetainedFence(fence.witness, descriptorBefore)
    || !sameRetainedFence(fence.witness, entryBefore)
    || !sameRetainedFence(descriptorBefore, entryBefore)
    || descriptorBefore.size !== expectedSize
    || entryBefore.size !== expectedSize
    || Number(descriptorBefore.uid) !== expectedUid
    || !OWNER_ONLY_FILE_MODES.includes(Number(descriptorBefore.mode & 0o7777n))
    || descriptorBefore.nlink !== 1n
  ) {
    throw new Error("retired project fence changed before renewal");
  }
  const content = readRetainedFenceBytes(fence);
  fence.io.afterRead?.();
  const descriptorAfter = fence.io.stat(
    "descriptor",
    "after",
    fstatSync(fence.fd, { bigint: true }) as unknown as RetainedFenceIdentity,
  );
  const entryAfter = fence.io.stat(
    "path",
    "after",
    lstatSync(path, { bigint: true }) as unknown as RetainedFenceIdentity,
  );
  if (
    !content.equals(fence.expectedContent)
    || !sameRetainedFence(descriptorBefore, descriptorAfter)
    || !sameRetainedFence(entryBefore, entryAfter)
    || !sameRetainedFence(descriptorAfter, entryAfter)
    || descriptorAfter.size !== expectedSize
    || entryAfter.size !== expectedSize
  ) {
    throw new Error("retired project fence changed during exact read");
  }
}

function openRetainedFenceFile(
  projects: PrivateDirectoryHandle,
  oldId: string,
  expectedUid: number,
  options: RetiredProjectIdentityRenewalOptions,
): RetainedFenceFile {
  const name = basename(retiredProjectStoragePath(oldId));
  const fd = openSync(
    join(retainedDirectoryDescriptorPath(projects.fd), name),
    RETAINED_FILE_FLAGS,
  );
  const expectedContent = Buffer.from(
    `${JSON.stringify({ version: 1, hash: oldId, kind: "project" })}\n`,
    "utf8",
  );
  const io: RetainedFenceIo = {
    read: options._fenceReadForTesting
      ?? ((readFd, buffer, offset, length, position) =>
        readSync(readFd, buffer, offset, length, position)),
    stat: options._fenceStatForTesting ?? ((_kind, _phase, stat) => stat),
    ...(options._afterFenceReadForTesting === undefined
      ? {}
      : { afterRead: options._afterFenceReadForTesting }),
  };
  try {
    const witness = io.stat(
      "descriptor",
      "before",
      fstatSync(fd, { bigint: true }) as unknown as RetainedFenceIdentity,
    );
    const fence = { fd, name, expectedContent, witness, io };
    assertRetainedFenceFile(projects, fence, expectedUid);
    return fence;
  } catch (error) {
    try { closeSync(fd); } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "retired project fence admission and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function closeRetiredIdentityRenewalEvidence(
  evidence: MutableRetiredIdentityRenewalEvidence,
  closeForTesting?: RetiredProjectIdentityRenewalOptions["_closeEvidenceForTesting"],
  kinds: readonly ("fence" | "events" | "projects" | "root" | "target")[] = [
    "fence", "events", "projects", "root", "target",
  ],
): unknown[] {
  const errors: unknown[] = [];
  const closers = [
    ["fence", evidence.fence === undefined ? undefined : () => closeSync(evidence.fence!.fd)],
    ["events", evidence.events === undefined ? undefined : () => evidence.events!.close()],
    ["projects", evidence.projects === undefined ? undefined : () => evidence.projects!.close()],
    ["root", evidence.root === undefined ? undefined : () => evidence.root!.close()],
    ["target", evidence.target === undefined ? undefined : () => closeSync(evidence.target!.fd)],
  ] as const;
  for (const [kind, close] of closers) {
    if (!kinds.includes(kind)) continue;
    if (close === undefined) continue;
    try {
      if (closeForTesting === undefined) close();
      else closeForTesting(kind, close);
    } catch (error) { errors.push(error); }
  }
  return errors;
}

function openRetiredIdentityRenewalEvidence(
  canonical: string,
  oldId: string,
  successorId: string,
  options: RetiredProjectIdentityRenewalOptions,
): RetiredIdentityRenewalEvidence {
  const evidence: MutableRetiredIdentityRenewalEvidence = {};
  try {
    const expectedUid = requireSupportedProcessUid();
    const rootPath = lcmHomeDir();
    const projectsPath = projectsDir();
    const eventsPath = join(rootPath, "events");
    evidence.target = openRetainedTargetDirectory(canonical);
    evidence.root = openPrivateDirectory(rootPath, { expectedUid });
    evidence.projects = openPrivateDirectory(projectsPath, { expectedUid });
    evidence.events = openPrivateDirectoryIfExists(eventsPath, { expectedUid });
    evidence.fence = openRetainedFenceFile(
      evidence.projects,
      oldId,
      expectedUid,
      options,
    );
    const complete = {
      ...evidence,
      target: evidence.target,
      root: evidence.root,
      rootPath,
      projects: evidence.projects,
      projectsPath,
      events: evidence.events,
      eventsPath,
      fence: evidence.fence,
      successorId,
      expectedUid,
    } as RetiredIdentityRenewalEvidence;
    return complete;
  } catch (error) {
    const cleanupErrors = closeRetiredIdentityRenewalEvidence(evidence);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "retired project renewal evidence admission and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function assertRetiredIdentityRenewalEvidence(
  evidence: RetiredIdentityRenewalEvidence,
  requireSuccessorAbsent: boolean,
): void {
  assertRetainedTargetDirectory(evidence.target);
  assertStableRetainedPrivateDirectory(
    evidence.root,
    evidence.rootPath,
    evidence.root.witness,
    evidence.expectedUid,
  );
  assertStableRetainedPrivateDirectory(
    evidence.projects,
    evidence.projectsPath,
    evidence.projects.witness,
    evidence.expectedUid,
  );
  assertRetainedPrivateChild(evidence.root, "projects", evidence.projects.witness);
  assertRetainedFenceFile(evidence.projects, evidence.fence, evidence.expectedUid);
  if (requireSuccessorAbsent) {
    assertRetainedChildAbsent(evidence.projects, evidence.successorId);
  }
  if (evidence.events === undefined) {
    if (requireSuccessorAbsent) assertRetainedChildAbsent(evidence.root, "events");
  } else {
    assertStableRetainedPrivateDirectory(
      evidence.events,
      evidence.eventsPath,
      evidence.events.witness,
      evidence.expectedUid,
    );
    assertRetainedPrivateChild(evidence.root, "events", evidence.events.witness);
    if (requireSuccessorAbsent) {
      assertRetainedChildAbsent(evidence.events, `${evidence.successorId}.db`);
    }
  }
}

function assertRenewableProjectEntry(
  entry: ProjectMapEntry,
  canonical: string,
): void {
  if (normalizeProjectPath(entry.canonical) !== canonical) {
    throw new Error("retired project canonical binding changed");
  }
  if (entry.aliases.length !== 0) {
    throw new Error("retired project identity renewal refuses aliases");
  }
  if (entry.remoteProjectId !== undefined) {
    throw new Error("retired project identity renewal is local-only");
  }
}

function retiredProjectStoragePath(id: string): string {
  return join(projectsDir(), id);
}

function assertUnoccupiedRetiredProjectSuccessor(
  map: ProjectMap,
  successorId: string,
): void {
  if (map[successorId] !== undefined) {
    throw new Error("retired project successor map identity is occupied");
  }
}

/**
 * Rekey one proven path-hash binding while preserving its reconciliation fence.
 * Repeated calls recognize the same successor and return an idempotent no-op.
 */
export function renewRetiredProjectIdentity(
  targetPath: string = process.cwd(),
  options: RetiredProjectIdentityRenewalOptions = {},
): RetiredProjectIdentityRenewal {
  const requested = normalizeProjectPath(targetPath);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error("retired project identity renewal requires an existing local directory");
  }
  // The recovery diagnostic tells the user to run this "from this project", so
  // the invocation may come from a nested directory or a linked worktree. The
  // map is keyed by the repository anchor that ordinary identity resolution
  // uses, so resolve the same anchor before deriving the retired hash and
  // looking up its map owner.
  const canonical = normalizeProjectIdentityPath(requested);
  const oldId = hashProjectPath(canonical);
  const newId = retiredProjectIdentitySuccessor(oldId, canonical);
  return withProjectMapMutationLock((publicationLockToken) => {
    let map = loadProjectMap({
      strict: true,
      reload: true,
      _publicationLockToken: publicationLockToken,
    });
    const owners = findPathMatches(map, canonical);
    if (owners.size !== 1) {
      throw new Error("retired project path must have exactly one local map owner");
    }
    const ownerId = [...owners][0]!;
    const entry = map[ownerId]!;
    assertRenewableProjectEntry(entry, canonical);
    const idempotent = ownerId === newId;
    if (idempotent && map[oldId] !== undefined) {
      throw new Error("retired and successor project identities are both mapped");
    }
    if (!idempotent && ownerId !== oldId) {
      throw new Error("project is not bound by its original canonical path hash");
    }
    if (!idempotent) assertUnoccupiedRetiredProjectSuccessor(map, newId);

    const evidence = openRetiredIdentityRenewalEvidence(
      canonical,
      oldId,
      newId,
      options,
    );
    let primaryError: unknown;
    let result: RetiredProjectIdentityRenewal | undefined;
    const readRenewalMap = options._readMapFileForTesting ?? readMapFile;
    const retainedMapWrite = (
      phase: "publish",
      validate: () => void,
    ): RetainedProjectMapWrite => ({
      parent: evidence.root,
      beforeReplace: () => {
        validate();
        options._beforeMapReplaceForTesting?.(phase);
        validate();
      },
    });
    try {
      if (readRenewalMap(projectMapPath()) === null) {
        throw new Error("retired project map disappeared before renewal");
      }
      assertRetiredIdentityRenewalEvidence(evidence, !idempotent);
      if (idempotent) {
        result = { oldId, newId, canonical, changed: false };
      } else {
        options._afterValidationBeforePublicationForTesting?.();
        map = loadProjectMap({
          strict: true,
          reload: true,
          _publicationLockToken: publicationLockToken,
        });
        const finalOwners = findPathMatches(map, canonical);
        if (finalOwners.size !== 1 || !finalOwners.has(oldId)) {
          throw new Error("retired project map binding changed before renewal");
        }
        assertRenewableProjectEntry(map[oldId]!, canonical);
        assertUnoccupiedRetiredProjectSuccessor(map, newId);
        assertRetiredIdentityRenewalEvidence(evidence, true);
        if (readMapFile(projectMapPath()) === null) {
          throw new Error("retired project map disappeared before publication");
        }

        const renewed = cloneMap(map);
        delete renewed[oldId];
        renewed[newId] = { canonical, aliases: [] };
        // The rename can expose `newId` before the writer completes its
        // retained-parent post-check, calls `onMapPublished`, or refreshes the
        // process cache. A reported `published` or `unknown` outcome may
        // therefore already be visible to hooks, which resolve without this
        // lock and can immediately materialize successor storage. Never
        // restore `oldId` after a publication attempt: every failure before
        // the rename leaves the retired map untouched, while every uncertain
        // outcome must preserve the only binding hooks may have observed.
        writeProjectMap(renewed, undefined, {
          retainedWrite: retainedMapWrite(
            "publish",
            () => assertRetiredIdentityRenewalEvidence(evidence, true),
          ),
          onMapPublished: () => options._afterMapReplaceForTesting?.(),
        });
        options._afterMapPublicationForTesting?.();
        // The atomic replace above already made `newId` the authoritative
        // binding. Hook-side identity resolution deliberately resolves
        // without the publication lock, so a concurrent hook that observes
        // the published map may legitimately create the successor storage
        // directory, the `events` directory, or `events/<newId>.db` in this
        // window. Successor absence only proves the successor was unoccupied
        // at the moment of the rekey, so it stays an obligation of the
        // pre-publication validations and of the publishing write's
        // `beforeReplace` boundary. Retained-descriptor and retained-fence
        // authentication still run in full, so a same-UID rebinding of
        // `.lcm`, `projects`, `events`, or the retired fence still fails
        // closed without undoing an observable publication.
        assertRetiredIdentityRenewalEvidence(evidence, false);
        const readback = loadProjectMap({
          strict: true,
          reload: true,
          _publicationLockToken: publicationLockToken,
        });
        if (
          readback[oldId] !== undefined
          || readback[newId] === undefined
          || Object.keys(readback).length !== Object.keys(renewed).length
          || !projectMapEntriesEqual(readback[newId]!, renewed[newId]!)
        ) {
          throw new Error("retired project identity renewal readback failed");
        }
        result = { oldId, newId, canonical, changed: true };
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = closeRetiredIdentityRenewalEvidence(
      evidence,
      options._closeEvidenceForTesting,
      ["fence", "events", "projects", "target"],
    );
    // A publication that passed its own readback is the authoritative
    // binding, and a hook resolving without the publication lock may already
    // have created the successor sidecar. Restoring the retired id because a
    // descriptor failed to close would fence the project behind an occupied
    // successor that every retry then refuses, so the cleanup failure is
    // reported on its own and the renewed binding stands.
    cleanupErrors.push(...closeRetiredIdentityRenewalEvidence(
      evidence,
      options._closeEvidenceForTesting,
      ["root"],
    ));
    if (primaryError !== undefined) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "retired project identity renewal and evidence cleanup failed",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "retired project identity evidence cleanup failed");
    }
    if (result === undefined) throw new Error("retired project identity renewal produced no result");
    return result;
  });
}

export function clearProjectMapCache(): void {
  cache = null;
}

function emptyMap(): ProjectMap {
  return {};
}

function cloneMap(map: ProjectMap): ProjectMap {
  return Object.fromEntries(
    Object.entries(map).map(([hash, entry]) => [
      hash,
      {
        canonical: entry.canonical,
        aliases: [...entry.aliases],
        ...(entry.remoteProjectId ? { remoteProjectId: entry.remoteProjectId } : {}),
      },
    ]),
  );
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function readMapFile(path: string): { content: string; mtimeMs: number | null } | null {
  try {
    return readBoundedRegularFileWithStat(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_PROJECT_MAP_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
    });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

class InvalidProjectMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectMapError";
  }
}

function parseProjectMap(content: string): ProjectMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new InvalidProjectMapError(
      error instanceof Error ? error.message : "map.json is invalid",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidProjectMapError("map.json must be an object");
  }

  const map: ProjectMap = {};
  for (const [hash, value] of Object.entries(parsed)) {
    if (!HASH_RE.test(hash)) {
      throw new InvalidProjectMapError(
        `map entry key must be a 64-character lowercase sha256 hash: ${hash}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new InvalidProjectMapError(`map entry ${hash} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.canonical !== "string" || entry.canonical.length === 0) {
      throw new InvalidProjectMapError(
        `map entry ${hash}.canonical must be a non-empty string`,
      );
    }
    if (!isAbsolute(entry.canonical)) {
      throw new InvalidProjectMapError(
        `map entry ${hash}.canonical must be an absolute path`,
      );
    }
    if (!Array.isArray(entry.aliases) || !entry.aliases.every((alias) => typeof alias === "string" && alias.length > 0)) {
      throw new InvalidProjectMapError(
        `map entry ${hash}.aliases must be an array of non-empty strings`,
      );
    }
    for (const alias of entry.aliases) {
      if (!isAbsolute(alias)) {
        throw new InvalidProjectMapError(
          `map entry ${hash}.aliases must contain only absolute paths: ${alias}`,
        );
      }
    }
    const remoteProjectId = typeof entry.remoteProjectId === "string"
      ? normalizeUuidV7(entry.remoteProjectId)
      : null;
    if (entry.remoteProjectId !== undefined && remoteProjectId === null) {
      throw new InvalidProjectMapError(
        `map entry ${hash}.remoteProjectId must be a PostgreSQL UUIDv7`,
      );
    }
    map[hash] = {
      canonical: entry.canonical,
      aliases: [...entry.aliases],
      ...(remoteProjectId
        ? { remoteProjectId }
        : {}),
    };
  }
  return map;
}

function prettyMap(map: ProjectMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}

function createBackupIfNeeded(path: string, homeDir?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backupDir = oldMapsDir(homeDir);
  ensurePrivateDirectory(backupDir);
  const timestamp = Math.floor(Date.now() / 1000);
  let content: string;
  try {
    content = readBoundedRegularFile(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_PROJECT_MAP_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
    });
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  for (let suffix = 0; suffix < MAX_PROJECT_MAP_BACKUP_ATTEMPTS; suffix += 1) {
    const discriminator = suffix === 0 ? "" : `-${suffix}`;
    const backupPath = join(backupDir, `map-${timestamp}${discriminator}.json`);
    if (writePrivateFileExclusive(backupPath, content)) return backupPath;
  }
  throw new Error(
    `could not create an exclusive project map backup after ${MAX_PROJECT_MAP_BACKUP_ATTEMPTS} attempts; move old backups aside and retry`,
  );
}

function assertCurrentMapIsWritable(path: string): void {
  const file = readMapFile(path);
  if (!file) return;
  try {
    parseProjectMap(file.content);
  } catch (err) {
    throw new Error(`refusing to overwrite invalid map.json: ${(err as Error).message}`);
  }
}

type RetainedProjectMapWrite = Readonly<{
  parent: PrivateDirectoryHandle;
  beforeReplace: () => void;
}>;

function writeProjectMap(
  map: ProjectMap,
  homeDir?: string,
  opts: {
    metadataPopulated?: boolean;
    onBackupCreated?: (path: string) => void;
    onMapPublished?: () => void;
    retainedWrite?: RetainedProjectMapWrite;
  } = {},
): { path: string; backupPath?: string } {
  const path = projectMapPath(homeDir);
  if (opts.retainedWrite === undefined) ensurePrivateDirectory(dirname(path));
  else assertPrivateDirectory(
    opts.retainedWrite.parent,
    dirname(path),
    opts.retainedWrite.parent.witness,
    opts.retainedWrite.parent.witness.uid,
  );
  if (opts.retainedWrite === undefined) assertCurrentMapIsWritable(path);
  const backupPath = opts.retainedWrite === undefined
    ? createBackupIfNeeded(path, homeDir)
    : undefined;
  if (backupPath) opts.onBackupCreated?.(backupPath);
  atomicWritePrivateFile(
    path,
    prettyMap(map),
    {},
    opts.retainedWrite?.parent,
    opts.retainedWrite === undefined ? {} : { beforeReplace: opts.retainedWrite.beforeReplace },
  );
  opts.onMapPublished?.();
  const statPath = opts.retainedWrite === undefined
    ? path
    : join(retainedDirectoryDescriptorPath(opts.retainedWrite.parent.fd), basename(path));
  cache = {
    path,
    mtimeMs: statSync(statPath).mtimeMs,
    map: cloneMap(map),
    metadataPopulated: opts.metadataPopulated ?? cache?.metadataPopulated ?? false,
  };
  return { path, backupPath };
}

function recoveryProjectMapContent(
  input: BackendPublicationFileMutationContext,
): { readonly content: string | null; readonly map: ProjectMap } {
  if (input.file.presence === "absent") return { content: null, map: emptyMap() };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(input.file.content);
  } catch (error) {
    throw new InvalidProjectMapError(`backend publication project-map material is not UTF-8: ${String(error)}`);
  }
  return { content, map: parseProjectMap(content) };
}

function projectMapWitnessMatches(
  actual: BackendPublicationFileWitness,
  expected: BackendPublicationFileWitness,
  requireDescriptorIdentity = true,
): boolean {
  for (const field of ["presence", "rawSha256", "semanticSha256", "byteLength", "mode", "uid", "gid", "nlink"] as const) {
    if (actual[field] !== expected[field]) return false;
  }
  return !requireDescriptorIdentity || (["dev", "ino", "parentDev", "parentIno"] as const).every((field) =>
    expected[field] === null || actual[field] === expected[field]);
}

function expectedProjectMapBeforeWitness(input: BackendPublicationFileMutationContext): BackendPublicationFileWitness {
  if (input.mutationAccess === "publish-project-map") return input.journal.sourceState.projectMap;
  if (input.mutationAccess === "restore-project-map") return input.journal.targetState.projectMap;
  throw new InvalidProjectMapError("invalid coordinator access for project-map publication: " + input.mutationAccess);
}

/** Apply exact authenticated project-map bytes from a coordinator permit. */
export async function applyBackendPublicationProjectMapFile(
  input: BackendPublicationFileMutationContext,
): Promise<BackendPublicationFileWitness> {
  assertBackendPublicationPermit(input.permit, input.homeDir, input.journal);
  return withProjectMapMutationLock(() => {
    const state = recoveryProjectMapContent(input);
    const path = projectMapPath(input.homeDir);
    const before = captureBackendPublicationState(input.homeDir).projectMap;
    if (!projectMapWitnessMatches(
      before,
      expectedProjectMapBeforeWitness(input),
      input.mutationAccess !== "restore-project-map",
    )) {
      throw new Error("project map changed before coordinator publication");
    }
    assertBackendPublicationProjectMapMutation(
      state.map,
      input.homeDir,
      state.content,
      input.permit,
    );
    if (state.content === null) {
      if (before.presence === "present") {
        consumeBoundedRegularFile(path, {
          allowedRoot: dirname(path),
          maxBytes: 4 * 1024 * 1024,
          expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
          allowedModes: OWNER_ONLY_FILE_MODES,
          requireSingleLink: true,
          expectedRawSha256: before.rawSha256,
        });
        syncPrivateDirectory(dirname(path));
      }
      cache = { path, mtimeMs: null, map: emptyMap(), metadataPopulated: false };
    } else {
      ensurePrivateDirectory(dirname(path));
      const recoveryFile = input.file as Extract<BackendPublicationRecoveryFile, { presence: "present" }>;
      // The authenticated witness is checked before admission; publication of
      // an existing map is still unconditional under the cooperating locks.
      atomicWritePrivateFileDurable(path, state.content, {
        requireAbsent: before.presence === "absent",
        maxExistingBytes: 4 * 1024 * 1024,
        finalMode: recoveryFile.mode,
      });
      syncPrivateDirectory(dirname(path));
      cache = {
        path,
        mtimeMs: statSync(path).mtimeMs,
        map: cloneMap(state.map),
        metadataPopulated: false,
      };
    }
    const after = captureBackendPublicationState(input.homeDir).projectMap;
    if (!projectMapWitnessMatches(after, input.expectedWitness, false)) {
      throw new Error("project map does not match authenticated coordinator witness after publication");
    }
    return after;
  }, input.homeDir, undefined, undefined, input.permit);
}

function loadProjectMap(opts: {
  strict?: boolean;
  reload?: boolean;
  homeDir?: string;
  _publicationLockToken?: BackendPublicationLockToken;
} = {}): ProjectMap {
  const path = projectMapPath(opts.homeDir);
  const file = readMapFile(path);
  if (!file) {
    if (opts._publicationLockToken !== undefined) {
      assertBackendPublicationProjectMapAccess({
        homeDir: opts.homeDir,
        content: null,
        map: emptyMap(),
        present: false,
        lockToken: opts._publicationLockToken,
      });
    }
    if (!opts.strict && cache?.path === path) {
      return cloneMap(cache.map);
    }
    const map = emptyMap();
    cache = { path, mtimeMs: null, map, metadataPopulated: false };
    return cloneMap(map);
  }

  if (!opts.reload && cache?.path === path && cache.mtimeMs === file.mtimeMs) {
    // A fresh cache is only consumable through the retained publication
    // admission token. Callers that do not have that token always request a
    // reload and therefore cannot reach this path.
    assertBackendPublicationProjectMapAccess({
      homeDir: opts.homeDir,
      content: file.content,
      map: cache.map,
      present: true,
      lockToken: opts._publicationLockToken!,
    });
    return cloneMap(cache.map);
  } else {
    let map: ProjectMap;
    try {
      map = parseProjectMap(file.content);
    } catch (err) {
      if (opts.strict || !cache || cache.path !== path) {
        throw err;
      }
      return cloneMap(cache.map);
    }
    if (opts._publicationLockToken !== undefined) {
      assertBackendPublicationProjectMapAccess({
        homeDir: opts.homeDir,
        content: file.content,
        map,
        present: true,
        lockToken: opts._publicationLockToken,
      });
    }
    cache = { path, mtimeMs: file.mtimeMs, map: cloneMap(map), metadataPopulated: false };
    return map;
  }
}

function loadProjectMapWithMetadata(opts: {
  strict?: boolean;
  reload?: boolean;
  homeDir?: string;
  /** @internal Return metadata backfill in memory without publishing it. */
  _suppressMetadataBackfill?: boolean;
  _beforeMetadataLockForTesting?: () => void;
  _beforeMetadataMutationLockForTesting?: () => void;
  _publicationLockToken?: BackendPublicationLockToken;
} = {}): ProjectMap {
  const path = projectMapPath(opts.homeDir);
  const map = loadProjectMap(opts);
  if (!opts.reload && cache?.path === path && cache.metadataPopulated) {
    return map;
  }

  const populated = populateFromExistingProjectMetadata(map, opts.homeDir);
  if (populated.changed) {
    if (opts._suppressMetadataBackfill) return populated.map;
    opts._beforeMetadataMutationLockForTesting?.();
    if (activeProjectMapMutationLocks.has(projectMapMutationLockPath(opts.homeDir))) {
      writeProjectMap(populated.map, opts.homeDir, { metadataPopulated: true });
      return populated.map;
    }
      return withProjectMapMutationLock(() => {
      const current = loadProjectMap({
        strict: true,
        reload: true,
        homeDir: opts.homeDir,
      });
      const locked = populateFromExistingProjectMetadata(current, opts.homeDir);
      if (locked.changed) {
        writeProjectMap(locked.map, opts.homeDir, { metadataPopulated: true });
      } else {
        cache = { ...cache!, map: cloneMap(current), metadataPopulated: true };
      }
      return locked.map;
      }, opts.homeDir, undefined, opts._publicationLockToken);
  }

  cache = { ...cache!, map: cloneMap(map), metadataPopulated: true };
  return map;
}

function collectPathOwners(map: ProjectMap): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [hash, entry] of Object.entries(map)) {
    for (const rawPath of [entry.canonical, ...entry.aliases]) {
      const path = resolve(rawPath);
      const set = owners.get(path) ?? new Set<string>();
      set.add(hash);
      owners.set(path, set);
    }
  }
  return owners;
}

function repairSameHashDuplicates(map: ProjectMap): { map: ProjectMap; changed: boolean; warnings: string[] } {
  const repaired = cloneMap(map);
  const warnings: string[] = [];
  let changed = false;

  for (const [hash, entry] of Object.entries(repaired)) {
    const canonical = resolve(entry.canonical);
    const seen = new Set<string>();
    const aliases: string[] = [];
    for (const alias of entry.aliases) {
      const normalized = resolve(alias);
      if (normalized === canonical) {
        changed = true;
        warnings.push(`${hash.slice(0, 8)} removed alias equal to canonical path: ${alias}`);
        continue;
      }
      if (seen.has(normalized)) {
        changed = true;
        warnings.push(`${hash.slice(0, 8)} removed duplicate alias: ${alias}`);
        continue;
      }
      seen.add(normalized);
      aliases.push(alias);
    }
    entry.aliases = aliases;
  }

  return { map: repaired, changed, warnings };
}

function findPathMatches(map: ProjectMap, path: string): Set<string> {
  const lexical = resolve(path);
  const aliasMatches = new Set<string>();
  const lexicalCanonicalMatches = new Set<string>();
  for (const [hash, entry] of Object.entries(map)) {
    if (entry.aliases.some((alias) => resolve(alias) === lexical)) aliasMatches.add(hash);
    if (resolve(entry.canonical) === lexical) lexicalCanonicalMatches.add(hash);
  }
  if (aliasMatches.size > 0) {
    // A manually edited map may assign the same lexical path as both an alias
    // and another hash's canonical path. Return every owner so the caller fails
    // closed instead of silently preferring either entry.
    for (const hash of lexicalCanonicalMatches) aliasMatches.add(hash);
    return aliasMatches;
  }

  const canonical = normalizeProjectPath(path);
  const canonicalMatches = new Set<string>();
  for (const [hash, entry] of Object.entries(map)) {
    if (resolve(entry.canonical) === canonical) canonicalMatches.add(hash);
  }
  return canonicalMatches;
}

function populateFromExistingProjectMetadata(map: ProjectMap, homeDir?: string): { map: ProjectMap; changed: boolean } {
  const next = cloneMap(map);
  let changed = false;
  const root = projectsDir(homeDir);
  if (!existsSync(root)) return { map: next, changed };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HASH_RE.test(entry.name)) continue;
    const metaPath = join(root, entry.name, "meta.json");
    if (!existsSync(metaPath) || next[entry.name]) continue;
    try {
      const meta = JSON.parse(readBoundedRegularFile(metaPath, {
        allowedRoot: join(root, entry.name),
        maxBytes: 1024 * 1024,
        expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
        requireSingleLink: true,
      })) as { cwd?: unknown };
      if (typeof meta.cwd !== "string" || meta.cwd.length === 0) continue;
      const canonical = normalizeProjectPath(meta.cwd);
      if (findPathMatches(next, canonical).size > 0) continue;
      next[entry.name] = { canonical, aliases: [] };
      changed = true;
    } catch {
      // Ignore corrupt project metadata; doctor handles project health separately.
    }
  }
  return { map: next, changed };
}

function existingProjectHasStoredData(hash: string): boolean {
  return existsSync(join(projectsDir(), hash, "db.sqlite"))
    || existsSync(join(lcmHomeDir(), "events", `${hash}.db`));
}

/** Reject a map key that no local evidence binds to its canonical path. */
export class UnauthenticatedProjectIdentityError extends Error {
  constructor(readonly id: string, readonly canonical: string) {
    super(`project map identity is not authenticated for its canonical path: ${canonical} (${id})`);
    this.name = "UnauthenticatedProjectIdentityError";
  }
}

/**
 * Decide whether one map key may act as the storage identity for its path.
 *
 * Three grounds admit a key, and their order matters. The canonical path hash
 * is the derivation every other code path reproduces. A renewal successor is
 * decided solely by its retained predecessor fence: once a key has the
 * successor shape, no other evidence may stand in for that fence, because a
 * renewed project writes its own project metadata the first time it is opened
 * and that metadata would otherwise re-admit a successor whose fence was lost.
 * Only keys matching neither of the first two grounds use metadata
 * corroboration.
 *
 * The metadata ground is compatibility, not a defence. A hash minted before
 * the current path normalization does not equal hashProjectPath(canonical),
 * and populateFromExistingProjectMetadata legitimately backfills the map from
 * such a directory, so refusing it would reject identities this repository
 * supports. It is not an independent trust anchor: anyone who can write
 * map.json can usually also write projects/<id>/meta.json. What it removes is
 * the case with no corroboration anywhere on disk, where the CLI adopted a key
 * the hook side would never derive.
 */
export function isAuthenticatedProjectIdentity(
  id: string,
  canonical: string,
  homeDir?: string,
): boolean {
  // Resolve symlinks before deriving anything. An entry reached through an
  // alias carries its canonical path verbatim, so a symlinked canonical would
  // otherwise authenticate the lexical path hash while the hook side derives
  // the real target's hash.
  //
  // Deliberately realpath only, not the Git anchor. A legacy entry keyed by a
  // linked worktree's own path hash is a supported shape that reconciliation
  // still has to migrate, and anchoring here would refuse it before the
  // legacy-storage path ever reports it.
  const normalized = normalizeProjectPath(canonical);
  const retiredId = hashProjectPath(normalized);
  if (id === retiredId) return true;
  if (isRetiredProjectIdentitySuccessor(id, retiredId, normalized)) {
    return isAuthenticatedRetiredProjectIdentitySuccessor(id, retiredId, normalized, homeDir);
  }
  return projectMetadataBindsCanonical(id, normalized, homeDir);
}

/**
 * Recognize a legacy identity corroborated by its own project metadata.
 *
 * The stored cwd must normalize to the same canonical path the entry claims,
 * read through the same bounded, single-link, owner-checked reader the map
 * backfill uses, so an unreadable or mismatched metadata file corroborates
 * nothing. This is same-UID corroboration rather than an independent trust
 * anchor; see isAuthenticatedProjectIdentity for what it does and does not
 * establish.
 */
function projectMetadataBindsCanonical(
  id: string,
  canonical: string,
  homeDir?: string,
): boolean {
  const dir = join(projectsDir(homeDir), id);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(readBoundedRegularFile(metaPath, {
      allowedRoot: dir,
      maxBytes: 1024 * 1024,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      requireSingleLink: true,
    })) as { cwd?: unknown };
    return typeof meta.cwd === "string"
      && meta.cwd.length > 0
      && normalizeProjectPath(meta.cwd) === canonical;
  } catch {
    return false;
  }
}

/**
 * Refuse a map key no derivation can produce, before it becomes an identity.
 *
 * A successor-shaped key deliberately passes here even when its predecessor
 * fence is missing or tampered: admission and reconciliation already refuse it
 * with the specific renewal diagnostic, and pre-empting them with a generic
 * message would lose that guidance. Enumeration uses the authenticated
 * predicate instead, so no surface presents a successor it cannot open.
 */
function assertDerivableProjectIdentity(id: string, canonical: string): void {
  const normalized = normalizeProjectPath(canonical);
  const pathHash = hashProjectPath(normalized);
  if (id === pathHash) return;
  if (isRetiredProjectIdentitySuccessor(id, pathHash, normalized)) return;
  if (projectMetadataBindsCanonical(id, normalized)) return;
  throw new UnauthenticatedProjectIdentityError(id, canonical);
}

function identityForMatches(
  map: ProjectMap,
  cwd: string,
  normalized: string,
): ProjectIdentity | null {
  const matches = findPathMatches(map, cwd);
  if (matches.size > 1) {
    throw new Error(`project path maps to multiple hashes: ${normalized} (${[...matches].join(", ")})`);
  }
  if (matches.size === 0) return null;
  const id = [...matches][0];
  const canonical = resolve(map[id].canonical);
  assertDerivableProjectIdentity(id, canonical);
  return {
    id,
    canonical,
    ...(map[id].remoteProjectId ? { remoteProjectId: map[id].remoteProjectId } : {}),
  };
}

function resolveProjectIdentityUnlocked(
  cwd: string,
  opts: {
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _beforeMissingEntryLockForTesting?: () => void;
    /** @internal Test-only synchronization seam for metadata backfill coverage. */
    readonly _beforeMetadataLockForTesting?: () => void;
    /** @internal Test-only synchronization seam for metadata lock races. */
    readonly _beforeMetadataMutationLockForTesting?: () => void;
    /** @internal Test-only synchronization seam for missing-entry races. */
    readonly _beforeMissingIdentityLockForTesting?: () => void;
    /** @internal Resolve against metadata backfill without publishing it. */
    readonly _suppressMetadataBackfill?: boolean;
  } = {},
  publicationLockToken?: BackendPublicationLockToken,
): ProjectIdentity {
  const map = loadProjectMapWithMetadata({
    _suppressMetadataBackfill: opts._suppressMetadataBackfill,
    _beforeMetadataLockForTesting: opts._beforeMetadataLockForTesting,
    _beforeMetadataMutationLockForTesting: opts._beforeMetadataMutationLockForTesting,
    _publicationLockToken: publicationLockToken,
  });
  const gitAnchor = resolveGitProjectAnchor(cwd);
  const lookupPath = gitAnchor?.canonical ?? cwd;
  const normalized = gitAnchor?.canonical ?? normalizeProjectPath(cwd);
  const existing = identityForMatches(map, lookupPath, normalized);
  if (existing) return existing;

  const createMissingIdentity = (): ProjectIdentity => {
    let current: ProjectMap;
    opts._beforeMissingIdentityLockForTesting?.();
    try {
      current = loadProjectMapWithMetadata({
        strict: true,
        reload: true,
        _suppressMetadataBackfill: opts._suppressMetadataBackfill,
        _publicationLockToken: publicationLockToken,
      });
    } catch (error) {
      if (error instanceof InvalidProjectMapError) {
        throw new Error(`refusing to overwrite invalid map.json: ${error.message}`);
      }
      throw error;
    }
    // Preserve a known-good in-memory snapshot when the file disappeared
    // between the optimistic read and the locked reload. A genuinely fresh
    // bootstrap has an empty snapshot and follows this same path.
    if (!existsSync(projectMapPath())) current = map;
    const raced = identityForMatches(current, lookupPath, normalized);
    if (raced) return raced;
    const id = hashProjectPath(normalized);
    current[id] ??= { canonical: normalized, aliases: [] };
    writeProjectMap(current, undefined, { metadataPopulated: true });
    return {
      id,
      canonical: resolve(current[id].canonical),
      ...(current[id].remoteProjectId ? { remoteProjectId: current[id].remoteProjectId } : {}),
    };
  };
  if (activeProjectMapMutationLocks.has(projectMapMutationLockPath())) {
    return createMissingIdentity();
  }
  return withProjectMapMutationLock(
    () => createMissingIdentity(),
    undefined,
    undefined,
    publicationLockToken,
  );
}

export function resolveProjectIdentity(
  cwd: string,
  opts: {
    readonly _beforeMissingEntryLockForTesting?: () => void;
    readonly _beforeMetadataLockForTesting?: () => void;
    readonly _beforeMetadataMutationLockForTesting?: () => void;
    readonly _beforeMissingIdentityLockForTesting?: () => void;
    /** @internal Token held by a caller that already has publication admission. */
    readonly _publicationLockToken?: BackendPublicationLockToken;
  } = {},
): ProjectIdentity {
  // These hooks model another process winning the race before this consumer
  // takes publication admission. Running them outside the retained lock also
  // prevents a test-only concurrent public call from being mistaken for a
  // reentrant capability.
  opts._beforeMetadataLockForTesting?.();
  opts._beforeMissingEntryLockForTesting?.();
  const resolveWithToken = (token: BackendPublicationLockToken): ProjectIdentity =>
    resolveProjectIdentityUnlocked(cwd, {
      ...opts,
      _beforeMetadataLockForTesting: undefined,
      _beforeMissingEntryLockForTesting: undefined,
    }, token);
  if (opts._publicationLockToken !== undefined) {
    return resolveWithToken(opts._publicationLockToken);
  }
  return withBackendPublicationConsumerLock(
    undefined,
    resolveWithToken,
  );
}

export function listProjectMapEntries(
  homeDir?: string,
  publicationLockToken?: BackendPublicationLockToken,
): ProjectMap {
  return withBackendPublicationConsumerLock(homeDir, (token) =>
    loadProjectMapWithMetadata({
      strict: true,
      reload: true,
      homeDir,
      _publicationLockToken: token,
    }), { lockToken: publicationLockToken });
}

/**
 * Return the same metadata-enriched view as listProjectMapEntries without
 * publishing metadata backfill, taking a mutation lock, or creating backups.
 */
export function readProjectMapSnapshot(
  homeDir?: string,
  publicationLockToken?: BackendPublicationLockToken,
): ProjectMap {
  return withBackendPublicationConsumerLock(homeDir, (token) => {
    const map = loadProjectMap({
      strict: true,
      reload: true,
      homeDir,
      _publicationLockToken: token,
    });
    return populateFromExistingProjectMetadata(map, homeDir).map;
  }, { lockToken: publicationLockToken });
}

/**
 * Resolve a project identity from already-persisted map or project metadata.
 *
 * Unlike resolveProjectIdentity, this function never creates or publishes a
 * project-map entry. It is used by recovery paths that may receive a cwd that
 * has disappeared since its last event was captured.
 */
export function resolveExistingProjectIdentity(
  cwd: string,
  publicationLockToken?: BackendPublicationLockToken,
): ProjectIdentity | null {
  const map = readProjectMapSnapshot(undefined, publicationLockToken);
  let gitAnchor: ReturnType<typeof resolveGitProjectAnchor> = null;
  try {
    gitAnchor = resolveGitProjectAnchor(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const lookupPath = gitAnchor?.canonical ?? cwd;
  const normalized = gitAnchor?.canonical ?? normalizeProjectPath(cwd);
  return identityForMatches(map, lookupPath, normalized);
}

function showProjectMapEntryUnlocked(
  target: string | undefined,
  publicationLockToken?: BackendPublicationLockToken,
): { hash: string; entry: ProjectMapEntry; transient?: boolean } {
  const map = loadProjectMapWithMetadata({
    strict: true,
    reload: true,
    _publicationLockToken: publicationLockToken,
  });
  const requestedPath = target ?? process.cwd();
  const targetPath = resolveGitProjectAnchor(requestedPath)?.canonical ?? requestedPath;
  if (!target) {
    const matches = findPathMatches(map, targetPath);
    if (matches.size > 1) throw new Error(`project path maps to multiple hashes: ${targetPath} (${[...matches].join(", ")})`);
    if (matches.size === 1) {
      const hash = [...matches][0];
      return { hash, entry: map[hash] };
    }
    const canonical = normalizeProjectPath(targetPath);
    return { hash: hashProjectPath(canonical), entry: { canonical, aliases: [] }, transient: true };
  }
  if (HASH_RE.test(target)) {
    const entry = map[target];
    if (!entry) throw new Error(`unknown project hash: ${target}`);
    return { hash: target, entry };
  }
  const remoteProjectId = normalizeUuidV7(target);
  if (remoteProjectId) {
    const matches = Object.entries(map).filter(
      ([, entry]) => entry.remoteProjectId === remoteProjectId,
    );
    if (matches.length === 0) throw new Error(`unknown remote project UUIDv7: ${remoteProjectId}`);
    if (matches.length > 1) {
      throw new Error(
        `remote project UUIDv7 maps to multiple local hashes: ${remoteProjectId} (${matches.map(([hash]) => hash).join(", ")})`,
      );
    }
    return { hash: matches[0][0], entry: matches[0][1] };
  }
  const matches = findPathMatches(map, targetPath);
  if (matches.size > 1) throw new Error(`project path maps to multiple hashes: ${targetPath} (${[...matches].join(", ")})`);
  if (matches.size === 1) {
    const hash = [...matches][0];
    return { hash, entry: map[hash] };
  }
  const canonical = normalizeProjectPath(targetPath);
  return { hash: hashProjectPath(canonical), entry: { canonical, aliases: [] }, transient: true };
}

export function showProjectMapEntry(
  target?: string,
  publicationLockToken?: BackendPublicationLockToken,
): { hash: string; entry: ProjectMapEntry; transient?: boolean } {
  return withBackendPublicationConsumerLock(undefined, (token) =>
    showProjectMapEntryUnlocked(target, token), { lockToken: publicationLockToken });
}

function resolveCliTarget(
  opts: { canonical?: string; hash?: string },
  publicationLockToken?: BackendPublicationLockToken,
  resolutionOpts: { readonly _suppressMetadataBackfill?: boolean } = {},
): { hash: string; entry: ProjectMapEntry; map: ProjectMap } {
  if (opts.canonical && opts.hash) {
    throw new Error("--canonical and --hash are mutually exclusive");
  }
  if (opts.canonical) {
    const canonical = normalizeProjectPath(opts.canonical);
    if (!existsSync(canonical)) throw new Error(`canonical path does not exist: ${canonical}`);
    if (!statSync(canonical).isDirectory()) throw new Error(`canonical path must be an existing directory: ${canonical}`);
    const identity = resolveProjectIdentityUnlocked(canonical, resolutionOpts, publicationLockToken);
    const map = loadProjectMapWithMetadata({
      strict: true,
      reload: true,
      _suppressMetadataBackfill: resolutionOpts._suppressMetadataBackfill,
      _publicationLockToken: publicationLockToken,
    });
    return { hash: identity.id, entry: map[identity.id], map };
  }
  const map = loadProjectMapWithMetadata({
    strict: true,
    reload: true,
    _suppressMetadataBackfill: resolutionOpts._suppressMetadataBackfill,
    _publicationLockToken: publicationLockToken,
  });
  if (opts.hash) {
    if (!HASH_RE.test(opts.hash)) throw new Error(`invalid project hash: ${opts.hash}`);
    const entry = map[opts.hash];
    if (!entry) throw new Error(`unknown project hash: ${opts.hash}`);
    return { hash: opts.hash, entry, map };
  }
  const identity = resolveProjectIdentityUnlocked(process.cwd(), resolutionOpts, publicationLockToken);
  const refreshed = loadProjectMapWithMetadata({
    strict: true,
    reload: true,
    _suppressMetadataBackfill: resolutionOpts._suppressMetadataBackfill,
    _publicationLockToken: publicationLockToken,
  });
  return { hash: identity.id, entry: refreshed[identity.id], map: refreshed };
}

export function projectMapPathsForHash(
  hash: string,
  publicationLockToken?: BackendPublicationLockToken,
): string[] {
  return withBackendPublicationConsumerLock(undefined, (token) => {
    const map = loadProjectMapWithMetadata({ _publicationLockToken: token });
    const entry = map[hash];
    if (!entry) return [];
    return [...new Set([entry.canonical, ...entry.aliases].map((path) => resolve(path)))];
  }, { lockToken: publicationLockToken });
}

export function isProjectHash(value: string): boolean {
  return HASH_RE.test(value);
}

export function projectMapEntryHasStoredData(hash: string): boolean {
  return withBackendPublicationConsumerLock(undefined, () => existingProjectHasStoredData(hash));
}

/**
 * Atomically replace worktree-scoped entries with a single canonical local
 * project. Callers must finish and verify all state migration before invoking
 * this function: map publication is the reconciliation commit point.
 */
export function foldProjectMapEntries(opts: {
  readonly targetHash: string;
  readonly canonical: string;
  readonly sourceHashes: readonly string[];
  readonly aliases: readonly string[];
  readonly expectedRemoteProjectId?: string | null;
  readonly homeDir?: string;
  readonly onBackupCreated?: (path: string) => void;
  readonly onMapPublished?: () => void;
}): { entry: ProjectMapEntry; backupPath?: string } {
  if (!HASH_RE.test(opts.targetHash)) {
    throw new Error(`invalid reconciliation target hash: ${opts.targetHash}`);
  }
  return withProjectMapMutationLock(
    (publicationLockToken) => foldProjectMapEntriesLocked({
      ...opts,
      _publicationLockToken: publicationLockToken,
    }),
    opts.homeDir,
  );
}

/** Fold entries while the caller holds withProjectMapReconciliationLock. */
export function foldProjectMapEntriesLocked(opts: {
  readonly targetHash: string;
  readonly canonical: string;
  readonly sourceHashes: readonly string[];
  readonly aliases: readonly string[];
  readonly expectedRemoteProjectId?: string | null;
  readonly homeDir?: string;
  readonly onBackupCreated?: (path: string) => void;
  readonly onMapPublished?: () => void;
  readonly _publicationLockToken?: BackendPublicationLockToken;
}): { entry: ProjectMapEntry; backupPath?: string } {
  if (!activeProjectMapMutationLocks.has(projectMapMutationLockPath(opts.homeDir))) {
    throw new Error("project map reconciliation lock is not held");
  }
  const map = loadProjectMapWithMetadata({
    strict: true,
    reload: true,
    homeDir: opts.homeDir,
    _publicationLockToken: opts._publicationLockToken,
  });
  const sourceHashes = [...new Set([
    ...(map[opts.targetHash] ? [opts.targetHash] : []),
    ...opts.sourceHashes,
  ])];
  const entries = sourceHashes.map((hash) => {
    const entry = map[hash];
    if (!entry) throw new Error(`project reconciliation source disappeared: ${hash}`);
    return [hash, entry] as const;
  });
  const remoteBindings = new Set(
    entries.flatMap(([, entry]) => entry.remoteProjectId ? [entry.remoteProjectId] : []),
  );
  if (remoteBindings.size > 1) {
    throw new Error(
      `conflicting PostgreSQL project bindings block worktree reconciliation: ${[...remoteBindings].join(", ")}`,
    );
  }
  const remoteProjectId = [...remoteBindings][0];
  if (
    opts.expectedRemoteProjectId !== undefined
    && remoteProjectId !== (opts.expectedRemoteProjectId ?? undefined)
  ) {
    throw new Error("PostgreSQL project binding changed during worktree reconciliation");
  }

  const canonical = resolve(opts.canonical);
  const paths = new Set<string>([
    ...opts.aliases.map((path) => resolve(path)),
    ...entries.flatMap(([, entry]) => [
      resolve(entry.canonical),
      ...entry.aliases.map((path) => resolve(path)),
    ]),
  ]);
  paths.delete(canonical);
  for (const [hash] of entries) delete map[hash];
  map[opts.targetHash] = {
    canonical,
    aliases: [...paths].sort(),
    ...(remoteProjectId ? { remoteProjectId } : {}),
  };
  const write = writeProjectMap(map, opts.homeDir, {
    metadataPopulated: true,
    onBackupCreated: opts.onBackupCreated,
    onMapPublished: opts.onMapPublished,
  });
  return { entry: map[opts.targetHash], backupPath: write.backupPath };
}

export function setRemoteProjectBinding(
  remoteProjectId: string,
  opts: {
    readonly canonical?: string;
    readonly hash?: string;
    readonly alias?: string;
    readonly allowExistingData?: boolean;
    readonly expectedEntry?: ProjectMapEntry;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _afterLockForTesting?: () => void;
    /** @internal Test-only failure injection for lock protocol boundaries. */
    readonly _lockObserverForTesting?: ProjectMapLockObserver;
  } = {},
): {
  readonly hash: string;
  readonly entry: ProjectMapEntry;
  readonly changed: boolean;
  readonly backupPath?: string;
} {
  const normalizedRemoteProjectId = normalizeUuidV7(remoteProjectId);
  if (!normalizedRemoteProjectId) {
    throw new Error(`invalid remote project UUIDv7: ${remoteProjectId}`);
  }
  return withProjectMapMutationLock((publicationLockToken) => {
    opts._afterLockForTesting?.();
    const target = resolveCliTarget(
      { canonical: opts.canonical, hash: opts.hash },
      publicationLockToken,
    );
    assertExpectedProjectMapEntry(target.hash, target.entry, opts.expectedEntry);
    let aliasChanged = false;
    if (opts.alias !== undefined) {
      const alias = resolve(opts.alias);
      if (!existsSync(alias)) throw new Error(`alias path does not exist: ${alias}`);
      if (!statSync(alias).isDirectory()) {
        throw new Error(`alias path must be an existing directory: ${alias}`);
      }
      const owners = collectPathOwners(target.map).get(alias) ?? new Set<string>();
      const foreignOwners = [...owners].filter((owner) => owner !== target.hash);
      if (foreignOwners.length > 0) {
        throw new Error(
          `alias is already mapped to another hash: ${alias} (${foreignOwners.join(", ")})`,
        );
      }
      if (
        resolve(target.entry.canonical) !== alias
        && !target.entry.aliases.some((candidate) => resolve(candidate) === alias)
      ) {
        target.map[target.hash].aliases.push(alias);
        aliasChanged = true;
      }
    }
    const current = target.entry.remoteProjectId;
    if (current === normalizedRemoteProjectId && !aliasChanged) {
      return { hash: target.hash, entry: target.entry, changed: false };
    }
    if (
      current !== undefined
      && existingProjectHasStoredData(target.hash)
      && !opts.allowExistingData
    ) {
      throw new Error(
        `project ${target.hash} already has local data; rerun with --allow-existing-data to rebind it explicitly`,
      );
    }
    target.map[target.hash].remoteProjectId = normalizedRemoteProjectId;
    const write = writeProjectMap(target.map);
    return {
      hash: target.hash,
      entry: target.map[target.hash],
      changed: true,
      backupPath: write.backupPath,
    };
  }, undefined, opts._lockObserverForTesting);
}

export function clearRemoteProjectBinding(
  target: string | undefined,
  expectedRemoteProjectId: string,
  opts: {
    readonly expectedEntry?: ProjectMapEntry;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _afterLockForTesting?: () => void;
  } = {},
): {
  readonly hash: string;
  readonly entry: ProjectMapEntry;
  readonly remoteProjectId?: string;
  readonly changed: boolean;
  readonly backupPath?: string;
} {
  const normalizedExpectedRemoteProjectId = normalizeUuidV7(expectedRemoteProjectId);
  if (!normalizedExpectedRemoteProjectId) {
    throw new Error(`invalid expected remote project UUIDv7: ${expectedRemoteProjectId}`);
  }
  return withProjectMapMutationLock((publicationLockToken) => {
    opts._afterLockForTesting?.();
    const shown = showProjectMapEntry(target, publicationLockToken);
    if (shown.transient) {
      throw new Error(`project is not mapped: ${target ?? process.cwd()}`);
    }
    const map = listProjectMapEntries(undefined, publicationLockToken);
    // The lock makes the non-transient result and this same cached map one
    // synchronous mutation snapshot.
    const entry = map[shown.hash]!;
    assertExpectedProjectMapEntry(shown.hash, entry, opts.expectedEntry);
    if (entry.remoteProjectId !== normalizedExpectedRemoteProjectId) {
      throw new Error(
        `project ${shown.hash} remote binding changed; expected ${expectedRemoteProjectId}`,
      );
    }
    delete entry.remoteProjectId;
    const write = writeProjectMap(map);
    return {
      hash: shown.hash,
      entry,
      remoteProjectId: normalizedExpectedRemoteProjectId,
      changed: true,
      backupPath: write.backupPath,
    };
  });
}

export function addProjectAlias(alias: string, opts: {
  canonical?: string;
  hash?: string;
  expectedEntry?: ProjectMapEntry;
  _afterLockForTesting?: () => void;
} = {}): { hash: string; entry: ProjectMapEntry; warning?: string; backupPath?: string } {
  const normalizedAlias = resolve(alias);
  if (!existsSync(normalizedAlias)) throw new Error(`alias path does not exist: ${normalizedAlias}`);
  if (!statSync(normalizedAlias).isDirectory()) throw new Error(`alias path must be an existing directory: ${normalizedAlias}`);
  return withProjectMapMutationLock((publicationLockToken) => {
    opts._afterLockForTesting?.();
    const target = resolveCliTarget(opts, publicationLockToken, {
      _suppressMetadataBackfill: true,
    });
    assertExpectedProjectMapEntry(target.hash, target.entry, opts.expectedEntry);
    const canonical = resolve(target.entry.canonical);
    // Refuse before any mutation. Resolution keeps metadata backfill in memory
    // until this gate authenticates the target, so a refused link leaves the
    // persisted map byte-identical.
    if (!isAuthenticatedProjectIdentity(target.hash, canonical)) {
      throw new UnauthenticatedProjectIdentityError(target.hash, canonical);
    }
    if (normalizedAlias === canonical) {
      throw new Error(`alias matches canonical path for ${target.hash}: ${normalizedAlias}`);
    }

    const owners = collectPathOwners(target.map);
    const existingOwners = owners.get(normalizedAlias) ?? new Set<string>();
    if (existingOwners.has(target.hash)) {
      throw new Error(`alias is already mapped to ${target.hash}: ${normalizedAlias}`);
    }
    if (existingOwners.size > 0) {
      const canonicalAlias = normalizeProjectPath(normalizedAlias);
      const adoptableOwners = [...existingOwners].filter((ownerHash) => {
        const entry = target.map[ownerHash];
        return entry
          && ownerHash === hashProjectPath(canonicalAlias)
          && normalizeProjectPath(entry.canonical) === canonicalAlias
          && entry.aliases.length === 0
          && entry.remoteProjectId === undefined;
      });
      if (existingOwners.size === 1 && adoptableOwners.length === 1) {
        if (existingProjectHasStoredData(adoptableOwners[0])) {
          throw new Error(`alias is already a project with stored data: ${normalizedAlias} (${adoptableOwners[0]})`);
        }
        delete target.map[adoptableOwners[0]];
      } else {
        throw new Error(`alias is already mapped to another hash: ${normalizedAlias} (${[...existingOwners].join(", ")})`);
      }
    }

    target.map[target.hash].aliases.push(normalizedAlias);
    const write = writeProjectMap(target.map);
    return { hash: target.hash, entry: target.map[target.hash], backupPath: write.backupPath };
  });
}

export function removeProjectAlias(alias: string, opts: {
  canonical?: string;
  hash?: string;
  expectedEntry?: ProjectMapEntry;
  _afterLockForTesting?: () => void;
} = {}): { hash: string; entry: ProjectMapEntry; removed: boolean; backupPath?: string } {
  const normalizedAlias = resolve(alias);
  return withProjectMapMutationLock((publicationLockToken) => {
    opts._afterLockForTesting?.();
    const map = loadProjectMap({
      strict: true,
      reload: true,
      _publicationLockToken: publicationLockToken,
    });
    let hash: string;

  if (opts.canonical && opts.hash) {
    throw new Error("--canonical and --hash are mutually exclusive");
  }

  if (opts.canonical) {
    const canonical = normalizeProjectPath(opts.canonical);
    if (!existsSync(canonical)) throw new Error(`canonical path does not exist: ${canonical}`);
    if (!statSync(canonical).isDirectory()) throw new Error(`canonical path must be an existing directory: ${canonical}`);
    const owners = Object.entries(map)
      .filter(([, entry]) => resolve(entry.canonical) === canonical)
      .map(([ownerHash]) => ownerHash);
    if (owners.length === 0) throw new Error(`unknown canonical project path: ${canonical}`);
    if (owners.length > 1) throw new Error(`canonical path maps to multiple hashes: ${canonical} (${owners.join(", ")})`);
    hash = owners[0];
  } else if (opts.hash) {
    if (!HASH_RE.test(opts.hash)) throw new Error(`invalid project hash: ${opts.hash}`);
    if (!map[opts.hash]) throw new Error(`unknown project hash: ${opts.hash}`);
    hash = opts.hash;
  } else {
    const owners = Object.entries(map)
      .filter(([, entry]) => entry.aliases.map((candidate) => resolve(candidate)).includes(normalizedAlias))
      .map(([ownerHash]) => ownerHash);
    if (owners.length === 0) throw new Error(`alias is not mapped: ${normalizedAlias}`);
    if (owners.length > 1) throw new Error(`alias maps to multiple hashes: ${normalizedAlias} (${owners.join(", ")})`);
    hash = owners[0];
  }

    const entry = map[hash];
    assertExpectedProjectMapEntry(hash, entry, opts.expectedEntry);
    const before = entry.aliases.length;
    entry.aliases = entry.aliases.filter((candidate) => resolve(candidate) !== normalizedAlias);
    const removed = entry.aliases.length !== before;
    const write: { backupPath?: string } = removed ? writeProjectMap(map) : {};
    return { hash, entry, removed, backupPath: write.backupPath };
  });
}

function validateProjectMapUnlocked(opts: { homeDir?: string; fix?: boolean }): ProjectMapValidation {
  const path = projectMapPath(opts.homeDir);
  const file = readMapFile(path);
  if (!file) {
    return { ok: true, map: emptyMap(), path, errors: [], warnings: ["map.json does not exist yet"], fixApplied: false };
  }

  let parsed: ProjectMap;
  try {
    parsed = parseProjectMap(file.content);
  } catch (err) {
    return {
      ok: false,
      map: null,
      path,
      errors: [(err as Error).message],
      warnings: [],
      fixApplied: false,
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const owners = collectPathOwners(parsed);
  for (const [mappedPath, hashes] of owners.entries()) {
    if (hashes.size > 1) {
      errors.push(`path maps to multiple hashes: ${mappedPath} (${[...hashes].join(", ")})`);
    }
  }

  const repaired = repairSameHashDuplicates(parsed);
  warnings.push(...repaired.warnings);
  const desiredMap = opts.fix && repaired.changed && errors.length === 0 ? repaired.map : parsed;
  const needsFormat = file.content !== prettyMap(desiredMap);
  let backupPath: string | undefined;
  let fixApplied = false;

  if (opts.fix && errors.length === 0 && (repaired.changed || needsFormat)) {
    const write = writeProjectMap(desiredMap, opts.homeDir);
    backupPath = write.backupPath;
    fixApplied = true;
  }

  return {
    ok: errors.length === 0,
    map: desiredMap,
    path,
    errors,
    warnings,
    fixApplied,
    backupPath,
  };
}

export function validateProjectMap(opts: { homeDir?: string; fix?: boolean } = {}): ProjectMapValidation {
  return withBackendPublicationConsumerLock(opts.homeDir, (token) => {
    const result = opts.fix
      ? withProjectMapMutationLock(
        () => validateProjectMapUnlocked(opts),
        opts.homeDir,
        undefined,
        token,
      )
      : validateProjectMapUnlocked(opts);
    const file = readMapFile(projectMapPath(opts.homeDir));
    assertBackendPublicationProjectMapAccess({
      homeDir: opts.homeDir,
      content: file?.content ?? null,
      map: result.map ?? emptyMap(),
      present: file !== null,
      lockToken: token,
    });
    return result;
  });
}

function reloadProjectMapCacheUnlocked(
  opts: { reformat?: boolean },
  publicationLockToken: BackendPublicationLockToken,
): boolean {
  const path = projectMapPath();
  const file = readMapFile(path);
  if (!file) {
    assertBackendPublicationProjectMapAccess({
      content: null,
      map: emptyMap(),
      present: false,
      lockToken: publicationLockToken,
    });
    if (cache?.path === path) {
      return true;
    }
    cache = { path, mtimeMs: null, map: emptyMap(), metadataPopulated: false };
    return true;
  }
  let map: ProjectMap;
  try {
    map = parseProjectMap(file.content);
  } catch {
    return false;
  }
  assertBackendPublicationProjectMapAccess({
    content: file.content,
    map,
    present: true,
    lockToken: publicationLockToken,
  });
  cache = { path, mtimeMs: file.mtimeMs, map: cloneMap(map), metadataPopulated: false };
  if (opts.reformat && file.content !== prettyMap(map)) {
    writeProjectMap(map);
  }
  return true;
}

export function reloadProjectMapCache(opts: { reformat?: boolean } = {}): boolean {
  return withBackendPublicationConsumerLock(undefined, (token) =>
    opts.reformat
      ? withProjectMapMutationLock(
        () => reloadProjectMapCacheUnlocked(opts, token),
        undefined,
        undefined,
        token,
      )
      : reloadProjectMapCacheUnlocked(opts, token));
}

export function watchProjectMap(): { close: () => void } {
  const path = projectMapPath();
  let closed = false;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeWatchPath: string | undefined;
  let arm: () => void;

  const scheduleReload = (watchPath: string | undefined) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        reloadProjectMapCache({ reformat: true });
      } catch (error) {
        if (error instanceof PrivateMutationLockContentionError) {
          scheduleReload(watchPath);
        } else if (error instanceof BackendPublicationJournalError) {
          closed = true;
          watcher?.close();
          throw error;
        } else {
          // A malformed/temporarily unavailable map is handled by the next
          // ordinary reload. Publication errors and live-writer contention
          // remain fail-closed above.
        }
      }
      try {
        const shouldRearm = withBackendPublicationConsumerLock(undefined, () =>
          !existsSync(path) || watchPath === path);
        if (shouldRearm) arm();
      } catch (error) {
        if (error instanceof PrivateMutationLockContentionError) {
          scheduleReload(watchPath);
          return;
        }
        if (error instanceof BackendPublicationJournalError) {
          closed = true;
          watcher?.close();
        }
        throw error;
      }
    }, 25);
  };

  arm = () => {
    try {
      withBackendPublicationConsumerLock(undefined, () => {
        watcher?.close();
        const watchPath = existsSync(path) ? path : dirname(path);
        activeWatchPath = watchPath;
        watcher = watch(watchPath, (_event, filename) => {
          if (watchPath !== path && filename && filename.toString() !== "map.json") return;
          scheduleReload(watchPath);
        });
        watcher.unref();
      });
    } catch (error) {
      if (error instanceof BackendPublicationJournalError) {
        closed = true;
        watcher?.close();
        throw error;
      }
      // Watch support varies by filesystem; map resolution still reloads by mtime.
    }
  };

  let startupContended = false;
  try {
    reloadProjectMapCache({ reformat: true });
  } catch (error) {
    if (!(error instanceof PrivateMutationLockContentionError)) throw error;
    startupContended = true;
  }
  arm();
  if (startupContended) scheduleReload(activeWatchPath);

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
