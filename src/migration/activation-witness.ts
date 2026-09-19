import { createHash } from "node:crypto";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../storage/portable-record.js";

/**
 * Frozen shared activation/rollback witness schema for #624/#625/#626.
 *
 * Pure, no I/O. Implements the in-force sections of
 * .superpowers/624/witness-schema-FROZEN-v2.md (2-6, 9, 10), replaced by
 * witness-schema-FROZEN-v3.md (7, 8, adds 11) and amended by
 * witness-schema-FROZEN-v3.1.md (corrects 11, adds 12 persistence rule
 * consumed by verification-store.ts, corrects the v2 section 9 field path).
 *
 * This module can force #625 and #626 to carry specific, internally
 * consistent values and recomputes every verdict rather than trusting a
 * carried one. It cannot prove a live fenced read happened, because a pure
 * module has no I/O; a dishonest caller can fabricate a consistent-looking
 * set. #625 and #626 close that residue with drift-injection acceptance
 * tests, not this module.
 */

export type MigrationActivationWitnessReason =
  | "invalid-input"
  | "malformed-record"
  | "unexpected-state";

export class MigrationActivationWitnessError extends Error {
  constructor(
    readonly reason: MigrationActivationWitnessReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationActivationWitnessError";
  }
}

function witnessError(
  reason: MigrationActivationWitnessReason,
  message: string,
  options?: ErrorOptions,
): never {
  throw new MigrationActivationWitnessError(reason, message, options);
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)$/u;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): RecordValue {
  if (!isRecord(value) || !exactKeys(value, keys)) {
    witnessError("malformed-record", `${label} has an invalid shape`);
  }
  return value;
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value is not canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("value is not canonical JSON");
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (isRecord(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("value is not canonical JSON");
    }
    if (seen.has(value)) throw new TypeError("value is not canonical JSON");
    seen.add(value);
    try {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError("value is not canonical JSON");
}

/** Canonical sha256 digest, exported for report/store modules that must bind to the same formula. */
export function migrationWitnessSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value, new Set()), "utf8").digest("hex");
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

function assertDomainVector<T extends Readonly<{ domain: PortableDomain }>>(
  domains: unknown,
  label: string,
  parseEntry: (value: unknown, expectedDomain: PortableDomain) => T,
): readonly T[] {
  if (!Array.isArray(domains) || domains.length !== PORTABLE_RECORD_DOMAIN_ORDER.length) {
    witnessError("malformed-record", `${label} must carry exactly the frozen domain order`);
  }
  return PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => parseEntry(domains[index], domain));
}

// --- Section 2: MigrationSelectionAuthority ---------------------------------

export type MigrationSelectionAuthority = Readonly<{
  version: 1;
  resourceType: string;
  resourceKey: string;
  /** Decimal string, nonnegative, compared as a big integer, never a JS number. */
  fencingToken: string;
  ownerProcessId: string;
}>;

export function parseMigrationSelectionAuthority(value: unknown): MigrationSelectionAuthority {
  const record = assertExactObject(
    value,
    ["fencingToken", "ownerProcessId", "resourceKey", "resourceType", "version"],
    "selection authority",
  );
  if (
    record.version !== 1
    || !isIdentifier(record.resourceType)
    || !isIdentifier(record.resourceKey)
    || !isDecimalString(record.fencingToken)
    || !isIdentifier(record.ownerProcessId)
  ) {
    witnessError("invalid-input", "selection authority is invalid");
  }
  return deepFreeze({
    version: 1,
    resourceType: record.resourceType as string,
    resourceKey: record.resourceKey as string,
    fencingToken: record.fencingToken as string,
    ownerProcessId: record.ownerProcessId as string,
  });
}

// --- Section 3: MigrationDestinationIdentity --------------------------------

