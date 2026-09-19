import { createHash } from "node:crypto";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { PostgreSqlWorkCoordinator } from "../storage/postgresql/coordination.js";
import { verifyPostgreSqlTransferSchema } from "../storage/postgresql/runtime-readiness.js";
import {
  inspectPostgreSqlSearchConfiguration,
  POSTGRESQL_SEARCH_CONFIGURATION_SHA256,
} from "../storage/postgresql/search-configuration.js";
import {
  createPostgreSqlPortableSource, readPostgreSqlPortableSourceDomainCensus,
  readPostgreSqlPortableWitness,
} from "../storage/postgresql/portable-source.js";
import { PostgreSqlConversationRepository } from "../storage/postgresql/conversation-repository.js";
import { PostgreSqlLexicalSearchRepository } from "../storage/postgresql/lexical-search-repository.js";
import { probePostgreSqlPortableDestination } from "../storage/postgresql/portable-destination.js";
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import {
  PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_LIMITS, canonicalJson as portableCanonicalJson,
  PORTABLE_RECORD_SCHEMA_SHA256,
  type PortableDomain, type PortableRecord,
} from "../storage/portable-record.js";
import type {
  PortableCheckpoint, PortableRecordSource, PortableRecordStream, PortableRecordValueByDomain,
} from "../storage/portable-record-stream.js";
import { aggregateContentSha256 } from "../storage/portable-record-stream.js";
import { openMigrationCopySource, type MigrationCopySourceInput } from "./copy-source.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { beginMigrationEffect, completeMigrationEffect, type MigrationCheckpoint } from "./protocol.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import {
  migrationWitnessSha256,
  parseMigrationCanonicalDelta, parseMigrationCensusVector, parseMigrationDestinationIdentity,
  parseMigrationSchemaWitness,
  type MigrationCanonicalDelta, type MigrationCensusVector, type MigrationDestinationIdentity,
  type MigrationSchemaWitness,
} from "./activation-witness.js";
import {
  createMigrationVerificationReport,
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT, MIGRATION_PUBLIC_PROBE_ORDERING_SHA256,
  MIGRATION_PUBLIC_PROBE_ORDER,
  migrationMismatchClassOrdinal,
  type MigrationClassCoverageVector,
  type MigrationPublicProbeCoverageVector,
  type CreateMigrationVerificationReportInput, type MigrationMismatchClass, type MigrationQueueClassificationWitness,
  type MigrationReconciliationDomain, type MigrationSourceWitnessDigests, type MigrationVerificationMismatch,
  type MigrationVerificationMismatchTotal, type MigrationVerificationReport, type MigrationVerificationSampleParameters,
} from "./verification-report.js";
import { MigrationVerificationReportStore, type MigrationVerificationPersistOutcome } from "./verification-store.js";

/**
 * V2's replacement for census-alone gating: classes this driver actually
 * checks this pass (either as a recordable mismatch, or as a hard refuse
 * that must have already passed by the time a report is built at all --
 * destination-identity's sealed-witness check, and schema's migrations-
 * chain plus its round-1 search-configuration/collation live-to-live
 * checks, are all the latter shape) are marked ran. Every class this
 * driver defines has an implementation as of round 1 (relation and
 * ledger, plus schema's search-configuration/collation comparisons,
 * were the last additions); a class only ever moves back to not-run if
 * a future change removes its comparator, in which case this set --
 * not the report body, not a comment -- is what stops
 * `activationEligible` from being true while that gap exists.
 */
export const DRIVER_IMPLEMENTED_MISMATCH_CLASSES: ReadonlySet<MigrationMismatchClass> = new Set([
  "count", "digest", "identity", "sequence", "schema", "sample", "relation", "ledger",
]);

function buildClassCoverageVector(): MigrationClassCoverageVector {
  return MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({
    class: mismatchClass, ran: DRIVER_IMPLEMENTED_MISMATCH_CLASSES.has(mismatchClass),
  }));
}

/**
 * Round-2 follow-up to X2: the search probe's liveness has its own
 * vector, separate from classCoverage's "sample" bit, so a genuine
 * listing mismatch and a not-run search probe in the same pass have an
 * honest joint representation instead of a forced choice between
 * suppressing real evidence and crashing report construction. The
 * listing probe always runs unconditionally; the search probe's ran bit
 * is this pass's actual outcome. See
 * MIGRATION_PUBLIC_PROBE_ORDER's own comment for the reasoning.
 */
function buildPublicProbeCoverageVector(searchProbeRan: boolean): MigrationPublicProbeCoverageVector {
  return MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({
    probe, ran: probe === "public-listing" ? true : searchProbeRan,
  }));
}

/**
 * The #624 verification driver: plan-v4.md section 2's frozen ordering.
 *
 * Scope note, stated plainly rather than left implicit: this pass reconciles
 * counts, the census, the canonical delta, the destination schema witness
 * (migrations/search-configuration/collation/sequence-state), destination
 * identity, foreign-key edge-set equality plus a dangling-reference guard
 * (the `relation` class), and the transfer ledger's run/batch/identity
 * state (the `ledger` class) end-to-end against a live PostgreSQL
 * destination. It does not yet independently reconcile summary-parent-links
 * acyclicity or ordinal contiguity/seq monotonicity as their own checks
 * (edge-set equality catches a wrong parent, but not a structurally cyclic
 * or gapped chain of otherwise-correct edges); the "public reads" step runs
 * a representative ordered-listing probe rather than every repository read
 * path. These are flagged to the owner as a stated scope reduction for this
 * pass, not silently assumed complete.
 */

export type MigrationVerificationDriverReason =
  | "invalid-input"
  | "destination-drift"
  | "lease-unavailable"
  | "report-identity-conflict";

export class MigrationVerificationDriverError extends Error {
  constructor(
    readonly reason: MigrationVerificationDriverReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationVerificationDriverError";
  }
}

