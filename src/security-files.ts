import { randomBytes } from "node:crypto";
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

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function isContainedPath(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

export type BoundedFileOptions = {
  allowedRoot: string;
  maxBytes: number;
  /** @internal Deterministic race seam for descriptor-bound tests. */
  _afterStatForTesting?: () => void;
  /** @internal Deterministic parent-swap seam for descriptor-bound tests. */
  _beforeOpenForTesting?: () => void;
};

export type BoundedFileResult = {
  content: string;
  mtimeMs: number;
};

function readDescriptorBounded(fd: number, maxBytes: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error("file exceeds the configured size limit");
  return Buffer.concat(chunks, total).toString("utf-8");
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

  options._beforeOpenForTesting?.();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("path is not a regular file");
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
    return { content: readDescriptorBounded(fd, options.maxBytes), mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** Read a bounded regular file without following a symlink at the leaf. */
export function readBoundedRegularFile(path: string, options: BoundedFileOptions): string {
  return readBoundedRegularFileWithStat(path, options).content;
}

/** Atomically replace a private file from a same-directory exclusive temp file. */
export function atomicWritePrivateFile(
  path: string,
  content: string,
  operations: {
    readonly close?: typeof closeSync;
    readonly fchmod?: typeof fchmodSync;
    readonly open?: typeof openSync;
    readonly random?: (size: number) => Buffer;
    readonly remove?: typeof rmSync;
    readonly rename?: typeof renameSync;
    readonly sync?: typeof fsyncSync;
    readonly write?: typeof writeFileSync;
  } = {},
): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const tempPath = join(
    directory,
    `.${basename(path)}.${(operations.random ?? randomBytes)(12).toString("hex")}.tmp`,
  );
  let ownsTempPath = false;
  try {
    const fd = (operations.open ?? openSync)(tempPath, "wx", PRIVATE_FILE_MODE);
    ownsTempPath = true;
    try {
      (operations.write ?? writeFileSync)(fd, content, "utf-8");
      (operations.fchmod ?? fchmodSync)(fd, PRIVATE_FILE_MODE);
      (operations.sync ?? fsyncSync)(fd);
    } finally {
      (operations.close ?? closeSync)(fd);
    }
    (operations.rename ?? renameSync)(tempPath, path);
    ownsTempPath = false;
  } finally {
    if (ownsTempPath) (operations.remove ?? rmSync)(tempPath, { force: true });
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
      try { io.unlink(destinationPath); } catch { /* preserve the original failure */ }
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
  try {
    fd = io.open(path, "wx", PRIVATE_FILE_MODE);
    io.write(fd, content, "utf-8");
    io.sync(fd);
    io.close(fd);
    fd = undefined;
    return true;
  } catch (error) {
    const created = fd !== undefined;
    if (fd !== undefined) {
      try { io.close(fd); } catch { /* preserve the original failure */ }
      try { io.unlink(path); } catch { /* preserve the original failure */ }
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
  let published = false;
  try {
    const fd = openSync(tempPath, "wx", PRIVATE_FILE_MODE);
    ownsTempPath = true;
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
    if (ownsTempPath) {
      try {
        (operations.remove ?? rmSync)(tempPath, { force: true });
      } catch (error) {
        // Once the destination is published it is complete and private. A
        // best-effort temporary-link cleanup failure must not report lock
        // acquisition failure while leaving that valid destination behind.
        if (!published) throw error;
      }
    }
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
