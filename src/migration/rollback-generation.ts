/**
 * Builds and independently verifies a new SQLite generation for item #626
 * (rollback), per plan-v2 section 4 and the "rollback-generation.ts" entry
 * of section 6's module list. Quarantines rather than deletes on any
 * failure, per plan-v2 section 4's "Verification mismatch preserving both
 * evidence sets" acceptance requirement and adjudication S-9 (rejecting a
 * prior reviewer's "discard the incomplete generation" remediation in
 * favor of preserving it as immutable evidence, exactly as #622 treats a
 * failed capture).
 *
 * SCOPE NOTE, read before extending this file. This module implements
 * build + independent verification + quarantine-on-failure for one fresh
 * generation. It deliberately does NOT implement:
 *
 *  - Sidecar materialization (the passive-events db, session_instruction_
 *    cache, machine-sequence reconciliation). Plan-v2 section 4 groups
 *    this under the same "Build and verify" heading, but it is large
 *    enough, and independent enough of build/verify's own correctness, to
 *    land as its own commit.
 *  - Resume. Every call here builds a brand-new generation and refuses
 *    (throws `RollbackGenerationError` with reason
 *    "generation-exists") if anything already exists at its path.
 *    Crash-recovery / in-process-retry semantics for generation building
 *    are plan-v2's "Resumability" story, which states a post-crash resume
 *    "cannot match and must not be claimed" (source session identity is
 *    inside the hashed manifest `admit` byte-compares) --
 *    deciding whether to mint a fresh generationId or retry in-process
 *    belongs with rollback.ts's orchestration, not here.
 *  - Opening the PostgreSQL source. The caller (rollback.ts) owns the
 *    fenced, leased, repeatable-read snapshot and passes this module an
 *    already-open `PortableRecordStream`, the same
 *    "caller already fetched it" discipline rollback-eligibility.ts uses
 *    for its own boundaries.
 *
 * DIRECTORY CONVENTION, a decision recorded here (per owner direction)
 * because nothing else in this Epic currently claims this path and a
 * later item may inherit it. There is no existing "generation directory
 * holding a newly-built destination database" convention anywhere in this
 * codebase: #622's `.lcm/migration-snapshots/generations/<id>`
 * (sqlite-snapshot.ts) preserves EVIDENCE of a database that already
 * existed; #624's verify-generation.ts verifies an existing source in
 * place and never materializes a destination. #626 is the first item to
 * build a new installable database artifact, so it gets its own root,
 * `.lcm/migration-rollback-generations/<generationId>/`,
 * distinct from #622's evidence-preservation tree, so "evidence of what
 * was" and "candidate for what will be" are never in one namespace an
 * operator could confuse during recovery. Quarantined failures live
 * under this SAME root as successes -- an operator finds a generation's
 * failed attempts beside it, not in a second location -- and the
 * quarantine marker is the file mode plus `witness.json`'s
 * `state` field, not a separate path. File/directory
 * discipline reuses sqlite-snapshot.ts's and queue-evidence.ts's existing
 * idiom (security-files.ts's private-directory/private-file primitives,
 * 0700 owner-only directories, 0400 immutable artifacts) rather than a
 * new one.
 *
 * SUCCESS FILES KEEP THEIR ORIGINAL PERMISSIONS. Only a quarantined
 * generation's database file is tightened to 0400: a verified generation
 * is about to be installed at the canonical path by a single rename
 * (plan-v2 section 4 step 4), and the renamed file becomes the live,
 * writable database, so locking it to 0400 here would make the installed
 * database unwritable. `witness.json` itself is always
 * 0400 in both outcomes -- it is write-once evidence either way, never
 * installed.
 */

import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  readBoundedRegularFileWithStat,
} from "../security-files.js";
import {
  canonicalJson,
  createPortableRecordStream,
  negotiatePortableManifest,
  parsePortableManifest,
  serializePortableManifest,
  sha256,
  type PortableManifest,
  type PortableProjectIdentity,
  type PortableRecordStream,
} from "../storage/portable-record-stream.js";
import {
  runPortableTransfer,
  normalizePortableTransferError,
  type PortableTransferProgress,
} from "../storage/portable-transfer.js";
import type { MigrationCanonicalDelta, MigrationCensusVector } from "./activation-witness.js";
import { openSqlitePortableDestination } from "../storage/sqlite/portable-destination.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../storage/sqlite/portable-source.js";

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_WITNESS_BYTES = 64 * 1024;

