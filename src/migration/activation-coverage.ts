import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { projectsDir } from "../runtime-paths.js";
import { withProjectMapReconciliationLock } from "../project-map.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";
import { attributeNullableRead } from "./activation-absence.js";

/**
 * Complete-coverage refusal for backend-selection activation.
 *
 * Backend selection is configured per LCM home and installation, not per
 * project: activating a new selection changes where every project under
 * this home reads and writes, whether or not that project currently has a
 * live project-map entry. Before activation can proceed, this module must
 * be able to show that every physical project directory carrying stored
 * data is covered by the current project map -- otherwise a project could
 * silently keep writing to a backend nothing is watching.
 *
 * This is new reconciliation work: nothing in the codebase before this
 * module compared the registered project-map set against the physical
 * on-disk project directories. Two traps in project-map.ts make a naive
 * comparison unsafe, both confirmed by reading their implementations
 * rather than assumed:
 *
 * - foldProjectMapEntriesLocked (worktree reconciliation) deletes only the
 *   source hashes' *map* entries when folding them into a target entry
 *   ("for (const [hash] of entries) delete map[hash];"). It never touches
 *   the folded-away hash's physical storage directory. A folded project's
 *   directory -- and any local writer state still inside it -- persists on
 *   disk with no map entry pointing at it.
 * - populateFromExistingProjectMetadata, invoked on every strict
 *   loadProjectMapWithMetadata call (including the one
 *   withProjectMapReconciliationLock performs), scans projectsDir and can
 *   re-adopt an orphaned directory back into the map as a side effect of
 *   what looks like a plain read, purely because it still has a readable
 *   meta.json whose cwd is not already claimed by another entry.
 *   addProjectAlias can also delete a map entry
 *   ("delete target.map[adoptableOwners[0]];") to reclaim a path for an
 *   alias, again without touching the physical directory.
 *
 * Because reading the map can itself mutate it (re-adoption) or a
 * concurrent mutation could remove an entry between two separate reads, a
 * plain read (listProjectMapEntries / readProjectMapSnapshot) does not give
 * two comparisons -- map contents and on-disk directories -- a consistent,
 * atomic view of each other. This module instead enumerates the map
 * through withProjectMapReconciliationLock, the locked snapshot seam that
 * holds the project-map mutation lock for the duration of the comparison,
 * and performs its own on-disk directory enumeration inside that same
 * locked callback so nothing else can mutate the map or physically alter
 * project directories mid-comparison.
 */

export type ActivationCoverageStatus = "satisfied" | "unsatisfied" | "unresolvable";

export type ActivationCoverageReason =
  | "complete-coverage"
  | "uncovered-project-directories"
  | "projects-directory-unresolvable"
  | "project-directory-unresolvable";

/** A physical project directory with stored data but no covering
 * project-map entry. */
export type UncoveredProjectDirectory = Readonly<{
  hash: string;
  detail: string;
}>;

/** Attributed three-valued verification result. Never collapse to boolean. */
export type ActivationCoverageResult = Readonly<{
  status: ActivationCoverageStatus;
  reason: ActivationCoverageReason;
  /** Human-readable attribution for the status; always populated. */
  detail: string;
  /** Number of physical project directories with stored data that are
   * covered by the current project map. 0 when the check refused before
   * a count could be established. */
  coveredProjectCount: number;
  /** Every physical project directory with stored data that has no
   * covering project-map entry. Empty unless status is "unsatisfied" with
   * reason "uncovered-project-directories". */
  uncoveredProjectDirectories: readonly UncoveredProjectDirectory[];
}>;

export type ActivationCoverageInput = Readonly<{
  homeDir?: string;
  /** Reuse an already-active backend-publication consumer lock token
   * instead of acquiring a fresh one. Optional; see
   * withProjectMapReconciliationLock. */
  publicationLockToken?: BackendPublicationLockToken;
}>;

