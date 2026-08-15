import {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PORTABLE_RECORD_SCHEMA_DESCRIPTOR,
  PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError,
  canonicalJson,
  comparePortableOrder,
  parsePortableRecord,
  serializePortableRecord,
  sha256,
} from "./portable-record.js";
import type {
  PortableDomain,
  PortableRecord,
  PortableStreamErrorCode,
  PortableStreamErrorOptions,
} from "./portable-record.js";

export * from "./portable-record.js";

export type PortableCoverageEvidence =
  | Readonly<{ state: "available"; evidenceSha256: string }>
  | Readonly<{
      state: "authoritative-empty";
      reason: "not-in-source-generation";
      evidenceSha256: string;
    }>;

export interface PortableSourceDescription {
  readonly capturedAt: string;
  readonly sourceIdentitySha256: string;
  readonly sourceWitnessSha256: string;
  readonly coverage: Readonly<Record<PortableDomain, PortableCoverageEvidence>>;
}

export interface PortableSourcePageInput {
  readonly domain: PortableDomain;
  readonly afterOrdinal: number;
  readonly includePredecessor: boolean;
  readonly maxRecords: 500;
  readonly maxBytes: 150994944;
  readonly signal?: AbortSignal;
}

export interface PortableSourcePage {
  readonly predecessor: PortableRecord | null;
  readonly records: readonly PortableRecord[];
  readonly complete: boolean;
}

export interface PortableSourceVerificationInput {
  readonly sourceIdentitySha256: string;
  readonly sourceWitnessSha256: string;
  readonly contentSha256?: string;
  readonly manifestSha256?: string;
  readonly boundary?: Readonly<{
    readonly domain: PortableDomain;
    readonly nextOrdinal: number;
    readonly recordCount: number;
    readonly prefixSha256: string;
    readonly lastRecordIdentitySha256: string | null;
    readonly lastRecordSha256: string | null;
  }>;
  readonly signal?: AbortSignal;
}

export interface PortableRecordSource {
  describeSource(): PortableSourceDescription;
  readDomainPage(input: PortableSourcePageInput): Promise<PortableSourcePage>;
  verifySource(
    input: PortableSourceVerificationInput,
  ): Promise<"unchanged" | "changed" | "invalid" | "unavailable">;
  close(): Promise<void>;
}

export interface PortableReadBatchInput {
  readonly domain: PortableDomain;
  readonly after?: PortableCheckpoint;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface PortableLimits {
  readonly maxJsonDepth: 100;
  readonly maxRecordBytes: 134217728;
  readonly maxBatchRecords: 500;
  readonly maxBatchBytes: 150994944;
  readonly maxControlBytes: 1048576;
}

export interface PortableDomainManifest {
  readonly domain: PortableDomain;
  readonly domainVersion: 1;
  readonly coverage: PortableCoverageEvidence;
  readonly recordCount: number;
  readonly prefixSha256: string;
}

export interface PortableManifest {
  readonly version: 1;
  readonly schemaSha256: string;
  readonly source: PortableSourceDescription;
  readonly domains: readonly PortableDomainManifest[];
  readonly contentSha256: string;
  readonly limits: PortableLimits;
  readonly manifestSha256: string;
}

export interface PortableCheckpoint {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  readonly nextOrdinal: number;
  readonly recordCount: number;
  readonly prefixSha256: string;
  readonly lastRecordIdentitySha256: string | null;
  readonly lastRecordSha256: string | null;
  readonly previousCheckpointSha256: string | null;
  readonly complete: boolean;
  readonly checkpointSha256: string;
}

export interface PortableBatch {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  readonly records: readonly PortableRecord[];
  readonly framedBytes: number;
  readonly complete: boolean;
  readonly priorCheckpointSha256: string | null;
  readonly checkpoint: PortableCheckpoint;
}

export interface PortableVerification {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly domain: PortableDomain;
  readonly checkpointSha256: string;
  readonly nextOrdinal: number;
  readonly recordCount: number;
  readonly prefixSha256: string;
  readonly complete: boolean;
  readonly matchesManifestBoundary: boolean;
  readonly authoritative: true;
}

export interface PortableRecordStream {
  describe(): PortableManifest;
  readBatch(input: PortableReadBatchInput): Promise<PortableBatch>;
  verify(checkpoint: PortableCheckpoint): Promise<PortableVerification>;
  close(): Promise<void>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPTURED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const MANIFEST_KEYS = [
  "version",
  "schemaSha256",
  "source",
  "domains",
  "contentSha256",
  "limits",
  "manifestSha256",
] as const;
const CHECKPOINT_KEYS = [
  "version",
  "manifestSha256",
  "domain",
  "nextOrdinal",
  "recordCount",
  "prefixSha256",
  "lastRecordIdentitySha256",
  "lastRecordSha256",
  "previousCheckpointSha256",
  "complete",
  "checkpointSha256",
] as const;

function fail(code: PortableStreamErrorCode, options: PortableStreamErrorOptions = {}): never {
  throw new PortableStreamError(code, options);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isCanonicalCapturedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(CAPTURED_AT_PATTERN);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function ownKeys(value: object, code: PortableStreamErrorCode): (string | symbol)[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
}

function prototypeOf(value: object, code: PortableStreamErrorCode): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    fail(code);
  }
}

function ownValue(value: object, key: string, code: PortableStreamErrorCode): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) fail(code);
    return descriptor.value;
  } catch (error) {
    if (error instanceof PortableStreamError) throw error;
    fail(code);
  }
}

