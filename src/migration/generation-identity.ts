import {
  backendPublicationCanonicalSha256,
  assertBackendPublicationConsumerAccess,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import {
  classifySqliteSnapshotArtifact,
  SqliteSnapshotError,
  type SqliteSnapshotClassification,
} from "./sqlite-snapshot.js";
import {
  MigrationManifestStore,
  type MigrationManifestPresence,
} from "./manifest-store.js";

/**
 * Section 4.1's stable narrow base, plus the section 4.3 two-tree occupancy
 * probe used to mint a fresh generation id. Neither reimplements a migration
 * decision: both call the exact existing classifiers (#622's snapshot
 * classification, this item's own manifest presence probe) and refuse rather
 * than guess when either cannot be established.
 *
 * **Fencing residue (section 4.9), stated rather than hidden.** The
 * publication lock this module's callers are required to hold (see
 * {@link resolveMigrationGenerationId}) binds same-host processes only. It
 * does not, and cannot, bind a second LCM installation pointed at the same
 * project, a direct `sqlite3` session opened outside LCM, or any process on
 * another host. No exclusion proof exists across those boundaries; none is
 * claimed. This is the same residue the frozen witness schema's section 10
 * records and the same one #625 and #626 state for their own fences.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const SEPARATOR = "-";
const BASE_LABEL = "sqlite-postgresql-migration";
const SET_BASE_LABEL = "cutover-set";

/**
 * The bound on how many candidate ordinals `apply` will probe before
 * refusing rather than looping. Documented in `docs/migration-operations.md`.
 * Overridable only for deterministic tests; production callers must use the
 * default.
 */
export const DEFAULT_MAX_PROBE_ORDINAL = 9999;

export type MigrationIdentityReason =
  | "invalid-input"
  | "identifier-bound-exceeded"
  | "probe-bound-exceeded"
  | "occupancy-refused";

export class MigrationIdentityError extends Error {
  readonly reason: MigrationIdentityReason;
  /** Closed, non-path, non-secret evidence string; never a raw message or cause. */
  readonly evidence: string | null;

  constructor(reason: MigrationIdentityReason, message: string, evidence: string | null = null) {
    super(message);
    this.name = "MigrationIdentityError";
    this.reason = reason;
    this.evidence = evidence;
  }
}

function invalid(message: string): never {
  throw new MigrationIdentityError("invalid-input", message);
}

export type NonSecretPostgreSqlTarget = Readonly<{
  host: string;
  port: number;
  database: string;
}>;

/**
 * Extracts only the target's non-secret coordinates from a PostgreSQL
 * connection URL: host, port, database. Never the URL itself, which may
 * carry a credential (section 4.1). `URL#username`/`#password` are never
 * read.
 */
export function nonSecretPostgreSqlTargetCoordinates(url: string): NonSecretPostgreSqlTarget {
  if (typeof url !== "string" || url.length === 0) {
    invalid("PostgreSQL target URL is missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new MigrationIdentityError("invalid-input", "PostgreSQL target URL is malformed", null);
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (host.length === 0 || database.length === 0) {
    invalid("PostgreSQL target URL is missing a host or database name");
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  // WHATWG URL parsing already rejects a port outside 0-65535 and anything
  // non-numeric, so the only invalid case reachable here is the syntactically
  // legal but semantically unusable port 0.
  if (port === 0) {
    invalid("PostgreSQL target URL has an invalid port");
  }
  return Object.freeze({ host, port, database });
}

export type MigrationGenerationBaseInput = Readonly<{
  physicalProjectId: string;
  canonicalPath: string;
  target: NonSecretPostgreSqlTarget;
}>;

/**
 * The stable, attempt-invariant base identity (section 4.1): local physical
 * project id, canonical path, and the target's non-secret coordinates only.
 * Excludes `sourceSelectionSha256` and every clock, random value, fencing
 * token and live capture (section 2.10). A configuration property alone, so
 * it cannot distinguish a second cutover from the first — {@link
 * resolveMigrationGenerationId} appends the probe ordinal that does.
 */
export function computeMigrationGenerationBase(input: MigrationGenerationBaseInput): string {
  if (typeof input?.physicalProjectId !== "string" || input.physicalProjectId.length === 0) {
    invalid("migration base identity requires a physical project id");
  }
  if (typeof input.canonicalPath !== "string" || input.canonicalPath.length === 0) {
    invalid("migration base identity requires a canonical path");
  }
  const { host, port, database } = validatedTargetCoordinates(input.target);
  const digest = backendPublicationCanonicalSha256({
    version: 1,
    kind: "migration-generation-base-identity",
    physicalProjectId: input.physicalProjectId,
    canonicalPath: input.canonicalPath,
    target: { host, port, database },
  });
  return `${BASE_LABEL}${SEPARATOR}${digest}`;
}

function validatedTargetCoordinates(target: NonSecretPostgreSqlTarget | undefined): NonSecretPostgreSqlTarget {
  const { host, port, database } = target ?? invalid("migration base identity requires a target");
  if (typeof host !== "string" || host.length === 0 || typeof database !== "string" || database.length === 0
    || !Number.isInteger(port) || port <= 0 || port > 65535) {
    invalid("migration base identity target coordinates are invalid");
  }
  return { host, port, database };
}

export type CutoverSetBaseMember = Readonly<{ physicalProjectId: string; generationId: string }>;

/**
 * The cutover-set base identity (#1548 C3): a versioned digest of the
 * target's non-secret coordinates and the sorted (project, member
 * generation) pairs. Because each member generation id carries its own
 * probe ordinal, a member whose earlier generation became occupied moves
 * the set base, and with it the set id an operator confirmed. Like the
 * single-generation base it excludes every clock, random value and live
 * capture; the set id is this base plus the probe ordinal that
 * {@link resolveMigrationGenerationId} appends.
 */
export function computeCutoverSetBase(input: Readonly<{
  target: NonSecretPostgreSqlTarget;
  members: readonly CutoverSetBaseMember[];
}>): string {
  const target = validatedTargetCoordinates(input?.target);
  if (!Array.isArray(input.members) || input.members.length === 0) {
    invalid("cutover set base identity requires members");
  }
  const members = input.members.map(({ physicalProjectId, generationId }) => {
    if (typeof physicalProjectId !== "string" || physicalProjectId.length === 0
      || typeof generationId !== "string" || generationId.length === 0) {
      invalid("cutover set base identity members require a project id and a generation id");
    }
    return { physicalProjectId, generationId };
  }).sort((left, right) => (left.physicalProjectId < right.physicalProjectId ? -1 : 1));
  if (new Set(members.map((member) => member.physicalProjectId)).size !== members.length) {
    invalid("cutover set base identity members must be distinct projects");
  }
  const digest = backendPublicationCanonicalSha256({
    version: 1,
    kind: "cutover-set-base-identity",
    target,
    members,
  });
  return `${SET_BASE_LABEL}${SEPARATOR}${digest}`;
}

/**
 * Whether `generationId` is exactly `base` plus the separator and a
 * canonical probe ordinal within the bound. A held member that is not in its
 * own base family was allocated for a different target or path.
 */
export function generationIdBelongsToBase(
  base: string,
  generationId: string,
  maxProbeOrdinal: number = DEFAULT_MAX_PROBE_ORDINAL,
): boolean {
  const prefix = `${base}${SEPARATOR}`;
  if (!generationId.startsWith(prefix)) return false;
  const ordinal = generationId.slice(prefix.length);
  return /^(0|[1-9][0-9]*)$/u.test(ordinal) && Number(ordinal) <= maxProbeOrdinal;
}

export type MigrationCandidateOccupancy =
  | Readonly<{ status: "free" }>
  | Readonly<{ status: "occupied" }>
  | Readonly<{ status: "refuse"; evidence: string }>;

export type MigrationCandidateOccupancyOperations = Readonly<{
  classifySnapshot: typeof classifySqliteSnapshotArtifact;
}>;

/**
 * Section 4.3's two-tree occupancy check for one candidate generation id.
 * Never deletes or advances anything itself; the caller decides what a
 * `refuse` or `occupied` result means for the probe loop.
 *
 * `lockToken` (section 4.9 exposure 1, layer 1) is both a compile-time proof
 * of possession and, now, a runtime-verified liveness check: this function
 * opens by calling the exported `assertBackendPublicationConsumerAccess`
 * with the token, which reaches the module-private `assertLockToken` and
 * throws `permit-mismatch` for a dummy or revoked token
 * (`backend-publication.ts:1677`, verified empirically — a fabricated token
 * object is rejected, a real token from an active
 * `withBackendPublicationAppendBarrierAsync` span is accepted). Neither
 * underlying occupancy read (`classifySqliteSnapshotArtifact`,
 * `probeManifestPresence`) consumes the token itself; this call is the sole
 * source of the liveness guarantee.
 *
 * This assertion is scoped deliberately to occupancy classification, never
 * to continuation. `assertBackendPublicationConsumerAccess` also asserts
 * ordinary consumer access, which is fenced while a non-terminal maintenance
 * hold exists (verified empirically: a genuinely live token refuses
 * `unresolved-publication` against a `maintenance-held` journal). Occupancy
 * classification only ever runs when no hold exists yet or the hold is
 * terminal (absent or `probe-fresh`, section 4.2), so the assertion is
 * exercised exactly where it is safe and never against a held journal it
 * would incorrectly refuse. Do not reuse this assertion on the continuation
 * path.
 *
 * A thrown `permit-mismatch` (or any other assertion failure) propagates
 * rather than being converted into a `refuse` result: it represents a
 * violation of this function's own calling convention — an invalid or dead
 * token — not a legitimate business outcome the probe loop should
 * interpret.
 */
export async function classifyMigrationCandidateOccupancy(input: Readonly<{
  generationId: string;
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  manifestStore?: MigrationManifestStore;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/` (see `sqlite-snapshot.ts`, `maintenance.ts`). Every
   * documented throw from `classifySqliteSnapshotArtifact` is a typed
   * `SqliteSnapshotError` (`invalid-input`, `unsupported-platform`,
   * `snapshot-io`); this default is never overridden in production.
   */
  _operationsForTesting?: Partial<MigrationCandidateOccupancyOperations>;
}>): Promise<MigrationCandidateOccupancy> {
  assertBackendPublicationConsumerAccess({ homeDir: input.homeDir, lockToken: input.lockToken });
  const classify = input._operationsForTesting?.classifySnapshot ?? classifySqliteSnapshotArtifact;
  let snapshot: SqliteSnapshotClassification;
  try {
    snapshot = await classify(input.generationId, { homeDir: input.homeDir });
  } catch (error) {
    // The real seam never throws anything else (verified at source: every
    // throw path in classifySqliteSnapshotArtifact wraps into
    // SqliteSnapshotError). An unrecognised throw shape is not converted
    // into fabricated evidence — it propagates, because guessing at its
    // meaning would be exactly the unattributable-absence defect this item
    // exists to avoid.
    if (!(error instanceof SqliteSnapshotError)) throw error;
    return { status: "refuse", evidence: `snapshot-${error.reason}` };
  }
  if (snapshot.state === "replaced" || snapshot.state === "tampered") {
    return { status: "refuse", evidence: `snapshot-${snapshot.state}` };
  }
  if (snapshot.state === "complete" || snapshot.state === "partial") {
    return { status: "occupied" };
  }
  // snapshot.state === "absent": the manifest tree still needs its own answer.
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const presence: MigrationManifestPresence = store.probeManifestPresence(input.generationId);
  if (presence.status === "present") return { status: "occupied" };
  if (presence.status === "absent") return { status: "free" };
  return { status: "refuse", evidence: `manifest-${presence.reason}` };
}

export type MigrationGenerationIdResolution = Readonly<{
  generationId: string;
  probedOrdinals: number;
}>;

/**
 * Advances the probe ordinal (section 4.1) until both trees agree a
 * candidate is free (section 4.3), refusing rather than looping when the
 * identifier bound or the probe bound would be exceeded, or either tree
 * cannot be classified.
 *
 * **Calling convention, binding (section 4.9 exposure 1):** neither this
 * function nor `classifyMigrationCandidateOccupancy` takes or checks a lock
 * token, because the trees they read (`classifySqliteSnapshotArtifact`,
 * `MigrationManifestStore.probeManifestPresence`) are themselves lock-free
 * reads by design. That means the free/occupied conclusion this function
 * reaches is a conclusion about one moment, and a concurrent local actor
 * could occupy the returned ordinal immediately afterward if nothing holds
 * the window shut. The caller (`apply`) is required to acquire the append
 * barrier (`withBackendPublicationAppendBarrierAsync`, the seam plan-v2
 * section 4.8 settled on; the retained-admission seam refuses once the
 * caller's own hold exists) **before** calling this function, and to keep the hold and the capture
 * that consume its result inside that same retained span — never call this
 * function first and acquire the token afterward. This binds same-host
 * actors only, which is the only class the publication lock binds at all;
 * that residue is stated rather than hidden. #622's capture supplies an
 * independent second defence (it re-classifies after private sampling and
 * refuses "SQLite migration generation appeared before capture binding"),
 * and the two defences are deliberately not merged — each must be able to
 * fail on its own.
 */
export async function resolveMigrationGenerationId(input: Readonly<{
  base: string;
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  manifestStore?: MigrationManifestStore;
  maxProbeOrdinal?: number;
}>): Promise<MigrationGenerationIdResolution> {
  if (typeof input?.base !== "string" || input.base.length === 0) {
    invalid("migration generation base identity is missing");
  }
  const maxProbeOrdinal = input.maxProbeOrdinal ?? DEFAULT_MAX_PROBE_ORDINAL;
  if (!Number.isInteger(maxProbeOrdinal) || maxProbeOrdinal < 0) {
    invalid("migration generation probe bound is invalid");
  }
  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  for (let ordinal = 0; ordinal <= maxProbeOrdinal; ordinal += 1) {
    const candidate = `${input.base}${SEPARATOR}${ordinal}`;
    if (candidate.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(candidate)) {
      throw new MigrationIdentityError(
        "identifier-bound-exceeded",
        "migration candidate generation id exceeds the identifier bound",
        `ordinal-${ordinal}`,
      );
    }
    const occupancy = await classifyMigrationCandidateOccupancy({
      generationId: candidate,
      homeDir: input.homeDir,
      lockToken: input.lockToken,
      manifestStore: store,
    });
    if (occupancy.status === "free") {
      return { generationId: candidate, probedOrdinals: ordinal + 1 };
    }
    if (occupancy.status === "refuse") {
      throw new MigrationIdentityError(
        "occupancy-refused",
        "migration candidate generation could not be classified",
        occupancy.evidence,
      );
    }
  }
  throw new MigrationIdentityError(
    "probe-bound-exceeded",
    "migration generation probe ordinal bound was exceeded before a free candidate was found",
    `max-${maxProbeOrdinal}`,
  );
}

export type MigrationConfirmedGenerationResolution =
  | Readonly<{ status: "confirmed"; generationId: string; probedOrdinals: number }>
  | Readonly<{ status: "refuse"; reason: "occupied-since-probe" | "unresolvable-since-probe"; evidence?: string }>;

/**
 * Section 4.9 exposure 1, layer 2: re-runs the occupancy check for the
 * already-selected candidate immediately before the hold, inside the same
 * retained span (same `lockToken`) as the original probe. The probe result
 * and this re-check are two independent observations of one fact — whether
 * the candidate is still free — and either can be corrupted on its own: a
 * test can occupy the candidate between them, or make the re-check itself
 * unresolvable, and each must be caught.
 *
 * This detects the realistic same-host window; it does not, and must not be
 * described as, a proof that no race occurred. #622's capture supplies an
 * independent third observation after private sampling and refuses "SQLite
 * migration generation appeared before capture binding" — deliberately not
 * merged with this check, so each can fail on its own.
 */
export async function resolveConfirmedMigrationGenerationId(input: Readonly<{
  base: string;
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  manifestStore?: MigrationManifestStore;
  maxProbeOrdinal?: number;
}>): Promise<MigrationConfirmedGenerationResolution> {
  const resolution = await resolveMigrationGenerationId(input);
  const recheck = await classifyMigrationCandidateOccupancy({
    generationId: resolution.generationId,
    homeDir: input.homeDir,
    lockToken: input.lockToken,
    manifestStore: input.manifestStore,
  });
  if (recheck.status === "free") {
    return { status: "confirmed", generationId: resolution.generationId, probedOrdinals: resolution.probedOrdinals };
  }
  if (recheck.status === "occupied") {
    return { status: "refuse", reason: "occupied-since-probe" };
  }
  return { status: "refuse", reason: "unresolvable-since-probe", evidence: recheck.evidence };
}