export type RollbackGenerationErrorReason =
  | "invalid-input"
  | "generation-exists"
  | "unsafe-storage";

export class RollbackGenerationError extends Error {
  constructor(readonly reason: RollbackGenerationErrorReason, message: string = reason, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackGenerationError";
  }
}

function assertGenerationId(value: string): void {
  if (!GENERATION_ID_PATTERN.test(value)) throw new RollbackGenerationError("invalid-input", "invalid rollback generation id");
}

/** Refuses an id that could not name a rollback generation (the same pattern every path here derives from). */
export function assertRollbackGenerationId(value: string): void {
  assertGenerationId(value);
}

/** .lcm/migration-rollback-generations. Idempotent to ensure across many generation ids. */
export function rollbackGenerationsRoot(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-generations");
}

/** .lcm/migration-rollback-generations/<generationId>. */
export function rollbackGenerationPath(homeDir: string, generationId: string): string {
  assertGenerationId(generationId);
  return join(rollbackGenerationsRoot(homeDir), generationId);
}

function rollbackGenerationDatabasePath(homeDir: string, generationId: string): string {
  return join(rollbackGenerationPath(homeDir, generationId), "db.sqlite");
}

function rollbackGenerationManifestPath(homeDir: string, generationId: string): string {
  return join(rollbackGenerationPath(homeDir, generationId), "manifest.bin");
}

function rollbackGenerationWitnessPath(homeDir: string, generationId: string): string {
  return join(rollbackGenerationPath(homeDir, generationId), "witness.json");
}

type ManifestDomainDigest = Readonly<{ domain: string; recordCount: number; prefixSha256: string }>;

export type RollbackGenerationExportEvidence = Readonly<{
  canonicalDelta: MigrationCanonicalDelta;
  censusVector: MigrationCensusVector;
}>;

export type RollbackGenerationWitness = Readonly<{
  version: 1;
  generationId: string;
  state: "verified" | "quarantined";
  manifestSha256: string;
  contentSha256: string | null;
  recordCount: number | null;
  domains: readonly ManifestDomainDigest[] | null;
  reason: string | null;
  exportEvidence: RollbackGenerationExportEvidence | null;
  checksumSha256: string;
}>;

function witnessChecksum(body: Omit<RollbackGenerationWitness, "checksumSha256">): string {
  return sha256(canonicalJson(body as unknown as Record<string, unknown>));
}

export type RollbackGenerationOutcome =
  | Readonly<{
      state: "verified";
      generationId: string;
      databasePath: string;
      manifestSha256: string;
      contentSha256: string;
      recordCount: number;
      witness: RollbackGenerationWitness;
    }>
  | Readonly<{
      state: "quarantined";
      generationId: string;
      databasePath: string;
      reason: string;
      witness: RollbackGenerationWitness;
    }>;

export interface BuildRollbackGenerationInput {
  readonly homeDir: string;
  readonly generationId: string;
  readonly projectIdentity: PortableProjectIdentity;
  /** Caller-opened, caller-fenced source (e.g. the leased PostgreSQL snapshot). This function closes it via runPortableTransfer's own cleanup. */
  readonly source: PortableRecordStream;
  /**
   * The canonical delta and census vector of the snapshot `source` reads,
   * derived once with the verification driver's own builders. Recorded in
   * the build's witness so a later reader can compare it with any other
   * snapshot (plan-v3.1 amendment A6). Absent for a source that is not a
   * fenced PostgreSQL snapshot.
   */
  readonly exportEvidence?: RollbackGenerationExportEvidence;
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PortableTransferProgress) => void;
  /**
   * @internal Deterministic fault-injection seam for tests, mirroring
   * OpenSqlitePortableDestinationInput's _transactionObserver. Invoked
   * once, after runPortableTransfer succeeds and before the independent
   * on-disk manifest is read back, so a test can corrupt manifest.bin at
   * exactly the moment that proves the second verification pass is doing
   * real work rather than re-deriving the same in-memory answer.
   */
  readonly _afterTransferForTesting?: () => void | Promise<void>;
}

