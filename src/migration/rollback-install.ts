/**
 * Moves the live canonical SQLite database aside and installs a verified
 * rollback generation in its place, for item #626, per plan-v2 section 4
 * ("Moving it aside correctly") and section 5 step 11 ("Install
 * precedes publication").
 *
 * ORDER IS THE CONTRACT, not an implementation detail. Each step exists
 * because skipping it produces intermittent, hard-to-reproduce corruption
 * rather than a clean failure:
 *
 *  1. Release the pooled connection for the canonical path FIRST. Pooled
 *     handles are keyed by path and track inode (db/connection.ts:249-272
 *     `getPooledLcmConnection` / the `_connections` map), so a
 *     handle left open follows the renamed inode and keeps writing the
 *     file this function is about to preserve as evidence.
 *  2. Checkpoint and convert to `journal_mode = DELETE`. Live
 *     LCM connections run WAL (db/connection.ts:307), so the sibling set
 *     matters: renaming the main file alone would neither preserve a
 *     complete committed image nor stop a stale -wal poisoning a newly
 *     installed file at the same name. #622 already solved exactly this
 *     problem (sqlite-snapshot.ts's `inspectDatabase`,
 *     `normalize: true` branch) and this reuses that same two-PRAGMA
 *     idiom rather than inventing a second one.
 *  3. Witness the file, move it aside to a lineage path, and witness it
 *     again -- proving the move preserved the exact bytes rather than
 *     merely trusting `renameSync`'s success.
 *  4. Install the verified generation at the canonical path by a single
 *     rename, so a reader never observes a partially-written file at that
 *     name.
 *
 * WHAT THIS MODULE DOES NOT OWN. It performs no PostgreSQL-side fencing,
 * no BackendPublicationCoordinator calls, and no maintenance-journal
 * transitions -- those belong to rollback.ts's orchestration, which calls
 * this function while the retained local token and the durable
 * PostgreSQL lease are already held. The window this function's own
 * crash-recovery leaves open (canonical path briefly absent, between
 * moving the old file aside and installing the new one) is closed by
 * that durable maintenance-journal state, not by anything in this file:
 * `assertBackendPublicationConsumerAccessUnlocked`
 * (backend-publication.ts:1616-1632) refuses `unresolved-publication`
 * for any caller going through backend selection while maintenance
 * remains non-terminal, and it reads that fact from the durable journal
 * file, not from an in-memory lock that would die with a crashed
 * process. This function's own idempotence (skipping preemption when the
 * canonical path is already absent) is what makes a retry after such a
 * crash safe to call again.
 *
 * PR #1556 thread 4308518705. The move-aside is recorded durably BEFORE
 * its rename, in a record keyed by the rollback's own generation id
 * (.lcm/migration-rollback-preemptions/<rollbackGenerationId>.json), and
 * completed in that record once the preserved file is read-only, flushed
 * and witnessed again. A retry whose build lands in a different generation
 * directory (every attempt's does) therefore still finds the preserved
 * file of a crashed attempt and finishes it: a crash between the rename
 * and the chmod no longer leaves the pre-rollback database writable,
 * unflushed and unverified. A record that is complete leaves nothing to
 * finish; a live canonical file beside an unfinished preserved file is a
 * state no path here produces and refuses.
 */

import { chmodSync, lstatSync, openSync, closeSync, readSync, renameSync, type BigIntStats } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  getExistingLcmConnection,
  invalidateLcmConnection,
} from "../db/connection.js";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  readBoundedRegularFileWithStat,
  syncPrivateDirectory,
} from "../security-files.js";
import { assertRollbackGenerationId, rollbackGenerationPath } from "./rollback-generation.js";

export type RollbackInstallErrorReason =
  | "unsafe-storage"
  | "move-aside-content-changed";

export class RollbackInstallError extends Error {
  constructor(readonly reason: RollbackInstallErrorReason, message: string = reason, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackInstallError";
  }
}

/** Mirrors sqlite-snapshot.ts's SqliteSnapshotFileIdentity field set -- the established witness shape, not a new one. */
export type RollbackFileWitness = Readonly<{
  dev: string;
  ino: string;
  mode: number;
  size: string;
  sha256: string;
}>;

export type RollbackInstallOutcome = Readonly<{
  canonicalPath: string;
  preempted: Readonly<{
    path: string;
    before: RollbackFileWitness;
    after: RollbackFileWitness;
  }> | null;
}>;

