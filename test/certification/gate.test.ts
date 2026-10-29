import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleGateFromEvidence, buildEvidenceManifest, createSampleBuilder, forEachNdjsonRow, parseGateArguments, readObserverWitness } from "../../scripts/certification-gate.mjs";
import { captureExecutionHost, captureExecutionProvenance } from "../../scripts/certification-harness.mjs";
import { createGitCheckoutFixture } from "./git-checkout-fixture.js";
import { createDeterministicSchedule, createFaultSchedule } from "./schedule.mjs";
import { sampleSha256, writeSampleFile } from "./slo.mjs";
import { observerReadSettings } from "./sqlite-observer-worker.mjs";

function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value)}\n`); }
function writeNdjson(path: string, values: unknown[]): void { writeFileSync(path, values.map((value) => `${JSON.stringify(value)}\n`).join("")); }
function snapshotFiles(root: string, directory = root, files = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) snapshotFiles(root, path, files);
    else files.set(path.slice(root.length + 1), readFileSync(path));
  }
  return files;
}

type FaultLayout = "faults" | "partition-a" | "none";
type MaintenanceFailure = "compact" | "snapshot" | "mixed";
type Variant = { serverPort?: number; providerPort?: number | null; clockRetry?: "recovered" | "exhausted" | "miscounted"; observerRows?: number; withFaults?: boolean; observerGap?: boolean; observerSiblingsPresent?: boolean; extraObserverRow?: Record<string, unknown>; clockBreach?: boolean; clockGap?: boolean; duplicateMapping?: boolean; drainFail?: boolean; capacityPeak?: number; recoveryFail?: boolean; partitionFirstSuccessSeconds?: number; restartBFirstSuccessSeconds?: number; restartBNoSuccess?: boolean; noRecoverySuccess?: boolean; catchUpFail?: boolean; catchUpAtSeconds?: number; missingCatchUpTimestamp?: boolean; readinessInvalid?: boolean; residualOccupied?: boolean; poolConfigMismatch?: boolean; setupSessionOpen?: boolean; phaseEarly?: boolean; profile?: "smoke" | "full"; lane?: "local" | "managed"; faultLayout?: FaultLayout; maintenanceFailure?: MaintenanceFailure; smokeFailure?: boolean; smokeSlow?: boolean; executionHost?: Record<string, unknown> };

// Every scheduled compact, every scheduled snapshot, or every other one of each.
function maintenanceFails(mode: MaintenanceFailure | undefined, op: string, index: number): boolean {
  if (mode === undefined || (op !== "compact" && op !== "snapshot")) return false;
  if (mode === "mixed") return op === "compact" ? index % 2 === 0 : index % 2 === 1;
  return op === mode;
}

// Mirrors the real producers: local full writes faults.json with both faults,
// managed full writes only fault-partition-a.json, and smoke writes no fault file.
function rawFixture(options: Variant = {}) {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-"));
  const output = join(mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-output-")), "gate");
  const contract = JSON.parse(readFileSync(new URL("./contract-v3.json", import.meta.url), "utf8"));
  const contractText = `${JSON.stringify(contract)}\n`;
  const contractPath = join(root, "contract.json");
  writeFileSync(contractPath, contractText);
  const contractSha256 = createHash("sha256").update(contractText).digest("hex");
  const approval = {
    contractSha256,
    approvedBy: "maintainer",
    approvedAt: "2026-10-26T10:00:00.000Z",
    note: "recorded",
    approvalRef: "issue-629",
  };
  const approvalText = `${JSON.stringify(approval)}\n`;
  writeFileSync(join(root, "contract.approval.json"), approvalText);
  const approvalSha256 = createHash("sha256").update(approvalText).digest("hex");
  const executionHost = {
    capturedAt: "2026-10-26T10:00:59.000Z", osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64",
    cpuModel: "AMD EPYC 9R14", logicalCpus: 8, totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: "5.2.3",
    hostnameSha256: "7".repeat(64), runnerName: "blacksmith-8vcpu-ubuntu-2404", runnerOs: "Linux", runnerArch: "X64", runnerSku: "blacksmith-8vcpu-ubuntu-2404",
    ...(options.executionHost ?? {}),
  };
  const provenance = {
    testedCommit: "c".repeat(40), dirty: false, testedInputsSha256: "d".repeat(64), testedInputsCount: 100,
    lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), stagedPackageSha256: "1".repeat(64),
    contractSha256, approvalSha256, node: process.version, executionHost, observerSettings: observerReadSettings(contract),
  };
  const profile = options.profile ?? "full";
  const lane = options.lane ?? "local";
  const faultLayout: FaultLayout = options.faultLayout ?? (profile === "full" ? (lane === "managed" ? "partition-a" : "faults") : "none");
  const runtimeRole = lane === "local" ? "lcm_test_runtime" : "lcm_cert_runtime_run12345";
  const t0 = Date.parse("2026-10-26T10:10:00.000Z");
  writeJson(join(root, "run.json"), { lane, profile, ...(options.withFaults ? { withFaults: true } : {}), runId: "run12345", contractSha256, approval, approvalSha256, startedAt: "2026-10-26T10:01:00.000Z" });
  writeJson(join(root, "phase-control.json"), { warmupStartAt: options.phaseEarly ? "2026-10-26T10:09:00.000Z" : "2026-10-26T10:08:00.000Z", steadyT0At: new Date(t0).toISOString() });
  writeJson(join(root, "execution-provenance.json"), provenance);
  writeJson(join(root, "machine-identities.json"), {
    a: { machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
    b: { machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
  });
  const preActivationResidual = {
    observedAt: "2026-10-26T10:00:30.000Z",
    residual: { machines: options.residualOccupied ? 1 : 0, projects: 0, conversations: 0, passive_events: 0 },
    residualEmpty: !options.residualOccupied,
  };
  const setupSessionClosure = {
    observedAt: "2026-10-26T10:10:00.000Z",
    roles: { migrator: options.setupSessionOpen ? 1 : 0, transfer: 0 },
    totalConnections: options.setupSessionOpen ? 1 : 0,
    setupSessionsClosed: !options.setupSessionOpen,
  };
  writeJson(join(root, "pre-activation-residual.json"), preActivationResidual);
  writeJson(join(root, "setup-session-closure.json"), setupSessionClosure);
  writeJson(join(root, "database-readiness.json"), {
    serverVersionNum: options.readinessInvalid ? 170006 : 180004, serverPort: options.serverPort ?? (lane === "local" ? 5432 : 25060),
    ...(lane === "managed" && options.providerPort !== null ? { providerPort: options.providerPort ?? 25060 } : {}),
    databaseName: lane === "local" ? "lcm_harness_run12345" : "lcm_cert_run12345", roleName: runtimeRole,
    role: { superuser: false, createRole: false, createDb: false }, residualEmpty: false,
    maxConnections: 100, reservedConnections: 3,
    configuredPoolMax: options.poolConfigMismatch ? undefined : 2,
    poolByMachine: {
      a: { observedAt: "2026-10-26T10:09:00.000Z", configuredMax: 2 },
      b: { observedAt: "2026-10-26T10:10:00.000Z", configuredMax: options.poolConfigMismatch ? 3 : 2 },
    },
    setupSessionsClosed: !options.setupSessionOpen, setupSessionClosure,
    extensions: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((name) => ({ name, schema: "public" })),
    migrations: 9, expectedMigrations: 9, systemIdentifier: "123456789",
  });
  writeJson(join(root, "cleanup.json"), {
    verdict: "pass", residualResources: 0, labeledContainers: 0, labeledNetworks: 0,
    labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: true,
    ownedProcessesExited: true, providerDestroyConfirmedWithinSeconds: 0,
  });
  writeJson(join(root, "database-growth.json"), { beforeBytes: 1000, afterBytes: 2000, deltaBytes: 1000 });
  const clockDurationMinutes = Math.floor(contract.timeline[profile].steadySeconds / 60);
  const clocks: Array<Record<string, any>> = Array.from({ length: clockDurationMinutes + 1 }, (_, minute) => ["a", "b"].map((machine) => {
    const index = minute * 2 + (machine === "b" ? 1 : 0);
    const wallMs = t0 + minute * 60_000;
    return {
      phase: minute === 0 ? "start" : minute === clockDurationMinutes ? "end" : "interval",
      machine, radiusMs: options.clockBreach && index === 0 ? 300 : 10,
      verdict: options.clockBreach && index === 0 ? "fail" : "pass",
      t0: { wallMs, monotonicNs: String(1_000_000_000n + BigInt(minute) * 60_000_000_000n) },
      serverTime: new Date(wallMs + 10).toISOString(),
      t1: { wallMs: wallMs + (options.clockBreach && index === 0 ? 600 : 20), monotonicNs: String(1_020_000_000n + BigInt(minute) * 60_000_000_000n) },
      databaseConnections: index === 0 ? options.capacityPeak ?? 8 : 8,
      connections: [{ role_name: runtimeRole, client_address: machine === "a" ? "10.0.0.2" : "10.0.0.3", connections: index === 0 ? options.capacityPeak ?? 8 : 8 }],
    };
  })).flat();
  if (options.clockGap) {
    const row = clocks.find((entry) => entry.machine === "a" && entry.phase === "interval");
    if (row) row.t0.monotonicNs = String(1_000_000_000n + 180_000_000_000n);
  }
  // One interval sample of machine A that the monitor retried: it succeeded 1.4 s late on
  // its third attempt, all five attempts failed, or its attempt number disagrees with the
  // failed attempts it records.
  if (options.clockRetry) {
    const index = clocks.findIndex((entry) => entry.machine === "a" && entry.phase === "interval");
    const row = clocks[index];
    const failed = (attempt: number) => ({
      attempt, errorClass: "Error", code: "ECONNREFUSED",
      startedAtMs: row.t0.wallMs + (attempt - 1) * 700, failedAtMs: row.t0.wallMs + (attempt - 1) * 700 + 200,
    });
    clocks[index] = options.clockRetry === "exhausted"
      ? { phase: "interval", machine: "a", verdict: "incomplete", ...failed(5), failedAttempts: [1, 2, 3, 4].map(failed) }
      : {
        ...row,
        t0: { wallMs: row.t0.wallMs + 1_400, monotonicNs: String(BigInt(row.t0.monotonicNs) + 1_400_000_000n) },
        serverTime: new Date(row.t0.wallMs + 1_410).toISOString(),
        t1: { wallMs: row.t1.wallMs + 1_400, monotonicNs: String(BigInt(row.t1.monotonicNs) + 1_400_000_000n) },
        attempt: 3,
        failedAttempts: (options.clockRetry === "miscounted" ? [1] : [1, 2]).map(failed),
      };
  }
  writeJson(join(root, "clock-witness.json"), clocks);
  const partitionApplied = t0 + 6_060_000;
  const partitionCleared = partitionApplied + 60_500;
  const restartApplied = partitionApplied + 400_000;
  const restartCleared = restartApplied + 60_000;
  const partitionFault = { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: new Date(partitionApplied - 10).toISOString(), appliedAt: new Date(partitionApplied).toISOString(), clearedAt: new Date(partitionCleared).toISOString(), recoveredAt: new Date(partitionCleared + 90_000).toISOString() };
  const restartFault = { id: "restart-database", kind: "restart-database", target: "database", requestedAt: new Date(restartApplied - 10).toISOString(), appliedAt: new Date(restartApplied).toISOString(), clearedAt: new Date(restartCleared).toISOString(), recoveredAt: new Date(restartCleared + 90_000).toISOString() };
  if (faultLayout === "faults") writeFileSync(join(root, "faults.json"), `${JSON.stringify([partitionFault, restartFault], null, 2)}\n`);
  if (faultLayout === "partition-a") writeFileSync(join(root, "fault-partition-a.json"), `${JSON.stringify(partitionFault, null, 2)}\n`);
  for (const machine of ["a", "b"] as const) {
    const directory = join(root, `machine-${machine}`);
    mkdirSync(directory);
    writeJson(join(directory, "warmup-complete.json"), { machine, at: new Date(t0 - 1_000).toISOString() });
    const steady = createDeterministicSchedule({ profile, machine, runId: "run12345", contract }).map((entry) => ({
      ...entry, phase: "steady", scheduledWallMs: t0 + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(t0 + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: options.smokeSlow && entry.op === "search" ? 10_000 : 10,
      outcome: (options.smokeFailure && entry.op === "search" && entry.index === 0) || maintenanceFails(options.maintenanceFailure, entry.op, entry.index) ? "failed" : "success",
      ...(maintenanceFails(options.maintenanceFailure, entry.op, entry.index) ? { errorClass: "CliExit", exitCode: 1 } : {}),
      processExitNs: String(BigInt(1_000_000_000 + entry.index * 10_000_000)),
    }));
    const partition = (faultLayout !== "none" ? createFaultSchedule({ machine, runId: "run12345", phase: "partition-recovery", durationSeconds: 180 }) : []).map((entry) => ({
      ...entry, scheduledWallMs: partitionApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(partitionApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10,
      outcome: options.recoveryFail && machine === "a" || options.partitionFirstSuccessSeconds !== undefined && machine === "a"
        && partitionApplied + entry.offsetSeconds * 1000 + 10 < partitionCleared + options.partitionFirstSuccessSeconds * 1000 ? "failed" : "success",
    }));
    const restart = (faultLayout === "faults" ? createFaultSchedule({ machine, runId: "run12345", phase: "restart-recovery", durationSeconds: 240 }) : []).map((entry) => ({
      ...entry, scheduledWallMs: restartApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(restartApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10, outcome: "success",
    }));
    for (const entry of restart) {
      if (machine === "b" && options.restartBNoSuccess) entry.outcome = "failed";
      if (machine === "b" && options.restartBFirstSuccessSeconds !== undefined
        && Date.parse(entry.wallEndedAt) < restartCleared + options.restartBFirstSuccessSeconds * 1000) entry.outcome = "failed";
      if (machine === "a" && options.noRecoverySuccess) entry.outcome = "failed";
    }
    if (machine === "a" && options.noRecoverySuccess) for (const entry of partition) entry.outcome = "failed";
    const samples = [...steady, ...partition, ...restart];
    writeNdjson(join(directory, "samples.ndjson"), samples);
    const hookSamples = steady.filter((entry) => entry.op === "hook");
    const ledger = hookSamples.flatMap((entry, index) => [
      { invocationId: entry.id, kind: entry.kind, sessionId: entry.sessionId, expectedCount: 1 },
      { invocationId: entry.id, eventUuid: options.duplicateMapping && index === 1 ? `${machine}-event-0` : `${machine}-event-${index}`, machineSequence: String(index).padStart(19, "0") },
    ]);
    writeNdjson(join(directory, "invocations.ndjson"), ledger);
    const acknowledgments = Object.fromEntries(hookSamples.map((entry, index) => [
      `${machine}-event-${index}`,
      { firstSeenMonotonicNs: String(BigInt(entry.processExitNs) + 1_000_000_000n), inboxIds: [`inbox-${machine}-${index}`] },
    ]));
    writeNdjson(join(directory, "acknowledgments.ndjson"), [acknowledgments]);
    // A long observer file carries the cumulative acknowledgment map in every poll, as
    // the real observer does.
    writeNdjson(join(directory, "observer.ndjson"), options.observerRows === undefined ? [
      { status: "ok", gapMs: options.observerGap ? 3000 : 1000, incomplete: false, siblingsPresent: options.observerSiblingsPresent ?? true },
      ...(options.extraObserverRow ? [{ gapMs: 1000, ...options.extraObserverRow }] : []),
    ] : Array.from({ length: options.observerRows }, (_, poll) => ({
      monotonicMs: 1_000 * (poll + 1) + 0.25, gapMs: 1000.5, status: "ok", siblingsPresent: poll % 3 !== 0, incomplete: false,
      acknowledgments: Object.fromEntries(Array.from({ length: Math.floor(poll / 4) }, (_, event) => [
        `${machine}-event-${event}`, { firstSeenMonotonicNs: String(1_000_000_000 + event), inboxIds: [String(event + 1)] },
      ])),
    })));
    writeJson(join(directory, "readiness.json"), { tls: { wrongCa: "certificate-authority", wrongHostname: "certificate-name" } });
    writeJson(join(directory, "partition-catch-up.json"), options.missingCatchUpTimestamp && machine === "a"
      ? { phase: "partition", verdict: "incomplete", seconds: 0, remaining: 0, clearedAt: new Date(partitionCleared).toISOString() }
      : options.catchUpFail && machine === "a"
      ? { phase: "partition", verdict: "fail", seconds: 900, remaining: 1, clearedAt: new Date(partitionCleared).toISOString(), observedAt: new Date(partitionCleared + 900_000).toISOString() }
      : { phase: "partition", verdict: "pass", seconds: options.catchUpAtSeconds ?? 10, remaining: 0, clearedAt: new Date(partitionCleared).toISOString(), observedAt: new Date(partitionCleared + (options.catchUpAtSeconds ?? 10) * 1000).toISOString() });
    writeJson(join(directory, "restart-catch-up.json"), { phase: "restart", verdict: "pass", seconds: 10, remaining: 0, clearedAt: new Date(restartCleared).toISOString(), observedAt: new Date(restartCleared + 10_000).toISOString() });
    writeJson(join(directory, "final-diagnostics.json"), { doctorSha256: "a".repeat(64), doctor: "sweep complete", sweepTimestamps: ["2026-10-26T12:00:00.000Z"] });
    writeJson(join(directory, "drain.json"), options.drainFail
      ? { verdict: "fail", expectedEvents: 600, acknowledged: 599, remotePruned: 599, nonterminal: 1, awaitingRemotePrune: 1 }
      : { verdict: "pass", expectedEvents: 600, acknowledged: 600, remotePruned: 600, nonterminal: 0, awaitingRemotePrune: 0 });
  }
  const current = { ...provenance } as Record<string, unknown>;
  delete current.stagedPackageSha256;
  delete current.contractSha256;
  delete current.observerSettings;
  // The assembling host is a different machine in general: its witness must not be
  // compared against the recorded one.
  current.executionHost = { ...executionHost, hostnameSha256: "8".repeat(64), capturedAt: "2026-10-27T00:00:00.000Z", runnerSku: null };
  return { root, output, contractPath, contractSha256, provenance: current, faults: faultLayout === "faults" ? [partitionFault, restartFault] : faultLayout === "partition-a" ? [partitionFault] : [] };
}

function assemble(fixture: ReturnType<typeof rawFixture>) {
  return assembleGateFromEvidence({
    repositoryRoot: new URL("../..", import.meta.url).pathname,
    evidenceDirectory: fixture.root,
    contractPath: fixture.contractPath,
    outputDirectory: fixture.output,
  }, { captureProvenance: () => fixture.provenance });
}

// Smoke evidence whose recorded code provenance matches a throwaway Git checkout, so
// the gate's real readback (no injected captureProvenance) runs end to end without
// the repository's build output.
function realReadbackInput(executionHost: Record<string, unknown>) {
  const checkout = createGitCheckoutFixture();
  const fixture = rawFixture({ profile: "smoke", executionHost });
  const path = join(fixture.root, "execution-provenance.json");
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  writeJson(path, captureExecutionProvenance(checkout.root, recorded.contractSha256, recorded.stagedPackageSha256, recorded.approvalSha256, {
    executionHost: recorded.executionHost, contract: JSON.parse(readFileSync(fixture.contractPath, "utf8")),
  }));
  return { repositoryRoot: checkout.root, evidenceDirectory: fixture.root, contractPath: fixture.contractPath, outputDirectory: fixture.output };
}

describe("certification raw evidence pipeline", () => {
  it("rebuilds the exact gate from raw evidence and ignores supplied verdicts", () => {
    const fixture = rawFixture();
    writeJson(join(fixture.root, "evidence-manifest.json"), { slos: [{ id: "forged", verdict: "pass" }] });
    const result = assemble(fixture);
    expect(result.gate.verdict).toBe("pass");
    expect(result.gate.contract).toMatchObject({
      sha256: fixture.contractSha256,
      status: "approved",
      approval: { contractSha256: fixture.contractSha256 },
    });
    expect(result.gate.slos.some((slo: any) => slo.id === "forged")).toBe(false);
    expect(JSON.parse(readFileSync(result.paths.json, "utf8"))).toEqual(result.gate);
  });

  it("uses the separate pre-activation empty witness instead of post-activation residual state", () => {
    const gate = assemble(rawFixture()).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("pass");
  });

  it("fails readiness when the measured pre-activation residual is nonempty", () => {
    const gate = assemble(rawFixture({ residualOccupied: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("fail");
  });

  it("accepts a managed server port that differs from the advertised port and publishes both", () => {
    const fixture = rawFixture({ lane: "managed", serverPort: 5432 });
    const gate = assemble(fixture).gate;
    expect(gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("pass");
    const witness = JSON.parse(readFileSync(join(fixture.output, "readiness-witness.ndjson"), "utf8"));
    expect(witness.databaseReadiness).toMatchObject({ serverPort: 5432, providerPort: 25060 });
  });

  it("still fails readiness without a managed advertised port or with a local server port other than 5432", () => {
    for (const variant of [{ lane: "managed" as const, providerPort: null }, { lane: "local" as const, serverPort: 15432 }]) {
      expect(assemble(rawFixture(variant)).gate.slos.find((slo: any) => slo.id === "readiness")?.verdict).toBe("fail");
    }
  }, 15_000);

  it("fails capacity when measured pool configuration differs from the contract", () => {
    const gate = assemble(rawFixture({ poolConfigMismatch: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("fail");
  });

  it("fails capacity when setup-role sessions remain after activation", () => {
    const gate = assemble(rawFixture({ setupSessionOpen: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("fail");
  });

  it("keeps a definite clock breach above missing observer evidence", () => {
    expect(assemble(rawFixture({ clockBreach: true, observerGap: true })).gate.verdict).toBe("fail");
  });

  it("rejects a byte-identical alternate contract with a different approval receipt", () => {
    const fixture = rawFixture();
    writeJson(join(fixture.root, "contract.approval.json"), {
      contractSha256: fixture.contractSha256,
      approvedBy: "different approver",
      approvedAt: "2026-10-26T10:00:00.000Z",
      note: "substituted",
      approvalRef: "different receipt",
    });
    expect(() => assemble(fixture)).toThrow("approval");
  });

  it("reassembles the same raw evidence without adding or changing evidence files", () => {
    const fixture = rawFixture();
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    const second = assemble(fixture).gate;
    expect(second).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("can retry after a late provenance rejection without poisoning raw evidence", () => {
    const fixture = rawFixture();
    const before = snapshotFiles(fixture.root);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: new URL("../..", import.meta.url).pathname,
      evidenceDirectory: fixture.root,
      contractPath: fixture.contractPath,
      outputDirectory: fixture.output,
    }, { captureProvenance: () => ({ ...fixture.provenance, testedCommit: "e".repeat(40) }) })).toThrow("provenance");
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(assemble(fixture).gate.verdict).toBe("pass");
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("keeps healthy smoke evidence incomplete and never non-certifying pass", () => {
    const gate = assemble(rawFixture({ profile: "smoke" })).gate;
    expect(gate.verdict).toBe("incomplete");
    expect(gate.slos.find((slo: any) => slo.id === "profile-certifying")?.verdict).toBe("incomplete");
    expect(gate.slos.find((slo: any) => slo.id === "lane-fault-set")?.verdict).toBe("incomplete");
  });

  it("keeps observed smoke failures as fail", () => {
    const gate = assemble(rawFixture({ profile: "smoke", smokeFailure: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "non-injected-error-rate")?.verdict).toBe("fail");
    expect(gate.verdict).toBe("fail");
  });

  it("fails an observed smoke percentile breach even below the full sample floor", () => {
    const gate = assemble(rawFixture({ profile: "smoke", smokeSlow: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "daemon-search.p50")?.verdict).toBe("fail");
    expect(gate.verdict).toBe("fail");
  });

  it("rejects a clock cadence gap for one machine despite sufficient total samples", () => {
    const gate = assemble(rawFixture({ clockGap: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(gate.verdict).toBe("incomplete");
  });

  it("scores a clock sample that succeeded on a recorded retry like any other sample", () => {
    const gate = assemble(rawFixture({ clockRetry: "recovered" })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("pass");
    expect(gate.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("pass");
    expect(gate.verdict).toBe("pass");
  });

  it("keeps a clock sample incomplete when every attempt failed or its attempt count disagrees with its failures", () => {
    const exhausted = assemble(rawFixture({ clockRetry: "exhausted" })).gate;
    expect(exhausted.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(exhausted.slos.find((slo: any) => slo.id === "capacity")?.verdict).toBe("incomplete");
    expect(exhausted.verdict).toBe("incomplete");
    const miscounted = assemble(rawFixture({ clockRetry: "miscounted" })).gate;
    expect(miscounted.slos.find((slo: any) => slo.id === "clock-interval-radius")?.verdict).toBe("incomplete");
    expect(miscounted.verdict).toBe("incomplete");
  }, 15_000);

  it("accepts partition recovery after the contracted 60-second reconnect plus verification overhead", () => {
    const gate = assemble(rawFixture()).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("pass");
  });

  it("checks restart first-success latency independently for each machine", () => {
    const gate = assemble(rawFixture({ restartBFirstSuccessSeconds: 45 })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.restart-database")?.verdict).toBe("fail");
  });

  it("fails restart recovery when machine B has no post-clearance success", () => {
    const gate = assemble(rawFixture({ restartBNoSuccess: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.restart-database")?.verdict).toBe("fail");
  });

  it("measures acknowledgment catch-up from fault clearance, not helper start", () => {
    const gate = assemble(rawFixture({ catchUpAtSeconds: 950 })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("treats complete recovery evidence with no success as fail over missing measures", () => {
    const gate = assemble(rawFixture({ noRecoverySuccess: true, catchUpFail: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("keeps a known first-success breach as fail when catch-up evidence is missing", () => {
    const gate = assemble(rawFixture({ partitionFirstSuccessSeconds: 45, missingCatchUpTimestamp: true })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "recovery.partition-a")?.verdict).toBe("fail");
  });

  it("marks an observer gap incomplete when no definite gate fails", () => {
    expect(assemble(rawFixture({ observerGap: true })).gate.verdict).toBe("incomplete");
  });

  it("passes good observer polls whose -wal/-shm siblings were absent", () => {
    const gate = assemble(rawFixture({ observerSiblingsPresent: false })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "observer-completeness")).toMatchObject({ verdict: "pass", observed: 0 });
    expect(gate.verdict).toBe("pass");
  });

  it.each(["error", "replaced", "missing"])("keeps a raw %s poll incomplete even when the row claims completeness", (status) => {
    const gate = assemble(rawFixture({ extraObserverRow: { status, incomplete: false } })).gate;
    expect(gate.slos.find((slo: any) => slo.id === "observer-completeness")?.verdict).toBe("incomplete");
    expect(gate.verdict).toBe("incomplete");
  });

  it.each([
    [{ duplicateMapping: true }, "oracle-capture-bijection"],
    [{ drainFail: true }, "final-drain"],
    [{ capacityPeak: 20 }, "capacity"],
    [{ recoveryFail: true }, "recovery.partition-a"],
    [{ catchUpFail: true }, "recovery.partition-a"],
    [{ readinessInvalid: true }, "readiness"],
    [{ phaseEarly: true }, "phase-barriers"],
  ] as const)("rejects raw acceptance failure %j", (variant, sloId) => {
    const gate = assemble(rawFixture(variant)).gate;
    expect(gate.slos.find((slo: any) => slo.id === sloId)?.verdict).not.toBe("pass");
    expect(gate.verdict).not.toBe("pass");
  });
});

// The gate's earlier reading of the observer files: each file as one string and the
// merged witness as one joined string. The streamed reading must reproduce its bytes.
function joinedObserverWitness(root: string): Buffer {
  return Buffer.from(["a", "b"].flatMap((machine) => readFileSync(join(root, `machine-${machine}`, "observer.ndjson"), "utf8")
    .split(/\r?\n/u).filter(Boolean).map((line) => ({ machine, ...JSON.parse(line) })))
    .map((row) => `${JSON.stringify(row)}\n`).join(""));
}
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("streamed evidence reads and chunked samples", () => {
  function ndjsonFile(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "lcm-cert-ndjson-")), "rows.ndjson");
    writeFileSync(path, text);
    return path;
  }
  function streamedRows(path: string, chunkSizes?: { chunkBytes: number }): unknown[] {
    const rows: unknown[] = [];
    forEachNdjsonRow(path, (row: unknown) => { rows.push(row); }, chunkSizes);
    return rows;
  }

  it("splits rows exactly as the whole-text split does at every chunk size", () => {
    const path = ndjsonFile([
      '{"n":1,"text":"ação 🙂"}\r\n', "\n", `{"n":2,"long":"${"x".repeat(150)}"}\n`, "\r\n", '{"n":3,"text":"🙂🙂"}\r\n', '{"n":4}',
    ].join(""));
    const whole = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    expect(whole.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    for (const chunkBytes of [1, 2, 3, 5, 64]) expect(streamedRows(path, { chunkBytes })).toEqual(whole);
    expect(streamedRows(path)).toEqual(whole);
  });

  it("reads the next chunk only after the rows before it are visited", () => {
    const path = ndjsonFile('{"n":1}\n{"n":2}\n');
    const seen: number[] = [];
    // A whole-file read would miss the row appended while the first row is visited.
    forEachNdjsonRow(path, (row: { n: number }) => {
      seen.push(row.n);
      if (row.n === 1) appendFileSync(path, '{"n":3}\n');
    }, { chunkBytes: 8 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("flushes sample chunks only at row boundaries, so multibyte text and empty samples keep their bytes", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ index, text: "ação 🙂".repeat(index % 7) }));
    const builder = createSampleBuilder({ chunkChars: 40 });
    for (const row of rows) builder.append(row);
    const chunks = builder.finish();
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) expect(chunk.toString("utf8").endsWith("\n")).toBe(true);
    expect(Buffer.concat(chunks).equals(Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join("")))).toBe(true);
    const empty = createSampleBuilder().finish();
    expect(empty).toEqual([]);
    expect(sampleSha256(empty)).toBe(sha256Hex(Buffer.alloc(0)));
  });

  it("merges both observer files into a chunked witness byte-identical to the joined witness", () => {
    const fixture = rawFixture({ profile: "smoke", observerRows: 240 });
    const golden = joinedObserverWitness(fixture.root);
    const { polls, witness } = readObserverWitness(fixture.root, { chunkBytes: 64, chunkChars: 512 });
    expect(Buffer.concat(witness).equals(golden)).toBe(true);
    expect(sampleSha256(witness)).toBe(sha256Hex(golden));
    expect(polls).toHaveLength(480);
    expect(polls[0]).toEqual({ machine: "a", status: "ok", incomplete: false, gapMs: 1000.5 });
    expect(polls.at(-1)).toEqual({ machine: "b", status: "ok", incomplete: false, gapMs: 1000.5 });
    const longestRow = Math.max(...golden.toString("utf8").split("\n").map((line) => line.length + 1));
    expect(witness.length).toBeGreaterThan(100);
    for (const chunk of witness) expect(chunk.length).toBeLessThan(512 + longestRow);
    const written = join(mkdtempSync(join(tmpdir(), "lcm-cert-witness-")), "observer-witness.ndjson");
    writeSampleFile(written, witness);
    expect(readFileSync(written).equals(golden)).toBe(true);
  });

  it("builds the same manifest and samples at any chunk size and publishes the witness unchanged", () => {
    const fixture = rawFixture({ profile: "smoke", observerRows: 240 });
    const contract = JSON.parse(readFileSync(fixture.contractPath, "utf8"));
    const tiny = buildEvidenceManifest({ evidenceDirectory: fixture.root, contract, persist: false, chunkSizes: { chunkBytes: 7, chunkChars: 64 } });
    const standard = buildEvidenceManifest({ evidenceDirectory: fixture.root, contract, persist: false });
    expect(tiny.manifest).toEqual(standard.manifest);
    expect(Object.keys(tiny.sampleFiles)).toEqual(Object.keys(standard.sampleFiles));
    for (const [name, sample] of Object.entries(standard.sampleFiles)) {
      expect(Buffer.concat(tiny.sampleFiles[name]).equals(Buffer.concat(sample as Buffer[]))).toBe(true);
    }
    const golden = joinedObserverWitness(fixture.root);
    const result = assemble(fixture);
    expect(result.gate.slos.find((slo: any) => slo.id === "observer-completeness")).toMatchObject({
      verdict: "pass", observed: 0, inputs: { count: 480, sampleSha256: sha256Hex(golden) },
    });
    expect(readFileSync(join(fixture.output, "observer-witness.ndjson")).equals(golden)).toBe(true);
  }, 15_000);
});

describe("lane fault-set sample from real producer layouts", () => {
  const ndjson = (values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join("");
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const faultSetOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "lane-fault-set");

  it("assembles managed full evidence that records only fault-partition-a.json", () => {
    const fixture = rawFixture({ lane: "managed" });
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "fault-partition-a.json"))).toBe(true);
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    expect(first.lane).toBe("managed");
    expect(first.verdict).toBe("pass");
    expect(faultSetOf(first)).toMatchObject({
      verdict: "pass", observed: 1, threshold: 1,
      inputs: { count: 1, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256(ndjson(fixture.faults)) },
    });
    expect(first.faults).toEqual(fixture.faults);
    expect(first.slos.find((slo: any) => slo.id === "recovery.partition-a")).toMatchObject({ verdict: "pass", inputs: { sampleFile: "fault-partition-a.json" } });
    expect(first.slos.some((slo: any) => slo.id === "recovery.restart-database")).toBe(false);
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe(ndjson(fixture.faults));
    expect(assemble(fixture).gate).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("assembles smoke evidence that records no fault file at all", () => {
    const fixture = rawFixture({ profile: "smoke" });
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "fault-partition-a.json"))).toBe(false);
    const before = snapshotFiles(fixture.root);
    const first = assemble(fixture).gate;
    expect(first.verdict).toBe("incomplete");
    expect(first.faults).toEqual([]);
    expect(faultSetOf(first)).toMatchObject({
      verdict: "incomplete", observed: 0, threshold: 0,
      inputs: { count: 0, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256("") },
    });
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe("");
    expect(assemble(fixture).gate).toEqual(first);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  }, 15_000);

  it("derives the local full fault-set sample from faults.json without rewriting it", () => {
    const fixture = rawFixture();
    expect(existsSync(join(fixture.root, "faults.json"))).toBe(true);
    const rawBytes = readFileSync(join(fixture.root, "faults.json"));
    const first = assemble(fixture).gate;
    expect(first.verdict).toBe("pass");
    expect(faultSetOf(first)).toMatchObject({
      verdict: "pass", observed: 2, threshold: 2,
      inputs: { count: 2, sampleFile: "lane-fault-set.ndjson", sampleSha256: sha256(ndjson(fixture.faults)) },
    });
    expect(first.slos.find((slo: any) => slo.id === "recovery.restart-database")).toMatchObject({ verdict: "pass", inputs: { sampleFile: "faults.json" } });
    expect(readFileSync(join(fixture.output, "lane-fault-set.ndjson"), "utf8")).toBe(ndjson(fixture.faults));
    expect(readFileSync(join(fixture.root, "faults.json"))).toEqual(rawBytes);
    expect(existsSync(join(fixture.root, "lane-fault-set.ndjson"))).toBe(false);
  });

  it("fails rather than throws when a full run records fewer faults than its lane requires", () => {
    const fixture = rawFixture({ lane: "local", faultLayout: "partition-a" });
    const gate = assemble(fixture).gate;
    expect(faultSetOf(gate)).toMatchObject({ verdict: "fail", observed: 1, threshold: 2, inputs: { count: 1, sampleFile: "lane-fault-set.ndjson" } });
    expect(gate.verdict).toBe("fail");
  });

  it("evaluates a fault smoke against the lane's contract faults and keeps it non-certifying", () => {
    const fixture = rawFixture({ profile: "smoke", withFaults: true, faultLayout: "faults" });
    const result = assemble(fixture);
    const gate = result.gate;
    expect(gate.withFaults).toBe(true);
    expect(faultSetOf(gate)).toMatchObject({ verdict: "pass", observed: 2, threshold: 2, formula: "full profile or smoke with faults: exact contract lane fault IDs" });
    for (const id of ["recovery.partition-a", "recovery.restart-database"]) {
      expect(gate.slos.find((slo: any) => slo.id === id)).toMatchObject({ verdict: "pass", inputs: { sampleFile: "faults.json" } });
    }
    expect(gate.slos.find((slo: any) => slo.id === "profile-certifying")).toMatchObject({ verdict: "incomplete", observed: 0 });
    expect(gate.verdict).toBe("incomplete");
    expect(readFileSync(result.paths.markdown, "utf8")).toContain("Lane/profile: `local` / `smoke` with faults (non-certifying)");
  });

  it("fails a fault smoke whose recorded faults differ from the lane's contract faults", () => {
    for (const faultLayout of ["partition-a", "none"] as const) {
      const gate = assemble(rawFixture({ profile: "smoke", withFaults: true, faultLayout })).gate;
      expect(faultSetOf(gate)).toMatchObject({ verdict: "fail", threshold: 2, observed: faultLayout === "none" ? 0 : 1 });
      expect(gate.verdict).toBe("fail");
    }
  });

  it("publishes withFaults false for runs without the option", () => {
    for (const profile of ["smoke", "full"] as const) {
      const result = assemble(rawFixture({ profile }));
      expect(result.gate.withFaults).toBe(false);
      expect(readFileSync(result.paths.markdown, "utf8")).not.toContain("with faults");
    }
  });
});

describe("scheduled maintenance outcomes gate the non-injected error rate", () => {
  const errorRateOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "non-injected-error-rate");
  const identityOf = (gate: any) => gate.slos.find((slo: any) => slo.id === "scheduled-attempt-identity");
  // Full profile per machine: 600 hooks + 1200 searches + 600 stores + 100 snapshots + 20 compacts = 2520; pooled 5040.
  const fullScheduled = 5040;

  it.each([["local"], ["managed"]] as const)("counts the complete %s steady schedule including snapshot and compact", (lane) => {
    const gate = assemble(rawFixture({ lane })).gate;
    expect(gate.verdict).toBe("pass");
    expect(errorRateOf(gate)).toMatchObject({ verdict: "pass", observed: 0, inputs: { count: fullScheduled } });
    expect(errorRateOf(gate).formula).toMatch(/snapshot, compact/u);
  });

  it.each([
    ["local", "compact", 40],
    ["local", "snapshot", 200],
    ["local", "mixed", 120],
    ["managed", "compact", 40],
    ["managed", "snapshot", 200],
    ["managed", "mixed", 120],
  ] as const)("fails otherwise passing %s evidence when %s maintenance operations fail", (lane, mode, failed) => {
    const gate = assemble(rawFixture({ lane, maintenanceFailure: mode })).gate;
    expect(identityOf(gate).verdict).toBe("pass");
    expect(errorRateOf(gate)).toMatchObject({ verdict: "fail", inputs: { count: fullScheduled } });
    expect(errorRateOf(gate).observed).toBeCloseTo(failed / fullScheduled, 12);
    expect(gate.verdict).toBe("fail");
  });

  it("fails smoke evidence whose only failure is a compact", () => {
    const gate = assemble(rawFixture({ profile: "smoke", maintenanceFailure: "compact" })).gate;
    expect(errorRateOf(gate)).toMatchObject({ verdict: "fail", inputs: { count: 102 } });
    expect(errorRateOf(gate).observed).toBeCloseTo(2 / 102, 12);
    expect(gate.verdict).toBe("fail");
  });
});

describe("execution-host witness in the public gate", () => {
  it("carries the recorded witness into gate provenance and markdown as recorded, not the assembling host", () => {
    const fixture = rawFixture();
    const result = assemble(fixture);
    expect(result.gate.provenance.executionHost).toMatchObject({
      osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64", cpuModel: "AMD EPYC 9R14", logicalCpus: 8,
      totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: "5.2.3", hostnameSha256: "7".repeat(64),
      runnerName: "blacksmith-8vcpu-ubuntu-2404", runnerOs: "Linux", runnerArch: "X64", runnerSku: "blacksmith-8vcpu-ubuntu-2404",
    });
    const markdown = readFileSync(result.paths.markdown, "utf8");
    expect(markdown).toContain("## Execution host");
    expect(markdown).toContain("OS: ubuntu 24.04; kernel 6.8.0-45-generic; x64");
    expect(markdown).toContain("CPU: AMD EPYC 9R14 (8 logical); memory 30.7 GiB");
    expect(markdown).toContain("Container engine: podman 5.2.3");
    expect(markdown).toContain(`Hostname SHA-256: \`${"7".repeat(64)}\``);
    expect(markdown).toContain("SKU blacksmith-8vcpu-ubuntu-2404");
    expect(markdown).not.toContain("8".repeat(64));
  });

  it("accepts null runner metadata and SKU without failing and renders them as n/a", () => {
    const fixture = rawFixture({ executionHost: { runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null, containerEngineVersion: null } });
    const result = assemble(fixture);
    expect(result.gate.verdict).toBe("pass");
    expect(result.gate.provenance.executionHost).toMatchObject({ runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null });
    expect(readFileSync(result.paths.markdown, "utf8")).toContain("Runner: name n/a; os n/a; arch n/a; SKU n/a");
  });

  it("refuses evidence without a host witness, with a malformed hostname digest, or with an unknown witness key", () => {
    const missing = rawFixture();
    const recorded = JSON.parse(readFileSync(join(missing.root, "execution-provenance.json"), "utf8"));
    delete recorded.executionHost;
    writeJson(join(missing.root, "execution-provenance.json"), recorded);
    expect(() => assemble(missing)).toThrow("execution-host witness");
    expect(() => assemble(rawFixture({ executionHost: { hostnameSha256: "lcm-testbox" } }))).toThrow("hostname digest");
    expect(() => assemble(rawFixture({ executionHost: { rawHostname: "leak" } }))).toThrow("unexpected key");
  });
});