function snapshot(
  value: unknown,
  keys: readonly string[],
  code: PortableStreamErrorCode,
): Record<string, unknown> {
  if (!isObject(value)) fail(code);
  const prototype = prototypeOf(value, code);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const actual = ownKeys(value, code);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail(code);
  }
  return Object.fromEntries(keys.map((key) => [key, ownValue(value, key, code)]));
}

function arrayValues(value: unknown, code: PortableStreamErrorCode): unknown[] {
  if (!Array.isArray(value) || prototypeOf(value, code) !== Array.prototype) fail(code);
  const keys = ownKeys(value, code);
  if (
    keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))
    || keys.length !== value.length + 1
  ) fail(code);
  const result = new Array<unknown>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = ownValue(value, String(index), code);
  }
  return result;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of ownKeys(value, "malformed-manifest")) {
    deepFreeze(ownValue(value, key as string, "malformed-manifest"), seen);
  }
  return Object.freeze(value);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uint64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function appendLengthPrefixed(previousSha256: string, bytes: Uint8Array): string {
  return sha256(Buffer.concat([
    Buffer.from(previousSha256, "hex"),
    Buffer.from(uint64be(bytes.byteLength)),
    Buffer.from(bytes),
  ]));
}

function initialDomainPrefix(schemaSha256: string, domain: PortableDomain): string {
  return sha256(canonicalJson(["lcm-portable-domain-v1", schemaSha256, domain, 1]));
}

function aggregateContentSha256(schemaSha256: string, prefixes: readonly string[]): string {
  let digest = sha256(canonicalJson(["lcm-portable-content-v1", schemaSha256]));
  for (const prefix of prefixes) digest = appendLengthPrefixed(digest, Buffer.from(prefix, "hex"));
  return digest;
}

function compareBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function parseControl(
  bytes: Uint8Array,
  code: PortableStreamErrorCode,
): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PORTABLE_LIMITS.maxControlBytes) {
    fail(code);
  }
  if (bytes[bytes.byteLength - 1] !== 0x0a || (bytes.byteLength > 1 && bytes[bytes.byteLength - 2] === 0x0a)) {
    fail(code);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1));
  } catch {
    fail(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(code);
  }
  let canonical: Uint8Array;
  try {
    canonical = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
  } catch {
    fail(code);
  }
  if (!compareBytes(bytes, canonical)) fail(code);
  return parsed;
}

function serializeControl(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function validateCoverage(value: unknown): PortableCoverageEvidence {
  if (!isObject(value)) fail("malformed-manifest");
  const state = ownValue(value, "state", "malformed-manifest");
  if (state === "available") {
    const object = snapshot(value, ["state", "evidenceSha256"], "malformed-manifest");
    if (!isSha256(object.evidenceSha256)) fail("malformed-manifest");
    return deepFreeze({ state, evidenceSha256: object.evidenceSha256 });
  }
  if (state === "authoritative-empty") {
    const object = snapshot(value, ["state", "reason", "evidenceSha256"], "malformed-manifest");
    if (object.reason !== "not-in-source-generation" || !isSha256(object.evidenceSha256)) {
      fail("malformed-manifest");
    }
    return deepFreeze({ state, reason: object.reason, evidenceSha256: object.evidenceSha256 });
  }
  fail("malformed-manifest");
}

function validateSourceDescription(value: unknown): PortableSourceDescription {
  const object = snapshot(
    value,
    ["capturedAt", "sourceIdentitySha256", "sourceWitnessSha256", "coverage"],
    "malformed-manifest",
  );
  if (
    !isCanonicalCapturedAt(object.capturedAt)
    || !isSha256(object.sourceIdentitySha256)
    || !isSha256(object.sourceWitnessSha256)
  ) fail("malformed-manifest");
  const coverageObject = snapshot(
    object.coverage,
    PORTABLE_RECORD_DOMAIN_ORDER,
    "malformed-manifest",
  );
  const coverage = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [
    domain,
    validateCoverage(coverageObject[domain]),
  ])) as Record<PortableDomain, PortableCoverageEvidence>;
  return deepFreeze({
    capturedAt: object.capturedAt,
    sourceIdentitySha256: object.sourceIdentitySha256,
    sourceWitnessSha256: object.sourceWitnessSha256,
    coverage: deepFreeze(coverage),
  });
}