export type MigrationDestinationIdentity = Readonly<{
  version: 1;
  /** Exactly readPostgreSqlPortableWitness's five-field formula. Never redefined. */
  sealedWitnessSha256: string;
  /** The control-file system identifier, carried beside the sealed digest. */
  systemIdentifier: string;
}>;

export function parseMigrationDestinationIdentity(value: unknown): MigrationDestinationIdentity {
  const record = assertExactObject(
    value,
    ["sealedWitnessSha256", "systemIdentifier", "version"],
    "destination identity",
  );
  if (
    record.version !== 1
    || !isHash(record.sealedWitnessSha256)
    || !isDecimalString(record.systemIdentifier)
  ) {
    witnessError("invalid-input", "destination identity is invalid");
  }
  return deepFreeze({
    version: 1,
    sealedWitnessSha256: record.sealedWitnessSha256 as string,
    systemIdentifier: record.systemIdentifier as string,
  });
}

// --- Section 4: MigrationCanonicalDelta (the cheap class) ------------------

export type MigrationCanonicalDeltaEntry = Readonly<{
  domain: PortableDomain;
  recordCount: number;
  terminalIdentitySha256: string;
}>;

export type MigrationCanonicalDelta = Readonly<{
  version: 1;
  domains: readonly MigrationCanonicalDeltaEntry[];
}>;

function parseCanonicalDeltaEntry(value: unknown, expectedDomain: PortableDomain): MigrationCanonicalDeltaEntry {
  const record = assertExactObject(
    value,
    ["domain", "recordCount", "terminalIdentitySha256"],
    "canonical delta entry",
  );
  if (
    record.domain !== expectedDomain
    || !isSafeNonNegativeInteger(record.recordCount)
    || !isHash(record.terminalIdentitySha256)
  ) {
    witnessError("invalid-input", "canonical delta entry is invalid");
  }
  return { domain: expectedDomain, recordCount: record.recordCount as number, terminalIdentitySha256: record.terminalIdentitySha256 as string };
}

export function parseMigrationCanonicalDelta(value: unknown): MigrationCanonicalDelta {
  const record = assertExactObject(value, ["domains", "version"], "canonical delta");
  if (record.version !== 1) witnessError("invalid-input", "canonical delta is invalid");
  const domains = assertDomainVector(record.domains, "canonical delta", parseCanonicalDeltaEntry);
  return deepFreeze({ version: 1, domains });
}

/**
 * A difference is canonical evidence rows changed; equality is inconclusive
 * because an in-place UPDATE alters neither a count nor a terminal identity.
 * This predicate may only ever be used to detect change, never cleanliness.
 */
export function migrationCanonicalDeltaChanged(
  left: MigrationCanonicalDelta,
  right: MigrationCanonicalDelta,
): boolean {
  return migrationWitnessSha256(left) !== migrationWitnessSha256(right);
}

// --- Section 5: MigrationCensusVector (the only arbiter) -------------------

export type MigrationCensusVectorEntry = Readonly<{
  domain: PortableDomain;
  recordCount: number;
  prefixSha256: string;
}>;

export type MigrationCensusVector = Readonly<{
  version: 1;
  domains: readonly MigrationCensusVectorEntry[];
  contentSha256: string;
}>;

function parseCensusVectorEntry(value: unknown, expectedDomain: PortableDomain): MigrationCensusVectorEntry {
  const record = assertExactObject(value, ["domain", "prefixSha256", "recordCount"], "census vector entry");
  if (
    record.domain !== expectedDomain
    || !isSafeNonNegativeInteger(record.recordCount)
    || !isHash(record.prefixSha256)
  ) {
    witnessError("invalid-input", "census vector entry is invalid");
  }
  return { domain: expectedDomain, recordCount: record.recordCount as number, prefixSha256: record.prefixSha256 as string };
}

export function parseMigrationCensusVector(value: unknown): MigrationCensusVector {
  const record = assertExactObject(value, ["contentSha256", "domains", "version"], "census vector");
  if (record.version !== 1 || !isHash(record.contentSha256)) {
    witnessError("invalid-input", "census vector is invalid");
  }
  const domains = assertDomainVector(record.domains, "census vector", parseCensusVectorEntry);
  return deepFreeze({ version: 1, domains, contentSha256: record.contentSha256 as string });
}

