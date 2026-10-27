import { describe, expect, it } from "vitest";
import { backendDiagnosticFailure, collectBackendDiagnostics, type BackendDiagnosticRuntime } from "../../src/storage/diagnostics.js";
import { renderBackendDiagnostics, renderQueryStatistics } from "../../src/storage/diagnostic-renderer.js";
import { QUERY_OPERATION_IDS } from "../../src/storage/postgresql/query-operations.js";

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
    expect(text).not.toMatch(/Classification: (healthy|degraded)|^Action: No action required/m);
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
  it("renders bounded query-statistics status and counts only valid call counters", () => {
    const snapshot = backendDiagnosticFailure(undefined, "postgresql");
    snapshot.telemetry.statements = {
      status: "partial", observedAt: 1, scope: "aggregate",
      operations: [
        { operation: QUERY_OPERATION_IDS[0]!, values: { queryCallsTotal: 2 }, omitted: {} },
        { operation: QUERY_OPERATION_IDS[1]!, values: {}, omitted: { queryCallsTotal: "no-entry" } },
        { operation: QUERY_OPERATION_IDS[2]!, values: { queryCallsTotal: -1 }, omitted: {} },
        { operation: QUERY_OPERATION_IDS[0]!, values: { queryCallsTotal: 3 }, omitted: {} },
        { operation: "hostile.unknown", values: { queryCallsTotal: 4 }, omitted: {} },
        null as never,
        { operation: QUERY_OPERATION_IDS[3]!, values: null as never, omitted: {} },
      ],
    };
    expect(renderBackendDiagnostics(snapshot)).toContain(
      `Query statistics: partial; scope: aggregate; operations with call counters: 1 of ${QUERY_OPERATION_IDS.length}`,
    );
  });
  it("renders unknown or hostile query-statistics values with fixed fallbacks", () => {
    const secret = "postgresql://private:secret@host/db";
    const snapshot = backendDiagnosticFailure(undefined, "postgresql");
    Object.assign(snapshot.telemetry.statements, { status: secret, scope: secret, operations: secret });
    const text = renderBackendDiagnostics(snapshot);
    expect(text).toContain("Query statistics: unavailable");
    expect(text).not.toContain(secret);
    expect(renderQueryStatistics(null)).toBe("Query statistics: unavailable");
  });
});


import { RUNTIME_HEALTH_ACTIONS, poolTelemetry } from "../../src/storage/runtime-health.js";

const A = RUNTIME_HEALTH_ACTIONS;
const names = ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"];
function postgres(): ReturnType<typeof backendDiagnosticFailure> {
  const snapshot = backendDiagnosticFailure(new Error("private"), "postgresql");
  snapshot.pool = { status: "ready", origin: "daemon", configuredMax: 4, total: 3, idle: 1, waiting: 0, failed: false };
  snapshot.outbox = { status: "ready", deliveryQuarantined: 0 };
  snapshot.telemetry = {
    pool: poolTelemetry(snapshot.pool, 1),
    migration: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: A.healthy, historyStatus: "current", appliedCount: 8, expectedCount: 8 },
    extensions: { status: "observed", observedAt: 1, health: "healthy", omitted: [], remediation: A.healthy, entries: names.map(name => ({ name, status: "current", installedVersion: "1.2", defaultVersion: "1.2.3" })) as never },
    queue: { status: "observed", observedAt: 1, health: "healthy", omitted: [{ field: "replayLagSeconds", reason: "no-entry" }], remediation: A.healthy, inboxClaimed: 2, inboxQuarantined: 0, outboxOldestPendingAgeSeconds: 7 },
  };
  return snapshot;
}
const lineOf = (text: string, prefix: string): string => text.split("\n").find(line => line.startsWith(prefix)) ?? "<missing>";

