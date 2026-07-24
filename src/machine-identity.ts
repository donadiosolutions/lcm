import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { lcmHomeDir } from "./runtime-paths.js";
import { quoteShellArgument } from "./shell-quote.js";
import {
  atomicWritePrivateFile,
  atomicWritePrivateFileExclusive,
  ensurePrivateDirectory,
  readBoundedRegularFile,
  writePrivateFileExclusive,
} from "./security-files.js";
import {
  withPrivateMutationLock,
  type PrivateMutationLockObserver,
} from "./private-mutation-lock.js";

const MACHINE_IDENTITY_VERSION = 1 as const;
const MAX_MACHINE_IDENTITY_BYTES = 64 * 1024;
const IDENTITY_KEY_RE = /^machine:[a-f0-9]{64}$/u;
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface MachineIdentity {
  readonly version: typeof MACHINE_IDENTITY_VERSION;
  readonly identityKey: string;
  readonly machineId: string;
  readonly displayName: string;
}

export interface PendingMachineIdentity {
  readonly version: typeof MACHINE_IDENTITY_VERSION;
  readonly identityKey: string;
  readonly machineId: null;
  readonly displayName: string;
}

export type StoredMachineIdentity = MachineIdentity | PendingMachineIdentity;

export interface MachineIdentityRecoveryResult {
  readonly identity: MachineIdentity;
  readonly backupPath?: string;
}

export class MachineIdentityFileError extends Error {
  constructor(
    message: string,
    readonly remediation: string,
  ) {
    super(`${message}. ${remediation}`);
    this.name = "MachineIdentityFileError";
  }
}

export class MachineIdentityRegistrationChangedError extends MachineIdentityFileError {
  constructor() {
    super(
      "machine identity changed during registration",
      "Run `lcm machine show` and retry the registration explicitly.",
    );
    this.name = "MachineIdentityRegistrationChangedError";
  }
}

export function machineIdentityPath(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "machine.json");
}

export function oldMachineIdentitiesDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "oldmachines");
}

function machineIdentityMutationLockPath(homeDir?: string): string {
  return `${machineIdentityPath(homeDir)}.lock`;
}

export function isUuidV7(value: string): boolean {
  return normalizeUuidV7(value) !== null;
}

export function normalizeUuidV7(value: string): string | null {
  const normalized = value.toLowerCase();
  return UUIDV7_RE.test(normalized) ? normalized : null;
}

export function normalizeMachineDisplayName(value: string | undefined): string {
  const candidate = value ?? hostname();
  const normalized = candidate.trim();
  if (
    normalized.length === 0
    || normalized.length > 256
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u.test(candidate)
  ) {
    throw new MachineIdentityFileError(
      "machine display name must contain 1-256 printable characters",
      "Run `lcm machine register --name <display-name>` with a valid name.",
    );
  }
  return normalized;
}

function parseMachineIdentity(content: string): StoredMachineIdentity {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new MachineIdentityFileError(
      "machine.json contains invalid JSON",
      "Run `lcm machine recover <machine-id> --force` to replace the corrupt file.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MachineIdentityFileError(
      "machine.json must contain an object",
      "Run `lcm machine recover <machine-id> --force` to replace the invalid file.",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MACHINE_IDENTITY_VERSION) {
    throw new MachineIdentityFileError(
      `machine.json uses unsupported version ${String(record.version)}`,
      "Upgrade LCM or run `lcm machine recover <machine-id> --force` with a supported version.",
    );
  }
  if (
    typeof record.identityKey !== "string"
    || record.identityKey.length !== 72
    || !IDENTITY_KEY_RE.test(record.identityKey)
  ) {
    throw new MachineIdentityFileError(
      "machine.json contains an invalid identity key",
      "Run `lcm machine recover <machine-id> --force` to replace the invalid file.",
    );
  }
  if (typeof record.displayName !== "string") {
    throw new MachineIdentityFileError(
      "machine.json contains an invalid display name",
      "Run `lcm machine recover <machine-id> --force` to replace the invalid file.",
    );
  }
  let displayName: string;
  try {
    displayName = normalizeMachineDisplayName(record.displayName);
  } catch {
    throw new MachineIdentityFileError(
      "machine.json contains an invalid display name",
      "Run `lcm machine recover <machine-id> --force` to replace the invalid file.",
    );
  }
  const machineId = record.machineId === null
    ? null
    : typeof record.machineId === "string" ? normalizeUuidV7(record.machineId) : null;
  if (record.machineId !== null && machineId === null) {
    throw new MachineIdentityFileError(
      "machine.json contains an invalid PostgreSQL machine ID",
      "Run `lcm machine recover <machine-id> --force` to replace the stale file.",
    );
  }
  return {
    version: MACHINE_IDENTITY_VERSION,
    identityKey: record.identityKey,
    machineId,
    displayName,
  };
}