/** The only witness permitted to conclude a destination is unchanged. */
export function migrationCensusVectorsEqual(
  left: MigrationCensusVector,
  right: MigrationCensusVector,
): boolean {
  return migrationWitnessSha256(left) === migrationWitnessSha256(right);
}

// --- Section 6: MigrationSchemaWitness --------------------------------------

export type MigrationSchemaWitness = Readonly<{
  version: 1;
  migrationsSha256: string;
  searchConfigurationSha256: string;
  collationSha256: string;
  sequenceStateSha256: string;
}>;

export function parseMigrationSchemaWitness(value: unknown): MigrationSchemaWitness {
  const record = assertExactObject(
    value,
    ["collationSha256", "migrationsSha256", "searchConfigurationSha256", "sequenceStateSha256", "version"],
    "schema witness",
  );
  if (
    record.version !== 1
    || !isHash(record.migrationsSha256)
    || !isHash(record.searchConfigurationSha256)
    || !isHash(record.collationSha256)
    || !isHash(record.sequenceStateSha256)
  ) {
    witnessError("invalid-input", "schema witness is invalid");
  }
  return deepFreeze({
    version: 1,
    migrationsSha256: record.migrationsSha256 as string,
    searchConfigurationSha256: record.searchConfigurationSha256 as string,
    collationSha256: record.collationSha256 as string,
    sequenceStateSha256: record.sequenceStateSha256 as string,
  });
}

// --- v3.1 section 11 supporting records: quiescence fence and intra-
//     activation watermark, as opaque-but-fully-hashed envelopes.
//
// Neither structure is fixed by the frozen schema text beyond "a record" /
// "a watermark record" carrying replayable evidence rather than a bare
// label; their live construction and field needs belong entirely to
// #625/#626. Freezing a concrete guessed shape here would recreate the
// coupling this schema exists to avoid: any later #625/#626 field need
// would force an amendment to a frozen contract with two live consumers.
// Instead #624 freezes an opaque envelope. This schema validates the
// envelope's shape, that its payload is canonical JSON, and the digest's
// self-consistency; it validates nothing about the payload's contents, so
// #625/#626 can put whatever fields their live construction needs into
// payload without amending this contract.
//
// The property that must survive opacity: every byte still participates in
// MigrationActivationAttempt.attemptId. evidenceSha256 covers the whole
// envelope (version, kind, payload) and the envelope itself is hashed in
// full by deriveMigrationActivationAttemptId, so a payload difference
// alone -- same kind, same everything else -- still changes attemptId.

export type MigrationOpaqueEvidence = Readonly<{
  version: 1;
  /** Identifier for who produced this evidence and how to interpret it; opaque to this schema. */
  kind: string;
  /** Opaque to this schema; validated only as canonical JSON. */
  payload: unknown;
  /** Canonical digest of { version, kind, payload }. */
  evidenceSha256: string;
}>;

function assertCanonicalJsonPayload(value: unknown, label: string): void {
  try {
    canonicalJson(value, new Set());
  } catch (error) {
    witnessError("invalid-input", `${label} payload is not canonical JSON`, { cause: error });
  }
}

export type CreateMigrationOpaqueEvidenceInput = Readonly<{ kind: string; payload: unknown }>;

export function createMigrationOpaqueEvidence(
  input: CreateMigrationOpaqueEvidenceInput,
  label = "opaque evidence",
): MigrationOpaqueEvidence {
  if (!isIdentifier(input.kind)) witnessError("invalid-input", `${label} kind is invalid`);
  assertCanonicalJsonPayload(input.payload, label);
  const evidenceSha256 = migrationWitnessSha256({ version: 1, kind: input.kind, payload: input.payload });
  return deepFreeze({ version: 1, kind: input.kind, payload: input.payload, evidenceSha256 });
}

