import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleGateFromEvidence, parseGateArguments } from "../../scripts/certification-gate.mjs";
import { captureExecutionHost, captureExecutionProvenance } from "../../scripts/certification-harness.mjs";
import { createGitCheckoutFixture } from "./git-checkout-fixture.js";
import { createDeterministicSchedule, createFaultSchedule } from "./schedule.mjs";

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
type Variant = { observerGap?: boolean; clockBreach?: boolean; clockGap?: boolean; duplicateMapping?: boolean; drainFail?: boolean; capacityPeak?: number; recoveryFail?: boolean; partitionFirstSuccessSeconds?: number; restartBFirstSuccessSeconds?: number; restartBNoSuccess?: boolean; noRecoverySuccess?: boolean; catchUpFail?: boolean; catchUpAtSeconds?: number; missingCatchUpTimestamp?: boolean; readinessInvalid?: boolean; residualOccupied?: boolean; poolConfigMismatch?: boolean; setupSessionOpen?: boolean; phaseEarly?: boolean; profile?: "smoke" | "full"; lane?: "local" | "managed"; faultLayout?: FaultLayout; maintenanceFailure?: MaintenanceFailure; smokeFailure?: boolean; smokeSlow?: boolean; executionHost?: Record<string, unknown> };

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
  const contract = JSON.parse(readFileSync(new URL("./contract-v2.json", import.meta.url), "utf8"));
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
    contractSha256, approvalSha256, node: process.version, executionHost,
  };
  const profile = options.profile ?? "full";
  const lane = options.lane ?? "local";
  const faultLayout: FaultLayout = options.faultLayout ?? (profile === "full" ? (lane === "managed" ? "partition-a" : "faults") : "none");
  const runtimeRole = lane === "local" ? "lcm_test_runtime" : "lcm_cert_runtime_run12345";
  const t0 = Date.parse("2026-10-26T10:10:00.000Z");
  writeJson(join(root, "run.json"), { lane, profile, runId: "run12345", contractSha256, approval, approvalSha256, startedAt: "2026-10-26T10:01:00.000Z" });
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
    serverVersionNum: options.readinessInvalid ? 170006 : 180004, serverPort: lane === "local" ? 5432 : 25060,
    ...(lane === "managed" ? { providerPort: 25060 } : {}),
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
  const clocks = Array.from({ length: clockDurationMinutes + 1 }, (_, minute) => ["a", "b"].map((machine) => {
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
    writeNdjson(join(directory, "observer.ndjson"), [{ status: "ok", gapMs: options.observerGap ? 3000 : 1000, incomplete: false, siblingsPresent: true }]);
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
  writeJson(path, captureExecutionProvenance(checkout.root, recorded.contractSha256, recorded.stagedPackageSha256, recorded.approvalSha256, { executionHost: recorded.executionHost }));
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
