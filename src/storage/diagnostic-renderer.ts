import type { BackendDiagnosticSnapshot } from "./diagnostics.js";
import { QUERY_OPERATION_IDS } from "./postgresql/query-operations.js";
import {
  MIGRATION_HISTORY_STATUSES, TELEMETRY_FIELDS, TELEMETRY_HEALTHS, TELEMETRY_REASONS, TELEMETRY_STATUSES,
  extensionsAction, isRecord, migrationAction, ownValue, pickExtensions, poolAction, poolFacts, queueAction,
  safeCount, safeNumber, type TelemetryFamilyName, type TelemetryHealth,
} from "./runtime-health.js";

const ACTIONS = {
  healthy: "No action required.",
  degraded: "Run `lcm doctor` to recheck backend readiness.",
  unavailable: "Run `lcm doctor` and review the storage configuration.",
  "permission-denied": "Review local file permissions and PostgreSQL runtime grants, then run `lcm doctor`.",
  timeout: "Check backend connectivity, then run `lcm doctor` again.",
  "stale-publication": "Complete backend publication recovery, then run `lcm doctor`.",
};
function choice(value: unknown, choices: readonly string[], fallback = "unverified"): string {
  return typeof value === "string" && choices.includes(value) ? value : fallback;
}
function readiness(value: unknown): string {
  return choice(value, ["ready", "unavailable", "unverified", "not-applicable"]);
}
function count(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "unverified";
}
function figure(value: number | undefined): string {
  return value === undefined ? "unverified" : String(value);
}
function identifier(value: unknown, kind: "uuid" | "hash" | "either"): string {
  if (typeof value !== "string") return "unverified";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const hash = /^[0-9a-f]{64}$/u;
  return ((kind !== "hash" && uuid.test(value)) || (kind !== "uuid" && hash.test(value))) ? value : "unverified";
}
const QUERY_STATUSES = [
  "not-applicable", "disabled", "unavailable", "permission-denied", "timeout",
  "stale", "reset", "partial", "observed",
] as const;