export function parseMigrationOpaqueEvidence(value: unknown, label = "opaque evidence"): MigrationOpaqueEvidence {
  const record = assertExactObject(value, ["evidenceSha256", "kind", "payload", "version"], label);
  if (record.version !== 1 || !isIdentifier(record.kind) || !isHash(record.evidenceSha256)) {
    witnessError("invalid-input", `${label} is invalid`);
  }
  assertCanonicalJsonPayload(record.payload, label);
  const evidenceSha256 = migrationWitnessSha256({ version: 1, kind: record.kind, payload: record.payload });
  if (evidenceSha256 !== record.evidenceSha256) witnessError("unexpected-state", `${label} digest does not match its content`);
  return deepFreeze({ version: 1, kind: record.kind as string, payload: record.payload, evidenceSha256 });
}

export type MigrationQuiescenceFence = MigrationOpaqueEvidence;

export function createMigrationQuiescenceFence(input: CreateMigrationOpaqueEvidenceInput): MigrationQuiescenceFence {
  return createMigrationOpaqueEvidence(input, "quiescence fence");
}

export function parseMigrationQuiescenceFence(value: unknown): MigrationQuiescenceFence {
  return parseMigrationOpaqueEvidence(value, "quiescence fence");
}

export type MigrationIntraActivationWatermark = MigrationOpaqueEvidence;

export function createMigrationIntraActivationWatermark(
  input: CreateMigrationOpaqueEvidenceInput,
): MigrationIntraActivationWatermark {
  return createMigrationOpaqueEvidence(input, "intra-activation watermark");
}

export function parseMigrationIntraActivationWatermark(value: unknown): MigrationIntraActivationWatermark {
  return parseMigrationOpaqueEvidence(value, "intra-activation watermark");
}

// --- v3 section 7: MigrationActivationEpoch, deterministic only ------------

export type MigrationActivationEpoch = Readonly<{
  version: 1;
  epochId: string;
  generationId: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  verificationReportId: string;
  verificationReportSha256: string;
  projectMapWitnessSha256: string;
  queueClassificationWitnessSha256: string;
  destinationIdentity: MigrationDestinationIdentity;
  censusVector: MigrationCensusVector;
  schemaWitness: MigrationSchemaWitness;
}>;

export type CreateMigrationActivationEpochInput = Readonly<{
  generationId: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  verificationReportId: string;
  verificationReportSha256: string;
  projectMapWitnessSha256: string;
  queueClassificationWitnessSha256: string;
  destinationIdentity: MigrationDestinationIdentity;
  censusVector: MigrationCensusVector;
  schemaWitness: MigrationSchemaWitness;
}>;

/**
 * Derived from generationId, manifestChecksumSha256, verificationReportSha256,
 * projectMapWitnessSha256 and queueClassificationWitnessSha256 only. Never a
 * clock, never random, never the selection authority or any live capture, so
 * the epoch is byte-identical across every attempt, including one that took
 * the lease over.
 */
export function deriveMigrationActivationEpochId(input: Readonly<{
  generationId: string;
  manifestChecksumSha256: string;
  verificationReportSha256: string;
  projectMapWitnessSha256: string;
  queueClassificationWitnessSha256: string;
}>): string {
  return migrationWitnessSha256([
    "lcm-migration-activation-epoch-id-v1",
    input.generationId,
    input.manifestChecksumSha256,
    input.verificationReportSha256,
    input.projectMapWitnessSha256,
    input.queueClassificationWitnessSha256,
  ]);
}

function assertActivationEpochInputShape(input: CreateMigrationActivationEpochInput): void {
  if (
    !isIdentifier(input.generationId)
    || !isSafeNonNegativeInteger(input.manifestRevision)
    || !isHash(input.manifestChecksumSha256)
    || !isIdentifier(input.verificationReportId)
    || !isHash(input.verificationReportSha256)
    || !isHash(input.projectMapWitnessSha256)
    || !isHash(input.queueClassificationWitnessSha256)
  ) {
    witnessError("invalid-input", "activation epoch input is invalid");
  }
}