function writeWitness(
  homeDir: string,
  generationId: string,
  body: Omit<RollbackGenerationWitness, "checksumSha256">,
): RollbackGenerationWitness {
  const witness: RollbackGenerationWitness = { ...body, checksumSha256: witnessChecksum(body) };
  atomicWritePrivateFileDurable(rollbackGenerationWitnessPath(homeDir, generationId), canonicalJson(witness), {
    finalMode: 0o400,
    requireAbsent: true,
    maxExistingBytes: MAX_WITNESS_BYTES,
  });
  return witness;
}

function quarantine(
  homeDir: string,
  generationId: string,
  databasePath: string,
  manifestSha256: string,
  reason: string,
  exportEvidence: RollbackGenerationExportEvidence | null,
): RollbackGenerationOutcome {
  try { if (existsSync(databasePath)) chmodSync(databasePath, 0o400); } catch { /* best-effort; never block quarantine on this */ }
  const witness = writeWitness(homeDir, generationId, {
    version: 1,
    generationId,
    state: "quarantined",
    manifestSha256,
    contentSha256: null,
    recordCount: null,
    domains: null,
    reason,
    exportEvidence,
  });
  return { state: "quarantined", generationId, databasePath, reason, witness };
}

/**
 * Reopens the just-written SQLite file as a fresh, independent source (a
 * new file descriptor and a new node:sqlite connection, never the writer
 * connection runPortableTransfer just used) and recomputes its content
 * digest and per-domain digests directly from disk. Mirrors the shape of
 * openSqlitePortableDestination's own verifyComplete readback, which is
 * genuinely independent for the destination's bytes -- what it is NOT
 * independent for is the manifest it compares against, which is the exact
 * same in-memory object runPortableTransfer derived from
 * source.describe() before a single record was read. This function's
 * caller supplies that comparand via an on-disk round trip instead (see
 * buildRollbackGeneration below), which is the actual fix plan-v2
 * section 4 requires: "The manifest used for that comparison must arrive
 * by an independent serialization rather than from the same in-memory
 * bytes, or the check always agrees."
 */
async function independentReadback(
  databasePath: string,
  projectIdentity: PortableProjectIdentity,
  capturedAt: string,
  scratchParent: string | undefined,
  signal: AbortSignal | undefined,
): Promise<PortableManifest> {
  const stream = await createPortableRecordStream(await openSqlitePortableSource({
    databasePath,
    projectIdentity,
    expectedFileSha256: sqlitePortableFileSha256(databasePath),
    capturedAt,
    scratchParent,
    signal,
  }));
  try {
    return stream.describe();
  } finally {
    await stream.close();
  }
}

function domainDigests(manifest: PortableManifest): readonly ManifestDomainDigest[] {
  return manifest.domains.map((entry) => ({
    domain: entry.domain,
    recordCount: entry.recordCount,
    prefixSha256: entry.prefixSha256,
  }));
}

function manifestsAgree(left: PortableManifest, right: PortableManifest): boolean {
  if (left.contentSha256 !== right.contentSha256) return false;
  if (left.domains.length !== right.domains.length) return false;
  return left.domains.every((entry, index) => {
    const other = right.domains[index]!;
    return entry.domain === other.domain
      && entry.recordCount === other.recordCount
      && entry.prefixSha256 === other.prefixSha256;
  });
}

/**
 * Builds a brand-new SQLite generation from input.source and verifies it
 * twice: once via runPortableTransfer's built-in verifyComplete call
 * (destination-independent bytes, source-derived-in-memory manifest), and
 * once more here against a manifest that made a real disk round trip
 * (serialized durably, then read back), compared against a completely
 * fresh reopen of the destination file. Never throws for an ordinary
 * build or verification failure -- those return a "quarantined" outcome,
 * preserving whatever was written rather than deleting it. Throws only
 * for precondition violations: an invalid generationId, or a generation
 * that already exists at this id's path (see the SCOPE NOTE above on
 * resume).
 */
