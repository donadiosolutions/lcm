import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export function nearestRank(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("percentile population must not be empty");
  if (!(quantile > 0 && quantile <= 1)) throw new Error("quantile must be in (0, 1]");
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new Error("percentile population contains an invalid duration");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}
export function evaluatePercentiles(values, thresholds, minimums) {
  const observed = {};
  const verdicts = {};
  const reasons = [];
  for (const [name, threshold] of Object.entries(thresholds)) {
    const minimum = minimums[name];
    if (!Number.isSafeInteger(minimum) || minimum <= 0) throw new Error(`invalid minimum for ${name}`);
    const quantile = Number(name.slice(1)) / 100;
    if (values.length > 0) observed[name] = nearestRank(values, quantile);
    if (values.length > 0 && observed[name] > threshold) {
      reasons.push(`${name} observed ${observed[name]} exceeds ${threshold}`);
      verdicts[name] = "fail";
    } else if (values.length < minimum) {
      reasons.push(`${name} has ${values.length} samples; minimum is ${minimum}`);
      verdicts[name] = "incomplete";
    } else {
      verdicts[name] = "pass";
    }
  }
  const verdict = Object.values(verdicts).includes("fail") ? "fail"
    : Object.values(verdicts).includes("incomplete") ? "incomplete" : "pass";
  return { verdict, verdicts, reasons, observed };
}

export function errorRate({ scheduled, failed }) {
  if (!Number.isSafeInteger(scheduled) || scheduled <= 0) throw new Error("scheduled attempts must be positive");
  if (!Number.isSafeInteger(failed) || failed < 0 || failed > scheduled) throw new Error("failed attempts are invalid");
  return failed / scheduled;
}

export function recoveryWindow(attempts, { startMs, endMs }) {
  const result = {};
  let verdict = "pass";
  for (const kind of ["search", "store"]) {
    const selected = attempts.filter((attempt) => attempt.kind === kind
      && attempt.scheduledAtMs >= startMs && attempt.scheduledAtMs < endMs);
    const succeeded = selected.filter((attempt) => attempt.outcome === "success").length;
    const required = Math.ceil(0.9 * selected.length);
    const pass = selected.length > 0
      && selected.every((attempt) => Number.isFinite(attempt.terminalAtMs))
      && succeeded >= required;
    if (!pass) verdict = "fail";
    result[kind] = { scheduled: selected.length, succeeded, required, pass };
  }
  return { verdict, search: result.search, store: result.store };
}

// A sample is a Buffer, or the gate's list of Buffer chunks. Both are hashed and written
// chunk by chunk, so no sample is ever joined into one string or one Buffer.
const sampleChunks = (sample) => Buffer.isBuffer(sample) ? [sample] : sample;
export function sampleSha256(sample) {
  const hash = createHash("sha256");
  for (const chunk of sampleChunks(sample)) hash.update(chunk);
  return hash.digest("hex");
}
export function writeSampleFile(path, sample) {
  const fd = openSync(path, "w", 0o600);
  try {
    for (const chunk of sampleChunks(sample)) {
      for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    }
  } finally {
    closeSync(fd);
  }
}

export function assembleCertificationGate(input) {
  if (input.contractStatus !== "approved") throw new Error("gate requires an approved contract");
  const approvedAt = Date.parse(input.approval.approvedAt);
  const startedAt = Date.parse(input.startedAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(startedAt) || approvedAt > startedAt) {
    throw new Error("contract approval must precede evidence collection");
  }
  const slos = input.slos.map((slo) => {
    const samplePath = join(input.evidenceDirectory, slo.inputs.sampleFile);
    const bytes = input.sampleFiles?.[slo.inputs.sampleFile] ?? readFileSync(samplePath);
    return {
      ...slo,
      inputs: { ...slo.inputs, sampleSha256: sampleSha256(bytes) },
    };
  });
  const cleanupFails = input.cleanup.verdict === "fail" || input.cleanup.residualResources !== 0;
  const verdict = cleanupFails || slos.some((slo) => slo.verdict === "fail")
    ? "fail"
    : input.cleanup.verdict === "incomplete" || slos.some((slo) => slo.verdict === "incomplete") ? "incomplete" : "pass";
  return {
    schemaVersion: 1,
    contract: { sha256: input.contractSha256, status: input.contractStatus, approval: input.approval },
    startedAt: input.startedAt,
    lane: input.lane,
    profile: input.profile,
    withFaults: input.withFaults === true,
    provenance: input.provenance,
    machines: input.machines,
    faults: input.faults,
    slos,
    cleanup: input.cleanup,
    diagnostics: input.diagnostics,
    verdict,
  };
}

export function writeCertificationGate(gate, outputDirectory, sampleFiles = {}) {
  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, sample] of Object.entries(sampleFiles)) writeSampleFile(join(outputDirectory, name), sample);
  const json = join(outputDirectory, "production-certification-gate.json");
  const markdown = join(outputDirectory, "production-certification-gate.md");
  const rows = gate.slos.map((slo) => `${slo.id} | ${slo.verdict} | ${slo.observed} | ${slo.threshold}`);
  const host = gate.provenance?.executionHost ?? {};
  const observer = gate.provenance?.observerSettings ?? {};
  const show = (value) => value === null || value === undefined ? "n/a" : String(value);
  const memoryGiB = Number.isFinite(host.totalMemoryBytes) ? `${(host.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB` : "n/a";
  const body = [
    "# Production certification gate",
    "",
    `Overall verdict: **${gate.verdict}**`,
    "",
    `Contract SHA-256: \`${gate.contract.sha256}\``,
    `Lane/profile: \`${gate.lane}\` / \`${gate.profile}\`${gate.withFaults ? " with faults (non-certifying)" : ""}`,
    "",
    "## Execution host",
    "",
    `OS: ${show(host.osId)} ${show(host.osVersionId)}; kernel ${show(host.kernelRelease)}; ${show(host.architecture)}`,
    `CPU: ${show(host.cpuModel)} (${show(host.logicalCpus)} logical); memory ${memoryGiB}`,
    `Container engine: ${show(host.containerEngine)} ${show(host.containerEngineVersion)}`,
    `Hostname SHA-256: \`${show(host.hostnameSha256)}\``,
    `Runner: name ${show(host.runnerName)}; os ${show(host.runnerOs)}; arch ${show(host.runnerArch)}; SKU ${show(host.runnerSku)}`,
    "",
    "## Observer reads",
    "",
    `Poll every ${show(observer.pollSeconds)} s; SQLite busy timeout ${show(observer.busyTimeoutMs)} ms; per-query deadline ${show(observer.perQueryDeadlineMs)} ms; maximum poll gap ${show(observer.maxPollGapSeconds)} s`,
    "",
    "SLO | Verdict | Observed | Threshold",
    "--- | --- | ---: | ---:",
    ...rows,
    "",
    `Cleanup: **${gate.cleanup.verdict}** (${gate.cleanup.residualResources} residual resources)`,
    "",
  ].join("\n");
  writeFileSync(json, `${JSON.stringify(gate, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(markdown, body, { encoding: "utf8", mode: 0o600 });
  return { json, markdown };
}
