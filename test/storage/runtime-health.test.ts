import { describe, expect, it } from "vitest";
import {
  QUEUE_CANDIDATE_LIMIT, RUNTIME_HEALTH_ACTIONS, extensionVersion, extensionsAction, extensionsTelemetry,
  failUnfinishedTelemetry, failedServerQueueReads, isRecord, localPendingAgeRead, migrationAction, migrationTelemetry,
  ownValue, pickExtensions, poolAction, poolFacts, poolSaturationRatio, poolTelemetry, queueAction, queueTelemetry,
  TELEMETRY_FIELDS, safeCount, safeNumber, serverQueueReads, telemetryDegraded, telemetryFailureStatus, telemetryFillers,
  type QueueReads, type TelemetryFamilyName,
} from "../../src/storage/runtime-health.js";

const ACTIONS = RUNTIME_HEALTH_ACTIONS;
const names = ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"] as const;
const extension = (name: string, status = "current", installedVersion: unknown = "1.2", defaultVersion: unknown = "1.2") =>
  ({ name, status, installedVersion, defaultVersion });
const allExtensions = (status = "current") => names.map(name => extension(name, status));
const readyPool = (overrides: Record<string, unknown> = {}) =>
  ({ origin: "daemon", status: "ready", configuredMax: 4, total: 3, idle: 1, waiting: 0, failed: false, ...overrides });
const noReads: QueueReads = {
  inboxClaimed: { value: 0 }, inboxQuarantined: { value: 0 }, replayLagSeconds: { reason: "no-entry" },
  outboxOldestPendingAgeSeconds: { reason: "no-entry" },
};

describe("primitive validators", () => {
  it("accepts only own properties, exact counts and finite non-negative numbers", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(ownValue({ a: 1 }, "a")).toBe(1);
    expect(ownValue(Object.create({ a: 1 }) as Record<string, unknown>, "a")).toBeUndefined();
    expect(safeCount(3)).toBe(3);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", NaN]) expect(safeCount(bad)).toBeUndefined();
    expect(safeNumber(1.5)).toBe(1.5);
    for (const bad of [-0.1, Infinity, NaN, "1", null]) expect(safeNumber(bad)).toBeUndefined();
  });
  it("maps classifications to closed failure statuses", () => {
    expect(telemetryFailureStatus("permission-denied")).toBe("permission-denied");
    expect(telemetryFailureStatus("timeout")).toBe("timeout");
    for (const other of ["healthy", "stale-publication", "unavailable", "anything"]) expect(telemetryFailureStatus(other)).toBe("unavailable");
  });
});

describe("fillers and folding", () => {
  it("reports four not-applicable families for SQLite and failures elsewhere", () => {
    const sqlite = telemetryFillers("sqlite", "timeout", 5);
    for (const family of Object.values(sqlite)) expect(family).toEqual({ status: "not-applicable", observedAt: 5, omitted: [] });
    for (const backend of ["postgresql", "unavailable"] as const) {
      const failed = telemetryFillers(backend, "permission-denied", 7);
      expect(failed.pool).toMatchObject({ status: "permission-denied", health: "unavailable", observedAt: 7, remediation: ACTIONS.unavailable });
      expect(failed.migration).toMatchObject({ status: "permission-denied", historyStatus: "unavailable" });
      expect(failed.extensions).toMatchObject({ status: "permission-denied", entries: [] });
      expect(failed.queue).toMatchObject({ status: "permission-denied" });
      expect((failed.extensions.omitted).map(entry => entry.field)).toEqual([...names]);
      expect(failed.queue.omitted.every(entry => entry.reason === "permission-denied")).toBe(true);
    }
  });
  it("rewrites only unfinished families", () => {
    const original = telemetryFillers("postgresql", "unavailable", 1);
    const marker = { ...original, pool: poolTelemetry(readyPool(), 2) };
    const none = failUnfinishedTelemetry(marker, new Set(), "timeout", 3);
    for (const family of Object.values(none)) expect(family).toMatchObject({ status: "timeout", observedAt: 3 });
    const all = failUnfinishedTelemetry(marker, new Set<TelemetryFamilyName>(["pool", "migration", "extensions", "queue"]), "timeout", 3);
    expect(all).toEqual(marker);
    const some = failUnfinishedTelemetry(marker, new Set<TelemetryFamilyName>(["pool", "queue"]), "timeout", 3);
    expect(some.pool).toBe(marker.pool);
    expect(some.queue).toBe(marker.queue);
    expect(some.migration).toMatchObject({ status: "timeout" });
    expect(some.extensions).toMatchObject({ status: "timeout" });
  });
  it("detects a degraded family but never a not-applicable or unhealthy one", () => {
    expect(telemetryDegraded(telemetryFillers("sqlite", "timeout", 1))).toBe(false);
    expect(telemetryDegraded(telemetryFillers("postgresql", "timeout", 1))).toBe(false);
    const degraded = { ...telemetryFillers("postgresql", "timeout", 1), pool: poolTelemetry(readyPool({ failed: true }), 1) };
    expect(telemetryDegraded(degraded)).toBe(true);
  });
});

