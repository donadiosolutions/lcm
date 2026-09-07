import {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PortableStreamError,
  negotiatePortableManifest,
  canonicalJson,
  comparePortableOrder,
  parsePortableRecord,
  serializePortableRecord,
  sha256,
  serializePortableCheckpoint,
  verifyPortableCheckpoint,
} from "./portable-record-stream.js";
import type {
  PortableBatch,
  PortableCheckpoint,
  PortableDomain,
  PortableManifest,
  PortableRecordStream,
  PortableStreamErrorCode,
} from "./portable-record-stream.js";

export type PortableTransferErrorCode =
  | "invalid-input" | "unsupported-capability" | "source-changed"
  | "source-failed" | "destination-conflict" | "destination-failed"
  | "destination-uncertain" | "checkpoint-mismatch" | "zero-progress"
  | "aborted" | "verification-failed" | "close-failed";

const ERROR_POLICY: Readonly<Record<PortableStreamErrorCode, readonly [PortableTransferErrorCode, boolean]>> = {
  "unsupported-version": ["unsupported-capability", false],
  "unknown-domain": ["invalid-input", false],
  "malformed-record": ["invalid-input", false],
  "record-unrepresentable": ["unsupported-capability", false],
  "duplicate-identity": ["invalid-input", false],
  "order-regression": ["invalid-input", false],
  "dependency-order": ["invalid-input", false],
  "malformed-manifest": ["invalid-input", false],
  "incompatible-schema": ["unsupported-capability", false],
  "invalid-limit": ["invalid-input", false],
  "batch-limit-exceeded": ["invalid-input", false],
  "checkpoint-mismatch": ["checkpoint-mismatch", false],
  "partial-batch": ["checkpoint-mismatch", false],
  "source-changed": ["source-changed", false],
  "source-invalid": ["source-failed", false],
  "source-unavailable": ["source-failed", true],
  "aborted": ["aborted", true],
  "closed": ["source-failed", false],
};
const ERROR_CODES: readonly PortableTransferErrorCode[] = [
  "invalid-input", "unsupported-capability", "source-changed", "source-failed",
  "destination-conflict", "destination-failed", "destination-uncertain",
  "checkpoint-mismatch", "zero-progress", "aborted", "verification-failed", "close-failed",
];

/** A closed vocabulary deliberately excludes driver text, causes and record data. */
export class PortableTransferError extends Error {
  readonly code: PortableTransferErrorCode;
  readonly retryable: boolean;

  constructor(code: PortableTransferErrorCode, retryable = false) {
    const safeCode = ERROR_CODES.includes(code) ? code : "invalid-input";
    super(`Portable transfer error: ${safeCode}`);
    this.name = "PortableTransferError";
    this.code = safeCode;
    this.retryable = retryable && [
      "source-failed", "destination-failed", "destination-uncertain", "aborted",
    ].includes(safeCode);
  }
}

export function normalizePortableTransferError(
  error: unknown,
  fallback: PortableTransferErrorCode = "destination-failed",
): PortableTransferError {
  try {
    if (error instanceof PortableTransferError) return new PortableTransferError(error.code, error.retryable);
    if (error instanceof PortableStreamError && Object.hasOwn(ERROR_POLICY, error.code)) {
      const [code, retryable] = ERROR_POLICY[error.code];
      return new PortableTransferError(code, retryable);
    }
  } catch { /* Even a hostile error object must not prevent handle cleanup. */ }
  return new PortableTransferError(fallback);
}

/** Opaque public shape; each production adapter validates its own private brand. */
export interface PortablePreflight {
  readonly manifestSha256: string;
  readonly destinationWitnessSha256: string;
}

export interface PortableDestinationProgress {
  readonly generationIdentitySha256: string;
  readonly manifestSha256: string;
  /** Contiguous domain prefix, with at most one incomplete final checkpoint. */
  readonly checkpoints: readonly PortableCheckpoint[];
  readonly complete: boolean;
}

export interface PortableDestinationVerification {
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly domains: readonly Readonly<{
    domain: PortableDomain;
    recordCount: number;
    prefixSha256: string;
  }>[];
  readonly complete: true;
}

export interface PortableRecordWriter {
  /** Complete bounded capability/relationship scan; does not mutate the target. */
  preflight(manifest: PortableManifest, source: PortableRecordStream, signal?: AbortSignal): Promise<PortablePreflight>;
  /** Accept only this adapter's branded preflight, under retained target authority. */
  admit(manifest: PortableManifest, preflight: PortablePreflight, signal?: AbortSignal): Promise<void>;
  readProgress(manifestSha256: string, signal?: AbortSignal): Promise<PortableDestinationProgress>;
  /** Apply data, dependency mappings and immutable receipt in one transaction. */
  applyBatch(batch: PortableBatch, signal?: AbortSignal): Promise<PortableCheckpoint>;
  /** Read and hash actual destination domains before marking the run complete. */
  verifyComplete(manifest: PortableManifest, signal?: AbortSignal): Promise<PortableDestinationVerification>;
  close(): Promise<void>;
}