export interface InstallRollbackGenerationInput {
  readonly homeDir: string;
  /** The generation being installed; the preempted file is recorded beside it. */
  readonly generationId: string;
  /** The rollback's own generation id, stable across its attempts; the move-aside record is keyed by it. */
  readonly rollbackGenerationId: string;
  readonly canonicalPath: string;
  /** BuildRollbackGenerationOutcome's databasePath when state is "verified". */
  readonly verifiedDatabasePath: string;
  /**
   * Flushes a directory so a rename's directory entries are durable. Defaults to syncPrivateDirectory
   * (src/security-files.ts). Injectable so a test can fail it.
   */
  readonly syncDirectory?: (path: string) => void;
}

const COPY_CHUNK = 1024 * 1024;
const OWNER_FILE_MODES = new Set([0o400, 0o500, 0o600, 0o700]);
const MAX_ROLLBACK_PREEMPTION_RECORD_BYTES = 65536;

/** One move-aside of the canonical database: its intent (`after` null) before the rename, its completion after the witness. */
export type RollbackPreemptionMove = Readonly<{
  preemptedPath: string;
  before: RollbackFileWitness;
  after: RollbackFileWitness | null;
}>;

/**
 * The durable move-aside record of one rollback: every move of its canonical database, appended in order and
 * never rewritten once complete. The first completed move preserved the true pre-rollback database (the
 * original); a later move, after a crash between an install and the selection, preserved an installed generation
 * and is recorded beside it. Only the last move can be unfinished; an earlier unfinished one was superseded (its
 * rename never became durable).
 */
export type RollbackPreemptionRecord = Readonly<{
  version: 2;
  rollbackGenerationId: string;
  canonicalPath: string;
  moves: readonly RollbackPreemptionMove[];
}>;

/** A move whose completion witness has been recorded. */
export type CompletedRollbackPreemptionMove = RollbackPreemptionMove & Readonly<{ after: RollbackFileWitness }>;

/** The first completed move: the preserved pre-rollback database (undefined while no move has completed). */
export function originalRollbackPreemption(record: RollbackPreemptionRecord): CompletedRollbackPreemptionMove | undefined {
  return record.moves.find((move): move is CompletedRollbackPreemptionMove => move.after !== null);
}

function rollbackPreemptionDirectory(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-preemptions");
}

/** .lcm/migration-rollback-preemptions/<rollbackGenerationId>.json. */
export function rollbackPreemptionRecordPath(homeDir: string, rollbackGenerationId: string): string {
  assertRollbackGenerationId(rollbackGenerationId);
  return join(rollbackPreemptionDirectory(homeDir), rollbackGenerationId + ".json");
}

function isFileWitness(value: unknown): value is RollbackFileWitness {
  if (typeof value !== "object" || value === null) return false;
  const witness = value as Record<string, unknown>;
  return typeof witness.dev === "string" && typeof witness.ino === "string" && typeof witness.mode === "number"
    && typeof witness.size === "string" && typeof witness.sha256 === "string";
}

function writePreemptionRecord(homeDir: string, record: RollbackPreemptionRecord): void {
  ensurePrivateDirectory(rollbackPreemptionDirectory(homeDir));
  atomicWritePrivateFileDurable(rollbackPreemptionRecordPath(homeDir, record.rollbackGenerationId), JSON.stringify(record), {
    maxExistingBytes: MAX_ROLLBACK_PREEMPTION_RECORD_BYTES,
  });
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function readRollbackPreemptionRecord(homeDir: string, rollbackGenerationId: string): RollbackPreemptionRecord | null {
  const path = rollbackPreemptionRecordPath(homeDir, rollbackGenerationId);
  let content: string;
  try {
    content = Buffer.from(readBoundedRegularFileWithStat(path, {
      allowedRoot: rollbackPreemptionDirectory(homeDir),
      maxBytes: MAX_ROLLBACK_PREEMPTION_RECORD_BYTES,
      allowedModes: [0o600],
      requireSingleLink: true,
    }).content).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RollbackInstallError("unsafe-storage", "the move-aside record could not be read", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "the move-aside record is malformed", { cause: error });
  }
  const record = parsed as Record<string, unknown>;
  const isMove = (value: unknown): boolean => typeof value === "object" && value !== null
    && typeof (value as Record<string, unknown>).preemptedPath === "string"
    && isFileWitness((value as Record<string, unknown>).before)
    && ((value as Record<string, unknown>).after === null || isFileWitness((value as Record<string, unknown>).after));
  if (
    typeof parsed !== "object" || parsed === null
    || record.version !== 2
    || record.rollbackGenerationId !== rollbackGenerationId
    || typeof record.canonicalPath !== "string"
    || !Array.isArray(record.moves)
    || record.moves.length === 0
    || !record.moves.every(isMove)
  ) {
    throw new RollbackInstallError("unsafe-storage", "the move-aside record is malformed");
  }
  return parsed as RollbackPreemptionRecord;
}

/**
 * A preserved file must still be exactly what its completion witnessed: a plain single-link regular file at
 * mode 0400 with the same identity and bytes. Anything else refuses; the record is not trusted over the file.
 */
function assertPreservedFileMatches(move: CompletedRollbackPreemptionMove): void {
  let stat: BigIntStats;
  try {
    stat = lstatSync(move.preemptedPath, { bigint: true });
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "a preserved database recorded as complete is missing", { cause: error });
  }
  if (!stat.isFile() || stat.nlink !== 1n || (Number(stat.mode) & 0o777) !== 0o400) {
    throw new RollbackInstallError("unsafe-storage", "a preserved database is no longer a plain single-link read-only file");
  }
  if (stat.dev.toString() !== move.after.dev || stat.ino.toString() !== move.after.ino || stat.size.toString() !== move.after.size) {
    throw new RollbackInstallError("unsafe-storage", "a preserved database is not the file its move-aside record completed");
  }
  if (streamSha256(move.preemptedPath, Number(stat.size)) !== move.after.sha256) {
    throw new RollbackInstallError("unsafe-storage", "a preserved database's bytes differ from its move-aside record");
  }
}

