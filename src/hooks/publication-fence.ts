import { join } from "node:path";
import {
  assertBackendPublicationConsumerAccess,
  assertBackendPublicationConfigAccess,
  assertBackendPublicationProjectMapAccess,
  backendPublicationHomeForConfigPath,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { configPath as defaultConfigPath, lcmHomeDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";
import { BackendPublicationJournalError } from "../storage/backend-publication.js";

const MAX_HOOK_EVIDENCE_BYTES = 4 * 1024 * 1024;

/** The hook token is the coordinator's token, not a parallel hook authority. */
export type HookPublicationLockToken = BackendPublicationLockToken;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function assertStableRoot(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
): void {
  const actual = assertPrivateDirectory(handle, path);
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("private directory witness changed");
  }
}

function readObservedFile(path: string, root: string): string | null {
  try {
    return readBoundedRegularFile(path, {
      allowedRoot: root,
      maxBytes: MAX_HOOK_EVIDENCE_BYTES,
      allowedModes: OWNER_ONLY_FILE_MODES,
    });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function configBackend(content: string | null): "sqlite" | "postgresql" {
  if (content === null) return "sqlite";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "config cannot be authenticated as publication evidence",
      { cause: error },
    );
  }
  if (
    parsed !== null
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && "storage" in parsed
    && parsed.storage !== null
    && typeof parsed.storage === "object"
    && !Array.isArray(parsed.storage)
    && "backend" in parsed.storage
    && parsed.storage.backend === "postgresql"
  ) {
    return "postgresql";
  }
  return "sqlite";
}

function projectMapValue(content: string | null): unknown {
  if (content === null) return {};
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new BackendPublicationJournalError(
      "unexpected-state",
      "project map cannot be authenticated as publication evidence",
      { cause: error },
    );
  }
}

function hookPublicationHome(): string {
  const homeDir = backendPublicationHomeForConfigPath(defaultConfigPath());
  if (homeDir === undefined) {
    throw new BackendPublicationJournalError(
      "unsafe-storage",
      "hook publication evidence requires the canonical LCM config path",
    );
  }
  return homeDir;
}

/**
 * Authenticate the selected terminal state while the coordinator lock token
 * is live. Passing null is intentional: it records an observed absent file;
 * undefined would omit the exact-content check altogether.
 */
function assertHookPublicationEvidence(lockToken: HookPublicationLockToken): void {
  const root = lcmHomeDir();
  const configPath = defaultConfigPath();
  const homeDir = hookPublicationHome();
  const configContent = readObservedFile(configPath, root);
  const projectMapPath = join(root, "map.json");
  const projectMapContent = readObservedFile(projectMapPath, root);

  assertBackendPublicationConsumerAccess({ homeDir, lockToken });
  assertBackendPublicationConfigAccess(
    configPath,
    configBackend(configContent),
    configContent,
    undefined,
    lockToken,
  );
  assertBackendPublicationProjectMapAccess({
    homeDir,
    content: projectMapContent,
    map: projectMapValue(projectMapContent),
    present: projectMapContent !== null,
    lockToken,
  });
}

function assertEstablishedLcmRoot(): void {
  // Bootstrap/install owns root creation. Hook admission is read-only and must
  // fail before any lock or child directory can be created.
  const root = openPrivateDirectory(lcmHomeDir());
  root.close();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

/** Authenticate topology only; unresolved publication is allowed at this boundary. */
export function assertHookRootEstablished(): void {
  assertEstablishedLcmRoot();
}

/**
 * Fence one direct synchronous hook action with the coordinator's consumer
 * lock. The callback must stay short and consume the live coordinator token
 * at its direct action boundary; network work must not retain the lock.
 */
export function withHookPublicationFence<T>(
  callback: (lockToken: HookPublicationLockToken) => T,
): T {
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  try {
    return withBackendPublicationConsumerLock(hookPublicationHome(), (lockToken) => {
      assertStableRoot(rootHandle, rootPath, rootWitness);
      assertHookPublicationEvidence(lockToken);
      const result = callback(lockToken);
      if (isThenable(result)) {
        throw new BackendPublicationJournalError(
          "unsafe-storage",
          "synchronous hook publication callback returned a promise",
        );
      }
      assertStableRoot(rootHandle, rootPath, rootWitness);
      assertHookPublicationEvidence(lockToken);
      return result;
    });
  } finally {
    try {
      assertStableRoot(rootHandle, rootPath, rootWitness);
    } finally {
      rootHandle.close();
    }
  }
}

/** Async counterpart for short local hook actions that need a live token. */
export async function withHookPublicationFenceAsync<T>(
  callback: (lockToken: HookPublicationLockToken) => Promise<T> | T,
): Promise<T> {
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  try {
    return await withBackendPublicationConsumerLockAsync(
      hookPublicationHome(),
      async (lockToken) => {
        assertStableRoot(rootHandle, rootPath, rootWitness);
        assertHookPublicationEvidence(lockToken);
        const result = await callback(lockToken);
        assertStableRoot(rootHandle, rootPath, rootWitness);
        assertHookPublicationEvidence(lockToken);
        return result;
      },
    );
  } finally {
    try {
      assertStableRoot(rootHandle, rootPath, rootWitness);
    } finally {
      rootHandle.close();
    }
  }
}

/** Consume a short admission check without retaining the lock over I/O. */
export function assertHookPublicationFence(): void {
  withHookPublicationFence((lockToken) => assertHookPublicationFenceToken(lockToken));
}

/** Validate a token at a direct action seam such as an unreffed HTTP request. */
export function assertHookPublicationFenceToken(lockToken: HookPublicationLockToken): void {
  assertHookPublicationEvidence(lockToken);
}

/** Publication errors are control-flow failures and must not be downgraded. */
export function isBackendPublicationJournalError(
  error: unknown,
): error is BackendPublicationJournalError {
  return error instanceof BackendPublicationJournalError;
}

export function isBackendPublicationEvidenceMissing(error: unknown): boolean {
  return isBackendPublicationJournalError(error) && error.reason === "publication-evidence-missing";
}

export function rethrowBackendPublicationJournalError(error: unknown): void {
  if (isBackendPublicationJournalError(error)) throw error;
}