export function createMigrationActivationEpoch(
  input: CreateMigrationActivationEpochInput,
): MigrationActivationEpoch {
  assertActivationEpochInputShape(input);
  const destinationIdentity = parseMigrationDestinationIdentity(input.destinationIdentity);
  const censusVector = parseMigrationCensusVector(input.censusVector);
  const schemaWitness = parseMigrationSchemaWitness(input.schemaWitness);
  const epochId = deriveMigrationActivationEpochId(input);
  return deepFreeze({
    version: 1,
    epochId,
    generationId: input.generationId,
    manifestRevision: input.manifestRevision,
    manifestChecksumSha256: input.manifestChecksumSha256,
    verificationReportId: input.verificationReportId,
    verificationReportSha256: input.verificationReportSha256,
    projectMapWitnessSha256: input.projectMapWitnessSha256,
    queueClassificationWitnessSha256: input.queueClassificationWitnessSha256,
    destinationIdentity,
    censusVector,
    schemaWitness,
  });
}

export function parseMigrationActivationEpoch(value: unknown): MigrationActivationEpoch {
  const record = assertExactObject(
    value,
    [
      "censusVector", "destinationIdentity", "epochId", "generationId", "manifestChecksumSha256",
      "manifestRevision", "projectMapWitnessSha256", "queueClassificationWitnessSha256", "schemaWitness",
      "verificationReportId", "verificationReportSha256", "version",
    ],
    "activation epoch",
  );
  if (record.version !== 1 || !isHash(record.epochId)) witnessError("invalid-input", "activation epoch is invalid");
  const parsed = createMigrationActivationEpoch({
    generationId: record.generationId as string,
    manifestRevision: record.manifestRevision as number,
    manifestChecksumSha256: record.manifestChecksumSha256 as string,
    verificationReportId: record.verificationReportId as string,
    verificationReportSha256: record.verificationReportSha256 as string,
    projectMapWitnessSha256: record.projectMapWitnessSha256 as string,
    queueClassificationWitnessSha256: record.queueClassificationWitnessSha256 as string,
    destinationIdentity: record.destinationIdentity as MigrationDestinationIdentity,
    censusVector: record.censusVector as MigrationCensusVector,
    schemaWitness: record.schemaWitness as MigrationSchemaWitness,
  });
  if (parsed.epochId !== record.epochId) witnessError("unexpected-state", "activation epoch id does not match its derivation");
  return parsed;
}

// --- v3.1 section 11: MigrationActivationAttempt, corrected identity -------

export type MigrationActivationAttempt = Readonly<{
  version: 1;
  attemptId: string;
  epochId: string;
  selectionAuthority: MigrationSelectionAuthority;
  canonicalDeltaBaseline: MigrationCanonicalDelta;
  activationRecomputedCensus: MigrationCensusVector;
  intraActivationWatermark: MigrationIntraActivationWatermark | null;
  quiescenceFence: MigrationQuiescenceFence;
}>;

export type CreateMigrationActivationAttemptInput = Readonly<{
  epochId: string;
  selectionAuthority: MigrationSelectionAuthority;
  canonicalDeltaBaseline: MigrationCanonicalDelta;
  activationRecomputedCensus: MigrationCensusVector;
  intraActivationWatermark: MigrationIntraActivationWatermark | null;
  quiescenceFence: MigrationQuiescenceFence;
}>;

/**
 * Derived from epochId and every variable field of the record, with none
 * excluded: selectionAuthority, canonicalDeltaBaseline,
 * activationRecomputedCensus, intraActivationWatermark and the full
 * quiescenceFence bytes including its replay evidence. A field that is
 * recorded but not hashed is a collision; there is no third category.
 */
