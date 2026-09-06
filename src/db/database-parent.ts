import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PRIVATE_DIRECTORY_MODE,
  PrivateDirectoryTopologyError,
} from "../security-files.js";

export type DatabaseParentIdentity = Readonly<{
  device: string;
  inode: string;
}>;

type DatabaseParentOperations = Readonly<{
  open: (path: string, flags: number) => number;
  close: (fd: number) => void;
  fchmod: (fd: number, mode: number) => void;
  fstat: (fd: number) => BigIntStats;
  lstat: (path: string) => BigIntStats;
  mkdir: (path: string) => void;
}>;

export type DatabaseParentTestingOptions = Readonly<{
  open?: DatabaseParentOperations["open"];
  close?: DatabaseParentOperations["close"];
  fchmod?: DatabaseParentOperations["fchmod"];
  fstat?: DatabaseParentOperations["fstat"];
  lstat?: DatabaseParentOperations["lstat"];
  mkdir?: DatabaseParentOperations["mkdir"];
  expectedUid?: number | null;
  beforeTighten?: (path: string) => void;
  beforeCreateComponent?: (path: string, index: number) => void;
}>;

export type DatabaseParentAdmissionOptions = Readonly<{
  createIfMissing: boolean;
  tighten: boolean;
  expectedIdentity?: DatabaseParentIdentity;
  _databaseParentForTesting?: DatabaseParentTestingOptions;
}>;

export type DatabaseParentHandle = Readonly<{
  path: string;
  identity: DatabaseParentIdentity;
  assertCurrent: () => void;
  close: () => void;
}>;

const DATABASE_PARENT_OPEN_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK;

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function directoryIdentity(stat: BigIntStats): DatabaseParentIdentity {
  return {
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
  };
}

export function sameDatabaseParentIdentity(
  left: DatabaseParentIdentity,
  right: DatabaseParentIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function topologyError(message: string, cause?: unknown): PrivateDirectoryTopologyError {
  return new PrivateDirectoryTopologyError(`database parent topology is not trusted: ${message}`, {
    cause,
  });
}

function authenticateDatabaseParent(
  fd: number,
  path: string,
  expectedUid: number | undefined,
  expectedIdentity: DatabaseParentIdentity | undefined,
  requirePrivateMode: boolean,
  operations: DatabaseParentOperations,
): DatabaseParentIdentity {
  try {
    const descriptor = operations.fstat(fd);
    if (!descriptor.isDirectory()) throw new Error("descriptor is not a directory");
    if (
      expectedUid !== undefined
      && (!Number.isSafeInteger(expectedUid) || Number(descriptor.uid) !== expectedUid)
    ) {
      throw new Error("owner is not trusted");
    }

    const entry = operations.lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("entry is not a directory");
    }
    if (entry.uid !== descriptor.uid) throw new Error("entry owner is not trusted");

    const identity = directoryIdentity(descriptor);
    if (!sameDatabaseParentIdentity(identity, directoryIdentity(entry))) {
      throw new Error("entry changed during validation");
    }
    if (expectedIdentity && !sameDatabaseParentIdentity(identity, expectedIdentity)) {
      throw new Error("entry no longer matches the pooled parent");
    }

    if (requirePrivateMode) {
      const descriptorMode = Number(descriptor.mode & 0o7777n);
      const entryMode = Number(entry.mode & 0o7777n);
      if (
        descriptorMode !== PRIVATE_DIRECTORY_MODE
        || entryMode !== PRIVATE_DIRECTORY_MODE
      ) {
        throw new Error("mode is not private");
      }
    }
    return identity;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw topologyError(message, error);
  }
}

