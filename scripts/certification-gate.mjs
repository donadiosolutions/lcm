#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvidence } from "../test/postgresql/cutover-rehearsal/check-evidence.ts";
import { loadCertificationContract } from "../test/certification/contract.mjs";
import { assembleCertificationGate, errorRate, evaluatePercentiles, nearestRank, writeCertificationGate } from "../test/certification/slo.mjs";
import { createDeterministicSchedule, createFaultSchedule } from "../test/certification/schedule.mjs";
import { EXECUTION_HOST_IDENTITY_FIELDS, captureExecutionProvenance, recoveryWindowSearch } from "./certification-harness.mjs";

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function ndjson(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
// Allow five seconds for query duration and scheduler jitter on a 60-second cadence.
const clockCadenceNanos = 65_000_000_000n;

function percentileSlos(id, samples, thresholds, minimums, file) {
  const evaluated = evaluatePercentiles(samples, thresholds, minimums);
  return Object.entries(thresholds).map(([percentile, threshold]) => ({
    id: `${id}.${percentile}`,
    formula: "nearest-rank over successful steady samples",
    inputs: { count: samples.length, sampleFile: file },
    threshold,
    observed: evaluated.observed[percentile] ?? 0,
    verdict: evaluated.verdicts[percentile],
  }));
}

export function clockVerdict(samples, threshold, minimumCount = 2, steadySeconds = 0, steadyStartMs, steadyEndMs) {
  const finite = samples.filter((entry) => Number.isFinite(entry?.radiusMs) && entry.radiusMs >= 0);
  if (finite.some((entry) => entry.radiusMs > threshold || entry.verdict === "fail")) return "fail";
  const validBracket = (entry) => ['a', 'b'].includes(entry.machine)
    && Number.isFinite(entry.t0?.wallMs) && Number.isFinite(entry.t1?.wallMs) && entry.t1.wallMs >= entry.t0.wallMs
    && typeof entry.t0?.monotonicNs === "string" && /^\d+$/u.test(entry.t0.monotonicNs)
    && typeof entry.t1?.monotonicNs === "string" && /^\d+$/u.test(entry.t1.monotonicNs)
    && BigInt(entry.t1.monotonicNs) >= BigInt(entry.t0.monotonicNs)
    && Number.isFinite(Date.parse(entry.serverTime))
    && Math.abs(entry.radiusMs - (entry.t1.wallMs - entry.t0.wallMs) / 2) < 0.001;
  const expectedPerMachine = Math.max(2, Math.floor(steadySeconds / 60) + 1);
  if (samples.length < minimumCount || finite.length !== samples.length || samples.some((entry) => entry.verdict === "incomplete" || !validBracket(entry))) return "incomplete";
  for (const machine of ['a', 'b']) {
    const rows = samples.filter((entry) => entry.machine === machine)
      .sort((left, right) => Number(BigInt(left.t0.monotonicNs) - BigInt(right.t0.monotonicNs)));
    if (rows.length < expectedPerMachine || rows[0]?.phase !== "start" || rows.at(-1)?.phase !== "end") return "incomplete";
    if (Number.isFinite(steadyStartMs) && Number.isFinite(steadyEndMs)
      && (rows[0].t0.wallMs > steadyStartMs || rows.at(-1).t0.wallMs < steadyEndMs)) return "incomplete";
    if (BigInt(rows.at(-1).t0.monotonicNs) - BigInt(rows[0].t0.monotonicNs) < BigInt(steadySeconds) * 1_000_000_000n) return "incomplete";
    if (rows.slice(1).some((entry, index) => BigInt(entry.t0.monotonicNs) - BigInt(rows[index].t0.monotonicNs) > clockCadenceNanos)) return "incomplete";
  }
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
  const checks = [
    [observed.firstSuccessSeconds, limits.firstSuccess],
    [observed.outageSeconds, limits.outage],
    [observed.rtoSeconds, limits.rto],
    [observed.catchUpSeconds, limits.catchUp],
  ];
  const incomplete = checks.some(([value]) => !Number.isFinite(value) || value < 0);
  const failed = limits.knownFailure === true || checks.some(([value, threshold]) => Number.isFinite(value)
    && value >= 0 && Number.isFinite(threshold) && value > threshold);
  return { verdict: failed ? "fail" : incomplete ? "incomplete" : "pass", ...observed };
}

export function buildEvidenceManifest({ evidenceDirectory, contract, persist = true }) {
  const generatedSamples = {};
  const sampleFile = (name, values) => {
    generatedSamples[name] = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
    return name;
  };
  const run = json(join(evidenceDirectory, "run.json"));
  const identities = json(join(evidenceDirectory, "machine-identities.json"));
  const cleanup = json(join(evidenceDirectory, "cleanup.json"));
  const executionProvenance = json(join(evidenceDirectory, "execution-provenance.json"));
  const databaseReadiness = json(join(evidenceDirectory, "database-readiness.json"));
  const preActivationResidualPath = join(evidenceDirectory, "pre-activation-residual.json");
  const setupSessionClosurePath = join(evidenceDirectory, "setup-session-closure.json");
  const preActivationResidual = existsSync(preActivationResidualPath) ? json(preActivationResidualPath) : undefined;
  const setupSessionClosure = existsSync(setupSessionClosurePath) ? json(setupSessionClosurePath) : undefined;
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
    hook: sampleFile("hook-command-samples.ndjson", hook),
    search: sampleFile("daemon-search-samples.ndjson", search),
    store: sampleFile("daemon-store-samples.ndjson", store),
    attempts: sampleFile("steady-attempts.ndjson", steady),
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
  const residualKeys = ["machines", "projects", "conversations", "passive_events"];
  const residualCounts = preActivationResidual?.residual;
  const residualWitnessPresent = Number.isFinite(Date.parse(preActivationResidual?.observedAt))
    && residualCounts && typeof residualCounts === "object"
    && residualKeys.every((key) => Number.isSafeInteger(residualCounts[key]) && residualCounts[key] >= 0);
  const preActivationEmpty = residualWitnessPresent
    && Object.keys(residualCounts).length === residualKeys.length
    && residualKeys.every((key) => residualCounts[key] === 0)
    && preActivationResidual.residualEmpty === true;
  const poolRows = databaseReadiness.poolByMachine;
  const poolEvidencePresent = ["a", "b"].every((machine) => Number.isFinite(Date.parse(poolRows?.[machine]?.observedAt))
    && Number.isSafeInteger(poolRows?.[machine]?.configuredMax) && poolRows[machine].configuredMax > 0)
    && (poolRows?.a?.configuredMax !== poolRows?.b?.configuredMax || Number.isSafeInteger(databaseReadiness.configuredPoolMax));
  const poolConfigMatches = poolEvidencePresent
    && ["a", "b"].every((machine) => poolRows[machine].configuredMax === contract.thresholds.capacity.poolMaxPerRuntime)
    && databaseReadiness.configuredPoolMax === contract.thresholds.capacity.poolMaxPerRuntime;
  const closureRoles = setupSessionClosure?.roles;
  const closureWitnessPresent = Number.isFinite(Date.parse(setupSessionClosure?.observedAt))
    && closureRoles && typeof closureRoles === "object" && !Array.isArray(closureRoles)
    && Object.keys(closureRoles).length === 2
    && Object.values(closureRoles).every((count) => Number.isSafeInteger(count) && count >= 0)
    && Number.isSafeInteger(setupSessionClosure?.totalConnections) && setupSessionClosure.totalConnections >= 0
    && Object.values(closureRoles).reduce((sum, count) => sum + count, 0) === setupSessionClosure.totalConnections
    && typeof setupSessionClosure?.setupSessionsClosed === "boolean"
    && databaseReadiness.setupSessionClosure
    && typeof databaseReadiness.setupSessionsClosed === "boolean";
  const nestedClosure = databaseReadiness.setupSessionClosure;
  const closureConsistent = closureWitnessPresent
    && nestedClosure.observedAt === setupSessionClosure.observedAt
    && nestedClosure.totalConnections === setupSessionClosure.totalConnections
    && nestedClosure.setupSessionsClosed === setupSessionClosure.setupSessionsClosed
    && JSON.stringify(nestedClosure.roles) === JSON.stringify(setupSessionClosure.roles)
    && databaseReadiness.setupSessionsClosed === setupSessionClosure.setupSessionsClosed;
  const setupSessionsClosed = closureConsistent && setupSessionClosure.setupSessionsClosed === true
    && setupSessionClosure.totalConnections === 0 && Object.values(closureRoles).every((count) => count === 0);
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
    && preActivationEmpty
    && Object.values(drains).every((entry) => entry.verdict === "pass" && Number.isInteger(entry.expectedEvents)
      && entry.expectedEvents > 0 && entry.acknowledged === entry.expectedEvents
      && entry.remotePruned === entry.expectedEvents && entry.nonterminal === 0 && entry.awaitingRemotePrune === 0);
  const readinessFile = sampleFile("readiness-witness.ndjson", [{ databaseReadiness, preActivationResidual, readinessByMachine, setupSessionClosure, drains }]);
  const readinessEvidenceMissing = !residualWitnessPresent || !closureWitnessPresent || !poolEvidencePresent;
  slos.push({
    id: "readiness", formula: "all database, role, TLS, machine and drain predicates",
    inputs: { count: 2, sampleFile: readinessFile }, threshold: 1, observed: readinessOk ? 1 : 0,
    verdict: readinessEvidenceMissing ? "incomplete" : readinessOk ? "pass" : "fail",
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
      verdict: observed > contract.thresholds.hookCommandMs.perKindPooledP95 ? "fail"
        : rows.length < contract.thresholds.hookCommandMs.minSuccessesForSubgates ? "incomplete" : "pass",
    });
  }
  for (const machine of ['a', 'b']) {
    const rows = samplesByMachine[machine].filter((sample) => sample.phase === "steady" && sample.op === "hook" && sample.outcome === "success");
    const observed = rows.length === 0 ? 0 : nearestRank(durations(rows), 0.95);
    slos.push({
      id: `hook-command.machine-${machine}.p95`, formula: "nearest-rank per machine", inputs: { count: rows.length, sampleFile: files.hook },
      threshold: contract.thresholds.hookCommandMs.perMachineP95, observed,
      verdict: observed > contract.thresholds.hookCommandMs.perMachineP95 ? "fail"
        : rows.length < contract.thresholds.hookCommandMs.minSuccessesForSubgates ? "incomplete" : "pass",
    });
  }
  // Contract calculations.errorRate: "nonInjected failed attempts / scheduled steady attempts".
  // The population is the complete expected steady schedule for both machines, including
  // session snapshots and explicit compacts; a scheduled operation that failed, was
  // cancelled or is missing counts as a failure.
  const scheduled = expectedAttempts.length;
  const observedById = new Map(steady.map((sample) => [sample.id, sample]));
  const failures = expectedAttempts.filter((sample) => observedById.get(sample.id)?.outcome !== "success").length;
  const observedErrorRate = errorRate({ scheduled, failed: failures });
  slos.push({
    id: "non-injected-error-rate", formula: "failed, cancelled or missing attempts / complete expected steady schedule (hook, search, store, snapshot, compact)",
    inputs: { count: steady.length, sampleFile: files.attempts }, threshold: contract.thresholds.errors.nonInjectedErrorRateMax,
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
  const lagFile = sampleFile("acknowledgment-lag-samples.ndjson", lagSamples.map((seconds) => ({ seconds })));
  const oracleFile = sampleFile("oracle-events.ndjson", mappings.map((mapping) => ({ ...mapping, acknowledgment: acknowledgments[mapping.eventUuid] })));
  const lagP99 = lagSamples.length === 0 ? 0 : nearestRank(lagSamples, 0.99);
  const lagMax = lagSamples.length === 0 ? 0 : Math.max(...lagSamples);
  slos.push(
    { id: "acknowledgment-lag.p99", formula: "nearest-rank", inputs: { count: lagSamples.length, sampleFile: lagFile }, threshold: contract.thresholds.acknowledgmentLagSeconds.p99, observed: lagP99, verdict: lagSamples.length > 0 && lagP99 > contract.thresholds.acknowledgmentLagSeconds.p99 ? "fail" : lagSamples.length < minimums.p99 ? "incomplete" : "pass" },
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
  sampleFile("observer-witness.ndjson", observerRows);
  const clocks = json(join(evidenceDirectory, "clock-witness.json"));
  const clockRadius = Math.max(0, ...clocks.filter((entry) => typeof entry.radiusMs === "number").map((entry) => entry.radiusMs));
  const steadySeconds = contract.timeline[run.profile].steadySeconds;
  const clockState = clockVerdict(clocks, contract.thresholds.clock.maxIntervalRadiusMs,
    Math.floor(steadySeconds / 60) * 2 + 2, steadySeconds, steadyStart, steadyEnd);
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
    || !poolEvidencePresent || !closureWitnessPresent || !closureConsistent || runtimeAddresses.size < 2;
  const capacityLimit = Math.min(contract.thresholds.capacity.totalMax, run.lane === "managed" ? contract.thresholds.capacity.managedUsableBudget : contract.thresholds.capacity.totalMax);
  const capacityFail = (poolEvidencePresent && !poolConfigMatches)
    || (closureWitnessPresent && closureConsistent && !setupSessionsClosed)
    || (closureWitnessPresent && !closureConsistent)
    || connectionPeak > capacityLimit || !perAddressWithinCap;
  slos.push({ id: "capacity", formula: "measured per-machine pools and setup-role closure plus attributed runtime peaks within configured total and usable budget", inputs: { count: clocks.length, sampleFile: "clock-witness.json" }, threshold: capacityLimit, observed: connectionPeak, verdict: capacityFail ? "fail" : capacityMissing ? "incomplete" : "pass" });
  const faults = existsSync(join(evidenceDirectory, "faults.json"))
    ? json(join(evidenceDirectory, "faults.json"))
    : existsSync(join(evidenceDirectory, "fault-partition-a.json")) ? [json(join(evidenceDirectory, "fault-partition-a.json"))] : [];
  const expectedFaultIds = (run.profile === "full" ? contract.lanes[run.lane].faults : [])
    .map((fault) => fault === "partition-machine-a" ? "partition-a" : fault).sort();
  const actualFaultIds = faults.map((fault) => fault.id).sort();
  const faultSetVerdict = run.profile === "smoke" && faults.length === 0 ? "incomplete"
    : JSON.stringify(expectedFaultIds) === JSON.stringify(actualFaultIds) ? "pass" : "fail";
  const faultSetFile = sampleFile("lane-fault-set.ndjson", faults);
  slos.push({ id: "lane-fault-set", formula: "full-profile exact contract lane fault IDs", inputs: { count: faults.length, sampleFile: faultSetFile }, threshold: expectedFaultIds.length, observed: faults.length, verdict: faultSetVerdict });
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
    const firstSuccessByMachine = affected.map((machine) => {
      const successes = faultSamples.filter((sample) => sample.machine === machine && sample.outcome === "success"
        && Date.parse(sample.wallEndedAt) >= Date.parse(fault.clearedAt));
      return successes.length === 0 ? Number.POSITIVE_INFINITY
        : Math.min(...successes.map((sample) => (Date.parse(sample.wallEndedAt) - Date.parse(fault.clearedAt)) / 1000));
    });
    const firstSuccess = Math.max(...firstSuccessByMachine);
    const observed = windows.every((entry) => entry.pass) ? Math.max(...windows.map((entry) => (entry.endMs - Date.parse(fault.appliedAt)) / 1000)) : Number.POSITIVE_INFINITY;
    const catchUps = affected.map((machine) => json(join(evidenceDirectory, `machine-${machine}`, `${fault.id === "partition-a" ? "partition" : "restart"}-catch-up.json`)));
    const catchUpLimit = contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds;
    const catchUpElapsed = catchUps.map((entry) => {
      const clearedAtMs = Date.parse(entry.clearedAt);
      const observedAtMs = Date.parse(entry.observedAt);
      return Number.isFinite(clearedAtMs) && clearedAtMs === Date.parse(fault.clearedAt) && Number.isFinite(observedAtMs) && observedAtMs >= clearedAtMs
        ? (observedAtMs - clearedAtMs) / 1000 : Number.POSITIVE_INFINITY;
    });
    const catchUpComplete = catchUps.every((entry, index) => entry.verdict === "pass" && entry.remaining === 0 && Number.isFinite(catchUpElapsed[index]));
    const catchUpSeconds = catchUpComplete ? Math.max(...catchUpElapsed) : Number.POSITIVE_INFINITY;
    const outageSeconds = (Date.parse(fault.clearedAt) - Date.parse(fault.appliedAt)) / 1000;
    const recoveryKey = fault.kind === "restart-database" ? "restartDatabase" : "partition";
    const expectedFaultAttempts = affected.flatMap((machine) => createFaultSchedule({
      machine, runId: run.runId, phase, durationSeconds: limit,
    }));
    const faultSamplesByMachine = new Map(faultSamples.map((sample) => [sample.id, sample]));
    const faultEvidenceComplete = expectedFaultAttempts.length > 0 && expectedFaultAttempts.every((sample) => {
      const observedSample = faultSamplesByMachine.get(sample.id);
      return observedSample && ["success", "failed"].includes(observedSample.outcome);
    });
    const recovery = recoveryVerdicts({ firstSuccessSeconds: firstSuccess, outageSeconds, rtoSeconds: observed, catchUpSeconds }, {
      firstSuccess: contract.thresholds.recovery[recoveryKey].firstSuccessAfterClearedSeconds,
      ...(fault.kind === "restart-database" ? { outage: contract.thresholds.recovery.restartDatabase.maxOutageSeconds } : {}),
      rto: limit,
      catchUp: catchUpLimit,
      knownFailure: faultEvidenceComplete && (firstSuccess > contract.thresholds.recovery[recoveryKey].firstSuccessAfterClearedSeconds
        || windows.some((entry) => !entry.pass) || catchUps.some((entry, index) => entry.verdict === "fail"
          || entry.remaining > 0 || (Number.isFinite(catchUpElapsed[index]) && catchUpElapsed[index] > catchUpLimit))),
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
    runContractSha256: run.contractSha256,
    runApproval: run.approval,
    runApprovalSha256: run.approvalSha256,
    machines: ['a', 'b'].map((name) => ({ name, ...identities[name] })),
    faults,
    cleanup: verifiedCleanup,
    executionProvenance,
    slos,
    diagnostics,
  };
  if (persist) writeFileSync(join(evidenceDirectory, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { manifest, sampleFiles: generatedSamples };
}

export function assembleGateFromEvidence(input, dependencies = {}) {
  const loaded = loadCertificationContract(input.contractPath);
  const { manifest, sampleFiles } = buildEvidenceManifest({ evidenceDirectory: input.evidenceDirectory, contract: loaded.contract, persist: false });
  const execution = manifest.executionProvenance;
  const schema = JSON.parse(readFileSync(new URL("../test/certification/evidence-schema.json", import.meta.url), "utf8"));
  // The recorded execution-host witness is required, validated against the closed
  // evidence schema before any use, and carried into the public gate as recorded.
  // Gate assembly may legitimately run on another machine, so the witness is never
  // compared with the assembling host.
  const host = execution.executionHost;
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    throw new Error("certification execution provenance is missing its execution-host witness");
  }
  for (const field of EXECUTION_HOST_IDENTITY_FIELDS) {
    if (!(field in host)) throw new Error(`certification execution-host witness is missing ${field}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(host.hostnameSha256 ?? "")) throw new Error("certification execution-host witness has an invalid hostname digest");
  const hostErrors = validateEvidence(schema, host, "#/properties/provenance/properties/executionHost");
  if (hostErrors.length > 0) throw new Error(`certification execution-host witness is invalid:\n${hostErrors.join("\n")}`);
  // Readback recomputes code provenance only. Injecting the validated recorded
  // witness skips live host capture, so nothing named by evidence (such as
  // containerEngine) is executed and the assembler's own environment (such as
  // LCM_CERT_RUNNER_SKU) cannot fail assembly.
  const provenance = dependencies.captureProvenance
    ? dependencies.captureProvenance(input.repositoryRoot)
    : captureExecutionProvenance(input.repositoryRoot, execution.contractSha256, execution.stagedPackageSha256, execution.approvalSha256, {
      executionHost: host,
    });
  for (const field of ["testedCommit", "testedInputsSha256", "testedInputsCount", "lockfileSha256", "cliSha256", "approvalSha256", "node"]) {
    if (execution[field] !== provenance[field]) throw new Error(`certification execution provenance differs at ${field}`);
  }
  if (execution.dirty || provenance.dirty || execution.contractSha256 !== loaded.sha256
    || execution.approvalSha256 !== loaded.approvalSha256
    || manifest.runContractSha256 !== loaded.sha256
    || manifest.runApprovalSha256 !== loaded.approvalSha256
    || JSON.stringify(manifest.runApproval) !== JSON.stringify(loaded.approval)
    || typeof execution.stagedPackageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(execution.stagedPackageSha256)) {
    throw new Error("certification execution provenance or approval is dirty or unbound");
  }
  const gate = assembleCertificationGate({
    ...manifest,
    evidenceDirectory: input.evidenceDirectory,
    contractSha256: loaded.sha256,
    contractStatus: loaded.status,
    approval: loaded.approval,
    provenance: execution,
    sampleFiles,
  });
  const errors = validateEvidence(schema, gate);
  if (errors.length > 0) throw new Error(`certification gate evidence is invalid:\n${errors.join("\n")}`);
  return { gate, paths: writeCertificationGate(gate, input.outputDirectory, sampleFiles) };
}

export function parseGateArguments(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map();
  for (let index = 0; index < normalized.length; index += 2) values.set(normalized[index], normalized[index + 1]);
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
    const result = assembleGateFromEvidence(parseGateArguments(process.argv.slice(2)));
    process.stdout.write(`${result.paths.json}\n${result.paths.markdown}\n`);
  } catch (error) {
    process.stderr.write(`Certification gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
