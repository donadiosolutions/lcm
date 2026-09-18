import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../storage/portable-record.js";
import {
  migrationWitnessSha256,
  parseMigrationCanonicalDelta,
  parseMigrationCensusVector,
  parseMigrationDestinationIdentity,
  parseMigrationSchemaWitness,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
  type MigrationSchemaWitness,
} from "./activation-witness.js";

/**
 * The #624 verification report body, census vector, canonical delta and
 * bounded mismatch vocabulary. Pure, no I/O: it validates and hashes report
 * structures per plan-v4.md sections 4-6, but performs no read of any kind.
 */

export type MigrationVerificationReportReason =
  | "invalid-input"
  | "malformed-record"
  | "unexpected-state";

export class MigrationVerificationReportError extends Error {
  constructor(
    readonly reason: MigrationVerificationReportReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationVerificationReportError";
  }
}

function reportError(
  reason: MigrationVerificationReportReason,
  message: string,
  options?: ErrorOptions,
): never {
  throw new MigrationVerificationReportError(reason, message, options);
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_SEQUENCE_PATTERN = /^\d{19}$/u;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function assertExactObject(value: unknown, keys: readonly string[], label: string): RecordValue {
  if (!isRecord(value) || !exactKeys(value, keys)) reportError("malformed-record", `${label} has an invalid shape`);
  return value;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const item of Object.values(value)) deepFreeze(item);
    }
  }
  return value;
}

// --- Frozen mismatch vocabulary and domain ordinal ---------------------------

export const MIGRATION_RECONCILIATION_DOMAIN_ORDER = Object.freeze([
  ...PORTABLE_RECORD_DOMAIN_ORDER,
  "schema",
  "ledger",
  "public-listing",
  "public-search",
] as const);
export type MigrationReconciliationDomain = (typeof MIGRATION_RECONCILIATION_DOMAIN_ORDER)[number];

const RECONCILIATION_DOMAIN_ORDINAL = new Map<MigrationReconciliationDomain, number>(
  MIGRATION_RECONCILIATION_DOMAIN_ORDER.map((domain, index) => [domain, index]),
);

/** Closed mismatch vocabulary; nothing outside this set may ever be recorded. */
export const MIGRATION_MISMATCH_CLASSES = Object.freeze([
  "count", "digest", "identity", "relation", "sequence", "schema", "ledger", "sample",
] as const);
export type MigrationMismatchClass = (typeof MIGRATION_MISMATCH_CLASSES)[number];

const MISMATCH_CLASS_ORDINAL = new Map<MigrationMismatchClass, number>(
  MIGRATION_MISMATCH_CLASSES.map((klass, index) => [klass, index]),
);

/** Frozen per-class bound on the number of retained mismatch entries; exact totals are retained separately. */
export const MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT = 100;

// --- Class-coverage vector ---------------------------------------------------

/**
 * V2's repair for census-alone gating: an empty mismatch list can look
 * clean when a required class simply never ran (foreign keys, DAG,
 * samples, ledger), which produces no mismatches precisely because the
 * check did not execute. This vector makes coverage provable from the
 * artifact itself -- one entry per closed mismatch class, in
 * MIGRATION_MISMATCH_CLASSES order, each stating whether that class ran
 * this pass -- rather than assumed from an absence of recorded mismatches.
 */
export type MigrationClassCoverageEntry = Readonly<{
  class: MigrationMismatchClass;
  ran: boolean;
}>;
export type MigrationClassCoverageVector = readonly MigrationClassCoverageEntry[];

function parseMigrationClassCoverageVector(value: unknown): MigrationClassCoverageVector {
  if (!Array.isArray(value) || value.length !== MIGRATION_MISMATCH_CLASSES.length) {
    reportError("invalid-input", "class coverage vector must have exactly one entry per mismatch class");
  }
  const entries = value.map((entry, index) => {
    const record = assertExactObject(entry, ["class", "ran"], "class coverage entry");
    if (record.class !== MIGRATION_MISMATCH_CLASSES[index] || typeof record.ran !== "boolean") {
      reportError("invalid-input", "class coverage vector is not in the frozen class order");
    }
    return { class: record.class as MigrationMismatchClass, ran: record.ran };
  });
  return deepFreeze(entries);
}

