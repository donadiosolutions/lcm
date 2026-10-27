import { normalizeUuidV7 } from "../machine-identity.js";
import { normalizeProjectPath, readProjectMapSnapshot, type ProjectMap } from "../project-map.js";
import type { BackendPublicationLockToken } from "../storage/backend-publication.js";
import { canonicalSha256 } from "../storage/portable-record.js";

/**
 * projectMapWitnessSha256 (plan-v6 section 2; plan-v7 S-3 / P2): one
 * definition, two observations.
 *
 * The witness is the canonical digest of {localProjectId, remoteProjectId,
 * normalizeProjectPath(canonical)} for the generation's covered project-map
 * entry, under the domain string "lcm-migration-project-map-witness-v1".
 * remoteProjectId is always the caller's value -- the manifest's
 * destination project id -- and never read from the map: a witness that
 * digested whatever the map happened to say would certify itself. The map
 * contributes only the canonical path (and, through the predicate below,
 * the fact of being bound or unbound).
 *
 * Two modes observe the same entry at two moments and must agree:
 *
 * - "pre-publication" (#627 verify, and S5's recomputation against the
 *   report body): the entry must exist and be either unbound or already
 *   bound to exactly remoteProjectId. The map is not yet published for
 *   this generation, so an unbound entry is the expected shape; a binding
 *   to another remote is drift.
 * - "post-publication" (S16's authoritative readback): the entry must
 *   exist and be bound to exactly remoteProjectId. S13 published the map;
 *   an unbound entry or a binding to another remote means S13 did not bind
 *   what was verified.
 *
 * The predicate is checked BEFORE the digest is computed (S-3): a
 * predicate failure is a typed project-map-drift error, never a digest
 * that happens to differ, so the caller can distinguish "the map is not in
 * the state this mode requires" from "the digests disagree". When both
 * modes pass their predicate, the digests are equal iff the canonical path
 * is unchanged, because remoteProjectId is the caller's constant in both.
 *
 * Read seam, chosen deliberately: readProjectMapSnapshot. It is the
 * exported project-map read that never writes -- it loads the strict map
 * through loadProjectMap, enriches it from project metadata IN MEMORY only
 * (populateFromExistingProjectMetadata's result is returned, never
 * published), takes no project-map mutation lock and creates no backup.
 * listProjectMapEntries and withProjectMapReconciliationLock both go
 * through loadProjectMapWithMetadata, which can publish a metadata backfill
 * as a side effect of a read; neither is acceptable for a witness. The
 * read is admitted under the backend-publication consumer lock: when the
 * caller passes its retained lock token (the orchestrator's S1 barrier
 * token, or #627's consumer token) that token is reused and no new lock is
 * taken; without one, readProjectMapSnapshot acquires and releases the
 * consumer lock itself. The entry must be present in the map; an entry
 * that only the in-memory metadata backfill would have supplied is still
 * looked up by key like any other, but S4's coverage check has already
 * published such a backfill before either mode runs.
 *
 * remoteProjectId is a PostgreSQL project UUIDv7 (the only value the map
 * parser admits for a binding); it is normalized to lowercase exactly as
 * project-map.ts normalizes stored bindings, so the comparison and the
 * digest are case-insensitive in the same way the map is.
 *
 * Failures are typed: invalid-input before any I/O, project-map-drift for
 * a predicate failure (detail names the cause: entry-absent,
 * bound-to-other-remote, unbound-after-publication), and
 * project-map-unresolvable when the map read itself failed (cause
 * attached). Nothing else is thrown by this module.
 */

export const MIGRATION_PROJECT_MAP_WITNESS_DOMAIN = "lcm-migration-project-map-witness-v1";

export type MigrationProjectMapWitnessMode = "pre-publication" | "post-publication";

export type MigrationProjectMapWitnessReason = "invalid-input" | "project-map-drift" | "project-map-unresolvable";

export type MigrationProjectMapDriftCause = "entry-absent" | "bound-to-other-remote" | "unbound-after-publication";

export class MigrationProjectMapWitnessError extends Error {
  /** Populated only for project-map-drift. */
  readonly drift: MigrationProjectMapDriftCause | null;

  constructor(
    readonly reason: MigrationProjectMapWitnessReason,
    message: string,
    options: { readonly cause?: unknown; readonly drift?: MigrationProjectMapDriftCause } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MigrationProjectMapWitnessError";
    this.drift = options.drift ?? null;
  }
}

