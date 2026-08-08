import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StorageBackend } from "../daemon/config.js";
import { withPrivateMutationLock, withPrivateMutationLockAsync } from "../private-mutation-lock.js";
import {
  BackendPublicationJournalError,
  backendPublicationDirectory,
  readBackendPublicationJournal,
} from "./backend-publication.js";
import { openPrivateDirectory } from "../security-files.js";

export type StorageBackendSelection = {
  backend: StorageBackend;
  homeDir?: string;
};

export type SelectedStorageBackend = { backend: "sqlite" };

export class StorageBackendUnavailableError extends Error {
  constructor(backend: "postgresql") {
    super(`The ${backend} storage backend is not available in this release; use storage.backend \"sqlite\" until PostgreSQL repository support lands.`);
    this.name = "StorageBackendUnavailableError";
  }
}

type PublicationLockToken = { readonly homeDir: string | undefined };

const activePublicationLocks = new WeakSet<PublicationLockToken>();

function publicationError(
  reason: BackendPublicationJournalError["reason"],
  message: string,
): never {
  throw new BackendPublicationJournalError(reason, message);
}

function publicationHomeForConfigPath(configPath: string): string | undefined {
  const canonical = resolve(configPath);
  const lcmRoot = resolve(dirname(canonical));
  return basename(canonical) === "config.json" && basename(lcmRoot) === ".lcm"
    ? dirname(lcmRoot)
    : undefined;
}

