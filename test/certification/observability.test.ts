import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateEvidence } from "../postgresql/cutover-rehearsal/check-evidence.js";
import { RUNTIME_HEALTH_ACTIONS, telemetryFillers } from "../../src/storage/runtime-health.js";
import { QUERY_OPERATION_IDS } from "../../src/storage/postgresql/query-operations.js";
import { createQueryStatisticsFamily } from "../../src/storage/postgresql/query-statistics.js";
import { CANARY_CLI_SURFACES, createCanaryWorkload } from "./canary-corpus.mjs";
import {
  CANARY_CORPUS,
  OBSERVABILITY_ACTIONS,
  backlogAgeBracket,
  buildSecretInventory,
  buildObservabilitySummary,
  createInventoryManifest,
  createProbeSchedule,
  encodedScanForms,
  evaluateBarrierSequence,
  evaluateCalibrationPairs,
  evaluateFencedReset,
  evaluateConnectionEvidence,
  evaluatePhaseProbeEvidence,
  evaluatePhaseWorkload,
  evaluateProbePopulation,
  evaluateSaturationWitness,
  evaluateTimeoutShape,
  evaluateWorkloadCompleteness,
  observabilityApplicability,
  scanSurface,
  scanHashedInventory,
  validateTelemetryCardinality,
} from "./observability.mjs";

const healthyFamily = (extra: Record<string, unknown> = {}) => ({
  status: "observed", health: "healthy", observedAt: 100,
  remediation: "No action required.", omitted: [], ...extra,
});

function validTelemetry() {
  return {
    statements: {
      status: "observed", scope: "aggregate", observedAt: 100,
      statementsStatsReset: "2026-11-04T00:00:00.000Z", statementsDeallocTotal: 0,
      blockSize: 8192, omitted: {}, operations: [{ operation: "conversations.getMessages", values: { queryCallsTotal: 2 }, omitted: {} }],
    },
    pool: healthyFamily({ saturationRatio: 0.5 }),
    migration: healthyFamily({ historyStatus: "current", expectedCount: 9, appliedCount: 9 }),
    extensions: healthyFamily({ entries: [
      { name: "pg_stat_statements", status: "current", installedVersion: "1", defaultVersion: "1" },
      { name: "pg_trgm", status: "current", installedVersion: "1", defaultVersion: "1" },
      { name: "pgcrypto", status: "current", installedVersion: "1", defaultVersion: "1" },
      { name: "unaccent", status: "current", installedVersion: "1", defaultVersion: "1" },
    ] }),
    queue: healthyFamily({ inboxClaimed: 0, inboxQuarantined: 0, replayLagSeconds: 0, outboxOldestPendingAgeSeconds: 0 }),
  };
}

function healthySnapshotFixture() {
  return { classification: "healthy", pool: { status: "ready", origin: "daemon", failed: false } };
}

