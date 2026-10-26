#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureProvenance as captureRepositoryProvenance } from "../test/postgresql/cutover-rehearsal/provenance.ts";
import { validateEvidence } from "../test/postgresql/cutover-rehearsal/check-evidence.ts";
import { loadCertificationContract } from "../test/certification/contract.mjs";
import { assembleCertificationGate, errorRate, evaluatePercentiles, nearestRank, writeCertificationGate } from "../test/certification/slo.mjs";

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

export function buildEvidenceManifest({ evidenceDirectory, contract }) {
  const run = json(join(evidenceDirectory, "run.json"));
  const identities = json(join(evidenceDirectory, "machine-identities.json"));
  const cleanup = json(join(evidenceDirectory, "cleanup.json"));
  const databaseReadiness = json(join(evidenceDirectory, "database-readiness.json"));
  const readinessByMachine = Object.fromEntries(['a', 'b'].map((machine) => [machine, json(join(evidenceDirectory, `machine-${machine}`, "readiness.json"))]));
  const drains = Object.fromEntries(['a', 'b'].map((machine) => [machine, json(join(evidenceDirectory, `machine-${machine}`, "drain.json"))]));
  const samplesByMachine = Object.fromEntries(['a', 'b'].map((machine) => [
    machine,
    ndjson(join(evidenceDirectory, `machine-${machine}`, "samples.ndjson")),
  ]));
  const allSamples = Object.values(samplesByMachine).flat();
  const steady = allSamples.filter((sample) => sample.phase === "steady");
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
  const readinessOk = Object.values(readinessByMachine).every((entry) => entry.tls?.wrongCa === "certificate-authority"
    && entry.tls?.wrongHostname === "certificate-name")
    && databaseReadiness.role?.superuser === false
    && databaseReadiness.role?.createRole === false
    && databaseReadiness.role?.createDb === false
    && Object.values(drains).every((entry) => entry.acknowledged === entry.remotePruned);
  const readinessFile = sampleFile(evidenceDirectory, "readiness-witness.ndjson", [{ databaseReadiness, readinessByMachine, drains }]);
  slos.push({
    id: "readiness", formula: "all database, role, TLS, machine and drain predicates",
    inputs: { count: 2, sampleFile: readinessFile }, threshold: 1, observed: readinessOk ? 1 : 0,
    verdict: readinessOk ? "pass" : "fail",
  });
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
  const mappings = Object.fromEntries(['a', 'b'].flatMap((machine) => ndjson(join(evidenceDirectory, `machine-${machine}`, "invocations.ndjson"))
    .filter((entry) => entry.eventUuid).map((entry) => [entry.invocationId, entry])));
  const acknowledgments = Object.assign({}, ...['a', 'b'].map((machine) => {
    const rows = ndjson(join(evidenceDirectory, `machine-${machine}`, "acknowledgments.ndjson"));
    return rows[0] ?? {};
  }));
  const hookById = Object.fromEntries(allSamples.filter((sample) => sample.op === "hook").map((sample) => [sample.id, sample]));
  const lagSamples = [];
  const successfulHooks = allSamples.filter((sample) => sample.op === "hook" && sample.outcome === "success").length;
  let missingAcknowledgments = Math.max(0, successfulHooks - Object.keys(mappings).length);
  let duplicates = 0;
  for (const [invocationId, mapping] of Object.entries(mappings)) {
    const acknowledgment = acknowledgments[mapping.eventUuid];
    const sample = hookById[invocationId];
    if (!acknowledgment || !sample) { missingAcknowledgments += 1; continue; }
    if (acknowledgment.inboxIds.length > 1) duplicates += 1;
    if (sample.phase === "steady" && sample.outcome === "success") {
      lagSamples.push(Math.max(0, Number(BigInt(acknowledgment.firstSeenMonotonicNs) - BigInt(sample.monotonicEndNs))) / 1e9);
    }
  }
  const lagFile = sampleFile(evidenceDirectory, "acknowledgment-lag-samples.ndjson", lagSamples.map((seconds) => ({ seconds })));
  const oracleFile = sampleFile(evidenceDirectory, "oracle-events.ndjson", Object.entries(mappings).map(([invocationId, mapping]) => ({ invocationId, ...mapping, acknowledgment: acknowledgments[mapping.eventUuid] })));
  const lagP99 = lagSamples.length === 0 ? 0 : nearestRank(lagSamples, 0.99);
  const lagMax = lagSamples.length === 0 ? 0 : Math.max(...lagSamples);
  slos.push(
    { id: "acknowledgment-lag.p99", formula: "nearest-rank", inputs: { count: lagSamples.length, sampleFile: lagFile }, threshold: contract.thresholds.acknowledgmentLagSeconds.p99, observed: lagP99, verdict: lagSamples.length < minimums.p99 ? "incomplete" : lagP99 <= contract.thresholds.acknowledgmentLagSeconds.p99 ? "pass" : "fail" },
    { id: "acknowledgment-lag.max", formula: "maximum", inputs: { count: lagSamples.length, sampleFile: lagFile }, threshold: contract.thresholds.acknowledgmentLagSeconds.max, observed: lagMax, verdict: lagSamples.length === 0 ? "incomplete" : lagMax <= contract.thresholds.acknowledgmentLagSeconds.max ? "pass" : "fail" },
    { id: "event-loss", formula: "captured events without terminal acknowledgment", inputs: { count: Object.keys(mappings).length, sampleFile: oracleFile }, threshold: 0, observed: missingAcknowledgments, verdict: missingAcknowledgments === 0 ? "pass" : "fail" },
    { id: "observed-duplicate-inbox-ids", formula: "event ids with more than one distinct acknowledged inbox id", inputs: { count: Object.keys(mappings).length, sampleFile: oracleFile }, threshold: 0, observed: duplicates, verdict: duplicates === 0 ? "pass" : "fail" },
  );
  const clocks = json(join(evidenceDirectory, "clock-witness.json"));
  const clockRadius = Math.max(0, ...clocks.filter((entry) => typeof entry.radiusMs === "number").map((entry) => entry.radiusMs));
  slos.push({
    id: "clock-interval-radius", formula: "max((t1.wall-t0.wall)/2)", inputs: { count: clocks.length, sampleFile: "clock-witness.json" },
    threshold: contract.thresholds.clock.maxIntervalRadiusMs, observed: clockRadius,
    verdict: clocks.some((entry) => entry.verdict === "incomplete") || clocks.length === 0 ? "incomplete" : clockRadius <= contract.thresholds.clock.maxIntervalRadiusMs ? "pass" : "fail",
  });
  const faults = existsSync(join(evidenceDirectory, "faults.json"))
    ? json(join(evidenceDirectory, "faults.json"))
    : existsSync(join(evidenceDirectory, "fault-partition-a.json")) ? [json(join(evidenceDirectory, "fault-partition-a.json"))] : [];
  for (const fault of faults) {
    const limit = fault.kind === "restart-database"
      ? contract.thresholds.recovery.restartDatabase.rtoSeconds
      : contract.thresholds.recovery.partition.rtoSeconds;
    const observed = (Date.parse(fault.recoveredAt) - Date.parse(fault.appliedAt)) / 1000;
    const faultFile = existsSync(join(evidenceDirectory, "faults.json")) ? "faults.json" : "fault-partition-a.json";
    slos.push({ id: `recovery.${fault.id}`, formula: "recoveredAt - appliedAt", inputs: { count: 1, sampleFile: faultFile }, threshold: limit, observed, verdict: observed <= limit ? "pass" : "fail" });
  }
  const manifest = {
    startedAt: run.startedAt,
    lane: run.lane,
    profile: run.profile,
    machines: ['a', 'b'].map((name) => ({ name, ...identities[name] })),
    faults,
    cleanup: { verdict: cleanup.verdict, residualResources: cleanup.residualResources },
    slos,
  };
  writeFileSync(join(evidenceDirectory, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export function assembleGateFromEvidence(input, dependencies = {}) {
  const loaded = loadCertificationContract(input.contractPath);
  const manifestPath = join(input.evidenceDirectory, "evidence-manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : buildEvidenceManifest({ evidenceDirectory: input.evidenceDirectory, contract: loaded.contract });
  const provenance = (dependencies.captureProvenance ?? captureRepositoryProvenance)(input.repositoryRoot);
  const gate = assembleCertificationGate({
    ...manifest,
    evidenceDirectory: input.evidenceDirectory,
    contractSha256: loaded.sha256,
    contractStatus: loaded.contract.status,
    approval: loaded.contract.approval,
    provenance,
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
