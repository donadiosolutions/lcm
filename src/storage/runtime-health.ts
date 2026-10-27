import type { PostgreSqlExtensionReadiness } from "./postgresql/contracts.js";
import type { PostgreSqlDiagnosticPoolRejection } from "./postgresql/errors.js";

/** Closed observation statuses shared by every telemetry family. */
export const TELEMETRY_STATUSES = [
  "not-applicable", "disabled", "unavailable", "permission-denied", "timeout", "stale", "reset", "partial", "observed",
] as const;
export const TELEMETRY_HEALTHS = ["healthy", "degraded", "unavailable"] as const;
export const TELEMETRY_REASONS = [
  "unavailable", "timeout", "permission-denied", "out-of-range", "reset", "disabled-setting", "no-entry", "no-baseline",
  "invalid-input", "limit-reached",
] as const;
export const TELEMETRY_FIELDS = {
  pool: ["saturationRatio"],
  migration: ["appliedCount", "expectedCount"],
  extensions: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"],
  queue: ["outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"],
} as const;
export const MIGRATION_HISTORY_STATUSES = ["current", "behind", "ahead", "drift", "checksum-mismatch", "unavailable"] as const;
export const EXTENSION_READINESS = [
  "current", "installed-unavailable", "not-preloaded", "unavailable", "uninstalled", "version-mismatch", "wrong-namespace",
] as const satisfies readonly PostgreSqlExtensionReadiness[];
/** Candidate rows admitted to the server queue aggregate. One extra row is a sentinel. */
export const QUEUE_CANDIDATE_LIMIT = 4096;
/** Pending age and replay lag above this many seconds are an advisory backlog. */
export const QUEUE_BACKLOG_SECONDS = 900;
/** Minimum remaining snapshot time required to launch a new telemetry probe. */
export const PROBE_MIN_REMAINING_MS = 100;

export type TelemetryStatus = (typeof TELEMETRY_STATUSES)[number];
export type TelemetryHealth = (typeof TELEMETRY_HEALTHS)[number];
export type TelemetryReason = (typeof TELEMETRY_REASONS)[number];
export type TelemetryFamilyName = keyof typeof TELEMETRY_FIELDS;
export type MigrationHistoryStatus = (typeof MIGRATION_HISTORY_STATUSES)[number];
export type TelemetryFailureStatus = "unavailable" | "permission-denied" | "timeout";
export interface TelemetryOmission { field: string; reason: TelemetryReason }
export interface NotApplicableTelemetry { status: "not-applicable"; observedAt: number; omitted: TelemetryOmission[] }
interface ApplicableTelemetry {
  status: Exclude<TelemetryStatus, "not-applicable">;
  observedAt: number;
  health: TelemetryHealth;
  omitted: TelemetryOmission[];
  remediation: string;
}
export type PoolTelemetry = NotApplicableTelemetry | (ApplicableTelemetry & { saturationRatio?: number });
export type MigrationTelemetry = NotApplicableTelemetry | (ApplicableTelemetry & {
  historyStatus: MigrationHistoryStatus; appliedCount?: number; expectedCount?: number;
});
export interface ExtensionTelemetryEntry {
  name: (typeof TELEMETRY_FIELDS.extensions)[number];
  status: PostgreSqlExtensionReadiness;
  installedVersion: string;
  defaultVersion: string;
}
export type ExtensionsTelemetry = NotApplicableTelemetry | (ApplicableTelemetry & { entries: ExtensionTelemetryEntry[] });
export type QueueTelemetry = NotApplicableTelemetry | (ApplicableTelemetry & {
  outboxOldestPendingAgeSeconds?: number; inboxClaimed?: number; inboxQuarantined?: number; replayLagSeconds?: number;
});
export interface BackendDiagnosticTelemetry {
  pool: PoolTelemetry;
  migration: MigrationTelemetry;
  extensions: ExtensionsTelemetry;
  queue: QueueTelemetry;
}

