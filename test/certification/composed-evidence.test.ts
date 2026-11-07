import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCalibrationEvidence, finalizeCalibrationEvidence, reconstructObservabilitySummary } from "../../scripts/certification-harness.mjs";
import { normalizeSearchLayers, normalizeSearchLimit } from "../../src/retrieval.js";
import { poolTelemetry } from "../../src/storage/runtime-health.js";
import {
  executeControlledObservabilityPhase,
  executeDeterministicSchedule,
  executeProbeSchedule,
  executeRecoveryProbePhase,
  runRawStatusProbe,
  waitForControl,
} from "./machine-agent.mjs";
import { createProbeSchedule } from "./observability.mjs";
import { createFaultSchedule, createObservabilityWorkloadSchedule } from "./schedule.mjs";

// Composed producer/reconstruction fixtures: the real agent loops and the real raw status
// probe run on a virtual clock against status bodies captured from smoke 3, and the real
// reconstruction evaluates what they wrote.
const contractBytes = readFileSync(new URL("./contract-v4.json", import.meta.url));
const contract = JSON.parse(contractBytes.toString("utf8"));
const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");
const runId = "0123456789abcdef0123456789abcdef";
type StatusName = "healthy" | "unavailable" | "timeout";
const statusBodies = Object.fromEntries((["healthy", "unavailable", "timeout"] as const).map((name) => [
  name, JSON.parse(readFileSync(new URL(`./fixtures/status-${name}.json`, import.meta.url), "utf8")),
])) as Record<StatusName, { backendDiagnostics: Record<string, any> }>;
const LOCKED_POOL = { origin: "daemon", status: "ready", configuredMax: 2, total: 1, idle: 0, waiting: 0, failed: false };
const SATURATED_POOL = { ...LOCKED_POOL, total: 2, waiting: 2 };

// A status body as the daemon would return it at atMs; the pool family is recomputed by the
// product's own poolTelemetry when the counters change.
function statusBytes(name: StatusName, atMs: number, pool?: Record<string, unknown>) {
  const body = structuredClone(statusBodies[name]);
  for (const family of Object.values(body.backendDiagnostics.telemetry) as Array<{ observedAt?: number }>) family.observedAt = atMs;
  if (pool) {
    body.backendDiagnostics.pool = pool;
    body.backendDiagnostics.telemetry.pool = poolTelemetry(pool, atMs);
  }
  return Buffer.from(JSON.stringify(body));
}

// The real raw status probe; the daemon answers after durationMs of virtual time, and the
// coordinator acts on its own timeline (onTick) whatever the agent is doing.
function virtualProbe(
  clock: { now: number },
  respond: (request: { sequence: number }) => { name: StatusName; pool?: Record<string, unknown>; durationMs: number },
  onTick: () => void,
) {
  return (request: { sequence: number }) => runRawStatusProbe({
    ...request,
    now: () => clock.now,
    fetch: async () => {
      const { name, pool, durationMs } = respond(request);
      const bytes = statusBytes(name, clock.now, pool);
      clock.now += durationMs;
      onTick();
      return { status: 200, arrayBuffer: async () => bytes };
    },
  });
}

function composedEvidence(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `lcm-cert-composed-${prefix}-`));
  const evidenceDirectory = join(root, "evidence");
  for (const machine of ["a", "b"]) mkdirSync(join(evidenceDirectory, `machine-${machine}`), { recursive: true });
  const daemonTokenPath = join(root, "daemon.token");
  writeFileSync(daemonTokenPath, "token\n");
  return { root, evidenceDirectory, daemonTokenPath, machineDirectory: (machine: string) => join(evidenceDirectory, `machine-${machine}`) };
}

