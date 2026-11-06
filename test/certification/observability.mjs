import { CANARY_CORPUS } from "./canary-corpus.mjs";
import { createHash } from "node:crypto";

export { CANARY_CORPUS } from "./canary-corpus.mjs";

const TELEMETRY_STATUSES = new Set([
  "not-applicable", "disabled", "unavailable", "permission-denied", "timeout",
  "stale", "reset", "partial", "observed",
]);
const TELEMETRY_HEALTHS = new Set(["healthy", "degraded", "unavailable"]);
const TELEMETRY_REASONS = new Set([
  "unavailable", "timeout", "permission-denied", "out-of-range", "reset",
  "disabled-setting", "no-entry", "no-baseline", "invalid-input", "limit-reached",
]);
const METRIC_KEYS = new Set([
  "queryCallsTotal", "queryRowsTotal", "queryExecTimeTotalMs", "queryExecTimeMinMs",
  "queryExecTimeMaxMs", "queryExecTimeMeanMs", "queryExecTimeStddevMs",
  "queryPlanTimeTotalMs", "querySharedBlksHitTotal", "querySharedBlksReadTotal",
  "querySharedBlksDirtiedTotal", "querySharedBlksWrittenTotal", "queryLocalBlksHitTotal",
  "queryLocalBlksReadTotal", "queryLocalBlksDirtiedTotal", "queryLocalBlksWrittenTotal",
  "queryTempBlksReadTotal", "queryTempBlksWrittenTotal", "querySharedBlkReadTimeMs",
  "querySharedBlkWriteTimeMs", "queryWalRecordsTotal", "queryWalBytesTotal",
]);
const EXTENSION_NAMES = new Set(["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"]);
const MIGRATION_HISTORY_STATUSES = new Set(["current", "behind", "ahead", "drift", "checksum-mismatch", "unavailable"]);
const EXTENSION_READINESS = new Set(["current", "installed-unavailable", "not-preloaded", "unavailable", "uninstalled", "version-mismatch", "wrong-namespace"]);
const FAILURE_STATUSES = new Set(["unavailable", "permission-denied", "timeout"]);
const TELEMETRY_VALUE_FIELDS = Object.freeze({
  pool: new Set(["saturationRatio"]),
  migration: new Set(["appliedCount", "expectedCount"]),
  extensions: EXTENSION_NAMES,
  queue: new Set(["outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"]),
});

export const OBSERVABILITY_ACTIONS = Object.freeze({
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
});

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function encodedScanForms(value, prefixLength = 24) {
  const forms = unique([
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("hex"),
  ]);
  return unique([...forms, ...forms.filter((form) => form.length >= prefixLength).map((form) => form.slice(0, prefixLength))]);
}

const INVENTORY_FIELDS = Object.freeze([
  ["runtime-url", "runtimeUrl", "runtime-config"],
  ["runtime-password", "runtimePassword", "runtime-url"],
  ["runtime-role", "runtimeRole", "runtime-url"],
  ["migration-role", "migrationRole", "runtime-config"],
  ["database-name", "databaseName", "runtime-url"],
  ["database-host", "databaseHost", "runtime-url"],
  ["database-address", "databaseAddress", "resolved-network"],
  ["ca-pem", "caPem", "ca-file"],
  ["ca-file", "caFile", "runtime-config"],
  ["daemon-token", "daemonToken", "daemon-token-file"],
  ["project-path", "projectPath", "agent-runtime"],
  ["home-path", "homePath", "agent-runtime"],
  ["container-hostname", "containerHostname", "agent-runtime"],
]);
export const REQUIRED_MACHINE_INVENTORY_CATEGORIES = Object.freeze(INVENTORY_FIELDS.map(([category]) => category));

export function buildSecretInventory(values) {
  const entries = [];
  for (const [category, key, sourceClass] of INVENTORY_FIELDS) {
    const value = values?.[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`missing secret inventory category ${category}`);
    entries.push({ category, value, sourceClass, scanMode: value.length >= 8 ? "all-forms" : "boundary-token" });
  }
  if (!Array.isArray(values.caBodyLines) || values.caBodyLines.length === 0) {
    throw new Error("missing secret inventory category ca-body-line");
  }
  for (const [index, value] of values.caBodyLines.entries()) {
    if (typeof value !== "string" || value.length === 0) throw new Error("missing secret inventory category ca-body-line");
    entries.push({ category: `ca-body-line-${index}`, value, sourceClass: "ca-file", scanMode: value.length >= 8 ? "all-forms" : "boundary-token" });
  }
  return entries;
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createInventoryManifest(inventory, owner) {
  const caPem = inventory.find((entry) => entry.category === "ca-pem")?.value;
  const caEntries = inventory.filter((entry) => entry.category.startsWith("ca-body-line-")).map((entry) => entry.value);
  let caBody;
  if (caPem !== undefined) {
    const expected = caPem.split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("-----"));
    if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(caEntries)) {
      throw new Error("secret inventory CA body lines are incomplete");
    }
    caBody = { count: expected.length, sha256: digest(Buffer.from(expected.join("\n"), "utf8")) };
  }
  return {
    owner,
    ...(caBody === undefined ? {} : { caBody }),
    entries: inventory.map((entry) => ({
      category: entry.category,
      sourceClass: entry.sourceClass,
      scanMode: entry.scanMode,
      forms: (entry.scanMode === "boundary-token" ? [entry.value] : encodedScanForms(entry.value))
        .map((form) => ({ bytes: Buffer.byteLength(form), sha256: digest(Buffer.from(form, "utf8")) })),
    })),
  };
}

