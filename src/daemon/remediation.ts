import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  deleteRegularFile,
  readBoundedRegularFileWithStat,
  writePrivateFileExclusive,
} from "../security-files.js";

/**
 * The marker is deliberately a small, non-authoritative hint.  Lifecycle
 * decisions must never depend on its presence, contents, or write result.
 */
export const DAEMON_REMEDIATION_MARKER_VERSION = 1 as const;
export const DAEMON_REMEDIATION_MARKER_NAME = "daemon-remediation.v1.json";
export const DAEMON_NOTICE_REPEAT_INTERVAL_MS = 30 * 60 * 1_000;

/**
 * The marker is shared by every scope under one state root.  Serialise the
 * complete read/decision/replacement sequence rather than locking a single
 * scope, otherwise independent scope writers could still overwrite one
 * another's entries.  A short deadline keeps a damaged or abandoned lock
 * from blocking hook delivery indefinitely.
 */
const DAEMON_REMEDIATION_LOCK_TIMEOUT_MS = 250;
const DAEMON_REMEDIATION_LOCK_RETRY_MS = 5;
const DAEMON_REMEDIATION_LOCK_STALE_MS = 10_000;
const DAEMON_REMEDIATION_LOCK_MAX_BYTES = 512;
const DAEMON_REMEDIATION_LOCK_VERSION = 1 as const;
const LOCK_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Refusal reasons are a closed vocabulary.  Callers should map their richer
 * observations to one of these values before crossing the remediation seam.
 */
export const DAEMON_REFUSAL_REASONS = [
  "live-no-response",
  "response-invalid",
  "response-timeout",
  "response-auth-failure",
  "stale-config",
  "invalid-collision",
  "ambiguous",
  "detached-no-response",
  "manager-unavailable",
  "absent",
  "not-running",
  "startup-failure",
] as const;

export type DaemonRefusalReason = typeof DAEMON_REFUSAL_REASONS[number];

export function isDaemonRefusalReason(value: unknown): value is DaemonRefusalReason {
  return typeof value === "string"
    && (DAEMON_REFUSAL_REASONS as readonly string[]).includes(value);
}

export type RemediationKind = "restart" | "doctor" | "safe-start";

export type SanitizedRemediation = Readonly<{
  /** Stable action classification used by CLI, doctor, and hooks. */
  kind: RemediationKind;
  /** Alias for integrations that call the classification an action. */
  action: RemediationKind;
  /** A fixed, safe command string; never a path, PID, or shell fragment. */
  command: "lcm daemon restart" | "lcm doctor" | "lcm daemon start";
  /** User-facing text containing only the bounded reason and fixed guidance. */
  message: string;
}>;

const REMEDIATION_KIND_BY_REASON: Readonly<Record<DaemonRefusalReason, RemediationKind>> = {
  "live-no-response": "doctor",
  "response-invalid": "doctor",
  "response-timeout": "doctor",
  "response-auth-failure": "doctor",
  "stale-config": "restart",
  "invalid-collision": "doctor",
  ambiguous: "doctor",
  "detached-no-response": "doctor",
  "manager-unavailable": "doctor",
  absent: "safe-start",
  "not-running": "safe-start",
  "startup-failure": "doctor",
};

const COMMAND_BY_KIND: Readonly<Record<RemediationKind, SanitizedRemediation["command"]>> = {
  restart: "lcm daemon restart",
  doctor: "lcm doctor",
  "safe-start": "lcm daemon start",
};

function messageFor(reason: DaemonRefusalReason, kind: RemediationKind): string {
  const prefix = `lcm daemon unavailable (${reason});`;
  switch (kind) {
    case "restart":
      return `${prefix} run 'lcm daemon restart'.`;
    case "safe-start":
      return `${prefix} run 'lcm daemon start'.`;
    case "doctor":
      // A no-response/refusal is not proof that signalling is safe.  Keep
      // inspection in the guidance and leave any restart to the explicit CLI
      // operation, which owns its own authority checks.
      return `${prefix} run 'lcm daemon restart' or 'lcm doctor'.`;
  }
}