export function deriveMigrationActivationAttemptId(input: Readonly<{
  epochId: string;
  selectionAuthority: MigrationSelectionAuthority;
  canonicalDeltaBaseline: MigrationCanonicalDelta;
  activationRecomputedCensus: MigrationCensusVector;
  intraActivationWatermark: MigrationIntraActivationWatermark | null;
  quiescenceFence: MigrationQuiescenceFence;
}>): string {
  return migrationWitnessSha256([
    "lcm-migration-activation-attempt-id-v1",
    input.epochId,
    input.selectionAuthority,
    input.canonicalDeltaBaseline,
    input.activationRecomputedCensus,
    input.intraActivationWatermark,
    input.quiescenceFence,
  ]);
}

export function createMigrationActivationAttempt(
  input: CreateMigrationActivationAttemptInput,
): MigrationActivationAttempt {
  if (!isHash(input.epochId)) witnessError("invalid-input", "activation attempt input is invalid");
  const selectionAuthority = parseMigrationSelectionAuthority(input.selectionAuthority);
  const canonicalDeltaBaseline = parseMigrationCanonicalDelta(input.canonicalDeltaBaseline);
  const activationRecomputedCensus = parseMigrationCensusVector(input.activationRecomputedCensus);
  const intraActivationWatermark = input.intraActivationWatermark === null
    ? null
    : parseMigrationIntraActivationWatermark(input.intraActivationWatermark);
  const quiescenceFence = parseMigrationQuiescenceFence(input.quiescenceFence);
  const attemptId = deriveMigrationActivationAttemptId({
    epochId: input.epochId,
    selectionAuthority,
    canonicalDeltaBaseline,
    activationRecomputedCensus,
    intraActivationWatermark,
    quiescenceFence,
  });
  return deepFreeze({
    version: 1,
    attemptId,
    epochId: input.epochId,
    selectionAuthority,
    canonicalDeltaBaseline,
    activationRecomputedCensus,
    intraActivationWatermark,
    quiescenceFence,
  });
}

export function parseMigrationActivationAttempt(value: unknown): MigrationActivationAttempt {
  const record = assertExactObject(
    value,
    [
      "activationRecomputedCensus", "attemptId", "canonicalDeltaBaseline", "epochId",
      "intraActivationWatermark", "quiescenceFence", "selectionAuthority", "version",
    ],
    "activation attempt",
  );
  if (record.version !== 1 || !isHash(record.attemptId) || !isHash(record.epochId)) {
    witnessError("invalid-input", "activation attempt is invalid");
  }
  if (record.intraActivationWatermark !== null && !isRecord(record.intraActivationWatermark)) {
    witnessError("invalid-input", "activation attempt watermark is invalid");
  }
  const parsed = createMigrationActivationAttempt({
    epochId: record.epochId as string,
    selectionAuthority: record.selectionAuthority as MigrationSelectionAuthority,
    canonicalDeltaBaseline: record.canonicalDeltaBaseline as MigrationCanonicalDelta,
    activationRecomputedCensus: record.activationRecomputedCensus as MigrationCensusVector,
    intraActivationWatermark: record.intraActivationWatermark as MigrationIntraActivationWatermark | null,
    quiescenceFence: record.quiescenceFence as MigrationQuiescenceFence,
  });
  if (parsed.attemptId !== record.attemptId) witnessError("unexpected-state", "activation attempt id does not match its derivation");
  return parsed;
}

// --- v3 section 8: MigrationActivationWitness -------------------------------

export type MigrationActivationWitness = Readonly<{
  version: 1;
  kind: "activation" | "rollback";
  epochId: string;
  attemptId: string;
  censusMatchVerdict: boolean;
  postEpochDelta: MigrationCanonicalDelta | null;
  postEpochCensus: MigrationCensusVector | null;
  rollbackMode: "pre-write" | "post-write" | null;
  checksumSha256: string;
}>;