function validateLimits(value: unknown): PortableLimits {
  const object = snapshot(value, Object.keys(PORTABLE_LIMITS), "invalid-limit");
  if (!sameCanonical(object, PORTABLE_LIMITS)) fail("invalid-limit");
  return PORTABLE_LIMITS as PortableLimits;
}

function validateManifest(value: unknown, requireChecksum = true): PortableManifest {
  const object = snapshot(value, MANIFEST_KEYS, "malformed-manifest");
  if (object.version !== 1) fail("unsupported-version");
  if (object.schemaSha256 !== PORTABLE_RECORD_SCHEMA_SHA256) fail("incompatible-schema");
  const source = validateSourceDescription(object.source);
  const domains = arrayValues(object.domains, "malformed-manifest");
  if (domains.length !== PORTABLE_RECORD_DOMAIN_ORDER.length) fail("malformed-manifest");
  const normalizedDomains = domains.map((entry, index): PortableDomainManifest => {
    const domain = PORTABLE_RECORD_DOMAIN_ORDER[index];
    const item = snapshot(
      entry,
      ["domain", "domainVersion", "coverage", "recordCount", "prefixSha256"],
      "malformed-manifest",
    );
    if (
      item.domain !== domain
      || item.domainVersion !== 1
      || !isSafeCount(item.recordCount)
      || !isSha256(item.prefixSha256)
    ) fail("malformed-manifest");
    const coverage = validateCoverage(item.coverage);
    if (!sameCanonical(coverage, source.coverage[domain])) fail("malformed-manifest");
    return deepFreeze({
      domain,
      domainVersion: 1,
      coverage,
      recordCount: item.recordCount,
      prefixSha256: item.prefixSha256,
    });
  });
  if (!isSha256(object.contentSha256) || !isSha256(object.manifestSha256)) fail("malformed-manifest");
  const expectedContent = aggregateContentSha256(
    PORTABLE_RECORD_SCHEMA_SHA256,
    normalizedDomains.map((entry) => entry.prefixSha256),
  );
  if (object.contentSha256 !== expectedContent) fail("malformed-manifest");
  const limits = validateLimits(object.limits);
  const normalizedBody: Record<string, unknown> = {
    version: 1,
    schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
    source,
    domains: normalizedDomains,
    contentSha256: object.contentSha256,
    limits,
  };
  const expectedChecksum = sha256(canonicalJson(normalizedBody));
  if (requireChecksum && object.manifestSha256 !== expectedChecksum) fail("malformed-manifest");
  return deepFreeze({
    ...normalizedBody,
    manifestSha256: expectedChecksum,
  } as unknown as PortableManifest);
}

export function createPortableManifest(input: Omit<PortableManifest, "manifestSha256">): PortableManifest {
  const object = snapshot(input, MANIFEST_KEYS.slice(0, -1), "malformed-manifest");
  return validateManifest({ ...object, manifestSha256: "0".repeat(64) }, false);
}

export function serializePortableManifest(manifest: PortableManifest): Uint8Array {
  return serializeControl(validateManifest(manifest));
}

export function parsePortableManifest(bytes: Uint8Array): PortableManifest {
  return validateManifest(parseControl(bytes, "malformed-manifest"));
}

export function negotiatePortableManifest(
  manifest: PortableManifest,
  capabilities?: Readonly<{ version: 1; schemaSha256: string; limits: PortableLimits }>,
): PortableManifest {
  const validated = validateManifest(manifest);
  if (capabilities !== undefined) {
    const object = snapshot(capabilities, ["version", "schemaSha256", "limits"], "malformed-manifest");
    if (object.version !== 1) fail("unsupported-version");
    if (object.schemaSha256 !== PORTABLE_RECORD_SCHEMA_SHA256) fail("incompatible-schema");
    validateLimits(object.limits);
  }
  return validated;
}

function manifestDomain(manifest: PortableManifest, domain: PortableDomain): PortableDomainManifest {
  return manifest.domains[PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)] as PortableDomainManifest;
}

