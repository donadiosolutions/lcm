import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
/** Exact modes that keep a regular file readable by its owner only. */
export const OWNER_ONLY_FILE_MODES: readonly number[] = Object.freeze([
  0o400,
  0o500,
  0o600,
  0o700,
]);

export function isOwnerOnlyFileMode(mode: number): boolean {
  return Number.isSafeInteger(mode) && OWNER_ONLY_FILE_MODES.includes(mode);
}

/** Exact identity/security evidence for a retained private directory descriptor. */
export type PrivateDirectoryWitness = Readonly<{
  mode: number;
  uid: number;
  gid: number;
  nlink: string;
  dev: string;
  ino: string;
}>;

export type PrivateDirectoryHandle = Readonly<{
  fd: number;
  witness: PrivateDirectoryWitness;
  close: () => void;
}>;

/** A retained private-directory path no longer names its authenticated inode. */
export class PrivateDirectoryTopologyError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PrivateDirectoryTopologyError";
  }
}

/** A create-if-absent private publication found an existing destination. */
export class PrivateFileCollisionError extends PrivateDirectoryTopologyError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PrivateFileCollisionError";
  }
}

export type PrivateFilePublicationOutcome = "published" | "unknown";

/** A publication attempt and retained-parent topology check could not agree. */
export class PrivateFilePublicationTopologyError extends PrivateDirectoryTopologyError {
  readonly outcome: PrivateFilePublicationOutcome;
  readonly topologyError: PrivateDirectoryTopologyError;

  constructor(
    outcome: PrivateFilePublicationOutcome,
    topologyError: PrivateDirectoryTopologyError,
    cause: unknown,
    operation: "rename" | "link" = "rename",
  ) {
    super(
      outcome === "published"
        ? operation === "rename"
          ? "private file rename completed, but retained parent topology is not trusted"
          : "private file link completed, but published file topology is not trusted"
        : `private file publication outcome is unknown because ${operation} and retained parent topology checks failed`,
      { cause },
    );
    this.outcome = outcome;
    this.topologyError = topologyError;
  }
}

type BigIntDirectoryStat = Readonly<{
  isDirectory: () => boolean;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  dev: bigint;
  ino: bigint;
}>;

function directoryStat(fd: number): BigIntDirectoryStat {
  return fstatSync(fd, { bigint: true }) as unknown as BigIntDirectoryStat;
}

function privateDirectoryWitness(stat: BigIntDirectoryStat): PrivateDirectoryWitness {
  return {
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    nlink: stat.nlink.toString(10),
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
  };
}

