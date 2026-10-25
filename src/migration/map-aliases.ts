import { resolve } from "node:path";
import { readProjectMapSnapshot } from "../project-map.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";

/**
 * The extra alias paths a project-map entry authorizes next to its canonical
 * path: resolved, de-duplicated, without the canonical path itself, sorted.
 * One rule for the source authority (`authenticateSqliteMigrationSource`),
 * whose output the copy stream emits, and for the destination identity step,
 * which must mint exactly the same set (#1678).
 */
export function authorizedMapAliasPaths(canonicalPath: string, aliases: readonly string[]): string[] {
  return [...new Set(aliases.map((path) => resolve(path)))]
    .filter((path) => path !== canonicalPath)
    .sort();
}

/** The authorized alias paths of one persisted project-map entry, read under the caller's publication admission. */
export function readAuthorizedMapAliasPaths(input: Readonly<{
  homeDir: string;
  localProjectId: string;
  canonicalPath: string;
  publicationLockToken?: BackendPublicationLockToken;
}>): string[] {
  const entry = readProjectMapSnapshot(input.homeDir, input.publicationLockToken)[input.localProjectId];
  return authorizedMapAliasPaths(input.canonicalPath, entry?.aliases ?? []);
}