function driverError(
  reason: MigrationVerificationDriverReason,
  message: string,
  options?: ErrorOptions,
): never {
  throw new MigrationVerificationDriverError(reason, message, options);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic sentinel for a domain with zero records; never null, per the frozen schema. */
function emptyTerminalIdentitySha256(domain: PortableDomain): string {
  return migrationWitnessSha256(["lcm-migration-verification-empty-domain-terminal-v1", domain]);
}

// --- Step 2: destination identity and schema witnesses ---------------------

async function captureDestinationIdentity(
  executor: PostgreSqlQueryExecutor, projectId: string, signal?: AbortSignal,
): Promise<MigrationDestinationIdentity> {
  const sealedWitnessSha256 = await readPostgreSqlPortableWitness(executor, projectId, signal);
  const result = await executor.query<{ system_identifier: string }>({
    text: "SELECT system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()",
  }, { domain: "factory", operation: "verifyGenerationDestinationIdentity", signal });
  const systemIdentifier = result.rows[0]?.system_identifier;
  if (typeof systemIdentifier !== "string" || !/^(0|[1-9][0-9]*)$/u.test(systemIdentifier)) {
    driverError("invalid-input", "destination system identifier is invalid");
  }
  return parseMigrationDestinationIdentity({ version: 1, sealedWitnessSha256, systemIdentifier });
}

async function captureCollationSha256(executor: PostgreSqlQueryExecutor, signal?: AbortSignal): Promise<string> {
  // Collation-sensitive columns are the text columns compared or ordered by
  // portable-mapping.ts's canonical row queries (COLLATE "C" locator/key
  // expressions rely on database default collation for value comparisons).
  const result = await executor.query<{ collname: string; collcollate: string; collctype: string; collprovider: string }>({
    text: "SELECT c.collname, c.collcollate, c.collctype, c.collprovider "
      + "FROM pg_catalog.pg_collation c "
      + "JOIN pg_catalog.pg_database d ON d.datcollate OPERATOR(pg_catalog.=) c.collcollate "
      + "AND d.datctype OPERATOR(pg_catalog.=) c.collctype "
      + "WHERE d.datname OPERATOR(pg_catalog.=) current_database() "
      + "ORDER BY c.collname",
  }, { domain: "factory", operation: "verifyGenerationCollation", signal });
  return sha256Hex(portableCanonicalJson(["lcm-migration-verification-collation-v1", result.rows]));
}

async function captureSequenceStateSha256(executor: PostgreSqlQueryExecutor, signal?: AbortSignal): Promise<string> {
  const result = await executor.query<{ sequence_name: string; is_called: boolean; start_value: string; increment_by: string }>({
    text: "SELECT c.relname AS sequence_name, s.seqstart::text AS start_value, s.seqincrement::text AS increment_by, "
      + "pg_catalog.pg_sequence_last_value(c.oid) IS NOT NULL AS is_called "
      + "FROM pg_catalog.pg_class c "
      + "JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace "
      + "JOIN pg_catalog.pg_sequence s ON s.seqrelid OPERATOR(pg_catalog.=) c.oid "
      + "WHERE n.nspname OPERATOR(pg_catalog.=) 'lcm' AND c.relkind OPERATOR(pg_catalog.=) 'S' "
      + "ORDER BY c.relname",
  }, { domain: "factory", operation: "verifyGenerationSequenceState", signal });
  return sha256Hex(portableCanonicalJson(["lcm-migration-verification-sequence-state-v1", result.rows]));
}

/**
 * Round-1 P2: migrationsSha256 must witness what the destination's own
 * migration ledger actually records as applied, not what the currently
 * running binary happens to bundle. loadPostgreSqlMigrations() reflects
 * this process's compiled-in migration set, which can legitimately
 * differ from the destination's own lcm.schema_migrations history (a
 * different LCM version ran the copy, for instance) -- comparing the
 * bundle's digest against the frozen expected value would validate the
 * wrong thing whenever that happens, agreeing or disagreeing with the
 * expected value for a reason unrelated to what is actually on the
 * destination.
 */
async function captureAppliedMigrationsSha256(
  executor: PostgreSqlQueryExecutor, signal?: AbortSignal,
): Promise<string> {
  const result = await executor.query<{ id: string; checksum_sha256: string }>({
    text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id",
  }, { domain: "factory", operation: "verifyGenerationAppliedMigrations", signal });
  return sha256Hex(portableCanonicalJson(
    result.rows.map(({ id, checksum_sha256: checksum }) => ({ id, sha256: checksum })),
  ));
}

/**
 * Round-1 P3: distinguishes why the search configuration's digest is
 * unreadable rather than collapsing every cause to one "absent" message.
 * v3.4's unattributable-NULL shape applies here just as it does to the
 * sequence witness: a NULL actualSha256 can mean the configuration was
 * never created (objectCount 0) or that it exists but fails its
 * ownership/definition contract (objectCount > 0, ownershipReady false,
 * or the function/mapping shape does not match) -- two different
 * failures an operator would investigate differently, and treating both
 * as "absent" would misdirect that investigation.
 */
function searchConfigurationAbsentReason(status: Readonly<{ objectCount: number; ownershipReady: boolean }>): string {
  return status.objectCount === 0
    ? "destination search configuration is absent"
    : "destination search configuration is present but does not satisfy its ownership or definition contract";
}

async function captureDestinationSchemaWitness(
  executor: PostgreSqlQueryExecutor, signal?: AbortSignal,
): Promise<MigrationSchemaWitness> {
  const migrationsSha256 = await captureAppliedMigrationsSha256(executor, signal);
  const searchStatus = await inspectPostgreSqlSearchConfiguration(executor, { signal });
  if (searchStatus.actualSha256 === null) driverError("invalid-input", searchConfigurationAbsentReason(searchStatus));
  // Round-3 P2: the in-window comparison below (assertSchemaWitnessLiveToLive)
  // only proves the pre-window and in-window reads agree with each
  // other -- it says nothing about whether either read is *correct*.
  // A search configuration that is stable but wrong (installed from a
  // different migration revision, hand-edited, or never updated to
  // match this build's expectation) would pass live-to-live cleanly
  // while never having been the configuration this driver's own
  // contract expects. Pinning the pre-window read against the same
  // compiled-in digest the schema installer itself enforces closes
  // that gap: a stable-wrong value now refuses here, before the window
  // even opens, rather than silently becoming "expected" for the rest
  // of the pass.
  if (searchStatus.actualSha256 !== POSTGRESQL_SEARCH_CONFIGURATION_SHA256) {
    driverError("invalid-input", "destination search configuration digest does not match the pinned lcm.search_v1 contract");
  }
  const [collationSha256, sequenceStateSha256] = await Promise.all([
    captureCollationSha256(executor, signal),
    captureSequenceStateSha256(executor, signal),
  ]);
  return parseMigrationSchemaWitness({
    version: 1, migrationsSha256, searchConfigurationSha256: searchStatus.actualSha256,
    collationSha256, sequenceStateSha256,
  });
}

// --- Step 5: public reads outside the window --------------------------------

/**
 * Frozen witness-schema v3.2's audit table row: searchConfigurationSha256
 * and collationSha256 are "compared against the live destination values,
 * live-to-live", refusing because "the census cannot see this drift". No
 * caller-supplied expected value exists for either -- unlike migrations,
 * neither has a manifest-sealed baseline from copy time -- so "live-to-
 * live" here means what it says literally: the value captured once before
 * the window (captureDestinationSchemaWitness, step 2) compared against a
 * second live read taken from inside the fenced window itself, on the
 * borrowed read-only session. A destination whose search configuration or
 * collation changed between those two reads -- exactly the drift the
 * census's row-level comparison cannot see -- refuses here instead of
 * silently publishing a clean report against a schema the window never
 * actually held constant.
 *
 * Round-4: system_identifier and the migrations chain digest were both
 * captured once before the lease was even acquired (captureDestinationIdentity
 * and captureAppliedMigrationsSha256, step 2) and never rechecked --
 * unlike search configuration and collation, both of these DO have a
 * pre-window comparison (against expectedSystemIdentifier and
 * destinationMigrationsSha256 respectively), but neither of those
 * comparisons says anything about whether the value was still true once
 * the window actually opened. A failover between the pre-lease read and
 * the window would change system_identifier; a migration committing in
 * that same interval would change the migrations chain -- either would
 * let the report certify census rows read from a destination that was
 * no longer the one identity-witnessed and schema-witnessed at step 2.
 * Both are now rechecked live-to-live here too, closing the interval
 * this function's own name already promised to cover but did not.
 */
async function assertSchemaWitnessLiveToLive(
  session: PostgreSqlSnapshotSession, expected: MigrationSchemaWitness, expectedSystemIdentifier: string, signal?: AbortSignal,
): Promise<void> {
  const [searchStatus, collationSha256, migrationsSha256, systemIdentifierResult] = await Promise.all([
    inspectPostgreSqlSearchConfiguration(session, { signal }),
    captureCollationSha256(session, signal),
    captureAppliedMigrationsSha256(session, signal),
    session.query<{ system_identifier: string }>({
      text: "SELECT system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()",
    }, { domain: "factory", operation: "verifyGenerationDestinationIdentityLiveToLive", signal }),
  ]);
  if (searchStatus.actualSha256 === null) driverError("invalid-input", searchConfigurationAbsentReason(searchStatus));
  if (searchStatus.actualSha256 !== expected.searchConfigurationSha256) {
    driverError("destination-drift", "destination search configuration changed inside the fenced verification window");
  }
  if (collationSha256 !== expected.collationSha256) {
    driverError("destination-drift", "destination collation changed inside the fenced verification window");
  }
  if (migrationsSha256 !== expected.migrationsSha256) {
    driverError("destination-drift", "destination migrations chain changed inside the fenced verification window");
  }
  if (systemIdentifierResult.rows[0]?.system_identifier !== expectedSystemIdentifier) {
    driverError("destination-drift", "destination system identifier changed inside the fenced verification window");
  }
}

/**
 * Millisecond-precision ISO-8601 UTC, matching what `pg` gives back for a
 * `timestamptz` column via `Date#toISOString()`. Source timestamps are
 * six-digit microsecond strings; comparing at millisecond precision is the
 * honest ceiling, since the real repository path returns a JS `Date` and
 * can carry no more precision than that -- the probe's job is to catch a
 * broken read path, not to out-resolve what that path can express.
 */
function truncateToMillisecondIso(value: string): string {
  return value.slice(0, 23) + "Z";
}

/** One source "conversations" record's public-listing-relevant projection, in canonical order. */
export type MigrationPublicListingSourceEntry = Readonly<{
  createdAt: string;
  identitySha256: string;
  /**
   * Round-4 P2: the destination's native listConversations() read has
   * no field in common with the source's portable identitySha256 --
   * they are different identity spaces, the same shape as the search
   * probe's correlation problem, and adding the destination-native
   * conversationId into this digest would compare a value one side can
   * never produce, closing nothing. title, unlike conversationId, is a
   * plain scalar copied verbatim by the copy (see
   * portable-mapping.ts's fields("... title ...") with no transform,
   * and portable-source.ts's canonicalJson(value.title) on the read
   * side), so it exists unchanged on both the source's canonical record
   * and the destination's row. Folding it into both sides distinguishes
   * two destination rows sharing a millisecond whenever their titles
   * differ, without any ledger correlation and without adding a query.
   * It is still a probe, not a proof: two same-millisecond
   * conversations that also share a title remain indistinguishable by
   * this check alone.
   */
  title: string | null;
}>;

/**
 * One source "messages" record's search-probe candidate projection: its
 * position in the canonical forward-pass stream (0-indexed, the first
 * message encountered is ordinal 0) and its content, which the step 5
 * search probe uses as a self-match query against the destination. Only
 * the first MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE messages ever
 * become candidates -- see StreamedSourceCheckpoints.searchProbeCandidates
 * for why capturing every message's content for the whole domain is not
 * done.
 */
export type MigrationSearchProbeSourceEntry = Readonly<{ ordinal: number; identitySha256: string; content: string }>;

/**
 * Bound on how many "messages" records become search-probe candidates.
 * Capturing every message's content for the whole domain in memory would
 * materially add to the exact per-record read cost this item measured
 * and documented as dominant (docs/migration-cutover.md's census-cost
 * section): a project's messages domain is its largest in practice (the
 * measured fixture alone has 4,502). A small, fixed-size candidate pool
 * keeps this probe's cost negligible regardless of project size, at the
 * cost of only ever considering the first of a project's messages as
 * candidates -- acceptable because the probe only needs *some* content
 * known to be present, not a representative sample of the whole domain.
 */
export const MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE = 25;

/**
 * The step 5 ordered-listing probe now runs through the real repository
 * (PostgreSqlConversationRepository.listConversations, the exact production
 * read path -- not hand-written SQL that would only re-test a copy of the
 * ordering logic) and is compared against expectedOrder, derived from the
 * source's own canonical records during step 1 rather than assumed. A
 * mismatch is recorded as a sample-class mismatch on the public-listing
 * pseudo-domain; a clean probe contributes nothing (equality is not itself
 * evidence worth persisting). Full parity with every public repository
 * read remains out of scope for this pass (see the module-level scope
 * note); this establishes the pattern for the one probe plan-v4 names.
 *
 * Per witness-schema-FROZEN-v3.3.md section 6.1, a sample mismatch's
 * identitySha256 is pinned to exactly the sampled record's portable
 * identity digest plus its canonical ordinal -- never a hash of two
 * aggregate probe digests, differing values, a diff shape, a rank, or a
 * query string. The "sampled record" is the source's own record at the
 * first position the two orders diverge, which is the earliest point a
 * reader can name a single concrete record responsible for the mismatch.
 * The pair is folded into the single identitySha256 hash below
 * (migrationWitnessSha256(["sample", identity, ordinal])); the ordinal
 * has no separate field of its own on MigrationVerificationMismatch,
 * since that type carries only domain, class and identitySha256.
 */
/**
 * Round-2 P3: a fixed marker, not a hash of actualOrder.length. The
 * "empty source vs non-empty destination" case names one kind of
 * mismatch, not a distinct one per destination row count -- folding
 * the count into the identity would let a reader infer how many
 * destination rows exist from the digest alone, which is exactly the
 * kind of leak the redaction ceiling (domain plus class plus identity
 * digest, never a value) exists to prevent. There is no single "the
 * sampled record" to name here, since the source has none, so a
 * versioned constant is the honest identity rather than a
 * manufactured one.
 */
export const MIGRATION_SAMPLE_EMPTY_SOURCE_IDENTITY_SHA256 = migrationWitnessSha256(["sample-empty-source"]);

async function runOrderedListingProbe(
  executor: PostgreSqlRuntime, projectId: string,
  expectedOrder: readonly MigrationPublicListingSourceEntry[], signal?: AbortSignal,
): Promise<{ mismatch: MigrationVerificationMismatch | null; publicListingSha256: string }> {
  const repository = new PostgreSqlConversationRepository(executor, projectId);
  const rows = await repository.listConversations();
  const actualOrder = rows.map((row) =>
    [truncateToMillisecondIso(row.createdAt.toISOString()), row.title] as const);
  const publicListingSha256 = sha256Hex(portableCanonicalJson(["lcm-migration-verification-public-listing-v1", actualOrder]));
  const expectedEntries = expectedOrder.map((entry) => [entry.createdAt, entry.title] as const);
  const expectedSha256 = sha256Hex(portableCanonicalJson(["lcm-migration-verification-public-listing-v1", expectedEntries]));
  if (expectedSha256 === publicListingSha256) return { mismatch: null, publicListingSha256 };
  // An empty expected (source) order can only reach here when the actual
  // (destination) order disagrees, since two empty arrays hash equal and
  // return above -- so this is a real mismatch: a legitimately empty
  // source domain against a non-empty destination listing. Round-1 P1:
  // Math.min(ordinal, expectedOrder.length - 1) was Math.min(0, -1) = -1
  // here, and expectedOrder[-1] is undefined, so reading
  // sampledRecord.identitySha256 threw before the report was ever built --
  // a crash instead of a refusal or a report, for exactly the kind of
  // legitimately empty domain this driver must be able to report on.
  if (expectedOrder.length === 0) {
    return {
      publicListingSha256,
      mismatch: {
        domain: "public-listing", class: "sample",
        identitySha256: MIGRATION_SAMPLE_EMPTY_SOURCE_IDENTITY_SHA256,
      },
    };
  }
  // The first position where the two orders diverge, clamped so a length
  // difference still names a real source record rather than indexing
  // past the end of whichever side ran out first.
  let ordinal = 0;
  while (
    ordinal < expectedEntries.length && ordinal < actualOrder.length
    && expectedEntries[ordinal]![0] === actualOrder[ordinal]![0]
    && expectedEntries[ordinal]![1] === actualOrder[ordinal]![1]
  ) ordinal += 1;
  const sampledRecord = expectedOrder[Math.min(ordinal, expectedOrder.length - 1)]!;
  return {
    publicListingSha256,
    mismatch: {
      domain: "public-listing", class: "sample",
      // Schema v3.3 section 6.1: the sampled record's portable identity
      // digest plus its canonical ordinal, and nothing else.
      identitySha256: migrationWitnessSha256(["sample", sampledRecord.identitySha256, ordinal]),
    },
  };
}

/**
 * Outcome of the step 5 lcm.search_v1 search probe: "ran" when some
 * candidate's own content produced a non-empty search_v1 result on the
 * destination (self-match, proving the search path and configuration
 * actually find content independently known to be present); "not run"
 * when every candidate in the pool exhausted the attempt cap without a
 * single non-empty result. This is an attributed absence, not a
 * mismatch: a probe with no ground truth on which candidates *should*
 * tokenize to a searchable term cannot distinguish "search is broken"
 * from "every sampled candidate's content happens not to index to
 * anything", so it does not guess. It reports what it could not
 * evaluate and lets classCoverage's sample bit -- driven by this
 * outcome, not a static declaration -- refuse eligibility instead.
 */
export type MigrationSearchProbeOutcome =
  | Readonly<{ ran: true; chosenOrdinal: number; notRunReason: null }>
  | Readonly<{ ran: false; chosenOrdinal: null; notRunReason: string }>;

/**
 * Runs before the window, through the real
 * PostgreSqlLexicalSearchRepository (never hand-written SQL), exactly
 * like the listing probe above uses the real conversation repository.
 * Walks the candidate pool starting at an index derived from
 * seedBasisSha256 (giving sampleParameters' bound seed a real purpose
 * rather than the decorative one round-2 review found), wrapping within
 * the pool, trying each candidate's own content as a project-scoped
 * full-text query until one comes back non-empty. No cross-engine
 * ground truth is needed or computed: this asserts a message finds
 * itself, not that this driver's own re-derivation of lcm.search_v1's
 * tokenization agrees with PostgreSQL's -- exactly the second-
 * implementation drift this item has rejected twice for other classes.
 */
/**
 * Round-4 P1: a bare non-empty result was previously accepted as "ran",
 * with no check that the result was the *candidate's own* message. A
 * search path that ignores its query, uses the wrong configuration, or
 * returns some unrelated fixed result would pass every attempt in the
 * pool, since "some row came back" was the entire test -- exactly the
 * defect a self-match probe exists to catch. Fixed by correlating the
 * candidate's source-space identitySha256 to the destination's native
 * message_id through lcm.transfer_identities (the only place that
 * mapping is recorded) and requiring that native key to actually appear
 * among the search results, not merely that the results are non-empty.
 *
 * This borrows trust from one ledger row per candidate tried: a false
 * pass now requires two coordinated corruptions -- a broken search
 * *and* a transfer_identities row that happens to name exactly the
 * message the broken search returned. That conjunction is recorded here
 * and in witness-audit.ts rather than left for a reader to reconstruct.
 * Per the frozen absence rule, an unattributable correlation (no row,
 * because run_id is missing entirely, or a candidate's identity has no
 * matching row) is never treated as a pass: it makes that source of
 * evidence unusable for this candidate, and the walk moves on to the
 * next one, exactly as it already does for a search that came back
 * empty. Only a correlated, confirmed self-match ever reports ran:true.
 *
 * The transfer_runs/transfer_identities reads here are a second,
 * separate read of the same immutable post-copy evidence the ledger
 * class reads inside the fenced window -- not a restatement of the
 * ledger check and not itself the ledger's cardinality/injectivity
 * reconciliation. Bounded by the same fixed-size candidate pool as
 * before, so the added cost is at most one transfer_runs lookup plus
 * one transfer_identities lookup per attempt, never proportional to
 * domain size.
 */
export async function runSearchSelfMatchProbe(
  executor: PostgreSqlRuntime, projectId: string, targetGenerationId: string,
  candidates: readonly MigrationSearchProbeSourceEntry[], seedBasisSha256: string, signal?: AbortSignal,
): Promise<MigrationSearchProbeOutcome> {
  if (candidates.length === 0) {
    return { ran: false, chosenOrdinal: null, notRunReason: "no source messages are available to search-probe" };
  }
  const runResult = await executor.query<{ run_id: string }>({
    text: "SELECT run_id FROM lcm.transfer_runs WHERE project_id = $1::uuid AND target_generation = $2",
    values: [projectId, targetGenerationId],
  }, { domain: "factory", operation: "verifyGenerationSearchProbeRun", signal });
  const runId = runResult.rows[0]?.run_id;
  if (runId === undefined) {
    // No source of correlation exists at all: every candidate would be
    // unattributable, so there is no point walking the pool.
    return {
      ran: false, chosenOrdinal: null,
      notRunReason: "no completed transfer run was found to correlate search-probe candidates against",
    };
  }
  const repository = new PostgreSqlLexicalSearchRepository(executor, projectId);
  const seedIndex = Number.parseInt(seedBasisSha256.slice(0, 8), 16) % candidates.length;
  let unattributedAttempts = 0;
  let unconfirmedAttempts = 0;
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const candidate = candidates[(seedIndex + attempt) % candidates.length]!;
    const identityResult = await executor.query<{ native_key: string }>({
      text: "SELECT native_key FROM lcm.transfer_identities WHERE run_id = $1 AND domain = 'messages' AND identity_sha256 = $2",
      values: [runId, candidate.identitySha256],
    }, { domain: "factory", operation: "verifyGenerationSearchProbeCorrelation", signal });
    if (identityResult.rows.length !== 1) {
      // Zero rows: this candidate's identity was never recorded in the
      // ledger, so no destination-native key exists to check search
      // results against -- unattributable, not evidence either way.
      // More than one row cannot occur under this table's own primary
      // key (run_id, domain, identity_sha256), but is still checked
      // rather than assumed, per the same discipline as the sequence
      // witness's privilege-versus-never-called split.
      unattributedAttempts += 1;
      continue;
    }
    const expectedNativeKey = identityResult.rows[0]!.native_key;
    const results = await repository.searchMessages({
      query: candidate.content, mode: "full_text" as const, limit: 1,
    });
    if (results.some((result) => String(result.messageId) === expectedNativeKey)) {
      return { ran: true, chosenOrdinal: candidate.ordinal, notRunReason: null };
    }
    unconfirmedAttempts += 1;
  }
  return {
    ran: false, chosenOrdinal: null,
    notRunReason: `none of ${candidates.length} candidates confirmed a correlated self-match `
      + `(${unattributedAttempts} unattributable, ${unconfirmedAttempts} searched but not confirmed) within the attempt cap`,
  };
}

