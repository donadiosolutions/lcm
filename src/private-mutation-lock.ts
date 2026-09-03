import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, win32 } from "node:path";
import {
  atomicWritePrivateFileExclusive,
  deleteRegularFile,
  readBoundedRegularFile,
} from "./security-files.js";

const MAX_PRIVATE_MUTATION_LOCK_BYTES = 1024;
const MAX_DISAPPEARED_OWNER_READ_RETRIES = 1;
const abandonedMutationLocks = new Map<string, string>();

export type PrivateMutationLockOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly processStartTime: string | null;
  readonly nonce: string;
  readonly createdAtMs?: number;
};

export class PrivateMutationLockContentionError extends Error {}

export type PrivateMutationLockObserver = (
  event: string,
  path: string,
  mutable?: { value: string },
) => void;

const NOOP_PRIVATE_MUTATION_LOCK_OBSERVER: PrivateMutationLockObserver = () => undefined;

/** @internal Deterministic filesystem seam used by lock recovery tests. */
export type PrivateMutationLockOperations = {
  readonly deleteRegularFile: typeof deleteRegularFile;
};

const DEFAULT_PRIVATE_MUTATION_LOCK_OPERATIONS: PrivateMutationLockOperations = {
  deleteRegularFile,
};

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function trustedProcessBirthExecutable(
  currentPlatform: string,
  systemRoot: string | undefined,
): string | null {
  switch (currentPlatform) {
    case "darwin":
    case "freebsd":
    case "netbsd":
    case "openbsd":
      return "/bin/ps";
    case "aix":
    case "sunos":
      return "/usr/bin/ps";
    case "win32":
      if (
        systemRoot === undefined
        || !/^[A-Za-z]:[\\/]/u.test(systemRoot)
        || !win32.isAbsolute(systemRoot)
      ) {
        return null;
      }
      return win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
    default:
      return null;
  }
}

/** @internal Pure platform seam used by process-birth security tests. */
export function trustedProcessBirthExecutableForTesting(
  currentPlatform: string,
  systemRoot?: string,
): string | null {
  return trustedProcessBirthExecutable(currentPlatform, systemRoot);
}