export interface RunPortableTransferInput {
  readonly source: PortableRecordStream;
  readonly destination: PortableRecordWriter;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  /** Contains only allowlisted counts and hashes, never domain records. */
  readonly onProgress?: (progress: PortableTransferProgress) => void;
}

export interface PortableTransferProgress {
  readonly domain: PortableDomain;
  readonly recordCount: number;
  readonly manifestSha256: string;
  readonly checkpointSha256: string;
  readonly complete: boolean;
}

export interface PortableTransferResult {
  readonly manifestSha256: string;
  readonly contentSha256: string;
  readonly recordCount: number;
  readonly checkpoints: readonly PortableCheckpoint[];
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortableTransferError("aborted", true);
}

/** Validate a replayable batch without requiring the previous payload in the ledger. */
export function validatePortableTransferBatch(
  batch: PortableBatch,
  manifest: PortableManifest,
  priorCheckpoint?: PortableCheckpoint,
): PortableBatch {
  try {
    const admitted = negotiatePortableManifest(manifest);
    const prior = priorCheckpoint === undefined ? undefined : verifyPortableCheckpoint(priorCheckpoint, admitted);
    const checkpoint = verifyPortableCheckpoint(batch.checkpoint, admitted);
    if (
      batch.version !== 1 || batch.manifestSha256 !== admitted.manifestSha256
      || checkpoint.domain !== batch.domain || prior?.complete === true
      || (prior !== undefined && prior.domain !== batch.domain)
      || batch.priorCheckpointSha256 !== (prior?.checkpointSha256 ?? null)
      || checkpoint.previousCheckpointSha256 !== (prior?.checkpointSha256 ?? null)
      || batch.complete !== checkpoint.complete || !Array.isArray(batch.records)
      || batch.records.length > PORTABLE_LIMITS.maxBatchRecords
    ) throw new PortableTransferError("checkpoint-mismatch");
    if (batch.records.length === 0 && !batch.complete) throw new PortableTransferError("zero-progress");
    let prefix = prior?.prefixSha256 ?? sha256(canonicalJson([
      "lcm-portable-domain-v1", admitted.schemaSha256, batch.domain, 1,
    ]));
    let framedBytes = 0;
    const identities = new Set<string>();
    const records = Array.from(batch.records, (record, index) => {
      const bytes = serializePortableRecord(record);
      framedBytes += bytes.byteLength;
      if (framedBytes > PORTABLE_LIMITS.maxBatchBytes) throw new PortableTransferError("invalid-input");
      const normalized = parsePortableRecord(bytes);
      if (
        normalized.domain !== batch.domain || normalized.ordinal !== (prior?.nextOrdinal ?? 0) + index
        || identities.has(normalized.identitySha256)
        || (index > 0 && comparePortableOrder(batch.records[index - 1].order, normalized.order) > 0)
      ) throw new PortableTransferError("checkpoint-mismatch");
      identities.add(normalized.identitySha256);
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.byteLength));
      prefix = sha256(Buffer.concat([Buffer.from(prefix, "hex"), length, bytes]));
      return normalized;
    });
    const last = records.at(-1);
    if (
      framedBytes !== batch.framedBytes
      || checkpoint.nextOrdinal !== (prior?.nextOrdinal ?? 0) + records.length
      || checkpoint.prefixSha256 !== prefix
      || checkpoint.lastRecordIdentitySha256 !== (last?.identitySha256 ?? prior?.lastRecordIdentitySha256 ?? null)
      || checkpoint.lastRecordSha256 !== (last?.recordSha256 ?? prior?.lastRecordSha256 ?? null)
    ) throw new PortableTransferError("checkpoint-mismatch");
    return Object.freeze({ ...batch, records: Object.freeze(records), checkpoint });
  } catch (error) {
    throw normalizePortableTransferError(error, "invalid-input");
  }
}

function validateProgress(progress: PortableDestinationProgress, manifest: PortableManifest): PortableCheckpoint[] {
  if (
    !/^[0-9a-f]{64}$/.test(progress.generationIdentitySha256)
    || progress.manifestSha256 !== manifest.manifestSha256
    || !Array.isArray(progress.checkpoints)
    || progress.checkpoints.length > PORTABLE_RECORD_DOMAIN_ORDER.length
    || typeof progress.complete !== "boolean"
  ) throw new PortableTransferError("checkpoint-mismatch");
  const checkpoints = Array.from(progress.checkpoints, (checkpoint, index) => {
    const verified = verifyPortableCheckpoint(checkpoint, manifest);
    if (
      verified.domain !== PORTABLE_RECORD_DOMAIN_ORDER[index]
      || (!verified.complete && index !== progress.checkpoints.length - 1)
    ) throw new PortableTransferError("checkpoint-mismatch");
    return verified;
  });
  if (progress.complete && (
    checkpoints.length !== PORTABLE_RECORD_DOMAIN_ORDER.length || !checkpoints.at(-1)?.complete
  )) throw new PortableTransferError("checkpoint-mismatch");
  return checkpoints;
}