function validateCheckpoint(value: unknown): PortableCheckpoint {
  const object = snapshot(value, CHECKPOINT_KEYS, "checkpoint-mismatch");
  if (object.version !== 1) fail("checkpoint-mismatch");
  if (
    !isSha256(object.manifestSha256)
    || typeof object.domain !== "string"
    || !PORTABLE_RECORD_DOMAIN_ORDER.includes(object.domain as PortableDomain)
    || !isSafeCount(object.nextOrdinal)
    || object.recordCount !== object.nextOrdinal
    || !isSha256(object.prefixSha256)
    || (object.lastRecordIdentitySha256 !== null && !isSha256(object.lastRecordIdentitySha256))
    || (object.lastRecordSha256 !== null && !isSha256(object.lastRecordSha256))
    || (object.previousCheckpointSha256 !== null && !isSha256(object.previousCheckpointSha256))
    || typeof object.complete !== "boolean"
    || !isSha256(object.checkpointSha256)
  ) fail("checkpoint-mismatch");
  if (
    (object.nextOrdinal === 0 && (
      object.lastRecordIdentitySha256 !== null
      || object.lastRecordSha256 !== null
      || object.previousCheckpointSha256 !== null
    ))
    || (object.nextOrdinal > 0 && (
      object.lastRecordIdentitySha256 === null
      || object.lastRecordSha256 === null
    ))
  ) fail("checkpoint-mismatch");
  const normalizedBody: Record<string, unknown> = {
    version: 1,
    manifestSha256: object.manifestSha256,
    domain: object.domain,
    nextOrdinal: object.nextOrdinal,
    recordCount: object.recordCount,
    prefixSha256: object.prefixSha256,
    lastRecordIdentitySha256: object.lastRecordIdentitySha256,
    lastRecordSha256: object.lastRecordSha256,
    previousCheckpointSha256: object.previousCheckpointSha256,
    complete: object.complete,
  };
  if (object.checkpointSha256 !== sha256(canonicalJson(normalizedBody))) fail("checkpoint-mismatch");
  return deepFreeze({
    ...normalizedBody,
    checkpointSha256: object.checkpointSha256,
  } as unknown as PortableCheckpoint);
}

function validateCheckpointManifest(value: unknown): PortableManifest {
  try {
    return validateManifest(value);
  } catch {
    fail("checkpoint-mismatch");
  }
}

export function serializePortableCheckpoint(checkpoint: PortableCheckpoint): Uint8Array {
  return serializeControl(validateCheckpoint(checkpoint));
}

export function parsePortableCheckpoint(bytes: Uint8Array): PortableCheckpoint {
  return validateCheckpoint(parseControl(bytes, "checkpoint-mismatch"));
}

export function verifyPortableCheckpoint(
  checkpoint: PortableCheckpoint,
  manifest: PortableManifest,
): PortableCheckpoint {
  const normalizedManifest = validateCheckpointManifest(manifest);
  const normalized = validateCheckpoint(checkpoint);
  if (normalized.manifestSha256 !== normalizedManifest.manifestSha256) fail("checkpoint-mismatch");
  const terminal = manifestDomain(normalizedManifest, normalized.domain);
  if (
    normalized.nextOrdinal > terminal.recordCount
    || (normalized.complete && (
      normalized.nextOrdinal !== terminal.recordCount
      || normalized.prefixSha256 !== terminal.prefixSha256
    ))
    || (!normalized.complete && normalized.nextOrdinal >= terminal.recordCount)
  ) fail("checkpoint-mismatch");
  if (
    normalized.nextOrdinal === 0
    && normalized.prefixSha256 !== initialDomainPrefix(normalizedManifest.schemaSha256, normalized.domain)
  ) fail("checkpoint-mismatch");
  return normalized;
}

function makeCheckpoint(body: Omit<PortableCheckpoint, "checkpointSha256">): PortableCheckpoint {
  return deepFreeze({
    ...body,
    checkpointSha256: sha256(canonicalJson(body)),
  });
}

function recordBytes(record: PortableRecord): Uint8Array {
  return serializePortableRecord(record);
}

function validateRecordForBatch(record: PortableRecord): {
  readonly record: PortableRecord;
  readonly bytes: Uint8Array;
} {
  const bytes = recordBytes(record);
  const parsed = parsePortableRecord(bytes);
  return { record: parsed, bytes };
}

const DOMAIN_DEPENDENCIES = PORTABLE_RECORD_SCHEMA_DESCRIPTOR.domainsByOrder as unknown as Readonly<
  Record<PortableDomain, Readonly<{ dependencies: readonly string[] }>>
>;

