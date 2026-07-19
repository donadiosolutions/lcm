import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
export function atomicWritePrivateFile(path: string, content: string): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const tempPath = join(directory, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    const fd = openSync(tempPath, "wx", PRIVATE_FILE_MODE);
    try {
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } finally {
    rmSync(tempPath, { force: true });
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

/** Delete a regular file without following a symlink. */
export function deleteRegularFile(path: string): boolean {
  let stat;
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
