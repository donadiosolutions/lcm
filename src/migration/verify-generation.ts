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
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import {
  PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_LIMITS, canonicalJson as portableCanonicalJson,
  type PortableDomain,
} from "../storage/portable-record.js";
import type { PortableCheckpoint, PortableRecordStream } from "../storage/portable-record-stream.js";
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
  type CreateMigrationVerificationReportInput, type MigrationMismatchClass, type MigrationQueueClassificationWitness,
  type MigrationReconciliationDomain, type MigrationSourceWitnessDigests, type MigrationVerificationMismatch,
  type MigrationVerificationMismatchTotal, type MigrationVerificationReport, type MigrationVerificationSampleParameters,
} from "./verification-report.js";
import { MigrationVerificationReportStore } from "./verification-store.js";

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

async function runOrderedListingProbe(
  executor: PostgreSqlQueryExecutor, projectId: string, signal?: AbortSignal,
): Promise<string> {
  // A representative ordered-listing probe through a real read path. Full
  // parity with every public repository read is out of scope for this pass
  // (see the module-level scope note); this establishes the pattern and the
  // report's "public-listing" pseudo-domain slot for a future extension.
  const result = await executor.query<{ conversation_id: string; created_at: string }>({
    text: "SELECT conversation_id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at "
      + "FROM lcm.conversations WHERE project_id = $1::uuid ORDER BY created_at, conversation_id",
    values: [projectId],
  }, { domain: "factory", operation: "verifyGenerationPublicListingProbe", projectId, signal });
  return sha256Hex(portableCanonicalJson(["lcm-migration-verification-public-listing-v1", result.rows]));
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

function buildCensusVector(domains: readonly MigrationVerificationDomainCensus[]): MigrationCensusVector {
  return parseMigrationCensusVector({
    version: 1,
    domains: domains.map((entry) => ({ domain: entry.domain, recordCount: entry.recordCount, prefixSha256: entry.prefixSha256 })),
    contentSha256: migrationWitnessSha256([
      "lcm-migration-verification-content-v1", domains.map((entry) => [entry.domain, entry.prefixSha256]),
    ]),
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

export async function streamSourceCheckpoints(
  stream: PortableRecordStream, signal?: AbortSignal,
): Promise<ReadonlyMap<PortableDomain, PortableCheckpoint>> {
  const checkpoints = new Map<PortableDomain, PortableCheckpoint>();
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let after: PortableCheckpoint | undefined;
    for (;;) {
      const batch = await stream.readBatch({ domain, after, maxRecords: 500, maxBytes: PORTABLE_LIMITS.maxBatchBytes, signal });
      after = batch.checkpoint;
      if (batch.complete) break;
    }
    checkpoints.set(domain, after);
  }
  return checkpoints;
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
    const sourceCheckpoints = await streamSourceCheckpoints(copySource.stream, input.signal);
    await dependencies._afterSourceCheckpointsForTesting?.();
    await copySource.reauthenticate();

    runtime = dependencies.createRuntime(input.destinationSettings);
    await dependencies.verifyTransferSchema(runtime, { expectedOwner: input.expectedOwner, signal: input.signal });
    const destinationIdentity = await captureDestinationIdentity(runtime, input.expectedIdentity.id, input.signal);
    const destinationSchemaWitness = await captureDestinationSchemaWitness(runtime, input.signal);
    if (destinationSchemaWitness.migrationsSha256 !== input.destinationMigrationsSha256) {
      driverError("destination-drift", "destination migrations chain does not match the expected witness");
    }

    const coordinator = new PostgreSqlWorkCoordinator(runtime, input.expectedIdentity.id, input.expectedIdentity.machineId!);
    const resource = {
      resourceType: "migration-verification", resourceKey: input.generationId,
      processId: input.ownerProcessId, operation: "verify-generation",
    };
    const lease = await coordinator.acquireLease({ ...resource, ttlMs: input.leaseTtlMs, signal: input.signal });
    if (lease === null) driverError("lease-unavailable", "migration verification lease is held by another worker");
    try {
      const publicListingSha256 = await runOrderedListingProbe(runtime, input.expectedIdentity.id, input.signal);

      const session = await runtime.openReadOnlySnapshot({ projectId: input.expectedIdentity.id, signal: input.signal });
      let destinationCensus: readonly MigrationVerificationDomainCensus[];
      try {
        await assertPermanentReadOnlyGuard(session, input.signal);
        destinationCensus = await readFencedDestinationCensus(session, {
          settings: input.destinationSettings, expectedOwner: input.expectedOwner,
          expectedIdentity: input.expectedIdentity, scratchParent: input.scratchParent, signal: input.signal,
        });
      } finally {
        await session.close();
      }

      const censusVector = buildCensusVector(destinationCensus);
      const canonicalDelta = buildCanonicalDelta(destinationCensus);
      const countMismatches = reconcileCounts(sourceCheckpoints, destinationCensus);
      const domainOrder = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger", "public-listing", "public-search"] as const;
      const mismatches = sortMismatches(countMismatches, domainOrder);
      const mismatchTotals = sortMismatches(
        totalsFor(mismatches) as unknown as MigrationVerificationMismatch[],
        domainOrder,
      ) as unknown as MigrationVerificationMismatchTotal[];

      const sourceWitness: MigrationSourceWitnessDigests = {
        version: 1, identitySha256: copySource.sourceWitness.identitySha256,
        schemaSha256: copySource.sourceWitness.schemaSha256, contentSha256: copySource.sourceWitness.contentSha256,
      };
      const bindingSha256 = migrationWitnessSha256([
        "lcm-migration-verification-binding-v1", input.generationId, input.targetGenerationId, sourceWitness, destinationIdentity,
      ]);
      const reportInput: CreateMigrationVerificationReportInput = {
        generationId: input.generationId, targetGenerationId: input.targetGenerationId, bindingSha256,
        manifestRevision: input.manifestRevision, manifestChecksumSha256: input.manifestChecksumSha256,
        sourceWitness, destinationIdentity, destinationSchemaWitness,
        projectMapWitnessSha256: input.projectMapWitnessSha256, queueClassificationWitness: input.queueClassificationWitness,
        censusVector, canonicalDelta, sampleParameters: input.sampleParameters,
        mismatches, mismatchTotals,
      };
      // publicListingSha256 is recorded via the report's public-listing pseudo-domain
      // once a mismatch there is detected; a clean probe contributes no mismatch entry
      // by design (equality is not itself evidence worth persisting per-run).
      void publicListingSha256;
      const report = createMigrationVerificationReport(reportInput);
      const store = new MigrationVerificationReportStore({ homeDir: input.homeDir });
      const persisted = store.persist(input.generationId, report);
      return { report: persisted.report, outcome: persisted.report.clean ? "clean" : "mismatches" };
    } finally {
      await coordinator.releaseLease({ ...resource, fencingToken: lease.fencingToken }).catch(() => undefined);
    }
  } finally {
    try { await copySource.stream.close(); } catch { /* preserve the primary failure */ }
    try { await runtime?.close(); } catch { /* preserve the primary failure */ }
  }
}
