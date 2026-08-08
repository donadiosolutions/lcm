import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { localProjectIdentity } from "../daemon/project.js";
import {
  hashProjectPath,
  normalizeProjectIdentityPath,
  normalizeProjectPath,
  resolveExistingProjectIdentity,
} from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";

function normalizeOrphanIdentityPath(cwd: string): string {
  const normalized = normalizeProjectIdentityPath(cwd);
  if (existsSync(cwd)) return normalized;

  let ancestor = resolve(cwd);
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }

  try {
    const ancestorIdentity = normalizeProjectIdentityPath(ancestor);
    return ancestorIdentity === normalizeProjectPath(ancestor) ? normalized : ancestorIdentity;
  } catch {
    return normalized;
  }
}

export function eventsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "events");
}

export function eventSequenceDbPath(homeDir?: string): string {
  return join(eventsDir(homeDir), ".machine-sequence.sqlite");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${localProjectIdentity(cwd).id}.db`);
}

/**
 * Derive a sidecar path only from identity or sidecar state that already
 * exists. This must remain read-only because callers use it while recovering
 * unavailable working directories.
 */
export function existingEventsDbPath(cwd: string): string | undefined {
  const identity = resolveExistingProjectIdentity(cwd);
  if (identity) return join(eventsDir(), `${identity.id}.db`);

  // A sidecar may outlive its map and metadata. Use the same Git-anchor-aware
  // normalization as sidecar creation, but return the hash only when the
  // sidecar is already present; no project identity is created by this
  // fallback.
  const candidate = join(eventsDir(), `${hashProjectPath(normalizeOrphanIdentityPath(cwd))}.db`);
  return existsSync(candidate) ? candidate : undefined;
}