/**
 * Frozen ordering marker for the step 5 public probes: they always run
 * before the step 6 census window opens, and only ever describe an
 * instant at or before the census. The report body carries no wall clock,
 * so this versioned constant is how the skew is disclosed structurally
 * rather than through prose the body cannot express. See
 * docs/migration-verification.md for the operator-facing explanation.
 */
export const MIGRATION_PUBLIC_PROBE_ORDERING_SHA256 = migrationWitnessSha256([
  "lcm-migration-verification-public-probe-ordering-v1", "probe-before-census",
]);

function isReconciliationDomain(value: unknown): value is MigrationReconciliationDomain {
  return typeof value === "string" && RECONCILIATION_DOMAIN_ORDINAL.has(value as MigrationReconciliationDomain);
}

function isMismatchClass(value: unknown): value is MigrationMismatchClass {
  return typeof value === "string" && MISMATCH_CLASS_ORDINAL.has(value as MigrationMismatchClass);
}

/**
 * Redaction ceiling: domain, class and identity digest only. A sample
 * mismatch reports only that a sample diverged and its identity digest,
 * never differing values or a diff shape -- this is the same shape as every
 * other mismatch, so the ceiling is structural rather than a rule to
 * remember per class.
 */
export type MigrationVerificationMismatch = Readonly<{
  domain: MigrationReconciliationDomain;
  class: MigrationMismatchClass;
  identitySha256: string;
}>;

function mismatchOrdinal(value: MigrationVerificationMismatch): readonly [number, number, string] {
  return [RECONCILIATION_DOMAIN_ORDINAL.get(value.domain)!, MISMATCH_CLASS_ORDINAL.get(value.class)!, value.identitySha256];
}

function compareMismatchOrdinals(
  left: readonly [number, number, string],
  right: readonly [number, number, string],
): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] === right[2] ? 0 : left[2] < right[2] ? -1 : 1;
}

function parseMismatch(value: unknown): MigrationVerificationMismatch {
  const record = assertExactObject(value, ["class", "domain", "identitySha256"], "verification mismatch");
  if (!isReconciliationDomain(record.domain) || !isMismatchClass(record.class) || !isHash(record.identitySha256)) {
    reportError("invalid-input", "verification mismatch is invalid");
  }
  return { domain: record.domain, class: record.class, identitySha256: record.identitySha256 as string };
}

export type MigrationVerificationMismatchTotal = Readonly<{
  domain: MigrationReconciliationDomain;
  class: MigrationMismatchClass;
  count: number;
}>;

function parseMismatchTotal(value: unknown): MigrationVerificationMismatchTotal {
  const record = assertExactObject(value, ["class", "count", "domain"], "verification mismatch total");
  if (!isReconciliationDomain(record.domain) || !isMismatchClass(record.class) || !isSafePositiveInteger(record.count)) {
    reportError("invalid-input", "verification mismatch total is invalid");
  }
  return { domain: record.domain, class: record.class, count: record.count as number };
}

function assertSortedUnique<T>(
  values: readonly T[],
  ordinal: (value: T) => readonly [number, number, string],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const comparison = compareMismatchOrdinals(ordinal(values[index - 1]!), ordinal(values[index]!));
    if (comparison > 0) reportError("invalid-input", `${label} must be sorted by (domain ordinal, class, identity digest)`);
    if (comparison === 0) reportError("invalid-input", `${label} must not repeat a (domain, class, identity) entry`);
  }
}