describe("observer read settings in the public gate", () => {
  // Rewrites the recorded settings; undefined removes them.
  function withObserverSettings(observerSettings: unknown) {
    const fixture = rawFixture({ profile: "smoke" });
    const path = join(fixture.root, "execution-provenance.json");
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    if (observerSettings === undefined) delete recorded.observerSettings;
    else recorded.observerSettings = observerSettings;
    writeJson(path, recorded);
    return fixture;
  }
  const recorded = { pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250, maxPollGapSeconds: 2 };

  it("carries the recorded settings into the gate JSON and markdown", () => {
    const result = assemble(rawFixture({ profile: "smoke" }));
    expect(result.gate.provenance.observerSettings).toEqual(recorded);
    expect(JSON.parse(readFileSync(result.paths.json, "utf8")).provenance.observerSettings).toEqual(recorded);
    const markdown = readFileSync(result.paths.markdown, "utf8");
    expect(markdown).toContain("## Observer reads");
    expect(markdown).toContain("Poll every 1 s; SQLite busy timeout 200 ms; per-query deadline 250 ms; maximum poll gap 2 s");
  });

  it("refuses evidence without settings or whose busy timeout is not shorter than the per-query deadline", () => {
    const missing = withObserverSettings(undefined);
    const captureProvenance = vi.fn(() => missing.provenance);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: missing.root, evidenceDirectory: missing.root, contractPath: missing.contractPath, outputDirectory: missing.output,
    }, { captureProvenance })).toThrow("missing its observer read settings");
    expect(captureProvenance).not.toHaveBeenCalled();
    expect(existsSync(missing.output)).toBe(false);
    for (const busyTimeoutMs of [250, 300]) {
      expect(() => assemble(withObserverSettings({ ...recorded, busyTimeoutMs }))).toThrow("busy timeout is not shorter than its per-query deadline");
    }
  });

  it("validates the settings against the closed schema and the values the contract and observer code produce", () => {
    expect(() => assemble(withObserverSettings({ ...recorded, databasePath: "/home/user/.lcm/events/project.db" }))).toThrow("unexpected key databasePath");
    expect(() => assemble(withObserverSettings({ pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250 }))).toThrow("missing maxPollGapSeconds");
    expect(() => assemble(withObserverSettings({ ...recorded, pollSeconds: 1.5 }))).toThrow("observer read settings are invalid");
    expect(() => assemble(withObserverSettings({ ...recorded, pollSeconds: 2 }))).toThrow("do not match the contract and observer code at pollSeconds");
    expect(() => assemble(withObserverSettings({ ...recorded, busyTimeoutMs: 100 }))).toThrow("do not match the contract and observer code at busyTimeoutMs");
  });
});

