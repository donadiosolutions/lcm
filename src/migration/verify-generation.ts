import { createHash } from "node:crypto";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { PostgreSqlWorkCoordinator } from "../storage/postgresql/coordination.js";
import { verifyPostgreSqlTransferSchema } from "../storage/postgresql/runtime-readiness.js";
import { loadPostgreSqlMigrations } from "../storage/postgresql/migrations.js";
import { inspectPostgreSqlSearchConfiguration } from "../storage/postgresql/search-configuration.js";
import {
  createPostgreSqlPortableSource, readPostgreSqlPortableSourceDomainCensus,
  readPostgreSqlPortableWitness,
} from "../storage/postgresql/portable-source.js";
import { PostgreSqlConversationRepository } from "../storage/postgresql/conversation-repository.js";
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import {
  PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_LIMITS, canonicalJson as portableCanonicalJson,
  PORTABLE_RECORD_SCHEMA_SHA256,
  type PortableDomain,
} from "../storage/portable-record.js";
import type {
  PortableCheckpoint, PortableRecordStream, PortableRecordValueByDomain,
} from "../storage/portable-record-stream.js";
import { aggregateContentSha256 } from "../storage/portable-record-stream.js";
import { openMigrationCopySource, type MigrationCopySourceInput } from "./copy-source.js";
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
  type MigrationClassCoverageVector,
  type CreateMigrationVerificationReportInput, type MigrationMismatchClass, type MigrationQueueClassificationWitness,
  type MigrationReconciliationDomain, type MigrationSourceWitnessDigests, type MigrationVerificationMismatch,
  type MigrationVerificationMismatchTotal, type MigrationVerificationReport, type MigrationVerificationSampleParameters,
} from "./verification-report.js";
import { MigrationVerificationReportStore } from "./verification-store.js";

/**
 * V2's replacement for census-alone gating: classes this driver actually
 * checks this pass (either as a recordable mismatch, or as a hard refuse
 * that must have already passed by the time a report is built at all --
 * schema's migrations-chain check and destination-identity's sealed-
 * witness check are both the latter shape) are marked ran; classes with
 * no implementation anywhere in this driver (relation/FK closure, ledger,
 * a distinct record-level identity class) are marked not-run. A report
 * built from this vector can never claim activation eligibility while a
 * required class is unimplemented, by construction -- that is deliberate,
 * not an oversight to fix later in this same item.
 */
export const DRIVER_IMPLEMENTED_MISMATCH_CLASSES: ReadonlySet<MigrationMismatchClass> = new Set([
  "count", "digest", "identity", "sequence", "schema", "sample",
]);

function buildClassCoverageVector(): MigrationClassCoverageVector {
  return MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({
    class: mismatchClass, ran: DRIVER_IMPLEMENTED_MISMATCH_CLASSES.has(mismatchClass),
  }));
}

/**
 * The #624 verification driver: plan-v4.md section 2's frozen ordering.
 *
 * Scope note, stated plainly rather than left implicit: this pass reconciles
 * counts, the census, the canonical delta, and the destination schema
 * witness (migrations/search-configuration/collation/sequence-state)
 * end-to-end against a live PostgreSQL destination. It records but does not
 * yet independently reconcile foreign-key closure, summary-parent-links
 * acyclicity, native-transcript-message-links and project-aliases set
 * equality, ordinal contiguity/seq monotonicity, or the ledger; the "public
 * reads" step runs a representative ordered-listing probe rather than every
 * repository read path. These are flagged to the owner as a stated scope
 * reduction for this pass, not silently assumed complete.
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

async function captureDestinationSchemaWitness(
  executor: PostgreSqlQueryExecutor, signal?: AbortSignal,
): Promise<MigrationSchemaWitness> {
  const migrationsSha256 = sha256Hex(portableCanonicalJson(
    loadPostgreSqlMigrations().map(({ id, sha256: checksum }) => ({ id, sha256: checksum })),
  ));
  const searchStatus = await inspectPostgreSqlSearchConfiguration(executor, { signal });
  if (searchStatus.actualSha256 === null) driverError("invalid-input", "destination search configuration is absent");
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
export type MigrationPublicListingSourceEntry = Readonly<{ createdAt: string; identitySha256: string }>;

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
 */