export type CreateMigrationActivationWitnessInput = Readonly<{
  kind: "activation" | "rollback";
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  postEpochDelta: MigrationCanonicalDelta | null;
  postEpochCensus: MigrationCensusVector | null;
  rollbackMode: "pre-write" | "post-write" | null;
}>;

/**
 * Recomputed by the validator from epoch.censusVector and the attempt's
 * activationRecomputedCensus. A carried value is never trusted and a
 * disagreeing one is a refusal.
 */
export function migrationActivationCensusMatchVerdict(
  epoch: MigrationActivationEpoch,
  attempt: MigrationActivationAttempt,
): boolean {
  if (epoch.epochId !== attempt.epochId) witnessError("unexpected-state", "activation attempt does not belong to this epoch");
  return migrationCensusVectorsEqual(epoch.censusVector, attempt.activationRecomputedCensus);
}

export function createMigrationActivationWitness(
  input: CreateMigrationActivationWitnessInput,
): MigrationActivationWitness {
  if (input.kind !== "activation" && input.kind !== "rollback") {
    witnessError("invalid-input", "activation witness kind is invalid");
  }
  if (input.epoch.epochId !== input.attempt.epochId) {
    witnessError("unexpected-state", "activation witness attempt does not match its epoch");
  }
  if (input.kind === "activation") {
    if (input.postEpochDelta !== null || input.postEpochCensus !== null || input.rollbackMode !== null) {
      witnessError("invalid-input", "activation witness carries rollback-only evidence");
    }
  } else if (
    input.postEpochDelta === null
    || (input.rollbackMode !== "pre-write" && input.rollbackMode !== "post-write")
  ) {
    witnessError("invalid-input", "rollback witness is missing required evidence");
  } else if (
    classifyMigrationRollbackMode({
      epoch: input.epoch,
      attempt: input.attempt,
      postEpochDelta: input.postEpochDelta,
      postEpochCensus: input.postEpochCensus,
    }) !== input.rollbackMode
  ) {
    witnessError("unexpected-state", "rollback mode does not match its classification");
  }
  const censusMatchVerdict = migrationActivationCensusMatchVerdict(input.epoch, input.attempt);
  const payload = {
    version: 1 as const,
    kind: input.kind,
    epochId: input.epoch.epochId,
    attemptId: input.attempt.attemptId,
    censusMatchVerdict,
    postEpochDelta: input.postEpochDelta,
    postEpochCensus: input.postEpochCensus,
    rollbackMode: input.rollbackMode,
  };
  return deepFreeze({ ...payload, checksumSha256: migrationWitnessSha256(payload) });
}

