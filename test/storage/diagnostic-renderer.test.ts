import { describe, expect, it } from "vitest";
import { backendDiagnosticFailure } from "../../src/storage/diagnostics.js";
import { renderBackendDiagnostics } from "../../src/storage/diagnostic-renderer.js";

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