/** Fixed guidance. The collector and the renderer select from this one table. */
export const RUNTIME_HEALTH_ACTIONS = {
  healthy: "No action required.",
  unavailable: "Run `lcm doctor` and review the storage configuration.",
  poolFailed: "Check backend connectivity, then run `lcm doctor` again.",
  poolSaturated: "Reduce concurrent database load or raise `storage.postgresql.poolMax`, then run `lcm doctor`.",
  migrationBehind: "Run `lcm postgres migrate` with the migration role, then run `lcm doctor`.",
  migrationAhead: "Upgrade LCM to a release that includes every applied migration, then run `lcm doctor`.",
  migrationDrift: "Restore the packaged PostgreSQL schema history; never edit applied migrations.",
  extensions: "Have a database administrator install or update the required PostgreSQL extensions and verify their schema and preload configuration, then run `lcm doctor`.",
  quarantine: "Inspect with `lcm events quarantine` and replay with `lcm events replay <event-id>`.",
  backlog: "Check daemon delivery with `lcm events status`, then run `lcm doctor`.",
} as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
/** An exact non-negative safe integer, or undefined. */
export function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** A finite non-negative number, or undefined. */
export function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function above(value: number | undefined, limit: number): boolean {
  return value !== undefined && value > limit;
}

/** Closed failure status for a snapshot classification. */
export function telemetryFailureStatus(classification: string): TelemetryFailureStatus {
  return classification === "permission-denied" || classification === "timeout" ? classification : "unavailable";
}

// ---- Status and health -----------------------------------------------------

const LOWERING_REASONS: readonly TelemetryReason[] = [
  "unavailable", "timeout", "permission-denied", "out-of-range", "invalid-input", "limit-reached",
];
const FAILURE_PRIORITY: readonly TelemetryFailureStatus[] = ["permission-denied", "timeout", "unavailable"];
type ObservedStatus = Exclude<TelemetryStatus, "not-applicable">;
/** Family-wide status from the omissions and the number of usable observations. */
function deriveStatus(omitted: readonly TelemetryOmission[], usable: number): ObservedStatus {
  const lowering = omitted.filter(entry => LOWERING_REASONS.includes(entry.reason));
  if (lowering.length === 0) return "observed";
  if (usable > 0) return "partial";
  return FAILURE_PRIORITY.find(status => lowering.some(entry => entry.reason === status)) ?? "unavailable";
}
function deriveHealth(status: ObservedStatus, degraded: boolean): TelemetryHealth {
  if (degraded) return "degraded";
  return status === "observed" ? "healthy" : "unavailable";
}
function selectAction(health: TelemetryHealth, degradedAction: string): string {
  if (health === "healthy") return RUNTIME_HEALTH_ACTIONS.healthy;
  return health === "degraded" ? degradedAction : RUNTIME_HEALTH_ACTIONS.unavailable;
}

// ---- Fillers and failures ---------------------------------------------------

function failureFamily(name: TelemetryFamilyName, status: TelemetryFailureStatus, observedAt: number): ApplicableTelemetry {
  return {
    status, observedAt, health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable,
    omitted: TELEMETRY_FIELDS[name].map(field => ({ field, reason: status })),
  };
}
function notApplicable(observedAt: number): NotApplicableTelemetry {
  return { status: "not-applicable", observedAt, omitted: [] };
}
/** Fillers for every family: SQLite never reports PostgreSQL telemetry as observed or failed. */
export function telemetryFillers(
  backend: "sqlite" | "postgresql" | "unavailable", status: TelemetryFailureStatus, observedAt: number,
): BackendDiagnosticTelemetry {
  if (backend === "sqlite") {
    return { pool: notApplicable(observedAt), migration: notApplicable(observedAt), extensions: notApplicable(observedAt), queue: notApplicable(observedAt) };
  }
  return {
    pool: failureFamily("pool", status, observedAt),
    migration: { ...failureFamily("migration", status, observedAt), historyStatus: "unavailable" },
    extensions: { ...failureFamily("extensions", status, observedAt), entries: [] },
    queue: failureFamily("queue", status, observedAt),
  };
}
/** Replaces only the families that did not finish, leaving finished observations intact. */
export function failUnfinishedTelemetry(
  telemetry: BackendDiagnosticTelemetry, finished: ReadonlySet<TelemetryFamilyName>,
  status: TelemetryFailureStatus, observedAt: number,
): BackendDiagnosticTelemetry {
  const fillers = telemetryFillers("postgresql", status, observedAt);
  return {
    pool: finished.has("pool") ? telemetry.pool : fillers.pool,
    migration: finished.has("migration") ? telemetry.migration : fillers.migration,
    extensions: finished.has("extensions") ? telemetry.extensions : fillers.extensions,
    queue: finished.has("queue") ? telemetry.queue : fillers.queue,
  };
}
/** A degraded family may only raise a healthy classification to degraded. */
export function telemetryDegraded(telemetry: BackendDiagnosticTelemetry): boolean {
  return [telemetry.pool, telemetry.migration, telemetry.extensions, telemetry.queue]
    .some(family => family.status !== "not-applicable" && family.health === "degraded");
}