function assertVerification(result: PortableDestinationVerification, manifest: PortableManifest): void {
  if (
    result.complete !== true || result.manifestSha256 !== manifest.manifestSha256
    || result.contentSha256 !== manifest.contentSha256
    || result.domains.length !== manifest.domains.length
    || Array.from(result.domains).some((domain, index) => {
      const expected = manifest.domains[index];
      return domain === undefined || domain.domain !== expected.domain || domain.recordCount !== expected.recordCount
        || domain.prefixSha256 !== expected.prefixSha256;
    })
  ) throw new PortableTransferError("verification-failed");
}

async function verifySourceBoundary(source: PortableRecordStream, checkpoint: PortableCheckpoint): Promise<void> {
  const result = await source.verify(checkpoint);
  if (
    result.version !== 1 || result.authoritative !== true
    || result.manifestSha256 !== checkpoint.manifestSha256
    || result.domain !== checkpoint.domain || result.checkpointSha256 !== checkpoint.checkpointSha256
    || result.nextOrdinal !== checkpoint.nextOrdinal || result.recordCount !== checkpoint.recordCount
    || result.prefixSha256 !== checkpoint.prefixSha256 || result.complete !== checkpoint.complete
    || result.matchesManifestBoundary !== checkpoint.complete
  ) throw new PortableTransferError("verification-failed");
}

/** Own both handles until deterministic cleanup, including all failure paths. */
export async function runPortableTransfer(input: RunPortableTransferInput): Promise<PortableTransferResult> {
  let failure: PortableTransferError | undefined;
  let result: PortableTransferResult | undefined;
  let seam: PortableTransferErrorCode = "invalid-input";
  try {
    checkAbort(input.signal);
    const maxRecords = input.maxRecords ?? PORTABLE_LIMITS.maxBatchRecords;
    const maxBytes = input.maxBytes ?? PORTABLE_LIMITS.maxBatchBytes;
    if (
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > PORTABLE_LIMITS.maxBatchRecords
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PORTABLE_LIMITS.maxBatchBytes
    ) throw new PortableTransferError("invalid-input");
    seam = "source-failed";
    const manifest = negotiatePortableManifest(input.source.describe());
    seam = "destination-failed";
    const preflight = await input.destination.preflight(manifest, input.source, input.signal);
    checkAbort(input.signal);
    await input.destination.admit(manifest, preflight, input.signal);
    const checkpoints = validateProgress(await input.destination.readProgress(manifest.manifestSha256, input.signal), manifest);
    for (const [index, domain] of PORTABLE_RECORD_DOMAIN_ORDER.entries()) {
      checkAbort(input.signal);
      let checkpoint: PortableCheckpoint | undefined = checkpoints[index];
      if (checkpoint !== undefined) {
        seam = "source-failed";
        await verifySourceBoundary(input.source, checkpoint);
      }
      while (!checkpoint?.complete) {
        checkAbort(input.signal);
        seam = "source-failed";
        const batch = validatePortableTransferBatch(await input.source.readBatch({
          domain, after: checkpoint, maxRecords, maxBytes, signal: input.signal,
        }), manifest, checkpoint);
        if (batch.domain !== domain || batch.records.length > maxRecords || batch.framedBytes > maxBytes) {
          throw new PortableTransferError("invalid-input");
        }
        await verifySourceBoundary(input.source, batch.checkpoint);
        checkAbort(input.signal);
        seam = "destination-failed";
        const acknowledgement = verifyPortableCheckpoint(await input.destination.applyBatch(batch, input.signal), manifest);
        if (!Buffer.from(serializePortableCheckpoint(acknowledgement)).equals(Buffer.from(serializePortableCheckpoint(batch.checkpoint)))) {
          throw new PortableTransferError("checkpoint-mismatch");
        }
        checkpoint = acknowledgement;
        checkpoints[index] = checkpoint;
        input.onProgress?.(Object.freeze({
          domain, recordCount: checkpoint.recordCount, manifestSha256: manifest.manifestSha256,
          checkpointSha256: checkpoint.checkpointSha256, complete: checkpoint.complete,
        }));
      }
    }
    checkAbort(input.signal);
    seam = "verification-failed";
    assertVerification(await input.destination.verifyComplete(manifest, input.signal), manifest);
    seam = "source-failed";
    for (const checkpoint of checkpoints) {
      checkAbort(input.signal);
      await verifySourceBoundary(input.source, checkpoint);
    }
    result = Object.freeze({
      manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256,
      recordCount: checkpoints.reduce((sum, checkpoint) => sum + checkpoint.recordCount, 0),
      checkpoints: Object.freeze(checkpoints),
    });
  } catch (error) {
    failure = normalizePortableTransferError(error, seam);
  }
  for (const handle of [input.destination, input.source]) {
    try { await handle.close(); }
    catch { failure ??= new PortableTransferError("close-failed"); }
  }
  if (failure !== undefined) throw failure;
  return result as PortableTransferResult;
}