function databaseParentOperations(
  testing: DatabaseParentTestingOptions | undefined,
): DatabaseParentOperations {
  return {
    open: testing?.open ?? openSync,
    close: testing?.close ?? closeSync,
    fchmod: testing?.fchmod ?? fchmodSync,
    fstat: testing?.fstat ?? ((fd) => fstatSync(fd, { bigint: true })),
    lstat: testing?.lstat ?? ((path) => lstatSync(path, { bigint: true })),
    mkdir: testing?.mkdir ?? ((path) => {
      mkdirSync(path, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    }),
  };
}

function openExistingDatabaseParent(
  path: string,
  options: Omit<DatabaseParentAdmissionOptions, "createIfMissing">,
): DatabaseParentHandle | null {
  const operations = databaseParentOperations(options._databaseParentForTesting);
  let fd: number;
  try {
    fd = operations.open(path, DATABASE_PARENT_OPEN_FLAGS);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    const message = error instanceof Error ? error.message : String(error);
    throw topologyError(message, error);
  }

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    operations.close(fd);
  };
  const testing = options._databaseParentForTesting;
  const expectedUid = testing && "expectedUid" in testing
    ? testing.expectedUid ?? undefined
    : currentUid();

  try {
    const identity = authenticateDatabaseParent(
      fd,
      path,
      expectedUid,
      options.expectedIdentity,
      false,
      operations,
    );
    if (options.tighten) {
      options._databaseParentForTesting?.beforeTighten?.(path);
      authenticateDatabaseParent(
        fd,
        path,
        expectedUid,
        options.expectedIdentity,
        false,
        operations,
      );
      operations.fchmod(fd, PRIVATE_DIRECTORY_MODE);
      authenticateDatabaseParent(
        fd,
        path,
        expectedUid,
        options.expectedIdentity,
        true,
        operations,
      );
    }

    return {
      path,
      identity,
      assertCurrent: () => {
        authenticateDatabaseParent(
          fd,
          path,
          expectedUid,
          identity,
          options.tighten,
          operations,
        );
      },
      close,
    };
  } catch (error) {
    try { close(); } catch { /* preserve the authentication failure */ }
    throw error;
  }
}

function createDatabaseParent(
  path: string,
  options: DatabaseParentAdmissionOptions,
): DatabaseParentHandle {
  const missing: string[] = [];
  const operations = databaseParentOperations(options._databaseParentForTesting);
  let anchor = path;
  for (;;) {
    try {
      operations.lstat(anchor);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      missing.push(anchor);
      const next = dirname(anchor);
      if (next === anchor) throw topologyError("no existing ancestor is available", error);
      anchor = next;
    }
  }

  if (missing.length === 0) {
    const appeared = openExistingDatabaseParent(path, options);
    if (appeared) return appeared;
    throw topologyError("entry disappeared before admission");
  }

  let retained: DatabaseParentHandle | undefined;
  try {
    const components = missing.reverse();
    for (const [index, component] of components.entries()) {
      options._databaseParentForTesting?.beforeCreateComponent?.(component, index);
      retained?.assertCurrent();
      try {
        operations.mkdir(component);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      const admitted = openExistingDatabaseParent(component, {
        ...options,
        tighten: true,
        expectedIdentity: undefined,
      });
      if (!admitted) throw topologyError("created entry disappeared before admission");
      if (retained) {
        try {
          retained.close();
        } catch (error) {
          try { admitted.close(); } catch { /* preserve the prior close failure */ }
          throw error;
        }
      }
      retained = admitted;
    }
    return retained!;
  } catch (error) {
    try { retained?.close(); } catch { /* preserve the creation failure */ }
    throw error;
  }
}

/**
 * Authenticate the immediate persistent-database parent before SQLite uses a
 * pathname. The retained descriptor detects topology changes at each explicit
 * boundary; SQLite remains pathname based, so this is not an atomic openat
 * guarantee against external substitution through a writable ancestor.
 */
export function admitDatabaseParent(
  dbPath: string,
  options: DatabaseParentAdmissionOptions,
): DatabaseParentHandle | null {
  const parentPath = resolve(dirname(dbPath));
  const existing = openExistingDatabaseParent(parentPath, options);
  if (existing) return existing;
  if (options.expectedIdentity) {
    throw topologyError("pooled parent is missing");
  }
  if (!options.createIfMissing) return null;
  return createDatabaseParent(parentPath, options);
}