describe("pool interpretation", () => {
  it("rejects unverified pools and invalid counters", () => {
    expect(poolFacts(null)).toBeUndefined();
    expect(poolFacts(readyPool({ status: "unverified" }))).toBeUndefined();
    for (const key of ["configuredMax", "total", "idle", "waiting"]) {
      expect(poolFacts(readyPool({ [key]: -1 }))).toBeUndefined();
      expect(poolFacts(readyPool({ [key]: undefined }))).toBeUndefined();
    }
    expect(poolFacts(readyPool({ failed: undefined }))).toMatchObject({ failed: false });
    expect(poolFacts(readyPool({ failed: true }))).toMatchObject({ failed: true, origin: "daemon" });
    expect(poolTelemetry(readyPool({ status: "unverified" }), 4)).toMatchObject({
      status: "unavailable", health: "unavailable", omitted: [{ field: "saturationRatio", reason: "unavailable" }],
    });
  });
  it("computes busy over configured maximum without clamping", () => {
    expect(poolSaturationRatio(poolFacts(readyPool())!)).toBe(0.5);
    expect(poolSaturationRatio(poolFacts(readyPool({ configuredMax: 2, total: 5, idle: 0 }))!)).toBe(2.5);
    expect(poolSaturationRatio(poolFacts(readyPool({ configuredMax: 0 }))!)).toBeUndefined();
    expect(poolSaturationRatio(poolFacts(readyPool({ idle: 4 }))!)).toBeUndefined();
  });
  it.each([
    ["daemon saturated with waiters", { configuredMax: 2, total: 2, idle: 0, waiting: 1 }, "degraded", ACTIONS.poolSaturated],
    ["ratio above one with waiters", { configuredMax: 2, total: 5, idle: 0, waiting: 3 }, "degraded", ACTIONS.poolSaturated],
    ["saturated without waiters", { configuredMax: 2, total: 2, idle: 0, waiting: 0 }, "healthy", ACTIONS.healthy],
    ["waiters below saturation", { configuredMax: 4, total: 2, idle: 0, waiting: 5 }, "healthy", ACTIONS.healthy],
    ["probe origin saturated", { origin: "diagnostic-probe", configuredMax: 2, total: 2, idle: 0, waiting: 1 }, "healthy", ACTIONS.healthy],
    ["failed latch", { failed: true }, "degraded", ACTIONS.poolFailed],
    ["failed latch beats saturation", { configuredMax: 2, total: 2, idle: 0, waiting: 1, failed: true }, "degraded", ACTIONS.poolFailed],
  ])("%s", (_name, overrides, health, action) => {
    expect(poolTelemetry(readyPool(overrides), 9)).toMatchObject({ status: "observed", health, remediation: action, omitted: [], observedAt: 9 });
  });
  it("marks an invalid relationship partial and degraded only by the failure latch", () => {
    expect(poolTelemetry(readyPool({ configuredMax: 0 }), 1)).toMatchObject({
      status: "partial", health: "unavailable", omitted: [{ field: "saturationRatio", reason: "invalid-input" }],
      remediation: ACTIONS.unavailable,
    });
    const failed = poolTelemetry(readyPool({ idle: 9, failed: true }), 1);
    expect(failed).toMatchObject({ status: "partial", health: "degraded", remediation: ACTIONS.poolFailed });
    expect(failed).not.toHaveProperty("saturationRatio");
  });
  it("names the reason for each invalid pool relationship", () => {
    expect(poolTelemetry(readyPool({ configuredMax: 0 }), 1)).toMatchObject({ omitted: [{ field: "saturationRatio", reason: "invalid-input" }] });
    expect(poolTelemetry(readyPool({ total: 2, idle: 3 }), 1)).toMatchObject({ status: "partial", omitted: [{ field: "saturationRatio", reason: "invalid-input" }] });
  });
  it("omits the ratio as out-of-range only for the boundary's out-of-range rejection, and as unavailable otherwise", () => {
    const unverified = readyPool({ status: "unverified" });
    expect(poolTelemetry(unverified, 3, "out-of-range")).toEqual({
      status: "partial", observedAt: 3, health: "unavailable", remediation: ACTIONS.unavailable,
      omitted: [{ field: "saturationRatio", reason: "out-of-range" }],
    });
    for (const rejection of [undefined, "unavailable"] as const) {
      expect(poolTelemetry(unverified, 3, rejection)).toMatchObject({ status: "unavailable", omitted: [{ field: "saturationRatio", reason: "unavailable" }] });
    }
  });
  it("selects guidance only from validated evidence", () => {
    expect(poolAction("degraded", undefined)).toBe(ACTIONS.unavailable);
    expect(poolAction("degraded", poolFacts(readyPool()))).toBe(ACTIONS.unavailable);
    expect(poolAction("unavailable", poolFacts(readyPool({ failed: true })))).toBe(ACTIONS.unavailable);
    expect(poolAction("healthy", poolFacts(readyPool({ failed: true })))).toBe(ACTIONS.healthy);
  });
});

