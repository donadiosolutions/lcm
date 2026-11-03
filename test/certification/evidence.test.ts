import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvidence } from "../postgresql/cutover-rehearsal/check-evidence.js";
import { assembleCertificationGate, writeCertificationGate } from "./slo.mjs";

describe("certification evidence", () => {
  it("assembles an allowlisted gate that conforms to the committed schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-evidence-"));
    writeFileSync(join(directory, "samples.ndjson"), `${JSON.stringify({ op: "hook", durationMs: 10, outcome: "success" })}\n`);
    const gate = assembleCertificationGate({
      evidenceDirectory: directory,
      contractSha256: "a".repeat(64),
      contractStatus: "approved",
      approval: { contractSha256: "a".repeat(64), approvedAt: "2026-10-26T10:00:00.000Z", note: "recorded", approvalRef: "issue-629", approvedBy: "maintainer" },
      startedAt: "2026-10-26T10:01:00.000Z",
      lane: "local",
      profile: "full",
      provenance: {
        testedCommit: "d".repeat(40), dirty: false, testedInputsSha256: "e".repeat(64),
        testedInputsCount: 100, lockfileSha256: "f".repeat(64), cliSha256: "1".repeat(64),
        stagedPackageSha256: "2".repeat(64), contractSha256: "a".repeat(64), approvalSha256: "5".repeat(64), node: process.version,
        executionHost: {
          capturedAt: "2026-10-26T10:00:59.000Z", osId: "ubuntu", osVersionId: "24.04", kernelRelease: "6.8.0-45-generic", architecture: "x64",
          cpuModel: "AMD EPYC 9R14", logicalCpus: 8, totalMemoryBytes: 33_000_000_000, containerEngine: "podman", containerEngineVersion: null,
          hostnameSha256: "7".repeat(64), runnerName: null, runnerOs: null, runnerArch: null, runnerSku: null,
        },
        observerSettings: { pollSeconds: 1, busyTimeoutMs: 200, perQueryDeadlineMs: 250, maxPollGapSeconds: 2 },
      },
      machines: [
        { name: "a", machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "b".repeat(64) },
        { name: "b", machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "c".repeat(64) },
      ],
      faults: [],
      cleanup: { verdict: "pass", residualResources: 0, labeledContainers: 0, labeledNetworks: 0, labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: true, ownedProcessesExited: true, providerDestroyConfirmedWithinSeconds: 0 },
      diagnostics: { databaseGrowth: { beforeBytes: 0, afterBytes: 0, deltaBytes: 0 }, submittedPrimaryBytes: 0, submittedEnvelopeBytes: 0, truncatedRows: 0, sweepWitnessSha256: ["3".repeat(64), "4".repeat(64)] },
      slos: [{ id: "hook.p50", formula: "nearest-rank", inputs: { count: 20, sampleFile: "samples.ndjson" }, threshold: 400, observed: 10, verdict: "pass" }],
    });
    const schema = JSON.parse(readFileSync(new URL("./evidence-schema.json", import.meta.url), "utf8"));

    expect(validateEvidence(schema, gate)).toEqual([]);
    expect(gate.provenance.testedCommit).toBe("d".repeat(40));
    expect(JSON.stringify(gate)).not.toContain("token");
    expect(gate.slos[0]?.inputs.sampleSha256).toMatch(/^[0-9a-f]{64}$/u);

    const output = mkdtempSync(join(tmpdir(), "lcm-cert-gate-"));
    const paths = writeCertificationGate(gate, output);
    expect(JSON.parse(readFileSync(paths.json, "utf8"))).toEqual(gate);
    expect(readFileSync(paths.markdown, "utf8")).toContain("hook.p50 | pass | 10 | 400");
  });
});
