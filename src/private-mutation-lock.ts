import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import {
  atomicWritePrivateFileExclusive,
  deleteRegularFile,
  readBoundedRegularFile,
} from "./security-files.js";

const MAX_PRIVATE_MUTATION_LOCK_BYTES = 1024;
const MAX_DISAPPEARED_OWNER_READ_RETRIES = 1;

type PrivateMutationLockOwner = {
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

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function processStartTime(
  pid: number,
  observer: PrivateMutationLockObserver,
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

  const command = currentPlatform.value === "win32" ? "powershell.exe" : "ps";
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
  if (!deleteRegularFile(ownerPath)) {
    throw new Error(`${label} lock reclamation owner disappeared before release`);
  }
  rmdirSync(claimPath);
}

function acquireMutationLock(
  lockPath: string,
  content: string,
  label: string,
  observer: PrivateMutationLockObserver,
): void {
  let disappearedOwnerReadRetries = 0;
  while (true) {
    observer("before-main-lock-publish", lockPath);
    if (atomicWritePrivateFileExclusive(lockPath, content)) return;

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

    const state = lockOwnerState(existing.owner, observer);
    if (state !== "stale") {
      const reason = state === "live" ? `owned by live PID ${existing.owner.pid}` : "owner state is ambiguous";
      throw new PrivateMutationLockContentionError(
        `${label} mutation is already in progress (${reason}); retry after the active operation completes`,
      );
    }
    const reclaimPath = `${lockPath}.reclaim-${existing.owner.nonce}`;
    acquireReclaimClaim(reclaimPath, content, label, observer);
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
      if (!deleteRegularFile(lockPath)) {
        throw new Error(`${label} lock disappeared during stale-owner recovery; retry the operation`);
      }
      observer("before-successor-lock-create", lockPath);
      if (!atomicWritePrivateFileExclusive(lockPath, content)) {
        throw new Error(`${label} mutation lock was claimed concurrently; retry the operation`);
      }
    } finally {
      releaseReclaimClaim(reclaimPath, content, label, observer);
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
    if (!deleteRegularFile(lockPath)) {
      throw new Error(`${label} mutation lock disappeared before release`);
    }
  } catch (releaseError) {
    if (!callbackFailed) throw releaseError;
  }
}

export function withPrivateMutationLock<T>(
  lockPath: string,
  label: string,
  callback: () => T,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
): T {
  const content = createMutationLockContent(observer);
  acquireMutationLock(lockPath, content, label, observer);
  let callbackFailed = false;
  try {
    return callback();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    releaseMutationLock(lockPath, content, label, observer, callbackFailed);
  }
}

export async function withPrivateMutationLockAsync<T>(
  lockPath: string,
  label: string,
  callback: () => Promise<T>,
  observer: PrivateMutationLockObserver = NOOP_PRIVATE_MUTATION_LOCK_OBSERVER,
): Promise<T> {
  const content = createMutationLockContent(observer);
  acquireMutationLock(lockPath, content, label, observer);
  let callbackFailed = false;
  try {
    return await callback();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    releaseMutationLock(lockPath, content, label, observer, callbackFailed);
  }
}
