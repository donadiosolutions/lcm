#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createDeterministicSchedule, createFaultSchedule } from "./schedule.mjs";
import { loadCertificationContract } from "./contract.mjs";

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

export function machineConfigEntries(environment) {
  if (!environment.LCM_CERT_MIGRATION_ROLE) throw new Error("certification migration role is required");
  return [
    ["storage.backend", "postgresql"],
    ["storage.postgresql.migrationRole", environment.LCM_CERT_MIGRATION_ROLE],
    ["summarizer.mock", "true"],
    ["hooks.disableAutoCompact", "true"],
    ["hooks.snapshotIntervalSec", "1"],
    ["storage.postgresql.poolMax", "2"],
  ];
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

export function querySqliteBounded(databasePath, mode, sessionId, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sqlite-observer-worker.mjs", import.meta.url), {
      workerData: { databasePath, mode, sessionId },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("certification SQLite observer query deadline exceeded"));
    }, timeoutMs);
    worker.once("message", (message) => { clearTimeout(timer); resolve(message.rows); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    worker.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`certification SQLite observer exited ${code}`)); }
    });
  });
}

export function readAcknowledgmentRows(databasePath) {
  return querySqliteBounded(databasePath, "acknowledgments");
}

function readAllDeliveryRows(databasePath) {
  return querySqliteBounded(databasePath, "all");
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

export function readEventRows(databasePath, sessionId) {
  return querySqliteBounded(databasePath, "session", sessionId);
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
    const processStartNs = process.hrtime.bigint();
    const processStartWallMs = Date.now();
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 5_000);
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const result = {
        code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
        processStartNs: processStartNs.toString(), processExitNs: process.hrtime.bigint().toString(),
        processStartWallMs, processExitWallMs: Date.now(),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`LCM command failed with ${code ?? signal}`), result, {
        errorClass: timedOut ? "OperationDeadlineExceeded" : "CliExit",
      }));
    });
  });
}
export function classifyTlsRejection(error) {
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.toLowerCase();
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
  wallNow = () => Date.now(),
  scheduleStartWallMs = wallNow(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const admission = createAdmissionController({ maxActive: 4, maxQueued: 64 });
  const transientCli = createAdmissionController({ maxActive: 1, maxQueued: 64 });
  const samplesPath = join(evidenceDirectory, "samples.ndjson");
  const ledgerPath = join(evidenceDirectory, "invocations.ndjson");
  const fatalAbort = new AbortController();
  const operations = schedule.map(async (entry) => {
    const scheduledWallMs = scheduleStartWallMs + entry.offsetSeconds * 1000;
    const operationDeadlineWallMs = scheduledWallMs + 60_000;
    const remainingOperationMs = () => operationDeadlineWallMs - wallNow();
    await waitForScheduledDelay(Math.max(0, scheduledWallMs - wallNow()), fatalAbort.signal, delay);
    if (fatalAbort.signal.aborted) {
      const sample = { id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, sessionId: entry.sessionId, phase: entry.phase ?? "steady", scheduledWallMs, outcome: "cancelled", errorClass: "AdmissionAborted" };
      appendNdjson(samplesPath, sample);
      return sample;
    }
    try {
      return await admission.run(async () => {
      if (fatalAbort.signal.aborted) throw Object.assign(new Error("certification schedule aborted"), { code: "AdmissionAborted" });
      if (remainingOperationMs() <= 0) throw Object.assign(new Error("certification operation deadline elapsed before admission"), { code: "OperationDeadlineExceeded" });
      const startedAt = now();
      const monotonicStartNs = process.hrtime.bigint();
      const wallStartedAt = new Date().toISOString();
    let outcome = "success";
    let errorClass;
    let commandTiming;
    let submittedPrimaryBytes;
    let submittedEnvelopeBytes;
    let storedTruncated;
    try {
      if (entry.op === "hook") {
        const fixture = createHookFixture({ kind: entry.kind, bytes: entry.primaryTextBytes, sessionId: entry.sessionId, cwd });
        submittedPrimaryBytes = entry.primaryTextBytes;
        submittedEnvelopeBytes = Buffer.byteLength(JSON.stringify(fixture));
        storedTruncated = entry.primaryTextBytes > 2000;
        appendNdjson(ledgerPath, { invocationId: entry.id, kind: entry.kind, sessionId: entry.sessionId, expectedCount: 1, scheduledWallMs });
        let hookError;
        await transientCli.run(async () => {
          const databasePath = findEventsDatabase(environment.HOME);
          const before = databasePath ? await readEventRows(databasePath, entry.sessionId) : [];
          try {
            commandTiming = await runCli(entrypoint, [entry.kind], { cwd, env: environment, input: JSON.stringify(fixture), timeoutMs: Math.max(1, remainingOperationMs()) });
          } catch (error) {
            commandTiming = error;
            hookError = error;
          }
          const captureDeadline = performance.now() + Math.max(0, Math.min(2000, remainingOperationMs()));
          let captured;
          let captureError;
          while (performance.now() <= captureDeadline) {
            const resolvedDatabase = findEventsDatabase(environment.HOME);
            if (resolvedDatabase) {
              try {
                const after = await readEventRows(resolvedDatabase, entry.sessionId);
                const expectedData = entry.kind === "user-prompt" ? fixture.prompt : `${fixture.tool_input.subject} → ${fixture.tool_input.status}`;
                const truncatedExpectedData = expectedData.length > 2000 ? `${expectedData.slice(0, 2000)}...` : expectedData;
                captured = captureInvocationRow(before, after, {
                  sessionId: entry.sessionId,
                  sourceHook: entry.kind === "user-prompt" ? "UserPromptSubmit" : "PostToolUse",
                  type: entry.kind === "user-prompt" ? "user_decision" : "task_create",
                  payloadSha256: createHash("sha256").update(truncatedExpectedData).digest("hex"),
                });
                break;
              } catch (error) { captureError = error; }
            }
            await delay(25);
          }
          if (!captured) {
            appendNdjson(ledgerPath, { invocationId: entry.id, captureFailure: true, capturedAt: new Date().toISOString(), errorClass: captureError?.name ?? "Error" });
            throw Object.assign(new Error("hook row capture exceeded its operation deadline", { cause: captureError }), { errorClass: "OperationDeadlineExceeded" });
          }
          const capturedMonotonicNs = process.hrtime.bigint();
          appendNdjson(ledgerPath, {
            invocationId: entry.id, ...captured, capturedAt: new Date().toISOString(),
            capturedMonotonicNs: capturedMonotonicNs.toString(),
            captureDelayMs: Number(capturedMonotonicNs - BigInt(commandTiming.processExitNs)) / 1e6,
          });
        });
        if (hookError) throw hookError;
      } else if (entry.op === "search") {
        commandTiming = await transientCli.run(() => runCli(entrypoint, ["search", "deterministic certification record"], { cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()) }));
      } else if (entry.op === "store") {
        commandTiming = await transientCli.run(() => runCli(entrypoint, ["store", `certification record ${entry.id}`, "--tag", "type:solution", "--tag", "scope:project"], { cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()) }));
      } else if (entry.op === "snapshot") {
        appendFileSync(environment.LCM_CERT_TRANSCRIPT_PATH, `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Certification snapshot ${entry.id}.` }] },
        })}\n`, { encoding: "utf8", mode: 0o600 });
        commandTiming = await transientCli.run(() => runCli(entrypoint, ["session-snapshot", "--client", "codex"], {
          cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()),
          input: JSON.stringify({ session_id: entry.sessionId, cwd, client: "codex", hook_event_name: "Stop", transcript_path: environment.LCM_CERT_TRANSCRIPT_PATH }),
        }));
      } else if (entry.op === "compact") {
        commandTiming = await transientCli.run(() => runCli(entrypoint, ["compact", "--no-promote"], { cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()) }));
      }
    } catch (error) {
      outcome = "failed";
      errorClass = error?.errorClass ?? error?.code ?? error?.name ?? "Error";
      if (errorClass === "OperationDeadlineExceeded") fatalAbort.abort(error);
    }
    const endedAt = now();
    const wallEndedAt = new Date().toISOString();
    if (wallNow() > operationDeadlineWallMs) {
      outcome = "failed";
      errorClass = "OperationDeadlineExceeded";
      fatalAbort.abort(new Error("certification operation deadline exceeded"));
    }
    const sample = {
      id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, sessionId: entry.sessionId, phase: entry.phase ?? "steady",
      scheduledAt: scheduledWallMs, startedAt, monotonicStartNs: monotonicStartNs.toString(),
      monotonicEndNs: process.hrtime.bigint().toString(), wallStartedAt, wallEndedAt,
      scheduledWallMs,
      processStartNs: commandTiming?.processStartNs,
      processExitNs: commandTiming?.processExitNs,
      processStartWallMs: commandTiming?.processStartWallMs,
      processExitWallMs: commandTiming?.processExitWallMs,
      scheduleDelayMs: (commandTiming?.processStartWallMs ?? Date.now()) - scheduledWallMs,
      durationMs: commandTiming?.processStartNs && commandTiming?.processExitNs
        ? Number(BigInt(commandTiming.processExitNs) - BigInt(commandTiming.processStartNs)) / 1e6
        : endedAt - startedAt,
      outcome,
      ...(submittedPrimaryBytes === undefined ? {} : { submittedPrimaryBytes, submittedEnvelopeBytes, storedTruncated }),
      ...(errorClass ? { errorClass } : {}),
    };
    appendNdjson(samplesPath, sample);
      return sample;
      });
    } catch (error) {
      const sample = { id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, sessionId: entry.sessionId, phase: entry.phase ?? "steady", scheduledWallMs, outcome: "failed", errorClass: /overflow/u.test(error?.message ?? "") ? "AdmissionOverflow" : error?.code ?? error?.name ?? "Error" };
      appendNdjson(samplesPath, sample);
      fatalAbort.abort(error);
      return sample;
    }
  });
  return Promise.all(operations);
}

async function observeUntilStopped({ home, evidenceDirectory, signal }) {
  let observations = new Map();
  let priorPoll = performance.now();
  let identityWitness;
  let incomplete = false;
  let seenDatabase = false;
  try {
    while (!signal.aborted) {
    const currentPoll = performance.now();
    const gapMs = currentPoll - priorPoll;
    priorPoll = currentPoll;
    const databasePath = findEventsDatabase(home);
    if (!databasePath) {
      incomplete ||= seenDatabase;
      appendNdjson(join(evidenceDirectory, "observer.ndjson"), { monotonicMs: currentPoll, gapMs, status: seenDatabase ? "missing" : "waiting", incomplete: seenDatabase, acknowledgments: Object.fromEntries(observations) });
    } else {
      seenDatabase = true;
      const file = statSync(databasePath);
      const parent = statSync(dirname(databasePath));
      const currentWitness = `${parent.dev}:${parent.ino}:${file.dev}:${file.ino}`;
      if (identityWitness !== undefined && currentWitness !== identityWitness) {
        incomplete = true;
        appendNdjson(join(evidenceDirectory, "observer.ndjson"), { monotonicMs: currentPoll, gapMs, status: "replaced", incomplete: true, acknowledgments: Object.fromEntries(observations) });
        break;
      }
      identityWitness = currentWitness;
      const siblingsPresent = existsSync(`${databasePath}-wal`) && existsSync(`${databasePath}-shm`);
      try {
        observations = observeAcknowledgments(observations, await readAcknowledgmentRows(databasePath));
      } catch (error) {
        incomplete = true;
        appendNdjson(join(evidenceDirectory, "observer.ndjson"), { monotonicMs: currentPoll, gapMs, status: "error", errorClass: error?.name ?? "Error", incomplete: true, acknowledgments: Object.fromEntries(observations) });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      incomplete ||= gapMs > 2000 || !siblingsPresent;
      appendNdjson(join(evidenceDirectory, "observer.ndjson"), {
        monotonicMs: currentPoll,
        gapMs,
        status: "ok",
        siblingsPresent,
        incomplete: gapMs > 2000 || !siblingsPresent,
        acknowledgments: Object.fromEntries(observations),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    try {
      appendNdjson(join(evidenceDirectory, "observer.ndjson"), {
        monotonicMs: performance.now(), status: "error", errorClass: error?.name ?? "Error",
        incomplete: true, acknowledgments: Object.fromEntries(observations),
      });
    } catch {
      // The returned in-memory result still preserves observations if evidence I/O itself failed.
    }
    return { observations, incomplete: true, identityWitness, error };
  }
  return { observations, incomplete, identityWitness };
}

function appendNdjson(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function waitForControl(path, { deadlineMs, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  while (now() < deadlineMs) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    await delay(Math.min(1000, Math.max(0, deadlineMs - now())));
  }
  throw new Error(`certification control deadline expired: ${path}`);
}

async function waitForScheduledDelay(milliseconds, signal, delay) {
  let onAbort;
  const abort = new Promise((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  await Promise.race([delay(milliseconds), abort]);
  signal.removeEventListener("abort", onAbort);
}

async function waitForAcknowledgmentCatchUp(home, evidenceDirectory, phase, deadlineSeconds) {
  const started = Date.now();
  let result;
  while (Date.now() - started <= deadlineSeconds * 1000) {
    const databasePath = findEventsDatabase(home);
    if (databasePath) {
      const rows = await readAllDeliveryRows(databasePath);
      const incomplete = rows.filter((row) => !isAcknowledgedRow(row) || !row.remote_pruned_at);
      if (incomplete.length === 0) {
        result = { phase, verdict: "pass", seconds: (Date.now() - started) / 1000, remaining: 0 };
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  result ??= { phase, verdict: "fail", seconds: deadlineSeconds, remaining: null };
  writeFileSync(join(evidenceDirectory, `${phase}-catch-up.json`), `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  return result;
}

export async function runMachineAgent(environment = process.env) {
  const evidenceDirectory = environment.LCM_CERT_EVIDENCE_DIR;
  const machine = process.argv[process.argv.indexOf("--machine") + 1];
  if (!evidenceDirectory || !['a', 'b'].includes(machine)) throw new Error("missing machine-agent configuration");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const { contract } = loadCertificationContract(new URL("./contract-v1.json", import.meta.url));
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
  for (const [path, value] of machineConfigEntries(environment)) {
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
  const observer = observeUntilStopped({ home: environment.HOME, evidenceDirectory, signal: observerAbort.signal });
  let observerResult;
  let expectedEvents = 0;
  try {
    const profile = environment.LCM_CERT_PROFILE;
    const timeline = contract.timeline[profile];
    const warmupControl = await waitForControl(join(evidenceDirectory, "warmup-control.json"), {
      deadlineMs: Date.now() + contract.timeline.full.setupMaxSeconds * 1000,
    });
    const warmupSeconds = timeline.warmupSeconds;
    const warmup = createDeterministicSchedule({
      profile: "smoke", machine, runId: environment.LCM_CERT_RUN_ID,
      idNamespace: `${environment.LCM_CERT_RUN_ID}-warmup`, contract,
    })
      .filter((entry) => entry.offsetSeconds < warmupSeconds)
      .map((entry) => ({ ...entry, phase: "warmup" }));
    const schedule = createDeterministicSchedule({ profile, machine, runId: environment.LCM_CERT_RUN_ID, contract });
    const emissionTimes = [
      ...warmup.filter((entry) => entry.op === "hook").map((entry) => entry.offsetSeconds),
      ...schedule.filter((entry) => entry.op === "hook").map((entry) => warmupSeconds + entry.offsetSeconds),
    ];
    verifyEmissionBudget(emissionTimes, 30);
    expectedEvents = emissionTimes.length;
    await executeDeterministicSchedule({ schedule: warmup, scheduleStartWallMs: Date.parse(warmupControl.warmupStartAt), entrypoint: lcm, cwd: project, environment, evidenceDirectory });
    writeFileSync(join(evidenceDirectory, "warmup-complete.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    const control = await waitForControl(join(evidenceDirectory, "phase-control.json"), {
      deadlineMs: Date.now() + 120_000,
    });
    await executeDeterministicSchedule({ schedule, scheduleStartWallMs: Date.parse(control.steadyT0At), entrypoint: lcm, cwd: project, environment, evidenceDirectory });
    writeFileSync(join(evidenceDirectory, "steady-complete.json"), `${JSON.stringify({ machine, at: new Date().toISOString(), steadyT0At: control.steadyT0At })}\n`, { mode: 0o600, flag: "wx" });
    const settleUntil = Date.parse(control.steadyT0At) + timeline.steadySeconds * 1000 + (timeline.pendingSettleMaxSeconds ?? 0) * 1000;
    if (Date.now() < settleUntil) await new Promise((resolve) => setTimeout(resolve, settleUntil - Date.now()));
    writeFileSync(join(evidenceDirectory, "fault-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    if (profile === "full") {
      const partitionSchedule = createFaultSchedule({
        machine, runId: environment.LCM_CERT_RUN_ID, phase: "partition-recovery",
        durationSeconds: contract.thresholds.recovery.partition.rtoSeconds,
      });
      await executeDeterministicSchedule({ schedule: partitionSchedule, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
      await waitForControl(join(evidenceDirectory, "partition-cleared.json"), {
        deadlineMs: Date.now() + timeline.partitionPhaseMaxSeconds * 1000,
      });
      const partitionCatchUp = await waitForAcknowledgmentCatchUp(environment.HOME, evidenceDirectory, "partition", contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds);
      if (partitionCatchUp.verdict !== "pass") throw new Error("partition acknowledgment catch-up failed");
      writeFileSync(join(evidenceDirectory, "partition-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      if (environment.LCM_CERT_LANE === "local") {
        writeFileSync(join(evidenceDirectory, "restart-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString(), priorCatchUp: partitionCatchUp.verdict })}\n`, { mode: 0o600, flag: "wx" });
        const restartSchedule = createFaultSchedule({
          machine, runId: environment.LCM_CERT_RUN_ID, phase: "restart-recovery",
          durationSeconds: contract.thresholds.recovery.restartDatabase.rtoSeconds,
        });
        await executeDeterministicSchedule({ schedule: restartSchedule, entrypoint: lcm, cwd: project, environment, evidenceDirectory });
        await waitForControl(join(evidenceDirectory, "restart-cleared.json"), {
          deadlineMs: Date.now() + timeline.restartPhaseMaxSeconds * 1000,
        });
        const restartCatchUp = await waitForAcknowledgmentCatchUp(environment.HOME, evidenceDirectory, "restart", contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds);
        if (restartCatchUp.verdict !== "pass") throw new Error("restart acknowledgment catch-up failed");
        writeFileSync(join(evidenceDirectory, "restart-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      }
    }
    const drainSeconds = environment.LCM_CERT_PROFILE === "full" ? 900 : 660;
    await new Promise((resolve) => setTimeout(resolve, drainSeconds * 1000));
  } finally {
    observerAbort.abort();
    observerResult = await observer;
  }
  appendNdjson(join(evidenceDirectory, "acknowledgments.ndjson"), Object.fromEntries(observerResult.observations));
  let drain;
  let drainError;
  let sweepTimestamps = [];
  try {
    const finalDatabase = findEventsDatabase(environment.HOME);
    if (!finalDatabase) throw new Error("event database is missing after workload");
    const finalFile = statSync(finalDatabase);
    const finalParent = statSync(dirname(finalDatabase));
    const finalWitness = `${finalParent.dev}:${finalParent.ino}:${finalFile.dev}:${finalFile.ino}`;
    const finalRows = await readAllDeliveryRows(finalDatabase);
    if (observerResult.identityWitness !== finalWitness) throw new Error("final drain database identity differs from observer witness");
    if (finalRows.length !== expectedEvents) throw new Error(`certification event oracle expected ${expectedEvents} rows, observed ${finalRows.length}`);
    drain = { verdict: "pass", expectedEvents, ...verifyFinalDrain(finalRows), nonterminal: 0, awaitingRemotePrune: 0 };
    sweepTimestamps = [...new Set(finalRows.map((row) => row.remote_pruned_at).filter((value) => typeof value === "string" && value.length > 0))].sort();
  } catch (error) {
    drainError = error;
    drain = { verdict: "fail", expectedEvents, acknowledged: 0, remotePruned: 0, nonterminal: null, awaitingRemotePrune: null, errorClass: error?.name ?? "Error" };
  }
  writeFileSync(join(evidenceDirectory, "drain.json"), `${JSON.stringify(drain)}\n`, { mode: 0o600, flag: "wx" });
  if (drainError) throw drainError;
  const finalDoctor = await execFileAsync(process.execPath, [lcm, "doctor", "--verbose"], { cwd: project, env: environment, timeout: 60_000 });
  writeFileSync(join(evidenceDirectory, "final-diagnostics.json"), `${JSON.stringify({
    doctorSha256: createHash("sha256").update(finalDoctor.stdout).digest("hex"),
    doctor: finalDoctor.stdout,
    sweepTimestamps,
  })}\n`, { mode: 0o600, flag: "wx" });
  await waitForControl(join(evidenceDirectory, "clock-finished.json"), { deadlineMs: Date.now() + 120_000 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMachineAgent().catch((error) => {
    process.stderr.write(`machine agent failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
