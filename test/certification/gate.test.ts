import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleGateFromEvidence } from "../../scripts/certification-gate.mjs";
import { createDeterministicSchedule, createFaultSchedule } from "./schedule.mjs";

function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value)}\n`); }
function writeNdjson(path: string, values: unknown[]): void { writeFileSync(path, values.map((value) => `${JSON.stringify(value)}\n`).join("")); }

type Variant = { observerGap?: boolean; clockBreach?: boolean; duplicateMapping?: boolean; drainFail?: boolean; capacityPeak?: number; recoveryFail?: boolean; catchUpFail?: boolean; readinessInvalid?: boolean; phaseEarly?: boolean };

function rawFixture(options: Variant = {}) {
  const root = mkdtempSync(join(tmpdir(), "lcm-cert-raw-gate-"));
  const output = join(root, "gate");
  const contract = JSON.parse(readFileSync(new URL("./contract-v1.json", import.meta.url), "utf8"));
  const contractText = `${JSON.stringify(contract)}\n`;
  const contractPath = join(root, "contract.json");
  writeFileSync(contractPath, contractText);
  const contractSha256 = createHash("sha256").update(contractText).digest("hex");
  writeJson(join(root, "contract.approval.json"), {
    contractSha256,
    approvedBy: "maintainer",
    approvedAt: "2026-10-26T10:00:00.000Z",
    approvalRef: "issue-629",
  });
  const provenance = {
    testedCommit: "c".repeat(40), dirty: false, testedInputsSha256: "d".repeat(64), testedInputsCount: 100,
    lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), stagedPackageSha256: "1".repeat(64),
    contractSha256, node: process.version,
  };
  const t0 = Date.parse("2026-10-26T10:10:00.000Z");
  writeJson(join(root, "run.json"), { lane: "local", profile: "full", runId: "run12345", startedAt: "2026-10-26T10:01:00.000Z" });
  writeJson(join(root, "phase-control.json"), { warmupStartAt: options.phaseEarly ? "2026-10-26T10:09:00.000Z" : "2026-10-26T10:08:00.000Z", steadyT0At: new Date(t0).toISOString() });
  writeJson(join(root, "execution-provenance.json"), provenance);
  writeJson(join(root, "machine-identities.json"), {
    a: { machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
    b: { machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
  });
  writeJson(join(root, "database-readiness.json"), {
    serverVersionNum: options.readinessInvalid ? 170006 : 180004, serverPort: 5432,
    databaseName: "lcm_harness_run12345", roleName: "lcm_test_runtime",
    role: { superuser: false, createRole: false, createDb: false }, residualEmpty: true,
    maxConnections: 100, reservedConnections: 3, configuredPoolMax: 2, setupSessionsClosed: true,
    extensions: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((name) => ({ name, schema: "public" })),
    migrations: 9, expectedMigrations: 9, systemIdentifier: "123456789",
  });
  writeJson(join(root, "cleanup.json"), {
    verdict: "pass", residualResources: 0, labeledContainers: 0, labeledNetworks: 0,
    labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: true,
    ownedProcessesExited: true, providerDestroyConfirmedWithinSeconds: 0,
  });
  writeJson(join(root, "database-growth.json"), { beforeBytes: 1000, afterBytes: 2000, deltaBytes: 1000 });
  writeJson(join(root, "clock-witness.json"), Array.from({ length: 202 }, (_, index) => ({
    phase: index < 2 ? "start" : index >= 200 ? "end" : "interval",
    machine: index % 2 === 0 ? "a" : "b", radiusMs: options.clockBreach && index === 0 ? 300 : 10,
    verdict: options.clockBreach && index === 0 ? "fail" : "pass",
    t0: { wallMs: t0 + index * 60_000, monotonicNs: String(1_000_000_000n + BigInt(index) * 60_000_000_000n) },
    serverTime: new Date(t0 + index * 60_000 + 10).toISOString(),
    t1: { wallMs: t0 + index * 60_000 + (options.clockBreach && index === 0 ? 600 : 20), monotonicNs: String(1_020_000_000n + BigInt(index) * 60_000_000_000n) },
    databaseConnections: index === 0 ? options.capacityPeak ?? 8 : 8,
    connections: [{ role_name: "lcm_test_runtime", client_address: index % 2 === 0 ? "10.0.0.2" : "10.0.0.3", connections: index === 0 ? options.capacityPeak ?? 8 : 8 }],
  })));
  const partitionApplied = t0 + 6_060_000;
  const partitionCleared = partitionApplied + 60_000;
  const restartApplied = partitionApplied + 400_000;
  const restartCleared = restartApplied + 60_000;
  writeJson(join(root, "faults.json"), [
    { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: new Date(partitionApplied - 10).toISOString(), appliedAt: new Date(partitionApplied).toISOString(), clearedAt: new Date(partitionCleared).toISOString(), recoveredAt: new Date(partitionCleared + 90_000).toISOString() },
    { id: "restart-database", kind: "restart-database", target: "database", requestedAt: new Date(restartApplied - 10).toISOString(), appliedAt: new Date(restartApplied).toISOString(), clearedAt: new Date(restartCleared).toISOString(), recoveredAt: new Date(restartCleared + 90_000).toISOString() },
  ]);
  for (const machine of ["a", "b"] as const) {
    const directory = join(root, `machine-${machine}`);
    mkdirSync(directory);
    writeJson(join(directory, "warmup-complete.json"), { machine, at: new Date(t0 - 1_000).toISOString() });
    const steady = createDeterministicSchedule({ profile: "full", machine, runId: "run12345", contract }).map((entry) => ({
      ...entry, phase: "steady", scheduledWallMs: t0 + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(t0 + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10,
      outcome: "success", processExitNs: String(BigInt(1_000_000_000 + entry.index * 10_000_000)),
    }));
    const partition = createFaultSchedule({ machine, runId: "run12345", phase: "partition-recovery", durationSeconds: 180 }).map((entry) => ({
      ...entry, scheduledWallMs: partitionApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(partitionApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10,
      outcome: options.recoveryFail && machine === "a" ? "failed" : "success",
    }));
    const restart = createFaultSchedule({ machine, runId: "run12345", phase: "restart-recovery", durationSeconds: 240 }).map((entry) => ({
      ...entry, scheduledWallMs: restartApplied + entry.offsetSeconds * 1000,
      wallEndedAt: new Date(restartApplied + entry.offsetSeconds * 1000 + 10).toISOString(), durationMs: 10, outcome: "success",
    }));
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
    writeJson(join(directory, "partition-catch-up.json"), options.catchUpFail && machine === "a"
      ? { phase: "partition", verdict: "fail", seconds: 900, remaining: 1 }
      : { phase: "partition", verdict: "pass", seconds: 10, remaining: 0 });
    writeJson(join(directory, "restart-catch-up.json"), { phase: "restart", verdict: "pass", seconds: 10, remaining: 0 });
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

  it("keeps a definite clock breach above missing observer evidence", () => {
    expect(assemble(rawFixture({ clockBreach: true, observerGap: true })).gate.verdict).toBe("fail");
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