function assertMismatchesConsistentWithTotals(
  mismatches: readonly MigrationVerificationMismatch[],
  totals: readonly MigrationVerificationMismatchTotal[],
): void {
  const recordedCounts = new Map<string, number>();
  for (const mismatch of mismatches) {
    const key = `${mismatch.domain}\u0000${mismatch.class}`;
    recordedCounts.set(key, (recordedCounts.get(key) ?? 0) + 1);
  }
  const perClassRecorded = new Map<MigrationMismatchClass, number>();
  for (const [key, count] of recordedCounts) {
    const klass = key.split("\u0000")[1] as MigrationMismatchClass;
    perClassRecorded.set(klass, (perClassRecorded.get(klass) ?? 0) + count);
  }
  for (const [klass, count] of perClassRecorded) {
    if (count > MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT) {
      reportError("invalid-input", `mismatch class "${klass}" exceeds the frozen per-class truncation limit`);
    }
  }
  const totalsByKey = new Map<string, number>();
  for (const total of totals) {
    const key = `${total.domain}\u0000${total.class}`;
    // assertSortedUnique already rejected a duplicate (domain, class) total
    // before this function runs, so this insertion can never overwrite.
    totalsByKey.set(key, total.count);
  }
  for (const [key, recorded] of recordedCounts) {
    const total = totalsByKey.get(key);
    if (total === undefined) reportError("unexpected-state", "a recorded mismatch has no matching total entry");
    if (total < recorded) reportError("unexpected-state", "a mismatch total is smaller than its recorded entries");
  }
  for (const key of totalsByKey.keys()) {
    if (!recordedCounts.has(key)) reportError("unexpected-state", "a mismatch total has no recorded entries");
  }
}

// --- Sample parameters -------------------------------------------------------

export type MigrationVerificationSampleParameters = Readonly<{
  version: 1;
  strideOrdinal: number;
  sampleCount: number;
  seedBasisSha256: string;
}>;

export function parseMigrationVerificationSampleParameters(
  value: unknown,
): MigrationVerificationSampleParameters {
  const record = assertExactObject(
    value,
    ["sampleCount", "seedBasisSha256", "strideOrdinal", "version"],
    "sample parameters",
  );
  if (
    record.version !== 1
    || !isSafePositiveInteger(record.strideOrdinal)
    || !isSafeNonNegativeInteger(record.sampleCount)
    || !isHash(record.seedBasisSha256)
  ) {
    reportError("invalid-input", "sample parameters are invalid");
  }
  return deepFreeze({
    version: 1,
    strideOrdinal: record.strideOrdinal as number,
    sampleCount: record.sampleCount as number,
    seedBasisSha256: record.seedBasisSha256 as string,
  });
}

// --- Sealed queue-classification witness -------------------------------------

export type MigrationQueueClassificationWitness = Readonly<{
  version: 1;
  queueCutoff: string | null;
  queueSetSha256: string;
  receiptSetSha256: string;
  epochChecksumSha256: string;
}>;

export function parseMigrationQueueClassificationWitness(value: unknown): MigrationQueueClassificationWitness {
  const record = assertExactObject(
    value,
    ["epochChecksumSha256", "queueCutoff", "queueSetSha256", "receiptSetSha256", "version"],
    "queue-classification witness",
  );
  if (
    record.version !== 1
    || (record.queueCutoff !== null && (typeof record.queueCutoff !== "string" || !EVENT_SEQUENCE_PATTERN.test(record.queueCutoff)))
    || !isHash(record.queueSetSha256)
    || !isHash(record.receiptSetSha256)
    || !isHash(record.epochChecksumSha256)
  ) {
    reportError("invalid-input", "queue-classification witness is invalid");
  }
  return deepFreeze({
    version: 1,
    queueCutoff: record.queueCutoff as string | null,
    queueSetSha256: record.queueSetSha256 as string,
    receiptSetSha256: record.receiptSetSha256 as string,
    epochChecksumSha256: record.epochChecksumSha256 as string,
  });
}

// --- Source witness digests (no capturedAt: a clock never gates) -----------

export type MigrationSourceWitnessDigests = Readonly<{
  version: 1;
  identitySha256: string;
  schemaSha256: string;
  contentSha256: string;
}>;