/**
 * Purely map a bounded refusal reason to sanitized operator guidance.
 *
 * This function has no process, filesystem, or lifecycle authority.  In
 * particular, it never suggests kill/pkill or foreground execution.  A
 * caller that has separately proven a clear target may still choose to invoke
 * an explicit restart command, but that proof is intentionally outside this
 * mapping.
 */
export function mapDaemonRefusalToRemediation(
  reason: DaemonRefusalReason,
): SanitizedRemediation {
  // Keep the runtime boundary fail-closed even when JavaScript callers bypass
  // the TypeScript union.  Hook payloads are normalized separately, but this
  // pure mapper is also safe to call directly from CLI/doctor adapters.
  const safeReason = isDaemonRefusalReason(reason) ? reason : "ambiguous";
  const kind = REMEDIATION_KIND_BY_REASON[safeReason];
  return Object.freeze({
    kind,
    action: kind,
    command: COMMAND_BY_KIND[kind],
    message: messageFor(safeReason, kind),
  });
}

/** Return the marker location for one canonical state root. */
export function daemonRemediationMarkerPath(stateRoot: string): string {
  return join(stateRoot, DAEMON_REMEDIATION_MARKER_NAME);
}

/** SHA-256 of the complete scope identity; no truncation is permitted. */
export function daemonScopeDigest(scope: string): string {
  return createHash("sha256").update(scope, "utf8").digest("hex");
}

export type DaemonRemediationFileSystem = Readonly<{
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (
    path: string,
    data: string,
    options: { encoding: BufferEncoding; mode: number; flag: string },
  ) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  mkdirSync: (path: string, options: { recursive: boolean; mode: number }) => void;
  chmodSync: (path: string, mode: number) => void;
}>;

/** @internal Deterministic seam for lock collision and metadata tests. */
export type DaemonRemediationLockOperations = Readonly<{
  lstatSync: typeof lstatSync;
  readBoundedRegularFileWithStat: typeof readBoundedRegularFileWithStat;
  writePrivateFileExclusive: typeof writePrivateFileExclusive;
  deleteRegularFile: typeof deleteRegularFile;
}>;

export type DaemonRemediationClock = Readonly<{ now: () => number }> | (() => number);

const DEFAULT_FILESYSTEM: DaemonRemediationFileSystem = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  renameSync,
  unlinkSync,
  mkdirSync: (path, options) => mkdirSync(path, options),
  chmodSync,
};

const DEFAULT_CLOCK: DaemonRemediationClock = { now: () => Date.now() };
const DEFAULT_LOCK_OPERATIONS: DaemonRemediationLockOperations = {
  lstatSync,
  readBoundedRegularFileWithStat,
  writePrivateFileExclusive,
  deleteRegularFile,
};

type MarkerEntry = Readonly<{
  reason: DaemonRefusalReason;
  lastNotifiedAtMs: number;
}>;

type MarkerDocument = Readonly<{
  version: typeof DAEMON_REMEDIATION_MARKER_VERSION;
  entries: Readonly<Record<string, MarkerEntry>>;
}>;

export type DaemonRemediationInput = Readonly<{
  /** Full canonical scope identity, usually the canonical state-root path. */
  scope: string;
  /** The refusal reason selected by the authoritative lifecycle caller. */
  reason: DaemonRefusalReason;
  /** Canonical state root used to derive the global marker when markerPath is omitted. */
  stateRoot?: string;
  /** Explicit marker path seam for callers/tests that already own the root. */
  markerPath?: string;
  /** Optional precomputed full SHA-256 scope digest. */
  scopeDigest?: string;
  fs?: Partial<DaemonRemediationFileSystem>;
  clock?: DaemonRemediationClock;
  _lockOperationsForTesting?: Partial<DaemonRemediationLockOperations>;
}>;

export type DaemonRemediationDecision = Readonly<{
  emit: boolean;
  remediation: SanitizedRemediation;
  /** Marker status is diagnostic only and never an authority signal. */
  markerStatus: "created" | "suppressed" | "re-emitted" | "reason-changed" | "unavailable";
  markerIoError: boolean;
  scopeDigest: string;
}>;