const expected = [{ id: "0001_a", sha256: "a" }, { id: "0002_b", sha256: "b" }, { id: "0003_c", sha256: "c" }];
const row = (id: string, checksum = id.slice(-1)) => ({ id, checksum_sha256: checksum });
const ledger = (...rows: unknown[]) => ({ expected, rows });

describe("migration interpretation", () => {
  it("reports a current ledger with an exact count", () => {
    expect(migrationTelemetry(ledger(row("0001_a"), row("0002_b"), row("0003_c")), 1)).toEqual({
      status: "observed", observedAt: 1, health: "healthy", omitted: [], historyStatus: "current",
      appliedCount: 3, expectedCount: 3, remediation: ACTIONS.healthy,
    });
  });
  it("reports empty and short ledgers as behind", () => {
    expect(migrationTelemetry(ledger(), 1)).toMatchObject({
      status: "observed", health: "degraded", historyStatus: "behind", appliedCount: 0, remediation: ACTIONS.migrationBehind,
    });
    expect(migrationTelemetry(ledger(row("0001_a")), 1)).toMatchObject({ historyStatus: "behind", appliedCount: 1 });
  });
  it("reports a longer ledger as ahead and partial without an exact total", () => {
    const result = migrationTelemetry(ledger(row("0001_a"), row("0002_b"), row("0003_c"), row("0004_d")), 1);
    expect(result).toMatchObject({
      status: "partial", health: "degraded", historyStatus: "ahead", expectedCount: 3,
      omitted: [{ field: "appliedCount", reason: "limit-reached" }], remediation: ACTIONS.migrationAhead,
    });
    expect(result).not.toHaveProperty("appliedCount");
    const bounded = migrationTelemetry(ledger(row("0001_a"), row("0002_b"), row("0003_c"), row("0004_d"), row("0005_e")), 1);
    expect(bounded).toMatchObject({ historyStatus: "ahead" });
  });
  it("prefers drift over checksum mismatch over count mismatch", () => {
    expect(migrationTelemetry(ledger(row("0001_a"), row("0003_c")), 1)).toMatchObject({ historyStatus: "drift", remediation: ACTIONS.migrationDrift, appliedCount: 2 });
    expect(migrationTelemetry(ledger(row("0001_a", "x"), row("0003_c")), 1)).toMatchObject({ historyStatus: "drift" });
    expect(migrationTelemetry(ledger(row("0001_a", "x")), 1)).toMatchObject({ historyStatus: "checksum-mismatch", health: "degraded", remediation: ACTIONS.migrationDrift });
    expect(migrationTelemetry(ledger(row("0001_a"), row("0002_b"), row("0003_c", "x"), row("0004_d")), 1)).toMatchObject({ historyStatus: "checksum-mismatch", status: "partial" });
    expect(migrationTelemetry(ledger(row("0009_z"), row("0002_b"), row("0003_c"), row("0004_d")), 1)).toMatchObject({ historyStatus: "drift", status: "partial" });
  });
  it("treats malformed rows as an unobserved ledger", () => {
    for (const bad of [null, "x", { id: 1, checksum_sha256: "a" }, { id: "0001_a" }, { id: "0001_a", checksum_sha256: 5 }]) {
      expect(migrationTelemetry(ledger(bad), 1)).toEqual({
        status: "unavailable", observedAt: 1, health: "unavailable", remediation: ACTIONS.unavailable,
        historyStatus: "unavailable", expectedCount: 3, omitted: [{ field: "appliedCount", reason: "unavailable" }],
      });
    }
  });
  it("selects migration guidance from the validated history", () => {
    expect(migrationAction("degraded", "behind")).toBe(ACTIONS.migrationBehind);
    expect(migrationAction("degraded", "ahead")).toBe(ACTIONS.migrationAhead);
    expect(migrationAction("degraded", "drift")).toBe(ACTIONS.migrationDrift);
    expect(migrationAction("degraded", "checksum-mismatch")).toBe(ACTIONS.migrationDrift);
    expect(migrationAction("degraded", "current")).toBe(ACTIONS.unavailable);
    expect(migrationAction("degraded", "hostile")).toBe(ACTIONS.unavailable);
    expect(migrationAction("healthy", "behind")).toBe(ACTIONS.healthy);
    expect(migrationAction("unavailable", "behind")).toBe(ACTIONS.unavailable);
  });
});