export function renderQueryStatistics(value: unknown): string {
  const family = typeof value === "object" && value !== null
    ? value as { status?: unknown; scope?: unknown; operations?: unknown }
    : {};
  const status = choice(family.status, QUERY_STATUSES, "unavailable");
  if (!Array.isArray(family.operations)) return `Query statistics: ${status}`;
  const catalog = new Set(QUERY_OPERATION_IDS);
  const counted = new Set<string>();
  const withCalls = family.operations.filter((operation) => {
    if (typeof operation !== "object" || operation === null) return false;
    const operationId = (operation as { operation?: unknown }).operation;
    if (typeof operationId !== "string" || !catalog.has(operationId) || counted.has(operationId)) {
      return false;
    }
    const values = (operation as { values?: unknown }).values;
    if (typeof values !== "object" || values === null) return false;
    const calls = (values as { queryCallsTotal?: unknown }).queryCallsTotal;
    if (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 0) return false;
    counted.add(operationId);
    return true;
  }).length;
  return `Query statistics: ${status}; scope: aggregate; operations with call counters: ${withCalls} of ${QUERY_OPERATION_IDS.length}`;
}
interface FamilyView { record: Record<string, unknown>; status: string; health: TelemetryHealth; omitted: string }
/** A family is only as healthy as its closed status allows; anything unrecognized is unavailable. */
function familyView(telemetry: Record<string, unknown>, name: TelemetryFamilyName): FamilyView {
  const raw = ownValue(telemetry, name);
  const record = isRecord(raw) ? raw : {};
  const status = choice(ownValue(record, "status"), TELEMETRY_STATUSES, "unavailable");
  const health = choice(ownValue(record, "health"), TELEMETRY_HEALTHS, "unavailable") as TelemetryHealth;
  const entries = ownValue(record, "omitted");
  // Traversal is bounded by the family's field catalog, not by the source length.
  const omitted = (Array.isArray(entries) ? entries.slice(0, TELEMETRY_FIELDS[name].length) : []).flatMap((entry: unknown) => {
    const field = isRecord(entry) ? ownValue(entry, "field") : undefined;
    const reason = isRecord(entry) ? ownValue(entry, "reason") : undefined;
    return (TELEMETRY_FIELDS[name] as readonly unknown[]).includes(field) && (TELEMETRY_REASONS as readonly unknown[]).includes(reason)
      ? [`${String(field)}=${String(reason)}`] : [];
  });
  return {
    record, status,
    health: health === "healthy" && status !== "observed" ? "unavailable"
      : health === "degraded" && status !== "observed" && status !== "partial" ? "unavailable" : health,
    omitted: omitted.length === 0 ? "none" : omitted.join(", "),
  };
}
function telemetryLines(snapshot: BackendDiagnosticSnapshot): string[] {
  const telemetry = isRecord(snapshot.telemetry) ? snapshot.telemetry : {};
  const lines: string[] = [];
  const header = (name: TelemetryFamilyName, view: FamilyView, detail: string[]): void => {
    lines.push(`Telemetry ${name}: ${view.status}; health: ${view.health}${detail.map(part => `; ${part}`).join("")}; omitted: ${view.omitted}`);
  };
  const pool = familyView(telemetry, "pool");
  if (pool.status === "not-applicable") lines.push("Telemetry pool: not-applicable");
  else {
    header("pool", pool, [`saturation ratio: ${figure(safeNumber(ownValue(pool.record, "saturationRatio")))}`]);
    lines.push(`Telemetry pool action: ${poolAction(pool.health, poolFacts(snapshot.pool))}`);
  }
  const migration = familyView(telemetry, "migration");
  if (migration.status === "not-applicable") lines.push("Telemetry migration: not-applicable");
  else {
    const history = choice(ownValue(migration.record, "historyStatus"), MIGRATION_HISTORY_STATUSES, "unavailable");
    header("migration", migration, [
      `history: ${history}`, `applied: ${figure(safeCount(ownValue(migration.record, "appliedCount")))}`,
      `expected: ${figure(safeCount(ownValue(migration.record, "expectedCount")))}`,
    ]);
    lines.push(`Telemetry migration action: ${migrationAction(migration.health, history)}`);
  }
  const extensions = familyView(telemetry, "extensions");
  if (extensions.status === "not-applicable") lines.push("Telemetry extensions: not-applicable");
  else {
    const { entries } = pickExtensions(ownValue(extensions.record, "entries"));
    header("extensions", extensions, [entries.length === 0 ? "entries: none" : entries.map(
      entry => `${entry.name}: ${entry.status} (installed ${entry.installedVersion}, default ${entry.defaultVersion})`,
    ).join("; ")]);
    lines.push(`Telemetry extensions action: ${extensionsAction(extensions.health)}`);
  }
  const queue = familyView(telemetry, "queue");
  if (queue.status === "not-applicable") lines.push("Telemetry queue: not-applicable");
  else {
    const facts = {
      outboxOldestPendingAgeSeconds: safeNumber(ownValue(queue.record, "outboxOldestPendingAgeSeconds")),
      inboxClaimed: safeCount(ownValue(queue.record, "inboxClaimed")),
      inboxQuarantined: safeCount(ownValue(queue.record, "inboxQuarantined")),
      replayLagSeconds: safeNumber(ownValue(queue.record, "replayLagSeconds")),
    };
    header("queue", queue, [
      `outbox oldest pending age seconds: ${figure(facts.outboxOldestPendingAgeSeconds)}`,
      `inbox claimed: ${figure(facts.inboxClaimed)}`, `inbox quarantined: ${figure(facts.inboxQuarantined)}`,
      `replay lag seconds: ${figure(facts.replayLagSeconds)}`,
    ]);
    const outbox = snapshot.outbox;
    const localQuarantined = outbox.status === "ready" ? safeCount(outbox.deliveryQuarantined) : undefined;
    lines.push(`Telemetry queue action: ${queueAction(queue.health, { ...facts, localQuarantined })}`);
  }
  return lines;
}
/** Text boundary: fixed labels/actions, closed enums, safe counts and identifiers only. */
export function renderBackendDiagnostics(snapshot: BackendDiagnosticSnapshot): string {
  const classification = choice(snapshot.classification, Object.keys(ACTIONS), "unavailable") as keyof typeof ACTIONS;
  const pool = snapshot.pool;
  const project = snapshot.project;
  const outbox = snapshot.outbox;
  return [
    `Storage backend: ${choice(snapshot.backend, ["sqlite", "postgresql", "unavailable"], "unavailable")}`,
    `Classification: ${classification}`,
    `Publication: ${readiness(snapshot.publication)}`,
    `TLS: ${readiness(snapshot.tls)}`,
    `Schema: ${readiness(snapshot.schema)}`,
    `Extensions: ${readiness(snapshot.extensions)}`,
    `Search: ${readiness(snapshot.search)}`,
    `Pool: ${readiness(pool.status)}; origin: ${choice(pool.origin, ["daemon", "diagnostic-probe", "local"])}`,
    `Pool counts: configured max: ${count(pool.configuredMax)}; total: ${count(pool.total)}; idle: ${count(pool.idle)}; waiting: ${count(pool.waiting)}; failed: ${typeof pool.failed === "boolean" ? String(pool.failed) : "unverified"}`,
    `Project: ${choice(project.scope, ["aggregate", "selected"])}; ${readiness(project.status)}`,
    `Project ID: ${identifier(project.projectId, "either")}; local hash: ${identifier(project.localProjectId, "hash")}`,
    `Machine identity: ${readiness(snapshot.identity.status)}; ID: ${identifier(snapshot.identity.machineId, "uuid")}`,
    `Outbox: ${readiness(outbox.status)}`,
    `Outbox counts: captured: ${count(outbox.captured)}; unprocessed: ${count(outbox.unprocessed)}; errors: ${count(outbox.errors)}`,
    `Outbox delivery: pending: ${count(outbox.deliveryPending)}; claimed: ${count(outbox.deliveryClaimed)}; retry: ${count(outbox.deliveryRetry)}; replicated: ${count(outbox.deliveryReplicated)}; acknowledged: ${count(outbox.deliveryAcknowledged)}; awaiting remote prune: ${count(outbox.deliveryAwaitingRemotePrune)}; quarantined: ${count(outbox.deliveryQuarantined)}`,
    renderQueryStatistics(snapshot.telemetry?.statements),
    ...telemetryLines(snapshot),
    `Action: ${ACTIONS[classification]}`,
  ].join("\n");
}