async function runOrderedListingProbe(
  executor: PostgreSqlRuntime, projectId: string,
  expectedOrder: readonly MigrationPublicListingSourceEntry[], signal?: AbortSignal,
): Promise<{ mismatch: MigrationVerificationMismatch | null; publicListingSha256: string }> {
  const repository = new PostgreSqlConversationRepository(executor, projectId);
  const rows = await repository.listConversations();
  const actualOrder = rows.map((row) => truncateToMillisecondIso(row.createdAt.toISOString()));
  const publicListingSha256 = sha256Hex(portableCanonicalJson(["lcm-migration-verification-public-listing-v1", actualOrder]));
  const expectedCreatedAt = expectedOrder.map((entry) => entry.createdAt);
  const expectedSha256 = sha256Hex(portableCanonicalJson(["lcm-migration-verification-public-listing-v1", expectedCreatedAt]));
  if (expectedSha256 === publicListingSha256) return { mismatch: null, publicListingSha256 };
  // The first position where the two orders diverge, clamped so a length
  // difference still names a real source record rather than indexing
  // past the end of whichever side ran out first.
  let ordinal = 0;
  while (
    ordinal < expectedCreatedAt.length && ordinal < actualOrder.length
    && expectedCreatedAt[ordinal] === actualOrder[ordinal]
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

// --- Steps 6-7: the single fenced census window ------------------------------

export type MigrationVerificationDomainCensus = Readonly<{
  domain: PortableDomain;
  recordCount: number;
  prefixSha256: string;
  terminalIdentitySha256: string | null;
}>;

/**
 * Runs entirely inside the caller's borrowed read-only snapshot session.
 * This function receives only that session: it has no lexical access to a
 * PostgreSqlRuntime, a PostgreSqlWorkCoordinator, or any transaction-scope
 * executor, so calling a lease method or opening a read-committed-read-write
 * transaction from here is not a code-review question but a compile error.
 * Nothing here may call session.close(); the caller owns that lifetime.
 */
export async function readFencedDestinationCensus(
  session: PostgreSqlSnapshotSession,
  input: Readonly<{
    settings: PostgreSqlConnectionSettings; expectedOwner: string; expectedIdentity: StorageIdentityContext;
    scratchParent: string; signal?: AbortSignal;
  }>,
): Promise<readonly MigrationVerificationDomainCensus[]> {
  const destinationSource = await createPostgreSqlPortableSource({
    settings: input.settings, expectedOwner: input.expectedOwner, expectedIdentity: input.expectedIdentity,
    scratchParent: input.scratchParent, signal: input.signal, session,
  });
  try {
    return PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => readPostgreSqlPortableSourceDomainCensus(destinationSource, domain));
  } finally {
    // Borrowed session: this must never close it. Verified by
    // test/storage/postgresql-portable-source-borrowed-session.test.ts and
    // by this module's own crash/error-path tests.
    await destinationSource.close();
  }
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
 * Reads the sequence's own stored, on-disk state -- never
 * pg_sequence_last_value(), which is scoped to the calling session and
 * reports NULL until that same session has called nextval() itself (S1: a
 * fresh read-only snapshot session never has, so that formula always read
 * NULL here and every non-empty sequence-backed domain would mismatch,
 * even a perfectly healthy one). SELECT last_value, is_called directly
 * from the sequence relation reads the persisted state regardless of what
 * this session has done, exactly like psql's \d on a sequence. The
 * sequence name is resolved server-side via pg_get_serial_sequence and is
 * never caller input, so splicing it into the second query's FROM clause
 * (PostgreSQL forbids parameterising a relation name) admits nothing an
 * attacker controls.
 */
async function readSequenceStoredState(
  session: PostgreSqlSnapshotSession, table: string, column: string, signal?: AbortSignal,
): Promise<{ lastValue: bigint; isCalled: boolean; incrementBy: bigint } | null> {
  const nameResult = await session.query<{ seq_name: string | null }>({
    text: "SELECT pg_catalog.pg_get_serial_sequence($1, $2) AS seq_name",
    values: [table, column],
  }, { domain: "factory", operation: "verifyGenerationSequenceName", signal });
  const seqName = nameResult.rows[0]?.seq_name ?? null;
  if (seqName === null) return null;
  // pg_catalog.pg_sequences (the view, not pg_sequence the catalog table)
  // is deliberately used for last_value/is_called: its definition gates
  // last_value on has_sequence_privilege(oid, 'SELECT') OR (..., 'USAGE'),
  // so the least-privilege runtime role -- granted USAGE on every
  // identity sequence but never SELECT -- still reads a real value here,
  // unlike a direct "SELECT last_value FROM <sequence>", which requires
  // SELECT specifically and would silently reintroduce the same fail-
  // closed defect this replaces. increment_by is ordinary catalog
  // metadata (pg_sequence), publicly readable regardless of sequence-
  // level ACLs, joined by oid via ::regclass rather than by name-string
  // matching so a quoting-sensitive identifier cannot desync the join.
  const result = await session.query<{ last_value: string | null; is_called: boolean | null; increment_by: string }>({
    text: "SELECT ps.last_value::text AS last_value, ps.is_called, pc.increment_by::text AS increment_by "
      + "FROM pg_catalog.pg_sequences ps "
      + "JOIN pg_catalog.pg_namespace n ON n.nspname OPERATOR(pg_catalog.=) ps.schemaname "
      + "JOIN pg_catalog.pg_class c ON c.relnamespace OPERATOR(pg_catalog.=) n.oid "
      + "AND c.relname OPERATOR(pg_catalog.=) ps.sequencename "
      + "JOIN pg_catalog.pg_sequence pc ON pc.seqrelid OPERATOR(pg_catalog.=) c.oid "
      + "WHERE c.oid OPERATOR(pg_catalog.=) $1::regclass",
    values: [seqName],
  }, { domain: "factory", operation: "verifyGenerationSequenceLastValue", signal });
  const row = result.rows[0];
  if (row === undefined || row.last_value === null || row.is_called === null) return null;
  return { lastValue: BigInt(row.last_value), isCalled: row.is_called, incrementBy: BigInt(row.increment_by) };
}
export async function readSequenceSelfConsistencyMismatches(
  session: PostgreSqlSnapshotSession, projectId: string, signal?: AbortSignal,
): Promise<MigrationVerificationMismatch[]> {
  const mismatches: MigrationVerificationMismatch[] = [];
  for (const [domain, target] of Object.entries(SEQUENCE_BACKED_IDENTITY_COLUMN)) {
    const maxResult = await session.query<{ max_value: string | null }>({
      text: "SELECT MAX(" + target.column + ")::text AS max_value FROM " + target.table + " WHERE project_id = $1::uuid",
      values: [projectId],
    }, { domain: "factory", operation: "verifyGenerationSequenceSelfConsistencyMax", projectId, signal });
    const maxValue = maxResult.rows[0]?.max_value ?? null;
    if (maxValue === null) continue; // domain is empty for this project: nothing to bound.
    const state = await readSequenceStoredState(session, target.table, target.column, signal);
    // is_called=false means nextval() has never run: the *next* call
    // returns last_value itself (the start value), not last_value plus
    // the increment. Getting this boundary backwards is exactly the S1
    // defect this replaces: a never-called sequence whose start value
    // collides with an already-copied row must still be caught.
    const nextAllocatedValue = state === null ? null
      : state.isCalled ? state.lastValue + state.incrementBy : state.lastValue;
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
}

export async function streamSourceCheckpoints(
  stream: PortableRecordStream, signal?: AbortSignal,
): Promise<StreamedSourceCheckpoints> {
  const checkpoints = new Map<PortableDomain, PortableCheckpoint>();
  const conversationEntries: Array<{ createdAt: string; identitySha256: string }> = [];
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let after: PortableCheckpoint | undefined;
    for (;;) {
      const batch = await stream.readBatch({ domain, after, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes, signal });
      if (domain === "conversations") {
        for (const record of batch.records) {
          const value = record.value as PortableRecordValueByDomain["conversations"];
          conversationEntries.push({
            createdAt: truncateToMillisecondIso(value.createdAt), identitySha256: record.identitySha256,
          });
        }
      }
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
        identitySha256: domainMismatchIdentity(["count", entry.domain, source.recordCount, entry.recordCount]),
      });
    } else if (source.prefixSha256 !== entry.prefixSha256) {
      mismatches.push({
        domain: entry.domain, class: "digest",
        identitySha256: domainMismatchIdentity(["digest", entry.domain, source.prefixSha256, entry.prefixSha256]),
      });
    }
  }
  return mismatches;
}