// ---- Pool ---------------------------------------------------------------------

export interface PoolFacts { origin: string; configuredMax: number; total: number; idle: number; waiting: number; failed: boolean }
/** Validated pool counters, or undefined when the pool was not verified. */
export function poolFacts(pool: unknown): PoolFacts | undefined {
  if (!isRecord(pool) || ownValue(pool, "status") !== "ready") return undefined;
  const counts = ["configuredMax", "total", "idle", "waiting"].map(key => safeCount(ownValue(pool, key)));
  if (counts.some(count => count === undefined)) return undefined;
  const [configuredMax, total, idle, waiting] = counts as number[];
  return { origin: String(ownValue(pool, "origin")), configuredMax, total, idle, waiting, failed: ownValue(pool, "failed") === true };
}
/** Busy connections over the configured maximum; undefined when the relationship is invalid. */
export function poolSaturationRatio(facts: PoolFacts): number | undefined {
  return facts.configuredMax > 0 && facts.idle <= facts.total ? (facts.total - facts.idle) / facts.configuredMax : undefined;
}
function poolEvidence(facts: PoolFacts): { failed: boolean; saturated: boolean } {
  const ratio = poolSaturationRatio(facts);
  return { failed: facts.failed, saturated: facts.origin === "daemon" && ratio !== undefined && ratio >= 1 && facts.waiting > 0 };
}
export function poolAction(health: TelemetryHealth, facts: PoolFacts | undefined): string {
  const evidence = facts === undefined ? undefined : poolEvidence(facts);
  const action = evidence?.failed === true ? RUNTIME_HEALTH_ACTIONS.poolFailed
    : evidence?.saturated === true ? RUNTIME_HEALTH_ACTIONS.poolSaturated : RUNTIME_HEALTH_ACTIONS.unavailable;
  return selectAction(health, action);
}
/** rejection is the closed reason the pool observation boundary refused the counters, if it did. */
export function poolTelemetry(pool: unknown, observedAt: number, rejection?: PostgreSqlDiagnosticPoolRejection): PoolTelemetry {
  const facts = poolFacts(pool);
  if (facts === undefined) {
    if (rejection !== "out-of-range") return failureFamily("pool", "unavailable", observedAt);
    const omitted: TelemetryOmission[] = [{ field: "saturationRatio", reason: "out-of-range" }];
    return { status: deriveStatus(omitted, 1), observedAt, health: "unavailable", omitted, remediation: RUNTIME_HEALTH_ACTIONS.unavailable };
  }
  const ratio = poolSaturationRatio(facts);
  const omitted: TelemetryOmission[] = ratio === undefined ? [{ field: "saturationRatio", reason: "invalid-input" }] : [];
  const evidence = poolEvidence(facts);
  const status = deriveStatus(omitted, 1);
  const health = deriveHealth(status, evidence.failed || evidence.saturated);
  return {
    status, observedAt, health, omitted, remediation: poolAction(health, facts),
    ...(ratio === undefined ? {} : { saturationRatio: ratio }),
  };
}

// ---- Migration ----------------------------------------------------------------