describe("gate readback never captures the assembling host", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("does not execute a container engine named by the recorded witness", () => {
    const bin = mkdtempSync(join(tmpdir(), "lcm-cert-engine-"));
    const marker = join(bin, "executed");
    writeFileSync(join(bin, "lcm-cert-sentinel-engine"), `#!/bin/sh\n: > '${marker}'\necho 9.9.9\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const result = assembleGateFromEvidence(realReadbackInput({ containerEngine: "lcm-cert-sentinel-engine" }));
    expect(result.gate.provenance.executionHost.containerEngine).toBe("lcm-cert-sentinel-engine");
    expect(existsSync(marker)).toBe(false);
  });

  it("assembles despite an invalid assembler runner SKU and publishes the recorded witness without the raw hostname", () => {
    vi.stubEnv("LCM_CERT_RUNNER_SKU", "not a valid sku");
    const witness = captureExecutionHost({
      environment: { RUNNER_NAME: "lcm-testbox-07", RUNNER_OS: "Linux", RUNNER_ARCH: "X64", LCM_CERT_RUNNER_SKU: "blacksmith-8vcpu-ubuntu-2404" },
      containerCli: "podman", readFile: () => "ID=ubuntu\nVERSION_ID=24.04\n", engineVersion: () => "5.8.4",
      os: { arch: () => "x64", cpus: () => Array.from({ length: 8 }, () => ({ model: "AMD EPYC 9R14" })), hostname: () => "lcm-testbox-07", release: () => "6.8.0-45-generic", totalmem: () => 33_000_000_000 },
    });
    const result = assembleGateFromEvidence(realReadbackInput(witness));
    expect(result.gate.provenance.executionHost).toEqual(witness);
    expect(result.gate.provenance.executionHost).toMatchObject({ runnerName: null, runnerSku: "blacksmith-8vcpu-ubuntu-2404" });
    for (const path of [result.paths.json, result.paths.markdown]) expect(readFileSync(path, "utf8")).not.toContain("lcm-testbox-07");
  });

  it("validates the recorded witness against the closed schema before any provenance readback", () => {
    for (const executionHost of [{ logicalCpus: 0 }, { containerEngine: "x".repeat(129) }, { runnerSku: "not a valid sku" }, { rawHostname: "lcm-testbox-07" }]) {
      const fixture = rawFixture({ profile: "smoke", executionHost });
      const captureProvenance = vi.fn(() => fixture.provenance);
      expect(() => assembleGateFromEvidence({
        repositoryRoot: fixture.root, evidenceDirectory: fixture.root, contractPath: fixture.contractPath, outputDirectory: fixture.output,
      }, { captureProvenance })).toThrow("execution-host witness is invalid");
      expect(captureProvenance).not.toHaveBeenCalled();
    }
  });
});

describe("gate contract version", () => {
  it("refuses to assemble a gate against the superseded v2 contract", () => {
    const fixture = rawFixture({ profile: "smoke" });
    const before = snapshotFiles(fixture.root);
    expect(() => assembleGateFromEvidence({
      repositoryRoot: fixture.root, evidenceDirectory: fixture.root,
      contractPath: new URL("./contract-v2.json", import.meta.url).pathname, outputDirectory: fixture.output,
    }, { captureProvenance: () => fixture.provenance })).toThrow("version 3 is required");
    expect(existsSync(fixture.output)).toBe(false);
    expect(snapshotFiles(fixture.root)).toEqual(before);
  });
});

describe("gate command-line parsing", () => {
  const pairs = ["--repository-root", "/repo", "--evidence-dir", "/evidence", "--contract", "/repo/contract.json", "--output-dir", "/out"];

  it("accepts the documented pnpm-forwarded leading separator and the direct form equally", () => {
    const direct = parseGateArguments(pairs);
    expect(direct).toEqual({ repositoryRoot: "/repo", evidenceDirectory: "/evidence", contractPath: "/repo/contract.json", outputDirectory: "/out" });
    expect(parseGateArguments(["--", ...pairs])).toEqual(direct);
  });

  it("still rejects missing required options", () => {
    expect(() => parseGateArguments(["--", "--repository-root", "/repo"])).toThrow("missing --evidence-dir");
    expect(() => parseGateArguments([])).toThrow("missing --repository-root");
  });
});
