import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The marker is deliberately a small, non-authoritative hint.  Lifecycle
 * decisions must never depend on its presence, contents, or write result.
 */
export const DAEMON_REMEDIATION_MARKER_VERSION = 1 as const;
export const DAEMON_REMEDIATION_MARKER_NAME = "daemon-remediation.v1.json";
export const DAEMON_NOTICE_REPEAT_INTERVAL_MS = 30 * 60 * 1_000;

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

function filesystemWithDefaults(
  fs: Partial<DaemonRemediationFileSystem> | undefined,
): DaemonRemediationFileSystem {
  return { ...DEFAULT_FILESYSTEM, ...fs };
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
  let now: number;
  try {
    now = clockNow(input.clock);
  } catch {
    return {
      emit: true,
      remediation,
      markerStatus: "unavailable",
      markerIoError: true,
      scopeDigest,
    };
  }

  const read = readMarker(path, fs);
  if (read.markerIoError) {
    return {
      emit: true,
      remediation,
      markerStatus: "unavailable",
      markerIoError: true,
      scopeDigest,
    };
  }

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
