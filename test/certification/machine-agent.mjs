#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createDeterministicSchedule } from "./schedule.mjs";

const execFileAsync = promisify(execFile);

function padded(prefix, bytes) {
  const prefixBytes = Buffer.byteLength(prefix);
  if (!Number.isSafeInteger(bytes) || bytes < prefixBytes) throw new Error("fixture byte count is too small");
  return prefix + "x".repeat(bytes - prefixBytes);
}
export function createHookFixture({ kind, bytes, sessionId, cwd }) {
  if (kind === "user-prompt") {
    return { prompt: padded("Always prefer deterministic records. ", bytes), session_id: sessionId, cwd, client: "codex" };
  }
  if (kind === "post-tool") {
    return {
      tool_name: "TaskCreate",
      tool_input: { subject: padded("fixture ", bytes), status: "created" },
      tool_response: "ok",
      session_id: sessionId,
      cwd,
      client: "codex",
    };
  }
  throw new Error("unsupported hook fixture kind");
}

export function isAcknowledgedRow(row) {
  return row?.delivery_state === "acknowledged"
    && typeof row.remote_inbox_id === "string" && row.remote_inbox_id.length > 0
    && typeof row.acknowledged_at === "string" && row.acknowledged_at.length > 0;
}

export function observeAcknowledgments(previous, rows, monotonicNs = process.hrtime.bigint()) {
  const result = new Map(previous);
  for (const row of rows) {
    if (!isAcknowledgedRow(row)) continue;
    const existing = result.get(row.event_uuid);
    const inboxIds = new Set(existing?.inboxIds ?? []);
    inboxIds.add(row.remote_inbox_id);
    result.set(row.event_uuid, {
      firstSeenMonotonicNs: existing?.firstSeenMonotonicNs ?? monotonicNs.toString(),
      inboxIds: [...inboxIds].sort(),
    });
  }
  return result;
}

export function createAdmissionController({ maxActive, maxQueued }) {
  if (!Number.isSafeInteger(maxActive) || maxActive <= 0 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new Error("invalid admission limits");
  }
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < maxActive && queue.length > 0) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return {
    run(operation) {
      if (active >= maxActive && queue.length >= maxQueued) return Promise.reject(new Error("certification admission queue overflow"));
      const promise = new Promise((resolve, reject) => queue.push({ operation, resolve, reject }));
      drain();
      return promise;
    },
    state: () => ({ active, queued: queue.length }),
  };
}

export async function readAcknowledgmentRows(databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 250 });
  try {
    return database.prepare(`SELECT event_uuid, delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at
      FROM events
      WHERE delivery_state IN ('replicated', 'acknowledged')`).all();
  } finally {
    database.close();
  }
}

async function readAllDeliveryRows(databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 250 });
  try {
    return database.prepare(`SELECT event_uuid, delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at
      FROM events ORDER BY event_id`).all();
  } finally {
    database.close();
  }
}

export function verifyFinalDrain(rows) {
  const nonterminal = rows.filter((row) => !isAcknowledgedRow(row));
  if (nonterminal.length > 0) throw new Error(`${nonterminal.length} certification events remain nonterminal`);
  const awaitingPrune = rows.filter((row) => row.remote_pruned_at === null || row.remote_pruned_at === undefined);
  if (awaitingPrune.length > 0) throw new Error(`${awaitingPrune.length} certification events remain awaiting remote prune`);
  return { acknowledged: rows.length, remotePruned: rows.length };
}

export function verifyEmissionBudget(scheduledSeconds, maximum) {
  const sorted = [...scheduledSeconds].sort((left, right) => left - right);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end] - sorted[start] >= 300) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  if (peak > maximum) throw new Error(`certification emission budget exceeded: ${peak} > ${maximum}`);
  return peak;
}

export async function readEventRows(databasePath, sessionId) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 250 });
  try {
    return database.prepare(`SELECT event_uuid, machine_sequence, session_id, type, source_hook, data,
      delivery_state, remote_inbox_id, acknowledged_at, remote_pruned_at
      FROM events WHERE session_id = ? ORDER BY event_id`).all(sessionId);
  } finally {
    database.close();
  }
}

export function captureInvocationRow(before, after, expected) {
  const previous = new Set(before.map((row) => row.event_uuid));
  const added = after.filter((row) => !previous.has(row.event_uuid));
  if (added.length !== 1) throw new Error(`hook invocation produced ${added.length} rows instead of one`);
  const row = added[0];
  if (row.session_id !== expected.sessionId || row.source_hook !== expected.sourceHook || row.type !== expected.type) {
    throw new Error("hook invocation produced an unexpected row");
  }
  const payloadSha256 = createHash("sha256").update(row.data).digest("hex");
  if (expected.payloadSha256 && payloadSha256 !== expected.payloadSha256) {
    throw new Error("hook invocation produced an unexpected scrubbed payload");
  }
  return {
    eventUuid: row.event_uuid,
    machineSequence: row.machine_sequence,
    sessionId: row.session_id,
    sourceHook: row.source_hook,
    type: row.type,
    payloadSha256,
  };
}