function validateDependencyContract(record: PortableRecord, domain: PortableDomain): void {
  if (!isObject(record)) fail("malformed-record", { domain });
  try {
    const dependencies = arrayValues(record.dependencies, "dependency-order");
    const expected = DOMAIN_DEPENDENCIES[domain].dependencies;
    if ((dependencies.length === 0) !== (expected.length === 0)) {
      fail("dependency-order", { domain, ordinal: record.ordinal });
    }
    const seenDomains = new Set<string>();
    for (const dependency of dependencies) {
      const item = snapshot(dependency, ["domain", "identitySha256"], "dependency-order");
      if (
        typeof item.domain !== "string"
        || !expected.some((candidate) => candidate.split("|").includes(item.domain as string))
        || !isSha256(item.identitySha256)
      ) fail("dependency-order", { domain, ordinal: record.ordinal });
      seenDomains.add(item.domain);
    }
    if (expected.some((candidate) => !candidate.split("|").some((domainName) => seenDomains.has(domainName)))) {
      fail("dependency-order", { domain, ordinal: record.ordinal });
    }
  } catch (error) {
    if (error instanceof PortableStreamError) throw error;
    fail("malformed-record", { domain });
  }
}

export interface CreatePortableBatchInput {
  readonly manifest: PortableManifest;
  readonly domain: PortableDomain;
  readonly page: PortableSourcePage;
  readonly priorCheckpoint?: PortableCheckpoint;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("aborted", { retryable: true });
}

export function createPortableBatch(input: CreatePortableBatchInput): PortableBatch {
  checkAbort(input.signal);
  const manifest = validateManifest(input.manifest);
  if (!PORTABLE_RECORD_DOMAIN_ORDER.includes(input.domain)) fail("unknown-domain");
  if (
    !Number.isSafeInteger(input.maxRecords)
    || input.maxRecords <= 0
    || input.maxRecords > PORTABLE_LIMITS.maxBatchRecords
    || !Number.isSafeInteger(input.maxBytes)
    || input.maxBytes <= 0
    || input.maxBytes > PORTABLE_LIMITS.maxBatchBytes
  ) fail("invalid-limit", { domain: input.domain });
  const terminal = manifestDomain(manifest, input.domain);
  const prior = input.priorCheckpoint === undefined
    ? undefined
    : verifyPortableCheckpoint(input.priorCheckpoint, manifest);
  if (prior !== undefined && prior.domain !== input.domain) fail("checkpoint-mismatch");
  const page = snapshot(input.page, ["predecessor", "records", "complete"], "partial-batch");
  if (typeof page.complete !== "boolean") fail("partial-batch", { domain: input.domain });
  const records = arrayValues(page.records, "partial-batch");
  if (records.length > PORTABLE_LIMITS.maxBatchRecords) {
    fail("batch-limit-exceeded", { domain: input.domain, retryable: true });
  }
  const startOrdinal = prior?.nextOrdinal ?? 0;
  let predecessor: PortableRecord | null = null;
  if (page.predecessor !== null) {
    predecessor = parsePortableRecord(recordBytes(page.predecessor as PortableRecord));
  }
  if (prior === undefined) {
    if (predecessor !== null) fail("checkpoint-mismatch", { domain: input.domain });
  } else {
    if (
      predecessor === null
      || predecessor.domain !== input.domain
      || predecessor.ordinal !== prior.nextOrdinal - 1
      || predecessor.identitySha256 !== prior.lastRecordIdentitySha256
      || predecessor.recordSha256 !== prior.lastRecordSha256
    ) fail("checkpoint-mismatch", { domain: input.domain });
  }
  if (records.length === 0 && page.complete === false) fail("partial-batch", { domain: input.domain });
  const normalized: PortableRecord[] = [];
  let framedBytes = 0;
  let previous = predecessor;
  let previousIsPredecessor = predecessor !== null;
  const identities = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const rawRecord = records[index] as PortableRecord;
    validateDependencyContract(rawRecord, input.domain);
    const candidate = validateRecordForBatch(rawRecord);
    if (candidate.record.domain !== input.domain || candidate.record.domainVersion !== 1) {
      fail("checkpoint-mismatch", { domain: input.domain, ordinal: candidate.record.ordinal });
    }
    framedBytes += candidate.bytes.byteLength;
    if (framedBytes > PORTABLE_LIMITS.maxBatchBytes) {
      fail("batch-limit-exceeded", { domain: input.domain, ordinal: candidate.record.ordinal, retryable: true });
    }
    if (identities.has(candidate.record.identitySha256)) {
      fail("duplicate-identity", { domain: input.domain, ordinal: candidate.record.ordinal });
    }
    identities.add(candidate.record.identitySha256);
    if (previous !== null) {
      const comparison = comparePortableOrder(previous.order, candidate.record.order);
      if (comparison > 0 || (comparison === 0 && previousIsPredecessor)) {
        fail("order-regression", { domain: input.domain, ordinal: candidate.record.ordinal });
      }
    }
    previous = candidate.record;
    previousIsPredecessor = false;
    normalized.push(candidate.record);
  }
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].ordinal !== startOrdinal + index) {
      fail("checkpoint-mismatch", { domain: input.domain, ordinal: normalized[index].ordinal });
    }
  }
  const pageNextOrdinal = startOrdinal + normalized.length;
  if (pageNextOrdinal > terminal.recordCount) {
    fail("partial-batch", { domain: input.domain, ordinal: pageNextOrdinal });
  }
  let selectedBytes = 0;
  let selectedCount = 0;
  for (const record of normalized) {
    const bytes = recordBytes(record).byteLength;
    if (selectedCount === 0 && bytes > input.maxBytes) {
      fail("batch-limit-exceeded", { domain: input.domain, ordinal: record.ordinal, retryable: true });
    }
    if (selectedCount >= input.maxRecords || selectedBytes + bytes > input.maxBytes) break;
    selectedBytes += bytes;
    selectedCount += 1;
  }
  const selected = normalized.slice(0, selectedCount);
  let prefix = prior?.prefixSha256 ?? initialDomainPrefix(manifest.schemaSha256, input.domain);
  for (const record of selected) prefix = appendLengthPrefixed(prefix, recordBytes(record));
  const nextOrdinal = startOrdinal + selected.length;
  const complete = page.complete === true && selected.length === normalized.length;
  if (!page.complete && nextOrdinal >= terminal.recordCount) {
    fail("partial-batch", { domain: input.domain, ordinal: nextOrdinal });
  }
  if (complete && (nextOrdinal !== terminal.recordCount || prefix !== terminal.prefixSha256)) {
    fail("partial-batch", { domain: input.domain, ordinal: nextOrdinal });
  }
  checkAbort(input.signal);
  const last = selected.at(-1) ?? predecessor;
  const checkpoint = makeCheckpoint({
    version: 1,
    manifestSha256: manifest.manifestSha256,
    domain: input.domain,
    nextOrdinal,
    recordCount: nextOrdinal,
    prefixSha256: prefix,
    lastRecordIdentitySha256: last?.identitySha256 ?? null,
    lastRecordSha256: last?.recordSha256 ?? null,
    previousCheckpointSha256: prior?.checkpointSha256 ?? null,
    complete,
  });
  return deepFreeze({
    version: 1,
    manifestSha256: manifest.manifestSha256,
    domain: input.domain,
    records: deepFreeze(selected),
    framedBytes: selectedBytes,
    complete,
    priorCheckpointSha256: prior?.checkpointSha256 ?? null,
    checkpoint,
  });
}