export interface MigrationLedgerRead {
  expected: readonly { id: string; sha256: string }[];
  /** Rows of an ordered ledger read capped at one more than the expected count. */
  rows: readonly unknown[];
}
function ledgerEntries(rows: readonly unknown[]): { id: string; checksum: string }[] | undefined {
  const entries: { id: string; checksum: string }[] = [];
  for (const row of rows) {
    const id = isRecord(row) ? ownValue(row, "id") : undefined;
    const checksum = isRecord(row) ? ownValue(row, "checksum_sha256") : undefined;
    if (typeof id !== "string" || typeof checksum !== "string") return undefined;
    entries.push({ id, checksum });
  }
  return entries;
}
export function migrationAction(health: TelemetryHealth, historyStatus: unknown): string {
  const action = historyStatus === "behind" ? RUNTIME_HEALTH_ACTIONS.migrationBehind
    : historyStatus === "ahead" ? RUNTIME_HEALTH_ACTIONS.migrationAhead
    : historyStatus === "drift" || historyStatus === "checksum-mismatch" ? RUNTIME_HEALTH_ACTIONS.migrationDrift
    : RUNTIME_HEALTH_ACTIONS.unavailable;
  return selectAction(health, action);
}
export function migrationTelemetry(read: MigrationLedgerRead, observedAt: number): MigrationTelemetry {
  const expectedCount = read.expected.length;
  const entries = ledgerEntries(read.rows.slice(0, expectedCount + 1));
  if (entries === undefined) {
    return {
      status: "unavailable", observedAt, health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable,
      historyStatus: "unavailable", expectedCount, omitted: [{ field: "appliedCount", reason: "unavailable" }],
    };
  }
  const compared = entries.slice(0, expectedCount);
  const drift = compared.some((entry, index) => entry.id !== read.expected[index]!.id);
  const mismatch = compared.some((entry, index) => entry.checksum !== read.expected[index]!.sha256);
  const capReached = entries.length > expectedCount;
  const historyStatus: MigrationHistoryStatus = drift ? "drift" : mismatch ? "checksum-mismatch"
    : capReached ? "ahead" : entries.length < expectedCount ? "behind" : "current";
  const omitted: TelemetryOmission[] = capReached ? [{ field: "appliedCount", reason: "limit-reached" }] : [];
  const status = deriveStatus(omitted, 1);
  const health = deriveHealth(status, historyStatus !== "current");
  return {
    status, observedAt, health, omitted, historyStatus, expectedCount,
    remediation: migrationAction(health, historyStatus),
    ...(capReached ? {} : { appliedCount: entries.length }),
  };
}

// ---- Extensions ------------------------------------------------------------------

const EXTENSION_VERSION = /^[0-9]+(\.[0-9]+){0,2}$/u;
/** A bounded number of candidate records is inspected, however long the source array is. */
const MAX_EXTENSION_CANDIDATES = 16;
export function extensionVersion(value: unknown): string {
  return typeof value === "string" && EXTENSION_VERSION.test(value) ? value : "unrecognized";
}
export function extensionsAction(health: TelemetryHealth): string {
  return selectAction(health, RUNTIME_HEALTH_ACTIONS.extensions);
}
/** Re-validates extension records from any source into at most one entry per fixed name. */
export function pickExtensions(source: unknown): { entries: ExtensionTelemetryEntry[]; omitted: TelemetryOmission[] } {
  const candidates = Array.isArray(source) ? source.slice(0, MAX_EXTENSION_CANDIDATES) : [];
  const entries: ExtensionTelemetryEntry[] = [];
  const omitted: TelemetryOmission[] = [];
  for (const name of TELEMETRY_FIELDS.extensions) {
    const matches = candidates.filter(candidate => isRecord(candidate) && ownValue(candidate, "name") === name);
    const match = matches.length === 1 ? matches[0] as Record<string, unknown> : undefined;
    const status = match === undefined ? undefined : ownValue(match, "status");
    if (match === undefined || !EXTENSION_READINESS.includes(status as PostgreSqlExtensionReadiness)) {
      omitted.push({ field: name, reason: "unavailable" });
    } else {
      entries.push({
        name, status: status as PostgreSqlExtensionReadiness,
        installedVersion: extensionVersion(ownValue(match, "installedVersion")),
        defaultVersion: extensionVersion(ownValue(match, "defaultVersion")),
      });
    }
  }
  return { entries, omitted };
}
export function extensionsTelemetry(source: unknown, observedAt: number): ExtensionsTelemetry {
  const { entries, omitted } = pickExtensions(source);
  const status = deriveStatus(omitted, entries.length);
  const health = deriveHealth(status, entries.some(entry => entry.status !== "current"));
  return { status, observedAt, health, omitted, entries, remediation: extensionsAction(health) };
}

// ---- Queue -----------------------------------------------------------------------

