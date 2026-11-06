import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCertificationRunPolicy,
  certificationDeadlineSeconds,
  expectedSteadyAttempts,
  loadCertificationContract,
} from "./contract.mjs";

const contractPath = new URL("./contract-v3.json", import.meta.url);
const approvalPath = new URL("./contract-v3.approval.json", import.meta.url);
const approvedContractSha256 = "ea6ccaaa77212c3c7486cdc85af03a985dde05eeef18096a4511163d0f490839";
const supersededContractPath = new URL("./contract-v2.json", import.meta.url);
const supersededContractSha256 = "6dc8cef4c170c851bbc4c9626ee4a31c3d5cf7a7f4b41bb4e4852c88759222e4";
const v4ContractPath = new URL("./contract-v4.json", import.meta.url);
const v4ApprovedContractSha256 = "cba17a7393f1cb04488a554b82fc2d374b3efc3c21d896546f59d91343b6f74a";

describe("certification contract", () => {
  it("loads the draft for planning and derives the frozen full schedule counts", () => {
    const loaded = loadCertificationContract(contractPath, { requireApproved: false });

    expect(loaded.contract.status).toBe("draft");
    expect(loaded.contract.version).toBe(3);
    expect(loaded.contract.workload.primaryTextBytesCycle).toEqual([256, 1024, 1024, 6144]);
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
      approvedAt: "2026-10-28T13:54:14Z",
      note: "recorded by root at receipt",
      approvalRef: "run-record epic-228-run-01a15242 entry 2026-10-28 13:54:14 UTC (user request_user_input answer in root chat)",
    });
  });

  it("loads v4 and its deadlines without changing the approved v3 bytes", () => {
    const v3 = loadCertificationContract(contractPath);
    const v4 = loadCertificationContract(v4ContractPath, { requireApproved: false });

    expect(v3.sha256).toBe(approvedContractSha256);
    expect(v4.contract.version).toBe(4);
    expect(v4.contract.status).toBe("draft");
    expect(v4.contract.timeline.full.localDeadlineSeconds).toBe(15_600);
    expect(certificationDeadlineSeconds(v4.contract, { profile: "full" })).toBe(15_600);
    expect(certificationDeadlineSeconds(v4.contract, { profile: "smoke", withFaults: true })).toBe(8_820);
    expect(certificationDeadlineSeconds(v4.contract, { profile: "smoke" })).toBe(1_800);
  });

  // Like v3, the approved v4 bytes stay in draft status; the external record binds their hash.
  it("binds v4 evidence collection to its approval record and allows the full profile", () => {
    const loaded = loadCertificationContract(v4ContractPath);

    expect(loaded.contract).toMatchObject({ version: 4, status: "draft", draftRevision: 1 });
    expect(loaded.status).toBe("approved");
    expect(loaded.sha256).toBe(v4ApprovedContractSha256);
    expect(loaded.approval).toEqual({
      contractSha256: v4ApprovedContractSha256,
      approvedBy: "bcdonadio (repository owner)",
      approvedAt: "2026-11-06T16:31:07Z",
      note: "recorded by root at receipt",
      approvalRef: "run-record epic-228-run-01a15242 entry 2026-11-06 16:31:07 UTC (user request_user_input answer in root chat: approve v4 with the events.log scope rule and the 3% database CPU ceiling; delta 3 narrowing recorded as within the approval)",
    });
    expect(() => assertCertificationRunPolicy(loaded, { lane: "local", profile: "full" })).not.toThrow();
  });

  it("validates both v4 deadline sums", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v4-"));
    const candidate = JSON.parse(readFileSync(v4ContractPath, "utf8"));
    const path = join(directory, "contract-v4.json");
    candidate.timeline.full.localDeadlineSeconds += 1;
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);
    expect(() => loadCertificationContract(path, { requireApproved: false })).toThrow("full timeline");

    candidate.timeline.full.localDeadlineSeconds -= 1;
    candidate.timeline.smoke.faultObservabilityDeadlineSeconds += 1;
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);
    expect(() => loadCertificationContract(path, { requireApproved: false })).toThrow("fault observability smoke timeline");
  });

  // One extra call in a 24-probe window adds 0.0417 per probe, so the tolerance must stay below
  // half of that (0.0208).
  it("requires a v4 statement tolerance below half of one extra call per probe", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v4-tolerance-"));
    const path = join(directory, "contract-v4.json");
    const load = (tolerance: unknown) => {
      const candidate = JSON.parse(readFileSync(v4ContractPath, "utf8"));
      if (tolerance === undefined) delete candidate.observability.calibration.successfulPathWireStatementTolerance;
      else candidate.observability.calibration.successfulPathWireStatementTolerance = tolerance;
      writeFileSync(path, `${JSON.stringify(candidate)}\n`);
      return () => loadCertificationContract(path, { requireApproved: false });
    };
    expect(loadCertificationContract(v4ContractPath, { requireApproved: false })
      .contract.observability.calibration.successfulPathWireStatementTolerance).toBe(0.01);
    for (const tolerance of [undefined, 0, "0.01", 0.5 / 24]) {
      expect(load(tolerance)).toThrow("certification contract v4 calibration is invalid");
    }
  });

  // The fallback log's two path categories in its cwd field are the only private-surface
  // allowance; the file-wide list form, another field, rule, category or surface, or a missing
  // allowance is refused.
  it("pins the v4 private-surface category allowance", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v4-allowance-"));
    const path = join(directory, "contract-v4.json");
    const load = (allowances: unknown) => {
      const candidate = JSON.parse(readFileSync(v4ContractPath, "utf8"));
      if (allowances === undefined) delete candidate.observability.privacy.privateSurfaceCategoryAllowances;
      else candidate.observability.privacy.privateSurfaceCategoryAllowances = allowances;
      writeFileSync(path, `${JSON.stringify(candidate)}\n`);
      return () => loadCertificationContract(path, { requireApproved: false });
    };
    const allowance = { field: "cwd", categories: ["project-path", "home-path"], witnessRule: "events-log-top-level-cwd-v1" };
    expect(loadCertificationContract(v4ContractPath, { requireApproved: false }).contract.observability.privacy
      .privateSurfaceCategoryAllowances).toEqual({ "logs/events.log": allowance });
    for (const allowances of [
      undefined,
      { "logs/events.log": ["project-path", "home-path"] },
      { "logs/events.log": { ...allowance, field: "error" } },
      { "logs/events.log": { ...allowance, witnessRule: "events-log-top-level-cwd-v0" } },
      { "logs/events.log": { ...allowance, categories: ["project-path", "home-path", "runtime-password"] } },
      { "logs/events.log": allowance, "failures.ndjson": allowance },
      { "logs/daemon.log": allowance },
    ]) {
      expect(load(allowances)).toThrow("certification contract v4 privacy is invalid");
    }
  });

  it("loads a hash-approved non-provisional v4 contract with resized empirical budgets", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v4-final-"));
    const candidate = JSON.parse(readFileSync(v4ContractPath, "utf8"));
    candidate.timeline.full.observabilityAllocationsProvisional = false;
    candidate.observability.calibration.budgetCeilingsProvisional = false;
    candidate.observability.calibration.machineCpuPercentCeiling = 3;
    candidate.observability.calibration.databaseCpuPercentCeiling = 4;
    candidate.observability.calibration.cpuNoisePercentCeiling = 1;
    candidate.observability.calibration.idleRuntimeRoleCallsPerSecondCeiling = 2;
    candidate.observability.calibration.sampledConnectionIncrementCeiling = 1;
    const path = join(directory, "contract-v4.json");
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(join(directory, "contract-v4.approval.json"), `${JSON.stringify({
      contractSha256: sha256, approvedBy: "owner", approvedAt: "2026-11-05T00:00:00Z",
      note: "approved after smoke", approvalRef: "issue-640",
    })}\n`);
    const loaded = loadCertificationContract(path);
    expect(loaded).toMatchObject({ status: "approved", contract: { version: 4 } });
    expect(() => assertCertificationRunPolicy(loaded, { lane: "local", profile: "full" })).not.toThrow();
  });

  it("requires approval for v3 smoke and faults for v4 local smoke", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v3-unapproved-"));
    const v3Path = join(directory, "contract-v3.json");
    writeFileSync(v3Path, readFileSync(contractPath));
    const v3 = loadCertificationContract(v3Path, { requireApproved: false });
    const v4 = loadCertificationContract(v4ContractPath, { requireApproved: false });
    expect(() => assertCertificationRunPolicy(v3, { lane: "local", profile: "smoke" })).toThrow("approval");
    expect(() => assertCertificationRunPolicy(v4, { lane: "local", profile: "smoke" })).toThrow("--with-faults");
    expect(() => assertCertificationRunPolicy(v4, { lane: "local", profile: "smoke", withFaults: true })).not.toThrow();
  });

  it("refuses a full v4 run while approved empirical budgets remain provisional", () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-cert-contract-v4-provisional-"));
    const path = join(directory, "contract-v4.json");
    for (const flag of ["allocations", "ceilings"]) {
      const candidate = JSON.parse(readFileSync(v4ContractPath, "utf8"));
      if (flag === "allocations") candidate.timeline.full.observabilityAllocationsProvisional = true;
      else candidate.observability.calibration.budgetCeilingsProvisional = true;
      writeFileSync(path, `${JSON.stringify(candidate)}\n`);
      const provisional = loadCertificationContract(path, { requireApproved: false });
      expect(() => assertCertificationRunPolicy({ ...provisional, approval: { contractSha256: provisional.sha256 } }, {
        lane: "local", profile: "full",
      })).toThrow("non-provisional");
    }
  });

  it("refuses the superseded v2 contract kept as history, even with its matching approval", () => {
    expect(createHash("sha256").update(readFileSync(supersededContractPath)).digest("hex")).toBe(supersededContractSha256);
    expect(() => loadCertificationContract(supersededContractPath)).toThrow("version 3 or 4 is required");
    expect(() => loadCertificationContract(supersededContractPath, { requireApproved: false })).toThrow("version 3 or 4 is required");
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

  it("rejects drift in v3 floors, hook limits, text cycle, version, per-machine counts, capacity and approval time", () => {
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
    expect(() => loadCertificationContract(write("cycle", (value) => { value.workload.primaryTextBytesCycle[3] = 8192; }), { requireApproved: false })).toThrow("primary text cycle");
    for (const version of [1, 2]) {
      expect(() => loadCertificationContract(write(`version-${version}`, (value) => { value.version = version; }), { requireApproved: false })).toThrow("identity");
    }
    expect(() => loadCertificationContract(write("version-4-without-v4-fields", (value) => { value.version = 4; }), { requireApproved: false })).toThrow("calibrationSeconds");
    expect(() => loadCertificationContract(write("counts", (value) => { value.workload.expectedPerMachine.daemonStore = 599; }), { requireApproved: false })).toThrow("per-machine");
    expect(() => loadCertificationContract(write("capacity", (value) => { value.thresholds.capacity.totalMax = 20; }), { requireApproved: false })).toThrow("capacity");
    const approvalContract = write("approval", () => undefined);
    const approval = join(directory, "approval.approval.json");
    const approvalSha256 = createHash("sha256").update(readFileSync(approvalContract)).digest("hex");
    writeFileSync(approval, `${JSON.stringify({ contractSha256: approvalSha256, approvedBy: "x", approvedAt: "not-a-date", note: "x", approvalRef: "x" })}\n`);
    expect(() => loadCertificationContract(approvalContract, { approvalPath: approval })).toThrow("approvedAt");
  });
});
