import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "../daemon/project.js";
import {
  hashProjectPath,
  normalizeProjectPath,
  resolveExistingProjectIdentity,
} from "../project-map.js";
import { lcmHomeDir } from "../runtime-paths.js";

export function eventsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "events");
}

export function eventSequenceDbPath(homeDir?: string): string {
  return join(eventsDir(homeDir), ".machine-sequence.sqlite");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectPaths(cwd).id}.db`);
}

/**
 * Derive a sidecar path only from identity or sidecar state that already
 * exists. This must remain read-only because callers use it while recovering
 * unavailable working directories.
 */
export function existingEventsDbPath(cwd: string): string | undefined {
  const identity = resolveExistingProjectIdentity(cwd);
  if (identity) return join(eventsDir(), `${identity.id}.db`);

  // A sidecar may outlive its map and metadata. The legacy deterministic hash
  // remains safe to probe as long as it is returned only when the sidecar is
  // already present; no project identity is created by this fallback.
  const candidate = join(eventsDir(), `${hashProjectPath(normalizeProjectPath(cwd))}.db`);
  return existsSync(candidate) ? candidate : undefined;
}