// --- Steps 6-7: the single fenced census window ------------------------------

export type MigrationVerificationDomainCensus = Readonly<{
  domain: PortableDomain;
  recordCount: number;
  prefixSha256: string;
  terminalIdentitySha256: string | null;
}>;

function dependencyEdgeKey(childIdentitySha256: string, parentDomain: string, parentIdentitySha256: string): string {
  return childIdentitySha256 + "|" + parentDomain + "|" + parentIdentitySha256;
}

/** Shared by the source stream pass and the destination page walk: both read
 * PortableRecord.dependencies, already computed by the existing
 * canonicalisation path on both sides, never recomputed here. */
function collectDependencyEdges(record: PortableRecord, into: Set<string>): void {
  for (const dependency of record.dependencies) {
    into.add(dependencyEdgeKey(record.identitySha256, dependency.domain, dependency.identitySha256));
  }
}

export interface MigrationFencedDestinationRead {
  readonly census: readonly MigrationVerificationDomainCensus[];
  readonly dependencyEdges: ReadonlyMap<PortableDomain, ReadonlySet<string>>;
  readonly recordIdentities: ReadonlyMap<PortableDomain, ReadonlySet<string>>;
}

/**
 * Runs entirely inside the caller's borrowed read-only snapshot session.
 * This function receives only that session: it has no lexical access to a
 * PostgreSqlRuntime, a PostgreSqlWorkCoordinator, or any transaction-scope
 * executor, so calling a lease method or opening a read-committed-read-write
 * transaction from here is not a code-review question but a compile error.
 * Nothing here may call session.close(); the caller owns that lifetime.
 *
 * Also walks every record of every domain a second time through
 * readDomainPage -- an existing, approved read on the already-open
 * PortableRecordSource, never new digest logic -- to collect each record's
 * already-computed dependencies for the relation class. This is real
 * additional cost inside the same window and the same already-open
 * source, not a second createPostgreSqlPortableSource open (which would
 * double the eager per-domain boundary computation that already happened
 * when this source was constructed).
 */
export async function readFencedDestinationCensus(
  session: PostgreSqlSnapshotSession,
  input: Readonly<{
    settings: PostgreSqlConnectionSettings; expectedOwner: string; expectedIdentity: StorageIdentityContext;
    scratchParent: string; signal?: AbortSignal;
  }>,
): Promise<MigrationFencedDestinationRead> {
  const destinationSource = await createPostgreSqlPortableSource({
    settings: input.settings, expectedOwner: input.expectedOwner, expectedIdentity: input.expectedIdentity,
    scratchParent: input.scratchParent, signal: input.signal, session,
  });
  try {
    const census = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => readPostgreSqlPortableSourceDomainCensus(destinationSource, domain));
    const { dependencyEdges, recordIdentities } = await readDestinationDependencyEdges(destinationSource, input.signal);
    return { census, dependencyEdges, recordIdentities };
  } finally {
    // Borrowed session: this must never close it. Verified by
    // test/storage/postgresql-portable-source-borrowed-session.test.ts and
    // by this module's own crash/error-path tests.
    await destinationSource.close();
  }
}

async function readDestinationDependencyEdges(
  destinationSource: PortableRecordSource, signal?: AbortSignal,
): Promise<{ dependencyEdges: Map<PortableDomain, Set<string>>; recordIdentities: Map<PortableDomain, Set<string>> }> {
  const dependencyEdges = new Map<PortableDomain, Set<string>>();
  const recordIdentities = new Map<PortableDomain, Set<string>>();
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const edgeSet = new Set<string>(); dependencyEdges.set(domain, edgeSet);
    const identitySet = new Set<string>(); recordIdentities.set(domain, identitySet);
    let afterOrdinal = 0;
    for (;;) {
      const page = await destinationSource.readDomainPage({
        domain, afterOrdinal, includePredecessor: false,
        maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes as 150994944, signal,
      });
      for (const record of page.records) {
        identitySet.add(record.identitySha256);
        collectDependencyEdges(record, edgeSet);
      }
      afterOrdinal += page.records.length;
      if (page.complete) break;
    }
  }
  return { dependencyEdges, recordIdentities };
}

/**
 * Relation class, substantive half: edge-set equality between source and
 * destination in canonical identity terms. A foreign-key constraint
 * cannot see a child remapped to a valid but wrong parent -- the row
 * still satisfies every constraint -- so this compares the destination's
 * recorded dependency edges against the source's directly, per domain.
 * Reports the child's identity digest, never the parent's, per plan.
 */
export function reconcileDependencyEdges(
  sourceEdges: ReadonlyMap<PortableDomain, ReadonlySet<string>>,
  destinationEdges: ReadonlyMap<PortableDomain, ReadonlySet<string>>,
): MigrationVerificationMismatch[] {
  const mismatches: MigrationVerificationMismatch[] = [];
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const source = sourceEdges.get(domain) ?? new Set<string>();
    const destination = destinationEdges.get(domain) ?? new Set<string>();
    const reported = new Set<string>();
    const report = (edge: string): void => {
      const childIdentitySha256 = edge.split("|")[0]!;
      if (reported.has(childIdentitySha256)) return;
      reported.add(childIdentitySha256);
      mismatches.push({
        domain, class: "relation",
        identitySha256: migrationWitnessSha256(["relation-edge-mismatch-v1", domain, childIdentitySha256]),
      });
    };
    for (const edge of source) if (!destination.has(edge)) report(edge);
    for (const edge of destination) if (!source.has(edge)) report(edge);
  }
  return mismatches;
}