export function parseMigrationSourceWitnessDigests(value: unknown): MigrationSourceWitnessDigests {
  const record = assertExactObject(
    value,
    ["contentSha256", "identitySha256", "schemaSha256", "version"],
    "source witness digests",
  );
  if (
    record.version !== 1
    || !isHash(record.identitySha256)
    || !isHash(record.schemaSha256)
    || !isHash(record.contentSha256)
  ) {
    reportError("invalid-input", "source witness digests are invalid");
  }
  return deepFreeze({
    version: 1,
    identitySha256: record.identitySha256 as string,
    schemaSha256: record.schemaSha256 as string,
    contentSha256: record.contentSha256 as string,
  });
}

// --- Report body: deterministic inputs, fixed enumerated order -------------

export type MigrationVerificationReportBody = Readonly<{
  version: 1;
  generationId: string;
  targetGenerationId: string;
  bindingSha256: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  sourceWitness: MigrationSourceWitnessDigests;
  destinationIdentity: MigrationDestinationIdentity;
  destinationSchemaWitness: MigrationSchemaWitness;
  projectMapWitnessSha256: string;
  queueClassificationWitness: MigrationQueueClassificationWitness;
  censusVector: MigrationCensusVector;
  canonicalDelta: MigrationCanonicalDelta;
  classCoverage: MigrationClassCoverageVector;
  /**
   * Binds the step 5 public-read probe outcome into the identity so it can
   * never again be recorded and discarded. The driver derives this from
   * MIGRATION_PUBLIC_PROBE_ORDERING_SHA256 plus the expected (source) and
   * actual (destination repository) probe digests; this module validates
   * only that it is a hash, the same way it treats bindingSha256.
   */
  publicProbeSha256: string;
  reconciliationOutcomeDigestSha256: string;
  sampleParameters: MigrationVerificationSampleParameters;
}>;

export type CreateMigrationVerificationReportBodyInput = Readonly<{
  generationId: string;
  targetGenerationId: string;
  bindingSha256: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  sourceWitness: MigrationSourceWitnessDigests;
  destinationIdentity: MigrationDestinationIdentity;
  destinationSchemaWitness: MigrationSchemaWitness;
  projectMapWitnessSha256: string;
  queueClassificationWitness: MigrationQueueClassificationWitness;
  censusVector: MigrationCensusVector;
  canonicalDelta: MigrationCanonicalDelta;
  classCoverage: MigrationClassCoverageVector;
  publicProbeSha256: string;
  sampleParameters: MigrationVerificationSampleParameters;
  mismatches: readonly MigrationVerificationMismatch[];
  mismatchTotals: readonly MigrationVerificationMismatchTotal[];
}>;

/** The reconciliation outcome digest binds the exact mismatch evidence into the body without carrying its bytes twice. */
export function migrationReconciliationOutcomeDigest(
  mismatches: readonly MigrationVerificationMismatch[],
  mismatchTotals: readonly MigrationVerificationMismatchTotal[],
): string {
  return migrationWitnessSha256([
    "lcm-migration-reconciliation-outcome-v1",
    mismatches.map((mismatch) => [mismatch.domain, mismatch.class, mismatch.identitySha256]),
    mismatchTotals.map((total) => [total.domain, total.class, total.count]),
  ]);
}

