import { describe, expect, it } from "vitest";
import { backendDiagnosticFailure, collectBackendDiagnostics, type BackendDiagnosticRuntime } from "../../src/storage/diagnostics.js";
import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";

import { parseDaemonConfig } from "../../src/daemon/config.js";

const uuid = "01912345-1234-7123-8123-123456789abc";
const hash = "a".repeat(64);
describe("safe common diagnostic text", () => {
  it.each(["healthy", "degraded", "unavailable", "permission-denied", "timeout", "stale-publication"] as const)("shows complete %s facts and fixed actions", classification => {
    const snapshot = backendDiagnosticFailure(new Error("private"), "postgresql");
    snapshot.classification = classification;
    snapshot.pool = {status:"ready",origin:"daemon",configuredMax:8,total:3,idle:2,waiting:1,failed:false};
    snapshot.project = {scope:"selected",status:"ready",projectId:uuid,localProjectId:hash};
    snapshot.identity = {status:"ready",machineId:uuid};
    snapshot.outbox = {status:"ready",captured:9,unprocessed:8,errors:7,deliveryPending:6,deliveryClaimed:5,deliveryRetry:4,deliveryReplicated:3,deliveryAcknowledged:2,deliveryAwaitingRemotePrune:1,deliveryQuarantined:0};
    snapshot.remediation = "PRIVATE_ACTION";
    const text = renderBackendDiagnostics(snapshot);
    for (const label of ["Storage backend:","Classification:","Publication:","TLS:","Schema:","Extensions:","Search:","Pool:","Pool counts:","Project:","Project ID:","Machine identity:","Outbox:","Outbox counts:","Outbox delivery:","Action:"]) expect(text).toContain(label);
    expect(text).toContain(`Classification: ${classification}`);
    expect(text).toContain(`Project ID: ${uuid}; local hash: ${hash}`);
    expect(text).toContain("configured max: 8; total: 3; idle: 2; waiting: 1; failed: false");
    expect(text).toContain("quarantined: 0");
    expect(text).not.toContain("PRIVATE_ACTION");
  });
  it.each([
    { phase: "acquisition", classification: "timeout", failed: true, action: "Check backend connectivity, then run `lcm doctor` again." },
    { phase: "acquisition", classification: "unavailable", failed: false, action: "Run `lcm doctor` and review the storage configuration." },
    { phase: "health", classification: "timeout", failed: false, action: "Check backend connectivity, then run `lcm doctor` again." },
    { phase: "health", classification: "unavailable", failed: true, action: "Run `lcm doctor` and review the storage configuration." },
  ] as const)("renders retained daemon pool during $phase $classification without promoting backend health", async ({ phase, classification, failed, action }) => {
    const secret = "postgresql://role:password@private.example/db\nPRIVATE_DETAIL";
    const config = parseDaemonConfig("{}");
    config.storage = { backend: "postgresql", postgresql: {
      url: secret, poolMax: 8, connectionTimeoutMs: 10000,
      idleTimeoutMs: 30000, statementTimeoutMs: 60000,
    } };
    const fail = async (): Promise<never> => {
      if (classification === "timeout") return new Promise(() => {});
      throw new Error(secret);
    };
    const runtime: BackendDiagnosticRuntime = {
      query: fail, health: fail, close: async () => {},
      poolDiagnostics: () => ({ configuredMax: 1, total: 0, idle: 0, waiting: 0, failed: false }),
    };
    const snapshot = await collectBackendDiagnostics({
      _deadlineMs: 10,
      storageFactory: {
        backend: "postgresql",
        getDiagnosticPool: () => ({ configuredMax: 8, total: 4, idle: 2, waiting: 1, failed, rawError: secret }),
      } as never,
      _dependencies: {
        observePublication: () => ({ config, witness: "stable", machineId: uuid, mapContent: null }),
        createRuntime: phase === "acquisition" ? fail : () => runtime,
      },
    });
    const text = renderBackendDiagnostics(snapshot);
    expect(text).toContain(`Classification: ${classification}`);
    expect(text).toContain("Pool: ready; origin: daemon");
    expect(text).toContain(`Pool counts: configured max: 8; total: 4; idle: 2; waiting: 1; failed: ${failed}`);
    expect(text).toContain("TLS: unverified");
    expect(text).toContain("Schema: unverified");
    expect(text).toContain(`Action: ${action}`);
    expect(text).not.toMatch(/Classification: (healthy|degraded)|No action required/);
    expect(text).not.toMatch(/PRIVATE_DETAIL|postgresql:\/\/|rawError|private\.example/);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_DETAIL|postgresql:\/\/|rawError|private\.example/);
  });
  it("renders SQLite hash identity, absent optional values and aggregate scope explicitly", () => {
    const snapshot = backendDiagnosticFailure(undefined,"sqlite");
    snapshot.identity.status = "not-applicable";
    snapshot.project = {scope:"selected",status:"ready",projectId:hash,localProjectId:hash};
    expect(renderBackendDiagnostics(snapshot)).toContain(`Project ID: ${hash}`);
    snapshot.project = {scope:"aggregate",status:"ready"};
    expect(renderBackendDiagnostics(snapshot)).toContain("Project: aggregate; ready");
    expect(renderBackendDiagnostics(snapshot)).toContain("Machine identity: not-applicable; ID: unverified");
  });
  it("refuses hostile enum, identifier, counter and remediation values", () => {
    const secret = "postgresql://role:password@private.example/db\nSECRET";
    const snapshot = backendDiagnosticFailure(undefined);
    Object.assign(snapshot,{backend:secret,classification:secret,publication:secret,tls:secret,schema:secret,extensions:secret,search:secret,remediation:secret});
    Object.assign(snapshot.pool,{origin:secret,status:secret,total:NaN,idle:-1,configuredMax:Infinity,waiting:secret,failed:secret});
    Object.assign(snapshot.project,{scope:secret,status:secret,projectId:secret,localProjectId:uuid});
    Object.assign(snapshot.identity,{status:secret,machineId:hash});
    Object.assign(snapshot.outbox,{status:secret,captured:1.5,errors:Number.MAX_SAFE_INTEGER+1});
    const text = renderBackendDiagnostics(snapshot);
    expect(text).not.toMatch(/SECRET|postgresql:\/\/|NaN|Infinity/);
    expect(text).toContain("Classification: unavailable");
    expect(text).toContain("Project ID: unverified; local hash: unverified");
    expect(text).toContain("Machine identity: unverified; ID: unverified");
  });
});