export function mismatchOrdinal(value: MigrationVerificationMismatch, order: readonly MigrationReconciliationDomain[]): readonly [number, string, string] {
  return [order.indexOf(value.domain), value.class, value.identitySha256];
}

export function sortMismatches(
  mismatches: readonly MigrationVerificationMismatch[], order: readonly MigrationReconciliationDomain[],
): MigrationVerificationMismatch[] {
  return [...mismatches].sort((left, right) => {
    const [leftDomain, leftClass, leftIdentity] = mismatchOrdinal(left, order);
    const [rightDomain, rightClass, rightIdentity] = mismatchOrdinal(right, order);
    if (leftDomain !== rightDomain) return leftDomain - rightDomain;
    if (leftClass !== rightClass) return leftClass < rightClass ? -1 : 1;
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
  const perClassRetained = new Map<MigrationMismatchClass, number>();
  return mismatches.filter((mismatch) => {
    const retained = perClassRetained.get(mismatch.class) ?? 0;
    perClassRetained.set(mismatch.class, retained + 1);
    return retained < MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT;
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
   * never a live observation. This driver does not itself call
   * beginMigrationEffect/completeMigrationEffect (that manifest-effect
   * wiring is a separate, not-yet-built caller), but pinning the formula
   * here means that caller has no choice to make, and two independent
   * drivers over an identical persisted report mint the same effectId --
   * the property the concurrent-begin adoption rule needs.
   */
  readonly effectId: string;
  readonly inputSha256: string;
}

/** effectId = `verify-generation-${reportSha256}`, inputSha256 = reportSha256. Pinned, not asserted. */
export function migrationVerificationEffectId(reportSha256: string): string {
  return `verify-generation-${reportSha256}`;
}

/**
 * Drives plan-v4.md section 2 end to end for one attempt. Never retries
 * internally: a connection loss or any other failure propagates to the
 * caller, and restarting means calling this function again from scratch.
 * Nothing is persisted until the fully-formed report is ready to write.
 */
export async function verifyMigrationGeneration(
  input: VerifyMigrationGenerationInput,
  dependencies: VerifyMigrationGenerationDependencies = defaultDependencies,
): Promise<VerifyMigrationGenerationResult> {
  const copySource = await dependencies.openSource({
    generationId: input.generationId, homeDir: input.homeDir, expectedIdentity: input.expectedIdentity,
    scratchParent: input.scratchParent, signal: input.signal,
  });
  let runtime: PostgreSqlRuntime | undefined;
  try {
    await copySource.reauthenticate();
    const { checkpoints: sourceCheckpoints, conversationsPublicOrder } = await streamSourceCheckpoints(copySource.stream, input.signal);
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

    const coordinator = new PostgreSqlWorkCoordinator(runtime, input.expectedIdentity.id, input.expectedIdentity.machineId!);
    const resource = {
      resourceType: "migration-verification", resourceKey: input.generationId,
      processId: input.ownerProcessId, operation: "verify-generation",
    };
    const lease = await coordinator.acquireLease({ ...resource, ttlMs: input.leaseTtlMs, signal: input.signal });
    if (lease === null) driverError("lease-unavailable", "migration verification lease is held by another worker");
    try {
      const { mismatch: publicListingMismatch, publicListingSha256 } = await runOrderedListingProbe(
        runtime, input.expectedIdentity.id, conversationsPublicOrder, input.signal,
      );

      const session = await runtime.openReadOnlySnapshot({ projectId: input.expectedIdentity.id, signal: input.signal });
      let destinationCensus: readonly MigrationVerificationDomainCensus[];
      let sequenceMismatches: MigrationVerificationMismatch[];
      try {
        await assertPermanentReadOnlyGuard(session, input.signal);
        destinationCensus = await readFencedDestinationCensus(session, {
          settings: input.destinationSettings, expectedOwner: input.expectedOwner,
          expectedIdentity: input.expectedIdentity, scratchParent: input.scratchParent, signal: input.signal,
        });
        sequenceMismatches = await readSequenceSelfConsistencyMismatches(session, input.expectedIdentity.id, input.signal);
      } finally {
        await session.close();
      }

      const censusVector = buildCensusVector(destinationCensus);
      const canonicalDelta = buildCanonicalDelta(destinationCensus);
      const countMismatches = reconcileCounts(sourceCheckpoints, destinationCensus);
      const domainOrder = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger", "public-listing", "public-search"] as const;
      const allMismatches = [
        ...countMismatches, ...sequenceMismatches, ...(publicListingMismatch ? [publicListingMismatch] : []),
      ];
      const fullMismatches = sortMismatches(allMismatches, domainOrder);
      // Totals must reflect the full (untruncated) evidence: truncation is
      // an operator-facing display bound on retained entries, never on the
      // exact count the operator is told about.
      const mismatchTotals = sortMismatches(
        totalsFor(fullMismatches) as unknown as MigrationVerificationMismatch[],
        domainOrder,
      ) as unknown as MigrationVerificationMismatchTotal[];
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
      ]);
      const reportInput: CreateMigrationVerificationReportInput = {
        generationId: input.generationId, targetGenerationId: input.targetGenerationId, bindingSha256,
        manifestRevision: input.manifestRevision, manifestChecksumSha256: input.manifestChecksumSha256,
        sourceWitness, destinationIdentity, destinationSchemaWitness,
        projectMapWitnessSha256: input.projectMapWitnessSha256, queueClassificationWitness: input.queueClassificationWitness,
        censusVector, canonicalDelta, classCoverage: buildClassCoverageVector(),
        publicProbeSha256, sampleParameters: input.sampleParameters,
        mismatches, mismatchTotals,
      };
      const report = createMigrationVerificationReport(reportInput);
      const store = new MigrationVerificationReportStore({ homeDir: input.homeDir });
      const persisted = store.persist(input.generationId, report);
      return {
        report: persisted.report, outcome: persisted.report.clean ? "clean" : "mismatches",
        effectId: migrationVerificationEffectId(persisted.report.reportSha256),
        inputSha256: persisted.report.reportSha256,
      };
    } finally {
      await coordinator.releaseLease({ ...resource, fencingToken: lease.fencingToken }).catch(() => undefined);
    }
  } finally {
    try { await copySource.stream.close(); } catch { /* preserve the primary failure */ }
    try { await runtime?.close(); } catch { /* preserve the primary failure */ }
  }
}