/**
 * Relation class, cheap additional guard: every dependency edge the
 * destination itself recorded must resolve to a record that actually
 * exists in the destination. Ordinary PostgreSQL foreign-key constraints
 * already make this structurally impossible for normal writes, so this
 * only fires against a constraint bypass (disabled triggers, an
 * unvalidated FK) -- defense in depth, not the primary check, and it
 * costs nothing extra: it reads the same data the edge-set comparison
 * already collected.
 */
export function readRelationDanglingReferenceMismatches(
  destinationEdges: ReadonlyMap<PortableDomain, ReadonlySet<string>>,
  destinationIdentities: ReadonlyMap<PortableDomain, ReadonlySet<string>>,
): MigrationVerificationMismatch[] {
  const mismatches: MigrationVerificationMismatch[] = [];
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const edgeSet = destinationEdges.get(domain);
    if (edgeSet === undefined) continue;
    const reported = new Set<string>();
    for (const edge of edgeSet) {
      const parts = edge.split("|");
      const childIdentitySha256 = parts[0]!; const parentDomain = parts[1]!; const parentIdentitySha256 = parts[2]!;
      const parentIdentities = destinationIdentities.get(parentDomain as PortableDomain);
      if (parentIdentities?.has(parentIdentitySha256) === true) continue;
      if (reported.has(childIdentitySha256)) continue;
      reported.add(childIdentitySha256);
      mismatches.push({
        domain, class: "relation",
        identitySha256: migrationWitnessSha256(["relation-dangling-reference-v1", domain, childIdentitySha256]),
      });
    }
  }
  return mismatches;
}

export interface MigrationLedgerReconciliationInput {
  readonly projectId: string;
  readonly targetGenerationId: string;
  readonly manifestSha256: string;
  readonly identityFingerprintSha256: string;
  readonly manifestCheckpoints: readonly MigrationCheckpoint[];
  readonly census: readonly MigrationVerificationDomainCensus[];
  readonly recordIdentities: ReadonlyMap<PortableDomain, ReadonlySet<string>>;
  readonly signal?: AbortSignal;
}

/**
 * Round-4 P2: cardinality-plus-injectivity alone lets a substitution
 * that preserves both pass undetected -- the ledger's own identity_sha256
 * SET for a domain could differ entirely from what was actually copied
 * while agreeing on count and staying one-to-one. prefixSha256 (the
 * census's own per-domain digest) cannot be the comparison target: it is
 * a full-content rolling digest computed client-side over every field of
 * every record, not an identity-only aggregate, so it could never agree
 * with an identity-only ledger digest even on a sound destination.
 *
 * The actual comparison operand already exists in memory at zero
 * marginal cost: recordIdentities, the destination's own per-domain
 * identity sets, walked once for the relation class. This function
 * folds each domain's set into one digest (sort, concatenate, SHA-256)
 * to compare against a matching per-domain aggregate computed entirely
 * server-side in one grouped query -- no transfer_identities row is
 * ever pulled to the client for this check. COLLATE "C" is forced in
 * the query rather than relying on the column's collation, so the two
 * sides agree by construction rather than because a collation checked
 * once still holds later; the client-side sort must therefore also be
 * plain byte-order, which JS's default string sort already is for this
 * restricted [0-9a-f]{64} character set.
 *
 * Returns null for an empty set, matching what string_agg produces for
 * zero rows (NULL, not an empty-string digest) so a domain with no
 * records on either side compares null === null rather than disagreeing
 * for a reason unrelated to content.
 */
function digestIdentitySet(identities: ReadonlySet<string>): string | null {
  if (identities.size === 0) return null;
  return sha256Hex([...identities].sort().join(""));
}

/**
 * Ledger class: lcm.transfer_runs / transfer_batches / transfer_identities,
 * all read inside the step 6 snapshot, nothing read after it. The run row
 * itself is read fresh here, never taken from the pre-window
 * probePostgreSqlPortableDestination call, since that call happens before
 * the window opens and could be stale by the time it closes; only its
 * identityFingerprintSha256 -- a re-derived project identity, not part of
 * transfer_runs -- is consumed as the comparison operand, per the same
 * canonicalisation the ledger row's own project_sha256 was written from.
 * The manifest's checkpoints are consumed directly, never restated: the
 * caller-supplied array from protocol.ts's own MigrationManifest, not a
 * second description of the same structure.
 */
export async function readLedgerMismatches(
  session: PostgreSqlSnapshotSession, input: MigrationLedgerReconciliationInput,
): Promise<MigrationVerificationMismatch[]> {
  const mismatches: MigrationVerificationMismatch[] = [];
  const queryOptions = { domain: "factory" as const, projectId: input.projectId, signal: input.signal };
  const runResult = await session.query<{
    run_id: string; state: string; manifest_sha256: string; project_sha256: string;
  }>({
    text: "SELECT run_id, state, manifest_sha256, project_sha256 FROM lcm.transfer_runs "
      + "WHERE project_id = $1::uuid AND target_generation = $2",
    values: [input.projectId, input.targetGenerationId],
  }, { ...queryOptions, operation: "verifyGenerationLedgerRun" });
  const run = runResult.rows[0];
  if (run === undefined || run.state !== "completed" || run.manifest_sha256 !== input.manifestSha256
    || run.project_sha256 !== input.identityFingerprintSha256) {
    mismatches.push({
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-run-mismatch-v1", input.targetGenerationId]),
    });
    // Nothing else in this class can be meaningfully checked without a
    // valid run row to scope transfer_batches/transfer_identities to.
    return mismatches;
  }

  const batchResult = await session.query<{ domain: string; checkpoint_sha256: string; next_ordinal: string }>({
    text: "SELECT DISTINCT ON (domain) domain, checkpoint_sha256, next_ordinal FROM lcm.transfer_batches "
      + "WHERE run_id = $1 ORDER BY domain, next_ordinal DESC",
    values: [run.run_id],
  }, { ...queryOptions, operation: "verifyGenerationLedgerBatches" });
  const terminalBatchByDomain = new Map(batchResult.rows.map((row) => [row.domain, row] as const));
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const expected = input.manifestCheckpoints.find((checkpoint) => checkpoint.domain === domain);
    const actual = terminalBatchByDomain.get(domain);
    if (expected === undefined || actual === undefined
      || actual.checkpoint_sha256 !== expected.sourceCheckpointSha256
      || Number(actual.next_ordinal) !== expected.ordinal) {
      mismatches.push({
        domain, class: "ledger",
        identitySha256: migrationWitnessSha256(["ledger-batch-mismatch-v1", domain]),
      });
    }
  }

  const totalCensusCount = input.census.reduce((sum, entry) => sum + entry.recordCount, 0);
  const identityCountResult = await session.query<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM lcm.transfer_identities WHERE run_id = $1",
    values: [run.run_id],
  }, { ...queryOptions, operation: "verifyGenerationLedgerIdentityCount" });
  if (Number(identityCountResult.rows[0]?.count ?? "-1") !== totalCensusCount) {
    mismatches.push({
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-identity-cardinality-mismatch-v1", input.targetGenerationId]),
    });
  }

  // Non-injective mapping is the storage-level signature of the same
  // wrong-parent defect the relation class catches at the edge level: two
  // different destination identities recorded against the same source
  // native key means the copy assigned one source row two destination
  // identities, or conflated two source rows into ambiguous evidence.
  const nonInjectiveResult = await session.query<{ domain: string; native_key: string }>({
    text: "SELECT domain, native_key FROM lcm.transfer_identities WHERE run_id = $1 "
      + "GROUP BY domain, native_key HAVING count(DISTINCT identity_sha256) > 1",
    values: [run.run_id],
  }, { ...queryOptions, operation: "verifyGenerationLedgerInjectivity" });
  for (const row of nonInjectiveResult.rows) {
    mismatches.push({
      domain: row.domain as PortableDomain, class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-non-injective-mapping-v1", row.domain, row.native_key]),
    });
  }

  // Round-4 P2: cardinality and injectivity alone permit a substitution
  // that preserves both -- this closes it by comparing the actual SET
  // of copied identities per domain, not just its size and uniqueness.
  // One grouped, server-side aggregate query; no per-identity row is
  // ever fetched to the client for this check.
  const identitySetResult = await session.query<{ domain: string; identity_set_sha256: string | null }>({
    text: "SELECT domain, encode(digest(string_agg(identity_sha256, '' ORDER BY identity_sha256 COLLATE \"C\"), 'sha256'), 'hex') AS identity_set_sha256 "
      + "FROM lcm.transfer_identities WHERE run_id = $1 GROUP BY domain",
    values: [run.run_id],
  }, { ...queryOptions, operation: "verifyGenerationLedgerIdentitySet" });
  const identitySetByDomain = new Map(identitySetResult.rows.map((row) => [row.domain, row.identity_set_sha256] as const));
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const expectedSha256 = digestIdentitySet(input.recordIdentities.get(domain) ?? new Set());
    const actualSha256 = identitySetByDomain.get(domain) ?? null;
    if (expectedSha256 !== actualSha256) {
      mismatches.push({
        domain, class: "ledger",
        identitySha256: migrationWitnessSha256(["ledger-identity-set-mismatch-v1", domain]),
      });
    }
  }

  return mismatches;
}

// --- Step 6 (in-window): sequence self-consistency ---------------------------

/**
 * Identity-sequence-backed domains and the physical table/column a
 * PostgreSQL "GENERATED ... AS IDENTITY" sequence allocates for them, per
 * migrations/0002_schema_baseline.sql. Every other portable domain uses a
 * non-sequence primary key (UUID or a composite key) and has no sequence
 * to bound.
 */
/**
 * Exported so the live completeness guard (S2: a future migration adding
 * an identity column must not silently fall outside this map's scope) can
 * assert this exact set against pg_catalog, rather than only against
 * itself.
 */
export const SEQUENCE_BACKED_IDENTITY_COLUMN: Readonly<Partial<Record<PortableDomain, Readonly<{ table: string; column: string }>>>> = Object.freeze({
  conversations: { table: "lcm.conversations", column: "conversation_id" },
  messages: { table: "lcm.messages", column: "message_id" },
  "recall-surfacings": { table: "lcm.recall_surfacing", column: "surfacing_id" },
  "session-instructions": { table: "lcm.session_instructions", column: "instruction_id" },
  "passive-events": { table: "lcm.passive_event_inbox", column: "inbox_id" },
});

/**
 * The P0 self-consistency bound: no source-side expected sequence value
 * exists anywhere (no artifact records a per-domain identity seed), and a
 * cluster-global watermark is unsatisfiable (the verifier's own lease
 * commit advances it). Instead this checks, entirely within the destination
 * snapshot, that each identity sequence's last_value is at least the
 * maximum identity value actually present in its copied domain -- the
 * necessary condition for the next allocation not to collide with a copied
 * row. A reset or diverged sequence is caught here even when every
 * canonical digest is identical, which is exactly the failure this class
 * exists to catch (see witness-schema-FROZEN-v2.md's own named blind spot).
 */

