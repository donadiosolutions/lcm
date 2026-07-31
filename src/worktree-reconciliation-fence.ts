import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBoundedRegularFile } from "./security-files.js";

const SOURCE_FENCE_VERSION = 1;
const MAX_SOURCE_FENCE_BYTES = 1024;

export type WorktreeReconciliationFenceKind = "project" | "events";

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
): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;

    const marker = kind === "events" ? join(path, "fence.json") : path;
    if (kind === "events") {
      if (!stat.isDirectory()) return false;
      const entries = readdirSync(path);
      if (entries.length !== 1 || entries[0] !== "fence.json") return false;
    } else if (!stat.isFile()) {
      return false;
    }

    const content = readBoundedRegularFile(marker, {
      allowedRoot: kind === "events" ? path : dirname(path),
      maxBytes: MAX_SOURCE_FENCE_BYTES,
    });
    JSON.parse(content);
    return content === serializeWorktreeReconciliationFence(hash, kind);
  } catch {
    return false;
  }
}