function publicationLockPath(homeDir: string | undefined): string {
  return join(backendPublicationDirectory(homeDir), "journal.lock");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function withPublicationLock<T>(
  homeDir: string | undefined,
  callback: (token: PublicationLockToken) => T,
): T {
  const directory = backendPublicationDirectory(homeDir);
  let directoryHandle: ReturnType<typeof openPrivateDirectory> | undefined;
  try {
    directoryHandle = openPrivateDirectory(directory);
  } catch (error) {
    if (isMissing(error)) {
      const token: PublicationLockToken = { homeDir };
      activePublicationLocks.add(token);
      try {
        return callback(token);
      } finally {
        activePublicationLocks.delete(token);
      }
    }
    return publicationError("unsafe-storage", `backend publication directory cannot be opened: ${(error as Error).message}`);
  }
  directoryHandle.close();
  const token: PublicationLockToken = { homeDir };
  activePublicationLocks.add(token);
  try {
    return withPrivateMutationLock(
      publicationLockPath(homeDir),
      "backend publication consumer",
      () => callback(token),
    );
  } finally {
    activePublicationLocks.delete(token);
  }
}

async function withPublicationLockAsync<T>(
  homeDir: string | undefined,
  callback: (token: PublicationLockToken) => Promise<T> | T,
): Promise<T> {
  const directory = backendPublicationDirectory(homeDir);
  let directoryHandle: ReturnType<typeof openPrivateDirectory> | undefined;
  try {
    directoryHandle = openPrivateDirectory(directory);
  } catch (error) {
    if (isMissing(error)) {
      const token: PublicationLockToken = { homeDir };
      activePublicationLocks.add(token);
      try {
        return await callback(token);
      } finally {
        activePublicationLocks.delete(token);
      }
    }
    return publicationError("unsafe-storage", `backend publication directory cannot be opened: ${(error as Error).message}`);
  }
  directoryHandle.close();
  const token: PublicationLockToken = { homeDir };
  activePublicationLocks.add(token);
  try {
    return await withPrivateMutationLockAsync(
      publicationLockPath(homeDir),
      "backend publication consumer",
      async () => callback(token),
    );
  } finally {
    activePublicationLocks.delete(token);
  }
}

function assertLockToken(token: PublicationLockToken, homeDir: string | undefined): void {
  if (!activePublicationLocks.has(token) || token.homeDir !== homeDir) {
    publicationError("permit-mismatch", "backend publication consumer lock is not active");
  }
}

function expectedConfigWitness(
  journal: NonNullable<ReturnType<typeof readBackendPublicationJournal>>,
): { readonly rawSha256: string | null; readonly byteLength: number } {
  const state = journal.phase === "completed" ? journal.targetState : journal.sourceState;
  return { rawSha256: state.config.rawSha256, byteLength: state.config.byteLength };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertPublicationUnlocked(
  config: StorageBackendSelection,
  content?: string | null,
): void {
  const journal = readBackendPublicationJournal(config.homeDir);
  if (journal === null) {
    if (config.backend === "postgresql") {
      return publicationError(
        "publication-evidence-missing",
        "PostgreSQL selection has no completed backend publication evidence",
      );
    }
    return;
  }
  if (journal.phase !== "completed" && journal.phase !== "aborted") {
    return publicationError(
      "unresolved-publication",
      "backend publication is unresolved; recover it before consuming local state",
    );
  }
  const expectedBackend = journal.phase === "completed" ? journal.targetBackend : journal.sourceBackend;
  if (config.backend !== expectedBackend) {
    return publicationError(
      "unexpected-state",
      "stored backend does not match completed backend publication evidence",
    );
  }
  if (content !== undefined) {
    const expected = expectedConfigWitness(journal);
    const observed = content === null ? null : sha256(content);
    const observedBytes = content === null ? 0 : Buffer.byteLength(content);
    if (observed !== expected.rawSha256 || observedBytes !== expected.byteLength) {
      return publicationError("unexpected-state", "config bytes do not match authenticated publication evidence");
    }
  }
}

/** Run a short synchronous backend-publication admission check. */
export function withStorageBackendConsumerLock<T>(
  homeDir: string | undefined,
  callback: (lockToken: object) => T,
): T {
  return withPublicationLock(homeDir, (token) => callback(token));
}

/** Run a short asynchronous backend-publication admission check. */
export async function withStorageBackendConsumerLockAsync<T>(
  homeDir: string | undefined,
  callback: (lockToken: object) => Promise<T> | T,
): Promise<T> {
  return withPublicationLockAsync(homeDir, (token) => callback(token));
}

/** Authenticate the selected backend against durable publication state. */
export function assertStorageBackendPublication(
  config: StorageBackendSelection,
  lockToken?: object,
): void {
  if (lockToken !== undefined) {
    assertLockToken(lockToken as PublicationLockToken, config.homeDir);
    return assertPublicationUnlocked(config);
  }
  return withPublicationLock(config.homeDir, () => assertPublicationUnlocked(config));
}

/** Derive the publication home only for the canonical ~/.lcm/config.json path. */
export function backendPublicationHomeForConfigPath(configPath: string): string | undefined {
  return publicationHomeForConfigPath(configPath);
}

/** Authenticate a config observation while retaining the short publication lock. */
export function assertBackendPublicationConfigAccess(
  configPath: string,
  backend: StorageBackend,
  content?: string | null,
  lockToken?: object,
): void {
  const homeDir = publicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return;
  if (lockToken !== undefined) {
    assertLockToken(lockToken as PublicationLockToken, homeDir);
    return assertPublicationUnlocked({ backend, homeDir }, content);
  }
  return withPublicationLock(homeDir, () => assertPublicationUnlocked({ backend, homeDir }, content));
}

/** Serialize config reads and publication admission without retaining locks over callers. */
export function withBackendPublicationConfigLock<T>(
  configPath: string,
  callback: (lockToken: object) => T,
): T {
  const homeDir = publicationHomeForConfigPath(configPath);
  if (homeDir === undefined) return callback({});
  const root = resolve(dirname(configPath));
  if (!existsSync(root)) {
    const token: PublicationLockToken = { homeDir };
    activePublicationLocks.add(token);
    try {
      return callback(token);
    } finally {
      activePublicationLocks.delete(token);
    }
  }
  return withPublicationLock(homeDir, (publicationToken) =>
    withPrivateMutationLock(
      `${resolve(configPath)}.lock`,
      "daemon config",
      () => callback(publicationToken),
    ));
}

/** Select the configured implementation after the caller's required preflight. */
export function selectStorageBackend(config: StorageBackendSelection): SelectedStorageBackend {
  assertStorageBackendPublication(config);
  if (config.backend === "postgresql") throw new StorageBackendUnavailableError(config.backend);
  return { backend: "sqlite" };
}

/** Select storage using the publication scope authenticated by a canonical config path. */
export function selectStorageBackendForConfig(
  configPath: string,
  config: StorageBackendSelection,
): SelectedStorageBackend {
  const homeDir = publicationHomeForConfigPath(configPath);
  if (homeDir === undefined) {
    return publicationError("unsafe-storage", "storage selection requires the canonical LCM configuration path");
  }
  return selectStorageBackend({ ...config, homeDir });
}
