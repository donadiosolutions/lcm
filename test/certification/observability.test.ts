import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateEvidence } from "../postgresql/cutover-rehearsal/check-evidence.js";
import { RUNTIME_HEALTH_ACTIONS } from "../../src/storage/runtime-health.js";
import { CANARY_CLI_SURFACES, createCanaryWorkload } from "./canary-corpus.mjs";
import {
  CANARY_CORPUS,
  OBSERVABILITY_ACTIONS,
  backlogAgeBracket,
  buildSecretInventory,
  buildObservabilitySummary,
  createProbeSchedule,
  encodedScanForms,
  evaluateBarrierSequence,
  evaluateCalibrationPairs,
  evaluateFencedReset,
  evaluateConnectionEvidence,
  evaluateSaturationWitness,
  evaluateTimeoutShape,
  evaluateWorkloadCompleteness,
  observabilityApplicability,
  scanSurface,
  validateTelemetryCardinality,
} from "./observability.mjs";

const healthyFamily = (extra: Record<string, unknown> = {}) => ({
  status: "observed", health: "healthy", observedAt: "2026-11-05T00:00:00.000Z",
  remediation: "No action required.", ...extra,
});

function validTelemetry() {
  return {
    statements: {
      status: "observed", scope: "aggregate", observedAt: "2026-11-05T00:00:00.000Z",
      statementsStatsReset: "2026-11-04T00:00:00.000Z", statementsDeallocTotal: 0,
      blockSize: 8192, operations: [{ operation: "conversations.getMessages", calls: 2 }],
    },
    pool: healthyFamily({ origin: "daemon", saturationRatio: 0.5, failed: false, waiting: 0 }),
    migration: healthyFamily({ historyStatus: "current", expectedCount: 9, appliedCount: 9 }),
    extensions: healthyFamily({ entries: [
      { name: "pg_stat_statements", status: "current" },
      { name: "pg_trgm", status: "current" },
      { name: "pgcrypto", status: "current" },
      { name: "unaccent", status: "current" },
    ] }),
    queue: healthyFamily({ inboxClaimed: 0, inboxQuarantined: 0, replayLagSeconds: 0, outboxOldestPendingAgeSeconds: 0 }),
  };
}

describe("observability certification helpers", () => {
  it("keeps the canary corpus byte-for-byte equal to the incident fixture", () => {
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
    expect(() => buildSecretInventory({ runtimeUrl: "" } as any)).toThrow("runtime-url");
  });

  it("rejects cardinality extra operations, fields, duplicate operations and oversized arrays", () => {
    expect(validateTelemetryCardinality(validTelemetry(), { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("pass");
    const extraOperation = validTelemetry();
    extraOperation.statements.operations.push({ operation: "extra", calls: 1 });
    expect(validateTelemetryCardinality(extraOperation, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons).toContain("statements.operations[1].operation is not cataloged");
    const extraField = validTelemetry() as any;
    extraField.pool.secret = "no";
    expect(validateTelemetryCardinality(extraField, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).reasons).toContain("pool has unknown key secret");
    const duplicate = validTelemetry();
    duplicate.statements.operations.push({ operation: "conversations.getMessages", calls: 1 });
    expect(validateTelemetryCardinality(duplicate, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).duplicateKeys).toBe(1);
    const oversized = validTelemetry();
    oversized.statements.operations = Array.from({ length: 65 }, () => ({ operation: "conversations.getMessages", calls: 1 }));
    expect(validateTelemetryCardinality(oversized, { operationIds: ["conversations.getMessages"], maximumOperations: 64 }).verdict).toBe("fail");
  });

  it("accepts both legal timeout shapes and rejects a non-timeout classification", () => {
    expect(evaluateTimeoutShape({ classification: "timeout", telemetry: {
      pool: healthyFamily({ origin: "daemon" }), extensions: { status: "timeout" }, migration: { status: "timeout" }, queue: { status: "timeout" }, statements: { status: "timeout" },
    } }).verdict).toBe("pass");
    expect(evaluateTimeoutShape({ classification: "timeout", telemetry: {
      pool: healthyFamily({ origin: "daemon" }), extensions: healthyFamily(), migration: { status: "timeout" }, queue: { status: "unavailable" }, statements: { status: "timeout" },
    } }).verdict).toBe("pass");
    expect(evaluateTimeoutShape({ classification: "healthy", telemetry: validTelemetry() }).verdict).toBe("fail");
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
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", saturationRatio: 1, waiting: 1, failed: false }, action: RUNTIME_HEALTH_ACTIONS.poolSaturated }]).verdict).toBe("pass");
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", saturationRatio: 1, waiting: 0, failed: false }, action: RUNTIME_HEALTH_ACTIONS.healthy }]).verdict).toBe("incomplete");
    expect(evaluateSaturationWitness([{ pool: { origin: "daemon", saturationRatio: 1, waiting: 1, failed: false }, action: RUNTIME_HEALTH_ACTIONS.healthy }]).verdict).toBe("fail");
  });

  it("brackets backlog age using request and response times", () => {
    expect(backlogAgeBracket({ createdAtMs: 0, requestStartMs: 900_999, responseEndMs: 902_001 })).toEqual({ minimum: 900, maximum: 902 });
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

  it("validates the counts-only observability summary schema", () => {
    const schema = JSON.parse(readFileSync(new URL("./observability-evidence-schema.json", import.meta.url), "utf8"));
    const summary = {
      schemaVersion: 1,
      contract: { version: 4, sha256: "a".repeat(64) },
      applicability: { applicable: true, reason: null },
      items: [{ id: "privacy.canary-leaks", formula: "hit count", threshold: 0, observed: 0, verdict: "pass" }],
      privateArtifacts: { rawProbeBodies: 1, probeRecords: 1, canarySurfaces: 7, secretCategories: 14, retentionDays: 90, directoryMode: "0700", fileMode: "0600" },
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
});
