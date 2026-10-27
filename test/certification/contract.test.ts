import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectedSteadyAttempts,
  loadCertificationContract,
} from "./contract.mjs";

const contractPath = new URL("./contract-v2.json", import.meta.url);
const approvalPath = new URL("./contract-v2.approval.json", import.meta.url);
const approvedContractSha256 = "6dc8cef4c170c851bbc4c9626ee4a31c3d5cf7a7f4b41bb4e4852c88759222e4";

describe("certification contract", () => {
  it("loads the draft for planning and derives the frozen full schedule counts", () => {
    const loaded = loadCertificationContract(contractPath, { requireApproved: false });

    expect(loaded.contract.status).toBe("draft");
    expect(loaded.contract.version).toBe(2);
    expect(loaded.contract.thresholds.hookCommandMs).toMatchObject({ pooled: { p50: 600, p95: 1500, p99: 2500 }, perKindPooledP95: 1500, perMachineP95: 1500 });
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(expectedSteadyAttempts(loaded.contract)).toEqual({
      hookInvocations: 1200,
      userPrompt: 300,
      postTool: 900,
      daemonSearch: 2400,
      daemonStore: 1200,
    });
  });

  it("binds evidence collection to the external approval record", () => {
    const loaded = loadCertificationContract(contractPath);

    expect(loaded.contract.status).toBe("draft");
    expect(loaded.sha256).toBe(approvedContractSha256);
    expect(loaded.approval).toEqual({
      contractSha256: approvedContractSha256,
      approvedBy: "bcdonadio (repository owner)",
      approvedAt: "2026-10-27T03:16:01Z",
      note: "recorded by root at receipt",
      approvalRef: "run-record epic-228-run-01a15242 entry 2026-10-27 03:16:01 UTC (user request_user_input answer in root chat)",
    });
  });

  it("rejects an approval record bound to different contract bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-approval-"));
    const path = join(directory, "contract.json");
    const approval = join(directory, "contract.approval.json");
    writeFileSync(path, readFileSync(contractPath));
    writeFileSync(approval, `${JSON.stringify({
      ...JSON.parse(readFileSync(approvalPath, "utf8")),
      contractSha256: "0".repeat(64),
    })}\n`);

    expect(() => loadCertificationContract(path, { approvalPath: approval })).toThrow(
      "approval hash",
    );
  });

  it("rejects a schedule whose expected counts miss a minimum sample floor", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-"));
    const candidate = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    candidate.timeline.full.steadySeconds = 100;
    candidate.timeline.full.localDeadlineSeconds = 4900;
    candidate.workload.expectedPooledSteadyAttemptsPerLane = expectedSteadyAttempts(candidate);
    const path = join(directory, "contract.json");
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);

    expect(() => loadCertificationContract(path, { requireApproved: false })).toThrow(
      "p99 minimum",
    );
  });

  it("rejects a contract with a missing required shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-shape-"));
    const candidate = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    delete candidate.oracle.observer;
    const path = join(directory, "contract.json");
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);
    expect(() => loadCertificationContract(path, { requireApproved: false })).toThrow("oracle.observer");
  });

  it("rejects drift in v2 floors, hook limits, version, per-machine counts, capacity and approval time", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-drift-"));
    const write = (name: string, mutate: (candidate: any) => void) => {
      const candidate = JSON.parse(readFileSync(contractPath, "utf8"));
      mutate(candidate);
      const path = join(directory, `${name}.json`);
      writeFileSync(path, `${JSON.stringify(candidate)}\n`);
      return path;
    };
    expect(() => loadCertificationContract(write("floor", (value) => { value.calculations.minimumSamples.p99 = 999; }), { requireApproved: false })).toThrow("sample floors");
    expect(() => loadCertificationContract(write("hook", (value) => { value.thresholds.hookCommandMs.pooled.p95 = 1000; }), { requireApproved: false })).toThrow("hook limits");
    expect(() => loadCertificationContract(write("version", (value) => { value.version = 1; }), { requireApproved: false })).toThrow("identity");
    expect(() => loadCertificationContract(write("counts", (value) => { value.workload.expectedPerMachine.daemonStore = 599; }), { requireApproved: false })).toThrow("per-machine");
    expect(() => loadCertificationContract(write("capacity", (value) => { value.thresholds.capacity.totalMax = 20; }), { requireApproved: false })).toThrow("capacity");
    const approvalContract = write("approval", () => undefined);
    const approval = join(directory, "approval.approval.json");
    const approvalSha256 = createHash("sha256").update(readFileSync(approvalContract)).digest("hex");
    writeFileSync(approval, `${JSON.stringify({ contractSha256: approvalSha256, approvedBy: "x", approvedAt: "not-a-date", note: "x", approvalRef: "x" })}\n`);
    expect(() => loadCertificationContract(approvalContract, { approvalPath: approval })).toThrow("approvedAt");
  });
});
