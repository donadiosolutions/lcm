import type { BackendDiagnosticSnapshot } from "./diagnostics.js";

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
function identifier(value: unknown, kind: "uuid" | "hash" | "either"): string {
  if (typeof value !== "string") return "unverified";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const hash = /^[0-9a-f]{64}$/u;
  return ((kind !== "hash" && uuid.test(value)) || (kind !== "uuid" && hash.test(value))) ? value : "unverified";
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
    `Action: ${ACTIONS[classification]}`,
  ].join("\n");
}
