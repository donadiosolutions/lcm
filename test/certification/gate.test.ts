import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleGateFromEvidence } from "../../scripts/certification-gate.mjs";

describe("certification gate writer", () => {
  it("binds approved contract, provenance and schema to evidence files", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-cert-gate-input-"));
    const output = join(root, "docs");
    writeFileSync(join(root, "samples.ndjson"), `${JSON.stringify({ op: "hook", durationMs: 10 })}\n`);
    const contract = JSON.parse(readFileSync(new URL("./contract-v1.json", import.meta.url), "utf8"));
    contract.status = "approved";
    contract.approval = { ...contract.approval, approvedBy: "maintainer", approvedAt: "2026-10-26T10:00:00.000Z", approvalRef: "issue-629" };
    const contractPath = join(root, "contract.json");
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    writeFileSync(join(root, "evidence-manifest.json"), JSON.stringify({
      startedAt: "2026-10-26T10:01:00.000Z",
      lane: "local",
      profile: "full",
      machines: [
        { name: "a", machineId: "018f0000-0000-7000-8000-000000000001", identityKeySha256: "a".repeat(64) },
        { name: "b", machineId: "018f0000-0000-7000-8000-000000000002", identityKeySha256: "b".repeat(64) },
      ],
      faults: [],
      cleanup: { verdict: "pass", residualResources: 0 },
      slos: [{ id: "hook.p50", formula: "nearest-rank", inputs: { count: 20, sampleFile: "samples.ndjson" }, threshold: 400, observed: 10, verdict: "pass" }],
    }));
    const provenance = {
      testedCommit: "c".repeat(40), dirty: false, testedInputsSha256: "d".repeat(64), testedInputsCount: 1,
      lockfileSha256: "e".repeat(64), cliSha256: "f".repeat(64), node: process.version,
    };

    const result = assembleGateFromEvidence({
      repositoryRoot: new URL("../..", import.meta.url).pathname,
      evidenceDirectory: root,
      contractPath,
      outputDirectory: output,
    }, { captureProvenance: () => provenance });

    expect(result.gate.provenance).toEqual(provenance);
    expect(JSON.parse(readFileSync(result.paths.json, "utf8"))).toEqual(result.gate);
  });
});