function sourceFailure(code: "source-changed" | "source-invalid" | "source-unavailable"): never {
  fail(code, { retryable: code === "source-unavailable" });
}

function sourceDescription(source: PortableRecordSource): PortableSourceDescription {
  let description: PortableSourceDescription;
  try {
    description = source.describeSource();
  } catch {
    sourceFailure("source-unavailable");
  }
  try {
    return validateSourceDescription(description);
  } catch {
    sourceFailure("source-invalid");
  }
}

async function readSourcePage(
  source: PortableRecordSource,
  input: PortableSourcePageInput,
): Promise<PortableSourcePage> {
  try {
    return await source.readDomainPage(input);
  } catch (error) {
    if (error instanceof PortableStreamError) sourceFailure("source-invalid");
    sourceFailure("source-unavailable");
  }
}

async function authenticateSource(
  source: PortableRecordSource,
  input: PortableSourceVerificationInput,
): Promise<void> {
  let result: "unchanged" | "changed" | "invalid" | "unavailable";
  try {
    result = await source.verifySource(input);
  } catch {
    sourceFailure("source-unavailable");
  }
  if (result === "changed") sourceFailure("source-changed");
  if (result === "invalid") sourceFailure("source-invalid");
  if (result === "unavailable") sourceFailure("source-unavailable");
  if (result !== "unchanged") sourceFailure("source-invalid");
}