export function scanHashedInventory(bytes, manifests) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const targets = new Map();
  for (const manifest of manifests) for (const entry of manifest.entries ?? []) for (const form of entry.forms ?? []) {
    if (!targets.has(form.bytes)) targets.set(form.bytes, new Set());
    targets.get(form.bytes).add(form.sha256);
  }
  let hits = 0;
  for (const [length, hashes] of targets) {
    if (!Number.isSafeInteger(length) || length <= 0 || length > buffer.length) continue;
    for (let offset = 0; offset <= buffer.length - length; offset += 1) {
      if (hashes.has(digest(buffer.subarray(offset, offset + length)))) hits += 1;
    }
  }
  return { bytes: buffer.length, hits };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function boundaryHit(text, value) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(value)}(?:$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

export function scanSurface(bytes, inventory = [], canaries = CANARY_CORPUS) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const text = buffer.toString("utf8");
  const categoryHits = {};
  let secretHits = 0;
  for (const entry of inventory) {
    const forms = entry.scanMode === "boundary-token" ? [entry.value] : encodedScanForms(entry.value);
    const hits = forms.reduce((count, form) => count + (entry.scanMode === "boundary-token"
      ? Number(boundaryHit(text, form)) : Number(buffer.indexOf(Buffer.from(form, "utf8")) >= 0)), 0);
    categoryHits[entry.category] = hits;
    secretHits += hits;
  }
  let canaryHits = 0;
  for (const canary of canaries) {
    for (const form of encodedScanForms(canary)) canaryHits += Number(buffer.indexOf(Buffer.from(form, "utf8")) >= 0);
  }
  return { bytes: buffer.length, categoryHits, secretHits, canaryHits };
}

const FAMILY_KEYS = Object.freeze({
  statements: new Set(["status", "observedAt", "scope", "statementsDeallocTotal", "statementsStatsReset", "blockSize", "omitted", "operations"]),
  pool: new Set(["status", "observedAt", "health", "omitted", "remediation", "saturationRatio"]),
  migration: new Set(["status", "observedAt", "health", "omitted", "remediation", "historyStatus", "appliedCount", "expectedCount"]),
  extensions: new Set(["status", "observedAt", "health", "omitted", "remediation", "entries"]),
  queue: new Set(["status", "observedAt", "health", "omitted", "remediation", "outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"]),
});

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOmitted(value, prefix, reasons, allowedFields) {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value.map((entry) => [entry?.field, entry?.reason]) : Object.entries(value);
  for (const [field, reason] of entries) {
    if (typeof field !== "string" || !TELEMETRY_REASONS.has(reason) || allowedFields && !allowedFields.has(field)) reasons.push(`${prefix} has invalid omission`);
  }
}

