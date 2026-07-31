import { lstatSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBoundedRegularFile } from "./security-files.js";

const SOURCE_FENCE_VERSION = 1;
const MAX_SOURCE_FENCE_BYTES = 1024;

export type WorktreeReconciliationFenceKind = "project" | "events";

type WorktreeReconciliationFenceValidationOptions = {
  /** @internal Event-sidecar discovery deadline; reconciliation omits it. */
  readonly _deadlineReached?: () => boolean;
  /** @internal Deterministic directory-read seam for exact-shape tests. */
  readonly _openDirectory?: typeof opendirSync;
};

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