function prettyMachineIdentity(identity: StoredMachineIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

function readMachineIdentityContent(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new MachineIdentityFileError(
        "machine.json must be a regular file and may not be a symbolic link",
        "Move the unsafe path aside, then run `lcm machine recover <machine-id>`.",
      );
    }
    // Windows does not implement POSIX owner/group/other permission bits.
    // Node may still populate mode with compatibility values there, so only
    // enforce the 0600 mask on platforms where those bits are meaningful.
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new MachineIdentityFileError(
        "machine.json permissions are too broad; expected mode 0600",
        `Run \`chmod 600 -- ${quoteShellArgument(path)}\`, then retry.`,
      );
    }
    return readBoundedRegularFile(path, {
      allowedRoot: dirname(path),
      maxBytes: MAX_MACHINE_IDENTITY_BYTES,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readMachineIdentity(homeDir?: string): StoredMachineIdentity | null {
  const content = readMachineIdentityContent(machineIdentityPath(homeDir));
  return content === null ? null : parseMachineIdentity(content);
}

export function requireMachineIdentity(homeDir?: string): MachineIdentity {
  const identity = readMachineIdentity(homeDir);
  if (identity === null) {
    throw new MachineIdentityFileError(
      "machine identity is not registered",
      "Run `lcm machine register` before linking a PostgreSQL project.",
    );
  }
  if (identity.machineId === null) {
    throw new MachineIdentityFileError(
      "machine registration is pending",
      "Run `lcm machine register` again to finish the interrupted registration.",
    );
  }
  return identity;
}

export function ensurePendingMachineIdentity(
  displayName?: string,
  homeDir?: string,
  fileOperations: {
    readonly writeExclusive?: typeof atomicWritePrivateFileExclusive;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _lockObserverForTesting?: PrivateMutationLockObserver;
  } = {},
): { readonly identity: StoredMachineIdentity; readonly created: boolean } {
  return withPrivateMutationLock(
    machineIdentityMutationLockPath(homeDir),
    "machine identity",
    () => {
      const existing = readMachineIdentity(homeDir);
      if (existing !== null) return { identity: existing, created: false };
      const pending: PendingMachineIdentity = {
        version: MACHINE_IDENTITY_VERSION,
        identityKey: `machine:${randomBytes(32).toString("hex")}`,
        machineId: null,
        displayName: normalizeMachineDisplayName(displayName),
      };
      const path = machineIdentityPath(homeDir);
      const created = (fileOperations.writeExclusive ?? atomicWritePrivateFileExclusive)(
        path,
        prettyMachineIdentity(pending),
      );
      if (created) return { identity: pending, created: true };
      const winner = readMachineIdentity(homeDir);
      if (winner === null) {
        throw new MachineIdentityFileError(
          "machine identity disappeared during concurrent registration",
          "Run `lcm machine register` again.",
        );
      }
      return { identity: winner, created: false };
    },
    fileOperations._lockObserverForTesting,
  );
}

export function finalizeMachineIdentity(
  pending: StoredMachineIdentity,
  machineId: string,
  displayName: string,
  homeDir?: string,
  options: {
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _lockObserverForTesting?: PrivateMutationLockObserver;
  } = {},
): MachineIdentity {
  const normalizedMachineId = normalizeUuidV7(machineId);
  if (!normalizedMachineId) {
    throw new MachineIdentityFileError(
      "PostgreSQL returned an invalid machine ID",
      "Verify the PostgreSQL 18 schema and rerun `lcm machine register`.",
    );
  }
  const intended: MachineIdentity = {
    version: MACHINE_IDENTITY_VERSION,
    identityKey: pending.identityKey,
    machineId: normalizedMachineId,
    displayName: normalizeMachineDisplayName(displayName),
  };
  return withPrivateMutationLock(
    machineIdentityMutationLockPath(homeDir),
    "machine identity",
    () => {
      const current = readMachineIdentity(homeDir);
      if (current === null || current.identityKey !== pending.identityKey) {
        throw new MachineIdentityFileError(
          "machine identity changed during registration",
          "Run `lcm machine show` and recover the intended identity explicitly.",
        );
      }
      if (current.machineId !== null) {
        if (current.machineId !== normalizedMachineId) {
          throw new MachineIdentityFileError(
            "machine.json is stale and disagrees with PostgreSQL",
            `Run \`lcm machine recover ${normalizedMachineId} --force\` to reconcile it.`,
          );
        }
        if (
          pending.machineId === null
          || (
            current.machineId === intended.machineId
            && current.displayName === intended.displayName
          )
        ) {
          return current;
        }
      }
      if (
        current.machineId !== pending.machineId
        || current.displayName !== pending.displayName
      ) {
        throw new MachineIdentityRegistrationChangedError();
      }
      atomicWritePrivateFile(machineIdentityPath(homeDir), prettyMachineIdentity(intended));
      return intended;
    },
    options._lockObserverForTesting,
  );
}

function backupExistingMachineIdentity(homeDir?: string): string | undefined {
  const path = machineIdentityPath(homeDir);
  const content = readMachineIdentityContent(path);
  if (content === null) return undefined;
  const directory = oldMachineIdentitiesDir(homeDir);
  ensurePrivateDirectory(directory);
  const timestamp = Math.floor(Date.now() / 1000);
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const discriminator = suffix === 0 ? "" : `-${suffix}`;
    const backupPath = join(directory, `machine-${timestamp}${discriminator}.json`);
    if (writePrivateFileExclusive(backupPath, content)) return backupPath;
  }
  throw new MachineIdentityFileError(
    "could not create an exclusive backup for machine.json",
    "Move old backup files aside, then retry the forced recovery.",
  );
}

export function recoverMachineIdentity(
  identity: MachineIdentity,
  options: {
    readonly force?: boolean;
    readonly homeDir?: string;
    /** @internal Test-only synchronization seam for deterministic race coverage. */
    readonly _lockObserverForTesting?: PrivateMutationLockObserver;
  } = {},
): MachineIdentityRecoveryResult {
  const validated = parseMachineIdentity(prettyMachineIdentity(identity));
  if (validated.machineId === null) {
    throw new MachineIdentityFileError(
      "recovery requires a finalized machine identity",
      "Provide a PostgreSQL-assigned machine UUIDv7.",
    );
  }
  identity = validated;
  return withPrivateMutationLock(
    machineIdentityMutationLockPath(options.homeDir),
    "machine identity",
    () => {
      const path = machineIdentityPath(options.homeDir);
      let existing: StoredMachineIdentity | null = null;
      let invalid = false;
      try {
        existing = readMachineIdentity(options.homeDir);
      } catch (error) {
        if (!options.force) throw error;
        invalid = true;
      }
      if (!invalid && existing !== null) {
        if (
          existing.machineId === identity.machineId
          && existing.identityKey === identity.identityKey
          && existing.displayName === identity.displayName
        ) {
          return { identity: existing };
        }
        if (!options.force) {
          throw new MachineIdentityFileError(
            "machine.json already contains a different identity",
            `Run \`lcm machine recover ${identity.machineId} --force\` to replace it explicitly.`,
          );
        }
      }
      const backupPath = backupExistingMachineIdentity(options.homeDir);
      atomicWritePrivateFile(path, prettyMachineIdentity(identity));
      return { identity, backupPath };
    },
    options._lockObserverForTesting,
  );
}