function sourceVerificationInput(
  manifest: PortableManifest,
  signal?: AbortSignal,
  boundary?: PortableSourceVerificationInput["boundary"],
): PortableSourceVerificationInput {
  return {
    sourceIdentitySha256: manifest.source.sourceIdentitySha256,
    sourceWitnessSha256: manifest.source.sourceWitnessSha256,
    contentSha256: manifest.contentSha256,
    manifestSha256: manifest.manifestSha256,
    ...(boundary === undefined ? {} : { boundary }),
    ...(signal === undefined ? {} : { signal }),
  };
}

interface ScannedDomain {
  readonly manifest: PortableDomainManifest;
  readonly projectIdentitySha256: string | null;
}

function invalidSource(): never {
  sourceFailure("source-invalid");
}

function scanSourcePage(
  domain: PortableDomain,
  rawPage: PortableSourcePage,
  nextOrdinal: number,
  prefixSha256: string,
  previous: PortableRecord | null,
  expectedProjectIdentitySha256: string | null,
): Readonly<{
  nextOrdinal: number;
  prefixSha256: string;
  previous: PortableRecord | null;
  complete: boolean;
  projectIdentitySha256: string | null;
}> {
  let page: Record<string, unknown>;
  let records: unknown[];
  try {
    page = snapshot(rawPage, ["predecessor", "records", "complete"], "source-invalid");
    records = arrayValues(page.records, "source-invalid");
  } catch {
    invalidSource();
  }
  if (typeof page.complete !== "boolean" || records.length > PORTABLE_LIMITS.maxBatchRecords) {
    invalidSource();
  }
  if (records.length === 0 && page.complete === false) invalidSource();

  let predecessor: PortableRecord | null = null;
  try {
    predecessor = page.predecessor === null
      ? null
      : parsePortableRecord(recordBytes(page.predecessor as PortableRecord));
  } catch {
    invalidSource();
  }
  if (nextOrdinal === 0) {
    if (predecessor !== null) invalidSource();
  } else if (
    predecessor === null
    || predecessor.domain !== domain
    || predecessor.ordinal !== nextOrdinal - 1
    || predecessor.identitySha256 !== previous!.identitySha256
    || predecessor.recordSha256 !== previous!.recordSha256
  ) {
    invalidSource();
  }
  let framedBytes = 0;
  let prior = predecessor;
  let projectIdentitySha256: string | null = null;
  for (const rawRecord of records) {
    let record: PortableRecord;
    let bytes: Uint8Array;
    try {
      ({ record, bytes } = validateRecordForBatch(rawRecord as PortableRecord));
      validateDependencyContract(record, domain);
    } catch {
      invalidSource();
    }
    framedBytes += bytes.byteLength;
    if (
      framedBytes > PORTABLE_LIMITS.maxBatchBytes
      || record.domain !== domain
      || record.domainVersion !== 1
      || record.ordinal !== nextOrdinal
      || (prior !== null && (
        prior.identitySha256 === record.identitySha256
        || comparePortableOrder(prior.order, record.order) >= 0
      ))
    ) invalidSource();
    if (domain === "project") {
      if (projectIdentitySha256 !== null) invalidSource();
      projectIdentitySha256 = record.identitySha256;
    }
    for (const dependency of record.dependencies) {
      if (
        dependency.domain === "project"
        && (
          expectedProjectIdentitySha256 === null
          || dependency.identitySha256 !== expectedProjectIdentitySha256
        )
      ) invalidSource();
    }
    prefixSha256 = appendLengthPrefixed(prefixSha256, bytes);
    nextOrdinal += 1;
    prior = record;
  }

  return {
    nextOrdinal,
    prefixSha256,
    previous: prior,
    complete: page.complete,
    projectIdentitySha256,
  };
}

async function scanDomain(
  source: PortableRecordSource,
  description: PortableSourceDescription,
  domain: PortableDomain,
  expectedProjectIdentitySha256: string | null,
): Promise<ScannedDomain> {
  const coverage = description.coverage[domain];
  let prefixSha256 = initialDomainPrefix(PORTABLE_RECORD_SCHEMA_SHA256, domain);
  if (coverage.state === "authoritative-empty") {
    return {
      manifest: deepFreeze({ domain, domainVersion: 1, coverage, recordCount: 0, prefixSha256 }),
      projectIdentitySha256: null,
    };
  }

  let nextOrdinal = 0;
  let previous: PortableRecord | null = null;
  let projectIdentitySha256: string | null = null;
  while (true) {
    const page = await readSourcePage(source, {
      domain,
      afterOrdinal: nextOrdinal,
      includePredecessor: nextOrdinal > 0,
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes as 150994944,
    });
    const scanned = scanSourcePage(
      domain,
      page,
      nextOrdinal,
      prefixSha256,
      previous,
      expectedProjectIdentitySha256,
    );
    nextOrdinal = scanned.nextOrdinal;
    prefixSha256 = scanned.prefixSha256;
    previous = scanned.previous;
    if (scanned.projectIdentitySha256 !== null) {
      if (projectIdentitySha256 !== null) invalidSource();
      projectIdentitySha256 = scanned.projectIdentitySha256;
    }
    if (scanned.complete) break;
  }
  return {
    manifest: deepFreeze({
      domain,
      domainVersion: 1,
      coverage,
      recordCount: nextOrdinal,
      prefixSha256,
    }),
    projectIdentitySha256,
  };
}