describe("observability certification helpers", () => {
  it("uses one unique shared incident canary corpus", () => {
    expect(CANARY_CORPUS).toHaveLength(22);
    expect(new Set(CANARY_CORPUS).size).toBe(CANARY_CORPUS.length);
  });

  it("scans raw, escaped, encoded and truncation-boundary canary forms", () => {
    const canary = "incident-message-content-canary";
    const forms = encodedScanForms(canary, 24);
    expect(forms).toEqual(expect.arrayContaining([
      canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary),
      Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("hex"), canary.slice(0, 24),
    ]));
    for (const form of forms) {
      expect(scanSurface(Buffer.from(`before ${form} after`), [], [canary]).canaryHits).toBeGreaterThan(0);
    }
  });

  it("counts exact input bytes without lossy UTF-8 re-encoding", () => {
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from("incident-message-content-canary")]);
    expect(scanSurface(bytes, [], ["incident-message-content-canary"])).toMatchObject({ bytes: bytes.length, canaryHits: expect.any(Number) });
    expect(scanSurface(bytes, [], ["incident-message-content-canary"]).canaryHits).toBeGreaterThan(0);
  });

  it("builds countable witnesses for every canary input and CLI surface", () => {
    const workload = createCanaryWorkload("run", "a");
    expect(workload.hooks).toHaveLength(CANARY_CORPUS.length * 2);
    expect(workload.stores).toHaveLength(CANARY_CORPUS.length);
    expect(workload.searches).toHaveLength(CANARY_CORPUS.length);
    expect(workload.cli).toHaveLength(CANARY_CLI_SURFACES.length);
    expect(workload.utility.sql).toContain("incident-app-canary");
    expect(new Set([
      ...workload.hooks, ...workload.stores, ...workload.searches, workload.utility, ...workload.cli,
    ].map((entry) => entry.id)).size).toBe(CANARY_CORPUS.length * 4 + CANARY_CLI_SURFACES.length + 1);
  });

  it("requires every inventory category and scans short values only at token boundaries", () => {
    const inventory = buildSecretInventory({
      runtimeUrl: "postgresql://runtime:pw@db/lcm", runtimePassword: "pw", runtimeRole: "runtime",
      migrationRole: "migrator", databaseName: "lcm", databaseHost: "db", databaseAddress: "1.2.3.4",
      caPem: "-----BEGIN CERTIFICATE-----\nBODY\n-----END CERTIFICATE-----", caBodyLines: ["BODY"], caFile: "/ca.pem",
      daemonToken: "daemon-token", projectPath: "/project", homePath: "/home/lcm", containerHostname: "machine-a",
    });
    expect(inventory.every((entry) => entry.value.length > 0 && entry.sourceClass.length > 0)).toBe(true);
    const short = inventory.find((entry) => entry.category === "runtime-password")!;
    expect(short.scanMode).toBe("boundary-token");
    expect(scanSurface(Buffer.from("xpwz"), [short], []).secretHits).toBe(0);
    expect(scanSurface(Buffer.from("pw;"), [short], []).secretHits).toBe(1);
    expect(createInventoryManifest(inventory, "a").caBody).toMatchObject({ count: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(() => createInventoryManifest(inventory.filter((entry) => !entry.category.startsWith("ca-body-line-")), "a")).toThrow("CA body lines are incomplete");
    expect(() => buildSecretInventory({ runtimeUrl: "" } as any)).toThrow("runtime-url");
  });

  it("persists no inventory values while retaining a private public-output scan", () => {
    const manifest = createInventoryManifest([
      { category: "runtime-role", sourceClass: "runtime-url", scanMode: "all-forms", value: "private-role-value" },
    ], "a");
    expect(JSON.stringify(manifest)).not.toContain("private-role-value");
    expect(scanHashedInventory(Buffer.from("safe private-role-value output"), [manifest]).hits).toBeGreaterThan(0);
  });

  it("rejects cardinality extra operations, fields, duplicate operations and oversized arrays", () => {
    expect(validateTelemetryCardinality(validTelemetry(), { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("pass");
    const extraOperation = validTelemetry();
    extraOperation.statements.operations.push({ operation: "extra", values: {}, omitted: {} });
    expect(validateTelemetryCardinality(extraOperation, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons).toContain("statements.operations[1].operation is not cataloged");
    const extraField = validTelemetry() as any;
    extraField.pool.secret = "no";
    expect(validateTelemetryCardinality(extraField, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons).toContain("pool has unknown key secret");
    const duplicate = validTelemetry();
    duplicate.statements.operations.push({ operation: "conversations.getMessages", values: {}, omitted: {} });
    expect(validateTelemetryCardinality(duplicate, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).duplicateKeys).toBe(1);
    const oversized = validTelemetry();
    oversized.statements.operations = Array.from({ length: 65 }, () => ({ operation: "conversations.getMessages", values: {}, omitted: {} }));
    expect(validateTelemetryCardinality(oversized, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("fail");
    const extraOperationField = validTelemetry() as any;
    extraOperationField.statements.operations[0].secret = 1;
    expect(validateTelemetryCardinality(extraOperationField, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons).toContain("statements operation has unknown key secret");
  });

  it("accepts lawful failure fillers and rejects malformed closed labels", () => {
    expect(validateTelemetryCardinality({
      statements: createQueryStatisticsFamily("timeout", 100),
      ...telemetryFillers("postgresql", "timeout", 100),
    }, { operationIds: QUERY_OPERATION_IDS, maximumOperations: 64 }).verdict).toBe("pass");
    const failure = validTelemetry() as any;
    failure.extensions = {
      status: "timeout", observedAt: 100, health: "unavailable",
      remediation: RUNTIME_HEALTH_ACTIONS.unavailable,
      omitted: ["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"].map((field) => ({ field, reason: "timeout" })),
      entries: [],
    };
    failure.statements = { status: "timeout", observedAt: 100, scope: "aggregate", omitted: {} };
    expect(validateTelemetryCardinality(failure, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("pass");
    const malformed = validTelemetry() as any;
    malformed.migration.historyStatus = "invented";
    malformed.extensions.entries[0].status = "invented";
    malformed.statements.scope = "selected";
    expect(validateTelemetryCardinality(malformed, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("fail");
    const missingRequired = validTelemetry() as any;
    delete missingRequired.pool.health;
    delete missingRequired.migration.remediation;
    missingRequired.queue.omitted = {};
    expect(validateTelemetryCardinality(missingRequired, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("fail");
    const unaccounted = validTelemetry() as any;
    delete unaccounted.queue.replayLagSeconds;
    expect(validateTelemetryCardinality(unaccounted, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons)
      .toContain("queue.replayLagSeconds must be present or omitted exclusively");
    const contradictory = validTelemetry() as any;
    contradictory.queue.omitted = [{ field: "replayLagSeconds", reason: "no-entry" }];
    expect(validateTelemetryCardinality(contradictory, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons)
      .toContain("queue.replayLagSeconds must be present or omitted exclusively");
  });

  it("accepts both legal timeout shapes and rejects a non-timeout classification", () => {
    expect(evaluateTimeoutShape({ classification: "timeout", pool: { origin: "daemon", status: "ready", failed: false }, telemetry: {
      pool: healthyFamily(), extensions: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable }, migration: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable }, queue: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable }, statements: { status: "timeout" },
    } }).verdict).toBe("pass");
    expect(evaluateTimeoutShape({ classification: "timeout", pool: { origin: "daemon", status: "ready", failed: false }, telemetry: {
      pool: healthyFamily(), extensions: healthyFamily(), migration: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable }, queue: { status: "unavailable", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable }, statements: { status: "timeout" },
    } }).verdict).toBe("pass");
    expect(evaluateTimeoutShape({ classification: "healthy", telemetry: validTelemetry() }).verdict).toBe("fail");
    expect(evaluateTimeoutShape({ classification: "timeout", pool: { origin: "daemon", status: "ready", failed: false }, telemetry: {
      pool: healthyFamily({ health: "degraded", remediation: RUNTIME_HEALTH_ACTIONS.poolSaturated }),
      extensions: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable },
      migration: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable },
      queue: { status: "timeout", health: "unavailable", remediation: RUNTIME_HEALTH_ACTIONS.unavailable },
      statements: { status: "timeout" },
    } }).verdict).toBe("fail");
  });

  it("distinguishes fencing straddlers that consume reset from those retaining the old epoch", () => {
    const oldEpoch = "2026-11-04T00:00:00.000Z";
    const newEpoch = "2026-11-05T00:00:00.000Z";
    expect(evaluateFencedReset({ baselineEpoch: oldEpoch, appliedAtMs: 20, observations: [
      { startedAtMs: 10, completedAtMs: 30, status: "reset", epoch: newEpoch },
      { startedAtMs: 31, completedAtMs: 32, status: "observed", epoch: newEpoch },
    ] }).verdict).toBe("fail");
    expect(evaluateFencedReset({ baselineEpoch: oldEpoch, appliedAtMs: 20, observations: [
      { startedAtMs: 10, completedAtMs: 19, status: "observed", epoch: oldEpoch },
      { startedAtMs: 21, completedAtMs: 22, status: "reset", epoch: newEpoch },
      { startedAtMs: 23, completedAtMs: 24, status: "observed", epoch: newEpoch },
    ] }).verdict).toBe("pass");
    expect(evaluateFencedReset({ baselineEpoch: newEpoch, appliedAtMs: 20, observations: [
      { startedAtMs: 21, completedAtMs: 22, status: "reset", epoch: oldEpoch },
      { startedAtMs: 23, completedAtMs: 24, status: "observed", epoch: oldEpoch },
    ] }).verdict).toBe("fail");
  });

  describe("restart identification", () => {
    // Smoke 3: the database stop completed at 08:13:17.553 and the coordinator recorded the
    // clear at 08:13:19.147. Each machine's probe 0 started inside that window, after the
    // database was back, and read `reset` with the unchanged stats_reset epoch; probe 1,
    // after the clear, read `observed`.
    const appliedAtMs = Date.parse("2026-11-06T08:13:17.553Z");
    const fault = { appliedAt: "2026-11-06T08:13:17.553Z", clearedAt: "2026-11-06T08:13:19.147Z" };
    const epoch = "2026-11-06T07:37:35.383308Z";
    const read = (machine: string, sequence: number, startedAt: string, completedAt: string, classification: string, status?: string) => ({
      id: `restart-database-${machine}-probe-${sequence}`, machine, phase: "restart-database", sequence,
      startedAtMs: Date.parse(startedAt), completedAtMs: Date.parse(completedAt),
      snapshot: { classification, ...(status === undefined ? {} : { telemetry: { statements: { status, statementsStatsReset: epoch } } }) },
    });
    const smoke3 = [
      read("a", 0, "2026-11-06T08:13:18.165Z", "2026-11-06T08:13:18.420Z", "degraded", "reset"),
      read("a", 1, "2026-11-06T08:13:22.552Z", "2026-11-06T08:13:22.795Z", "healthy", "observed"),
      read("b", 0, "2026-11-06T08:13:18.067Z", "2026-11-06T08:13:18.341Z", "degraded", "reset"),
      read("b", 1, "2026-11-06T08:13:22.553Z", "2026-11-06T08:13:22.793Z", "healthy", "observed"),
    ];
    const baseline = Object.fromEntries(["a", "b"].map((machine) => [machine, { snapshot: { telemetry: { statements: { status: "observed", statementsStatsReset: epoch } } } }]));
    const identify = (probes: unknown[]) => evaluatePhaseProbeEvidence({ phase: "restart-database", probes, fault, baseline });

    it("identifies the smoke-3 restart from the reset read although stats_reset did not advance", () => {
      expect(identify(smoke3)).toMatchObject({
        alert: true, detectionSeconds: (Date.parse("2026-11-06T08:13:18.420Z") - appliedAtMs) / 1000,
        detectionFormula: expect.stringContaining("no outage observed: a, b"),
      });
    });

    it("measures detection to an in-window failure when a probe observed the outage", () => {
      const outage = [read("a", 0, "2026-11-06T08:13:17.600Z", "2026-11-06T08:13:17.700Z", "unavailable"), ...smoke3.map((probe) => probe.machine === "a"
        ? { ...probe, sequence: probe.sequence + 1, id: `restart-database-a-probe-${probe.sequence + 1}` } : probe)];
      expect(identify(outage)).toMatchObject({
        alert: true, detectionSeconds: (Date.parse("2026-11-06T08:13:18.341Z") - appliedAtMs) / 1000,
        detectionFormula: expect.stringContaining("no outage observed: b"),
      });
    });

    it.each([
      ["has no reset read", smoke3.map((probe) => probe.sequence === 0 && probe.machine === "a" ? read("a", 0, "2026-11-06T08:13:18.165Z", "2026-11-06T08:13:18.420Z", "healthy", "observed") : probe)],
      ["has a probe that straddles appliedAt", [read("a", 9, "2026-11-06T08:13:17.400Z", "2026-11-06T08:13:17.700Z", "healthy", "observed"), ...smoke3]],
      ["reads observed inside the window before the reset", [read("a", 0, "2026-11-06T08:13:17.700Z", "2026-11-06T08:13:17.900Z", "healthy", "observed"), ...smoke3.map((probe) => probe.machine === "a"
        ? { ...probe, sequence: probe.sequence + 1, id: `restart-database-a-probe-${probe.sequence + 1}` } : probe)]],
      ["lacks the observed read after the reset", smoke3.filter((probe) => !(probe.machine === "b" && probe.sequence === 1))],
    ])("fails when a machine %s", (_label, probes) => {
      expect(identify(probes)).toMatchObject({ alert: false, detectionSeconds: undefined });
    });
  });

  it("builds bounded single-flight schedules with a qualifying post-acknowledgment start", () => {
    expect(createProbeSchedule({ phase: "timeout", machine: "a", appliedAtMs: 1_000, holdMaximumMs: 30_000, cadenceMs: 5_000 }))
      .toEqual([
        { id: "timeout-a-probe-0", phase: "timeout", machine: "a", sequence: 0, startAtMs: 1_000, timeoutMs: 5_000 },
        { id: "timeout-a-probe-1", phase: "timeout", machine: "a", sequence: 1, startAtMs: 6_000, timeoutMs: 5_000 },
        { id: "timeout-a-probe-2", phase: "timeout", machine: "a", sequence: 2, startAtMs: 11_000, timeoutMs: 5_000 },
        { id: "timeout-a-probe-3", phase: "timeout", machine: "a", sequence: 3, startAtMs: 16_000, timeoutMs: 5_000 },
        { id: "timeout-a-probe-4", phase: "timeout", machine: "a", sequence: 4, startAtMs: 21_000, timeoutMs: 5_000 },
        { id: "timeout-a-probe-5", phase: "timeout", machine: "a", sequence: 5, startAtMs: 26_000, timeoutMs: 5_000 },
      ]);
  });

  it("uses the qualifying saturation body as witness and classifies missing induction", () => {
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", status: "ready", waiting: 1, failed: false }, telemetry: { pool: { status: "observed", health: "degraded", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.poolSaturated } } }]).verdict).toBe("pass");
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", status: "ready", waiting: 0, failed: false }, telemetry: { pool: { status: "observed", health: "healthy", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.healthy } } }]).verdict).toBe("incomplete");
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", status: "ready", waiting: 1, failed: false }, telemetry: { pool: { status: "observed", health: "healthy", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.healthy } } }]).verdict).toBe("fail");
    expect(evaluateSaturationWitness([
      { pool: { origin: "daemon", status: "ready", waiting: 1, failed: false }, telemetry: { pool: { status: "observed", health: "healthy", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.healthy } } },
      { pool: { origin: "daemon", status: "ready", waiting: 1, failed: false }, telemetry: { pool: { status: "observed", health: "degraded", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.poolSaturated } } },
    ]).verdict).toBe("fail");
  });

  it("brackets backlog age using request and response times", () => {
    expect(backlogAgeBracket({ createdAtMs: 0, requestStartMs: 900_999, responseEndMs: 902_001 })).toEqual({ minimum: 900, maximum: 902 });
  });

  it("separates backlog outage detection from the first post-clear aged-row alert", () => {
    const created = "2026-11-05 00:00:00";
    const appliedAt = Date.parse("2026-11-05T00:00:00Z");
    const clearedAt = appliedAt + 960_000;
    const probes = [
      { id: "queue-backlog-b-probe-0", machine: "b", sequence: 0, startedAtMs: appliedAt, completedAtMs: appliedAt + 5_000, transportFailure: true },
      { id: "queue-backlog-a-probe-0", machine: "a", sequence: 0, startedAtMs: clearedAt, completedAtMs: clearedAt + 1_000, snapshot: { ...healthySnapshotFixture(), telemetry: validTelemetry() } },
      { id: "queue-backlog-b-probe-1", machine: "b", sequence: 1, startedAtMs: clearedAt, completedAtMs: clearedAt + 5_000, snapshot: {
        ...healthySnapshotFixture(), classification: "degraded", telemetry: {
          ...validTelemetry(), queue: { ...healthyFamily({ health: "degraded", remediation: RUNTIME_HEALTH_ACTIONS.backlog, outboxOldestPendingAgeSeconds: 965, inboxQuarantined: 0 }) },
        },
      } },
      { id: "queue-backlog-b-probe-2", machine: "b", sequence: 2, startedAtMs: clearedAt + 6_000, completedAtMs: clearedAt + 7_000, snapshot: { ...healthySnapshotFixture(), telemetry: validTelemetry() } },
    ];
    const result = evaluatePhaseProbeEvidence({
      phase: "queue-backlog", probes,
      fault: { appliedAt: new Date(appliedAt).toISOString(), clearedAt: new Date(clearedAt).toISOString() },
      backlogWitness: { before: { event_uuid: "row", created_at: created } },
      backlogDetection: { id: "queue-backlog-b-probe-1", event_uuid: "row", delivery_state: "pending" },
    });
    expect(result).toMatchObject({ alert: true, detectionSeconds: 5, firstSuccessSeconds: 5, healthyClearanceSeconds: 7, recovery: true });
    const wrongFirst = structuredClone(probes);
    wrongFirst.splice(2, 0, { id: "queue-backlog-b-probe-first", machine: "b", sequence: 1, startedAtMs: clearedAt, completedAtMs: clearedAt + 2_000, snapshot: { ...healthySnapshotFixture(), telemetry: validTelemetry() } });
    expect(evaluatePhaseProbeEvidence({
      phase: "queue-backlog", probes: wrongFirst,
      fault: { appliedAt: new Date(appliedAt).toISOString(), clearedAt: new Date(clearedAt).toISOString() },
      backlogWitness: { before: { event_uuid: "row", created_at: created } },
      backlogDetection: { id: "queue-backlog-b-probe-1", event_uuid: "row", delivery_state: "pending" },
    }).alert).toBe(false);
  });

  it("fails exact phase predicates for wrong actions and non-advanced reset epochs", () => {
    const appliedAt = Date.parse("2026-11-05T00:00:00Z");
    const wrongSaturation = evaluatePhaseProbeEvidence({
      phase: "saturation",
      fault: { appliedAt: new Date(appliedAt).toISOString(), clearedAt: new Date(appliedAt + 5_000).toISOString() },
      probes: [{ machine: "b", startedAtMs: appliedAt, completedAtMs: appliedAt + 1_000, snapshot: {
        pool: { status: "ready", origin: "daemon", waiting: 1, failed: false },
        telemetry: { pool: { status: "observed", health: "degraded", saturationRatio: 1, remediation: RUNTIME_HEALTH_ACTIONS.healthy } },
      } }],
    });
    expect(wrongSaturation.alert).toBe(false);
    const oldEpoch = "2026-11-05T00:00:00.000Z";
    const reset = evaluatePhaseProbeEvidence({
      phase: "stats-reset",
      baseline: {
        a: { snapshot: { telemetry: { statements: { statementsStatsReset: oldEpoch } } } },
        b: { snapshot: { telemetry: { statements: { statementsStatsReset: oldEpoch } } } },
      },
      fault: { appliedAt: new Date(appliedAt).toISOString(), clearedAt: new Date(appliedAt + 5_000).toISOString() },
      probes: [
        { machine: "a", startedAtMs: appliedAt, completedAtMs: appliedAt + 1, snapshot: { telemetry: { statements: { status: "reset", statementsStatsReset: oldEpoch } } } },
        { machine: "a", startedAtMs: appliedAt + 2, completedAtMs: appliedAt + 3, snapshot: { telemetry: { statements: { status: "observed", statementsStatsReset: oldEpoch } } } },
        { machine: "b", startedAtMs: appliedAt, completedAtMs: appliedAt + 1, snapshot: { telemetry: { statements: { status: "reset", statementsStatsReset: oldEpoch } } } },
        { machine: "b", startedAtMs: appliedAt + 2, completedAtMs: appliedAt + 3, snapshot: { telemetry: { statements: { status: "observed", statementsStatsReset: oldEpoch } } } },
      ],
    });
    expect(reset.alert).toBe(false);
  });

  it("evaluates signed calibration deltas, negative deltas and rejected windows", () => {
    const pairs = [
      { baselineDelta: 100, baselineElapsedMs: 180_000, probeDelta: 130, probeElapsedMs: 180_000, probeCount: 24 },
      { baselineDelta: 120, baselineElapsedMs: 180_000, probeDelta: 100, probeElapsedMs: 180_000, probeCount: 24 },
      { baselineDelta: 90, baselineElapsedMs: 180_000, probeDelta: 138, probeElapsedMs: 180_000, probeCount: 24 },
      { baselineDelta: 110, baselineElapsedMs: 180_000, probeDelta: 146, probeElapsedMs: 180_000, probeCount: 24 },
    ];
    expect(evaluateCalibrationPairs(pairs, { approvedCeiling: 3, approvedNoiseCeiling: 2 }).verdict).toBe("pass");
    expect(evaluateCalibrationPairs(pairs.map((pair, index) => index < 2 ? { ...pair, rejected: "counter-decrease" } : pair), { approvedCeiling: 3, approvedNoiseCeiling: 2 }).verdict).toBe("incomplete");
    expect(evaluateCalibrationPairs(pairs, { approvedCeiling: 1, approvedNoiseCeiling: 0.5 }).verdict).toBe("fail");
  });

  it("combines sampled connection coverage with the structural single-flight bound", () => {
    expect(evaluateConnectionEvidence({ baseline: 2, probeSamples: [2, 3, 2], tailSamples: [3, 2], sampledIncrementCeiling: 1, structuralMaximum: 3, activeIntervals: 2, sampledActiveIntervals: 2 })).toMatchObject({ verdict: "pass", sampledIncrement: 1, residual: 0 });
    expect(evaluateConnectionEvidence({ baseline: 2, probeSamples: [2], tailSamples: [2], sampledIncrementCeiling: 1, structuralMaximum: 3, activeIntervals: 1, sampledActiveIntervals: 1 })).toMatchObject({ verdict: "pass", zeroIncrementNotZeroCost: true });
    expect(evaluateConnectionEvidence({ baseline: 2, probeSamples: [4], tailSamples: [3], sampledIncrementCeiling: 1, structuralMaximum: 4, activeIntervals: 1, sampledActiveIntervals: 1 }).verdict).toBe("fail");
    expect(evaluateConnectionEvidence({ baseline: 2, probeSamples: [], tailSamples: [], sampledIncrementCeiling: 1, structuralMaximum: 3, activeIntervals: 1, sampledActiveIntervals: 0 }).verdict).toBe("incomplete");
    // Coverage is recorded, not required: two sampled intervals out of 48 still measure.
    expect(evaluateConnectionEvidence({ baseline: 1, probeSamples: [2, 2], tailSamples: [1], sampledIncrementCeiling: 2, structuralMaximum: 3, activeIntervals: 48, sampledActiveIntervals: 2 }))
      .toMatchObject({ verdict: "pass", sampledIncrement: 1, activeIntervals: 48, sampledActiveIntervals: 2 });
  });

  it("fails extra, dropped and zero-attempt workload identities without vacuous success", () => {
    const expected = ["a-search-0", "a-search-1", "a-store-0"];
    const successful = expected.map((id) => ({
      id, outcome: "success", op: id.includes("store") ? "store" : "search", overlapped: true,
    }));
    expect(evaluateWorkloadCompleteness(expected, successful)).toMatchObject({ verdict: "pass" });
    expect(evaluateWorkloadCompleteness(expected, [])).toMatchObject({ verdict: "incomplete", missing: expected });
    expect(evaluateWorkloadCompleteness(expected, [
      ...successful, { id: "extra", outcome: "success", op: "search", overlapped: true },
    ])).toMatchObject({ verdict: "fail", extra: ["extra"] });
  });

  it("reconciles mixed-phase probe multiplicities and start gaps", () => {
    const records = [
      { id: "steady-a-probe-0", phase: "steady", machine: "a", sequence: 0, startedAtMs: 0 },
      { id: "steady-a-probe-1", phase: "steady", machine: "a", sequence: 1, startedAtMs: 5_000 },
      { id: "calibration-1-a-probe-0", phase: "calibration-1", machine: "a", sequence: 0, startedAtMs: 10_000 },
      { id: "timeout-a-probe-0", phase: "timeout", machine: "a", sequence: 0, startedAtMs: 15_000 },
      { id: "timeout-a-probe-1", phase: "timeout", machine: "a", sequence: 1, startedAtMs: 20_000 },
    ];
    const expected = records.map((record) => record.id);
    expect(evaluateProbePopulation({ expectedIds: expected, records, maximumStartGapMs: 7_500 }).verdict).toBe("pass");
    expect(evaluateProbePopulation({ expectedIds: expected, records: [...records, records[0]], maximumStartGapMs: 7_500 })).toMatchObject({ verdict: "fail", duplicate: ["steady-a-probe-0"] });
    expect(evaluateProbePopulation({ expectedIds: expected, records: records.slice(1), maximumStartGapMs: 7_500 }).verdict).toBe("incomplete");
    expect(evaluateProbePopulation({ expectedIds: expected, records: records.map((record) => ({ ...record, startedAtMs: record.phase === "timeout" ? record.sequence * 8_000 : record.startedAtMs })), maximumStartGapMs: 7_500 }).verdict).toBe("fail");
    expect(evaluateProbePopulation({
      expectedIds: ["timeout-a-probe-0"],
      records: [{ id: "timeout-a-probe-0", phase: "timeout", machine: "a", sequence: 0, startedAtMs: 8_000 }],
      maximumStartGapMs: 7_500,
      phaseWindows: { "timeout:a": { startMs: 0, endMs: 8_000 } },
    }).verdict).toBe("fail");
    expect(evaluateProbePopulation({
      expectedIds: ["timeout-a-probe-0"],
      records: [{ id: "timeout-a-probe-0", phase: "timeout", machine: "a", sequence: 0, startedAtMs: 0 }],
      maximumStartGapMs: 7_500,
      phaseWindows: { "timeout:a": { startMs: 0, endMs: 5_000 } },
    }).verdict).toBe("incomplete");
  });

  it("requires exact per-machine workload identities and applied-window overlap", () => {
    const expected = ["a-search-0", "a-search-1", "a-store-0"];
    const attempts = [
      { id: expected[0], machine: "a", op: "search", outcome: "success", processStartWallMs: 110, processExitWallMs: 120 },
      { id: expected[1], machine: "a", op: "search", outcome: "success", processStartWallMs: 120, processExitWallMs: 130 },
      { id: expected[2], machine: "a", op: "store", outcome: "success", processStartWallMs: 130, processExitWallMs: 140 },
    ];
    expect(evaluatePhaseWorkload({ expectedIds: expected, attempts, machine: "a", appliedAtMs: 100, clearedAtMs: 150 }).verdict).toBe("pass");
    expect(evaluatePhaseWorkload({ expectedIds: expected, attempts, machine: "b", appliedAtMs: 100, clearedAtMs: 150 }).verdict).toBe("incomplete");
    expect(evaluatePhaseWorkload({ expectedIds: expected, attempts: attempts.map((attempt) => ({ ...attempt, processStartWallMs: 160, processExitWallMs: 170 })), machine: "a", appliedAtMs: 100, clearedAtMs: 150 }).verdict).toBe("fail");
  });

  it("preserves known failures across barriers and marks only later steps incomplete", () => {
    expect(evaluateBarrierSequence([
      { step: "timeout", verdict: "fail" },
      { step: "stats-reset", verdict: "barrier-timeout" },
      { step: "permission-loss", verdict: "pass" },
    ])).toEqual([
      { step: "timeout", verdict: "fail" },
      { step: "stats-reset", verdict: "incomplete" },
      { step: "permission-loss", verdict: "incomplete" },
    ]);
  });

  it("marks local v4 observability applicable and managed v4 residual", () => {
    expect(observabilityApplicability({ version: 3, lane: "local" })).toEqual({ applicable: false, reason: "contract-v3" });
    expect(observabilityApplicability({ version: 4, lane: "local" })).toEqual({ applicable: true, reason: null });
    expect(observabilityApplicability({ version: 4, lane: "managed" })).toMatchObject({ applicable: false, reason: "managed-residual" });
  });

  it("pins remediation strings to the product constants", () => {
    expect(OBSERVABILITY_ACTIONS).toEqual(RUNTIME_HEALTH_ACTIONS);
  });

  it("pins contract v4 operation identities to the packaged product catalog", () => {
    const contract = JSON.parse(readFileSync(new URL("./contract-v4.json", import.meta.url), "utf8"));
    expect(contract.observability.cardinality.operationIds).toEqual(QUERY_OPERATION_IDS);
  });

  it("validates the counts-only observability summary schema", () => {
    const schema = JSON.parse(readFileSync(new URL("./observability-evidence-schema.json", import.meta.url), "utf8"));
    const summary = {
      schemaVersion: 1,
      contract: { version: 4, sha256: "a".repeat(64) },
      run: { sha256: "b".repeat(64) },
      applicability: { applicable: true, reason: null },
      items: [{ id: "privacy.canary-leaks", formula: "hit count", threshold: 0, observed: 0, verdict: "pass" }],
      privateArtifacts: {
        rawProbeBodies: 1, probeRecords: 1, canarySurfaces: 7, secretCategories: 14,
        allowedSurfaceHits: { "logs/events.log": { "project-path": 4, "home-path": 2 } }, retentionDays: 90, directoryMode: "0700", fileMode: "0600",
      },
    };
    expect(validateEvidence(schema, summary)).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("incident-message-content-canary");
  });

  it("builds all gate rows without turning missing evidence into a pass", () => {
    const summary = buildObservabilitySummary({ contractSha256: "a".repeat(64) });
    expect(summary.items.length).toBeGreaterThan(50);
    expect(summary.items.every((item) => item.verdict !== "pass")).toBe(true);
    expect(summary.privateArtifacts).toMatchObject({ retentionDays: 90, directoryMode: "0700", fileMode: "0600" });
  });

  it("fails freshness for missing, mistyped, or out-of-window family observations", () => {
    const probe = (telemetry: any) => ({
      id: "steady-a-probe-0", machine: "a", phase: "steady", sequence: 0,
      startedAtMs: 90, completedAtMs: 110, durationMs: 20,
      snapshot: { classification: "healthy", telemetry }, cardinality: { verdict: "pass" },
    });
    const expected = { id: "steady-a-probe-0", expected: true };
    const pass = buildObservabilitySummary({ contractSha256: "a".repeat(64), probes: [expected, probe(validTelemetry())] });
    expect(pass.items.find((item) => item.id === "telemetry.freshness")?.verdict).toBe("pass");
    for (const observedAt of [undefined, "100", 120]) {
      const telemetry = validTelemetry() as any;
      telemetry.queue.observedAt = observedAt;
      const summary = buildObservabilitySummary({ contractSha256: "a".repeat(64), probes: [expected, probe(telemetry)] });
      expect(summary.items.find((item) => item.id === "telemetry.freshness")?.verdict).toBe("fail");
    }
  });

  it("fails healthy-phase transport and reads evaluator bounds from the selected contract", () => {
    const contract = JSON.parse(readFileSync(new URL("./contract-v4.json", import.meta.url), "utf8"));
    contract.observability.probe.detectionMaxSeconds = 7;
    contract.observability.clearanceSeconds.timeout = 6;
    contract.observability.probe.steadyMaximumMs = 15;
    const summary = buildObservabilitySummary({
      contractSha256: "a".repeat(64), runId: "run", contract,
      probes: [{ id: "steady-a-probe-0", machine: "a", phase: "steady", sequence: 0,
        startedAtMs: 0, completedAtMs: 5, durationMs: 5, transportFailure: true }],
      probeCompleteness: { verdict: "pass", expected: 1, actual: 1 },
      phaseResults: { timeout: { alert: true, detectionSeconds: 8, clearanceSeconds: 7 } },
    });
    expect(summary.items.find((item) => item.id === "telemetry.steady-healthy")?.verdict).toBe("fail");
    expect(summary.items.find((item) => item.id === "telemetry.freshness")?.verdict).toBe("fail");
    expect(summary.items.find((item) => item.id === "detection.timeout")).toMatchObject({ threshold: 7, verdict: "fail" });
    expect(summary.items.find((item) => item.id === "clearance.timeout")).toMatchObject({ threshold: 6, verdict: "fail" });
    expect(summary.items.find((item) => item.id === "steady-probe-latency.max")?.threshold).toBe(15);
  });

  it("keeps a known secret leak failed even when inventory coverage is incomplete", () => {
    const summary = buildObservabilitySummary({
      contractSha256: "a".repeat(64),
      privacy: { secretHits: 1, inventoryComplete: false, canaryHits: 0 },
    });
    expect(summary.items.find((item) => item.id === "privacy.secret-leaks")?.verdict).toBe("fail");
  });
});