describe("extension interpretation", () => {
  it("accepts versions only in the numeric form", () => {
    for (const good of ["1", "1.2", "1.2.3"]) expect(extensionVersion(good)).toBe(good);
    for (const bad of ["1.2.3.4", "v1", "1.x", "", null, undefined, 1.2, "1.2\n"]) expect(extensionVersion(bad)).toBe("unrecognized");
  });
  it("observes four current extensions", () => {
    expect(extensionsTelemetry(allExtensions(), 1)).toMatchObject({
      status: "observed", health: "healthy", omitted: [], remediation: ACTIONS.healthy,
      entries: names.map(name => ({ name, status: "current", installedVersion: "1.2", defaultVersion: "1.2" })),
    });
  });
  it("degrades on any known non-current status and drops private fields", () => {
    const source = allExtensions();
    source[1] = { ...extension("pg_trgm", "wrong-namespace", null, "1.3"), installedSchema: "private_schema", remediation: "ALTER EXTENSION private" } as never;
    const result = extensionsTelemetry(source, 1);
    expect(result).toMatchObject({ status: "observed", health: "degraded", remediation: ACTIONS.extensions });
    expect(JSON.stringify(result)).not.toMatch(/private/);
    expect((result as { entries: unknown[] }).entries[1]).toEqual({ name: "pg_trgm", status: "wrong-namespace", installedVersion: "unrecognized", defaultVersion: "1.3" });
    expect(extensionsAction("degraded")).toBe(ACTIONS.extensions);
  });
  it("omits missing, duplicate, invalid and unknown records", () => {
    const source = [
      extension("pg_stat_statements"), extension("pg_trgm"), extension("pg_trgm"), extension("pgcrypto", "hostile"),
      extension("evil"), "text", null,
    ];
    const result = extensionsTelemetry(source, 1);
    expect(result).toMatchObject({
      status: "partial", health: "unavailable", remediation: ACTIONS.unavailable,
      omitted: [{ field: "pg_trgm", reason: "unavailable" }, { field: "pgcrypto", reason: "unavailable" }, { field: "unaccent", reason: "unavailable" }],
    });
    expect((result as { entries: { name: string }[] }).entries.map(entry => entry.name)).toEqual(["pg_stat_statements"]);
    expect(JSON.stringify(result)).not.toContain("evil");
  });
  it("keeps a proven degraded entry visible next to omissions", () => {
    expect(extensionsTelemetry([extension("pgcrypto", "uninstalled", null, null)], 1)).toMatchObject({ status: "partial", health: "degraded" });
  });
  it("is unavailable without any usable source and bounds the inspected records", () => {
    for (const source of [undefined, "x", {}, []]) expect(extensionsTelemetry(source, 1)).toMatchObject({ status: "unavailable", health: "unavailable", entries: [] });
    const padded = [...Array.from({ length: 16 }, () => extension("evil")), ...allExtensions()];
    expect(pickExtensions(padded).entries).toEqual([]);
  });
});

