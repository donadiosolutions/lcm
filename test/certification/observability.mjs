import { CANARY_CORPUS } from "./canary-corpus.mjs";

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function boundaryHit(text, value) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(value)}(?:$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

export function scanSurface(bytes, inventory = [], canaries = CANARY_CORPUS) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const categoryHits = {};
  let secretHits = 0;
  for (const entry of inventory) {
    const forms = entry.scanMode === "boundary-token" ? [entry.value] : encodedScanForms(entry.value);
    const hits = forms.reduce((count, form) => count + (entry.scanMode === "boundary-token"
      ? Number(boundaryHit(text, form)) : Number(text.includes(form))), 0);
    categoryHits[entry.category] = hits;
    secretHits += hits;
  }
  let canaryHits = 0;
  for (const canary of canaries) {
    for (const form of encodedScanForms(canary)) canaryHits += Number(text.includes(form));
  }
  return { bytes: Buffer.byteLength(text), categoryHits, secretHits, canaryHits };
}

const FAMILY_KEYS = Object.freeze({
  statements: new Set(["status", "observedAt", "scope", "statementsDeallocTotal", "statementsStatsReset", "blockSize", "omitted", "operations"]),
  pool: new Set(["status", "observedAt", "health", "omitted", "remediation", "saturationRatio", "origin", "failed", "waiting"]),
  migration: new Set(["status", "observedAt", "health", "omitted", "remediation", "historyStatus", "appliedCount", "expectedCount", "drifted"]),
  extensions: new Set(["status", "observedAt", "health", "omitted", "remediation", "entries"]),
  queue: new Set(["status", "observedAt", "health", "omitted", "remediation", "outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"]),
});

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOmitted(value, prefix, reasons) {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value.map((entry) => [entry?.field, entry?.reason]) : Object.entries(value);
  for (const [field, reason] of entries) {
    if (typeof field !== "string" || !TELEMETRY_REASONS.has(reason)) reasons.push(`${prefix} has invalid omission`);
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
    validateOmitted(value.omitted, family, reasons);
  }
  const operations = telemetry?.statements?.operations;
  if (operations !== undefined && !Array.isArray(operations)) reasons.push("statements.operations is not an array");
  if (Array.isArray(operations)) {
    if (operations.length > maximumOperations) reasons.push("statements.operations exceeds maximum");
    const seen = new Set();
    for (const [index, operation] of operations.entries()) {
      if (!operationIds.includes(operation?.operation)) reasons.push(`statements.operations[${index}].operation is not cataloged`);
      if (seen.has(operation?.operation)) duplicateKeys += 1;
      seen.add(operation?.operation);
      const values = operation?.values ?? Object.fromEntries(Object.entries(operation ?? {}).filter(([key]) => METRIC_KEYS.has(key)));
      const omitted = operation?.omitted ?? {};
      for (const key of Object.keys(values)) if (!METRIC_KEYS.has(key)) { reasons.push(`statements operation has unknown metric ${key}`); unknownKeys += 1; }
      for (const [key, reason] of Object.entries(omitted)) {
        if (!METRIC_KEYS.has(key) || !TELEMETRY_REASONS.has(reason)) reasons.push("statements operation has invalid omission");
      }
    }
  }
  const entries = telemetry?.extensions?.entries;
  if (entries !== undefined && (!Array.isArray(entries) || entries.length !== 4)) reasons.push("extensions.entries is not the exact four-entry catalog");
  if (Array.isArray(entries)) {
    const names = entries.map((entry) => entry?.name);
    if (new Set(names).size !== names.length) duplicateKeys += names.length - new Set(names).size;
    if (names.some((name) => !EXTENSION_NAMES.has(name))) reasons.push("extensions.entries contains an unknown extension");
  }
  const scalarCounts = {
    statements: (Array.isArray(operations) ? operations.reduce((count, operation) => count + Object.keys(operation?.values ?? {}).length + Object.keys(operation?.omitted ?? {}).length, 0) : 0)
      + ["statementsDeallocTotal", "statementsStatsReset", "blockSize"].filter((key) => telemetry?.statements?.[key] !== undefined).length,
    pool: Number(telemetry?.pool?.saturationRatio !== undefined),
    migration: ["historyStatus", "appliedCount", "expectedCount"].filter((key) => telemetry?.migration?.[key] !== undefined).length,
    extensions: Array.isArray(entries) ? entries.length * 4 : 0,
    queue: ["outboxOldestPendingAgeSeconds", "inboxClaimed", "inboxQuarantined", "replayLagSeconds"].filter((key) => telemetry?.queue?.[key] !== undefined).length,
  };
  if (scalarCounts.statements > 22 * maximumOperations + 3) reasons.push("statements scalar count exceeds bound");
  if (scalarCounts.pool > 1 || scalarCounts.migration > 3 || scalarCounts.extensions > 16 || scalarCounts.queue > 4) reasons.push("runtime-health scalar count exceeds bound");
  return { verdict: reasons.length === 0 && duplicateKeys === 0 ? "pass" : "fail", reasons, scalarCounts, unknownKeys, duplicateKeys };
}