export type DaemonRemediationClearInput = Readonly<{
  scope: string;
  stateRoot?: string;
  markerPath?: string;
  scopeDigest?: string;
  fs?: Partial<DaemonRemediationFileSystem>;
  _lockOperationsForTesting?: Partial<DaemonRemediationLockOperations>;
}>;

export type DaemonRemediationClearResult = Readonly<{
  cleared: boolean;
  markerIoError: boolean;
}>;

type ReadMarkerResult = Readonly<{
  document: MarkerDocument;
  exists: boolean;
  markerIoError: boolean;
}>;

type RemediationLockOwner = Readonly<{
  version: typeof DAEMON_REMEDIATION_LOCK_VERSION;
  nonce: string;
  createdAtMs: number;
}>;

type RemediationLockRecord = Readonly<{
  content: string;
  owner: RemediationLockOwner;
  mtimeMs: number;
}>;

type RemediationLock = Readonly<{
  path: string;
  content: string;
}>;

function lockOperationsWithDefaults(
  operations: Partial<DaemonRemediationLockOperations> | undefined,
): DaemonRemediationLockOperations {
  return { ...DEFAULT_LOCK_OPERATIONS, ...operations };
}

function filesystemWithDefaults(
  fs: Partial<DaemonRemediationFileSystem> | undefined,
): DaemonRemediationFileSystem {
  return { ...DEFAULT_FILESYSTEM, ...fs };
}

function remediationLockPath(markerPath: string): string {
  return `${markerPath}.lock`;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function waitForRemediationLock(): void {
  Atomics.wait(LOCK_SLEEP_CELL, 0, 0, DAEMON_REMEDIATION_LOCK_RETRY_MS);
}

function parseRemediationLockOwner(raw: string): RemediationLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<RemediationLockOwner>;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 3 || keys.join(",") !== "createdAtMs,nonce,version") return null;
  if (candidate.version !== DAEMON_REMEDIATION_LOCK_VERSION
    || typeof candidate.nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(candidate.nonce)
    || typeof candidate.createdAtMs !== "number"
    || !Number.isFinite(candidate.createdAtMs)
    || candidate.createdAtMs < 0) {
    return null;
  }
  return Object.freeze({
    version: DAEMON_REMEDIATION_LOCK_VERSION,
    nonce: candidate.nonce,
    createdAtMs: candidate.createdAtMs,
  });
}

/**
 * Validate and read the lock through one no-follow, non-blocking descriptor.
 * The lock contains only an opaque nonce and a bounded creation timestamp;
 * paths, scopes, PIDs, and secrets never cross the filesystem boundary.
 */
function readRemediationLock(
  path: string,
  operations: DaemonRemediationLockOperations,
): RemediationLockRecord {
  const descriptor = operations.lstatSync(path);
  if (!descriptor.isFile() || (descriptor.mode & 0o777) !== 0o600) {
    throw new Error("remediation lock is not a private regular file");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && descriptor.uid !== uid) {
    throw new Error("remediation lock owner is not the current user");
  }
  const result = operations.readBoundedRegularFileWithStat(path, {
    maxBytes: DAEMON_REMEDIATION_LOCK_MAX_BYTES,
    allowedRoot: dirname(path),
  });
  if (!Number.isFinite(result.mtimeMs) || result.mtimeMs < 0) {
    throw new Error("remediation lock metadata is invalid");
  }
  const owner = parseRemediationLockOwner(result.content.trim());
  if (owner === null) throw new Error("remediation lock owner is malformed");
  return Object.freeze({ content: result.content, owner, mtimeMs: result.mtimeMs });
}

function lockOwnerContent(now: number): string {
  return `${JSON.stringify({
    version: DAEMON_REMEDIATION_LOCK_VERSION,
    nonce: randomBytes(16).toString("hex"),
    createdAtMs: now,
  })}\n`;
}

function remediationLockIsStale(lock: RemediationLockRecord, now: number): boolean {
  // A rollback (or a lock created in the future) never authorizes reclamation.
  // The owner timestamp is deliberately compared only after the lock has
  // passed descriptor/mode/identity validation above.
  return now >= lock.owner.createdAtMs
    && now - lock.owner.createdAtMs >= DAEMON_REMEDIATION_LOCK_STALE_MS;
}