export type ActivationCoverageDependencies = Readonly<{
  /** Override listing the projects directory's entries. Defaults to
   * readdirSync(root, { withFileTypes: true }). This exists to test this
   * module's own "projects-directory-unresolvable" attribution branch:
   * withProjectMapReconciliationLock's real implementation already
   * performs its own unguarded readdirSync of the identical directory
   * while loading the map (see populateFromExistingProjectMetadata in
   * project-map.ts), so a genuinely unreadable projects directory fails
   * lock acquisition itself -- before this module's own read would ever
   * run. There is no synchronous fixture that can make only this read
   * fail without also breaking the seam's earlier read of the identical
   * directory; see the test suite for the explicit note on why injection
   * is used there instead of a real fixture. */
  readProjectDirectoryEntries?: (root: string) => readonly Dirent[];
}>;

const PROJECT_HASH_RE = /^[a-f0-9]{64}$/;

function buildResult(
  status: ActivationCoverageStatus,
  reason: ActivationCoverageReason,
  detail: string,
  coveredProjectCount: number,
  uncoveredProjectDirectories: readonly UncoveredProjectDirectory[],
): ActivationCoverageResult {
  return Object.freeze({
    status,
    reason,
    detail,
    coveredProjectCount,
    uncoveredProjectDirectories: Object.freeze([...uncoveredProjectDirectories]),
  });
}

function projectDatabasePath(root: string, hash: string): string {
  return join(root, hash, "db.sqlite");
}

/**
 * Assert that every physical project directory with stored data under this
 * installation's home is covered by the current project map. See the
 * module doc comment above for the two project-map traps this reconciles
 * against and why the locked snapshot seam is required rather than
 * optional.
 */
export function checkActivationProjectCoverage(
  input: ActivationCoverageInput = {},
  dependencies: ActivationCoverageDependencies = {},
): ActivationCoverageResult {
  const readProjectDirectoryEntries = dependencies.readProjectDirectoryEntries
    ?? ((root: string): readonly Dirent[] => readdirSync(root, { withFileTypes: true }));
  return withProjectMapReconciliationLock((map) => {
    const root = projectsDir(input.homeDir);
    const entriesOutcome = attributeNullableRead(() => readProjectDirectoryEntries(root));
    if (entriesOutcome.kind === "unresolvable") {
      return buildResult("unresolvable", "projects-directory-unresolvable", entriesOutcome.detail, 0, []);
    }
    // "absent" means the projects directory does not exist yet: no
    // installation has stored any project under this home, so coverage is
    // trivially complete (there is nothing to be uncovered).
    const entries = entriesOutcome.kind === "absent" ? [] : entriesOutcome.value;

    const uncovered: UncoveredProjectDirectory[] = [];
    let coveredProjectCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_HASH_RE.test(entry.name)) continue;
      const hash = entry.name;
      const statOutcome = attributeNullableRead(() => statSync(projectDatabasePath(root, hash)));
      if (statOutcome.kind === "unresolvable") {
        return buildResult(
          "unresolvable",
          "project-directory-unresolvable",
          `cannot determine whether project directory ${hash} has stored data: ${statOutcome.detail}`,
          0,
          [],
        );
      }
      // "absent" means this hash directory exists but has no db.sqlite yet
      // (an uninitialized or fully-drained project): nothing there for a
      // backend-selection change to leave uncovered.
      if (statOutcome.kind === "absent") continue;
      if (Object.hasOwn(map, hash)) {
        coveredProjectCount += 1;
      } else {
        uncovered.push({
          hash,
          detail: `project directory ${hash} has stored data but no current project-map entry covers it`,
        });
      }
    }

    if (uncovered.length > 0) {
      return buildResult(
        "unsatisfied",
        "uncovered-project-directories",
        `${uncovered.length} project director${uncovered.length === 1 ? "y has" : "ies have"} stored data but no project-map entry; activation cannot prove complete coverage`,
        coveredProjectCount,
        uncovered,
      );
    }

    return buildResult(
      "satisfied",
      "complete-coverage",
      `every physical project directory with stored data (${coveredProjectCount}) is covered by the current project map`,
      coveredProjectCount,
      [],
    );
  }, input.homeDir, input.publicationLockToken);
}