function writeProbe(evidenceDirectory: string, record: { id: string; machine: string; phase: string; sequence: number; startedAtMs: number }, name: StatusName = "healthy") {
  const directory = join(evidenceDirectory, `machine-${record.machine}`);
  const bytes = statusBytes(name, record.startedAtMs);
  mkdirSync(join(directory, "raw-probes"), { recursive: true });
  writeFileSync(join(directory, "raw-probes", `${record.id}.json`), bytes);
  appendFileSync(join(directory, "probes.ndjson"), `${JSON.stringify({
    ...record, runId, contractSha256, completedAtMs: record.startedAtMs + 200, durationMs: 200, status: 200,
    rawSha256: createHash("sha256").update(bytes).digest("hex"), rawBytes: bytes.length,
    snapshot: JSON.parse(bytes.toString("utf8")).backendDiagnostics,
  })}\n`);
}

// One healthy probe for every identity the reconstruction expects, except the phases a test
// produced with the real agent, plus the run metadata it reads.
function writeExpectedEnvelope(evidenceDirectory: string, steadyStartMs: number, produced: string[]) {
  writeFileSync(join(evidenceDirectory, "run.json"), JSON.stringify({ lane: "local", profile: "smoke", withFaults: true, contractSha256, contractVersion: 4, runId }));
  writeFileSync(join(evidenceDirectory, "phase-control.json"), JSON.stringify({ steadyT0At: new Date(steadyStartMs).toISOString() }));
  for (const machine of ["a", "b"]) {
    for (let pair = 1; pair <= contract.observability.calibration.pairs; pair += 1) {
      for (let sequence = 0; sequence < contract.observability.calibration.probesPerMachinePerWindow; sequence += 1) {
        writeProbe(evidenceDirectory, { id: `calibration-${pair}-${machine}-probe-${sequence}`, machine, phase: `calibration-${pair}`, sequence, startedAtMs: steadyStartMs - 2_000_000 + (pair * 360 + sequence * 15) * 1000 });
      }
    }
    for (const entry of createProbeSchedule({
      phase: "steady", machine, appliedAtMs: steadyStartMs, holdMaximumMs: contract.timeline.smoke.steadySeconds * 1000,
      cadenceMs: contract.observability.probe.steadyCadenceSeconds * 1000,
    })) writeProbe(evidenceDirectory, { id: entry.id, machine, phase: "steady", sequence: entry.sequence, startedAtMs: entry.startAtMs });
    const phases = ["partition-a", "restart-database", "saturation", "timeout", "stats-reset", "permission-loss", "extension-loss", "queue-backlog", "canary"];
    phases.filter((phase) => !produced.includes(phase)).forEach((phase, index) => {
      const startedAtMs = steadyStartMs + 3_600_000 + index * 60_000;
      writeProbe(evidenceDirectory, { id: `${phase}-${machine}-baseline`, machine, phase: `${phase}-baseline`, sequence: -1, startedAtMs });
      writeProbe(evidenceDirectory, { id: `${phase}-${machine}-probe-0`, machine, phase, sequence: 0, startedAtMs: startedAtMs + 5_000 });
    });
  }
}

function writeSamples(directory: string, samples: Array<Record<string, unknown>>) {
  for (const sample of samples) appendFileSync(join(directory, "samples.ndjson"), `${JSON.stringify(sample)}\n`);
}

function verdicts(summary: { items: Array<{ id: string; verdict: string }> }, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, summary.items.find((item) => item.id === id)?.verdict]));
}