/**
 * Reads the sequence's own stored, on-disk state through
 * pg_catalog.pg_sequences -- never pg_sequence_last_value(). An earlier
 * round characterised that function as session-local; the documented
 * failure mode for it and for pg_sequences.last_value is actually
 * privilege and never-called state, not which session is asking. Two
 * distinct NULL-producing cases exist and this function tells them apart
 * instead of collapsing them: a role lacking USAGE/SELECT on the
 * sequence, and a sequence genuinely never advanced (is_called = false).
 * Collapsing them would let a privilege gap present as "never called",
 * which reads as sound for an empty domain -- an unattributed NULL is
 * not evidence.
 *
 * pg_sequences.last_value is read rather than a bare
 * "SELECT last_value, is_called FROM <sequence>", because that direct
 * read needs actual SELECT on the sequence, while pg_sequences gates
 * last_value on has_sequence_privilege(oid, 'SELECT') OR (..., 'USAGE'),
 * so the least-privilege runtime role -- granted USAGE but never SELECT
 * on every identity sequence -- reads a real value through the view
 * where the direct read would fail on a permission error instead. The
 * privilege is still checked explicitly up front, so a role with
 * neither USAGE nor SELECT is refused for its own reason rather than
 * silently read as "never called". start_value is read alongside
 * last_value: when is_called is false the *next* nextval() call returns
 * start_value itself, not last_value plus the increment, and
 * pg_sequences exposes start_value directly so no second catalog join
 * is needed for it. The sequence name is resolved server-side via
 * pg_get_serial_sequence and is never caller input, so casting it to
 * regclass (PostgreSQL forbids parameterising a relation name) admits
 * nothing an attacker controls.
 */
export type MigrationSequenceStoredState =
  | Readonly<{ kind: "no-sequence" }>
  | Readonly<{ kind: "privilege-denied" }>
  | Readonly<{ kind: "never-called"; startValue: bigint }>
  | Readonly<{ kind: "called"; lastValue: bigint; incrementBy: bigint }>;

export async function readSequenceStoredState(
  session: PostgreSqlSnapshotSession, table: string, column: string, signal?: AbortSignal,
): Promise<MigrationSequenceStoredState> {
  const nameResult = await session.query<{ seq_name: string | null }>({
    text: "SELECT pg_catalog.pg_get_serial_sequence($1, $2) AS seq_name",
    values: [table, column],
  }, { domain: "factory", operation: "verifyGenerationSequenceName", signal });
  const seqName = nameResult.rows[0]?.seq_name ?? null;
  if (seqName === null) return { kind: "no-sequence" };
  // has_sequence_privilege is an introspection function callable
  // regardless of ACL on the target: it reports what the role could do,
  // never requires SELECT to run. A comma-separated privilege list
  // returns true if either is held, matching the two readable paths
  // above (the direct read needs SELECT, the view accepts either).
  const privilegeResult = await session.query<{ has_privilege: boolean | null }>({
    text: "SELECT pg_catalog.has_sequence_privilege($1::regclass, 'SELECT,USAGE') AS has_privilege",
    values: [seqName],
  }, { domain: "factory", operation: "verifyGenerationSequencePrivilege", signal });
  if (privilegeResult.rows[0]?.has_privilege !== true) return { kind: "privilege-denied" };
  const result = await session.query<{ last_value: string | null; start_value: string; increment_by: string }>({
    text: "SELECT ps.last_value::text AS last_value, ps.start_value::text AS start_value, "
      + "ps.increment_by::text AS increment_by "
      + "FROM pg_catalog.pg_sequences ps "
      + "JOIN pg_catalog.pg_namespace n ON n.nspname OPERATOR(pg_catalog.=) ps.schemaname "
      + "JOIN pg_catalog.pg_class c ON c.relnamespace OPERATOR(pg_catalog.=) n.oid "
      + "AND c.relname OPERATOR(pg_catalog.=) ps.sequencename "
      + "WHERE c.oid OPERATOR(pg_catalog.=) $1::regclass",
    values: [seqName],
  }, { domain: "factory", operation: "verifyGenerationSequenceLastValue", signal });
  const row = result.rows[0];
  if (row === undefined) return { kind: "no-sequence" };
  if (row.last_value === null) return { kind: "never-called", startValue: BigInt(row.start_value) };
  return { kind: "called", lastValue: BigInt(row.last_value), incrementBy: BigInt(row.increment_by) };
}

/**
 * Round-1 P2: SEQUENCE_BACKED_IDENTITY_COLUMN is a hand-maintained
 * completeness claim about which portable domains have an identity
 * sequence to bound. Previously this claim was proven against
 * pg_catalog only by an integration test requiring a live PostgreSQL 18
 * harness to even run -- every fake-backed unit test, and any
 * environment that skips the harness, could ship a stale map (a future
 * migration adding an identity column that never gets added here)
 * completely undetected, while sequence classCoverage kept claiming
 * ran: true for a column the self-consistency bound never actually
 * checked. Asserting this here, inside the fenced window on every real
 * run, makes a stale map a refusal on that run rather than an untested
 * assumption resting on whether anyone happened to run the harness.
 * fenced_leases.fencing_token is coordination-internal lease machinery,
 * not a portable domain, and is excluded exactly as the integration
 * test excludes it.
 */
async function assertSequenceBackedIdentityColumnCompleteness(
  session: PostgreSqlSnapshotSession, signal?: AbortSignal,
): Promise<void> {
  const result = await session.query<{ table_name: string; column_name: string }>({
    text: "SELECT c.relname AS table_name, a.attname AS column_name "
      + "FROM pg_catalog.pg_attribute a "
      + "JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid "
      + "JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace "
      + "WHERE n.nspname OPERATOR(pg_catalog.=) 'lcm' AND a.attidentity OPERATOR(pg_catalog.<>) '' "
      + "AND c.relkind OPERATOR(pg_catalog.=) 'r' AND NOT a.attisdropped "
      + "AND c.relname OPERATOR(pg_catalog.<>) 'fenced_leases'",
  }, { domain: "factory", operation: "verifyGenerationSequenceCompleteness", signal });
  const actual = result.rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
  const expected = Object.values(SEQUENCE_BACKED_IDENTITY_COLUMN)
    .map((target) => `${target!.table.replace("lcm.", "")}.${target!.column}`)
    .sort();
  const matches = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  if (!matches) {
    driverError("invalid-input", "the sequence-backed identity column map does not match the destination's live schema");
  }
}

export async function readSequenceSelfConsistencyMismatches(
  session: PostgreSqlSnapshotSession, projectId: string, signal?: AbortSignal,
): Promise<MigrationVerificationMismatch[]> {
  await assertSequenceBackedIdentityColumnCompleteness(session, signal);
  const mismatches: MigrationVerificationMismatch[] = [];
  for (const [domain, target] of Object.entries(SEQUENCE_BACKED_IDENTITY_COLUMN)) {
    // Round-4 P1: identity sequences are global per table, shared by
    // every project, not per-project. Scoping this MAX to the project
    // being verified meant an empty (or low-water) project skipped the
    // check entirely while another project's rows sat above the
    // sequence in the very same table -- the collision the bound exists
    // to catch was real, but outside the window this query looked
    // through. The invariant is "the sequence will not collide with any
    // row that already exists in this table", which is a table-wide
    // fact, not a project-scoped one, so the query is now table-wide to
    // match.
    const maxResult = await session.query<{ max_value: string | null }>({
      text: "SELECT MAX(" + target.column + ")::text AS max_value FROM " + target.table,
    }, { domain: "factory", operation: "verifyGenerationSequenceSelfConsistencyMax", projectId, signal });
    const maxValue = maxResult.rows[0]?.max_value ?? null;
    // Empty table (across every project, not just the one being
    // verified): nothing exists anywhere to collide with, so the bound
    // holds vacuously regardless of sequence state or privilege. Reading
    // the sequence is only meaningful once some row, in any project,
    // exists to protect.
    if (maxValue === null) continue;
    const state = await readSequenceStoredState(session, target.table, target.column, signal);
    if (state.kind === "privilege-denied") {
      // A privilege gap is a refusal in its own right, never evidence
      // about sequence state: collapsing it into "never called" would
      // let an environment misconfiguration read as healthy whenever the
      // domain happens to be non-empty in the wrong way.
      mismatches.push({
        domain: domain as PortableDomain, class: "sequence",
        identitySha256: migrationWitnessSha256(["sequence-self-consistency-privilege-denied-v1", domain]),
      });
      continue;
    }
    // is_called=false means nextval() has never run: the *next* call
    // returns start_value itself, not last_value plus the increment.
    // Getting this boundary backwards is exactly the S1 defect this
    // replaces: a never-called sequence whose start value collides with
    // an already-copied row must still be caught.
    const nextAllocatedValue = state.kind === "no-sequence" ? null
      : state.kind === "never-called" ? state.startValue
      : state.lastValue + state.incrementBy;
    if (nextAllocatedValue === null || nextAllocatedValue <= BigInt(maxValue)) {
      mismatches.push({
        domain: domain as PortableDomain, class: "sequence",
        // A constant marker, never the compared values: the sequence bound
        // is a boolean pass/fail per domain, and there is no per-record
        // identity to reference here (unlike a sampled-record mismatch).
        identitySha256: migrationWitnessSha256(["sequence-self-consistency-violation-v1", domain]),
      });
    }
  }
  return mismatches;
}

function buildCensusVector(domains: readonly MigrationVerificationDomainCensus[]): MigrationCensusVector {
  return parseMigrationCensusVector({
    version: 1,
    domains: domains.map((entry) => ({ domain: entry.domain, recordCount: entry.recordCount, prefixSha256: entry.prefixSha256 })),
    // Pinned to the portable manifest's own aggregate family (per freeze-
    // integrity repair 3): the same aggregateContentSha256(schema, prefixes)
    // formula the source's PortableManifest.contentSha256 uses, never a
    // second verification-only digest family for the same concept.
    contentSha256: aggregateContentSha256(
      PORTABLE_RECORD_SCHEMA_SHA256, domains.map((entry) => entry.prefixSha256),
    ),
  });
}

function buildCanonicalDelta(domains: readonly MigrationVerificationDomainCensus[]): MigrationCanonicalDelta {
  return parseMigrationCanonicalDelta({
    version: 1,
    domains: domains.map((entry) => ({
      domain: entry.domain, recordCount: entry.recordCount,
      terminalIdentitySha256: entry.terminalIdentitySha256 ?? emptyTerminalIdentitySha256(entry.domain),
    })),
  });
}

/**
 * Permanent regression guard for the P0 this whole design exists to avoid: a
 * read-only snapshot session must never assign a transaction id. Unlike the
 * whole-run form retired after v1, this asserts the property directly on the
 * dedicated window session, so it stays true regardless of what the rest of
 * the driver does inside the window.
 */
export async function assertPermanentReadOnlyGuard(
  session: PostgreSqlSnapshotSession, signal?: AbortSignal,
): Promise<void> {
  await session.query({ text: "SELECT 1" }, { domain: "transaction", operation: "verifyGenerationReadOnlyGuardProbe", signal });
  const result = await session.query<{ xid: string | null }>({
    text: "SELECT pg_catalog.pg_current_xact_id_if_assigned()::text AS xid",
  }, { domain: "transaction", operation: "verifyGenerationReadOnlyGuard", signal });
  if (result.rows[0]?.xid !== null) {
    driverError("invalid-input", "the census window assigned a transaction id; it must stay read-only");
  }
}