function releaseRemediationLock(lock: RemediationLock, operations: DaemonRemediationLockOperations): void {
  try {
    const current = readRemediationLock(lock.path, operations);
    if (current.content !== lock.content) return;
    operations.deleteRegularFile(lock.path);
  } catch {
    // A failed or replaced lock is never removed by pathname alone.  Leaving
    // an ambiguous lock in place is fail-safe; its bounded owner timestamp
    // allows a later caller to reclaim it only after stale validation.
  }
}

function acquireRemediationLock(
  markerPath: string,
  now: number,
  operations: DaemonRemediationLockOperations,
): RemediationLock | null {
  const path = remediationLockPath(markerPath);
  const content = lockOwnerContent(now);
  const deadline = performance.now() + DAEMON_REMEDIATION_LOCK_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    try {
      if (operations.writePrivateFileExclusive(path, content)) {
        try {
          if (readRemediationLock(path, operations).content === content) {
            return Object.freeze({ path, content });
          }
        } catch {
          // Do not remove an unverified path.  A later bounded stale check can
          // reclaim a lock only after validating its complete owner record.
        }
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return null;
    }

    let existing: RemediationLockRecord;
    try {
      existing = readRemediationLock(path, operations);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      return null;
    }
    if (remediationLockIsStale(existing, now)) {
      try {
        // Re-read immediately before deletion so cleanup is restricted to the
        // exact owner identity observed by this attempt.
        const current = readRemediationLock(path, operations);
        if (current.content === existing.content && operations.deleteRegularFile(path)) continue;
      } catch (error) {
        if (isMissingPathError(error)) continue;
        return null;
      }
    }
    waitForRemediationLock();
  }
  return null;
}

function markerPathFor(input: { markerPath?: string; stateRoot?: string }): string {
  if (input.markerPath) return input.markerPath;
  if (input.stateRoot) return daemonRemediationMarkerPath(input.stateRoot);
  throw new Error("stateRoot or markerPath is required for daemon remediation marker");
}

function fullDigest(input: Pick<DaemonRemediationInput, "scope" | "scopeDigest">): string {
  if (typeof input.scopeDigest === "string" && /^[a-f0-9]{64}$/u.test(input.scopeDigest)) {
    return input.scopeDigest;
  }
  return daemonScopeDigest(input.scope);
}

function clockNow(clock: DaemonRemediationClock | undefined): number {
  const source = clock ?? DEFAULT_CLOCK;
  const now = typeof source === "function" ? source() : source.now();
  if (!Number.isFinite(now) || now < 0) throw new Error("invalid remediation clock");
  return now;
}

function emptyDocument(): MarkerDocument {
  return Object.freeze({ version: DAEMON_REMEDIATION_MARKER_VERSION, entries: {} });
}

function isMarkerEntry(value: unknown): value is MarkerEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { reason?: unknown; lastNotifiedAtMs?: unknown };
  return isDaemonRefusalReason(candidate.reason)
    && typeof candidate.lastNotifiedAtMs === "number"
    && Number.isFinite(candidate.lastNotifiedAtMs)
    && candidate.lastNotifiedAtMs >= 0;
}

function parseMarker(raw: string): MarkerDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { version?: unknown; entries?: unknown };
  if (candidate.version !== DAEMON_REMEDIATION_MARKER_VERSION
    || typeof candidate.entries !== "object"
    || candidate.entries === null
    || Array.isArray(candidate.entries)) {
    return null;
  }
  const entries: Record<string, MarkerEntry> = {};
  for (const [key, value] of Object.entries(candidate.entries)) {
    // Keys are intentionally opaque to the parser, but bounding them to the
    // full digest + closed reason keeps a malformed marker from growing state
    // without ever echoing marker content to a user.
    const separator = key.lastIndexOf(":");
    const digest = key.slice(0, separator);
    const reason = key.slice(separator + 1);
    if (separator !== 64 || !/^[a-f0-9]{64}$/u.test(digest)
      || !isDaemonRefusalReason(reason) || !isMarkerEntry(value)
      || value.reason !== reason) continue;
    entries[key] = Object.freeze({ reason: value.reason, lastNotifiedAtMs: value.lastNotifiedAtMs });
  }
  return Object.freeze({
    version: DAEMON_REMEDIATION_MARKER_VERSION,
    entries: Object.freeze(entries),
  });
}