export function createMigrationVerificationReportBody(
  input: CreateMigrationVerificationReportBodyInput,
): MigrationVerificationReportBody {
  if (
    !isIdentifier(input.generationId)
    || !isIdentifier(input.targetGenerationId)
    || !isHash(input.bindingSha256)
    || !isSafeNonNegativeInteger(input.manifestRevision)
    || !isHash(input.manifestChecksumSha256)
    || !isHash(input.projectMapWitnessSha256)
    || !isHash(input.publicProbeSha256)
  ) {
    reportError("invalid-input", "verification report body input is invalid");
  }
  const sourceWitness = parseMigrationSourceWitnessDigests(input.sourceWitness);
  const destinationIdentity = parseMigrationDestinationIdentity(input.destinationIdentity);
  const destinationSchemaWitness = parseMigrationSchemaWitness(input.destinationSchemaWitness);
  const queueClassificationWitness = parseMigrationQueueClassificationWitness(input.queueClassificationWitness);
  const censusVector = parseMigrationCensusVector(input.censusVector);
  const canonicalDelta = parseMigrationCanonicalDelta(input.canonicalDelta);
  const classCoverage = parseMigrationClassCoverageVector(input.classCoverage);
  const sampleParameters = parseMigrationVerificationSampleParameters(input.sampleParameters);
  if (!Array.isArray(input.mismatches) || !Array.isArray(input.mismatchTotals)) {
    reportError("invalid-input", "verification report mismatch evidence is invalid");
  }
  const mismatches = input.mismatches.map(parseMismatch);
  const mismatchTotals = input.mismatchTotals.map(parseMismatchTotal);
  assertSortedUnique(mismatches, mismatchOrdinal, "verification report mismatches");
  assertSortedUnique(mismatchTotals, (total) => [
    RECONCILIATION_DOMAIN_ORDINAL.get(total.domain)!, MISMATCH_CLASS_ORDINAL.get(total.class)!, "",
  ], "verification report mismatch totals");
  assertMismatchesConsistentWithTotals(mismatches, mismatchTotals);
  // A class marked as not-run cannot have produced mismatch evidence: that
  // combination is self-contradictory (evidence from a check that did not
  // execute), never a real report state.
  const ranClasses = new Set(classCoverage.filter((entry) => entry.ran).map((entry) => entry.class));
  if (mismatchTotals.some((total) => !ranClasses.has(total.class))) {
    reportError("invalid-input", "a mismatch total names a class the coverage vector marks as not run");
  }
  return deepFreeze({
    version: 1,
    generationId: input.generationId,
    targetGenerationId: input.targetGenerationId,
    bindingSha256: input.bindingSha256,
    manifestRevision: input.manifestRevision,
    manifestChecksumSha256: input.manifestChecksumSha256,
    sourceWitness,
    destinationIdentity,
    destinationSchemaWitness,
    projectMapWitnessSha256: input.projectMapWitnessSha256,
    queueClassificationWitness,
    censusVector,
    canonicalDelta,
    classCoverage,
    publicProbeSha256: input.publicProbeSha256,
    reconciliationOutcomeDigestSha256: migrationReconciliationOutcomeDigest(mismatches, mismatchTotals),
    sampleParameters,
  });
}

// --- The persisted report artifact ------------------------------------------

export type MigrationVerificationReport = Readonly<{
  version: 1;
  reportId: string;
  body: MigrationVerificationReportBody;
  mismatches: readonly MigrationVerificationMismatch[];
  mismatchTotals: readonly MigrationVerificationMismatchTotal[];
  /** Recomputed, never carried: true iff mismatchTotals is empty. */
  clean: boolean;
  /**
   * Recomputed, never carried: true iff clean AND every entry in the
   * body's classCoverage vector ran. A report can be clean while some
   * required class never executed (relation/ledger are not yet
   * implemented anywhere in this driver); such a report is deliberately
   * ineligible for activation until that coverage gap is closed, per
   * plan-v4's replacement for census-alone gating.
   */
  activationEligible: boolean;
  reportSha256: string;
}>;

export type CreateMigrationVerificationReportInput = Readonly<
  Omit<CreateMigrationVerificationReportBodyInput, "mismatches" | "mismatchTotals">
  & { readonly mismatches: readonly MigrationVerificationMismatch[]; readonly mismatchTotals: readonly MigrationVerificationMismatchTotal[] }
>;

function reportPayloadSha256(
  body: MigrationVerificationReportBody,
  mismatches: readonly MigrationVerificationMismatch[],
  mismatchTotals: readonly MigrationVerificationMismatchTotal[],
  clean: boolean,
  activationEligible: boolean,
): string {
  return migrationWitnessSha256([
    "lcm-migration-verification-report-v1", body, mismatches, mismatchTotals, clean, activationEligible,
  ]);
}

