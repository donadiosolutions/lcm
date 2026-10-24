import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { lcmHomeDir, projectsDir } from "../runtime-paths.js";
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
  | "project-directory-unresolvable"
  | "events-directory-unresolvable"
  | "events-file-unresolvable";

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
  /** Override listing the events directory's entries (<lcm home>/events).
   * Defaults to readdirSync(root, { withFileTypes: true }). Separate from
   * readProjectDirectoryEntries so each directory's read failure is
   * attributed to its own reason. */
  readEventsDirectoryEntries?: (root: string) => readonly Dirent[];
}>;

const PROJECT_HASH_RE = /^[a-f0-9]{64}$/;
const EVENTS_DATABASE_RE = /^([a-f0-9]{64})\.db$/;

/** The reasons an enumeration of stored-data projects can refuse: the
 * coverage reasons that attribute a read failure, never a verdict. */
export type StoredDataProjectEnumerationReason = Exclude<
  ActivationCoverageReason,
  "complete-coverage" | "uncovered-project-directories"
>;

/** The full set of project hashes with stored data under one home, or an
 * attributed refusal. Hashes are the union of hash-named directories under
 * projects/ and <hash>.db files under events/, kept only when
 * projects/<hash>/db.sqlite or events/<hash>.db exists; sorted. */
export type StoredDataProjectEnumeration = Readonly<
  | { status: "enumerated"; projectHashes: readonly string[] }
  | { status: "unresolvable"; reason: StoredDataProjectEnumerationReason; detail: string }
>;

/**
 * The one enumeration both checkActivationProjectCoverage and
 * enumerateStoredDataProjectHashes perform (plan-v7.1 G8: "the full
 * stored-data hash set from coverage's locked enumeration"). Every
 * attribution branch and detail string is exactly what the coverage check
 * reported before this was extracted; the coverage check's behaviour is
 * unchanged.
 */
function enumerateStoredDataHashes(
  root: string,
  eventsRoot: string,
  readProjectDirectoryEntries: (root: string) => readonly Dirent[],
  readEventsDirectoryEntries: (root: string) => readonly Dirent[],
): StoredDataProjectEnumeration {
  const entriesOutcome = attributeNullableRead(() => readProjectDirectoryEntries(root));
  if (entriesOutcome.kind === "unresolvable") {
    return { status: "unresolvable", reason: "projects-directory-unresolvable", detail: entriesOutcome.detail };
  }
  // "absent" means the projects directory does not exist yet: no
  // installation has stored any project under this home, so coverage is
  // trivially complete (there is nothing to be uncovered).
  const entries = entriesOutcome.kind === "absent" ? [] : entriesOutcome.value;

  const eventsOutcome = attributeNullableRead(() => readEventsDirectoryEntries(eventsRoot));
  if (eventsOutcome.kind === "unresolvable") {
    return { status: "unresolvable", reason: "events-directory-unresolvable", detail: eventsOutcome.detail };
  }
  // "absent" means the events directory does not exist yet: no events-only
  // project data can exist under this home.
  const eventEntries = eventsOutcome.kind === "absent" ? [] : eventsOutcome.value;

  const hashes = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && PROJECT_HASH_RE.test(entry.name)) hashes.add(entry.name);
  }
  for (const entry of eventEntries) {
    const match = EVENTS_DATABASE_RE.exec(entry.name);
    if (match !== null) hashes.add(match[1]!);
  }

  const withData: string[] = [];
  for (const hash of hashes) {
    const statOutcome = attributeNullableRead(() => statSync(projectDatabasePath(root, hash)));
    if (statOutcome.kind === "unresolvable") {
      return {
        status: "unresolvable",
        reason: "project-directory-unresolvable",
        detail: `cannot determine whether project directory ${hash} has stored data: ${statOutcome.detail}`,
      };
    }
    // "absent" means this hash has no db.sqlite (an uninitialized,
    // fully-drained or events-only project); its events database, if any,
    // still counts as stored data.
    if (statOutcome.kind === "absent") {
      const eventsStat = attributeNullableRead(() => statSync(join(eventsRoot, hash + ".db")));
      if (eventsStat.kind === "unresolvable") {
        return {
          status: "unresolvable",
          reason: "events-file-unresolvable",
          detail: `cannot determine whether project ${hash} has an events database: ${eventsStat.detail}`,
        };
      }
      if (eventsStat.kind === "absent") continue;
    }
    withData.push(hash);
  }
  return { status: "enumerated", projectHashes: Object.freeze([...withData].sort()) };
}

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
 *
 * A project hash has stored data when projects/<hash>/db.sqlite or
 * events/<hash>.db exists (the same two files project-map.ts's
 * existingProjectHasStoredData consults, resolved here against the given
 * home rather than the ambient one). Hashes are the union of the projects
 * directory's hash-named directories and the events directory's
 * <hash>.db files, so an events-only project, which has no projects/<hash>
 * directory, is still checked.
 */
