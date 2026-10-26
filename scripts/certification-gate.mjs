#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvidence } from "../test/postgresql/cutover-rehearsal/check-evidence.ts";
import { loadCertificationContract } from "../test/certification/contract.mjs";
import { assembleCertificationGate, errorRate, evaluatePercentiles, nearestRank, writeCertificationGate } from "../test/certification/slo.mjs";
import { createDeterministicSchedule } from "../test/certification/schedule.mjs";
import { captureExecutionProvenance, recoveryWindowSearch } from "./certification-harness.mjs";

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function ndjson(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
function sampleFile(directory, name, values) {
  const path = join(directory, name);
  writeFileSync(path, values.map((value) => `${JSON.stringify(value)}\n`).join(""), { mode: 0o600, flag: "wx" });
  return name;
}

function percentileSlos(id, samples, thresholds, minimums, file) {
  const evaluated = evaluatePercentiles(samples, thresholds, minimums);
  return Object.entries(thresholds).map(([percentile, threshold]) => ({
    id: `${id}.${percentile}`,
    formula: "nearest-rank over successful steady samples",
    inputs: { count: samples.length, sampleFile: file },
    threshold,
    observed: evaluated.observed[percentile] ?? 0,
    verdict: evaluated.reasons.some((reason) => reason.startsWith(percentile))
      ? (evaluated.reasons.some((reason) => reason.startsWith(percentile) && reason.includes("exceeds")) ? "fail" : "incomplete")
      : "pass",
  }));
}

export function clockVerdict(samples, threshold, minimumCount = 2) {
  const finite = samples.filter((entry) => Number.isFinite(entry?.radiusMs) && entry.radiusMs >= 0);
  if (finite.some((entry) => entry.radiusMs > threshold || entry.verdict === "fail")) return "fail";
  const validBracket = (entry) => ['a', 'b'].includes(entry.machine)
    && Number.isFinite(entry.t0?.wallMs) && Number.isFinite(entry.t1?.wallMs) && entry.t1.wallMs >= entry.t0.wallMs
    && typeof entry.t0?.monotonicNs === "string" && /^\d+$/u.test(entry.t0.monotonicNs)
    && typeof entry.t1?.monotonicNs === "string" && /^\d+$/u.test(entry.t1.monotonicNs)
    && Number.isFinite(Date.parse(entry.serverTime))
    && Math.abs(entry.radiusMs - (entry.t1.wallMs - entry.t0.wallMs) / 2) < 0.001;
  const perMachineMinimum = Math.floor(minimumCount / 2);
  if (samples.length < minimumCount || finite.length !== samples.length || samples.some((entry) => entry.verdict === "incomplete" || !validBracket(entry))
    || ['a', 'b'].some((machine) => samples.filter((entry) => entry.machine === machine).length < perMachineMinimum
      || !samples.some((entry) => entry.machine === machine && entry.phase === "start")
      || !samples.some((entry) => entry.machine === machine && entry.phase === "end"))) return "incomplete";
  return "pass";
}

export function cleanupVerdict(cleanup) {
  if (!cleanup || cleanup.verdict === "fail" || cleanup.residualResources > 0) return "fail";
  if (cleanup.verdict === "incomplete") return "incomplete";
  return cleanup.verdict === "pass" && cleanup.residualResources === 0 ? "pass" : "incomplete";
}

export function reconcileAttemptIdentity(expected, observed) {
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const counts = new Map();
  const unexpected = [];
  const mismatched = [];
  for (const entry of observed) {
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    const wanted = expectedById.get(entry.id);
    if (!wanted) unexpected.push(entry.id);
    else if (wanted.machine !== entry.machine || wanted.op !== entry.op
      || (wanted.kind ?? null) !== (entry.kind ?? null)
      || (wanted.sessionId ?? null) !== (entry.sessionId ?? null)) mismatched.push(entry.id);
  }
  return {
    missing: expected.filter((entry) => !counts.has(entry.id)).map((entry) => entry.id),
    duplicate: [...counts].filter(([, count]) => count > 1).map(([id]) => id),
    unexpected: [...new Set(unexpected)],
    mismatched: [...new Set(mismatched)],
  };
}

export function reconcileOracleBijection(invocations, mappings, acknowledgments) {
  const byInvocation = new Map();
  const byEvent = new Map();
  for (const mapping of mappings) {
    const invocationRows = byInvocation.get(mapping.invocationId) ?? [];
    invocationRows.push(mapping);
    byInvocation.set(mapping.invocationId, invocationRows);
    const eventInvocations = byEvent.get(mapping.eventUuid) ?? [];
    eventInvocations.push(mapping.invocationId);
    byEvent.set(mapping.eventUuid, eventInvocations);
  }
  const missingCapture = invocations.filter((entry) => (byInvocation.get(entry.invocationId)?.length ?? 0) !== 1).map((entry) => entry.invocationId);
  const reusedEvents = [...byEvent].filter(([, ids]) => new Set(ids).size !== 1 || ids.length !== 1).map(([id]) => id);
  const missingAcknowledgment = mappings.filter((mapping) => !acknowledgments[mapping.eventUuid]).map((mapping) => mapping.eventUuid);
  const duplicateInbox = Object.entries(acknowledgments).filter(([, value]) => value?.inboxIds?.length > 1).map(([id]) => id);
  const verdict = missingCapture.length > 0 || reusedEvents.length > 0 ? "incomplete"
    : missingAcknowledgment.length > 0 || duplicateInbox.length > 0 ? "fail" : "pass";
  return { verdict, missingCapture, reusedEvents, missingAcknowledgment, duplicateInbox };
}

export function recoveryVerdicts(observed, limits) {
  const values = Object.values(observed);
  const incomplete = !values.every((value) => Number.isFinite(value) && value >= 0);
  const failed = !incomplete && (observed.firstSuccessSeconds > limits.firstSuccess || observed.outageSeconds > limits.outage
    || observed.rtoSeconds > limits.rto || observed.catchUpSeconds > limits.catchUp);
  return { verdict: failed ? "fail" : incomplete ? "incomplete" : "pass", ...observed };
}

export function buildEvidenceManifest({ evidenceDirectory, contract, persist = true }) {
  const run = json(join(evidenceDirectory, "run.json"));
  const identities = json(join(evidenceDirectory, "machine-identities.json"));
  const cleanup = json(join(evidenceDirectory, "cleanup.json"));
  const executionProvenance = json(join(evidenceDirectory, "execution-provenance.json"));
  const databaseReadiness = json(join(evidenceDirectory, "database-readiness.json"));
  const cleanupFieldsPass = cleanup.residualResources === 0
    && cleanup.labeledContainers === contract.thresholds.cleanup.labeledContainers
    && cleanup.labeledNetworks === contract.thresholds.cleanup.labeledNetworks
    && cleanup.labeledVolumes === contract.thresholds.cleanup.labeledVolumes
    && cleanup.familyTaggedProviderClusters === contract.thresholds.cleanup.familyTaggedProviderClusters
    && cleanup.privateRootsAbsent === contract.thresholds.cleanup.privateRootsAbsent
    && cleanup.ownedProcessesExited === contract.thresholds.cleanup.ownedProcessesExited
    && Number.isFinite(cleanup.providerDestroyConfirmedWithinSeconds)
    && cleanup.providerDestroyConfirmedWithinSeconds <= contract.thresholds.cleanup.providerDestroyConfirmedWithinSeconds;
  const verifiedCleanup = {
    verdict: cleanup.verdict === "fail" || !cleanupFieldsPass ? "fail" : cleanup.verdict,
    residualResources: cleanup.residualResources,
    labeledContainers: cleanup.labeledContainers,
    labeledNetworks: cleanup.labeledNetworks,
    labeledVolumes: cleanup.labeledVolumes,
    familyTaggedProviderClusters: cleanup.familyTaggedProviderClusters,
    privateRootsAbsent: cleanup.privateRootsAbsent,
    ownedProcessesExited: cleanup.ownedProcessesExited,
    providerDestroyConfirmedWithinSeconds: cleanup.providerDestroyConfirmedWithinSeconds,
  };
  const readinessByMachine = Object.fromEntries(['a', 'b'].map((machine) => [machine, json(join(evidenceDirectory, `machine-${machine}`, "readiness.json"))]));
  const drains = Object.fromEntries(['a', 'b'].map((machine) => [machine, json(join(evidenceDirectory, `machine-${machine}`, "drain.json"))]));
  const samplesByMachine = Object.fromEntries(['a', 'b'].map((machine) => [
    machine,
    ndjson(join(evidenceDirectory, `machine-${machine}`, "samples.ndjson")),
  ]));
  const allSamples = Object.values(samplesByMachine).flat();
  const steady = allSamples.filter((sample) => sample.phase === "steady");
  const phaseControl = json(join(evidenceDirectory, "phase-control.json"));
  const steadyStart = Date.parse(phaseControl.steadyT0At);
  const steadyEnd = steadyStart + contract.timeline[run.profile].steadySeconds * 1000;
  const warmupStart = Date.parse(phaseControl.warmupStartAt);
  const warmupCompletions = ['a', 'b'].map((machine) => json(join(evidenceDirectory, `machine-${machine}`, "warmup-complete.json")));
  const phaseBarriersPass = Number.isFinite(warmupStart) && Number.isFinite(steadyStart)
    && steadyStart - warmupStart >= contract.timeline[run.profile].warmupSeconds * 1000
    && warmupCompletions.every((entry) => {
      const completedAt = Date.parse(entry.at);
      return Number.isFinite(completedAt) && completedAt >= warmupStart && completedAt <= steadyStart;
    });
  const successful = (op, kind) => steady.filter((sample) => sample.op === op
    && (kind === undefined || sample.kind === kind) && sample.outcome === "success");
  const durations = (rows) => rows.map((sample) => sample.durationMs);
  const hook = successful("hook");
  const search = successful("search");
  const store = successful("store");
  const files = {
    hook: sampleFile(evidenceDirectory, "hook-command-samples.ndjson", hook),
    search: sampleFile(evidenceDirectory, "daemon-search-samples.ndjson", search),
    store: sampleFile(evidenceDirectory, "daemon-store-samples.ndjson", store),
    attempts: sampleFile(evidenceDirectory, "steady-attempts.ndjson", steady),
  };
  const minimums = contract.calculations.minimumSamples;
  const slos = [
    ...percentileSlos("hook-command", durations(hook), contract.thresholds.hookCommandMs.pooled, minimums, files.hook),
    ...percentileSlos("daemon-search", durations(search), contract.thresholds.daemonSearchMs[run.lane], minimums, files.search),
    ...percentileSlos("daemon-store", durations(store), contract.thresholds.daemonStoreMs[run.lane], minimums, files.store),
  ];
  slos.push({ id: "profile-certifying", formula: "full profile only", inputs: { count: 1, sampleFile: "run.json" }, threshold: 1, observed: run.profile === "full" ? 1 : 0, verdict: run.profile === "full" ? "pass" : "incomplete" });
  slos.push({ id: "phase-barriers", formula: "both warmups complete before coordinator-issued shared steady T0", inputs: { count: 2, sampleFile: "phase-control.json" }, threshold: 2, observed: phaseBarriersPass ? 2 : 0, verdict: phaseBarriersPass ? "pass" : "fail" });
  const expectedAttempts = ['a', 'b'].flatMap((machine) => createDeterministicSchedule({
    profile: run.profile, machine, runId: run.runId, contract,
  })).map((entry) => ({ id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, sessionId: entry.sessionId }));
  const attemptIdentity = reconcileAttemptIdentity(expectedAttempts, steady);
  const membershipInvalid = steady.filter((sample) => !Number.isFinite(sample.scheduledWallMs)
    || sample.scheduledWallMs < steadyStart || sample.scheduledWallMs >= steadyEnd).map((sample) => sample.id);
  const attemptFailures = [...attemptIdentity.missing, ...attemptIdentity.duplicate, ...attemptIdentity.unexpected, ...attemptIdentity.mismatched, ...membershipInvalid];
  slos.push({
    id: "scheduled-attempt-identity", formula: "exact expected machine/op/kind/session ID set in [T0,T0+steady)",
    inputs: { count: steady.length, sampleFile: files.attempts }, threshold: 0, observed: attemptFailures.length,
    verdict: attemptFailures.length === 0 ? "pass" : "fail",
  });
  const expectedDatabase = run.lane === "local" ? `lcm_harness_${String(run.runId).slice(0, 20)}` : `lcm_cert_${run.runId}`.slice(0, 63);
  const expectedRole = run.lane === "local" ? "lcm_test_runtime" : `lcm_cert_runtime_${run.runId}`.slice(0, 63);
  const expectedExtensions = ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"];
  const actualExtensions = Array.isArray(databaseReadiness.extensions)
    ? databaseReadiness.extensions.map((entry) => `${entry?.name}:${entry?.schema}`).sort()
    : [];
  const readinessOk = Object.values(readinessByMachine).every((entry) => entry.tls?.wrongCa === "certificate-authority"
    && entry.tls?.wrongHostname === "certificate-name")
    && Number.isInteger(databaseReadiness.serverVersionNum)
    && (run.lane === "local" ? databaseReadiness.serverVersionNum === 180004 : Math.floor(databaseReadiness.serverVersionNum / 10_000) === 18)
    && databaseReadiness.databaseName === expectedDatabase
    && databaseReadiness.roleName === expectedRole
    && Number.isInteger(databaseReadiness.serverPort) && databaseReadiness.serverPort > 0
    && (run.lane !== "local" || databaseReadiness.serverPort === 5432)
    && (run.lane !== "managed" || databaseReadiness.providerPort === databaseReadiness.serverPort)
    && actualExtensions.length === expectedExtensions.length
    && expectedExtensions.every((name) => actualExtensions.includes(`${name}:public`))
    && Number.isInteger(databaseReadiness.migrations) && databaseReadiness.migrations > 0
    && databaseReadiness.migrations === databaseReadiness.expectedMigrations
    && typeof databaseReadiness.systemIdentifier === "string" && databaseReadiness.systemIdentifier.length > 0
    && databaseReadiness.role?.superuser === false
    && databaseReadiness.role?.createRole === false
    && databaseReadiness.role?.createDb === false
    && databaseReadiness.residualEmpty === true
    && Object.values(drains).every((entry) => entry.verdict === "pass" && Number.isInteger(entry.expectedEvents)
      && entry.expectedEvents > 0 && entry.acknowledged === entry.expectedEvents
      && entry.remotePruned === entry.expectedEvents && entry.nonterminal === 0 && entry.awaitingRemotePrune === 0);
  const readinessFile = sampleFile(evidenceDirectory, "readiness-witness.ndjson", [{ databaseReadiness, readinessByMachine, drains }]);
  slos.push({
    id: "readiness", formula: "all database, role, TLS, machine and drain predicates",
    inputs: { count: 2, sampleFile: readinessFile }, threshold: 1, observed: readinessOk ? 1 : 0,
    verdict: readinessOk ? "pass" : "fail",
  });
  const drainFailures = Object.values(drains).filter((entry) => entry.verdict !== "pass"
    || entry.expectedEvents <= 0 || entry.acknowledged !== entry.expectedEvents
    || entry.remotePruned !== entry.expectedEvents || entry.nonterminal !== 0 || entry.awaitingRemotePrune !== 0).length;
  slos.push({ id: "final-drain", formula: "all expected oracle rows acknowledged and remotely pruned with zero backlog", inputs: { count: 2, sampleFile: readinessFile }, threshold: 0, observed: drainFailures, verdict: drainFailures === 0 ? "pass" : "fail" });
  for (const [kind, label] of [["user-prompt", "user-prompt"], ["post-tool", "post-tool"]]) {
    const rows = successful("hook", kind);
    const observed = rows.length === 0 ? 0 : nearestRank(durations(rows), 0.95);
    slos.push({
      id: `hook-command.${label}.p95`, formula: "nearest-rank per hook kind", inputs: { count: rows.length, sampleFile: files.hook },
      threshold: contract.thresholds.hookCommandMs.perKindPooledP95, observed,
      verdict: rows.length < contract.thresholds.hookCommandMs.minSuccessesForSubgates ? "incomplete"
        : observed <= contract.thresholds.hookCommandMs.perKindPooledP95 ? "pass" : "fail",
    });
  }
  for (const machine of ['a', 'b']) {
    const rows = samplesByMachine[machine].filter((sample) => sample.phase === "steady" && sample.op === "hook" && sample.outcome === "success");
    const observed = rows.length === 0 ? 0 : nearestRank(durations(rows), 0.95);
    slos.push({
      id: `hook-command.machine-${machine}.p95`, formula: "nearest-rank per machine", inputs: { count: rows.length, sampleFile: files.hook },
      threshold: contract.thresholds.hookCommandMs.perMachineP95, observed,
      verdict: rows.length < contract.thresholds.hookCommandMs.minSuccessesForSubgates ? "incomplete"
        : observed <= contract.thresholds.hookCommandMs.perMachineP95 ? "pass" : "fail",
    });
  }
  const expected = contract.workload.expectedPooledSteadyAttemptsPerLane;
  const scheduled = expected.hookInvocations + expected.daemonSearch + expected.daemonStore;
  const relevant = steady.filter((sample) => ["hook", "search", "store"].includes(sample.op));
  const failures = relevant.filter((sample) => sample.outcome !== "success").length + Math.max(0, scheduled - relevant.length);
  const observedErrorRate = errorRate({ scheduled, failed: Math.min(scheduled, failures) });
  slos.push({
    id: "non-injected-error-rate", formula: "failed or missing steady attempts / scheduled attempts",
    inputs: { count: relevant.length, sampleFile: files.attempts }, threshold: contract.thresholds.errors.nonInjectedErrorRateMax,
    observed: observedErrorRate, verdict: observedErrorRate <= contract.thresholds.errors.nonInjectedErrorRateMax ? "pass" : "fail",
  });
  const ledger = ['a', 'b'].flatMap((machine) => ndjson(join(evidenceDirectory, `machine-${machine}`, "invocations.ndjson")));
  const mappings = ledger.filter((entry) => entry.eventUuid);
  const acknowledgments = Object.assign({}, ...['a', 'b'].map((machine) => {
    const rows = ndjson(join(evidenceDirectory, `machine-${machine}`, "acknowledgments.ndjson"));
    return rows[0] ?? {};
  }));
  const hookById = Object.fromEntries(allSamples.filter((sample) => sample.op === "hook").map((sample) => [sample.id, sample]));
  const invocationOutcomes = allSamples.filter((sample) => sample.op === "hook")
    .map((sample) => ({ invocationId: sample.id, outcome: sample.outcome }));
  const oracle = reconcileOracleBijection(invocationOutcomes, mappings, acknowledgments);
  const lagSamples = [];
  let duplicates = 0;
  for (const mapping of mappings) {
    const invocationId = mapping.invocationId;
    const acknowledgment = acknowledgments[mapping.eventUuid];
    const sample = hookById[invocationId];
    if (!acknowledgment || !sample) continue;
    if (acknowledgment.inboxIds.length > 1) duplicates += 1;
    if (sample.phase === "steady" && sample.outcome === "success") {
      lagSamples.push(Math.max(0, Number(BigInt(acknowledgment.firstSeenMonotonicNs) - BigInt(sample.processExitNs))) / 1e9);
    }
  }
  const lagFile = sampleFile(evidenceDirectory, "acknowledgment-lag-samples.ndjson", lagSamples.map((seconds) => ({ seconds })));
  const oracleFile = sampleFile(evidenceDirectory, "oracle-events.ndjson", mappings.map((mapping) => ({ ...mapping, acknowledgment: acknowledgments[mapping.eventUuid] })));
  const lagP99 = lagSamples.length === 0 ? 0 : nearestRank(lagSamples, 0.99);
  const lagMax = lagSamples.length === 0 ? 0 : Math.max(...lagSamples);
  slos.push(
    { id: "acknowledgment-lag.p99", formula: "nearest-rank", inputs: { count: lagSamples.length, sampleFile: lagFile }, threshold: contract.thresholds.acknowledgmentLagSeconds.p99, observed: lagP99, verdict: lagSamples.length < minimums.p99 ? "incomplete" : lagP99 <= contract.thresholds.acknowledgmentLagSeconds.p99 ? "pass" : "fail" },
    { id: "acknowledgment-lag.max", formula: "maximum", inputs: { count: lagSamples.length, sampleFile: lagFile }, threshold: contract.thresholds.acknowledgmentLagSeconds.max, observed: lagMax, verdict: lagSamples.length === 0 ? "incomplete" : lagMax <= contract.thresholds.acknowledgmentLagSeconds.max ? "pass" : "fail" },
    { id: "oracle-capture-bijection", formula: "one invocation to one unique event", inputs: { count: invocationOutcomes.length, sampleFile: oracleFile }, threshold: 0, observed: oracle.missingCapture.length + oracle.reusedEvents.length, verdict: oracle.verdict === "incomplete" ? "incomplete" : "pass" },
    { id: "event-loss", formula: "captured events without terminal acknowledgment", inputs: { count: mappings.length, sampleFile: oracleFile }, threshold: 0, observed: oracle.missingAcknowledgment.length, verdict: oracle.missingAcknowledgment.length === 0 ? "pass" : "fail" },
    { id: "observed-duplicate-inbox-ids", formula: "event ids with more than one distinct acknowledged inbox id", inputs: { count: mappings.length, sampleFile: oracleFile }, threshold: 0, observed: duplicates + oracle.duplicateInbox.length, verdict: duplicates + oracle.duplicateInbox.length === 0 ? "pass" : "fail" },
  );
  const observerRows = ['a', 'b'].flatMap((machine) => ndjson(join(evidenceDirectory, `machine-${machine}`, "observer.ndjson"))
    .map((entry) => ({ machine, ...entry })));
  const observerIncomplete = observerRows.length === 0
    || ['a', 'b'].some((machine) => !observerRows.some((entry) => entry.machine === machine && entry.status === "ok"))
    || observerRows.some((entry) => entry.incomplete === true || entry.status === "missing" || entry.status === "error" || entry.status === "replaced"
      || !Number.isFinite(entry.gapMs) || entry.gapMs < 0 || entry.gapMs > 2000
      || (entry.status === "ok" && entry.siblingsPresent !== true));
  for (const slo of slos.filter((entry) => entry.id.startsWith("acknowledgment-lag."))) {
    if (slo.verdict !== "fail" && observerIncomplete) slo.verdict = "incomplete";
  }
  slos.push({ id: "observer-completeness", formula: "all one-second polls present, bounded and identity-stable", inputs: { count: observerRows.length, sampleFile: "observer-witness.ndjson" }, threshold: 0, observed: observerRows.filter((entry) => entry.incomplete).length, verdict: observerIncomplete ? "incomplete" : "pass" });
  sampleFile(evidenceDirectory, "observer-witness.ndjson", observerRows);
  const clocks = json(join(evidenceDirectory, "clock-witness.json"));
  const clockRadius = Math.max(0, ...clocks.filter((entry) => typeof entry.radiusMs === "number").map((entry) => entry.radiusMs));
  const clockState = clockVerdict(clocks, contract.thresholds.clock.maxIntervalRadiusMs, Math.floor(contract.timeline.full.steadySeconds / 60) * 2 + 2);
  slos.push({
    id: "clock-interval-radius", formula: "max((t1.wall-t0.wall)/2)", inputs: { count: clocks.length, sampleFile: "clock-witness.json" },
    threshold: contract.thresholds.clock.maxIntervalRadiusMs, observed: clockRadius,
    verdict: clockState,
  });
  const connectionPeak = Math.max(0, ...clocks.map((entry) => Number(entry.databaseConnections)).filter(Number.isFinite));
  const connectionGroups = clocks.flatMap((entry) => entry.connections ?? []);
  const runtimeGroups = connectionGroups.filter((entry) => entry.role_name === databaseReadiness.roleName);
  const runtimeAddresses = new Set(runtimeGroups.map((entry) => entry.client_address).filter((value) => value && value !== "local"));
  const perAddressWithinCap = runtimeGroups.every((entry) => Number(entry.connections) <= 8);
  const capacityMissing = clocks.length === 0 || clocks.some((entry) => !Array.isArray(entry.connections))
    || !Number.isFinite(databaseReadiness.maxConnections) || !Number.isFinite(databaseReadiness.reservedConnections)
    || databaseReadiness.configuredPoolMax !== contract.thresholds.capacity.poolMaxPerRuntime
    || databaseReadiness.setupSessionsClosed !== true || runtimeAddresses.size < 2;
  const capacityLimit = Math.min(contract.thresholds.capacity.totalMax, run.lane === "managed" ? contract.thresholds.capacity.managedUsableBudget : contract.thresholds.capacity.totalMax);
  slos.push({ id: "capacity", formula: "attributed per-address runtime peaks plus coordinator within configured total and usable budget", inputs: { count: clocks.length, sampleFile: "clock-witness.json" }, threshold: capacityLimit, observed: connectionPeak, verdict: capacityMissing ? "incomplete" : connectionPeak <= capacityLimit && perAddressWithinCap ? "pass" : "fail" });
  const faults = existsSync(join(evidenceDirectory, "faults.json"))
    ? json(join(evidenceDirectory, "faults.json"))
    : existsSync(join(evidenceDirectory, "fault-partition-a.json")) ? [json(join(evidenceDirectory, "fault-partition-a.json"))] : [];
  const expectedFaultIds = contract.lanes[run.lane].faults.map((fault) => fault === "partition-machine-a" ? "partition-a" : fault).sort();
  const actualFaultIds = faults.map((fault) => fault.id).sort();
  const faultSetPass = JSON.stringify(expectedFaultIds) === JSON.stringify(actualFaultIds);
  slos.push({ id: "lane-fault-set", formula: "exact contract lane fault IDs", inputs: { count: faults.length, sampleFile: faults.length > 1 ? "faults.json" : "fault-partition-a.json" }, threshold: expectedFaultIds.length, observed: faults.length, verdict: faultSetPass ? "pass" : "fail" });
  for (const fault of faults) {
    const limit = fault.kind === "restart-database"
      ? contract.thresholds.recovery.restartDatabase.rtoSeconds
      : contract.thresholds.recovery.partition.rtoSeconds;
    const affected = fault.kind === "restart-database" ? ['a', 'b'] : ['a'];
    const phase = fault.kind === "restart-database" ? "restart-recovery" : "partition-recovery";
    const faultSamples = allSamples.filter((sample) => sample.phase === phase);
    const windows = affected.map((machine) => recoveryWindowSearch(faultSamples, {
      machine, clearedAtMs: Date.parse(fault.clearedAt), deadlineMs: Date.parse(fault.appliedAt) + limit * 1000,
    }));
    const firstSuccess = Math.min(...faultSamples.filter((sample) => affected.includes(sample.machine) && sample.outcome === "success" && Date.parse(sample.wallEndedAt) >= Date.parse(fault.clearedAt)).map((sample) => (Date.parse(sample.wallEndedAt) - Date.parse(fault.clearedAt)) / 1000));
    const observed = windows.every((entry) => entry.pass) ? Math.max(...windows.map((entry) => (entry.endMs - Date.parse(fault.appliedAt)) / 1000)) : Number.POSITIVE_INFINITY;
    const catchUps = affected.map((machine) => json(join(evidenceDirectory, `machine-${machine}`, `${fault.id === "partition-a" ? "partition" : "restart"}-catch-up.json`)));
    const catchUpComplete = catchUps.every((entry) => entry.verdict === "pass" && entry.remaining === 0 && Number.isFinite(entry.seconds));
    const catchUpSeconds = catchUpComplete ? Math.max(...catchUps.map((entry) => Number(entry.seconds))) : Number.POSITIVE_INFINITY;
    const outageSeconds = (Date.parse(fault.clearedAt) - Date.parse(fault.appliedAt)) / 1000;
    const recoveryKey = fault.kind === "restart-database" ? "restartDatabase" : "partition";
    const recovery = recoveryVerdicts({ firstSuccessSeconds: firstSuccess, outageSeconds, rtoSeconds: observed, catchUpSeconds }, {
      firstSuccess: contract.thresholds.recovery[recoveryKey].firstSuccessAfterClearedSeconds,
      outage: fault.kind === "restart-database" ? contract.thresholds.recovery.restartDatabase.maxOutageSeconds : 60,
      rto: limit,
      catchUp: contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds,
    });
    const faultFile = existsSync(join(evidenceDirectory, "faults.json")) ? "faults.json" : "fault-partition-a.json";
    slos.push({ id: `recovery.${fault.id}`, formula: "first success, outage, 1-second-aligned per-kind 60-second window and acknowledgment catch-up", inputs: { count: faultSamples.length, sampleFile: faultFile }, threshold: limit, observed: Number.isFinite(observed) ? observed : limit + 1, verdict: recovery.verdict });
  }
  const growth = json(join(evidenceDirectory, "database-growth.json"));
  const diagnostics = {
    databaseGrowth: growth,
    submittedPrimaryBytes: allSamples.reduce((sum, sample) => sum + (sample.submittedPrimaryBytes ?? 0), 0),
    submittedEnvelopeBytes: allSamples.reduce((sum, sample) => sum + (sample.submittedEnvelopeBytes ?? 0), 0),
    truncatedRows: allSamples.filter((sample) => sample.storedTruncated === true).length,
    sweepWitnessSha256: ['a', 'b'].map((machine) => createHash("sha256").update(readFileSync(join(evidenceDirectory, `machine-${machine}`, "final-diagnostics.json"))).digest("hex")),
  };
  const manifest = {
    startedAt: run.startedAt,
    lane: run.lane,
    profile: run.profile,
    machines: ['a', 'b'].map((name) => ({ name, ...identities[name] })),
    faults,
    cleanup: verifiedCleanup,
    executionProvenance,
    slos,
    diagnostics,
  };
  if (persist) writeFileSync(join(evidenceDirectory, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export function assembleGateFromEvidence(input, dependencies = {}) {
  const loaded = loadCertificationContract(input.contractPath);
  const manifest = buildEvidenceManifest({ evidenceDirectory: input.evidenceDirectory, contract: loaded.contract, persist: false });
  const execution = manifest.executionProvenance;
  const provenance = dependencies.captureProvenance
    ? dependencies.captureProvenance(input.repositoryRoot)
    : captureExecutionProvenance(input.repositoryRoot, execution.contractSha256, execution.stagedPackageSha256);
  for (const field of ["testedCommit", "testedInputsSha256", "testedInputsCount", "lockfileSha256", "cliSha256", "node"]) {
    if (execution[field] !== provenance[field]) throw new Error(`certification execution provenance differs at ${field}`);
  }
  if (execution.dirty || provenance.dirty || execution.contractSha256 !== loaded.sha256
    || typeof execution.stagedPackageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(execution.stagedPackageSha256)) {
    throw new Error("certification execution provenance is dirty or unbound");
  }
  const gate = assembleCertificationGate({
    ...manifest,
    evidenceDirectory: input.evidenceDirectory,
    contractSha256: loaded.sha256,
    contractStatus: loaded.contract.status,
    approval: loaded.contract.approval,
    provenance: execution,
  });
  const schema = JSON.parse(readFileSync(new URL("../test/certification/evidence-schema.json", import.meta.url), "utf8"));
  const errors = validateEvidence(schema, gate);
  if (errors.length > 0) throw new Error(`certification gate evidence is invalid:\n${errors.join("\n")}`);
  return { gate, paths: writeCertificationGate(gate, input.outputDirectory) };
}

function parse(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  for (const name of ["--repository-root", "--evidence-dir", "--contract", "--output-dir"]) {
    if (!values.get(name)) throw new Error(`missing ${name}`);
  }
  return {
    repositoryRoot: resolve(values.get("--repository-root")),
    evidenceDirectory: resolve(values.get("--evidence-dir")),
    contractPath: resolve(values.get("--contract")),
    outputDirectory: resolve(values.get("--output-dir")),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assembleGateFromEvidence(parse(process.argv.slice(2)));
    process.stdout.write(`${result.paths.json}\n${result.paths.markdown}\n`);
  } catch (error) {
    process.stderr.write(`Certification gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
