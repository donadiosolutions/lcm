import { lstatSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  OWNER_ONLY_FILE_MODES,
  readBoundedRegularFile,
  readBoundedRegularFileWithStat,
  requireSupportedProcessUid,
  type BoundedFileOptions,
} from "./security-files.js";

const SOURCE_FENCE_VERSION = 1;
const MAX_SOURCE_FENCE_BYTES = 1024;

export type WorktreeReconciliationFenceKind = "project" | "events";

type WorktreeReconciliationFenceValidationOptions = {
  /** @internal Event-sidecar discovery deadline; reconciliation omits it. */
  readonly _deadlineReached?: () => boolean;
  /** @internal Deterministic directory-read seam for exact-shape tests. */
  readonly _openDirectory?: typeof opendirSync;
};

type AuthenticatedRetiredProjectFenceOptions = Pick<
  BoundedFileOptions,
  | "_afterStatForTesting"
  | "_beforeReadForTesting"
  | "_beforePostStatForTesting"
  | "_beforeOpenForTesting"
>;

export const RETIRED_PROJECT_IDENTITY_DIAGNOSTIC =
  "LCM found a retired local project identity. Run `lcm project renew-retired-identity` from this project, then retry. Do not remove the reconciliation fence.";

/** Exact authenticated local-project retirement, safe for caller-specific handling. */
export class RetiredProjectIdentityError extends Error {
  constructor() {
    super(RETIRED_PROJECT_IDENTITY_DIAGNOSTIC);
    this.name = "RetiredProjectIdentityError";
  }
}

export function serializeWorktreeReconciliationFence(
  hash: string,
  kind: WorktreeReconciliationFenceKind,
): string {
  return `${JSON.stringify({ version: SOURCE_FENCE_VERSION, hash, kind })}\n`;
}

export function isWorktreeReconciliationFence(
  path: string,
  hash: string,
  kind: WorktreeReconciliationFenceKind,
  options: WorktreeReconciliationFenceValidationOptions = {},
): boolean {
  try {
    if (options._deadlineReached?.() === true) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;

    const marker = kind === "events" ? join(path, "fence.json") : path;
    if (kind === "events") {
      if (!stat.isDirectory()) return false;
      if (options._deadlineReached?.() === true) return false;
      const directory = (options._openDirectory ?? opendirSync)(path);
      try {
        const first = directory.readSync();
        if (first?.name !== "fence.json") return false;
        if (options._deadlineReached?.() === true) return false;
        if (directory.readSync() !== null) return false;
      } finally {
        directory.closeSync();
      }
    } else if (!stat.isFile()) {
      return false;
    }

    if (options._deadlineReached?.() === true) return false;
    const content = readBoundedRegularFile(marker, {
      allowedRoot: kind === "events" ? path : dirname(path),
      maxBytes: MAX_SOURCE_FENCE_BYTES,
    });
    return content === serializeWorktreeReconciliationFence(hash, kind);
  } catch {
    return false;
  }
}

/**
 * Recognize only a byte-exact project fence below a retained private projects
 * directory. Every uncertain topology remains an ordinary caller error.
 */
export function isAuthenticatedRetiredProjectIdentityFence(
  path: string,
  hash: string,
  options: AuthenticatedRetiredProjectFenceOptions = {},
): boolean {
  let parent: ReturnType<typeof openPrivateDirectory> | undefined;
  let classified = false;
  try {
    const expectedUid = requireSupportedProcessUid();
    const parentPath = dirname(path);
    parent = openPrivateDirectory(parentPath, { expectedUid });
    assertPrivateDirectory(parent, parentPath, parent.witness, expectedUid);
    const observed = readBoundedRegularFileWithStat(path, {
      allowedRoot: parentPath,
      maxBytes: MAX_SOURCE_FENCE_BYTES,
      expectedUid,
      allowedModes: OWNER_ONLY_FILE_MODES,
      requireSingleLink: true,
      ...options,
    });
    assertPrivateDirectory(parent, parentPath, parent.witness, expectedUid);
    classified = observed.parentDev === parent.witness.dev
      && observed.parentIno === parent.witness.ino
      && observed.content === serializeWorktreeReconciliationFence(hash, "project");
  } catch {
    classified = false;
  } finally {
    try { parent?.close(); } catch { classified = false; }
  }
  return classified;
}

/** Throw a fixed recovery diagnostic only for the exact retired identity. */
export function assertProjectStorageIdentityActive(path: string, hash: string): void {
  if (isAuthenticatedRetiredProjectIdentityFence(path, hash)) {
    throw new RetiredProjectIdentityError();
  }
}