export async function buildRollbackGeneration(
  input: BuildRollbackGenerationInput,
): Promise<RollbackGenerationOutcome> {
  assertGenerationId(input.generationId);
  const exportEvidence = input.exportEvidence ?? null;
  const generationDir = rollbackGenerationPath(input.homeDir, input.generationId);
  const databasePath = rollbackGenerationDatabasePath(input.homeDir, input.generationId);
  const manifestPath = rollbackGenerationManifestPath(input.homeDir, input.generationId);

  ensurePrivateDirectory(rollbackGenerationsRoot(input.homeDir));
  try {
    mkdirSync(generationDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RollbackGenerationError("generation-exists", "rollback generation " + input.generationId + " already exists");
    }
    throw new RollbackGenerationError("unsafe-storage", "rollback generation directory could not be created", { cause: error });
  }

  // Durably serialize the source's manifest BEFORE any record is read, so
  // the independent-verification comparand is fixed at build start and
  // arrives later via a genuine disk round trip -- not the same in-memory
  // object runPortableTransfer captures internally at the same moment.
  const sourceManifest = negotiatePortableManifest(input.source.describe());
  atomicWritePrivateFileDurable(manifestPath, serializePortableManifest(sourceManifest), {
    finalMode: 0o400,
    requireAbsent: true,
  });

  let transferResult: Awaited<ReturnType<typeof runPortableTransfer>>;
  try {
    const destination = await openSqlitePortableDestination({
      databasePath,
      projectIdentity: input.projectIdentity,
      generationIdentitySha256: sha256(canonicalJson(["rollback-generation-v1", input.generationId])),
      mode: "create",
      scratchParent: input.scratchParent,
      signal: input.signal,
    });
    transferResult = await runPortableTransfer({
      source: input.source,
      destination,
      signal: input.signal,
      onProgress: input.onProgress,
    });
  } catch (error) {
    const normalized = normalizePortableTransferError(error);
    return quarantine(input.homeDir, input.generationId, databasePath, sourceManifest.manifestSha256, "transfer:" + normalized.code, exportEvidence);
  }

  await input._afterTransferForTesting?.();

  // Independent verification pass. Read the manifest back from disk (not
  // the in-memory sourceManifest above) and reopen the destination file
  // fresh (not the writer connection runPortableTransfer just closed).
  let readBackManifest: PortableManifest;
  try {
    const bytes = readBoundedRegularFileWithStat(manifestPath, {
      allowedRoot: generationDir,
      maxBytes: MAX_MANIFEST_BYTES,
      allowedModes: [0o400],
      requireSingleLink: true,
    });
    readBackManifest = parsePortableManifest(Buffer.from(bytes.content, "utf8"));
  } catch (error) {
    return quarantine(input.homeDir, input.generationId, databasePath, sourceManifest.manifestSha256, "independent-verification:manifest-readback-failed", exportEvidence);
  }
  if (readBackManifest.manifestSha256 !== transferResult.manifestSha256) {
    return quarantine(input.homeDir, input.generationId, databasePath, sourceManifest.manifestSha256, "independent-verification:manifest-sha-mismatch", exportEvidence);
  }

  let freshManifest: PortableManifest;
  try {
    freshManifest = await independentReadback(
      databasePath,
      input.projectIdentity,
      readBackManifest.source.capturedAt,
      input.scratchParent,
      input.signal,
    );
  } catch (error) {
    return quarantine(input.homeDir, input.generationId, databasePath, sourceManifest.manifestSha256, "independent-verification:readback-failed", exportEvidence);
  }
  if (!manifestsAgree(readBackManifest, freshManifest)) {
    return quarantine(input.homeDir, input.generationId, databasePath, sourceManifest.manifestSha256, "independent-verification:content-mismatch", exportEvidence);
  }

  const witness = writeWitness(input.homeDir, input.generationId, {
    version: 1,
    generationId: input.generationId,
    state: "verified",
    manifestSha256: readBackManifest.manifestSha256,
    contentSha256: freshManifest.contentSha256,
    recordCount: transferResult.recordCount,
    domains: domainDigests(freshManifest),
    reason: null,
    exportEvidence,
  });

  return {
    state: "verified",
    generationId: input.generationId,
    databasePath,
    manifestSha256: readBackManifest.manifestSha256,
    contentSha256: freshManifest.contentSha256,
    recordCount: transferResult.recordCount,
    witness,
  };
}