function releasePooledCanonicalConnection(canonicalPath: string): void {
  const db = getExistingLcmConnection(canonicalPath);
  if (db === null) return;
  invalidateLcmConnection(canonicalPath, db);
}

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function streamSha256(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let position = 0;
    while (position < size) {
      const wanted = Math.min(buffer.byteLength, size - position);
      const read = readSync(fd, buffer, 0, wanted, position);
      if (read <= 0) throw new RollbackInstallError("unsafe-storage", "canonical database changed while being witnessed");
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const extra = readSync(fd, buffer, 0, 1, position);
    if (extra !== 0) throw new RollbackInstallError("unsafe-storage", "canonical database grew while being witnessed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function witnessFile(path: string): RollbackFileWitness {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || !OWNER_FILE_MODES.has(Number(stat.mode) & 0o777)) {
    throw new RollbackInstallError("unsafe-storage", "canonical database is not a plain owner-only regular file");
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode) & 0o777,
    size: stat.size.toString(),
    sha256: streamSha256(path, Number(stat.size)),
  };
}

/** Reuses sqlite-snapshot.ts's checkpoint-then-DELETE idiom exactly (its `inspectDatabase`, normalize branch). */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function checkpointAndConvertToDelete(path: string): void {
  // mode=rw opens an existing file read/write and atomically refuses to
  // create a replacement main file, matching db/connection.ts:282-292's
  // own idiom for the same reason: this must never create.
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "rw");
  const db = new DatabaseSync(url);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE");
    const mode = db.prepare("PRAGMA journal_mode").get()!.journal_mode;
    if (mode !== "delete") throw new RollbackInstallError("unsafe-storage", "canonical database did not convert to journal_mode=DELETE");
  } finally {
    db.close();
  }
}

function assertNoWalSiblings(path: string): void {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    throw new RollbackInstallError("unsafe-storage", "canonical database still has WAL siblings after journal_mode=DELETE");
  }
}

/**
 * Three-valued in effect, named rather than collapsed into a boolean per
 * this Epic's standing rule against collapsing absence with failure:
 * `false` means a positively observed ENOENT (nothing lives here yet, a
 * normal first-install or a post-crash retry), `true` means a live plain
 * regular file was found, and any other stat failure (permission denied,
 * an unreadable parent, ...) is a distinct precondition failure that must
 * not be silently treated as either of the other two.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function checkCanonicalLiveExists(canonicalPath: string): boolean {
  try {
    const stat = lstatSync(canonicalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RollbackInstallError("unsafe-storage", "canonical database path is not a plain regular file");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Flushes the source and destination directories of a rename; a failure of either propagates. */
function syncRenamedDirectories(sync: (path: string) => void, fromDir: string, toDir: string): void {
  try {
    sync(fromDir);
    if (toDir !== fromDir) sync(toDir);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "a directory could not be flushed after a rename", { cause: error });
  }
}

/**
 * Moves the live canonical database aside (if one exists) and installs
 * the verified generation in its place. Idempotent across a crash: if the
 * canonical path is already absent (a prior attempt already moved it
 * aside but crashed before installing), this first finishes that attempt's
 * move-aside from its durable record when it is unfinished, then skips
 * straight to install.
 */