export type ComputeMigrationProjectMapWitnessInput = Readonly<{
  homeDir: string;
  /** The generation's local project hash (the project-map key). */
  localProjectId: string;
  /** The manifest's destination project id (a PostgreSQL UUIDv7); never
   * read from the map. */
  remoteProjectId: string;
  mode: MigrationProjectMapWitnessMode;
  /** Reuse an already-held backend-publication consumer lock token
   * instead of acquiring one for the read. */
  publicationLockToken?: BackendPublicationLockToken;
}>;

export type ComputeMigrationProjectMapWitnessDependencies = Readonly<{
  /** Defaults to readProjectMapSnapshot (see the module doc comment for
   * why that seam and no other). */
  readProjectMap?: (homeDir: string, publicationLockToken?: BackendPublicationLockToken) => ProjectMap;
}>;

const PROJECT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MODES: readonly MigrationProjectMapWitnessMode[] = ["pre-publication", "post-publication"];

function witnessError(
  reason: MigrationProjectMapWitnessReason,
  message: string,
  options: { readonly cause?: unknown; readonly drift?: MigrationProjectMapDriftCause } = {},
): never {
  throw new MigrationProjectMapWitnessError(reason, message, options);
}

/** Validate and return the normalized (lowercase) remote project UUIDv7. */
function validateInput(input: ComputeMigrationProjectMapWitnessInput): string {
  const remoteProjectId = typeof input?.remoteProjectId === "string" ? normalizeUuidV7(input.remoteProjectId) : null;
  if (
    typeof input !== "object"
    || input === null
    || typeof input.homeDir !== "string"
    || input.homeDir.length === 0
    || typeof input.localProjectId !== "string"
    || !PROJECT_HASH_PATTERN.test(input.localProjectId)
    || remoteProjectId === null
    || !MODES.includes(input.mode)
  ) {
    witnessError("invalid-input", "migration project map witness input is invalid");
  }
  return remoteProjectId;
}

/**
 * Pure digest over already-observed values. Exported so a reader holding
 * the three values (for example a test, or a report consumer) can
 * recompute the witness without a project-map read; the predicate is the
 * caller's responsibility on that path.
 */
export function migrationProjectMapWitnessDigest(input: Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  canonicalPath: string;
}>): string {
  return canonicalSha256([
    MIGRATION_PROJECT_MAP_WITNESS_DOMAIN,
    { localProjectId: input.localProjectId, remoteProjectId: input.remoteProjectId, canonicalPath: input.canonicalPath },
  ]);
}

/**
 * Observe the generation's project-map entry in the given mode and return
 * its witness digest. See the module doc comment for the predicate each
 * mode enforces before the digest is computed.
 */
export function computeMigrationProjectMapWitnessSha256(
  input: ComputeMigrationProjectMapWitnessInput,
  dependencies: ComputeMigrationProjectMapWitnessDependencies = {},
): string {
  const remoteProjectId = validateInput(input);
  const readProjectMap = dependencies.readProjectMap ?? readProjectMapSnapshot;

  let map: ProjectMap;
  try {
    map = readProjectMap(input.homeDir, input.publicationLockToken);
  } catch (error) {
    witnessError(
      "project-map-unresolvable",
      "the project map could not be read for the " + input.mode + " witness: " + (error as Error).message,
      { cause: error },
    );
  }

  const entry = Object.hasOwn(map, input.localProjectId) ? map[input.localProjectId] : undefined;
  if (entry === undefined) {
    witnessError(
      "project-map-drift",
      "project map has no entry for local project " + input.localProjectId + " (" + input.mode + ")",
      { drift: "entry-absent" },
    );
  }
  if (entry.remoteProjectId !== undefined && entry.remoteProjectId !== remoteProjectId) {
    witnessError(
      "project-map-drift",
      "project map entry " + input.localProjectId + " is bound to another remote project (" + input.mode + ")",
      { drift: "bound-to-other-remote" },
    );
  }
  if (input.mode === "post-publication" && entry.remoteProjectId === undefined) {
    witnessError(
      "project-map-drift",
      "project map entry " + input.localProjectId + " is still unbound after publication",
      { drift: "unbound-after-publication" },
    );
  }

  return migrationProjectMapWitnessDigest({
    localProjectId: input.localProjectId,
    remoteProjectId,
    canonicalPath: normalizeProjectPath(entry.canonical),
  });
}