export function parseMigrationActivationWitness(value: unknown): MigrationActivationWitness {
  const record = assertExactObject(
    value,
    [
      "attemptId", "censusMatchVerdict", "checksumSha256", "epochId", "kind",
      "postEpochCensus", "postEpochDelta", "rollbackMode", "version",
    ],
    "activation witness",
  );
  if (
    record.version !== 1
    || (record.kind !== "activation" && record.kind !== "rollback")
    || !isHash(record.epochId)
    || !isHash(record.attemptId)
    || typeof record.censusMatchVerdict !== "boolean"
    || !isHash(record.checksumSha256)
    || (record.rollbackMode !== null && record.rollbackMode !== "pre-write" && record.rollbackMode !== "post-write")
  ) {
    witnessError("invalid-input", "activation witness is invalid");
  }
  const postEpochDelta = record.postEpochDelta === null ? null : parseMigrationCanonicalDelta(record.postEpochDelta);
  const postEpochCensus = record.postEpochCensus === null ? null : parseMigrationCensusVector(record.postEpochCensus);
  // Round-4 P2: mirrors createMigrationActivationWitness's own
  // discriminated-union rule, which this parser previously left
  // unenforced -- a hand-built "activation" payload carrying rollback-
  // only evidence (or a "rollback" payload missing its required
  // evidence), with a checksum recomputed to match that exact
  // combination, passed the checksum check below with no other guard
  // to catch it. classifyMigrationRollbackMode's own cross-check
  // against epoch/attempt is not repeated here, since neither is part
  // of this serialized witness to re-derive it from; this closes the
  // half of the constructor's validation that depends only on the
  // witness's own fields.
  if (record.kind === "activation") {
    if (postEpochDelta !== null || postEpochCensus !== null || record.rollbackMode !== null) {
      witnessError("invalid-input", "activation witness carries rollback-only evidence");
    }
  } else if (postEpochDelta === null || (record.rollbackMode !== "pre-write" && record.rollbackMode !== "post-write")) {
    witnessError("invalid-input", "rollback witness is missing required evidence");
  }
  const payload = {
    version: 1 as const,
    kind: record.kind as MigrationActivationWitness["kind"],
    epochId: record.epochId as string,
    attemptId: record.attemptId as string,
    censusMatchVerdict: record.censusMatchVerdict as boolean,
    postEpochDelta,
    postEpochCensus,
    rollbackMode: record.rollbackMode as MigrationActivationWitness["rollbackMode"],
  };
  const checksumSha256 = migrationWitnessSha256(payload);
  if (checksumSha256 !== record.checksumSha256) {
    witnessError("unexpected-state", "activation witness checksum does not match its content");
  }
  return deepFreeze({ ...payload, checksumSha256 });
}

// --- v2 section 9 (in force, corrected field path per v3.1) ----------------

export type ClassifyMigrationRollbackModeInput = Readonly<{
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  postEpochDelta: MigrationCanonicalDelta;
  postEpochCensus: MigrationCensusVector | null;
}>;

/**
 * 1. A changed canonical delta against the attempt's baseline is sound,
 *    cheap evidence of a write: returns "post-write".
 * 2. Equality is inconclusive; the only legal successor is the census.
 * 3. With a supplied census: equality with the epoch's own frozen
 *    `censusVector` -- never the attempt's `activationRecomputedCensus`,
 *    which measures agreement with what this same attempt just observed,
 *    not drift since the epoch -- returns "pre-write"; inequality returns
 *    "post-write". Comparing against the attempt's own recomputed census
 *    instead of the epoch's was a real defect (round-1 P0): epoch C0,
 *    attempt C1, post-epoch C1 minted a valid-checksum "pre-write" even
 *    though `censusMatchVerdict` (epoch C0 vs attempt C1) was false,
 *    which would let a destructive rollback discard a destination the
 *    epoch itself never actually matched.
 * 4. No difference and no census: refuse. Never default.
 *
 * The permission-granting answer always costs a census: "pre-write"
 * authorises discarding the destination and is unreachable without one.
 */
export function classifyMigrationRollbackMode(
  input: ClassifyMigrationRollbackModeInput,
): "pre-write" | "post-write" {
  // Round-2 P3: createMigrationActivationWitness already refuses an
  // epoch/attempt mismatch before ever calling this function, but this
  // function is itself exported and callable standalone (#626 and any
  // other future consumer may call it directly without going through
  // witness construction). Without its own guard, a mismatched pair
  // would silently classify against the wrong epoch's census/delta
  // rather than refusing -- the same class of defect as the round-1 P0
  // this module already fixed once, just reachable through a different
  // door.
  if (input.epoch.epochId !== input.attempt.epochId) {
    witnessError("unexpected-state", "rollback classification attempt does not belong to this epoch");
  }
  if (migrationCanonicalDeltaChanged(input.postEpochDelta, input.attempt.canonicalDeltaBaseline)) {
    return "post-write";
  }
  if (input.postEpochCensus === null) {
    witnessError("unexpected-state", "rollback classification requires a census once the delta is inconclusive");
  }
  return migrationCensusVectorsEqual(input.postEpochCensus, input.epoch.censusVector)
    ? "pre-write"
    : "post-write";
}