describe("runtime health telemetry text", () => {
  it("renders fixed lines for observed PostgreSQL families", () => {
    const text = renderBackendDiagnostics(postgres());
    expect(lineOf(text, "Telemetry pool:")).toBe("Telemetry pool: observed; health: healthy; saturation ratio: 0.5; omitted: none");
    expect(lineOf(text, "Telemetry migration:")).toBe("Telemetry migration: observed; health: healthy; history: current; applied: 8; expected: 8; omitted: none");
    expect(lineOf(text, "Telemetry extensions:")).toContain("pg_trgm: current (installed 1.2, default 1.2.3)");
    expect(lineOf(text, "Telemetry queue:")).toBe("Telemetry queue: observed; health: healthy; outbox oldest pending age seconds: 7; inbox claimed: 2; inbox quarantined: 0; replay lag seconds: unverified; omitted: replayLagSeconds=no-entry");
    for (const family of ["pool", "migration", "extensions", "queue"]) expect(text).toContain("Telemetry " + family + " action: No action required.");
  });
  it("renders a single line per not-applicable SQLite family", () => {
    const snapshot = backendDiagnosticFailure(undefined, "sqlite");
    const text = renderBackendDiagnostics(snapshot);
    for (const family of ["pool", "migration", "extensions", "queue"]) expect(text).toContain("Telemetry " + family + ": not-applicable");
    expect(text).not.toContain("Telemetry pool action");
  });
  it.each([undefined, null, "text", [], { pool: null, migration: 3, extensions: "x", queue: [] }])("renders each family unavailable for missing or malformed telemetry %#", telemetry => {
    const snapshot = postgres();
    (snapshot as { telemetry: unknown }).telemetry = telemetry;
    const text = renderBackendDiagnostics(snapshot);
    expect(lineOf(text, "Telemetry pool:")).toBe("Telemetry pool: unavailable; health: unavailable; saturation ratio: unverified; omitted: none");
    expect(lineOf(text, "Telemetry migration:")).toContain("unavailable; health: unavailable; history: unavailable; applied: unverified");
    expect(lineOf(text, "Telemetry extensions:")).toContain("entries: none");
    expect(lineOf(text, "Telemetry queue:")).toContain("replay lag seconds: unverified");
    expect(text).not.toContain("No action required.\nTelemetry migration");
    for (const family of ["pool", "migration", "extensions", "queue"]) expect(text).toContain("Telemetry " + family + " action: " + A.unavailable);
  });
  it("coerces unrecognized or contradictory status and health", () => {
    const snapshot = postgres();
    Object.assign(snapshot.telemetry.pool, { status: "PRIVATE", health: "PRIVATE" });
    Object.assign(snapshot.telemetry.migration, { status: "timeout", health: "healthy" });
    Object.assign(snapshot.telemetry.extensions, { status: "timeout", health: "degraded" });
    Object.assign(snapshot.telemetry.queue, { status: "partial", health: "healthy" });
    const text = renderBackendDiagnostics(snapshot);
    expect(lineOf(text, "Telemetry pool:")).toContain("unavailable; health: unavailable");
    expect(lineOf(text, "Telemetry migration:")).toContain("timeout; health: unavailable");
    expect(lineOf(text, "Telemetry extensions:")).toContain("timeout; health: unavailable");
    expect(lineOf(text, "Telemetry queue:")).toContain("partial; health: unavailable");
    expect(text).not.toContain("PRIVATE");
  });
  it("ignores inherited telemetry properties", () => {
    const inherited = postgres();
    inherited.telemetry.queue = Object.create({ status: "observed", health: "degraded", inboxQuarantined: 5, omitted: [{ field: "inboxClaimed", reason: "timeout" }] });
    inherited.telemetry.extensions = Object.create({ status: "observed", health: "healthy", entries: [] });
    const inheritedText = renderBackendDiagnostics(inherited);
    expect(lineOf(inheritedText, "Telemetry queue:")).toBe("Telemetry queue: unavailable; health: unavailable; outbox oldest pending age seconds: unverified; inbox claimed: unverified; inbox quarantined: unverified; replay lag seconds: unverified; omitted: none");
    expect(lineOf(inheritedText, "Telemetry extensions:")).toContain("unavailable; health: unavailable; entries: none");
  });
  it("ignores the wire remediation and derives guidance from validated values", () => {
    const snapshot = postgres();
    const wire = [A.migrationBehind, A.quarantine, "No action required.", "PRIVATE free text"];
    for (const [index, family] of ["pool", "migration", "extensions", "queue"].entries()) {
      Object.assign((snapshot.telemetry as never as Record<string, object>)[family]!, { remediation: wire[index]! });
    }
    const healthy = renderBackendDiagnostics(snapshot);
    expect(healthy).not.toContain("PRIVATE");
    expect(healthy).not.toContain(A.migrationBehind);
    expect(healthy).not.toContain(A.quarantine);
  });
  it("selects migration guidance for the validated history, never the wire text", () => {
    for (const [history, action] of [["behind", A.migrationBehind], ["ahead", A.migrationAhead], ["drift", A.migrationDrift], ["checksum-mismatch", A.migrationDrift], ["current", A.unavailable], ["PRIVATE", A.unavailable]] as const) {
      const snapshot = postgres();
      Object.assign(snapshot.telemetry.migration, { health: "degraded", historyStatus: history, remediation: A.quarantine });
      const text = renderBackendDiagnostics(snapshot);
      expect(text).toContain("Telemetry migration action: " + action);
      expect(text).not.toContain("PRIVATE");
    }
  });
  it("keeps degraded health for partial and observed families only", () => {
    for (const [status, health] of [["partial", "degraded"], ["observed", "degraded"], ["unavailable", "unavailable"]] as const) {
      const snapshot = postgres();
      Object.assign(snapshot.telemetry.queue, { status, health: "degraded" });
      expect(lineOf(renderBackendDiagnostics(snapshot), "Telemetry queue:")).toContain(status + "; health: " + health);
    }
  });
  it("never prints a healthy or wrong-family action for a degraded family", () => {
    const snapshot = postgres();
    Object.assign(snapshot.telemetry.extensions, { health: "degraded", remediation: "No action required." });
    Object.assign(snapshot.telemetry.pool, { health: "degraded", remediation: A.migrationBehind });
    Object.assign(snapshot.telemetry.queue, { health: "degraded", remediation: A.healthy });
    const text = renderBackendDiagnostics(snapshot);
    expect(text).toContain("Telemetry extensions action: " + A.extensions);
    expect(text).toContain("Telemetry pool action: " + A.unavailable);
    expect(text).toContain("Telemetry queue action: " + A.unavailable);
  });
  it("selects pool guidance from validated pool evidence", () => {
    const failed = postgres();
    failed.pool.failed = true;
    Object.assign(failed.telemetry.pool, { health: "degraded" });
    expect(renderBackendDiagnostics(failed)).toContain("Telemetry pool action: " + A.poolFailed);
    const saturated = postgres();
    Object.assign(saturated.pool, { configuredMax: 2, total: 2, idle: 0, waiting: 3 });
    Object.assign(saturated.telemetry.pool, { health: "degraded" });
    expect(renderBackendDiagnostics(saturated)).toContain("Telemetry pool action: " + A.poolSaturated);
  });
  it("gives quarantine guidance precedence over backlog and reads only a ready local outbox", () => {
    const snapshot = postgres();
    Object.assign(snapshot.telemetry.queue, { health: "degraded", inboxQuarantined: 2, replayLagSeconds: 5000 });
    expect(renderBackendDiagnostics(snapshot)).toContain("Telemetry queue action: " + A.quarantine);
    const local = postgres();
    local.outbox = { status: "ready", deliveryQuarantined: 4 };
    Object.assign(local.telemetry.queue, { health: "degraded" });
    expect(renderBackendDiagnostics(local)).toContain("Telemetry queue action: " + A.quarantine);
    local.outbox = { status: "unavailable", deliveryQuarantined: 4 };
    expect(renderBackendDiagnostics(local)).toContain("Telemetry queue action: " + A.unavailable);
    const backlog = postgres();
    Object.assign(backlog.telemetry.queue, { health: "degraded", outboxOldestPendingAgeSeconds: 901 });
    expect(renderBackendDiagnostics(backlog)).toContain("Telemetry queue action: " + A.backlog);
  });
  it("filters omissions against the family catalog and bounds traversal", () => {
    const snapshot = postgres();
    snapshot.telemetry.queue.omitted = [
      null, "x", { field: 5 }, { field: "PRIVATE", reason: "timeout" }, { field: "replayLagSeconds", reason: "PRIVATE" },
      { field: "inboxClaimed", reason: "limit-reached" },
    ] as never;
    expect(lineOf(renderBackendDiagnostics(snapshot), "Telemetry queue:")).toContain("omitted: none");
    snapshot.telemetry.queue.omitted = [
      null, { field: "inboxClaimed", reason: "limit-reached" }, { field: "PRIVATE", reason: "timeout" },
      { field: "replayLagSeconds", reason: "out-of-range" }, { field: "inboxQuarantined", reason: "timeout" },
    ] as never;
    const text = renderBackendDiagnostics(snapshot);
    expect(lineOf(text, "Telemetry queue:")).toContain("omitted: inboxClaimed=limit-reached");
    expect(lineOf(text, "Telemetry queue:")).toContain("replayLagSeconds=out-of-range");
    expect(lineOf(text, "Telemetry queue:")).not.toContain("inboxQuarantined");
    expect(text).not.toContain("PRIVATE");
    (snapshot.telemetry.queue as { omitted: unknown }).omitted = "x";
    expect(lineOf(renderBackendDiagnostics(snapshot), "Telemetry queue:")).toContain("omitted: none");
  });
  it("renders only validated numbers, extension names and versions", () => {
    const snapshot = postgres();
    Object.assign(snapshot.telemetry.pool, { saturationRatio: Infinity });
    Object.assign(snapshot.telemetry.migration, { appliedCount: -1, expectedCount: 1.5, historyStatus: "PRIVATE" });
    Object.assign(snapshot.telemetry.queue, { inboxClaimed: Number.MAX_SAFE_INTEGER + 1, inboxQuarantined: "3", replayLagSeconds: NaN, outboxOldestPendingAgeSeconds: -2 });
    (snapshot.telemetry.extensions as { entries: unknown }).entries = [
      { name: "pg_trgm", status: "current", installedVersion: "PRIVATE-1", defaultVersion: "2.0" },
      { name: "evil", status: "current", installedVersion: "1", defaultVersion: "1" },
      { name: "pgcrypto", status: "PRIVATE", installedVersion: "1", defaultVersion: "1" },
      { name: "unaccent", status: "current", installedVersion: "1", defaultVersion: "1", installedSchema: "PRIVATE" },
    ];
    const text = renderBackendDiagnostics(snapshot);
    expect(text).not.toMatch(/PRIVATE|Infinity|NaN|evil/);
    expect(lineOf(text, "Telemetry pool:")).toContain("saturation ratio: unverified");
    expect(lineOf(text, "Telemetry migration:")).toContain("history: unavailable; applied: unverified; expected: unverified");
    expect(lineOf(text, "Telemetry queue:")).toContain("outbox oldest pending age seconds: unverified; inbox claimed: unverified; inbox quarantined: unverified; replay lag seconds: unverified");
    expect(lineOf(text, "Telemetry extensions:")).toContain("pg_trgm: current (installed unrecognized, default 2.0); unaccent: current (installed 1, default 1)");
  });
  it("renders a failure DTO's mirrored statuses", () => {
    const text = renderBackendDiagnostics(backendDiagnosticFailure(Object.assign(new Error("x"), { code: "EACCES" })));
    expect(lineOf(text, "Telemetry pool:")).toContain("permission-denied; health: unavailable");
  });
});