function readMarker(path: string, fs: DaemonRemediationFileSystem): ReadMarkerResult {
  try {
    const parsed = parseMarker(fs.readFileSync(path, "utf8"));
    if (!parsed) return { document: emptyDocument(), exists: true, markerIoError: true };
    return { document: parsed, exists: true, markerIoError: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { document: emptyDocument(), exists: false, markerIoError: false };
    }
    return { document: emptyDocument(), exists: true, markerIoError: true };
  }
}

function encodeMarker(document: MarkerDocument): string {
  const entries = Object.fromEntries(
    Object.entries(document.entries).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify({ version: document.version, entries }, null, 2)}\n`;
}

function writeMarker(
  path: string,
  document: MarkerDocument,
  fs: DaemonRemediationFileSystem,
): void {
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let ownsTemporaryPath = false;
  try {
    fs.writeFileSync(temporaryPath, encodeMarker(document), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    ownsTemporaryPath = true;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, path);
    ownsTemporaryPath = false;
    // chmod after replacement protects against an existing broad destination
    // and is harmless when rename preserved the private temp mode.
    fs.chmodSync(path, 0o600);
  } finally {
    if (ownsTemporaryPath) {
      try { fs.unlinkSync(temporaryPath); } catch { /* preserve the write error */ }
    }
  }
}

function keyFor(scopeDigest: string, reason: DaemonRefusalReason): string {
  return `${scopeDigest}:${reason}`;
}

function removeScopeEntries(
  entries: Record<string, MarkerEntry>,
  scopeDigest: string,
): void {
  const prefix = `${scopeDigest}:`;
  for (const key of Object.keys(entries)) {
    if (key.startsWith(prefix)) delete entries[key];
  }
}

function writeOrReport(
  path: string,
  document: MarkerDocument,
  fs: DaemonRemediationFileSystem,
): boolean {
  try {
    writeMarker(path, document, fs);
    return false;
  } catch {
    return true;
  }
}

function unavailableRemediationDecision(
  remediation: SanitizedRemediation,
  scopeDigest: string,
): DaemonRemediationDecision {
  return {
    emit: true,
    remediation,
    markerStatus: "unavailable",
    markerIoError: true,
    scopeDigest,
  };
}

function recordDaemonRemediationUnderLock(
  path: string,
  fs: DaemonRemediationFileSystem,
  scopeDigest: string,
  reason: DaemonRefusalReason,
  remediation: SanitizedRemediation,
  now: number,
): DaemonRemediationDecision {
  const read = readMarker(path, fs);
  if (read.markerIoError) return unavailableRemediationDecision(remediation, scopeDigest);

  const key = keyFor(scopeDigest, reason);
  const prior = read.document.entries[key];
  const changedReason = Object.keys(read.document.entries).some(
    candidate => candidate.startsWith(`${scopeDigest}:`) && candidate !== key,
  );
  const elapsed = prior ? now - prior.lastNotifiedAtMs : Number.POSITIVE_INFINITY;
  const emit = !prior || changedReason || elapsed < 0 || elapsed >= DAEMON_NOTICE_REPEAT_INTERVAL_MS;
  if (!emit) {
    return {
      emit: false,
      remediation,
      markerStatus: "suppressed",
      markerIoError: false,
      scopeDigest,
    };
  }

  const entries = { ...read.document.entries };
  removeScopeEntries(entries, scopeDigest);
  entries[key] = Object.freeze({ reason, lastNotifiedAtMs: now });
  const markerIoError = writeOrReport(
    path,
    { version: DAEMON_REMEDIATION_MARKER_VERSION, entries: Object.freeze(entries) },
    fs,
  );
  return {
    emit: true,
    remediation,
    markerStatus: markerIoError
      ? "unavailable"
      : (changedReason ? "reason-changed" : (prior ? "re-emitted" : "created")),
    markerIoError,
    scopeDigest,
  };
}

/**
 * Decide whether a refusal notice should be emitted and update the
 * non-authoritative marker when possible.
 */
export function recordDaemonRemediation(
  input: DaemonRemediationInput,
): DaemonRemediationDecision {
  const reason = isDaemonRefusalReason(input.reason) ? input.reason : "ambiguous";
  const remediation = mapDaemonRefusalToRemediation(reason);
  const scopeDigest = fullDigest(input);
  const path = markerPathFor(input);
  const fs = filesystemWithDefaults(input.fs);
  const lockOperations = lockOperationsWithDefaults(input._lockOperationsForTesting);
  let now: number;
  try {
    now = clockNow(input.clock);
  } catch {
    return unavailableRemediationDecision(remediation, scopeDigest);
  }
  const lock = acquireRemediationLock(path, now, lockOperations);
  // Lock timeout, stale-owner ambiguity, or any lock I/O failure follows the
  // existing marker-failure contract: emit visibly and report unavailable;
  // never suppress a notice based on untrusted persistence state.
  if (lock === null) return unavailableRemediationDecision(remediation, scopeDigest);
  try {
    return recordDaemonRemediationUnderLock(path, fs, scopeDigest, reason, remediation, now);
  } finally {
    releaseRemediationLock(lock, lockOperations);
  }
}

function clearDaemonRemediationUnderLock(
  path: string,
  fs: DaemonRemediationFileSystem,
  scopeDigest: string,
): DaemonRemediationClearResult {
  const read = readMarker(path, fs);
  if (!read.exists) return { cleared: false, markerIoError: false };
  if (read.markerIoError) {
    // A malformed marker is not authority.  Best effort removal avoids
    // retaining unbounded stale state, but failure is reported to the caller.
    try {
      fs.unlinkSync(path);
      return { cleared: true, markerIoError: false };
    } catch {
      return { cleared: false, markerIoError: true };
    }
  }

  const entries = { ...read.document.entries };
  const before = Object.keys(entries).length;
  removeScopeEntries(entries, scopeDigest);
  if (Object.keys(entries).length === before) {
    return { cleared: false, markerIoError: false };
  }
  try {
    if (Object.keys(entries).length === 0) {
      fs.unlinkSync(path);
    } else {
      writeMarker(
        path,
        { version: DAEMON_REMEDIATION_MARKER_VERSION, entries: Object.freeze(entries) },
        fs,
      );
    }
    return { cleared: true, markerIoError: false };
  } catch {
    return { cleared: false, markerIoError: true };
  }
}

/** Clear refusal entries for one scope after healthy or safe recovery. */
export function clearDaemonRemediation(
  input: DaemonRemediationClearInput,
): DaemonRemediationClearResult {
  let path: string;
  try {
    path = markerPathFor(input);
  } catch {
    return { cleared: false, markerIoError: true };
  }
  const fs = filesystemWithDefaults(input.fs);
  const scopeDigest = fullDigest(input);
  const lockOperations = lockOperationsWithDefaults(input._lockOperationsForTesting);
  const lock = acquireRemediationLock(path, Date.now(), lockOperations);
  if (lock === null) return { cleared: false, markerIoError: true };
  try {
    return clearDaemonRemediationUnderLock(path, fs, scopeDigest);
  } finally {
    releaseRemediationLock(lock, lockOperations);
  }
}

/** Read a marker for diagnostics/tests without exposing raw filesystem errors. */
export function readDaemonRemediationMarker(
  input: Readonly<{
    markerPath?: string;
    stateRoot?: string;
    fs?: Partial<DaemonRemediationFileSystem>;
  }>,
): Readonly<{ exists: boolean; markerIoError: boolean; entries: Readonly<Record<string, Readonly<MarkerEntry>>> }> {
  let path: string;
  try {
    path = markerPathFor(input);
  } catch {
    return { exists: false, markerIoError: true, entries: {} };
  }
  const result = readMarker(path, filesystemWithDefaults(input.fs));
  return {
    exists: result.exists,
    markerIoError: result.markerIoError,
    entries: result.document.entries,
  };
}