describe("composed observability evidence", () => {
  // Smoke 3: machine A was partitioned at 08:07:30.482 and the coordinator recorded its clear
  // at 08:08:31.780, after the 60-second hold, the reconnect and the database check.
  it("records partition clearance after a clear later than applied+60 s, inside the derived probe envelope", async () => {
    const { root, evidenceDirectory, daemonTokenPath, machineDirectory } = composedEvidence("partition");
    const appliedAtMs = Date.parse("2026-11-06T08:07:30.482Z");
    const clearedAtMs = Date.parse("2026-11-06T08:08:31.780Z");
    for (const machine of ["a", "b"] as const) {
      const directory = machineDirectory(machine);
      writeFileSync(join(directory, "partition-a-prepare.json"), JSON.stringify({ preparedAt: new Date(appliedAtMs - 2_000).toISOString() }));
      writeFileSync(join(directory, "partition-a-applied.json"), JSON.stringify({ appliedAt: new Date(appliedAtMs).toISOString() }));
      const clock = { now: appliedAtMs - 1_000 };
      const coordinator = () => {
        const path = join(directory, "partition-a-cleared.json");
        if (clock.now >= clearedAtMs && !existsSync(path)) writeFileSync(path, JSON.stringify({ clearedAt: new Date(clearedAtMs).toISOString() }));
      };
      await executeRecoveryProbePhase({
        phase: "partition-a", machine, runId, contract, contractSha256, cwd: root, evidenceDirectory: directory, daemonTokenPath, inventory: [],
        now: () => clock.now,
        wait: async (milliseconds: number) => { clock.now += milliseconds; coordinator(); },
        // Machine A's daemon reports the database unavailable while partitioned; B stays healthy.
        probe: virtualProbe(clock, (request) => machine === "a" && request.sequence >= 0 && clock.now < clearedAtMs
          ? { name: "unavailable", durationMs: 15 } : { name: "healthy", durationMs: 230 }, coordinator),
      });
      writeSamples(directory, createFaultSchedule({ machine, runId, phase: "partition-recovery", durationSeconds: contract.thresholds.recovery.partition.rtoSeconds })
        .map((entry) => ({ id: entry.id, machine, op: entry.op, phase: entry.phase, outcome: "success" })));
    }
    writeExpectedEnvelope(evidenceDirectory, appliedAtMs - 600_000, ["partition-a"]);
    const summary = reconstructObservabilitySummary({
      evidenceDirectory, contract, contractSha256, runId, persist: false,
      faults: [{ id: "partition-a", kind: "partition-machine", target: "a", requestedAt: new Date(appliedAtMs - 100).toISOString(),
        appliedAt: new Date(appliedAtMs).toISOString(), clearedAt: new Date(clearedAtMs).toISOString(), recoveredAt: new Date(clearedAtMs + 60_000).toISOString() }],
    });
    const clearance = (machine: string) => existsSync(join(machineDirectory(machine), "partition-a-clearance.json"))
      ? JSON.parse(readFileSync(join(machineDirectory(machine), "partition-a-clearance.json"), "utf8")).id : undefined;
    expect({ a: clearance("a"), b: clearance("b"), ...verdicts(summary, ["clearance.partition-a", "correctness.partition-a", "probe-completeness"]) }).toEqual({
      a: "partition-a-a-probe-13", b: "partition-a-b-probe-13",
      "clearance.partition-a": "pass", "correctness.partition-a": "pass", "probe-completeness": "pass",
    });
  });

  it("sends machine B's saturation workload as searches only, with promoted-layer inductions, four at a time", async () => {
    const { root, evidenceDirectory, daemonTokenPath } = composedEvidence("saturation-requests");
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let active = 0;
    let maximum = 0;
    await executeDeterministicSchedule({
      schedule: createObservabilityWorkloadSchedule({ machine: "b", runId, phase: "saturation", durationSeconds: 30 }),
      scheduleStartWallMs: Date.now() - 60_000, operationTimeoutMs: 600_000, deadlineAbortsSchedule: false,
      entrypoint: join(root, "lcm.mjs"), cwd: root, environment: { HOME: root }, evidenceDirectory: join(evidenceDirectory, "machine-b"), daemonTokenPath,
      daemonClient: { post: async (path: string, body: Record<string, unknown>) => {
        requests.push({ path, body });
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {};
      } },
    });
    // Each body passes the /search route's own validators (src/daemon/routes/search.ts:24-41);
    // an induction body selects the promoted layer, which reaches searchPromoted (search.ts:79).
    const layers = requests.map(({ body }) => normalizeSearchLayers(body.layers));
    expect({
      paths: [...new Set(requests.map(({ path }) => path))],
      valid: requests.every(({ body }) => Boolean(body.query) && normalizeSearchLimit(body.limit) === 5 && layers.every(Boolean)),
      promoted: layers.filter((value) => JSON.stringify(value) === JSON.stringify(["promoted"])).length,
      plain: layers.filter((value) => value?.length === 0).length,
      maximum,
    }).toEqual({ paths: ["/search"], valid: true, promoted: 10, plain: 8, maximum: 4 });
  });

  // The redesigned saturation step: promoted-layer searches on B hold both pool connections
  // and keep others waiting while the relation is locked, so the first B body that shows
  // waiting is the witness. The body is smoke 3's timeout body with the saturated counters.
  async function runSaturationStep(prefix: string) {
    const { root, evidenceDirectory, daemonTokenPath, machineDirectory } = composedEvidence(prefix);
    const appliedAtMs = Date.now() - 3_000_000;
    let clearedAtMs: number | undefined;
    for (const machine of ["b", "a"] as const) {
      const directory = machineDirectory(machine);
      writeFileSync(join(directory, "saturation-prepare.json"), JSON.stringify({ preparedAt: new Date(appliedAtMs - 3_000).toISOString() }));
      writeFileSync(join(directory, "saturation-control.json"), JSON.stringify({ appliedAt: new Date(appliedAtMs).toISOString(), expectDetection: machine === "b" }));
      const clock = { now: appliedAtMs - 2_000 };
      // The coordinator clears once B's terminal outcome exists; A sees the same clear.
      const coordinator = () => {
        if (clearedAtMs === undefined && existsSync(join(machineDirectory("b"), "saturation-outcome.json"))) clearedAtMs = clock.now;
        const path = join(directory, "saturation-cleared.json");
        if (clearedAtMs !== undefined && clock.now >= clearedAtMs && !existsSync(path)) writeFileSync(path, JSON.stringify({ clearedAt: new Date(clearedAtMs).toISOString() }));
      };
      await executeControlledObservabilityPhase({
        phase: "saturation", machine, runId, contract, contractSha256, entrypoint: join(root, "lcm.mjs"), cwd: root,
        environment: { HOME: root }, daemonClient: { post: async () => ({}) }, evidenceDirectory: directory, daemonTokenPath, inventory: [],
        now: () => clock.now,
        wait: async (milliseconds: number) => { clock.now += milliseconds; coordinator(); },
        probe: virtualProbe(clock, (request) => {
          if (request.sequence < 0 || (clearedAtMs !== undefined && clock.now >= clearedAtMs)) return { name: "healthy", durationMs: 250 };
          // Under the lock each status read waits out its 2-second diagnostic deadline.
          return { name: "timeout", pool: machine === "b" && request.sequence >= 1 ? SATURATED_POOL : LOCKED_POOL, durationMs: 2_000 };
        }, coordinator),
      });
      // The fast-failing real-time workload is replaced with deterministic attempts below.
      rmSync(join(directory, "samples.ndjson"));
    }
    return { evidenceDirectory, machineDirectory, appliedAtMs, clearedAtMs: clearedAtMs as number };
  }

  function saturationSamples(machine: string, appliedAtMs: number, clearedAtMs: number) {
    // Searches in flight at the clear complete just after it; later ones run unlocked.
    return createObservabilityWorkloadSchedule({ machine, runId, phase: "saturation", durationSeconds: 30 }).map((entry) => {
      const startedAtMs = Math.max(appliedAtMs + entry.offsetSeconds * 1000 + 50, entry.offsetSeconds === 0 ? 0 : clearedAtMs + 100);
      const endedAtMs = startedAtMs < clearedAtMs ? clearedAtMs + 50 : startedAtMs + 40;
      return { id: entry.id, machine, op: entry.op, phase: "saturation", outcome: "success",
        wallStartedAt: new Date(startedAtMs).toISOString(), wallEndedAt: new Date(endedAtMs).toISOString(),
        processStartWallMs: startedAtMs, processExitWallMs: endedAtMs };
    });
  }

  function reconstructSaturation(step: Awaited<ReturnType<typeof runSaturationStep>>, samples: Record<string, Array<Record<string, unknown>>>) {
    for (const machine of ["a", "b"]) writeSamples(step.machineDirectory(machine), samples[machine]);
    writeExpectedEnvelope(step.evidenceDirectory, step.appliedAtMs - 600_000, ["saturation"]);
    return reconstructObservabilitySummary({
      evidenceDirectory: step.evidenceDirectory, contract, contractSha256, runId, persist: false,
      faults: [{ id: "saturation", kind: "saturation", target: "b", requestedAt: new Date(step.appliedAtMs - 10).toISOString(),
        appliedAt: new Date(step.appliedAtMs).toISOString(), clearedAt: new Date(step.clearedAtMs).toISOString(), recoveredAt: new Date(step.clearedAtMs + 30_000).toISOString() }],
    });
  }

  const SATURATION_ITEMS = ["alert.saturation", "detection.saturation", "clearance.saturation", "correctness.saturation", "recovery.saturation", "probe-completeness"];

  it("certifies a promoted-search saturation witness from real-shaped bodies and its bounded recovery", async () => {
    const step = await runSaturationStep("saturation-witness");
    const read = (machine: string, name: string) => JSON.parse(readFileSync(join(step.machineDirectory(machine), name), "utf8"));
    const summary = reconstructSaturation(step, {
      a: saturationSamples("a", step.appliedAtMs, step.clearedAtMs), b: saturationSamples("b", step.appliedAtMs, step.clearedAtMs),
    });
    expect({
      outcome: read("b", "saturation-outcome.json"), witness: read("b", "saturation-detected.json").id,
      clearance: { a: read("a", "saturation-clearance.json").id, b: read("b", "saturation-clearance.json").id },
      ...verdicts(summary, SATURATION_ITEMS),
    }).toEqual({
      outcome: { machine: "b", outcome: "witness", id: "saturation-b-probe-1" }, witness: "saturation-b-probe-1",
      clearance: { a: "saturation-a-probe-3", b: "saturation-b-probe-2" },
      ...Object.fromEntries(SATURATION_ITEMS.map((id) => [id, "pass"])),
    });
  });

  it("accepts saturation searches that fail within the bound and rejects a later failure", async () => {
    const step = await runSaturationStep("saturation-failures");
    const failed = (samples: Array<Record<string, unknown>>, id: string, endedAtMs: number) => samples.map((sample) => sample.id === id
      ? { ...sample, outcome: "failed", errorClass: "Error", wallEndedAt: new Date(endedAtMs).toISOString(), processExitWallMs: endedAtMs } : sample);
    const bounded = failed(saturationSamples("b", step.appliedAtMs, step.clearedAtMs), `${runId}-saturation-b-induction-search-0`, step.clearedAtMs - 200);
    const accepted = reconstructSaturation(step, { a: saturationSamples("a", step.appliedAtMs, step.clearedAtMs), b: bounded });
    expect(verdicts(accepted, ["correctness.saturation", "recovery.saturation"])).toEqual({ "correctness.saturation": "pass", "recovery.saturation": "pass" });
    const late = await runSaturationStep("saturation-late-failure");
    const unbounded = failed(saturationSamples("b", late.appliedAtMs, late.clearedAtMs), `${runId}-saturation-b-induction-search-0`,
      late.clearedAtMs + contract.observability.clearanceSeconds.saturation * 1000 + 1_000);
    const rejected = reconstructSaturation(late, { a: saturationSamples("a", late.appliedAtMs, late.clearedAtMs), b: unbounded });
    expect(verdicts(rejected, ["correctness.saturation", "recovery.saturation"])).toEqual({ "correctness.saturation": "fail", "recovery.saturation": "fail" });
  });
});