export function validateTelemetryCardinality(telemetry, { operationIds, maximumOperations = 64 }) {
  const reasons = [];
  let unknownKeys = 0;
  let duplicateKeys = 0;
  if (!object(telemetry) || JSON.stringify(Object.keys(telemetry).sort()) !== JSON.stringify([...Object.keys(FAMILY_KEYS)].sort())) {
    reasons.push("telemetry families are not exact");
  }
  for (const [family, allowed] of Object.entries(FAMILY_KEYS)) {
    const value = telemetry?.[family];
    if (!object(value)) { reasons.push(`${family} is not an object`); continue; }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) { reasons.push(`${family} has unknown key ${key}`); unknownKeys += 1; }
    }
    if (!TELEMETRY_STATUSES.has(value.status)) reasons.push(`${family}.status is invalid`);
    if (value.health !== undefined && !TELEMETRY_HEALTHS.has(value.health)) reasons.push(`${family}.health is invalid`);
    if (typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt)) reasons.push(`${family}.observedAt is invalid`);
    validateOmitted(value.omitted, family, reasons, family === "statements"
      ? new Set(["statementsDeallocTotal", "statementsStatsReset", "blockSize"]) : TELEMETRY_VALUE_FIELDS[family]);
    if (family !== "statements" && FAILURE_STATUSES.has(value.status)) {
      const omissions = Array.isArray(value.omitted) ? value.omitted : [];
      const requiredFields = [...TELEMETRY_VALUE_FIELDS[family]];
      if (value.health !== "unavailable" || value.remediation !== OBSERVABILITY_ACTIONS.unavailable
        || omissions.length !== requiredFields.length
        || !requiredFields.every((field) => omissions.some((entry) => entry.field === field && entry.reason === value.status))) {
        reasons.push(`${family} failure filler is invalid`);
      }
    }
  }
  if (telemetry?.statements?.scope !== "aggregate") reasons.push("statements.scope is invalid");
  if (!MIGRATION_HISTORY_STATUSES.has(telemetry?.migration?.historyStatus)) reasons.push("migration.historyStatus is invalid");
  const operations = telemetry?.statements?.operations;
  if (operations !== undefined && !Array.isArray(operations)) reasons.push("statements.operations is not an array");
  if (["observed", "partial", "reset"].includes(telemetry?.statements?.status) && !Array.isArray(operations)) {
    reasons.push("observed statements.operations is missing");
  }
  if (Array.isArray(operations)) {
    if (operations.length > maximumOperations) reasons.push("statements.operations exceeds maximum");
    const seen = new Set();
    for (const [index, operation] of operations.entries()) {
      if (!object(operation)) { reasons.push(`statements.operations[${index}] is invalid`); continue; }
      for (const key of Object.keys(operation)) {
        if (!["operation", "values", "omitted"].includes(key)) { reasons.push(`statements operation has unknown key ${key}`); unknownKeys += 1; }
      }
      if (!operationIds.includes(operation?.operation)) reasons.push(`statements.operations[${index}].operation is not cataloged`);
      if (seen.has(operation?.operation)) duplicateKeys += 1;
      seen.add(operation?.operation);
      const values = operation.values;
      const omitted = operation.omitted;
      if (!object(values)) reasons.push("statements operation values is invalid");
      if (!object(omitted)) reasons.push("statements operation omitted is invalid");
      for (const key of Object.keys(object(values) ? values : {})) if (!METRIC_KEYS.has(key)) { reasons.push(`statements operation has unknown metric ${key}`); unknownKeys += 1; }
      for (const value of Object.values(object(values) ? values : {})) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) reasons.push("statements operation has an invalid metric value");
      }
      for (const [key, reason] of Object.entries(object(omitted) ? omitted : {})) {
        if (!METRIC_KEYS.has(key) || !TELEMETRY_REASONS.has(reason)) reasons.push("statements operation has invalid omission");
      }
    }
  }
  const entries = telemetry?.extensions?.entries;
  if (!Array.isArray(entries)) reasons.push("extensions.entries is missing");
  if (Array.isArray(entries)) {
    const failureFiller = FAILURE_STATUSES.has(telemetry.extensions.status)
      && telemetry.extensions.health === "unavailable"
      && entries.length === 0
      && Array.isArray(telemetry.extensions.omitted)
      && telemetry.extensions.omitted.length === 4
      && telemetry.extensions.omitted.every((entry) => EXTENSION_NAMES.has(entry.field) && entry.reason === telemetry.extensions.status);
    if (!failureFiller && entries.length !== 4) reasons.push("extensions.entries is not the exact observed or failure catalog");
    const names = entries.map((entry) => entry?.name);
    if (new Set(names).size !== names.length) duplicateKeys += names.length - new Set(names).size;
    if (names.some((name) => !EXTENSION_NAMES.has(name))) reasons.push("extensions.entries contains an unknown extension");
    for (const entry of entries) {
      if (!object(entry) || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["defaultVersion", "installedVersion", "name", "status"])) {
        reasons.push("extensions.entries contains an invalid shape");
      } else if (!EXTENSION_READINESS.has(entry.status)
        || typeof entry.installedVersion !== "string" || typeof entry.defaultVersion !== "string") {
        reasons.push("extensions.entries contains an invalid label");
      }
    }
  }
  const scalarCounts = {
    statements: (Array.isArray(operations) ? operations.reduce((count, operation) => count + Object.keys(operation?.values ?? {}).length + Object.keys(operation?.omitted ?? {}).length, 0) : 0)
      + ["statementsDeallocTotal", "statementsStatsReset", "blockSize"].filter((key) => telemetry?.statements?.[key] !== undefined).length,
    pool: Number(telemetry?.pool?.saturationRatio !== undefined),
    migration: ["historyStatus", "appliedCount", "expectedCount"].filter((key) => telemetry?.migration?.[key] !== undefined).length,
    extensions: Array.isArray(entries) ? entries.length * 4 : 0,
    queue: ["outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"].filter((key) => telemetry?.queue?.[key] !== undefined).length,
  };
  for (const [family, fields] of Object.entries({
    pool: ["saturationRatio"], migration: ["appliedCount", "expectedCount"],
    queue: ["outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"],
  })) for (const field of fields) {
    const value = telemetry?.[family]?.[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) reasons.push(`${family}.${field} is invalid`);
  }
  if (scalarCounts.statements > 22 * maximumOperations + 3) reasons.push("statements scalar count exceeds bound");
  if (scalarCounts.pool > 1 || scalarCounts.migration > 3 || scalarCounts.extensions > 16 || scalarCounts.queue > 4) reasons.push("runtime-health scalar count exceeds bound");
  return { verdict: reasons.length === 0 && duplicateKeys === 0 ? "pass" : "fail", reasons, scalarCounts, unknownKeys, duplicateKeys };
}

function legalTimeoutFamily(family, statements = false) {
  if (!family) return false;
  if (statements) return ["observed", "timeout", "unavailable"].includes(family.status);
  if (family.status === "observed") return family.health === "healthy" && family.remediation === OBSERVABILITY_ACTIONS.healthy;
  return ["timeout", "unavailable"].includes(family.status)
    && family.health === "unavailable" && family.remediation === OBSERVABILITY_ACTIONS.unavailable;
}

