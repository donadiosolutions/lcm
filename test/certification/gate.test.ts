import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleGateFromEvidence } from "../../scripts/certification-gate.mjs";
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

type Variant = { observerGap?: boolean; clockBreach?: boolean; clockGap?: boolean; duplicateMapping?: boolean; drainFail?: boolean; capacityPeak?: number; recoveryFail?: boolean; partitionFirstSuccessSeconds?: number; restartBFirstSuccessSeconds?: number; restartBNoSuccess?: boolean; noRecoverySuccess?: boolean; catchUpFail?: boolean; catchUpAtSeconds?: number; missingCatchUpTimestamp?: boolean; readinessInvalid?: boolean; residualOccupied?: boolean; poolConfigMismatch?: boolean; setupSessionOpen?: boolean; phaseEarly?: boolean; profile?: "smoke" | "full"; smokeFailure?: boolean; smokeSlow?: boolean };

function rawFixture(options: Variant = {}) {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-"));
  const output = join(mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-output-")), "gate");
  const contract = JSON.parse(readFileSync(new URL("./contract-v1.json", import.meta.url), "utf8"));
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
  const provenance = {
    testedCommit: "c".repeat(40), dirty: false, testedInputsSha256: "d".repeat(64), testedInputsCount: 100,
    lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), stagedPackageSha256: "1".repeat(64),
    contractSha256, approvalSha256, node: process.version,
  };
  const profile = options.profile ?? "full";
  const t0 = Date.parse("2026-10-26T10:10:00.000Z");
  writeJson(join(root, "run.json"), { lane: "local", profile, runId: "run12345", contractSha256, approval, approvalSha256, startedAt: "2026-10-26T10:01:00.000Z" });
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
    serverVersionNum: options.readinessInvalid ? 170006 : 180004, serverPort: 5432,
    databaseName: "lcm_harness_run12345", roleName: "lcm_test_runtime",
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
      connections: [{ role_name: "lcm_test_runtime", client_address: machine === "a" ? "10.0.0.2" : "10.0.0.3", connections: index === 0 ? options.capacityPeak ?? 8 : 8 }],
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
  writeJson(join(root, "faults.json"), profile === "full" ? [
    { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: new Date(partitionApplied - 10).toISOString(), appliedAt: new Date(partitionApplied).toISOString(), clearedAt: new Date(partitionCleared).toISOString(), recoveredAt: new Date(partitionCleared + 90_000).toISOString() },
    { id: "restart-database", kind: "restart-database", target: "database", requestedAt: new Date(restartApplied - 10).toISOString(), appliedAt: new Date(restartApplied).toISOString(), clearedAt: new Date(restartCleared).toISOString(), recoveredAt: new Date(restartCleared + 90_000).toISOString() },
  ] : []);
  for (const machine of ["a", "b"] as const) {
    const directory = join(root, `machine-${machine}`);
    mkdirSync(directory);
    writeJson(join(directory, "warmup-complete.json"), { machine, at: new Date(t0 - 1_000).toISOString() });
    const steady = createDeterministicSchedule({ profile, machine, runId: "run12345", contract }).map((entry) => ({
      ...entry, phase: "steady", scheduledWallMs: t0 + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(t0 + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: options.smokeSlow && entry.op === "search" ? 10_000 : 10,
      outcome: options.smokeFailure && entry.op === "search" && entry.index === 0 ? "failed" : "success", processExitNs: String(BigInt(1_000_000_000 + entry.index * 10_000_000)),
    }));
    const partition = (profile === "full" ? createFaultSchedule({ machine, runId: "run12345", phase: "partition-recovery", durationSeconds: 180 }) : []).map((entry) => ({
      ...entry, scheduledWallMs: partitionApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(partitionApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10,
      outcome: options.recoveryFail && machine === "a" || options.partitionFirstSuccessSeconds !== undefined && machine === "a"
        && partitionApplied + entry.offsetSeconds * 1000 + 10 < partitionCleared + options.partitionFirstSuccessSeconds * 1000 ? "failed" : "success",
    }));
    const restart = (profile === "full" ? createFaultSchedule({ machine, runId: "run12345", phase: "restart-recovery", durationSeconds: 240 }) : []).map((entry) => ({
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
  return { root, output, contractPath, contractSha256, provenance: current };
}

function assemble(fixture: ReturnType<typeof rawFixture>) {
  return assembleGateFromEvidence({
    repositoryRoot: new URL("../..", import.meta.url).pathname,
    evidenceDirectory: fixture.root,
    contractPath: fixture.contractPath,
    outputDirectory: fixture.output,
  }, { captureProvenance: () => fixture.provenance });
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