describe("queue interpretation", () => {
  it("parses server reads strictly and never publishes a capped total", () => {
    expect(serverQueueReads({ capReached: false, claimed: "2", quarantined: "0", lagSeconds: "12.5" })).toEqual({
      inboxClaimed: { value: 2 }, inboxQuarantined: { value: 0 }, replayLagSeconds: { value: 12.5 },
    });
    expect(serverQueueReads({ capReached: false, claimed: "1", quarantined: "1", lagSeconds: null }).replayLagSeconds).toEqual({ reason: "no-entry" });
    for (const bad of [2, null, "", "-1", "1.5", "0x10", "9007199254740993", " 1"]) {
      expect(serverQueueReads({ capReached: false, claimed: bad, quarantined: bad, lagSeconds: "0" }).inboxClaimed).toEqual({ reason: "out-of-range" });
    }
    for (const bad of [5, "-0.5", "NaN", "Infinity", "1e3", "", "1."]) {
      expect(serverQueueReads({ capReached: false, claimed: "0", quarantined: "0", lagSeconds: bad }).replayLagSeconds).toEqual({ reason: "out-of-range" });
    }
    const capped = serverQueueReads({ capReached: true, claimed: "5", quarantined: "5", lagSeconds: "5" });
    expect(Object.values(capped)).toEqual([{ reason: "limit-reached" }, { reason: "limit-reached" }, { reason: "limit-reached" }]);
    expect(Object.values(failedServerQueueReads("timeout"))).toEqual([{ reason: "timeout" }, { reason: "timeout" }, { reason: "timeout" }]);
    expect(QUEUE_CANDIDATE_LIMIT).toBe(4096);
  });
  const now = Date.UTC(2026, 1, 3, 12, 0, 0);
  it("computes whole-second local age from a strict UTC timestamp", () => {
    expect(localPendingAgeRead("2026-02-03 11:00:00", now)).toEqual({ value: 3600 });
    expect(localPendingAgeRead("2026-02-03 12:00:00", now)).toEqual({ value: 0 });
    expect(localPendingAgeRead("2024-02-29 00:00:00", now)).toMatchObject({ value: expect.any(Number) });
    expect(localPendingAgeRead("0099-12-31 23:59:59", now)).toMatchObject({ value: expect.any(Number) });
    expect(localPendingAgeRead(undefined, now)).toEqual({ reason: "unavailable" });
    expect(localPendingAgeRead(null, now)).toEqual({ reason: "no-entry" });
    for (const bad of [5, "", "2026-02-03T11:00:00Z", "2026-02-03 11:00", "2026-02-30 00:00:00", "2025-02-29 00:00:00",
      "2026-13-01 00:00:00", "2026-01-01 24:00:00", "2026-01-01 00:60:00", "2026-01-01 00:00:60", "2026-02-03 12:00:01"]) {
      expect(localPendingAgeRead(bad, now)).toEqual({ reason: "out-of-range" });
    }
  });
  it("is independent of the process time zone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      expect(localPendingAgeRead("2026-02-03 11:00:00", now)).toEqual({ value: 3600 });
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });
  it("observes an empty proven queue as healthy with no-entry ages", () => {
    expect(queueTelemetry(noReads, undefined, 4)).toEqual({
      status: "observed", observedAt: 4, health: "healthy", remediation: ACTIONS.healthy, inboxClaimed: 0, inboxQuarantined: 0,
      omitted: [{ field: "replayLagSeconds", reason: "no-entry" }, { field: "outboxOldestPendingAgeSeconds", reason: "no-entry" }].reverse(),
    });
  });
  it.each([
    ["inbox quarantine", { inboxQuarantined: { value: 1 } }, undefined, ACTIONS.quarantine],
    ["local quarantine", {}, 2, ACTIONS.quarantine],
    ["quarantine beats backlog", { inboxQuarantined: { value: 1 }, replayLagSeconds: { value: 901 } }, undefined, ACTIONS.quarantine],
    ["local age backlog", { outboxOldestPendingAgeSeconds: { value: 901 } }, undefined, ACTIONS.backlog],
    ["replay lag backlog", { replayLagSeconds: { value: 900.5 } }, undefined, ACTIONS.backlog],
  ])("degrades on %s", (_name, reads, localQuarantined, action) => {
    expect(queueTelemetry({ ...noReads, ...reads } as QueueReads, localQuarantined, 1)).toMatchObject({ status: "observed", health: "degraded", remediation: action });
  });
  it("keeps exact thresholds healthy", () => {
    const result = queueTelemetry({ ...noReads, replayLagSeconds: { value: 900 }, outboxOldestPendingAgeSeconds: { value: 900 } }, 0, 1);
    expect(result).toMatchObject({ status: "observed", health: "healthy" });
  });
  it("becomes partial when one source fails and unhealthy unless a bad condition is proven", () => {
    const failedServer = { ...failedServerQueueReads("permission-denied"), outboxOldestPendingAgeSeconds: { value: 3 } } as QueueReads;
    expect(queueTelemetry(failedServer, undefined, 1)).toMatchObject({ status: "partial", health: "unavailable", outboxOldestPendingAgeSeconds: 3, remediation: ACTIONS.unavailable });
    const proven = { ...failedServerQueueReads("timeout"), outboxOldestPendingAgeSeconds: { value: 5000 } } as QueueReads;
    expect(queueTelemetry(proven, undefined, 1)).toMatchObject({ status: "partial", health: "degraded", remediation: ACTIONS.backlog });
    const noEntryOnly = { ...failedServerQueueReads("timeout"), outboxOldestPendingAgeSeconds: { reason: "no-entry" } } as QueueReads;
    expect(queueTelemetry(noEntryOnly, undefined, 1)).toMatchObject({ status: "partial", health: "unavailable" });
  });
  it("uses the strongest family-wide failure when nothing is usable", () => {
    const base = { ...failedServerQueueReads("timeout"), outboxOldestPendingAgeSeconds: { reason: "unavailable" } } as QueueReads;
    expect(queueTelemetry(base, undefined, 1)).toMatchObject({ status: "timeout", health: "unavailable" });
    expect(queueTelemetry({ ...base, outboxOldestPendingAgeSeconds: { reason: "permission-denied" } } as QueueReads, undefined, 1)).toMatchObject({ status: "permission-denied" });
    expect(queueTelemetry({ ...failedServerQueueReads("unavailable"), outboxOldestPendingAgeSeconds: { reason: "unavailable" } } as QueueReads, undefined, 1)).toMatchObject({ status: "unavailable" });
    const outOfRange = { inboxClaimed: { reason: "out-of-range" }, inboxQuarantined: { reason: "out-of-range" }, replayLagSeconds: { reason: "out-of-range" }, outboxOldestPendingAgeSeconds: { reason: "out-of-range" } } as QueueReads;
    expect(queueTelemetry(outOfRange, undefined, 1)).toMatchObject({ status: "unavailable" });
  });
  it("counts a verified local quarantine and a cap sentinel as usable queue evidence", () => {
    const nothing = { ...failedServerQueueReads("timeout"), outboxOldestPendingAgeSeconds: { reason: "out-of-range" } } as QueueReads;
    expect(queueTelemetry(nothing, 0, 1)).toMatchObject({ status: "partial", health: "unavailable", remediation: ACTIONS.unavailable });
    expect(queueTelemetry(nothing, 2, 1)).toMatchObject({ status: "partial", health: "degraded", remediation: ACTIONS.quarantine });
    const capped = { ...serverQueueReads({ capReached: true, claimed: "1", quarantined: "1", lagSeconds: "1" }), outboxOldestPendingAgeSeconds: { reason: "unavailable" } } as QueueReads;
    expect(queueTelemetry(capped, undefined, 1)).toEqual({
      status: "partial", observedAt: 1, health: "unavailable", remediation: ACTIONS.unavailable,
      omitted: [
        { field: "outboxOldestPendingAgeSeconds", reason: "unavailable" }, { field: "inboxClaimed", reason: "limit-reached" },
        { field: "inboxQuarantined", reason: "limit-reached" }, { field: "replayLagSeconds", reason: "limit-reached" },
      ].sort((left, right) => TELEMETRY_FIELDS.queue.indexOf(left.field as never) - TELEMETRY_FIELDS.queue.indexOf(right.field as never)),
    });
  });
  it("selects queue guidance with quarantine precedence", () => {
    expect(queueAction("degraded", {})).toBe(ACTIONS.unavailable);
    expect(queueAction("degraded", { inboxQuarantined: 0 })).toBe(ACTIONS.unavailable);
    expect(queueAction("degraded", { localQuarantined: 1, replayLagSeconds: 5000 })).toBe(ACTIONS.quarantine);
    expect(queueAction("degraded", { replayLagSeconds: 5000 })).toBe(ACTIONS.backlog);
    expect(queueAction("healthy", { inboxQuarantined: 9 })).toBe(ACTIONS.healthy);
    expect(queueAction("unavailable", { inboxQuarantined: 9 })).toBe(ACTIONS.unavailable);
  });
});