export function checkActivationProjectCoverage(
  input: ActivationCoverageInput = {},
  dependencies: ActivationCoverageDependencies = {},
): ActivationCoverageResult {
  const readProjectDirectoryEntries = dependencies.readProjectDirectoryEntries
    ?? ((root: string): readonly Dirent[] => readdirSync(root, { withFileTypes: true }));
  const readEventsDirectoryEntries = dependencies.readEventsDirectoryEntries
    ?? ((root: string): readonly Dirent[] => readdirSync(root, { withFileTypes: true }));
  return withProjectMapReconciliationLock((map) => {
    const root = projectsDir(input.homeDir);
    const eventsRoot = join(lcmHomeDir(input.homeDir), "events");
    const enumeration = enumerateStoredDataHashes(root, eventsRoot, readProjectDirectoryEntries, readEventsDirectoryEntries);
    if (enumeration.status === "unresolvable") {
      return buildResult("unresolvable", enumeration.reason, enumeration.detail, 0, []);
    }

    const uncovered: UncoveredProjectDirectory[] = [];
    let coveredProjectCount = 0;
    for (const hash of enumeration.projectHashes) {
      if (Object.hasOwn(map, hash)) {
        coveredProjectCount += 1;
      } else {
        uncovered.push({
          hash,
          detail: `project hash ${hash} has stored data but no current project-map entry covers it`,
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

/**
 * The full stored-data project-hash set under one home (plan-v7.1 G8),
 * from exactly the enumeration checkActivationProjectCoverage performs,
 * under the same locked snapshot seam so the set cannot change under a
 * concurrent map mutation while it is taken. Returns the sorted hashes or
 * the same attributed refusal the coverage check would have reported. Pass
 * the retained publication lock token to reuse it. Run it pre-selection
 * only (G8 is a pre-selection refusal).
 */
export function enumerateStoredDataProjectHashes(
  input: ActivationCoverageInput & Readonly<{
    /** Enumerate without publishing a project-map metadata backfill (a preview must write nothing). */
    suppressMetadataBackfill?: boolean;
  }> = {},
  dependencies: ActivationCoverageDependencies = {},
): StoredDataProjectEnumeration {
  const readProjectDirectoryEntries = dependencies.readProjectDirectoryEntries
    ?? ((root: string): readonly Dirent[] => readdirSync(root, { withFileTypes: true }));
  const readEventsDirectoryEntries = dependencies.readEventsDirectoryEntries
    ?? ((root: string): readonly Dirent[] => readdirSync(root, { withFileTypes: true }));
  return withProjectMapReconciliationLock(() => enumerateStoredDataHashes(
    projectsDir(input.homeDir),
    join(lcmHomeDir(input.homeDir), "events"),
    readProjectDirectoryEntries,
    readEventsDirectoryEntries,
  ), input.homeDir, input.publicationLockToken, { suppressMetadataBackfill: input.suppressMetadataBackfill });
}

export type ActivationSingleProjectReason =
  /** The stored-data set is exactly {localProjectId}. */
  | "single-project"
  /** Other projects under this home hold stored data; one publication
   * would flip the whole home's backend for them too. */
  | "other-projects-hold-data"
  /** This generation's own project is not in the stored-data set. */
  | "local-project-has-no-data";

/** The G8 verdict (plan-v6 section 1 G8, plan-v7.1): pure, two-valued
 * because its inputs are already an attributed enumeration; an
 * unresolvable enumeration never reaches it. */
export type ActivationSingleProjectVerdict = Readonly<{
  status: "satisfied" | "unsatisfied";
  reason: ActivationSingleProjectReason;
  detail: string;
  /** Every stored-data hash other than localProjectId, sorted. */
  otherProjectHashes: readonly string[];
}>;

/**
 * Evaluate G8 over an already-taken enumeration: refuse unless the
 * stored-data set equals exactly {localProjectId}. Every other project with
 * data -- whether or not it has its own verified generation -- refuses,
 * because one publication flips the home-wide backend and
 * multi-generation publication is not built. Pure: no I/O, no lock. A
 * malformed localProjectId is a caller programming error and throws.
 */
export function evaluateActivationSingleProjectCoverage(
  input: Readonly<{ storedDataProjectHashes: readonly string[]; localProjectId: string }>,
): ActivationSingleProjectVerdict {
  if (typeof input?.localProjectId !== "string" || !PROJECT_HASH_RE.test(input.localProjectId)) {
    throw new Error("activation single-project coverage localProjectId is not a project hash");
  }
  if (!Array.isArray(input.storedDataProjectHashes)) {
    throw new Error("activation single-project coverage storedDataProjectHashes is not an array");
  }
  const others = [...new Set(input.storedDataProjectHashes)]
    .filter((hash) => hash !== input.localProjectId)
    .sort();
  const localPresent = input.storedDataProjectHashes.includes(input.localProjectId);
  if (others.length > 0) {
    return Object.freeze({
      status: "unsatisfied",
      reason: "other-projects-hold-data",
      detail: `${others.length} other project${others.length === 1 ? "" : "s"} under this home hold stored data (${others.join(", ")})`
        + (localPresent ? "" : `; this generation's project ${input.localProjectId} has none`)
        + "; one publication would flip the backend for every project, so activation refuses",
      otherProjectHashes: Object.freeze(others),
    });
  }
  if (!localPresent) {
    return Object.freeze({
      status: "unsatisfied",
      reason: "local-project-has-no-data",
      detail: `this generation's project ${input.localProjectId} has no stored data under this home`,
      otherProjectHashes: Object.freeze([]),
    });
  }
  return Object.freeze({
    status: "satisfied",
    reason: "single-project",
    detail: `the stored-data project set is exactly {${input.localProjectId}}`,
    otherProjectHashes: Object.freeze([]),
  });
}