export type FieldRead = { value: number } | { reason: TelemetryReason };
export interface ServerQueueRead { capReached: boolean; claimed: unknown; quarantined: unknown; lagSeconds: unknown }
export interface QueueReads {
  inboxClaimed: FieldRead; inboxQuarantined: FieldRead; replayLagSeconds: FieldRead; outboxOldestPendingAgeSeconds: FieldRead;
}
const EXACT_COUNT = /^[0-9]+$/u;
const NON_NEGATIVE_DECIMAL = /^[0-9]+(\.[0-9]+)?$/u;
function exactCountRead(value: unknown): FieldRead {
  const parsed = typeof value === "string" && EXACT_COUNT.test(value) ? safeCount(Number(value)) : undefined;
  return parsed === undefined ? { reason: "out-of-range" } : { value: parsed };
}
function secondsRead(value: unknown): FieldRead {
  if (value === null) return { reason: "no-entry" };
  const parsed = typeof value === "string" && NON_NEGATIVE_DECIMAL.test(value) ? safeNumber(Number(value)) : undefined;
  return parsed === undefined ? { reason: "out-of-range" } : { value: parsed };
}
/** Server fields; a reached cap never publishes an incomplete total. */
export function serverQueueReads(read: ServerQueueRead): Pick<QueueReads, "inboxClaimed" | "inboxQuarantined" | "replayLagSeconds"> {
  if (read.capReached) {
    const capped: FieldRead = { reason: "limit-reached" };
    return { inboxClaimed: capped, inboxQuarantined: capped, replayLagSeconds: capped };
  }
  return { inboxClaimed: exactCountRead(read.claimed), inboxQuarantined: exactCountRead(read.quarantined), replayLagSeconds: secondsRead(read.lagSeconds) };
}
export function failedServerQueueReads(status: TelemetryFailureStatus): Pick<QueueReads, "inboxClaimed" | "inboxQuarantined" | "replayLagSeconds"> {
  const failed: FieldRead = { reason: status };
  return { inboxClaimed: failed, inboxQuarantined: failed, replayLagSeconds: failed };
}
const SQLITE_UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/u;
/**
 * Epoch milliseconds of a strictly formatted, calendar-valid SQLite UTC
 * timestamp; undefined for anything else. Epoch zero is a valid result.
 */
export function sqliteUtcMs(value: unknown): number | undefined {
  const match = typeof value === "string" ? SQLITE_UTC.exec(value) : null;
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const exact = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return exact ? date.getTime() : undefined;
}
/**
 * Age in whole seconds of a SQLite UTC timestamp. Undefined means the source
 * was not read, null means a complete read found no qualifying row.
 */
export function localPendingAgeRead(value: unknown, nowMs: number): FieldRead {
  if (value === undefined) return { reason: "unavailable" };
  if (value === null) return { reason: "no-entry" };
  const ms = sqliteUtcMs(value);
  if (ms === undefined) return { reason: "out-of-range" };
  const elapsed = nowMs - ms;
  return elapsed >= 0 ? { value: Math.floor(elapsed / 1000) } : { reason: "out-of-range" };
}
export interface QueueFacts {
  inboxQuarantined?: number; localQuarantined?: number; outboxOldestPendingAgeSeconds?: number; replayLagSeconds?: number;
}
function queueEvidence(facts: QueueFacts): { quarantined: boolean; backlog: boolean } {
  return {
    quarantined: above(facts.inboxQuarantined, 0) || above(facts.localQuarantined, 0),
    backlog: above(facts.outboxOldestPendingAgeSeconds, QUEUE_BACKLOG_SECONDS) || above(facts.replayLagSeconds, QUEUE_BACKLOG_SECONDS),
  };
}
export function queueAction(health: TelemetryHealth, facts: QueueFacts): string {
  const evidence = queueEvidence(facts);
  return selectAction(health, evidence.quarantined ? RUNTIME_HEALTH_ACTIONS.quarantine
    : evidence.backlog ? RUNTIME_HEALTH_ACTIONS.backlog : RUNTIME_HEALTH_ACTIONS.unavailable);
}
/**
 * localQuarantined is the ready local outbox quarantine count, when that outbox was verified. It is
 * usable evidence, and an observed cap sentinel is a partial observation even when no value is usable.
 */
export function queueTelemetry(reads: QueueReads, localQuarantined: number | undefined, observedAt: number): QueueTelemetry {
  const values: Partial<Record<keyof QueueReads, number>> = {};
  const omitted: TelemetryOmission[] = [];
  for (const field of TELEMETRY_FIELDS.queue) {
    const read = reads[field];
    if ("value" in read) values[field] = read.value;
    else omitted.push({ field, reason: read.reason });
  }
  const usable = Object.keys(values).length + omitted.filter(entry => entry.reason === "no-entry").length
    + (localQuarantined === undefined ? 0 : 1) + (omitted.some(entry => entry.reason === "limit-reached") ? 1 : 0);
  const status = deriveStatus(omitted, usable);
  const facts: QueueFacts = { ...values, localQuarantined };
  const evidence = queueEvidence(facts);
  const health = deriveHealth(status, evidence.quarantined || evidence.backlog);
  return { status, observedAt, health, omitted, ...values, remediation: queueAction(health, facts) };
}