// --- Step 1 (source side): stream the re-authenticated source to completion -

export interface StreamedSourceCheckpoints {
  readonly checkpoints: ReadonlyMap<PortableDomain, PortableCheckpoint>;
  /**
   * Every source "conversations" record's createdAt (millisecond-
   * truncated) and portable identitySha256, sorted ascending by
   * (createdAt, identitySha256). This is the step 5 ordered-listing
   * probe's comparison target, captured during this same forward pass
   * rather than a second read of an already-exhausted stream; the
   * identitySha256 is what lets a sample mismatch name a real sampled
   * record per schema v3.3 section 6.1, rather than only an aggregate.
   */
  readonly conversationsPublicOrder: readonly MigrationPublicListingSourceEntry[];
  /**
   * Per-domain sets of dependency edges, one entry per
   * "child|parentDomain|parentIdentitySha256" for every record and every
   * declared dependency in its own PortableRecord.dependencies -- already
   * computed by the existing canonicalisation path, never recomputed
   * here. Captured during this same forward pass (no second source read)
   * and compared against the destination's own edges inside the window
   * by reconcileDependencyEdges, for the relation class: edge-set
   * equality in canonical identity terms, which catches a child remapped
   * to a valid but wrong parent -- the #623 P1 shape a foreign-key
   * constraint cannot see, because the remapped reference still points
   * at a real row.
   */
  readonly dependencyEdges: ReadonlyMap<PortableDomain, ReadonlySet<string>>;
  /**
   * Up to MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE "messages" records
   * from the start of canonical order, each with its own position
   * (ordinal) and content. The step 5 search probe walks this pool,
   * starting from an index derived from sampleParameters.seedBasisSha256,
   * searching the destination for each candidate's own content until one
   * produces a non-empty result or the pool is exhausted.
   */
  readonly searchProbeCandidates: readonly MigrationSearchProbeSourceEntry[];
}

export async function streamSourceCheckpoints(
  stream: PortableRecordStream, signal?: AbortSignal,
): Promise<StreamedSourceCheckpoints> {
  const checkpoints = new Map<PortableDomain, PortableCheckpoint>();
  const conversationEntries: Array<{ createdAt: string; identitySha256: string; title: string | null }> = [];
  const dependencyEdges = new Map<PortableDomain, Set<string>>();
  const searchProbeCandidates: MigrationSearchProbeSourceEntry[] = [];
  let messageOrdinal = 0;
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const edgeSet = new Set<string>();
    dependencyEdges.set(domain, edgeSet);
    let after: PortableCheckpoint | undefined;
    for (;;) {
      const batch = await stream.readBatch({ domain, after, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes, signal });
      if (domain === "conversations") {
        for (const record of batch.records) {
          const value = record.value as PortableRecordValueByDomain["conversations"];
          conversationEntries.push({
            createdAt: truncateToMillisecondIso(value.createdAt), identitySha256: record.identitySha256,
            title: value.title,
          });
        }
      }
      if (domain === "messages") {
        for (const record of batch.records) {
          if (searchProbeCandidates.length < MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE) {
            const value = record.value as PortableRecordValueByDomain["messages"];
            searchProbeCandidates.push({ ordinal: messageOrdinal, identitySha256: record.identitySha256, content: value.content });
          }
          messageOrdinal += 1;
        }
      }
      for (const record of batch.records) collectDependencyEdges(record, edgeSet);
      after = batch.checkpoint;
      if (batch.complete) break;
    }
    checkpoints.set(domain, after);
  }
  conversationEntries.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.identitySha256 < right.identitySha256 ? -1 : left.identitySha256 > right.identitySha256 ? 1 : 0;
  });
  return {
    checkpoints,
    conversationsPublicOrder: conversationEntries,
    dependencyEdges,
    searchProbeCandidates,
  };
}

// --- Reconciliation: source checkpoints versus the destination census ------

function domainMismatchIdentity(payload: unknown): string {
  return migrationWitnessSha256(payload);
}

export function reconcileCounts(
  sourceCheckpoints: ReadonlyMap<PortableDomain, PortableCheckpoint>,
  destinationCensus: readonly MigrationVerificationDomainCensus[],
): MigrationVerificationMismatch[] {
  const mismatches: MigrationVerificationMismatch[] = [];
  for (const entry of destinationCensus) {
    const source = sourceCheckpoints.get(entry.domain);
    if (source === undefined) continue;
    if (source.recordCount !== entry.recordCount) {
      mismatches.push({
        domain: entry.domain, class: "count",
        // W5: hashing the two record counts alongside the domain is
        // technically enumerable, since record counts are typically
        // small integers a reader could brute-force against the
        // published digest. domain and class are already plain fields
        // on this mismatch, and at most one count mismatch is ever
        // emitted per domain here, so a constant per-domain token loses
        // no evidence this identity is relied on to carry.
        identitySha256: domainMismatchIdentity(["count-mismatch-v1", entry.domain]),
      });
    } else if (source.prefixSha256 !== entry.prefixSha256) {
      mismatches.push({
        domain: entry.domain, class: "digest",
        identitySha256: domainMismatchIdentity(["digest-mismatch-v1", entry.domain]),
      });
    }
  }
  return mismatches;
}

/**
 * Domain position comes from the caller-supplied order (this driver's
 * own construction order, or a test's narrower one); class position
 * comes from verification-report.ts's migrationMismatchClassOrdinal --
 * the same frozen ordinal the report body's own validator enforces at
 * construction, never a second, separately-maintained comparison. See
 * migrationMismatchClassOrdinal's docstring for the round-1 defect this
 * sharing exists to close.
 */
export function mismatchOrdinal(value: MigrationVerificationMismatch, order: readonly MigrationReconciliationDomain[]): readonly [number, number, string] {
  return [order.indexOf(value.domain), migrationMismatchClassOrdinal(value.class), value.identitySha256];
}