// A discrete-event clock for code that takes injected now and delay functions: each pending delay
// is a timer, and the driver lets all runnable work settle before it advances to the earliest one.
function eventClock(startMs: number) {
  let current = startMs;
  let order = 0;
  const timers: Array<{ atMs: number; order: number; resolve: () => void }> = [];
  const settle = async (turns = 3) => {
    for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => current,
    delay: (milliseconds: number) => new Promise<void>((resolve) => {
      order += 1;
      timers.push({ atMs: current + Math.max(0, milliseconds), order, resolve });
    }),
    pending: () => timers.length,
    settle,
    async run<T>(work: Promise<T>, limitMs: number): Promise<T> {
      let finished = false;
      void work.then(() => { finished = true; }, () => { finished = true; });
      for (;;) {
        await settle();
        if (finished) return work;
        if (timers.length === 0) throw new Error("event clock has no pending timer");
        timers.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
        const next = timers.shift()!;
        if (next.atMs > startMs + limitMs) throw new Error("event clock limit exceeded");
        current = Math.max(current, next.atMs);
        next.resolve();
      }
    },
  };
}

describe("calibration connection sampling", () => {
  // Option (A) end to end: the real coordinator sampler and the real raw status probe exchange
  // per-probe sample requests and answers through the machine evidence directories. The probes
  // start 300 ms after a whole-second sample, as on the certifying testbox, whose one-second
  // sampler caught 0 of 48 intervals per machine. A's probes take 120 ms and hold their diagnostic
  // connection from 10 to 110 ms; B's take 40 ms and close it by 30 ms.
  it("samples every short calibration probe inside its interval through the per-probe handshake", async () => {
    const definition = {
      ...contract.observability.calibration,
      pairs: 4, baselineWindowSeconds: 3, probeWindowSeconds: 3, probeCadenceSeconds: 1, probesPerMachinePerWindow: 3,
    };
    const calibrationContract = { ...contract, observability: { ...contract.observability, calibration: definition } };
    const { machineDirectory } = composedEvidence("calibration-sampling");
    const clock = eventClock(Date.parse("2026-11-06T14:43:00.000Z"));
    const durations: Record<string, number> = { a: 120, b: 40 };
    const held: Record<string, Array<[number, number]>> = { a: [], b: [] };
    const connections = (machine: string) => 1 + held[machine].filter(([from, until]) => clock.now() >= from && clock.now() <= until).length;
    let cpu = 0;
    let calls = 0;
    const coordinator = collectCalibrationEvidence({
      contract: calibrationContract,
      startAt: new Date(clock.now() + 1_000).toISOString(),
      machineNames: { a: "machine-a", b: "machine-b" },
      databaseContainer: "database",
      run: async (args: string[]) => {
        if (args[1] === "inspect") {
          return { stdout: JSON.stringify([{ NetworkSettings: { Networks: { test: { IPAddress: args[2] === "machine-a" ? "10.0.0.2" : "10.0.0.3" } } } }]) };
        }
        if (args.at(-1) === "/sys/fs/cgroup/cpu.max") return { stdout: "100000 100000\n" };
        // A boundary CPU read takes 100 ms, as a container exec does, so the three reads put each
        // probe window's start 300 ms after its boundary second.
        await clock.delay(100);
        cpu += 1_000;
        return { stdout: `usage_usec ${cpu}\n` };
      },
      adminUrl: "postgresql://admin@db/lcm",
      caFile: "/unused",
      runtimeRole: "runtime",
      clientFactory: () => ({
        connect: async () => undefined,
        end: async () => undefined,
        query: async (sql: string) => {
          if (sql.includes("pg_stat_activity")) {
            return { rows: [{ client_address: "10.0.0.2", connections: connections("a") }, { client_address: "10.0.0.3", connections: connections("b") }] };
          }
          calls += 10;
          return { rows: [{ calls, total_exec_time: 0, total_plan_time: 0, stats_reset: 1, dealloc: 0, xact_commit: calls, xact_rollback: 0 }] };
        },
      }),
      machineEvidenceDirectories: { a: machineDirectory("a"), b: machineDirectory("b") },
      now: clock.now,
      delay: clock.delay,
      onProbeWindowStart: async (pair: number, sample: { observedAtMs: number }) => {
        for (const machine of ["a", "b"]) {
          writeFileSync(join(machineDirectory(machine), `calibration-pair-${pair}-start.json`),
            `${JSON.stringify({ pair, startAt: new Date(sample.observedAtMs).toISOString(), counterBoundaryObservedAtMs: sample.observedAtMs })}\n`, { flag: "wx" });
        }
      },
      beforeProbeWindowEnd: async (pair: number) => {
        for (const machine of ["a", "b"]) {
          await waitForControl(join(machineDirectory(machine), `calibration-pair-${pair}-complete.json`), { deadlineMs: clock.now() + 10_000, now: clock.now, delay: clock.delay });
        }
      },
    });
    // The machine agent's calibration loop, with this definition's window and cadence.
    const agent = async (machine: string) => {
      const directory = machineDirectory(machine);
      for (let pair = 1; pair <= definition.pairs; pair += 1) {
        const boundary = await waitForControl(join(directory, `calibration-pair-${pair}-start.json`), { deadlineMs: clock.now() + 60_000, now: clock.now, delay: clock.delay });
        const records = await executeProbeSchedule({
          schedule: createProbeSchedule({
            phase: `calibration-${pair}`, machine, appliedAtMs: Date.parse(boundary.startAt),
            holdMaximumMs: definition.probeWindowSeconds * 1000, cadenceMs: definition.probeCadenceSeconds * 1000,
            timeoutMs: contract.observability.probe.transportTimeoutMs,
          }),
          wait: clock.delay,
          now: clock.now,
          probe: (entry: { sequence: number }) => runRawStatusProbe({
            ...entry, runId, contractSha256, cwd: "/project", token: "token", evidenceDirectory: directory,
            operationIds: contract.observability.cardinality.operationIds,
            calibrationSample: { pair },
            now: clock.now,
            delay: clock.delay,
            fetch: async () => {
              const dispatchedAtMs = clock.now();
              held[machine].push([dispatchedAtMs + 10, dispatchedAtMs + durations[machine] - 10]);
              await clock.delay(durations[machine]);
              return { status: 200, arrayBuffer: async () => statusBytes("healthy", dispatchedAtMs + 5) };
            },
          }),
        });
        writeFileSync(join(directory, `calibration-pair-${pair}-complete.json`), `${JSON.stringify({ machine, pair, probes: records.length })}\n`, { flag: "wx" });
      }
    };
    // The coordinator reaches its first wait before the agents start polling.
    for (let turn = 0; turn < 1_000 && clock.pending() === 0; turn += 1) await clock.settle(1);
    const [raw] = await clock.run(Promise.all([coordinator, agent("a"), agent("b")]), 60_000);
    const probes = ["a", "b"].flatMap((machine) => readFileSync(join(machineDirectory(machine), "probes.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line)));
    const evidence = finalizeCalibrationEvidence(raw, probes, calibrationContract, {
      stagedPackageSha256: "a".repeat(64),
      configuredPoolEvidence: { configuredPoolMax: 2, poolByMachine: { a: { configuredMax: 2 }, b: { configuredMax: 2 } } },
    });
    expect(evidence.connections.machines.map((entry: any) => [entry.machine, entry.verdict, entry.sampledActiveIntervals, entry.activeIntervals, entry.sampledIncrement]))
      .toEqual([["a", "pass", 12, 12, 1], ["b", "pass", 12, 12, 0]]);
    // Every probe read its own answer, sampled 80 ms after it started and inside its interval.
    expect(probes.map((probe: any) => [probe.connectionSample?.status, probe.connectionSample?.observedAtMs - probe.startedAtMs,
      probe.connectionSample?.observedAtMs <= probe.completedAtMs])).toEqual(probes.map(() => ["acknowledged", 80, true]));
    // A's samples landed while its connection was open. B's landed after its connection closed and
    // read the baseline: a zero increment is not zero cost.
    expect(evidence.connections.machines.map((entry: any) => [...new Set(entry.probeSampleDiagnostics.map((diagnostic: any) => `${diagnostic.offsetMs}:${diagnostic.countMinusBaseline}`))]))
      .toEqual([["80:1"], ["80:0"]]);
    // B's 40 ms probes held their intervals open for the answer; A's 120 ms probes did not wait.
    expect(["a", "b"].map((machine) => [...new Set(probes.filter((probe: any) => probe.machine === machine).map((probe: any) => probe.durationMs))]))
      .toEqual([[120], [80]]);
    // The coordinator sampled each probe exactly once; requests due together shared one query.
    expect(raw.probeSamples.flatMap((sample: any) => sample.probeIds).sort()).toEqual(probes.map((probe: any) => probe.id).sort());
  });
});