export function evaluateTimeoutShape(snapshot) {
  const reasons = [];
  if (snapshot?.classification !== "timeout") reasons.push("classification is not timeout");
  if (snapshot?.pool?.origin !== "daemon" || snapshot.pool.status !== "ready") reasons.push("daemon pool telemetry is not preserved");
  if (snapshot?.pool?.failed !== false || snapshot?.telemetry?.pool?.status !== "observed"
    || snapshot.telemetry.pool.health !== "healthy" || snapshot.telemetry.pool.remediation !== OBSERVABILITY_ACTIONS.healthy) {
    reasons.push("daemon pool family is not healthy with its exact action");
  }
  if (snapshot?.telemetry?.migration?.status !== "timeout" || !legalTimeoutFamily(snapshot.telemetry.migration)) reasons.push("schema_migrations read did not time out");
  if (!legalTimeoutFamily(snapshot?.telemetry?.extensions)) reasons.push("extensions has an illegal timeout shape");
  if (!legalTimeoutFamily(snapshot?.telemetry?.queue)) reasons.push("queue has an illegal timeout shape");
  if (!legalTimeoutFamily(snapshot?.telemetry?.statements, true)) reasons.push("statements has an illegal timeout shape");
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function evaluateFencedReset({ baselineEpoch, appliedAtMs, observations }) {
  const straddlers = observations.filter((observation) => observation.startedAtMs < appliedAtMs && observation.completedAtMs >= appliedAtMs);
  if (straddlers.length > 0) return { verdict: "fail", reason: "probe straddled the fenced mutation" };
  const eligible = observations.filter((observation) => observation.startedAtMs >= appliedAtMs);
  const first = eligible[0];
  const second = eligible[1];
  const pass = first?.status === "reset" && Number.isFinite(Date.parse(first.epoch))
    && Date.parse(first.epoch) > Date.parse(baselineEpoch)
    && second?.status === "observed" && second.epoch === first.epoch;
  return { verdict: pass ? "pass" : "fail", reason: pass ? null : "reset then observed sequence is missing" };
}

export function createProbeSchedule({ phase, machine, appliedAtMs, holdMaximumMs, cadenceMs, timeoutMs = 5_000 }) {
  const schedule = [];
  for (let sequence = 0, startAtMs = appliedAtMs; startAtMs < appliedAtMs + holdMaximumMs; sequence += 1, startAtMs += cadenceMs) {
    schedule.push({ id: `${phase}-${machine}-probe-${sequence}`, phase, machine, sequence, startAtMs, timeoutMs });
  }
  return schedule;
}

export function evaluateSaturationWitness(observations) {
  const induced = observations.filter((observation) => observation?.pool?.waiting > 0);
  if (induced.length === 0) return { verdict: "incomplete", reason: "waiting was never established" };
  const pass = induced.some((observation) => observation.pool.origin === "daemon" && observation.pool.status === "ready"
    && observation.telemetry?.pool?.status === "observed" && observation.telemetry.pool.health === "degraded"
    && observation.telemetry.pool.saturationRatio >= 1 && observation.pool.failed === false
    && observation.telemetry.pool.remediation === OBSERVABILITY_ACTIONS.poolSaturated);
  return { verdict: pass ? "pass" : "fail", reason: pass ? null : "established saturation had incorrect telemetry" };
}

export function healthySnapshot(snapshot) {
  const telemetry = snapshot?.telemetry;
  return snapshot?.classification === "healthy" && snapshot?.pool?.status === "ready"
    && snapshot.pool.origin === "daemon" && snapshot.pool.failed === false
    && runtimeFamiliesHealthy(telemetry)
    && telemetry?.statements?.status === "observed";
}

function runtimeFamiliesHealthy(telemetry) {
  return ["pool", "migration", "extensions", "queue"].every((family) => telemetry?.[family]?.status === "observed"
    && telemetry[family].health === "healthy" && telemetry[family].remediation === OBSERVABILITY_ACTIONS.healthy);
}

export function evaluatePhaseProbeEvidence({ phase, probes, fault, baseline, backlogWitness, backlogDetection }) {
  const appliedAtMs = Date.parse(fault?.appliedAt);
  const clearedAtMs = Date.parse(fault?.clearedAt);
  const afterApply = probes.filter((probe) => probe.startedAtMs >= appliedAtMs);
  const healthyAfterClear = probes.filter((probe) => probe.startedAtMs >= clearedAtMs && healthySnapshot(probe.snapshot));
  const result = { alert: undefined, detectionSeconds: undefined, clearanceSeconds: undefined, recovery: undefined };
  let positiveBacklog;
  const detected = (record) => {
    result.alert = true;
    result.detectionSeconds = (record.completedAtMs - appliedAtMs) / 1000;
  };
  const matchesByMachine = (predicate, machines = ["a", "b"]) => machines.map((machine) => afterApply.find((probe) => probe.machine === machine && predicate(probe)));
  if (phase === "saturation") {
    const state = evaluateSaturationWitness(afterApply.map((probe) => probe.snapshot));
    const match = afterApply.find((probe) => evaluateSaturationWitness([probe.snapshot]).verdict === "pass");
    if (match) detected(match); else result.alert = state.verdict === "fail" ? false : undefined;
  } else if (phase === "timeout") {
    const matches = matchesByMachine((probe) => evaluateTimeoutShape(probe.snapshot).verdict === "pass");
    if (matches.every(Boolean)) { result.alert = true; result.detectionSeconds = Math.max(...matches.map((match) => (match.completedAtMs - appliedAtMs) / 1000)); }
    else result.alert = afterApply.length > 0 ? false : undefined;
  } else if (phase === "stats-reset" || phase === "restart-database") {
    const resets = ["a", "b"].map((machine) => {
      const observations = afterApply.filter((probe) => probe.machine === machine && probe.snapshot?.telemetry?.statements)
        .map((probe) => ({ startedAtMs: probe.startedAtMs, completedAtMs: probe.completedAtMs,
          status: probe.snapshot.telemetry.statements.status, epoch: probe.snapshot.telemetry.statements.statementsStatsReset }));
      return { observations, result: evaluateFencedReset({ baselineEpoch: baseline?.[machine]?.snapshot?.telemetry?.statements?.statementsStatsReset, appliedAtMs, observations }) };
    });
    const resetPass = resets.every((entry) => entry.result.verdict === "pass");
    const outages = phase === "restart-database" ? matchesByMachine((probe) => probe.transportFailure === true
      || ["timeout", "unavailable"].includes(probe.snapshot?.classification)) : [];
    result.alert = resetPass && (phase !== "restart-database" || outages.every(Boolean))
      ? true : resets.some((entry) => entry.observations.length > 0) ? false : undefined;
    const first = afterApply.filter((probe) => probe.snapshot?.telemetry?.statements?.status === "reset");
    const detection = phase === "restart-database" ? outages.filter(Boolean) : first;
    if (detection.length > 0) result.detectionSeconds = Math.max(...detection.map((probe) => (probe.completedAtMs - appliedAtMs) / 1000));
  } else if (phase === "permission-loss") {
    const matches = matchesByMachine((probe) => probe.snapshot?.classification === baseline?.[probe.machine]?.snapshot?.classification
      && probe.snapshot?.telemetry?.statements?.status === "permission-denied"
      && runtimeFamiliesHealthy(probe.snapshot.telemetry));
    if (matches.every(Boolean)) { result.alert = true; result.detectionSeconds = Math.max(...matches.map((match) => (match.completedAtMs - appliedAtMs) / 1000)); }
    else result.alert = afterApply.length > 0 ? false : undefined;
  } else if (phase === "extension-loss") {
    const matches = matchesByMachine((probe) => probe.snapshot?.classification === "unavailable"
      && probe.snapshot?.telemetry?.extensions?.health === "degraded"
      && probe.snapshot.telemetry.extensions.remediation === OBSERVABILITY_ACTIONS.extensions
      && probe.snapshot?.telemetry?.statements?.status === "unavailable");
    if (matches.every(Boolean)) { result.alert = true; result.detectionSeconds = Math.max(...matches.map((match) => (match.completedAtMs - appliedAtMs) / 1000)); }
    else result.alert = afterApply.length > 0 ? false : undefined;
  } else if (phase === "queue-backlog") {
    const outage = afterApply.find((probe) => probe.transportFailure === true || ["timeout", "unavailable"].includes(probe.snapshot?.classification));
    if (outage) result.detectionSeconds = (outage.completedAtMs - appliedAtMs) / 1000;
    const positive = probes.find((probe) => probe.startedAtMs >= clearedAtMs
      && probe.snapshot?.telemetry?.queue?.health === "degraded"
      && probe.snapshot.telemetry.queue.remediation === OBSERVABILITY_ACTIONS.backlog
      && probe.snapshot.telemetry.queue.inboxQuarantined === 0);
    if (positive && backlogWitness?.before?.created_at && backlogDetection?.delivery_state
      && ["pending", "retry"].includes(backlogDetection.delivery_state)
      && backlogDetection.event_uuid === backlogWitness.before.event_uuid) {
      const createdAtMs = Date.parse(`${String(backlogWitness.before.created_at).replace(" ", "T")}Z`);
      const bracket = backlogAgeBracket({ createdAtMs, requestStartMs: positive.startedAtMs, responseEndMs: positive.completedAtMs });
      const age = positive.snapshot.telemetry.queue.outboxOldestPendingAgeSeconds;
      result.alert = Number.isInteger(age) && age >= bracket.minimum && age <= bracket.maximum;
      if (result.alert) positiveBacklog = positive;
    } else result.alert = positive ? false : undefined;
  } else if (phase === "partition-a") {
    const affected = afterApply.filter((probe) => probe.machine === "a");
    const failure = affected.find((probe) => probe.transportFailure === true || ["timeout", "unavailable"].includes(probe.snapshot?.classification));
    const bDuring = afterApply.filter((probe) => probe.machine === "b" && probe.startedAtMs <= clearedAtMs);
    const bHealthy = bDuring.length > 0 && bDuring.every((probe) => healthySnapshot(probe.snapshot));
    if (failure) { detected(failure); result.alert = bHealthy; } else result.alert = affected.length > 0 ? false : undefined;
  } else if (phase === "canary") {
    result.alert = afterApply.length > 0 && afterApply.every((probe) => healthySnapshot(probe.snapshot));
    result.detectionSeconds = result.alert ? 0 : undefined;
  }
  const healthyClearanceByMachine = ["a", "b"].map((machine) => {
    const record = healthyAfterClear.find((probe) => probe.machine === machine);
    return record ? (record.completedAtMs - clearedAtMs) / 1000 : Number.POSITIVE_INFINITY;
  });
  if (healthyAfterClear.length > 0) result.clearanceSeconds = Math.max(...healthyClearanceByMachine);
  if (phase === "queue-backlog" && positiveBacklog) result.clearanceSeconds = (positiveBacklog.completedAtMs - clearedAtMs) / 1000;
  result.recovery = phase === "queue-backlog" ? healthyClearanceByMachine.every(Number.isFinite) : Number.isFinite(result.clearanceSeconds);
  return result;
}

export function backlogAgeBracket({ createdAtMs, requestStartMs, responseEndMs }) {
  return {
    minimum: Math.floor((requestStartMs - createdAtMs) / 1_000),
    maximum: Math.floor((responseEndMs - createdAtMs) / 1_000),
  };
}

export function evaluateCalibrationPairs(pairs, { approvedCeiling, approvedNoiseCeiling }) {
  const valid = pairs.filter((pair) => pair.rejected === undefined
    && pair.baselineElapsedMs > 0 && pair.probeElapsedMs > 0 && pair.probeCount > 0
    && [pair.baselineDelta, pair.probeDelta].every(Number.isFinite));
  const costs = valid.map((pair) => (
    pair.probeDelta - pair.baselineDelta * (pair.probeElapsedMs / pair.baselineElapsedMs)
  ) / pair.probeCount);
  const baselineEquivalents = valid.map((pair) => pair.baselineDelta * (pair.probeElapsedMs / pair.baselineElapsedMs) / pair.probeCount);
  const measuredMaximum = costs.length === 0 ? null : Math.max(...costs);
  const noiseAllowance = baselineEquivalents.length === 0 ? null : Math.max(...baselineEquivalents) - Math.min(...baselineEquivalents);
  const verdict = valid.length < 3 ? "incomplete"
    : measuredMaximum <= approvedCeiling && noiseAllowance <= approvedNoiseCeiling ? "pass"
      : measuredMaximum > approvedCeiling && measuredMaximum > noiseAllowance ? "fail" : "incomplete";
  return { verdict, validPairs: valid.length, rejectedPairs: pairs.length - valid.length, signedCosts: costs, measuredMaximum, noiseAllowance };
}

export function evaluateConnectionEvidence({
  baseline,
  probeSamples,
  tailSamples,
  sampledIncrementCeiling,
  structuralMaximum,
  structuralCeiling = 3,
  activeIntervals,
  sampledActiveIntervals,
}) {
  const complete = Number.isFinite(baseline) && Array.isArray(probeSamples) && probeSamples.length > 0
    && Array.isArray(tailSamples) && tailSamples.length > 0
    && activeIntervals > 0 && sampledActiveIntervals === activeIntervals;
  if (!complete) return { verdict: "incomplete", zeroIncrementNotZeroCost: true };
  const sampledMaximum = Math.max(...probeSamples);
  const sampledIncrement = Math.max(0, sampledMaximum - baseline);
  const residual = tailSamples.at(-1) - baseline;
  const failed = sampledIncrement > sampledIncrementCeiling || residual > 0 || structuralMaximum > structuralCeiling;
  return {
    verdict: failed ? "fail" : "pass",
    sampledMaximum,
    sampledIncrement,
    residual,
    structuralMaximum,
    zeroIncrementNotZeroCost: sampledIncrement === 0,
  };
}

export function evaluateWorkloadCompleteness(expectedIds, attempts, { minimumSearches = 2, minimumStores = 1 } = {}) {
  const expected = new Set(expectedIds);
  const observedCounts = new Map();
  for (const attempt of attempts) observedCounts.set(attempt.id, (observedCounts.get(attempt.id) ?? 0) + 1);
  const observed = new Set(observedCounts.keys());
  const missing = expectedIds.filter((id) => !observed.has(id));
  const extra = [...observed].filter((id) => !expected.has(id)).sort();
  const duplicate = [...observedCounts].filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (extra.length > 0 || duplicate.length > 0) return { verdict: "fail", missing, extra, duplicate };
  if (expectedIds.length === 0 || missing.length > 0) return { verdict: "incomplete", missing, extra };
  const successful = attempts.filter((attempt) => attempt.outcome === "success" && attempt.overlapped === true);
  const search = successful.filter((attempt) => attempt.op === "search").length;
  const store = successful.filter((attempt) => attempt.op === "store").length;
  const unexpected = attempts.filter((attempt) => attempt.outcome !== "success" && attempt.intentionalFailure !== true);
  return { verdict: search >= minimumSearches && store >= minimumStores && unexpected.length === 0 ? "pass" : "fail", missing, extra, duplicate, search, store, unexpected: unexpected.length };
}

export function evaluateProbePopulation({ expectedIds, records, maximumStartGapMs, phaseWindows = {} }) {
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const id of expectedIds) expectedCounts.set(id, (expectedCounts.get(id) ?? 0) + 1);
  for (const record of records) actualCounts.set(record.id, (actualCounts.get(record.id) ?? 0) + 1);
  const missing = [...expectedCounts].flatMap(([id, count]) => Array.from({ length: Math.max(0, count - (actualCounts.get(id) ?? 0)) }, () => id));
  const extra = [...actualCounts].flatMap(([id, count]) => Array.from({ length: Math.max(0, count - (expectedCounts.get(id) ?? 0)) }, () => id));
  const duplicate = [...actualCounts].filter(([, count]) => count > 1).map(([id]) => id);
  const groups = new Map();
  for (const record of records.filter((entry) => Number.isInteger(entry.sequence) && entry.sequence >= 0)) {
    const key = `${record.phase}:${record.machine}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  let maximumObservedGapMs = 0;
  let boundaryIncomplete = false;
  let boundaryFailure = false;
  for (const group of groups.values()) {
    if (group[0]?.phase === "steady" || String(group[0]?.phase).startsWith("calibration-")) continue;
    const ordered = group.filter((record) => Number.isFinite(record.startedAtMs)).sort((left, right) => left.startedAtMs - right.startedAtMs);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].gapReset === true) continue;
      maximumObservedGapMs = Math.max(maximumObservedGapMs, ordered[index].startedAtMs - ordered[index - 1].startedAtMs);
    }
    const window = phaseWindows[`${group[0]?.phase}:${group[0]?.machine}`];
    if (window) {
      if (ordered.length === 0 || ordered.at(-1).startedAtMs < window.endMs) boundaryIncomplete = true;
      else if (ordered[0].startedAtMs < window.startMs || ordered[0].startedAtMs - window.startMs > maximumStartGapMs) boundaryFailure = true;
    }
  }
  const definiteFailure = extra.length > 0 || duplicate.length > 0 || boundaryFailure
    || !Number.isFinite(maximumObservedGapMs) || maximumObservedGapMs > maximumStartGapMs;
  return {
    verdict: definiteFailure ? "fail" : missing.length > 0 || boundaryIncomplete || expectedIds.length === 0 ? "incomplete" : "pass",
    expected: expectedIds.length,
    actual: records.length,
    missing,
    extra,
    duplicate,
    maximumObservedGapMs,
    boundaryIncomplete,
    boundaryFailure,
  };
}

export function evaluatePhaseWorkload({ expectedIds, attempts, machine, appliedAtMs, clearedAtMs, minimumSearches = 2, minimumStores = 1 }) {
  const selected = attempts.filter((attempt) => attempt.machine === machine);
  const base = evaluateWorkloadCompleteness(expectedIds, selected.map((attempt) => ({
    ...attempt,
    overlapped: Number.isFinite(attempt.processStartWallMs) && Number.isFinite(attempt.processExitWallMs)
      && attempt.processStartWallMs <= clearedAtMs && attempt.processExitWallMs >= appliedAtMs,
  })), { minimumSearches: 0, minimumStores: 0 });
  const overlappedSuccesses = selected.filter((attempt) => attempt.outcome === "success"
    && Number.isFinite(attempt.processStartWallMs) && Number.isFinite(attempt.processExitWallMs)
    && attempt.processStartWallMs <= clearedAtMs && attempt.processExitWallMs >= appliedAtMs);
  const searches = overlappedSuccesses.filter((attempt) => attempt.op === "search").length;
  const stores = overlappedSuccesses.filter((attempt) => attempt.op === "store").length;
  const verdict = base.verdict === "fail" ? "fail"
    : base.verdict === "incomplete" ? "incomplete"
      : searches >= minimumSearches && stores >= minimumStores ? "pass" : "fail";
  return { ...base, verdict, searches, stores };
}

export function evaluateBarrierSequence(steps) {
  let blocked = false;
  return steps.map((step) => {
    if (blocked) return { ...step, verdict: "incomplete" };
    if (step.verdict === "barrier-timeout") {
      blocked = true;
      return { ...step, verdict: "incomplete" };
    }
    return step;
  });
}

export function observabilityApplicability({ version, lane }) {
  if (version !== 4) return { applicable: false, reason: "contract-v3" };
  if (lane === "managed") return {
    applicable: false,
    reason: "managed-residual",
    residuals: ["provider-failover", "provider-privilege-semantics", "provider-round-trip-overhead", "independent-clocks-and-hardware"],
  };
  return { applicable: true, reason: null };
}

const OBSERVABILITY_STEPS = Object.freeze([
  "steady", "partition-a", "restart-database", "saturation", "timeout", "stats-reset",
  "permission-loss", "extension-loss", "queue-backlog", "canary",
]);

function summaryItem(id, verdict, observed = verdict === "pass" ? 1 : 0, threshold = 1, formula = "v4 observability predicate") {
  return { id, formula, threshold, observed, verdict };
}

function booleanVerdict(value) {
  return value === true ? "pass" : value === false ? "fail" : "incomplete";
}

function boundedVerdict(value, maximum) {
  return !Number.isFinite(value) ? "incomplete" : value <= maximum ? "pass" : "fail";
}

export function buildObservabilitySummary({ contractSha256, runId, probes = [], probeCompleteness, phaseResults = {}, canary, privacy, calibration, connections } = {}) {
  const items = [];
  const expectedProbeIds = probes.filter((probe) => probe.expected === true).map((probe) => probe.id);
  const actualProbes = probes.filter((probe) => probe.expected !== true);
  const completeness = probeCompleteness ?? evaluateProbePopulation({ expectedIds: expectedProbeIds, records: actualProbes, maximumStartGapMs: 7_500 });
  items.push(summaryItem("probe-completeness", completeness.verdict, completeness.actual ?? actualProbes.length, completeness.expected ?? expectedProbeIds.length, "expected probe multiplicities and bounded start gaps"));
  const completed = actualProbes.filter((probe) => probe.transportFailure !== true && probe.snapshot);
  const steady = completed.filter((probe) => probe.phase === "steady");
  const steadyHealthy = steady.length > 0 && steady.every((probe) => probe.snapshot.classification === "healthy");
  items.push(summaryItem("telemetry.steady-healthy", steady.length === 0 ? "incomplete" : booleanVerdict(steadyHealthy), steadyHealthy ? 1 : 0));
  const freshnessBreach = completed.some((probe) => probe.durationMs > 2_500
    || !Number.isFinite(probe.startedAtMs) || !Number.isFinite(probe.completedAtMs)
    || Object.values(probe.snapshot.telemetry ?? {}).some((family) => typeof family?.observedAt !== "number"
      || !Number.isFinite(family.observedAt) || family.observedAt < probe.startedAtMs || family.observedAt > probe.completedAtMs));
  items.push(summaryItem("telemetry.freshness", completed.length === 0 ? "incomplete" : freshnessBreach ? "fail" : "pass", freshnessBreach ? 1 : 0, 0));
  const cardinalityFailures = completed.filter((probe) => probe.cardinality?.verdict !== "pass").length;
  items.push(summaryItem("telemetry.cardinality", completed.length === 0 ? "incomplete" : cardinalityFailures > 0 ? "fail" : "pass", cardinalityFailures, 0));
  for (const step of OBSERVABILITY_STEPS) {
    const result = phaseResults[step];
    items.push(summaryItem(`alert.${step}`, booleanVerdict(result?.alert)));
    const detectionMaximum = step === "steady" ? 10 : 10;
    items.push(summaryItem(`detection.${step}`, boundedVerdict(result?.detectionSeconds, detectionMaximum), Number.isFinite(result?.detectionSeconds) ? result.detectionSeconds : 0, detectionMaximum, "appliedAt to qualifying response completion"));
    const clearanceMaximum = ["partition-a", "restart-database", "queue-backlog"].includes(step) ? 30 : 10;
    items.push(summaryItem(`clearance.${step}`, boundedVerdict(result?.clearanceSeconds, clearanceMaximum), Number.isFinite(result?.clearanceSeconds) ? result.clearanceSeconds : 0, clearanceMaximum));
    items.push(summaryItem(`correctness.${step}`, booleanVerdict(result?.correctness)));
  }
  items.push(summaryItem("recovery.saturation", booleanVerdict(phaseResults.saturation?.recovery)));
  items.push(summaryItem("recovery.queue-backlog", booleanVerdict(phaseResults["queue-backlog"]?.recovery)));
  const canaryWitnesses = canary && JSON.stringify(canary.expected) === JSON.stringify(canary.observed);
  items.push(summaryItem("canary-witnesses", canary === undefined ? "incomplete" : booleanVerdict(canaryWitnesses)));
  const canaryHits = privacy?.canaryHits;
  const canaryVerdict = Number.isFinite(canaryHits) && canaryHits > 0 ? "fail"
    : !Number.isFinite(canaryHits) || privacy?.surfacesComplete !== true ? "incomplete" : "pass";
  items.push(summaryItem("privacy.canary-leaks", canaryVerdict, canaryHits ?? 0, 0));
  const secretHits = privacy?.secretHits;
  const secretVerdict = Number.isFinite(secretHits) && secretHits > 0 ? "fail"
    : !Number.isFinite(secretHits) || privacy?.inventoryComplete !== true || privacy?.surfacesComplete !== true ? "incomplete" : "pass";
  items.push(summaryItem("privacy.secret-leaks", secretVerdict, secretHits ?? 0, 0));
  for (const [id, value] of [["overhead.machine-cpu", calibration?.machineCpu], ["overhead.database-cpu", calibration?.databaseCpu]]) {
    items.push(summaryItem(id, value?.verdict ?? "incomplete", value?.measuredMaximum ?? 0, value?.ceiling ?? 0));
  }
  items.push(summaryItem("overhead.statements-per-snapshot", calibration?.statements?.verdict ?? "incomplete", calibration?.statements?.observed ?? 0, calibration?.statements?.ceiling ?? 0));
  items.push(summaryItem("overhead.connections", connections?.verdict ?? "incomplete", connections?.observed ?? 0, connections?.ceiling ?? 0));
  const latencies = steady.map((probe) => probe.durationMs).filter(Number.isFinite).sort((left, right) => left - right);
  const p95 = latencies.length === 0 ? 0 : latencies[Math.ceil(latencies.length * 0.95) - 1];
  const maximum = latencies.length === 0 ? 0 : Math.max(...latencies);
  items.push(summaryItem("steady-probe-latency.p95", latencies.length < 200 ? "incomplete" : p95 <= 2_000 ? "pass" : "fail", p95, 2_000));
  items.push(summaryItem("steady-probe-latency.max", latencies.length === 0 ? "incomplete" : maximum <= 2_500 ? "pass" : "fail", maximum, 2_500));
  return {
    schemaVersion: 1,
    contract: { version: 4, sha256: contractSha256 },
    run: { sha256: typeof runId === "string" ? digest(Buffer.from(runId)) : "0".repeat(64) },
    applicability: { applicable: true, reason: null },
    items,
    privateArtifacts: {
      rawProbeBodies: completed.length,
      probeRecords: probes.length,
      canarySurfaces: canary?.observed?.cli ?? 0,
      secretCategories: privacy?.secretCategories ?? 0,
      retentionDays: 90,
      directoryMode: "0700",
      fileMode: "0600",
    },
  };
}