export function sortMismatches(
  mismatches: readonly MigrationVerificationMismatch[], order: readonly MigrationReconciliationDomain[],
): MigrationVerificationMismatch[] {
  return [...mismatches].sort((left, right) => {
    const [leftDomain, leftClass, leftIdentity] = mismatchOrdinal(left, order);
    const [rightDomain, rightClass, rightIdentity] = mismatchOrdinal(right, order);
    if (leftDomain !== rightDomain) return leftDomain - rightDomain;
    if (leftClass !== rightClass) return leftClass - rightClass;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
}

export function totalsFor(mismatches: readonly MigrationVerificationMismatch[]): MigrationVerificationMismatchTotal[] {
  const counts = new Map<string, { domain: MigrationReconciliationDomain; class: MigrationMismatchClass; count: number }>();
  for (const mismatch of mismatches) {
    const key = mismatch.domain + "\u0000" + mismatch.class;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { domain: mismatch.domain, class: mismatch.class, count: 1 });
  }
  return [...counts.values()];
}

/**
 * Round-2 P3: totals previously borrowed sortMismatches via an
 * `as unknown as MigrationVerificationMismatch[]` double-cast, relying
 * on mismatchOrdinal's third tie-break (value.identitySha256) silently
 * reading undefined off every total -- harmless only because
 * totalsFor's Map already guarantees at most one entry per
 * (domain, class) pair, so the tie-break is never reached in practice.
 * That "harmless because the caller happens to guarantee no ties" is
 * exactly the kind of fact a type system should not have to be
 * trusted on. This sorter has its own two-key comparator -- domain then
 * class ordinal, the only two fields MigrationVerificationMismatchTotal
 * actually has -- so there is no cast and no borrowed field to misread.
 */
export function sortMismatchTotals(
  totals: readonly MigrationVerificationMismatchTotal[], order: readonly MigrationReconciliationDomain[],
): MigrationVerificationMismatchTotal[] {
  return [...totals].sort((left, right) => {
    const leftDomain = order.indexOf(left.domain);
    const rightDomain = order.indexOf(right.domain);
    if (leftDomain !== rightDomain) return leftDomain - rightDomain;
    return migrationMismatchClassOrdinal(left.class) - migrationMismatchClassOrdinal(right.class);
  });
}

/**
 * The report body rejects more than MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT
 * recorded entries in one class; it does not truncate for the driver. This
 * is the truncation itself: called on the full, already-sorted mismatch
 * list, it keeps the first LIMIT entries per class (in the frozen sort
 * order) and drops the rest. Exact totals must be computed from the full
 * list *before* calling this, never from its return value, or the operator
 * loses the one number truncation exists to preserve.
 */
export function truncateMismatchesPerClass(
  mismatches: readonly MigrationVerificationMismatch[],
): MigrationVerificationMismatch[] {
  // Round-1 candidate review 2, P1: truncating per class alone (ignoring
  // domain) could keep the frozen limit's worth of entries entirely from
  // one early domain and drop every entry from a later domain in the
  // same class -- but the full, untruncated totals still record that
  // later domain's count, and the report body's own consistency check
  // requires every total to have at least one retained entry. A badly
  // diverged multi-domain destination (for example 150 relation
  // mismatches on one domain plus 1 on another) then threw
  // "a mismatch total has no recorded entries" before persist, instead
  // of producing either a refused report or operator evidence -- for
  // exactly the destination this evidence path exists to serve.
  //
  // Truncate per (domain, class) pair instead, via round-robin across
  // the domains present in each class: visit every domain with at least
  // one mismatch in that class once per round, in the order those
  // domains first appear (already frozen-sort order, since the input
  // arrives pre-sorted domain-major), so every present domain keeps at
  // least one entry before any domain's second entry is kept. The
  // class-wide total retained can never exceed the frozen limit, and at
  // most 24 domains exist in this schema, so "one entry per present
  // domain" always fits inside a 100-entry budget with room to spare.
  const listsByKey = new Map<string, MigrationVerificationMismatch[]>();
  const domainsByClass = new Map<MigrationMismatchClass, MigrationReconciliationDomain[]>();
  for (const mismatch of mismatches) {
    const key = mismatch.domain + "\u0000" + mismatch.class;
    let list = listsByKey.get(key);
    if (list === undefined) {
      list = [];
      listsByKey.set(key, list);
      let domains = domainsByClass.get(mismatch.class);
      if (domains === undefined) { domains = []; domainsByClass.set(mismatch.class, domains); }
      domains.push(mismatch.domain);
    }
    list.push(mismatch);
  }
  const keepByKey = new Map<string, number>();
  for (const [klass, domains] of domainsByClass) {
    const available = domains.map((domain) => listsByKey.get(domain + "\u0000" + klass)!.length);
    const keep = new Array<number>(domains.length).fill(0);
    let remaining = MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT;
    for (let progressed = true; remaining > 0 && progressed;) {
      progressed = false;
      for (let index = 0; index < domains.length && remaining > 0; index += 1) {
        if (keep[index]! < available[index]!) {
          keep[index] = keep[index]! + 1;
          remaining -= 1;
          progressed = true;
        }
      }
    }
    domains.forEach((domain, index) => keepByKey.set(domain + "\u0000" + klass, keep[index]!));
  }
  const takenByKey = new Map<string, number>();
  return mismatches.filter((mismatch) => {
    const key = mismatch.domain + "\u0000" + mismatch.class;
    const taken = takenByKey.get(key) ?? 0;
    // Every key here was inserted into keepByKey above, since it can
    // only exist if mismatches contained at least one entry for it.
    if (taken >= keepByKey.get(key)!) return false;
    takenByKey.set(key, taken + 1);
    return true;
  });
}

export interface VerifyMigrationGenerationInput {
  readonly generationId: string;
  readonly targetGenerationId: string;
  readonly homeDir: string;
  readonly expectedIdentity: StorageIdentityContext;
  readonly destinationSettings: PostgreSqlConnectionSettings;
  readonly expectedOwner: string;
  readonly ownerProcessId: string;
  readonly scratchParent: string;
  readonly leaseTtlMs: number;
  readonly manifestRevision: number;
  readonly manifestChecksumSha256: string;
  readonly destinationMigrationsSha256: string;
  /**
   * manifest.destination.identitySha256: the sealed five-field witness
   * copy-time recorded for this destination. Compared in full against the
   * re-derived destinationIdentity.sealedWitnessSha256 -- unlike the
   * schema witness, which is migrations-only -- so a wrong-database or
   * failover-since-copy destination refuses instead of publishing a clean
   * report bound to the wrong destination.
   */
  readonly expectedDestinationIdentitySha256: string;
  /**
   * pg_control_system()'s system_identifier, recorded as a sibling of the
   * sealed five-field identity witness (per plan-v4 section 4) rather than
   * inside it. Comparing it live-to-live is what catches a destination
   * whose underlying physical cluster changed -- a failover to a standby
   * with a different system_identifier -- while the application-level
   * five-field witness happened to stay identical.
   */
  readonly expectedSystemIdentifier: string;
  readonly projectMapWitnessSha256: string;
  readonly queueClassificationWitness: MigrationQueueClassificationWitness;
  readonly sampleParameters: MigrationVerificationSampleParameters;
  readonly signal?: AbortSignal;
}

export interface VerifyMigrationGenerationDependencies {
  openSource(input: MigrationCopySourceInput): ReturnType<typeof openMigrationCopySource>;
  createRuntime(settings: PostgreSqlConnectionSettings): PostgreSqlRuntime;
  verifyTransferSchema: typeof verifyPostgreSqlTransferSchema;
  /**
   * @internal Deterministic seam for proving a write committed in the gap
   * between the source stream (step 1) and the fenced census window
   * (step 6) is caught as a genuine reconciliation mismatch, and is never
   * silently absorbed. Production callers must never set this.
   */
  _afterSourceCheckpointsForTesting?: () => Promise<void>;
}

const defaultDependencies: VerifyMigrationGenerationDependencies = {
  openSource: (input) => openMigrationCopySource(input),
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  verifyTransferSchema: (executor, options) => verifyPostgreSqlTransferSchema(executor, options),
};

export interface VerifyMigrationGenerationResult {
  readonly report: MigrationVerificationReport;
  readonly outcome: "clean" | "mismatches";
  /**
   * Pinned per plan-v4 step 10 (previously left asserted rather than
   * named): deterministic functions of the persisted report identity,
   * never a live observation. This driver calls
   * beginMigrationEffect/completeMigrationEffect itself (steps 10-11)
   * once the persisted report is activationEligible, and pinning the
   * formula means two independent drivers over an identical persisted
   * report mint the same effectId -- the property the idempotent-begin
   * adoption rule below needs.
   */
  readonly effectId: string;
  readonly inputSha256: string;
}

/** effectId = `verify-generation-${reportSha256}`, inputSha256 = reportSha256. Pinned, not asserted. */
export function migrationVerificationEffectId(reportSha256: string): string {
  return `verify-generation-${reportSha256}`;
}

/**
 * Plan-v4 section 2's steps 1-8: everything needed to produce a fully-
 * formed, freshly computed MigrationVerificationReport, and nothing more.
 * This function has no reference anywhere in its body to
 * MigrationVerificationReportStore.persist, MigrationManifestStore.update,
 * beginMigrationEffect or completeMigrationEffect -- it cannot publish,
 * not merely because it chooses not to, but because none of those
 * operations are reachable from its own code. verifyMigrationGeneration
 * and inspectMigrationVerification are the only two callers, and each
 * decides independently what to do with the report this returns: the
 * former persists it and may begin/complete an effect; the latter simply
 * returns it. Moving those write operations into this shared function
 * behind a flag was deliberately avoided, per the same reasoning that
 * made the fenced window's read-only handle a compile-time property
 * rather than a documented rule: a capability that is not reachable at
 * all is safer than one that is reachable but supposed to stay unused.
 *
 * A fresh call recomputes everything from scratch every time: it takes
 * no manifest-effect shortcut of its own (that belongs to
 * verifyMigrationGeneration's resume path, which never calls this
 * function at all for a resumed attempt) and never retries internally.
 */
/**
 * Round-2 P3: the lease is returned unreleased on success, so the caller
 * can defer release until after its own persist -- release-before-
 * persist would let a second worker acquire the lease and start a
 * concurrent recomputation while the first worker's persist is still in
 * flight, exactly the window the lease exists to close. On any failure
 * path below (including construction of the report itself), the lease
 * is released here before the error propagates, since there is nothing
 * left for a caller to persist in that case and nothing should hold the
 * lease past this function's own failure. inspectMigrationVerification
 * has no persist step at all, so it releases immediately on success too
 * -- deferred release is a verifyMigrationGeneration-only property, not
 * an escaping resource caller-owned wrapper types can accidentally sit
 * on for the lease's protection to depend on.
 *
 * Round-4 P1: the round-2 version of this function closed `runtime` in
 * its own outer `finally` unconditionally, which runs before a
 * `return` inside the `try` actually hands control back to the
 * caller. So on every successful pass, `runtime` was already closed by
 * the time the caller ever got to invoke the returned `releaseLease`,
 * and `coordinator.releaseLease(...)`'s own `.catch(() => undefined)`
 * silently absorbed the resulting rejection -- the lease was never
 * actually released on a successful run, and nothing distinguished that
 * from a real release, until the lease's own TTL eventually expired it.
 * `releaseLeaseHandedOff` tracks whether cleanup responsibility for
 * `runtime` transferred to the returned closure (success, and the
 * internal failure path below, both close it themselves) so the outer
 * `finally` only closes `runtime` for a failure that occurred before a
 * lease was ever acquired. The returned closure itself no longer
 * swallows a release failure: it always attempts to close `runtime`
 * (so the resource is never leaked open), but rethrows a genuine
 * release rejection rather than presenting it as success.
 */
async function computeVerificationReport(
  input: VerifyMigrationGenerationInput,
  dependencies: VerifyMigrationGenerationDependencies,
): Promise<{ report: MigrationVerificationReport; releaseLease: () => Promise<void> }> {
  const copySource = await dependencies.openSource({
    generationId: input.generationId, homeDir: input.homeDir, expectedIdentity: input.expectedIdentity,
    scratchParent: input.scratchParent, signal: input.signal,
  });
  let runtime: PostgreSqlRuntime | undefined;
  let releaseLeaseHandedOff = false;
  try {
    await copySource.reauthenticate();
    const {
      checkpoints: sourceCheckpoints, conversationsPublicOrder, dependencyEdges: sourceDependencyEdges,
      searchProbeCandidates,
    } = await streamSourceCheckpoints(copySource.stream, input.signal);
    await dependencies._afterSourceCheckpointsForTesting?.();
    await copySource.reauthenticate();

    runtime = dependencies.createRuntime(input.destinationSettings);
    await dependencies.verifyTransferSchema(runtime, { expectedOwner: input.expectedOwner, signal: input.signal });
    const destinationIdentity = await captureDestinationIdentity(runtime, input.expectedIdentity.id, input.signal);
    const destinationSchemaWitness = await captureDestinationSchemaWitness(runtime, input.signal);
    if (destinationSchemaWitness.migrationsSha256 !== input.destinationMigrationsSha256) {
      driverError("destination-drift", "destination migrations chain does not match the expected witness");
    }
    // Unlike the schema witness (migrations-only per #623), the identity
    // witness is compared in full: a same-data wrong-database destination
    // must refuse, not publish a clean report bound to the wrong target.
    if (destinationIdentity.sealedWitnessSha256 !== input.expectedDestinationIdentitySha256) {
      driverError("destination-drift", "destination identity does not match the expected witness");
    }
    if (destinationIdentity.systemIdentifier !== input.expectedSystemIdentifier) {
      driverError("destination-drift", "destination system identifier does not match the expected value");
    }

    // Ledger operand, obtained rather than reimplemented: the same
    // canonicalisation identityFingerprintSha256 was written from by
    // portable-destination.ts's writer, consumed here as the "expected"
    // side of the ledger's project_sha256 comparison. This probe runs
    // before the window and is never itself the ledger's transfer_runs
    // read; that read happens fresh inside the window below.
    const destinationProbe = await probePostgreSqlPortableDestination({
      settings: input.destinationSettings, expectedOwner: input.expectedOwner,
      expectedIdentity: input.expectedIdentity, signal: input.signal,
    });
    // The manifest's own checkpoints, consumed directly rather than
    // restated: reading a second, independently derived description of
    // "what the copy phase finished at" would be exactly the parallel
    // structure this design avoids elsewhere. A read, never a write: this
    // function has no manifest-mutation capability at all.
    const manifest = new MigrationManifestStore({ homeDir: input.homeDir }).read(input.generationId);

    const coordinator = new PostgreSqlWorkCoordinator(runtime, input.expectedIdentity.id, input.expectedIdentity.machineId!);
    const resource = {
      resourceType: "migration-verification", resourceKey: input.generationId,
      processId: input.ownerProcessId, operation: "verify-generation",
    };
    const lease = await coordinator.acquireLease({ ...resource, ttlMs: input.leaseTtlMs, signal: input.signal });
    if (lease === null) driverError("lease-unavailable", "migration verification lease is held by another worker");
    // Always closes runtime, even when the release call itself rejects
    // (so the connection pool is never leaked open), but no longer
    // swallows that rejection: a caller awaiting this closure now sees
    // a real release's failure rather than a false success.
    const releaseLease = async (): Promise<void> => {
      try {
        await coordinator.releaseLease({ ...resource, fencingToken: lease.fencingToken });
      } finally {
        await runtime?.close();
      }
    };
    // From the moment the lease is acquired and this closure exists,
    // closing runtime is releaseLease's job on every exit path from
    // here down: the caller invokes it after persist on success, and
    // the catch immediately below invokes it on failure. The outer
    // finally must not close runtime a second time in either case.
    releaseLeaseHandedOff = true;
    try {
      const { mismatch: publicListingMismatch, publicListingSha256 } = await runOrderedListingProbe(
        runtime, input.expectedIdentity.id, conversationsPublicOrder, input.signal,
      );
      const searchProbeOutcome = await runSearchSelfMatchProbe(
        runtime, input.expectedIdentity.id, input.targetGenerationId,
        searchProbeCandidates, input.sampleParameters.seedBasisSha256, input.signal,
      );

      const session = await runtime.openReadOnlySnapshot({ projectId: input.expectedIdentity.id, signal: input.signal });
      let destinationRead: MigrationFencedDestinationRead;
      let sequenceMismatches: MigrationVerificationMismatch[];
      let ledgerMismatches: MigrationVerificationMismatch[];
      try {
        await assertPermanentReadOnlyGuard(session, input.signal);
        await assertSchemaWitnessLiveToLive(session, destinationSchemaWitness, input.expectedSystemIdentifier, input.signal);
        destinationRead = await readFencedDestinationCensus(session, {
          settings: input.destinationSettings, expectedOwner: input.expectedOwner,
          expectedIdentity: input.expectedIdentity, scratchParent: input.scratchParent, signal: input.signal,
        });
        sequenceMismatches = await readSequenceSelfConsistencyMismatches(session, input.expectedIdentity.id, input.signal);
        ledgerMismatches = await readLedgerMismatches(session, {
          projectId: input.expectedIdentity.id, targetGenerationId: input.targetGenerationId,
          manifestSha256: copySource.stream.describe().manifestSha256,
          identityFingerprintSha256: destinationProbe.identityFingerprintSha256,
          manifestCheckpoints: manifest.checkpoints, census: destinationRead.census,
          recordIdentities: destinationRead.recordIdentities, signal: input.signal,
        });
      } finally {
        await session.close();
      }

      const destinationCensus = destinationRead.census;
      const censusVector = buildCensusVector(destinationCensus);
      const canonicalDelta = buildCanonicalDelta(destinationCensus);
      const countMismatches = reconcileCounts(sourceCheckpoints, destinationCensus);
      const relationEdgeMismatches = reconcileDependencyEdges(sourceDependencyEdges, destinationRead.dependencyEdges);
      const relationDanglingMismatches = readRelationDanglingReferenceMismatches(
        destinationRead.dependencyEdges, destinationRead.recordIdentities,
      );
      const domainOrder = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger", "public-listing"] as const;
      const allMismatches = [
        ...countMismatches, ...sequenceMismatches, ...relationEdgeMismatches, ...relationDanglingMismatches,
        ...ledgerMismatches, ...(publicListingMismatch ? [publicListingMismatch] : []),
      ];
      const fullMismatches = sortMismatches(allMismatches, domainOrder);
      // Totals must reflect the full (untruncated) evidence: truncation is
      // an operator-facing display bound on retained entries, never on the
      // exact count the operator is told about.
      const mismatchTotals = sortMismatchTotals(totalsFor(fullMismatches), domainOrder);
      // The report body rejects more than the frozen per-class limit among
      // *retained* entries; a badly diverged destination -- the exact case
      // operator evidence matters most for -- must still produce a report,
      // so the driver truncates here rather than letting construction throw.
      const mismatches = truncateMismatchesPerClass(fullMismatches);

      const sourceWitness: MigrationSourceWitnessDigests = {
        version: 1, identitySha256: copySource.sourceWitness.identitySha256,
        schemaSha256: copySource.sourceWitness.schemaSha256, contentSha256: copySource.sourceWitness.contentSha256,
      };
      const bindingSha256 = migrationWitnessSha256([
        "lcm-migration-verification-binding-v1", input.generationId, input.targetGenerationId, sourceWitness, destinationIdentity,
      ]);
      const publicProbeSha256 = migrationWitnessSha256([
        "lcm-migration-verification-public-probe-v1", MIGRATION_PUBLIC_PROBE_ORDERING_SHA256, publicListingSha256,
        // The search probe's outcome folds in here so a report can never
        // again record and discard it: ran, the fixed candidate pool
        // size and the chosen candidate's ordinal when it ran (both
        // needed to reproduce which candidate was tried without reading
        // the driver's own constant), or the not-run reason when it did
        // not -- never the candidate's content, and never a query string.
        searchProbeOutcome.ran
          ? ["search-self-match", true, MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE, searchProbeOutcome.chosenOrdinal]
          : ["search-self-match", false, searchProbeOutcome.notRunReason],
      ]);
      const reportInput: CreateMigrationVerificationReportInput = {
        generationId: input.generationId, targetGenerationId: input.targetGenerationId, bindingSha256,
        manifestRevision: input.manifestRevision, manifestChecksumSha256: input.manifestChecksumSha256,
        sourceWitness, destinationIdentity, destinationSchemaWitness,
        projectMapWitnessSha256: input.projectMapWitnessSha256, queueClassificationWitness: input.queueClassificationWitness,
        censusVector, canonicalDelta, classCoverage: buildClassCoverageVector(),
        publicProbeSha256, publicProbeCoverage: buildPublicProbeCoverageVector(searchProbeOutcome.ran),
        sampleParameters: input.sampleParameters,
        mismatches, mismatchTotals,
      };
      return { report: createMigrationVerificationReport(reportInput), releaseLease };
    } catch (error) {
      // A secondary failure releasing/closing here must never mask the
      // primary error that got us into this catch: that primary error
      // is the one worth propagating. releaseLease still runs (closing
      // runtime is part of it), its own outcome is just not the thing
      // this rethrow reports.
      await releaseLease().catch(() => undefined);
      throw error;
    }
  } finally {
    try { await copySource.stream.close(); } catch { /* preserve the primary failure */ }
    // Runtime close is now releaseLease's own responsibility once a
    // lease has been acquired (success hands the closure to the caller
    // to invoke after persist; the catch above already invoked it) --
    // closing it again here would be redundant at best. Only a failure
    // before a lease was ever acquired (nothing above set the flag)
    // still needs runtime closed here, since no releaseLease closure
    // exists in that case to have done it.
    if (!releaseLeaseHandedOff) {
      try { await runtime?.close(); } catch { /* preserve the primary failure */ }
    }
  }
}

/**
 * The read-only counterpart to verifyMigrationGeneration: runs the exact
 * same steps 1-8 inside the exact same single fenced snapshot with the
 * same hard negatives, and returns the resulting report directly. It
 * never persists the report, never begins or completes a manifest effect,
 * and never reads or writes any pending-effect state -- an operator can
 * use this to preview whether a generation would verify cleanly before
 * committing to the publishing path in verifyMigrationGeneration. See
 * computeVerificationReport's own docstring for why that is a structural
 * property of this function's call graph, not a documented rule about
 * this function's behaviour.
 */
export async function inspectMigrationVerification(
  input: VerifyMigrationGenerationInput,
  dependencies: VerifyMigrationGenerationDependencies = defaultDependencies,
): Promise<MigrationVerificationReport> {
  // No persist step exists on this path, so there is nothing to defer
  // release for: release immediately, the same as every failure path
  // inside computeVerificationReport itself.
  const { report, releaseLease } = await computeVerificationReport(input, dependencies);
  await releaseLease();
  return report;
}

/**
 * Drives plan-v4.md section 2 end to end for one attempt. Never retries
 * internally: a connection loss or any other failure propagates to the
 * caller, and restarting means calling this function again from scratch.
 * Nothing is persisted until the fully-formed report is ready to write.
 *
 * Steps 9-11 (persist, begin, complete) run in that fixed order: nothing
 * is begun until it is durably persisted, and begin always precedes
 * complete, so a resumed attempt can tell exactly how far a prior attempt
 * got from the manifest and the report store alone. If a verify-generation
 * effect is already pending when this function starts, that can only be
 * because an earlier attempt already persisted and began it -- the report
 * is already frozen, content-addressed evidence -- so this attempt reads
 * that report back and completes with it directly, without repeating any
 * of the expensive destination work below. This is what makes a crash
 * between begin and complete resumable without recomputation, and what
 * makes destination drift after begin harmless: this path never reopens
 * the destination at all.
 */
export async function verifyMigrationGeneration(
  input: VerifyMigrationGenerationInput,
  dependencies: VerifyMigrationGenerationDependencies = defaultDependencies,
): Promise<VerifyMigrationGenerationResult> {
  const manifestStore = new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = new MigrationVerificationReportStore({ homeDir: input.homeDir });
  const resumeManifest = manifestStore.read(input.generationId);
  if (resumeManifest.pendingEffect !== null && resumeManifest.pendingEffect.kind === "verify-generation") {
    const pending = resumeManifest.pendingEffect;
    const persistedReport = reportStore.read(input.generationId, pending.inputSha256);
    const completedAt = new Date().toISOString();
    manifestStore.update(input.generationId, resumeManifest.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: pending.effectId, completedAt, activationEligible: true,
      report: {
        // createdAt binds to the effect's own startedAt, not to this
        // completion's wall clock: the effect began exactly once (by
        // this driver's own prior attempt, since persist always
        // precedes begin), so startedAt is the one value every resumed
        // completion of the same effect agrees on. Using a fresh
        // completedAt here instead would make the manifest content for
        // the same effect differ across retries for no reason other
        // than which attempt happened to finish it.
        kind: "verification", reportId: persistedReport.reportId,
        reportSha256: persistedReport.reportSha256, createdAt: pending.startedAt,
      },
    }));
    return {
      // The resume path is only reachable for an effect this driver's own
      // begin() previously started, which only ever happens for a report
      // that was already eligible (clean and fully covered): "mismatches"
      // is not a reachable outcome for a resumed completion, and writing
      // a ternary here would be an untested, unreachable branch.
      report: persistedReport, outcome: "clean",
      effectId: pending.effectId, inputSha256: pending.inputSha256,
    };
  }
  const { report, releaseLease } = await computeVerificationReport(input, dependencies);
  // Round-2 P3: the lease stays held across persist and is released
  // only once persist itself has settled (success or failure), so a
  // second worker cannot acquire it and start a concurrent
  // recomputation while this attempt's persist is still in flight --
  // exactly the window releasing before persist left open.
  let persisted: MigrationVerificationPersistOutcome;
  try {
    persisted = reportStore.persist(input.generationId, report);
  } finally {
    await releaseLease();
  }
  const result: VerifyMigrationGenerationResult = {
    report: persisted.report, outcome: persisted.report.clean ? "clean" : "mismatches",
    effectId: migrationVerificationEffectId(persisted.report.reportSha256),
    inputSha256: persisted.report.reportSha256,
  };
  // Steps 10-11: begin and complete the manifest effect, but only for
  // a genuinely eligible report. An ineligible report -- clean but
  // missing coverage, or carrying a mismatch -- stops here: it is
  // persisted in full as operator evidence, but no effect is ever
  // begun for it, so it can never wedge activation on a bad reading.
  if (persisted.report.activationEligible) {
    let effectManifest = manifestStore.read(input.generationId);
    const beginStartedAt = new Date().toISOString();
    if (effectManifest.pendingEffect === null) {
      effectManifest = manifestStore.update(input.generationId, effectManifest.checksumSha256, (current) => beginMigrationEffect(current, {
        kind: "verify-generation", effectId: result.effectId, inputSha256: result.inputSha256,
        startedAt: beginStartedAt,
      }));
    } else {
      // Any pending effect reached here cannot be kind
      // "verify-generation": the resume shortcut at the top of this
      // function already intercepts that case unconditionally, before
      // any of the expensive work computeVerificationReport performs
      // above ever runs. So a pending effect surviving to here is
      // necessarily a different, genuinely conflicting effect (for
      // example a concurrent abort) -- refuse rather than silently
      // reusing or overwriting it.
      driverError("report-identity-conflict", "a different migration effect is already pending for this generation");
    }
    // The idempotent-adoption case -- another attempt already began
    // this exact effect -- never reaches here: it is intercepted by
    // the resume shortcut at the top of this function instead, before
    // any of this attempt's own (redundant) recomputation above ever
    // ran. So by the time control reaches this point, either this
    // attempt itself just began the effect above, or the `else`
    // branch already refused.
    const completedAt = new Date().toISOString();
    manifestStore.update(input.generationId, effectManifest.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: result.effectId, completedAt, activationEligible: true,
      report: {
        // createdAt binds to this effect's own startedAt rather than the
        // wall clock at completion, for the same reason as the resume
        // branch above: it is the one value a retry of the same effect
        // agrees on, which is what keeps the manifest content for a
        // retried attempt byte-identical to the original.
        kind: "verification", reportId: persisted.report.reportId,
        reportSha256: persisted.report.reportSha256, createdAt: beginStartedAt,
      },
    }));
  }
  return result;
}