function findEventsDatabase(home) {
  const directory = join(home, ".lcm", "events");
  if (!existsSync(directory)) return undefined;
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".db")).sort();
  if (candidates.length !== 1) return undefined;
  return join(directory, candidates[0]);
}

function runCli(entrypoint, args, { cwd, env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdin.end(input);
    let killTimer;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 5_000);
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const result = { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`LCM command failed with ${code ?? signal}`), result));
    });
  });
}
export function classifyTlsRejection(error) {
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  if (/hostname|altname|not cert's cn|does not match/u.test(text)) return "certificate-name";
  if (/certificate|self.signed|unable to verify|unknown ca/u.test(text)) return "certificate-authority";
  return "transport-or-other";
}

async function requireTlsRejection(entrypoint, environment, url, caFile, expected, cwd) {
  try {
    await runCli(entrypoint, ["project", "list", "--json"], {
      cwd,
      env: { ...environment, LCM_POSTGRES_URL: url, LCM_POSTGRES_CA_FILE: caFile },
    });
  } catch (error) {
    const classification = classifyTlsRejection(error);
    if (classification === expected) return classification;
    throw new Error(`TLS negative probe returned ${classification}, expected ${expected}`, { cause: error });
  }
  throw new Error(`TLS negative probe unexpectedly succeeded for ${expected}`);
}

export async function executeDeterministicSchedule({
  schedule,
  entrypoint,
  cwd,
  environment,
  evidenceDirectory,
  now = () => performance.now(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const admission = createAdmissionController({ maxActive: 4, maxQueued: 64 });
  const transientCli = createAdmissionController({ maxActive: 1, maxQueued: 64 });
  const start = now();
  const samplesPath = join(evidenceDirectory, "samples.ndjson");
  const ledgerPath = join(evidenceDirectory, "invocations.ndjson");
  const operations = schedule.map(async (entry) => {
    const scheduledAt = start + entry.offsetSeconds * 1000;
    await delay(Math.max(0, scheduledAt - now()));
    return admission.run(async () => {
      const startedAt = now();
      const monotonicStartNs = process.hrtime.bigint();
      const wallStartedAt = new Date().toISOString();
    let outcome = "success";
    let errorClass;
    try {
      if (entry.op === "hook") {
        const fixture = createHookFixture({ kind: entry.kind, bytes: entry.primaryTextBytes, sessionId: entry.sessionId, cwd });
        appendNdjson(ledgerPath, { invocationId: entry.id, kind: entry.kind, sessionId: entry.sessionId, expectedCount: 1, scheduledAt });
        const databasePath = findEventsDatabase(environment.HOME);
        const before = databasePath ? await readEventRows(databasePath, entry.sessionId) : [];
        let hookError;
        try {
          await transientCli.run(() => runCli(entrypoint, [entry.kind], { cwd, env: environment, input: JSON.stringify(fixture), timeoutMs: 60_000 }));
        } catch (error) {
          hookError = error;
        }
        const resolvedDatabase = findEventsDatabase(environment.HOME);
        if (!resolvedDatabase) throw new Error("hook event database was not created");
        const after = await readEventRows(resolvedDatabase, entry.sessionId);
        const expectedData = entry.kind === "user-prompt"
          ? fixture.prompt
          : `${fixture.tool_input.subject} → ${fixture.tool_input.status}`;
        const truncatedExpectedData = expectedData.length > 2000 ? `${expectedData.slice(0, 2000)}...` : expectedData;
        const captured = captureInvocationRow(before, after, {
          sessionId: entry.sessionId,
          sourceHook: entry.kind === "user-prompt" ? "UserPromptSubmit" : "PostToolUse",
          type: entry.kind === "user-prompt" ? "user_decision" : "task_create",
          payloadSha256: createHash("sha256").update(truncatedExpectedData).digest("hex"),
        });
        appendNdjson(ledgerPath, { invocationId: entry.id, ...captured });
        if (hookError) throw hookError;
      } else if (entry.op === "search") {
        await transientCli.run(() => runCli(entrypoint, ["search", "deterministic certification record"], { cwd, env: environment }));
      } else if (entry.op === "store") {
        await transientCli.run(() => runCli(entrypoint, ["store", `certification record ${entry.id}`, "--tag", "type:solution", "--tag", "scope:project"], { cwd, env: environment }));
      } else if (entry.op === "snapshot") {
        appendFileSync(environment.LCM_CERT_TRANSCRIPT_PATH, `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Certification snapshot ${entry.id}.` }] },
        })}\n`, { encoding: "utf8", mode: 0o600 });
        await transientCli.run(() => runCli(entrypoint, ["session-snapshot", "--client", "codex"], {
          cwd, env: environment,
          input: JSON.stringify({ session_id: entry.sessionId, cwd, client: "codex", hook_event_name: "Stop", transcript_path: environment.LCM_CERT_TRANSCRIPT_PATH }),
        }));
      } else if (entry.op === "compact") {
        await transientCli.run(() => runCli(entrypoint, ["compact", "--no-promote"], { cwd, env: environment }));
      }
    } catch (error) {
      outcome = "failed";
      errorClass = error?.code ?? error?.name ?? "Error";
    }
    const endedAt = now();
    const sample = {
      id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, phase: entry.phase ?? "steady",
      scheduledAt, startedAt, monotonicStartNs: monotonicStartNs.toString(),
      monotonicEndNs: process.hrtime.bigint().toString(), wallStartedAt, wallEndedAt: new Date().toISOString(),
      scheduleDelayMs: startedAt - scheduledAt, durationMs: endedAt - startedAt, outcome,
      ...(errorClass ? { errorClass } : {}),
    };
    appendNdjson(samplesPath, sample);
      return sample;
    });
  });
  return Promise.all(operations);
}

async function observeUntilStopped({ home, evidenceDirectory, signal }) {
  let observations = new Map();
  let priorPoll = performance.now();
  let identityWitness;
  while (!signal.aborted) {
    const currentPoll = performance.now();
    const gapMs = currentPoll - priorPoll;
    priorPoll = currentPoll;
    const databasePath = findEventsDatabase(home);
    if (databasePath) {
      const file = statSync(databasePath);
      const parent = statSync(dirname(databasePath));
      const currentWitness = `${parent.dev}:${parent.ino}:${file.dev}:${file.ino}`;
      if (identityWitness !== undefined && currentWitness !== identityWitness) {
        throw new Error("certification observer database identity changed");
      }
      identityWitness = currentWitness;
      observations = observeAcknowledgments(observations, await readAcknowledgmentRows(databasePath));
      appendNdjson(join(evidenceDirectory, "observer.ndjson"), {
        monotonicMs: currentPoll,
        gapMs,
        incomplete: gapMs > 2000,
        acknowledgments: Object.fromEntries(observations),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return observations;
}

function appendNdjson(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function runMachineAgent(environment = process.env) {
  const evidenceDirectory = environment.LCM_CERT_EVIDENCE_DIR;
  const machine = process.argv[process.argv.indexOf("--machine") + 1];
  if (!evidenceDirectory || !['a', 'b'].includes(machine)) throw new Error("missing machine-agent configuration");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const lcm = "/opt/lcm/dist/lcm.mjs";
  const name = `cert-${environment.LCM_CERT_RUN_ID}-${machine}`;
  const project = join(environment.HOME, "project");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const transcriptPath = join(environment.HOME, "transcript.jsonl");
  writeFileSync(transcriptPath, [
    JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: `cert-${environment.LCM_CERT_RUN_ID}-${machine}` } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Certification transcript fixture." }] } }),
  ].join("\n") + "\n", { mode: 0o600, flag: "wx" });
  environment.LCM_CERT_TRANSCRIPT_PATH = transcriptPath;
  for (const [path, value] of [
    ["summarizer.mock", "true"],
    ["hooks.disableAutoCompact", "true"],
    ["hooks.snapshotIntervalSec", "1"],
    ["storage.postgresql.poolMax", "2"],
  ]) {
    await execFileAsync(process.execPath, [lcm, "config", "set", path, value, "--json"], { cwd: project, env: environment, timeout: 60_000 });
  }
  await execFileAsync(process.execPath, [lcm, "machine", "register", "--name", name, "--json"], { cwd: project, env: environment, timeout: 60_000 });
  const tlsReadiness = {
    wrongCa: await requireTlsRejection(lcm, environment, environment.LCM_POSTGRES_URL, environment.LCM_CERT_WRONG_CA_FILE, "certificate-authority", project),
    wrongHostname: await requireTlsRejection(lcm, environment, environment.LCM_CERT_WRONG_HOST_URL, environment.LCM_POSTGRES_CA_FILE, "certificate-name", project),
  };
  const identity = await execFileAsync(process.execPath, [lcm, "machine", "show", "--json"], { cwd: project, env: environment, timeout: 60_000 });
  writeFileSync(join(evidenceDirectory, "identity.json"), identity.stdout, { mode: 0o600, flag: "wx" });
  await execFileAsync(process.execPath, [lcm, "project", "create", project, "--name", `cert-${environment.LCM_CERT_RUN_ID}`, "--json"], { cwd: project, env: environment, timeout: 60_000 });
  await execFileAsync(process.execPath, [lcm, "daemon", "start"], { env: environment, timeout: 60_000 });
  const doctor = await execFileAsync(process.execPath, [lcm, "doctor", "--verbose"], { cwd: project, env: environment, timeout: 60_000 });
  await execFileAsync(process.execPath, [lcm, "store", "certification readiness", "--tag", "type:solution", "--tag", "scope:project"], { cwd: project, env: environment, timeout: 60_000 });
  await execFileAsync(process.execPath, [lcm, "search", "certification readiness"], { cwd: project, env: environment, timeout: 60_000 });
  writeFileSync(join(evidenceDirectory, "readiness.json"), `${JSON.stringify({
    machine,
    tls: tlsReadiness,
    doctorSha256: createHash("sha256").update(doctor.stdout).digest("hex"),
    doctor: doctor.stdout,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(join(evidenceDirectory, "ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  const observerAbort = new AbortController();
  let observerError;
  const observer = observeUntilStopped({ home: environment.HOME, evidenceDirectory, signal: observerAbort.signal })
    .catch((error) => { observerError = error; return new Map(); });
  let observed;
  let expectedEvents = 0;
  try {
    const warmupSeconds = environment.LCM_CERT_PROFILE === "full" ? 120 : 20;
    const warmup = createDeterministicSchedule({ profile: "smoke", machine, runId: `${environment.LCM_CERT_RUN_ID}-warmup` })
      .filter((entry) => entry.offsetSeconds < warmupSeconds)
      .map((entry) => ({ ...entry, phase: "warmup" }));
    const schedule = createDeterministicSchedule({ profile: environment.LCM_CERT_PROFILE, machine, runId: environment.LCM_CERT_RUN_ID });
    const emissionTimes = [
      ...warmup.filter((entry) => entry.op === "hook").map((entry) => entry.offsetSeconds),
      ...schedule.filter((entry) => entry.op === "hook").map((entry) => warmupSeconds + entry.offsetSeconds),
    ];
    verifyEmissionBudget(emissionTimes, 30);
    expectedEvents = emissionTimes.length;
    await executeDeterministicSchedule({ schedule: warmup, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
    await executeDeterministicSchedule({ schedule, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
    writeFileSync(join(evidenceDirectory, "fault-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    if (environment.LCM_CERT_PROFILE === "full") {
      while (!existsSync(join(evidenceDirectory, "partition-cleared.json"))) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const recovery = createDeterministicSchedule({ profile: "smoke", machine, runId: `${environment.LCM_CERT_RUN_ID}-partition` })
        .filter((entry) => (entry.op === "search" || entry.op === "store") && entry.offsetSeconds < 60)
        .map((entry) => ({ ...entry, phase: "partition-recovery" }));
      await executeDeterministicSchedule({ schedule: recovery, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
      writeFileSync(join(evidenceDirectory, "partition-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      if (environment.LCM_CERT_LANE === "local") {
        writeFileSync(join(evidenceDirectory, "restart-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        while (!existsSync(join(evidenceDirectory, "restart-cleared.json"))) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const restartRecovery = recovery.map((entry) => ({ ...entry, id: entry.id.replace("partition", "restart"), phase: "restart-recovery" }));
        await executeDeterministicSchedule({ schedule: restartRecovery, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
        writeFileSync(join(evidenceDirectory, "restart-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      }
    }
    const drainSeconds = environment.LCM_CERT_PROFILE === "full" ? 900 : 660;
    await new Promise((resolve) => setTimeout(resolve, drainSeconds * 1000));
  } finally {
    observerAbort.abort();
    observed = await observer;
  }
  if (observerError) throw observerError;
  appendNdjson(join(evidenceDirectory, "acknowledgments.ndjson"), Object.fromEntries(observed));
  const finalDatabase = findEventsDatabase(environment.HOME);
  if (!finalDatabase) throw new Error("event database is missing after workload");
  const finalRows = await readAllDeliveryRows(finalDatabase);
  if (finalRows.length !== expectedEvents) throw new Error(`certification event oracle expected ${expectedEvents} rows, observed ${finalRows.length}`);
  const drain = verifyFinalDrain(finalRows);
  writeFileSync(join(evidenceDirectory, "drain.json"), `${JSON.stringify(drain)}\n`, { mode: 0o600, flag: "wx" });
  while (!existsSync(join(evidenceDirectory, "clock-finished.json"))) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMachineAgent().catch((error) => {
    process.stderr.write(`machine agent failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