export function evaluateTimeoutShape(snapshot) {
  const reasons = [];
  if (snapshot?.classification !== "timeout") reasons.push("classification is not timeout");
  if (snapshot?.telemetry?.pool?.origin !== "daemon") reasons.push("daemon pool telemetry is not preserved");
  if (snapshot?.telemetry?.migration?.status !== "timeout") reasons.push("schema_migrations read did not time out");
  for (const family of ["extensions", "queue", "statements"]) {
    const status = snapshot?.telemetry?.[family]?.status;
    if (!["observed", "timeout", "unavailable"].includes(status)) reasons.push(`${family} has an illegal timeout shape`);
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function evaluateFencedReset({ baselineEpoch, appliedAtMs, observations }) {
  const straddlers = observations.filter((observation) => observation.startedAtMs < appliedAtMs && observation.completedAtMs >= appliedAtMs);
  if (straddlers.length > 0) return { verdict: "fail", reason: "probe straddled the fenced mutation" };
  const eligible = observations.filter((observation) => observation.startedAtMs >= appliedAtMs);
  const first = eligible[0];
  const second = eligible[1];
  const pass = first?.status === "reset" && first.epoch !== baselineEpoch
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
  const pass = induced.some((observation) => observation.pool.origin === "daemon"
    && observation.pool.saturationRatio >= 1 && observation.pool.failed === false
    && observation.action === OBSERVABILITY_ACTIONS.poolSaturated);
  return { verdict: pass ? "pass" : "fail", reason: pass ? null : "established saturation had incorrect telemetry" };
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

export function evaluateWorkloadCompleteness(expectedIds, attempts) {
  const expected = new Set(expectedIds);
  const observed = new Set(attempts.map((attempt) => attempt.id));
  const missing = expectedIds.filter((id) => !observed.has(id));
  const extra = [...observed].filter((id) => !expected.has(id)).sort();
  if (extra.length > 0) return { verdict: "fail", missing, extra };
  if (expectedIds.length === 0 || missing.length > 0) return { verdict: "incomplete", missing, extra };
  const successful = attempts.filter((attempt) => attempt.outcome === "success" && attempt.overlapped === true);
  const search = successful.filter((attempt) => attempt.op === "search").length;
  const store = successful.filter((attempt) => attempt.op === "store").length;
  const unexpected = attempts.filter((attempt) => attempt.outcome !== "success" && attempt.intentionalFailure !== true);
  return { verdict: search >= 2 && store >= 1 && unexpected.length === 0 ? "pass" : "fail", missing, extra, search, store, unexpected: unexpected.length };
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

export function buildObservabilitySummary({ contractSha256, probes = [], phaseResults = {}, workload, canary, privacy, calibration, connections } = {}) {
  const items = [];
  const expectedProbeIds = new Set(probes.filter((probe) => probe.expected === true).map((probe) => probe.id));
  const actualProbeIds = new Set(probes.filter((probe) => probe.expected !== true).map((probe) => probe.id));
  const probeComplete = expectedProbeIds.size > 0 && expectedProbeIds.size === actualProbeIds.size
    && [...expectedProbeIds].every((id) => actualProbeIds.has(id));
  items.push(summaryItem("probe-completeness", expectedProbeIds.size === 0 ? "incomplete" : booleanVerdict(probeComplete), actualProbeIds.size, expectedProbeIds.size, "expected probe identities equal recorded identities"));
  const completed = probes.filter((probe) => probe.transportFailure !== true && probe.snapshot);
  const steady = completed.filter((probe) => probe.phase === "steady");
  const steadyHealthy = steady.length > 0 && steady.every((probe) => probe.snapshot.classification === "healthy");
  items.push(summaryItem("telemetry.steady-healthy", steady.length === 0 ? "incomplete" : booleanVerdict(steadyHealthy), steadyHealthy ? 1 : 0));
  const freshnessBreach = completed.some((probe) => probe.durationMs > 2_500 || !Number.isFinite(probe.startedAtMs) || !Number.isFinite(probe.completedAtMs));
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
  items.push(summaryItem("privacy.canary-leaks", !Number.isFinite(canaryHits) ? "incomplete" : canaryHits === 0 ? "pass" : "fail", canaryHits ?? 0, 0));
  const secretHits = privacy?.secretHits;
  const secretVerdict = !Number.isFinite(secretHits) || privacy?.inventoryComplete !== true
    ? "incomplete" : secretHits === 0 ? "pass" : "fail";
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
  const workloadResult = workload === undefined ? { verdict: "incomplete" } : evaluateWorkloadCompleteness(workload.expectedIds, workload.attempts);
  for (const item of items.filter((entry) => entry.id.startsWith("correctness."))) {
    if (item.verdict !== "fail" && workloadResult.verdict !== "pass") item.verdict = workloadResult.verdict;
  }
  return {
    schemaVersion: 1,
    contract: { version: 4, sha256: contractSha256 },
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