export function processStartTime(
  pid: number,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
): string | null {
  const currentPlatform = { value: platform() };
  observer("platform", "", currentPlatform);
  if (currentPlatform.value === "linux") {
    try {
      const path = `/proc/${pid}/stat`;
      observer("before-process-stat-read", path);
      const observed = { value: readBoundedRegularFile(path, {
        maxBytes: 16 * 1024,
        allowedRoot: "/proc",
      }) };
      observer("after-process-stat-read", path, observed);
      const fields = observed.value.slice(observed.value.lastIndexOf(")") + 2).split(" ");
      return fields[19] || null;
    } catch {
      return null;
    }
  }

  const command = trustedProcessBirthExecutable(
    currentPlatform.value,
    process.env.SystemRoot,
  );
  if (command === null) return null;
  const args = currentPlatform.value === "win32"
    ? [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('O')`,
    ]
    : ["-o", "lstart=", "-p", String(pid)];
  const observed = { value: "" };
  try {
    observer("before-process-birth-command", command);
    observed.value = execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 2_000,
      windowsHide: true,
    }).trim();
  } catch {
    observed.value = "";
  }
  observer("after-process-birth-command", command, observed);
  return observed.value.trim() || null;
}

function lockOwnerState(
  owner: PrivateMutationLockOwner,
  observer: PrivateMutationLockObserver,
): "live" | "stale" | "ambiguous" {
  try {
    observer("before-process-probe", String(owner.pid));
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "stale" : "ambiguous";
  }
  const observedStartTime = processStartTime(owner.pid, observer);
  if (owner.processStartTime === null || observedStartTime === null) {
    return "ambiguous";
  }
  return observedStartTime === owner.processStartTime ? "live" : "stale";
}

function readLockOwner(
  lockPath: string,
  label: string,
): {
  readonly content: string;
  readonly owner: PrivateMutationLockOwner;
} {
  const content = readBoundedRegularFile(lockPath, {
    maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
    allowedRoot: dirname(lockPath),
  });
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(
      `${label} lock is malformed; inspect ${lockPath} and remove it only after confirming no LCM mutation is active`,
    );
  }
  const owner = value as Partial<PrivateMutationLockOwner>;
  if (
    !value
    || typeof value !== "object"
    || owner.version !== 1
    || !Number.isSafeInteger(owner.pid)
    || (owner.pid ?? 0) <= 0
    || (owner.processStartTime !== null && typeof owner.processStartTime !== "string")
    || typeof owner.nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(owner.nonce)
    || (
      owner.createdAtMs !== undefined
      && (!Number.isSafeInteger(owner.createdAtMs) || owner.createdAtMs <= 0)
    )
  ) {
    throw new Error(
      `${label} lock has an invalid owner; inspect ${lockPath} and remove it only after confirming no LCM mutation is active`,
    );
  }
  return {
    content,
    owner: owner as PrivateMutationLockOwner,
  };
}

/** @internal Read one authenticated lock owner for bounded convergence callers. */
export function readPrivateMutationLockOwner(
  lockPath: string,
  label = "private mutation",
): PrivateMutationLockOwner | null {
  try {
    return readLockOwner(lockPath, label).owner;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function createReclaimClaim(
  claimPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
): boolean {
  try {
    observer("before-claim-mkdir", claimPath);
    mkdirSync(claimPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    observer("after-claim-mkdir", claimPath);
    observer("before-reclaim-owner-publish", join(claimPath, "owner.json"));
    if (!atomicWritePrivateFileExclusive(join(claimPath, "owner.json"), content)) {
      throw new Error(`${label} reclaim claim owner already exists: ${claimPath}`);
    }
    return true;
  } catch (error) {
    try {
      rmdirSync(claimPath);
    } catch {
      // A partially initialized claim fails closed on the next attempt.
    }
    throw error;
  }
}

function acquireReclaimClaim(
  claimPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
): void {
  if (createReclaimClaim(claimPath, content, label, observer)) return;

  const ownerPath = join(claimPath, "owner.json");
  let existing: ReturnType<typeof readLockOwner>;
  try {
    existing = readLockOwner(ownerPath, label);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        `${label} lock reclamation changed during acquisition; retry the operation`,
      );
    }
    throw error;
  }
  const state = lockOwnerState(existing.owner, observer);
  if (state !== "stale") {
    const reason = state === "live"
      ? `owned by live PID ${existing.owner.pid}`
      : "owner state is ambiguous";
    throw new PrivateMutationLockContentionError(
      `stale ${label} lock reclamation is already in progress (${reason}); retry after it completes`,
    );
  }

  const tombstonePath = `${claimPath}.stale-${existing.owner.nonce}`;
  try {
    observer("before-claim-rename", claimPath);
    renameSync(claimPath, tombstonePath);
  } catch {
    throw new Error(`${label} lock reclamation changed during stale-owner recovery; retry the operation`);
  }
  observer("after-claim-rename", claimPath);
  if (!createReclaimClaim(claimPath, content, label, observer)) {
    throw new Error(`${label} lock reclamation was claimed concurrently; retry the operation`);
  }
}

function releaseReclaimClaim(
  claimPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
  operations: PrivateMutationLockOperations,
): void {
  const ownerPath = join(claimPath, "owner.json");
  observer("before-claim-release-read", ownerPath);
  if (readBoundedRegularFile(ownerPath, {
    maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
    allowedRoot: claimPath,
  }) !== content) {
    throw new Error(`${label} lock reclamation ownership changed before release`);
  }
  observer("before-claim-release-delete", ownerPath);
  if (!operations.deleteRegularFile(ownerPath)) {
    throw new Error(`${label} lock reclamation owner disappeared before release`);
  }
  rmdirSync(claimPath);
}

function acquireMutationLock(
  lockPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
  operations: PrivateMutationLockOperations,
): void {
  let disappearedOwnerReadRetries = 0;
  while (true) {
    observer("before-main-lock-publish", lockPath);
    if (atomicWritePrivateFileExclusive(lockPath, content)) {
      abandonedMutationLocks.delete(lockPath);
      return;
    }

    let existing: ReturnType<typeof readLockOwner>;
    try {
      observer("before-main-lock-owner-read", lockPath);
      existing = readLockOwner(lockPath, label);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      if (disappearedOwnerReadRetries >= MAX_DISAPPEARED_OWNER_READ_RETRIES) {
        throw new Error(
          `${label} mutation lock changed repeatedly during acquisition; retry the operation`,
        );
      }
      disappearedOwnerReadRetries += 1;
      continue;
    }

    const abandonedContent = abandonedMutationLocks.get(lockPath);
    if (abandonedContent !== undefined) {
      if (existing.content !== abandonedContent) {
        abandonedMutationLocks.delete(lockPath);
      } else {
        operations.deleteRegularFile(lockPath);
        abandonedMutationLocks.delete(lockPath);
        disappearedOwnerReadRetries = 0;
        continue;
      }
    }

    const state = lockOwnerState(existing.owner, observer);
    if (state !== "stale") {
      const reason = state === "live" ? `owned by live PID ${existing.owner.pid}` : "owner state is ambiguous";
      throw new PrivateMutationLockContentionError(
        `${label} mutation is already in progress (${reason}); retry after the active operation completes`,
      );
    }
    const reclaimPath = `${lockPath}.reclaim-${existing.owner.nonce}`;
    acquireReclaimClaim(reclaimPath, content, label, observer);
    let successorPublished = false;
    try {
      const claimOwnerPath = join(reclaimPath, "owner.json");
      observer("before-claim-removal-read", claimOwnerPath);
      if (readBoundedRegularFile(claimOwnerPath, {
        maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
        allowedRoot: reclaimPath,
      }) !== content) {
        throw new Error(`${label} lock reclamation ownership changed before stale lock removal`);
      }
      observer("before-stale-lock-read", lockPath);
      if (readBoundedRegularFile(lockPath, {
        maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
        allowedRoot: dirname(lockPath),
      }) !== existing.content) {
        throw new Error(`${label} lock changed while checking its stale owner; retry the operation`);
      }
      observer("before-stale-lock-delete", lockPath);
      if (!operations.deleteRegularFile(lockPath)) {
        throw new Error(`${label} lock disappeared during stale-owner recovery; retry the operation`);
      }
      observer("before-successor-lock-create", lockPath);
      if (!atomicWritePrivateFileExclusive(lockPath, content)) {
        throw new Error(`${label} mutation lock was claimed concurrently; retry the operation`);
      }
      successorPublished = true;
    } finally {
      try {
        releaseReclaimClaim(reclaimPath, content, label, observer, operations);
      } catch (error) {
        // Once the successor main lock is published, it is authoritative.
        // Reclaim-claim cleanup failure must not report acquisition failure and
        // strand that live lock without running the protected callback.
        if (!successorPublished) throw error;
      }
    }
    return;
  }
}

function createMutationLockContent(
  observer: PrivateMutationLockObserver,
): string {
  const owner: PrivateMutationLockOwner = {
    version: 1,
    pid: process.pid,
    processStartTime: processStartTime(process.pid, observer),
    nonce: randomBytes(16).toString("hex"),
    createdAtMs: Date.now(),
  };
  return `${JSON.stringify(owner)}\n`;
}

function releaseMutationLock(
  lockPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
  callbackFailed: boolean,
  callbackError: unknown,
  operations: PrivateMutationLockOperations,
): void {
  try {
    observer("before-main-lock-release-read", lockPath);
    if (readBoundedRegularFile(lockPath, {
      maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
      allowedRoot: dirname(lockPath),
    }) !== content) {
      throw new Error(`${label} mutation lock ownership changed before release`);
    }
    observer("before-main-lock-release-delete", lockPath);
    if (!operations.deleteRegularFile(lockPath)) {
      throw new Error(`${label} mutation lock disappeared before release`);
    }
    abandonedMutationLocks.delete(lockPath);
  } catch (releaseError) {
    let current: string;
    try {
      current = readBoundedRegularFile(lockPath, {
        maxBytes: MAX_PRIVATE_MUTATION_LOCK_BYTES,
        allowedRoot: dirname(lockPath),
      });
    } catch (recoveryError) {
      if (isMissingFileError(recoveryError)) {
        abandonedMutationLocks.delete(lockPath);
        if (callbackFailed) return;
        throw releaseError;
      }
      abandonedMutationLocks.set(lockPath, content);
      if (!callbackFailed) {
        throw new AggregateError(
          [releaseError, recoveryError],
          `${label} mutation succeeded but lock cleanup could not be recovered`,
          { cause: releaseError },
        );
      }
      throw new AggregateError(
        [callbackError, releaseError, recoveryError],
        `${label} mutation failed and lock cleanup could not be recovered`,
        { cause: callbackError },
      );
    }
    if (current !== content) {
      abandonedMutationLocks.delete(lockPath);
      const ownershipError = new Error(
        `${label} mutation lock ownership changed during release recovery`,
      );
      if (!callbackFailed) {
        throw new AggregateError(
          [releaseError, ownershipError],
          `${label} mutation succeeded but lock ownership changed during cleanup`,
          { cause: releaseError },
        );
      }
      throw new AggregateError(
        [
          callbackError,
          releaseError,
          ownershipError,
        ],
        `${label} mutation failed and lock cleanup could not be recovered`,
        { cause: callbackError },
      );
    }
    try {
      operations.deleteRegularFile(lockPath);
    } catch (recoveryError) {
      abandonedMutationLocks.set(lockPath, content);
      if (!callbackFailed) {
        throw new AggregateError(
          [releaseError, recoveryError],
          `${label} mutation succeeded but lock cleanup could not be recovered`,
          { cause: releaseError },
        );
      }
      throw new AggregateError(
        [callbackError, releaseError, recoveryError],
        `${label} mutation failed and lock cleanup could not be recovered`,
        { cause: callbackError },
      );
    }
    abandonedMutationLocks.delete(lockPath);
    if (!callbackFailed) throw releaseError;
    throw new AggregateError(
      [callbackError, releaseError],
      `${label} mutation failed after lock cleanup initially failed`,
      { cause: callbackError },
    );
  }
}

export function withPrivateMutationLock<T>(
  lockPath: string,
  label: string,
  callback: () => T,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
  operations: PrivateMutationLockOperations = DEFAULT_PRIVATE_MUTATION_LOCK_OPERATIONS,
): T {
  const content = createMutationLockContent(observer);
  acquireMutationLock(lockPath, content, label, observer, operations);
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    return callback();
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
    throw error;
  } finally {
    releaseMutationLock(
      lockPath,
      content,
      label,
      observer,
      callbackFailed,
      callbackError,
      operations,
    );
  }
}

export async function withPrivateMutationLockAsync<T>(
  lockPath: string,
  label: string,
  callback: () => Promise<T>,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
  operations: PrivateMutationLockOperations = DEFAULT_PRIVATE_MUTATION_LOCK_OPERATIONS,
): Promise<T> {
  const content = createMutationLockContent(observer);
  acquireMutationLock(lockPath, content, label, observer, operations);
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    return await callback();
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
    throw error;
  } finally {
    releaseMutationLock(
      lockPath,
      content,
      label,
      observer,
      callbackFailed,
      callbackError,
      operations,
    );
  }
}

/** Raised when an asynchronous callback tries to use a revoked authority. */
export class PrivateMutationPermitRevokedError extends Error {
  constructor(readonly label: string) {
    super(`${label} mutation permit is no longer active`);
    this.name = "PrivateMutationPermitRevokedError";
  }
}

/**
 * An explicit, non-inheritable authority for one asynchronous mutation.
 *
 * The permit is deliberately an object passed to callbacks instead of an
 * AsyncLocalStorage value.  A callback retained by a child promise therefore
 * observes revocation rather than inheriting a stale path-based authority.
 */
export class PrivateMutationPermit {
  readonly #label: string;
  #active = true;

  constructor(label: string) {
    if (label.length === 0) throw new Error("mutation permit label is required");
    this.#label = label;
  }

  get active(): boolean {
    return this.#active;
  }

  assertActive(): void {
    if (!this.#active) throw new PrivateMutationPermitRevokedError(this.#label);
  }

  revoke(): void {
    this.#active = false;
  }
}

/** Run a callback with a unique explicit permit and revoke it on return. */
export async function withRevocablePrivateMutationPermit<T>(
  label: string,
  callback: (permit: PrivateMutationPermit) => T | Promise<T>,
): Promise<T> {
  const permit = new PrivateMutationPermit(label);
  try {
    permit.assertActive();
    return await callback(permit);
  } finally {
    permit.revoke();
  }
}

/**
 * Acquire multiple private mutation locks in canonical lexical order.
 * Duplicate paths are collapsed so callers cannot deadlock themselves by
 * declaring the same resource through two project aliases.
 */
export async function withPrivateMutationLocksAsync<T>(
  lockPaths: readonly string[],
  label: string,
  callback: () => Promise<T> | T,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
  operations: PrivateMutationLockOperations = DEFAULT_PRIVATE_MUTATION_LOCK_OPERATIONS,
): Promise<T> {
  const paths = [...new Set(lockPaths)].sort((left, right) => left.localeCompare(right));
  let index = 0;
  const acquireNext = async (): Promise<T> => {
    const path = paths[index];
    if (path === undefined) return callback();
    index += 1;
    return withPrivateMutationLockAsync(
      path,
      `${label} ${path}`,
      acquireNext,
      observer,
      operations,
    );
  };
  return acquireNext();
}