function assertPrivateDirectoryStat(
  stat: BigIntDirectoryStat,
  expectedUid: number | undefined,
): void {
  if (!stat.isDirectory()) throw new Error("path is not a directory");
  const mode = Number(stat.mode & 0o7777n);
  if (mode !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("private directory mode is not trusted");
  }
  if (
    expectedUid !== undefined
    && (!Number.isSafeInteger(expectedUid) || Number(stat.uid) !== expectedUid)
  ) {
    throw new Error("private directory owner is not trusted");
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

type PrivateDirectoryOpenOptions = Readonly<{
  expectedUid?: number;
}>;

type PrivateDirectoryAuthenticationOptions = PrivateDirectoryOpenOptions & Readonly<{
  /** @internal Creation-only path that authenticates type/owner before fchmod. */
  allowUntrustedMode?: boolean;
}>;

const PRIVATE_DIRECTORY_OPEN_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK;

function openPrivateDirectoryDescriptor(path: string): number {
  return openSync(path, PRIVATE_DIRECTORY_OPEN_FLAGS);
}

function authenticateOpenPrivateDirectory(
  path: string,
  fd: number,
  options: PrivateDirectoryAuthenticationOptions,
): PrivateDirectoryHandle {
  let closed = false;
  try {
    const stat = directoryStat(fd);
    const expectedUid = options.expectedUid ?? currentUid();
    if (options.allowUntrustedMode) {
      if (!stat.isDirectory()) throw new Error("path is not a directory");
      if (
        expectedUid !== undefined
        && (!Number.isSafeInteger(expectedUid) || Number(stat.uid) !== expectedUid)
      ) {
        throw new Error("private directory owner is not trusted");
      }
    } else {
      assertPrivateDirectoryStat(stat, expectedUid);
    }
    const canonicalPath = realpathSync(path);
    const pathStat = statSync(canonicalPath, { bigint: true }) as unknown as BigIntDirectoryStat;
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error("private directory changed during validation");
    }
    const witness = privateDirectoryWitness(stat);
    return {
      fd,
      witness,
      close: () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  } catch (authenticationError) {
    try {
      closeSync(fd);
    } catch (cleanupError) {
      throw new AggregateError(
        [authenticationError, cleanupError],
        "private directory authentication and cleanup failed",
        { cause: authenticationError },
      );
    }
    throw authenticationError;
  }
}

/**
 * Open and retain a private directory without following a symlink at the
 * final component.  The descriptor is checked before the pathname is used
 * again, and the pathname is required to still identify that same inode.
 */
export function openPrivateDirectory(
  path: string,
  options: PrivateDirectoryOpenOptions = {},
): PrivateDirectoryHandle {
  return authenticateOpenPrivateDirectory(path, openPrivateDirectoryDescriptor(path), options);
}

/**
 * Open a directory created by the caller before mode tightening.  This is
 * deliberately separate from openPrivateDirectory so existing callers never
 * relax the exact-0700 authentication policy.
 */
export function openPrivateDirectoryForCreation(
  path: string,
  options: PrivateDirectoryOpenOptions = {},
): PrivateDirectoryHandle {
  return authenticateOpenPrivateDirectory(path, openPrivateDirectoryDescriptor(path), {
    ...options,
    allowUntrustedMode: true,
  });
}

/**
 * Open an optional private directory while distinguishing initial absence
 * from interruption after its descriptor has been acquired.
 */
export function openPrivateDirectoryIfExists(
  path: string,
  options: PrivateDirectoryOpenOptions = {},
): PrivateDirectoryHandle | undefined {
  let fd: number;
  try {
    fd = openPrivateDirectoryDescriptor(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return authenticateOpenPrivateDirectory(path, fd, options);
}

/** Revalidate a retained private directory descriptor and its pathname. */
export function assertPrivateDirectory(
  handle: PrivateDirectoryHandle,
  path: string,
  expected?: PrivateDirectoryWitness,
  expectedUid: number | undefined = currentUid(),
): PrivateDirectoryWitness {
  const stat = directoryStat(handle.fd);
  assertPrivateDirectoryStat(stat, expectedUid);
  const canonicalPath = realpathSync(path);
  const pathStat = statSync(canonicalPath, { bigint: true }) as unknown as BigIntDirectoryStat;
  if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
    throw new Error("private directory changed during validation");
  }
  const actual = privateDirectoryWitness(stat);
  if (expected !== undefined && JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("private directory witness changed");
  }
  return actual;
}

/**
 * Authenticate the exact directory entry without following its final path
 * component, against a descriptor retained by the caller.
 */
export function assertPrivateDirectoryEntry(
  handle: PrivateDirectoryHandle,
  path: string,
  expectedUid: number | undefined = currentUid(),
): PrivateDirectoryWitness {
  try {
    const stat = directoryStat(handle.fd);
    assertPrivateDirectoryStat(stat, expectedUid);
    const entry = lstatSync(path, { bigint: true }) as unknown as BigIntDirectoryStat;
    if (!entry.isDirectory()) throw new Error("private directory entry is not a directory");
    if (Number(entry.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error("private directory entry mode is not trusted");
    }
    if (entry.uid !== stat.uid) {
      throw new Error("private directory entry owner is not trusted");
    }
    if (entry.dev !== stat.dev || entry.ino !== stat.ino) {
      throw new Error("private directory entry changed during validation");
    }
    return privateDirectoryWitness(stat);
  } catch (error) {
    throw new PrivateDirectoryTopologyError("private directory topology is not trusted", { cause: error });
  }
}

/** Flush a private directory through a descriptor with strict open flags. */
export function syncPrivateDirectory(
  path: string,
  options: { readonly expectedUid?: number } = {},
): void {
  const expectedUid = options.expectedUid ?? currentUid();
  const handle = openPrivateDirectory(path, { expectedUid });
  try {
    assertPrivateDirectory(handle, path, handle.witness, expectedUid);
    fsyncSync(handle.fd);
  } finally {
    handle.close();
  }
}

export type PrivateDirectoryOperations = Readonly<{
  mkdir?: (path: string, options: { recursive: boolean; mode: number }) => void;
  chmod?: (path: string, mode: number) => void;
}>;

export function ensurePrivateDirectory(
  path: string,
  operations: PrivateDirectoryOperations = {},
): void {
  (operations.mkdir ?? mkdirSync)(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  (operations.chmod ?? chmodSync)(path, PRIVATE_DIRECTORY_MODE);
}

function isContainedPath(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

export type BoundedFileOptions = {
  allowedRoot: string;
  maxBytes: number;
  /** Require the descriptor to be owned by this UID when provided. */
  expectedUid?: number;
  /** Require one of these exact permission/special-bit modes when provided. */
  allowedModes?: readonly number[];
  /** Reject files with more than one hard link when enabled. */
  requireSingleLink?: boolean;
  /** Require the bytes read from the retained descriptor to match exactly. */
  expectedRawSha256?: string;
  /** @internal Deterministic race seam for descriptor-bound tests. */
  _afterStatForTesting?: () => void;
  /** @internal Deterministic content-change seam before the bounded read. */
  _beforeReadForTesting?: () => void;
  /** @internal Deterministic post-path-stat race seam. */
  _beforePostStatForTesting?: () => void;
  /** @internal Deterministic parent-swap seam for descriptor-bound tests. */
  _beforeOpenForTesting?: () => void;
  /** @internal Deterministic leaf-swap seam before consume unlink. */
  _beforeUnlinkForTesting?: () => void;
};

export type BoundedFileResult = {
  content: string;
  mtimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: string;
  parentDev: string;
  parentIno: string;
  exactDev: string;
  exactIno: string;
};

function readDescriptorBoundedBytes(
  fd: number,
  maxBytes: number,
  position: number | null = null,
): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const bytesRead = readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, remaining),
      position === null ? null : position + total,
    );
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error("file exceeds the configured size limit");
  return Buffer.concat(chunks, total);
}

function readDescriptorBounded(fd: number, maxBytes: number): string {
  return readDescriptorBoundedBytes(fd, maxBytes).toString("utf-8");
}

function validateBoundedFileMetadata(
  stat: Stats,
  options: BoundedFileOptions,
): void {
  if (!stat.isFile()) throw new Error("path is not a regular file");
  if (options.requireSingleLink && stat.nlink !== 1) {
    throw new Error("file has multiple hard links");
  }
  if (options.expectedUid !== undefined && stat.uid !== options.expectedUid) {
    throw new Error("file owner is not trusted");
  }
  if (options.allowedModes !== undefined && !options.allowedModes.includes(stat.mode & 0o7777)) {
    throw new Error("file mode is not trusted");
  }
}

function boundedFileMetadataChanged(before: Stats, after: Stats): boolean {
  return before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.nlink !== after.nlink
    || before.uid !== after.uid
    || (before.mode & 0o7777) !== (after.mode & 0o7777)
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs;
}

type PrivatePathIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type PrivateFileIdentity = PrivatePathIdentity & Readonly<{
  parentDev: bigint;
  parentIno: bigint;
}>;

type BigIntFileStat = PrivatePathIdentity & Readonly<{
  isFile: () => boolean;
  nlink: bigint;
}>;

type BigIntBoundedFileStat = PrivatePathIdentity & Readonly<{
  isFile: () => boolean;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
}>;

function privatePathIdentity(path: string): PrivatePathIdentity {
  return lstatSync(path, { bigint: true }) as unknown as PrivatePathIdentity;
}

function privateFileIdentity(
  stat: PrivatePathIdentity,
  parent: PrivatePathIdentity,
): PrivateFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    parentDev: parent.dev,
    parentIno: parent.ino,
  };
}

/**
 * Remove a cleanup path only while it still names the inode retained by the
 * caller.  A replacement is left untouched: cleanup cannot turn an attacker
 * controlled pathname into an unrelated deletion target.
 */
function unlinkPrivateFileIfIdentityMatches(
  path: string,
  expected: PrivateFileIdentity,
  unlink: (path: string) => void = unlinkSync,
  lstat: (path: string) => BigIntFileStat = (candidate) => lstatSync(candidate, { bigint: true }) as unknown as BigIntFileStat,
  expectedNlink?: bigint,
): boolean {
  let currentParent: PrivatePathIdentity;
  try {
    currentParent = privatePathIdentity(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (currentParent.dev !== expected.parentDev || currentParent.ino !== expected.parentIno) return false;
  let current: BigIntFileStat;
  try {
    current = lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !current.isFile()
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (expectedNlink !== undefined && current.nlink !== expectedNlink)
  ) return false;
  unlink(path);
  return true;
}

function privateFilePublicationCleanupFailure(
  primaryError: unknown,
  cleanupError: unknown,
): unknown {
  const aggregate = new AggregateError(
    [primaryError, cleanupError],
    "private file publication and temporary cleanup failed",
    { cause: primaryError },
  );
  if (primaryError instanceof PrivateFilePublicationTopologyError) {
    return new PrivateFilePublicationTopologyError(
      primaryError.outcome,
      primaryError.topologyError,
      aggregate,
    );
  }
  if (primaryError instanceof PrivateDirectoryTopologyError) {
    return new PrivateDirectoryTopologyError(primaryError.message, { cause: aggregate });
  }
  return aggregate;
}

function assertPrivateTemporaryFileIdentity(
  path: string,
  expected: PrivateFileIdentity,
): void {
  try {
    const current = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
    if (
      !current.isFile()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
    ) {
      throw new Error("private temporary file changed during validation");
    }
  } catch (error) {
    throw new PrivateDirectoryTopologyError(
      "private temporary file topology is not trusted",
      { cause: error },
    );
  }
}

function validateBoundedBigIntFileMetadata(
  stat: BigIntBoundedFileStat,
  options: BoundedFileOptions,
): void {
  if (!stat.isFile()) throw new Error("path is not a regular file");
  if (options.requireSingleLink && stat.nlink !== 1n) {
    throw new Error("file has multiple hard links");
  }
  if (options.expectedUid !== undefined && stat.uid !== BigInt(options.expectedUid)) {
    throw new Error("file owner is not trusted");
  }
  if (
    options.allowedModes !== undefined
    && !options.allowedModes.includes(Number(stat.mode & 0o7777n))
  ) {
    throw new Error("file mode is not trusted");
  }
}

function assertPrivateFileSingleLink(
  path: string,
  expected: PrivateFileIdentity,
): void {
  assertPrivateFileLinkCount(path, expected, 1n, "private durable publication did not produce a single-link destination");
}

function assertPrivateFileLinkCount(
  path: string,
  expected: PrivateFileIdentity,
  expectedNlink: bigint,
  message: string,
): void {
  const current = lstatSync(path, { bigint: true }) as unknown as BigIntFileStat;
  if (
    !current.isFile()
    || current.nlink !== expectedNlink
    || current.dev !== expected.dev
    || current.ino !== expected.ino
  ) {
    throw new Error(message);
  }
}

type AuthenticatedWriterAliasFileStat = BigIntBoundedFileStat & Readonly<{
  ctimeNs: bigint;
  gid: bigint;
  mtimeNs: bigint;
  size: bigint;
}>;

function samePrivateFileMetadata(
  left: AuthenticatedWriterAliasFileStat,
  right: AuthenticatedWriterAliasFileStat,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function writerAliasPathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export type AuthenticatedWriterAliasOptions = Readonly<{
  expectedUid?: number;
  maxBytes: number;
  allowedModes?: readonly number[];
  /** @internal Deterministic race seam immediately before alias unlink. */
  _beforeUnlinkForTesting?: () => void;
  /** @internal Deterministic post-unlink identity seam for tests. */
  _afterUnlinkForTesting?: () => void;
}>;

/**
 * Consume the exact temporary writer name from an authenticated same-inode
 * final/alias pair.  All validation completes while both file descriptors and
 * the private parent descriptor are retained; the alias is then removed only
 * if its pathname still names the authenticated inode.
 */
export function consumeAuthenticatedWriterAlias(
  finalPath: string,
  aliasPath: string,
  options: AuthenticatedWriterAliasOptions,
): void {
  if (finalPath === aliasPath) throw new Error("writer alias must be a distinct path");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const allowedModes = options.allowedModes ?? [PRIVATE_FILE_MODE];
  if (
    allowedModes.length === 0
    || allowedModes.some((mode) => !isOwnerOnlyFileMode(mode))
  ) {
    throw new Error("writer alias modes must be owner-only");
  }
  const expectedUid = options.expectedUid ?? currentUid();
  const directory = dirname(finalPath);
  const parent = openPrivateDirectory(directory, { expectedUid });
  let finalFd: number | undefined;
  let aliasFd: number | undefined;
  let primaryError: unknown;
  try {
    assertPrivateDirectory(parent, directory, parent.witness, expectedUid);
    const parentIdentity: PrivatePathIdentity = {
      dev: BigInt(parent.witness.dev),
      ino: BigInt(parent.witness.ino),
    };
    const aliasParent = privatePathIdentity(dirname(aliasPath));
    if (aliasParent.dev !== parentIdentity.dev || aliasParent.ino !== parentIdentity.ino) {
      throw new Error("writer alias parent is not authenticated");
    }
    finalFd = openSync(
      finalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    aliasFd = openSync(
      aliasPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const finalStat = fstatSync(finalFd, { bigint: true }) as unknown as AuthenticatedWriterAliasFileStat;
    const aliasStat = fstatSync(aliasFd, { bigint: true }) as unknown as AuthenticatedWriterAliasFileStat;
    validateBoundedBigIntFileMetadata(finalStat, {
      allowedRoot: directory,
      maxBytes: options.maxBytes,
      expectedUid,
      allowedModes,
      requireSingleLink: false,
    });
    validateBoundedBigIntFileMetadata(aliasStat, {
      allowedRoot: directory,
      maxBytes: options.maxBytes,
      expectedUid,
      allowedModes,
      requireSingleLink: false,
    });
    if (finalStat.nlink !== 2n || aliasStat.nlink !== 2n) {
      throw new Error("writer alias has invalid link topology");
    }
    if (!samePrivateFileMetadata(finalStat, aliasStat)) {
      throw new Error("writer alias metadata does not match the final file");
    }
    const finalContent = readDescriptorBoundedBytes(finalFd, options.maxBytes);
    const aliasContent = readDescriptorBoundedBytes(aliasFd, options.maxBytes);
    if (!finalContent.equals(aliasContent)) {
      throw new Error("writer alias content does not match the final file");
    }
    const finalIdentity = privateFileIdentity(finalStat, parentIdentity);
    const aliasIdentity = privateFileIdentity(aliasStat, parentIdentity);
    options._beforeUnlinkForTesting?.();
    assertPrivateDirectory(parent, directory, parent.witness, expectedUid);
    const finalAfterRead = fstatSync(finalFd, { bigint: true }) as unknown as AuthenticatedWriterAliasFileStat;
    const aliasAfterRead = fstatSync(aliasFd, { bigint: true }) as unknown as AuthenticatedWriterAliasFileStat;
    validateBoundedBigIntFileMetadata(finalAfterRead, {
      allowedRoot: directory,
      maxBytes: options.maxBytes,
      expectedUid,
      allowedModes,
      requireSingleLink: false,
    });
    validateBoundedBigIntFileMetadata(aliasAfterRead, {
      allowedRoot: directory,
      maxBytes: options.maxBytes,
      expectedUid,
      allowedModes,
      requireSingleLink: false,
    });
    if (!samePrivateFileMetadata(finalStat, finalAfterRead) || !samePrivateFileMetadata(aliasStat, aliasAfterRead)) {
      throw new Error("writer alias changed during consume");
    }
    if (
      !readDescriptorBoundedBytes(finalFd, options.maxBytes, 0).equals(finalContent)
      || !readDescriptorBoundedBytes(aliasFd, options.maxBytes, 0).equals(aliasContent)
    ) {
      throw new Error("writer alias content changed during consume");
    }
    assertPrivateFileLinkCount(
      finalPath,
      finalIdentity,
      2n,
      "writer alias final file changed during consume",
    );
    if (!unlinkPrivateFileIfIdentityMatches(aliasPath, aliasIdentity, unlinkSync, undefined, 2n)) {
      throw new Error("writer alias changed during consume");
    }
    options._afterUnlinkForTesting?.();
    if (!writerAliasPathIsAbsent(aliasPath)) {
      throw new Error("writer alias was replaced during consume");
    }
    assertPrivateFileSingleLink(finalPath, finalIdentity);
    assertPrivateDirectory(parent, directory, parent.witness, expectedUid);
    fsyncSync(parent.fd);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const fd of [aliasFd, finalFd]) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      parent.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primaryError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "writer alias consumption and descriptor cleanup failed",
        { cause: primaryError },
      );
    }
    if (primaryError === undefined && cleanupErrors.length === 1) throw cleanupErrors[0];
    if (primaryError === undefined && cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "writer alias descriptor cleanup failed");
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

/** Read a bounded regular file and its metadata from one descriptor. */
export function readBoundedRegularFileWithStat(path: string, options: BoundedFileOptions): BoundedFileResult {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const allowedRoot = realpathSync(options.allowedRoot);
  const realParent = realpathSync(dirname(path));
  if (!isContainedPath(allowedRoot, realParent)) {
    throw new Error("file is outside the permitted root");
  }

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // The descriptor is opened before any path-based race seam or validation
    // work.  Subsequent pathname checks are witnesses only; bytes are read
    // from this retained descriptor, never by reopening the path.
    options._beforeOpenForTesting?.();
    const stat = fstatSync(fd);
    validateBoundedFileMetadata(stat, options);
    options._afterStatForTesting?.();
    // Re-resolve after opening and bind the pathname to the descriptor. This
    // detects an intermediate directory or leaf replacement between the
    // initial containment check and open(2). The descriptor is already fixed,
    // so any later replacement cannot change the bytes we read.
    const openedPath = realpathSync(path);
    if (!isContainedPath(allowedRoot, openedPath)) {
      throw new Error("file is outside the permitted root");
    }
    const current = statSync(openedPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error("file changed during validation");
    }
    if (stat.size > options.maxBytes) throw new Error("file exceeds the configured size limit");
    options._beforeReadForTesting?.();
    const content = readDescriptorBounded(fd, options.maxBytes);
    if (
      options.expectedRawSha256 !== undefined
      && createHash("sha256").update(content).digest("hex") !== options.expectedRawSha256
    ) {
      throw new Error("file content hash does not match expected witness");
    }
    const finalPath = realpathSync(path);
    if (!isContainedPath(allowedRoot, finalPath)) {
      throw new Error("file is outside the permitted root");
    }
    const final = statSync(finalPath);
    options._beforePostStatForTesting?.();
    const afterRead = fstatSync(fd);
    validateBoundedFileMetadata(afterRead, options);
    if (boundedFileMetadataChanged(stat, final)) {
      throw new Error("file changed during validation");
    }
    if (boundedFileMetadataChanged(stat, afterRead)) {
      throw new Error("file changed during validation");
    }
    const exactStat = directoryStat(fd) as unknown as Readonly<{
      mode: bigint;
      uid: bigint;
      gid: bigint;
      nlink: bigint;
      dev: bigint;
      ino: bigint;
    }>;
    const finalParent = statSync(dirname(finalPath), { bigint: true }) as unknown as Readonly<{
      dev: bigint;
      ino: bigint;
    }>;
    const result: BoundedFileResult = {
      content,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      mode: Number(exactStat.mode & 0o7777n),
      uid: Number(exactStat.uid),
      gid: Number(exactStat.gid),
      nlink: exactStat.nlink.toString(10),
      parentDev: finalParent.dev.toString(10),
      parentIno: finalParent.ino.toString(10),
      exactDev: exactStat.dev.toString(10),
      exactIno: exactStat.ino.toString(10),
    };
    // Preserve the historical enumerable result shape while exposing exact
    // metadata to descriptor-bound consumers through non-enumerable fields.
    for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "parentDev", "parentIno", "exactDev", "exactIno"] as const) {
      Object.defineProperty(result, key, { value: result[key], enumerable: false });
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

/** Read a bounded regular file without following a symlink at the leaf. */
export function readBoundedRegularFile(path: string, options: BoundedFileOptions): string {
  return readBoundedRegularFileWithStat(path, options).content;
}

/**
 * Read a private bounded regular file and consume only the exact inode that
 * was read.  The pathname is revalidated immediately before unlink; a
 * replacement, symlink, or hard-link collision is preserved as evidence.
 * An already-absent leaf after a successful read is an idempotent consume.
 */
export function consumeBoundedRegularFile(path: string, options: BoundedFileOptions): string {
  const expectedParent = realpathSync(dirname(path));
  const result = readBoundedRegularFileWithStat(path, options);
  options._beforeUnlinkForTesting?.();
  try {
    if (realpathSync(dirname(path)) !== expectedParent) {
      throw new Error("file parent changed during consume");
    }
    const currentParent = lstatSync(dirname(path), { bigint: true }) as unknown as PrivatePathIdentity;
    const current = lstatSync(path, { bigint: true }) as unknown as BigIntBoundedFileStat;
    if (
      currentParent.dev.toString(10) !== result.parentDev
      || currentParent.ino.toString(10) !== result.parentIno
      || current.dev.toString(10) !== result.exactDev
      || current.ino.toString(10) !== result.exactIno
    ) {
      throw new Error("file changed during consume");
    }
    validateBoundedBigIntFileMetadata(current, { ...options, requireSingleLink: true });
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result.content;
    throw error;
  }
  return result.content;
}

/** Atomically replace a private file from a same-directory exclusive temp file. */
export function atomicWritePrivateFile(
  path: string,
  content: string,
  operations: {
    readonly close?: typeof closeSync;
    readonly fchmod?: typeof fchmodSync;
    readonly link?: typeof linkSync;
    readonly open?: typeof openSync;
    readonly random?: (size: number) => Buffer;
    readonly remove?: typeof rmSync;
    readonly rename?: typeof renameSync;
    readonly sync?: typeof fsyncSync;
    readonly write?: typeof writeFileSync;
  } = {},
  parent?: PrivateDirectoryHandle,
  options: Readonly<{ requireAbsent?: boolean }> = {},
): void {
  const directory = dirname(path);
  if (options.requireAbsent) {
    if (parent === undefined) {
      throw new Error("exclusive private publication requires a retained parent");
    }
    assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
    const parentIdentity = {
      dev: BigInt(parent.witness.dev),
      ino: BigInt(parent.witness.ino),
    };
    const tempPath = join(
      directory,
      `.${basename(path)}.${(operations.random ?? randomBytes)(12).toString("hex")}.tmp`,
    );
    let ownsTempPath = false;
    let published = false;
    let tempIdentity: PrivateFileIdentity | undefined;
    let primaryError: unknown;
    try {
      let fd: number;
      try {
        fd = (operations.open ?? openSync)(tempPath, "wx", PRIVATE_FILE_MODE);
      } catch (error) {
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch {
          throw new PrivateDirectoryTopologyError(
            "private directory topology is not trusted after temporary file open failed",
            { cause: error },
          );
        }
        throw error;
      }
      ownsTempPath = true;
      try {
        tempIdentity = privateFileIdentity(
          fstatSync(fd, { bigint: true }) as unknown as PrivatePathIdentity,
          parentIdentity,
        );
        assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        (operations.write ?? writeFileSync)(fd, content, "utf-8");
        (operations.fchmod ?? fchmodSync)(fd, PRIVATE_FILE_MODE);
        (operations.sync ?? fsyncSync)(fd);
      } finally {
        (operations.close ?? closeSync)(fd);
      }
      assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
      assertPrivateTemporaryFileIdentity(tempPath, tempIdentity);
      try {
        (operations.link ?? linkSync)(tempPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PrivateFileCollisionError(
            "private file was created concurrently",
            { cause: error },
          );
        }
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch (topologyError) {
          throw new PrivateFilePublicationTopologyError(
            "unknown",
            topologyError as PrivateDirectoryTopologyError,
            error,
            "link",
          );
        }
        throw error;
      }
      published = true;
      const removed = unlinkPrivateFileIfIdentityMatches(
        tempPath,
        tempIdentity,
        (candidate) => (operations.remove ?? rmSync)(candidate, { force: true }),
        undefined,
        2n,
      );
      if (!removed) {
        throw new Error("private exclusive publication temp cleanup was not completed");
      }
      ownsTempPath = false;
      assertPrivateFileSingleLink(path, tempIdentity);
      assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
    } catch (error) {
      primaryError = error;
      if (
        published
        && !(error instanceof PrivateFileCollisionError)
        && !(error instanceof PrivateFilePublicationTopologyError)
      ) {
        let topologyError: PrivateDirectoryTopologyError | undefined;
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch (observedTopologyError) {
          topologyError = observedTopologyError as PrivateDirectoryTopologyError;
        }
        primaryError = new PrivateFilePublicationTopologyError(
          "published",
          topologyError ?? new PrivateDirectoryTopologyError(
            "private file link publication topology is not trusted",
            { cause: error },
          ),
          error,
          "link",
        );
      } else if (!(error instanceof PrivateDirectoryTopologyError)) {
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch (topologyError) {
          primaryError = topologyError;
        }
      }
    } finally {
      if (ownsTempPath && tempIdentity !== undefined) {
        try {
          unlinkPrivateFileIfIdentityMatches(
            tempPath,
            tempIdentity,
            (candidate) => (operations.remove ?? rmSync)(candidate, { force: true }),
            undefined,
            published ? 2n : 1n,
          );
        } catch { /* preserve the exclusive publication failure */ }
      }
    }
    if (primaryError !== undefined) throw primaryError;
    return;
  }
  if (parent === undefined) {
    ensurePrivateDirectory(directory);
  } else {
    assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
  }
  const parentIdentity = parent === undefined
    ? undefined
    : { dev: BigInt(parent.witness.dev), ino: BigInt(parent.witness.ino) };
  const tempPath = join(
    directory,
    `.${basename(path)}.${(operations.random ?? randomBytes)(12).toString("hex")}.tmp`,
  );
  let ownsTempPath = false;
  let tempIdentity: PrivateFileIdentity | undefined;
  try {
    let fd: number;
    try {
      fd = (operations.open ?? openSync)(tempPath, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      if (parent !== undefined) {
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch {
          throw new PrivateDirectoryTopologyError(
            "private directory topology is not trusted after temporary file open failed",
            { cause: error },
          );
        }
      }
      throw error;
    }
    ownsTempPath = true;
    try {
      tempIdentity = privateFileIdentity(
        fstatSync(fd, { bigint: true }) as unknown as PrivatePathIdentity,
        parentIdentity ?? privatePathIdentity(directory),
      );
      if (parent !== undefined) {
        assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
      }
      (operations.write ?? writeFileSync)(fd, content, "utf-8");
      (operations.fchmod ?? fchmodSync)(fd, PRIVATE_FILE_MODE);
      (operations.sync ?? fsyncSync)(fd);
    } finally {
      (operations.close ?? closeSync)(fd);
    }
    if (parent !== undefined) {
      assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
      assertPrivateTemporaryFileIdentity(tempPath, tempIdentity);
    }
    try {
      (operations.rename ?? renameSync)(tempPath, path);
    } catch (error) {
      if (parent !== undefined) {
        try {
          assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
        } catch (topologyError) {
          throw new PrivateFilePublicationTopologyError(
            "unknown",
            topologyError as PrivateDirectoryTopologyError,
            error,
          );
        }
      }
      throw error;
    }
    ownsTempPath = false;
    if (parent !== undefined) {
      try {
        assertPrivateDirectoryEntry(parent, directory, parent.witness.uid);
      } catch (topologyError) {
        throw new PrivateFilePublicationTopologyError(
          "published",
          topologyError as PrivateDirectoryTopologyError,
          topologyError,
        );
      }
    }
  } catch (primaryError) {
    if (ownsTempPath && tempIdentity !== undefined) {
      try {
        unlinkPrivateFileIfIdentityMatches(
          tempPath,
          tempIdentity,
          (candidate) => (operations.remove ?? rmSync)(candidate, { force: true }),
        );
      } catch (cleanupError) {
        throw privateFilePublicationCleanupFailure(primaryError, cleanupError);
      }
    }
    throw primaryError;
  }
}

/**
 * Copy a validated regular file into a new private destination without
 * retaining the source in memory. The source pathname is bound to one
 * no-follow descriptor before the destination is created.
 */
export function copyRegularFilePrivateExclusive(
  sourcePath: string,
  destinationPath: string,
  options: {
    readonly allowedRoot: string;
    /** @internal Deterministic streaming seam for tests. */
    readonly _chunkBytesForTesting?: number;
    /** @internal Deterministic I/O failure seam for tests. */
    readonly _operationsForTesting?: Partial<{
      readonly close: typeof closeSync;
      readonly fchmod: typeof fchmodSync;
      readonly fstat: typeof fstatSync;
      readonly lstat: typeof lstatSync;
      readonly open: typeof openSync;
      readonly read: typeof readSync;
      readonly realpath: typeof realpathSync;
      readonly stat: typeof statSync;
      readonly sync: typeof fsyncSync;
      readonly unlink: typeof unlinkSync;
      readonly write: typeof writeSync;
    }>;
  },
): boolean {
  const io = {
    close: closeSync,
    fchmod: fchmodSync,
    fstat: fstatSync,
    lstat: lstatSync,
    open: openSync,
    read: readSync,
    realpath: realpathSync,
    stat: statSync,
    sync: fsyncSync,
    unlink: unlinkSync,
    write: writeSync,
    ...options._operationsForTesting,
  };
  const chunkBytes = options._chunkBytesForTesting ?? 64 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  const allowedRoot = io.realpath(options.allowedRoot);
  const realParent = io.realpath(dirname(sourcePath));
  if (!isContainedPath(allowedRoot, realParent)) {
    throw new Error("file is outside the permitted root");
  }

  const sourceFd = io.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  let destinationIdentity: PrivateFileIdentity | undefined;
  try {
    const sourceStat = io.fstat(sourceFd);
    if (!sourceStat.isFile()) throw new Error("path is not a regular file");
    const openedPath = io.realpath(sourcePath);
    if (!isContainedPath(allowedRoot, openedPath)) {
      throw new Error("file is outside the permitted root");
    }
    const current = io.stat(openedPath);
    if (current.dev !== sourceStat.dev || current.ino !== sourceStat.ino) {
      throw new Error("file changed during validation");
    }

    ensurePrivateDirectory(dirname(destinationPath));
    try {
      destinationFd = io.open(destinationPath, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
    destinationIdentity = privateFileIdentity(
      io.fstat(destinationFd, { bigint: true }) as unknown as PrivatePathIdentity,
      privatePathIdentity(dirname(destinationPath)),
    );
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const bytesRead = io.read(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = io.write(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (bytesWritten === 0) throw new Error("private backup write made no progress");
        written += bytesWritten;
      }
    }
    io.fchmod(destinationFd, PRIVATE_FILE_MODE);
    io.sync(destinationFd);
    io.close(destinationFd);
    destinationFd = undefined;
    return true;
  } catch (error) {
    if (destinationFd !== undefined) {
      try { io.close(destinationFd); } catch { /* preserve the original failure */ }
      if (destinationIdentity !== undefined) {
        try {
          unlinkPrivateFileIfIdentityMatches(
            destinationPath,
            destinationIdentity,
            io.unlink,
            (candidate) => io.lstat(candidate, { bigint: true }) as unknown as BigIntFileStat,
          );
        } catch { /* preserve the original failure */ }
      }
    }
    throw error;
  } finally {
    try {
      io.close(sourceFd);
    } catch { /* preserve the completed result or original copy failure */ }
  }
}

/** Create a private file only when the final destination does not already exist. */
type ExclusiveWriteDeps = {
  open: typeof openSync;
  fstat?: typeof fstatSync;
  write: typeof writeFileSync;
  sync: typeof fsyncSync;
  close: typeof closeSync;
  unlink: typeof unlinkSync;
};

export function writePrivateFileExclusive(
  path: string,
  content: string,
  deps?: ExclusiveWriteDeps,
): boolean {
  const io = deps ?? {
    open: openSync,
    write: writeFileSync,
    sync: fsyncSync,
    close: closeSync,
    unlink: unlinkSync,
  };
  ensurePrivateDirectory(dirname(path));
  let fd: number | undefined;
  let fileIdentity: PrivateFileIdentity | undefined;
  try {
    fd = io.open(path, "wx", PRIVATE_FILE_MODE);
    fileIdentity = privateFileIdentity(
      (io.fstat ?? fstatSync)(fd, { bigint: true }) as unknown as PrivatePathIdentity,
      privatePathIdentity(dirname(path)),
    );
    io.write(fd, content, "utf-8");
    io.sync(fd);
    io.close(fd);
    fd = undefined;
    return true;
  } catch (error) {
    const created = fd !== undefined;
    if (fd !== undefined) {
      try { io.close(fd); } catch { /* preserve the original failure */ }
      if (fileIdentity !== undefined) {
        try { unlinkPrivateFileIfIdentityMatches(path, fileIdentity, io.unlink); } catch { /* preserve the original failure */ }
      }
    }
    if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Atomically create a private file only when the final destination is absent.
 *
 * The completed temporary file is hard-linked into place so concurrent readers
 * can never observe a partially written destination. The link operation is
 * same-directory and exclusive: an existing destination wins without being
 * replaced.
 */
export function atomicWritePrivateFileExclusive(
  path: string,
  content: string,
  operations: {
    readonly chmod?: typeof chmodSync;
    readonly link?: typeof linkSync;
    readonly random?: (size: number) => Buffer;
    readonly remove?: typeof rmSync;
  } = {},
): boolean {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const tempPath = join(
    directory,
    `.${basename(path)}.${(operations.random ?? randomBytes)(12).toString("hex")}.tmp`,
  );
  let ownsTempPath = false;
  let tempIdentity: PrivateFileIdentity | undefined;
  let published = false;
  try {
    const fd = openSync(tempPath, "wx", PRIVATE_FILE_MODE);
    ownsTempPath = true;
    tempIdentity = privateFileIdentity(
      fstatSync(fd, { bigint: true }) as unknown as PrivatePathIdentity,
      privatePathIdentity(directory),
    );
    try {
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A hard link shares the completed temporary inode, including its mode.
    // Finish every fallible setup step before publishing the destination so a
    // thrown setup error can never strand a lock that the caller did not
    // acquire.
    (operations.chmod ?? chmodSync)(tempPath, PRIVATE_FILE_MODE);
    try {
      (operations.link ?? linkSync)(tempPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    published = true;
    return true;
  } finally {
    if (ownsTempPath && tempIdentity !== undefined) {
      try {
        unlinkPrivateFileIfIdentityMatches(
          tempPath,
          tempIdentity,
          (candidate) => (operations.remove ?? rmSync)(candidate, { force: true }),
        );
      } catch (error) {
        // Once the destination is published it is complete and private. A
        // best-effort temporary-link cleanup failure must not report lock
        // acquisition failure while leaving that valid destination behind.
        if (!published) throw error;
      }
    }
  }
}

export type DurablePrivateWriteOptions = Readonly<{
  /** Require every retained directory and precondition read to use this owner policy. */
  expectedUid?: number;
  /** Require the destination to be absent rather than replacing it. */
  requireAbsent?: boolean;
  /** Bound the precondition read independently of the replacement size. */
  maxExistingBytes?: number;
  /** Authenticated owner-only mode to place on the temporary descriptor before publication. */
  finalMode?: number;
  /** @internal Deterministic temporary-name seam for tests. */
  random?: (size: number) => Buffer;
}>;

/**
 * Publish a bounded private file durably in one directory.
 *
 * The parent is retained and revalidated for the complete operation.  The
 * temporary inode is fully written, mode-tightened, and fsynced before it is
 * linked or renamed into place; the parent is then fsynced as well.
 * `requireAbsent` uses an exclusive hard link for portable no-clobber create.
 * Without it, publication is an unconditional same-directory rename after
 * the bounded existing-file safety preflight.  Parent and leaf checks reject
 * observed unsafe state but are not descriptor-relative mutation and cannot
 * close a same-UID substitution after the final check.  Application locks
 * serialize cooperating LCM writers only; callers needing conditional
 * replacement must own a protocol-specific operation and recovery grammar.
 */
export function atomicWritePrivateFileDurable(
  path: string,
  content: string | Uint8Array,
  options: DurablePrivateWriteOptions = {},
): void {
  if (Object.hasOwn(options, "expectedContentSha256")) {
    throw new Error("conditional durable replacement is unsupported; use a protocol-specific operation");
  }
  const finalMode = options.finalMode ?? PRIVATE_FILE_MODE;
  if (!isOwnerOnlyFileMode(finalMode)) {
    throw new Error("private durable publication mode must be owner-only");
  }
  const directory = dirname(path);
  const expectedUid = options.expectedUid ?? currentUid();
  const parent = openPrivateDirectory(directory, { expectedUid });
  const parentIdentity: PrivatePathIdentity = {
    dev: BigInt(parent.witness.dev),
    ino: BigInt(parent.witness.ino),
  };
  const current = (() => {
    try {
      readBoundedRegularFileWithStat(path, {
        allowedRoot: directory,
        maxBytes: options.maxExistingBytes ?? Math.max(Buffer.byteLength(content), 1) + 1,
        expectedUid,
        allowedModes: OWNER_ONLY_FILE_MODES,
        requireSingleLink: true,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  })();
  if (options.requireAbsent && current) {
    parent.close();
    throw new Error("private file already exists");
  }

  const temporaryPath = join(
    directory,
    `.${basename(path)}.${(options.random ?? randomBytes)(12).toString("hex")}.tmp`,
  );
  let temporaryFd: number | undefined;
  let temporaryIdentity: PrivateFileIdentity | undefined;
  let primaryError: unknown;
  try {
    temporaryFd = openSync(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      finalMode,
    );
    temporaryIdentity = privateFileIdentity(
      fstatSync(temporaryFd, { bigint: true }) as unknown as PrivatePathIdentity,
      parentIdentity,
    );
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(temporaryFd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("private durable write made no progress");
      offset += written;
    }
    fchmodSync(temporaryFd, finalMode);
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;
    if (options.requireAbsent) {
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("private file was created concurrently");
        }
        throw error;
      }
    } else {
      renameSync(temporaryPath, path);
    }
    if (options.requireAbsent && temporaryIdentity !== undefined) {
      unlinkPrivateFileIfIdentityMatches(temporaryPath, temporaryIdentity);
      assertPrivateFileSingleLink(path, temporaryIdentity);
      temporaryIdentity = undefined;
    }
    assertPrivateDirectory(parent, directory, parent.witness, expectedUid);
    fsyncSync(parent.fd);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (temporaryFd !== undefined) {
      try { closeSync(temporaryFd); } catch { /* preserve the original error */ }
    }
    if (temporaryIdentity !== undefined) {
      try {
        unlinkPrivateFileIfIdentityMatches(temporaryPath, temporaryIdentity);
      } catch (error) {
        if (
          primaryError === undefined
          || (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    parent.close();
  }
}

/** Delete a regular file without following a symlink. */
export function deleteRegularFile(path: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error("refusing to delete a non-regular file");
  }
  unlinkSync(path);
  return true;
}
