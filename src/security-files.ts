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
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, sep } from "node:path";

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
};

export type BoundedFileResult = {
  content: string;
  mtimeMs: number;
};

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

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if (stat.size > options.maxBytes) throw new Error("file exceeds the configured size limit");
    return { content: readFileSync(fd, "utf-8"), mtimeMs: stat.mtimeMs };
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
  const tempPath = `${directory}/.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`;
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