export function createMigrationVerificationReport(
  input: CreateMigrationVerificationReportInput,
): MigrationVerificationReport {
  const body = createMigrationVerificationReportBody(input);
  // createMigrationVerificationReportBody has already validated and sorted these.
  const mismatches = input.mismatches.map(parseMismatch);
  const mismatchTotals = input.mismatchTotals.map(parseMismatchTotal);
  const clean = mismatchTotals.length === 0;
  const activationEligible = clean && body.classCoverage.every((entry) => entry.ran);
  const reportSha256 = reportPayloadSha256(body, mismatches, mismatchTotals, clean, activationEligible);
  return deepFreeze({
    version: 1,
    reportId: `verify-generation-${reportSha256}`,
    body,
    mismatches,
    mismatchTotals,
    clean,
    activationEligible,
    reportSha256,
  });
}

export function parseMigrationVerificationReport(value: unknown): MigrationVerificationReport {
  const record = assertExactObject(
    value,
    ["activationEligible", "body", "clean", "mismatchTotals", "mismatches", "reportId", "reportSha256", "version"],
    "verification report",
  );
  if (
    record.version !== 1
    || !isIdentifier(record.reportId)
    || !isHash(record.reportSha256)
    || typeof record.clean !== "boolean"
    || typeof record.activationEligible !== "boolean"
  ) {
    reportError("invalid-input", "verification report is invalid");
  }
  if (!isRecord(record.body)) reportError("malformed-record", "verification report body is invalid");
  const body = createMigrationVerificationReportBody({
    generationId: (record.body as RecordValue).generationId as string,
    targetGenerationId: (record.body as RecordValue).targetGenerationId as string,
    bindingSha256: (record.body as RecordValue).bindingSha256 as string,
    manifestRevision: (record.body as RecordValue).manifestRevision as number,
    manifestChecksumSha256: (record.body as RecordValue).manifestChecksumSha256 as string,
    sourceWitness: (record.body as RecordValue).sourceWitness as MigrationSourceWitnessDigests,
    destinationIdentity: (record.body as RecordValue).destinationIdentity as MigrationDestinationIdentity,
    destinationSchemaWitness: (record.body as RecordValue).destinationSchemaWitness as MigrationSchemaWitness,
    projectMapWitnessSha256: (record.body as RecordValue).projectMapWitnessSha256 as string,
    queueClassificationWitness: (record.body as RecordValue).queueClassificationWitness as MigrationQueueClassificationWitness,
    censusVector: (record.body as RecordValue).censusVector as MigrationCensusVector,
    canonicalDelta: (record.body as RecordValue).canonicalDelta as MigrationCanonicalDelta,
    classCoverage: (record.body as RecordValue).classCoverage as MigrationClassCoverageVector,
    publicProbeSha256: (record.body as RecordValue).publicProbeSha256 as string,
    sampleParameters: (record.body as RecordValue).sampleParameters as MigrationVerificationSampleParameters,
    mismatches: Array.isArray(record.mismatches) ? record.mismatches : [],
    mismatchTotals: Array.isArray(record.mismatchTotals) ? record.mismatchTotals : [],
  });
  if (!Array.isArray(record.mismatches) || !Array.isArray(record.mismatchTotals)) {
    reportError("invalid-input", "verification report mismatch evidence is invalid");
  }
  const mismatches = record.mismatches.map(parseMismatch);
  const mismatchTotals = record.mismatchTotals.map(parseMismatchTotal);
  const clean = mismatchTotals.length === 0;
  if (clean !== record.clean) reportError("unexpected-state", "verification report clean flag does not match its mismatch totals");
  const activationEligible = clean && body.classCoverage.every((entry) => entry.ran);
  if (activationEligible !== record.activationEligible) {
    reportError("unexpected-state", "verification report activationEligible flag does not match its class coverage");
  }
  const reportSha256 = reportPayloadSha256(body, mismatches, mismatchTotals, clean, activationEligible);
  if (reportSha256 !== record.reportSha256) reportError("unexpected-state", "verification report checksum does not match its content");
  if (record.reportId !== `verify-generation-${reportSha256}`) {
    reportError("unexpected-state", "verification report id does not match its content");
  }
  return deepFreeze({
    version: 1,
    reportId: record.reportId as string,
    body,
    mismatches,
    mismatchTotals,
    clean,
    activationEligible,
    reportSha256,
  });
}