async function buildManifest(
  source: PortableRecordSource,
  description: PortableSourceDescription,
): Promise<PortableManifest> {
  const scanned: ScannedDomain[] = [];
  let projectIdentitySha256: string | null = null;
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const entry = await scanDomain(source, description, domain, projectIdentitySha256);
    scanned.push(entry);
    if (domain === "project") {
      if (entry.manifest.recordCount !== 1 || entry.projectIdentitySha256 === null) invalidSource();
      projectIdentitySha256 = entry.projectIdentitySha256;
    }
  }
  const domains = deepFreeze(scanned.map((entry) => entry.manifest));
  return createPortableManifest({
    version: 1,
    schemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
    source: description,
    domains,
    contentSha256: aggregateContentSha256(
      PORTABLE_RECORD_SCHEMA_SHA256,
      domains.map((entry) => entry.prefixSha256),
    ),
    limits: PORTABLE_LIMITS as PortableLimits,
  });
}

export async function createPortableRecordStream(
  source: PortableRecordSource,
): Promise<PortableRecordStream> {
  let manifest: PortableManifest;
  try {
    const description = sourceDescription(source);
    manifest = await buildManifest(source, description);
    const currentDescription = sourceDescription(source);
    if (!sameCanonical(description, currentDescription)) sourceFailure("source-changed");
    await authenticateSource(source, sourceVerificationInput(manifest));
  } catch (error) {
    try {
      await source.close();
    } catch {
      // Preserve the primary, sanitized creation failure.
    }
    throw error;
  }

  let closed = false;
  let operationTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new PortableStreamError("closed"));
    const result = operationTail.then(work);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const stream: PortableRecordStream = {
    describe(): PortableManifest {
      return manifest;
    },

    readBatch(input: PortableReadBatchInput): Promise<PortableBatch> {
      return enqueue(async () => {
        checkAbort(input.signal);
        const prior = input.after === undefined
          ? undefined
          : verifyPortableCheckpoint(input.after, manifest);
        if (prior !== undefined && prior.domain !== input.domain) fail("checkpoint-mismatch");
        await authenticateSource(source, sourceVerificationInput(manifest, input.signal));
        checkAbort(input.signal);
        const page = await readSourcePage(source, {
          domain: input.domain,
          afterOrdinal: prior?.nextOrdinal ?? 0,
          includePredecessor: prior !== undefined,
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes as 150994944,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        checkAbort(input.signal);
        await authenticateSource(source, sourceVerificationInput(manifest, input.signal));
        checkAbort(input.signal);
        return createPortableBatch({
          manifest,
          domain: input.domain,
          page,
          priorCheckpoint: prior,
          maxRecords: input.maxRecords,
          maxBytes: input.maxBytes,
          signal: input.signal,
        });
      });
    },

    verify(checkpoint: PortableCheckpoint): Promise<PortableVerification> {
      return enqueue(async () => {
        const normalized = verifyPortableCheckpoint(checkpoint, manifest);
        const boundary = deepFreeze({
          domain: normalized.domain,
          nextOrdinal: normalized.nextOrdinal,
          recordCount: normalized.recordCount,
          prefixSha256: normalized.prefixSha256,
          lastRecordIdentitySha256: normalized.lastRecordIdentitySha256,
          lastRecordSha256: normalized.lastRecordSha256,
        });
        await authenticateSource(source, sourceVerificationInput(manifest, undefined, boundary));
        return deepFreeze({
          version: 1,
          manifestSha256: manifest.manifestSha256,
          domain: normalized.domain,
          checkpointSha256: normalized.checkpointSha256,
          nextOrdinal: normalized.nextOrdinal,
          recordCount: normalized.recordCount,
          prefixSha256: normalized.prefixSha256,
          complete: normalized.complete,
          matchesManifestBoundary: normalized.complete,
          authoritative: true,
        });
      });
    },

    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = operationTail.then(async () => {
        try {
          await source.close();
        } catch {
          sourceFailure("source-unavailable");
        }
      });
      return closePromise;
    },
  };
  return deepFreeze(stream);
}
