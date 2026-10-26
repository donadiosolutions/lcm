import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectedSteadyAttempts,
  loadCertificationContract,
} from "./contract.mjs";

const contractPath = new URL("./contract-v1.json", import.meta.url);

describe("certification contract", () => {
  it("loads the draft for planning and derives the frozen full schedule counts", () => {
    const loaded = loadCertificationContract(contractPath, { requireApproved: false });

    expect(loaded.contract.status).toBe("draft");
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(expectedSteadyAttempts(loaded.contract)).toEqual({
      hookInvocations: 1200,
      userPrompt: 300,
      postTool: 900,
      daemonSearch: 2400,
      daemonStore: 1200,
    });
  });

  it("refuses evidence collection while the contract is a draft", () => {
    expect(() => loadCertificationContract(contractPath)).toThrow("approved");
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

  it("rejects drift in v1 floors, per-machine counts, capacity and approval time", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-drift-"));
    const write = (name: string, mutate: (candidate: any) => void) => {
      const candidate = JSON.parse(readFileSync(contractPath, "utf8"));
      mutate(candidate);
      const path = join(directory, `${name}.json`);
      writeFileSync(path, `${JSON.stringify(candidate)}\n`);
      return path;
    };
    expect(() => loadCertificationContract(write("floor", (value) => { value.calculations.minimumSamples.p99 = 999; }), { requireApproved: false })).toThrow("sample floors");
    expect(() => loadCertificationContract(write("counts", (value) => { value.workload.expectedPerMachine.daemonStore = 599; }), { requireApproved: false })).toThrow("per-machine");
    expect(() => loadCertificationContract(write("capacity", (value) => { value.thresholds.capacity.totalMax = 20; }), { requireApproved: false })).toThrow("capacity");
    expect(() => loadCertificationContract(write("approval", (value) => { value.status = "approved"; value.approval = { ...value.approval, approvedBy: "x", approvedAt: "not-a-date", approvalRef: "x" }; }))).toThrow("approvedAt");
  });
});
