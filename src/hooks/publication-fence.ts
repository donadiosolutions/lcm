import { homedir } from "node:os";
import { join } from "node:path";
import {
  BackendPublicationJournalError,
  readBackendPublicationJournal,
} from "../storage/backend-publication.js";
import {
  withPrivateMutationLock,
  withPrivateMutationLockAsync,
} from "../private-mutation-lock.js";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";

/** A non-authorizing handle for one retained hook publication-lock operation. */
export type HookPublicationLockToken = object;

const activeTokens = new WeakMap<HookPublicationLockToken, { active: boolean }>();

function publicationLockPath(): string {
  // Keep the consumer admission lock outside ~/.lcm. This lets a hook verify
  // an already-established root without creating publication state as a side
  // effect, and matches the publication coordinator's shared lock boundary.
  return join(homedir(), ".lcm.backend-publication.lock");
}

function assertEstablishedLcmRoot(): void {
  // Bootstrap/install owns root creation. Hook admission is read-only and must
  // fail before any lock or child directory can be created.
  const root = openPrivateDirectory(lcmHomeDir());
  root.close();
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

function assertPublicationState(): void {
  const journal = readBackendPublicationJournal();
  if (journal === null) return;
  if (journal.phase !== "completed" && journal.phase !== "aborted") {
    throw new BackendPublicationJournalError(
      "unresolved-publication",
      "backend publication is unresolved; recover it before consuming local state",
    );
  }
}

function newToken(): HookPublicationLockToken {
  const token = {};
  activeTokens.set(token, { active: true });
  return token;
}

function revokeToken(token: HookPublicationLockToken): void {
  const state = activeTokens.get(token);
  if (state) state.active = false;
}

function assertActiveToken(token: HookPublicationLockToken): void {
  const state = activeTokens.get(token);
  if (state === undefined || !state.active) {
    throw new BackendPublicationJournalError(
      "permit-mismatch",
      "backend publication lock token is not active",
    );
  }
  assertPublicationState();
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
 * Fence one direct synchronous hook action. The callback must consume the
 * token at its direct action boundary; the lock is never retained over a
 * promise or network I/O.
 */
export function withHookPublicationFence<T>(
  callback: (lockToken: HookPublicationLockToken) => T,
): T {
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  try {
    return withPrivateMutationLock(
      publicationLockPath(),
      "backend publication consumer",
      () => {
        assertStableRoot(rootHandle, rootPath, rootWitness);
        assertPublicationState();
        const token = newToken();
        try {
          const result = callback(token);
          if (isThenable(result)) {
            revokeToken(token);
            throw new BackendPublicationJournalError(
              "unsafe-storage",
              "synchronous hook publication callback returned a promise",
            );
          }
          assertStableRoot(rootHandle, rootPath, rootWitness);
          assertPublicationState();
          return result;
        } finally {
          revokeToken(token);
        }
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

/** Async counterpart for hook boundaries that must retain admission across local async work. */
export async function withHookPublicationFenceAsync<T>(
  callback: (lockToken: HookPublicationLockToken) => Promise<T> | T,
): Promise<T> {
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  try {
    return await withPrivateMutationLockAsync(
      publicationLockPath(),
      "backend publication consumer",
      async () => {
        assertStableRoot(rootHandle, rootPath, rootWitness);
        assertPublicationState();
        const token = newToken();
        try {
          const result = await callback(token);
          assertStableRoot(rootHandle, rootPath, rootWitness);
          assertPublicationState();
          return result;
        } finally {
          revokeToken(token);
        }
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
  withHookPublicationFence((lockToken) => assertActiveToken(lockToken));
}

/** Validate a token at a direct action seam such as an unreffed HTTP request. */
export function assertHookPublicationFenceToken(lockToken: HookPublicationLockToken): void {
  assertActiveToken(lockToken);
}

/** Publication errors are control-flow failures and must not be downgraded. */
export function isBackendPublicationJournalError(
  error: unknown,
): error is BackendPublicationJournalError {
  return error instanceof BackendPublicationJournalError;
}

export function rethrowBackendPublicationJournalError(error: unknown): void {
  if (isBackendPublicationJournalError(error)) throw error;
}