export function installRollbackGeneration(
  input: InstallRollbackGenerationInput,
): RollbackInstallOutcome {
  const canonicalPath = resolve(input.canonicalPath);
  const syncDirectory = input.syncDirectory ?? ((path: string) => syncPrivateDirectory(path));
  /**
   * Finishes the record's last move: the preserved file is checked to be a plain single-link regular file (never
   * a symlink, whose target a chmod would follow) and made read-only, both directories are flushed, the file is
   * witnessed again and compared, and the move is completed in the record. Returns the record as completed. A
   * preserved file that is absent means the rename never became durable and something else removed the canonical
   * file, which nothing here can repair.
   */
  const finishPreemption = (record: RollbackPreemptionRecord): RollbackPreemptionRecord => {
    const move = record.moves[record.moves.length - 1]!;
    let stat: BigIntStats;
    try {
      stat = lstatSync(move.preemptedPath, { bigint: true });
    } catch (error) {
      throw new RollbackInstallError("unsafe-storage", "the canonical database is absent and its unfinished move-aside record does not account for it", { cause: error });
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new RollbackInstallError("unsafe-storage", "the preserved database of an unfinished move-aside is not a plain single-link regular file");
    }
    // The preserved file is made read-only before the directories are flushed, so the flush covers its mode too (F14).
    chmodSync(move.preemptedPath, 0o400);
    // Both directories changed (the entry left one and entered the other): flush them before anything else.
    syncRenamedDirectories(syncDirectory, dirname(record.canonicalPath), dirname(move.preemptedPath));
    const after = witnessFile(move.preemptedPath);
    if (move.before.sha256 !== after.sha256 || move.before.size !== after.size) {
      throw new RollbackInstallError("move-aside-content-changed", "canonical database bytes changed across the move-aside rename");
    }
    const completed: RollbackPreemptionRecord = { ...record, moves: [...record.moves.slice(0, -1), { ...move, after }] };
    writePreemptionRecord(input.homeDir, completed);
    return completed;
  };
  try {
    releasePooledCanonicalConnection(canonicalPath);
  } catch (error) {
    throw new RollbackInstallError("unsafe-storage", "canonical database pool could not be released", { cause: error });
  }

  const liveExists = checkCanonicalLiveExists(canonicalPath);
  let record = readRollbackPreemptionRecord(input.homeDir, input.rollbackGenerationId);
  if (record !== null) {
    // The record is this rollback's account of this canonical path, and every move it recorded as complete must
    // still be exactly the file it witnessed. Nothing is trusted, moved or installed before that holds.
    if (record.canonicalPath !== canonicalPath) {
      throw new RollbackInstallError("unsafe-storage", "the move-aside record names another canonical database");
    }
    for (const move of record.moves) {
      if (move.after !== null) assertPreservedFileMatches({ ...move, after: move.after });
    }
  }
  const last = record === null ? null : record.moves[record.moves.length - 1]!;
  const unfinished = last !== null && last.after === null ? last : null;

  if (liveExists) {
    if (unfinished !== null && existsSync(unfinished.preemptedPath)) {
      throw new RollbackInstallError("unsafe-storage", "a live canonical database and an unfinished preserved database both exist");
    }
    checkpointAndConvertToDelete(canonicalPath);
    assertNoWalSiblings(canonicalPath);
    const before = witnessFile(canonicalPath);
    const preemptedPath = join(rollbackGenerationPath(input.homeDir, input.generationId), "preempted-canonical.sqlite");
    // The intent is appended durably before the rename, so a crash anywhere after it is finished by the retry
    // below; an earlier completed move (the original) is never rewritten.
    const intent: RollbackPreemptionRecord = {
      version: 2, rollbackGenerationId: input.rollbackGenerationId, canonicalPath,
      moves: [...(record?.moves ?? []), { preemptedPath, before, after: null }],
    };
    writePreemptionRecord(input.homeDir, intent);
    renameSync(canonicalPath, preemptedPath);
    record = finishPreemption(intent);
  } else if (unfinished !== null) {
    // A prior attempt crashed between its rename and its completion: the canonical file is gone and the record is
    // its only account; the preserved file must be where the record says.
    record = finishPreemption(record!);
  }
  const original = record === null ? undefined : originalRollbackPreemption(record);
  const preempted = original === undefined ? null : { path: original.preemptedPath, before: original.before, after: original.after };

  renameSync(input.verifiedDatabasePath, canonicalPath);
  // The selection must not become durable before the installed database's directory entries are (A-03 / F3).
  syncRenamedDirectories(syncDirectory, dirname(input.verifiedDatabasePath), dirname(canonicalPath));
  return { canonicalPath, preempted };
}
