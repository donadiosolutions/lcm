#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
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

export function machineStoredConfig(environment) {
  if (!environment.LCM_CERT_MIGRATION_ROLE) throw new Error("certification migration role is required");
  return {
    summarizer: { mock: true },
    hooks: { disableAutoCompact: true, snapshotIntervalSec: 1 },
    storage: {
      backend: "sqlite",
      postgresql: { migrationRole: environment.LCM_CERT_MIGRATION_ROLE, poolMax: 2 },
    },
  };
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

const DIAGNOSTIC_TEXT_LIMIT = 4096;
const SECRET_ENVIRONMENT_NAME = /(PASSWORD|TOKEN|SECRET|KEY|_URL)$/iu;

// Bounded, redacted text for private failure diagnostics. Exact secret-bearing
// environment values are masked first, then any credential embedded in a URL.
export function redactDiagnosticText(text, environment = {}, limit = DIAGNOSTIC_TEXT_LIMIT) {
  let value = typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
  for (const [name, secret] of Object.entries(environment)) {
    if (typeof secret !== "string" || secret.length < 8 || !SECRET_ENVIRONMENT_NAME.test(name)) continue;
    value = value.split(secret).join(`[redacted:${name}]`);
  }
  value = value.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s@]+@/giu, "$1[redacted]@");
  if (value.length > limit) value = `${value.slice(0, limit)}...[truncated ${value.length - limit} characters]`;
  return value;
}

// Private per-machine failure record (machine-<x>/failures.ndjson). The gate never
// reads this file, so diagnostic text stays out of public gate output.
export function createOperationFailureRecord(entry, error, errorClass, environment) {
  return {
    id: entry.id, machine: entry.machine, op: entry.op, kind: entry.kind, phase: entry.phase ?? "steady",
    recordedAt: new Date().toISOString(),
    errorClass,
    exitCode: Number.isInteger(error?.code) ? error.code : null,
    exitSignal: typeof error?.signal === "string" ? error.signal : null,
    message: redactDiagnosticText(error?.message, environment),
    stderr: redactDiagnosticText(error?.stderr, environment),
    stdout: redactDiagnosticText(error?.stdout, environment),
    processStartWallMs: Number.isFinite(error?.processStartWallMs) ? error.processStartWallMs : null,
    processExitWallMs: Number.isFinite(error?.processExitWallMs) ? error.processExitWallMs : null,
  };
}

async function probeRawTlsRejection(url, caFile) {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: endpoint.hostname,
      port: Number(endpoint.port || 5432),
      servername: endpoint.hostname,
      ca: readFileSync(caFile),
      rejectUnauthorized: true,
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(new Error("raw TLS probe timed out"));
    }, 10_000);
    timeout.unref?.();
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      socket.end();
      reject(new Error("raw TLS negative probe unexpectedly succeeded"));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

export async function verifyTlsNegativeProbe({ expected, clientProbe, tlsProbe }) {
  let clientError;
  try { await clientProbe(); } catch (error) { clientError = error; }
  if (!clientError) throw new Error(`TLS negative probe unexpectedly succeeded for ${expected}`);
  const clientClassification = classifyTlsRejection(clientError);
  if (clientClassification !== expected) {
    throw new Error(`LCM client TLS probe returned ${clientClassification}, expected ${expected}`);
  }
  const classification = classifyTlsRejection(await tlsProbe());
  if (classification !== expected) {
    throw new Error(`TLS negative probe returned ${classification}, expected ${expected}`);
  }
  return classification;
}

function operationDeadlineError() {
  return Object.assign(new Error("certification operation deadline exceeded"), {
    code: "OperationDeadlineExceeded",
    errorClass: "OperationDeadlineExceeded",
  });
}

async function runWithDeadline(timeoutMs, parentSignal, operation) {
  const controller = new AbortController();
  let deadlineExpired = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(operationDeadlineError());
  }, Math.max(1, timeoutMs));
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = await operation({ signal: controller.signal, timeoutMs: Math.max(1, timeoutMs) });
    if (deadlineExpired) throw operationDeadlineError();
    return result;
  } catch (error) {
    if (deadlineExpired) throw operationDeadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export async function probeLcmTlsRejection({ entrypoint, url, caFile, loadClientConfig, clientFactory }) {
  const buildClientConfig = loadClientConfig ?? (async () => {
    const module = await import(pathToFileURL(join(dirname(entrypoint), "src", "storage", "postgresql", "client-config.js")).href);
    return module.buildPostgreSqlClientConfig;
  });
  const createClient = clientFactory ?? (async (config) => {
    const loaded = await import("pg");
    const Client = loaded.Client ?? loaded.default?.Client;
    return new Client(config);
  });
  const config = (await buildClientConfig())({
    url,
    caFile,
    poolMax: 1,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 10_000,
    statementTimeoutMs: 10_000,
    snapshotIdleTimeoutMs: 10_000,
  }, { applicationName: "lcm-certification-tls-negative" });
  const client = await createClient(config);
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function requireTlsRejection(entrypoint, _environment, url, caFile, expected, _cwd) {
  return verifyTlsNegativeProbe({
    expected,
    clientProbe: () => probeLcmTlsRejection({ entrypoint, url, caFile }),
    tlsProbe: () => probeRawTlsRejection(url, caFile),
  });
}

export async function executeDeterministicSchedule({
  schedule,
  entrypoint,
  cwd,
  environment,
  daemonClient,
  evidenceDirectory,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  scheduleStartWallMs = wallNow(),
  operationTimeoutMs = 60_000,
  delay = (milliseconds, options) => sleep(milliseconds, undefined, options),
}) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new Error("certification operation timeout must be a positive integer");
  }
  const admission = createAdmissionController({ maxActive: 4, maxQueued: 64 });
  const transientCli = createAdmissionController({ maxActive: 1, maxQueued: 64 });
  const samplesPath = join(evidenceDirectory, "samples.ndjson");
  const ledgerPath = join(evidenceDirectory, "invocations.ndjson");
  const failuresPath = join(evidenceDirectory, "failures.ndjson");
  const fatalAbort = new AbortController();
  const operations = schedule.map(async (entry) => {
    const scheduledWallMs = scheduleStartWallMs + entry.offsetSeconds * 1000;
    const operationDeadlineWallMs = scheduledWallMs + operationTimeoutMs;
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
    let exitCode;
    let exitSignal;
    let submittedPrimaryBytes;
    let submittedEnvelopeBytes;
    let storedTruncated;
    const timedDaemonCall = async (call) => {
      const processStartNs = process.hrtime.bigint();
      const processStartWallMs = Date.now();
      try { await call(); }
      finally {
        commandTiming = { processStartNs: processStartNs.toString(), processExitNs: process.hrtime.bigint().toString(), processStartWallMs, processExitWallMs: Date.now() };
      }
    };
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
        if (daemonClient) {
          await timedDaemonCall(() => runWithDeadline(remainingOperationMs(), fatalAbort.signal, (options) =>
            daemonClient.post("/search", { cwd, query: "deterministic certification record", limit: 5, layers: [], tags: [] }, options)));
        } else commandTiming = await transientCli.run(() => runCli(entrypoint, ["search", "deterministic certification record"], { cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()) }));
      } else if (entry.op === "store") {
        if (daemonClient) {
          await timedDaemonCall(() => runWithDeadline(remainingOperationMs(), fatalAbort.signal, (options) =>
            daemonClient.post("/store", { cwd, text: `certification record ${entry.id}`, tags: ["type:solution", "scope:project"], metadata: {} }, options)));
        } else commandTiming = await transientCli.run(() => runCli(entrypoint, ["store", `certification record ${entry.id}`, "--tag", "type:solution", "--tag", "scope:project"], { cwd, env: environment, timeoutMs: Math.max(1, remainingOperationMs()) }));
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
      errorClass = fatalAbort.signal.reason?.code === "OperationDeadlineExceeded"
        ? "OperationDeadlineExceeded"
        : error?.errorClass ?? error?.code ?? error?.name ?? "Error";
      if (error?.processStartNs && error?.processExitNs) {
        commandTiming = {
          processStartNs: error.processStartNs, processExitNs: error.processExitNs,
          processStartWallMs: error.processStartWallMs, processExitWallMs: error.processExitWallMs,
        };
      }
      if (Number.isInteger(error?.code)) exitCode = error.code;
      if (typeof error?.signal === "string") exitSignal = error.signal;
      appendNdjson(failuresPath, createOperationFailureRecord(entry, error, errorClass, environment));
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
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(exitSignal === undefined ? {} : { exitSignal }),
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
  try {
    await delay(milliseconds, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export async function waitForAcknowledgmentCatchUp(home, evidenceDirectory, phase, clearedAt, deadlineSeconds, options = {}) {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const clearedAtMs = Date.parse(clearedAt);
  if (!Number.isFinite(clearedAtMs) || !Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new Error("invalid acknowledgment catch-up deadline");
  }
  const deadlineAtMs = clearedAtMs + deadlineSeconds * 1000;
  let result;
  while (!result) {
    let rows;
    if (options.readRows) rows = await options.readRows();
    else {
      const databasePath = findEventsDatabase(home);
      if (databasePath) rows = await readAllDeliveryRows(databasePath);
    }
    const observedAtMs = now();
    const observedAt = new Date(observedAtMs).toISOString();
    const seconds = (observedAtMs - clearedAtMs) / 1000;
    const complete = rows !== undefined && rows.every((row) => isAcknowledgedRow(row) && Boolean(row.remote_pruned_at));
    result = complete && observedAtMs <= deadlineAtMs
      ? { phase, verdict: "pass", clearedAt, observedAt, seconds, remaining: 0 }
      : observedAtMs >= deadlineAtMs
        ? { phase, verdict: "fail", clearedAt, observedAt, seconds, remaining: null }
        : undefined;
    if (!result) await delay(Math.min(1000, deadlineAtMs - observedAtMs));
  }
  writeFileSync(join(evidenceDirectory, `${phase}-catch-up.json`), `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  return result;
}

export async function startForegroundDaemon({
  entrypoint,
  environment,
  cwd,
  daemonArguments,
  spawnProcess = spawn,
  healthProbe,
  readinessTimeoutMs = 60_000,
  delay = (milliseconds, options) => sleep(milliseconds, undefined, options),
}) {
  const child = spawnProcess(process.execPath, daemonArguments ?? [entrypoint, "daemon", "start", "--foreground"], {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const append = (target, chunk) => {
    target.push(Buffer.from(chunk));
    while (Buffer.concat(target).length > 64 * 1024) target.shift();
  };
  child.stdout?.on("data", (chunk) => append(stdout, chunk));
  child.stderr?.on("data", (chunk) => append(stderr, chunk));
  let exitState;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { exitState = { error }; resolve(exitState); });
    child.once("exit", (code, signal) => { exitState = { code, signal }; resolve(exitState); });
  });
  const output = () => [Buffer.concat(stderr).toString("utf8"), Buffer.concat(stdout).toString("utf8")]
    .map((value) => value.trim()).filter(Boolean).join("\n");
  const assertRunning = () => {
    if (exitState) throw new Error(`foreground daemon exited unexpectedly${output() ? `: ${output()}` : ""}`, { cause: exitState.error });
  };
  const probe = healthProbe ?? (() => execFileAsync(process.execPath, [entrypoint, "status", "--json"], {
    cwd, env: environment, timeout: 5_000,
  }));
  const readinessController = new AbortController();
  const readinessDeadline = Date.now() + readinessTimeoutMs;
  const readinessError = Object.assign(new Error("foreground daemon readiness deadline exceeded"), {
    code: "ReadinessDeadlineExceeded",
  });
  const readinessTimer = setTimeout(() => readinessController.abort(readinessError), readinessTimeoutMs);
  try {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (exitState) throw new Error(`foreground daemon exited before readiness${output() ? `: ${output()}` : ""}`, { cause: exitState.error });
      if (readinessController.signal.aborted) break;
      const timeoutMs = Math.max(1, readinessDeadline - Date.now());
      try {
        await probe({ signal: readinessController.signal, timeoutMs });
        await delay(Math.min(100, Math.max(1, readinessDeadline - Date.now())), { signal: readinessController.signal });
        assertRunning();
        clearTimeout(readinessTimer);
        let stopping;
        return {
          assertRunning,
          stop() {
            stopping ??= (async () => {
              if (exitState) return;
              child.kill("SIGTERM");
              let timeout;
              await Promise.race([
                exited,
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("foreground daemon did not stop")), 10_000); }),
              ]).finally(() => clearTimeout(timeout));
            })();
            return stopping;
          },
        };
      } catch {
        if (readinessController.signal.aborted) break;
        try {
          await delay(Math.min(250, Math.max(1, readinessDeadline - Date.now())), { signal: readinessController.signal });
        } catch {
          if (readinessController.signal.aborted) break;
        }
      }
    }
  } finally {
    clearTimeout(readinessTimer);
  }
  if (!exitState) child.kill("SIGTERM");
  let killTimeout;
  await Promise.race([exited, new Promise((resolve) => { killTimeout = setTimeout(resolve, 10_000); })])
    .finally(() => clearTimeout(killTimeout));
  throw new Error(`foreground daemon did not become ready${output() ? `: ${output()}` : ""}`, {
    cause: readinessController.signal.aborted ? readinessError : undefined,
  });
}

export async function captureDoctorEvidence(run) {
  try {
    const result = await run();
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    if (typeof error?.stdout !== "string" || error.stdout.length === 0) throw error;
    return { stdout: error.stdout, exitCode: Number.isInteger(error.code) ? error.code : 1 };
  }
}

export async function runPublicMigrationFlow(runStep, options = {}) {
  const steps = [];
  const invoke = async (name, args) => {
    const envelope = await runStep(args);
    if (envelope?.outcome !== "ok") {
      const reason = envelope?.refusal?.reason ?? "unknown-refusal";
      const next = envelope?.next ?? "none";
      const evidence = JSON.stringify(envelope?.evidence ?? {});
      throw new Error(`certification migration ${name} refused: reason=${reason} next=${next} evidence=${evidence}`);
    }
    steps.push({ name, args, envelope });
    return envelope;
  };
  const plan = await invoke("plan", ["plan"]);
  const generation = plan.generation;
  if (typeof generation !== "string" || generation.length === 0) {
    throw new Error("certification migration plan omitted its generation");
  }
  await invoke("apply", ["apply", "--confirm-generation", generation]);
  await invoke("verify", ["verify", "--generation", generation, "--confirm-generation", generation]);
  await options.beforeActivate?.(steps);
  await invoke("activate", ["activate", "--generation", generation, "--confirm-generation", generation, "--confirm-backend", "postgresql"]);
  return steps;
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
  const configDirectory = join(environment.HOME, ".lcm");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDirectory, "config.json"), `${JSON.stringify(machineStoredConfig(environment), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const [projectModule, runtimePaths, projectMapModule, maintenance] = await Promise.all([
    import(pathToFileURL("/opt/lcm/dist/src/daemon/project.js").href),
    import(pathToFileURL("/opt/lcm/dist/src/runtime-paths.js").href),
    import(pathToFileURL("/opt/lcm/dist/src/project-map.js").href),
    import(pathToFileURL("/opt/lcm/dist/src/migration/maintenance.js").href),
  ]);
  const localProject = projectModule.localProjectIdentity(project, environment.HOME);
  const projectDirectory = join(runtimePaths.projectsDir(environment.HOME), localProject.id);
  mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDirectory, "meta.json"), `${JSON.stringify({ cwd: project })}\n`, { mode: 0o600, flag: "wx" });
  mkdirSync(join(environment.HOME, ".lcm", "events"), { recursive: true, mode: 0o700 });
  projectMapModule.clearProjectMapCache();
  const { prepareSqliteMigrationEnrollment } = maintenance;
  await prepareSqliteMigrationEnrollment({
    cwd: project,
    homeDir: environment.HOME,
    displayName: name,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: environment.LCM_POSTGRES_URL,
        caFile: environment.LCM_POSTGRES_CA_FILE,
        migrationRole: environment.LCM_CERT_MIGRATION_ROLE,
        poolMax: 2,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        snapshotIdleTimeoutMs: 300_000,
      },
    },
  });
  await waitForControl(join(evidenceDirectory, "migration-start.json"), {
    deadlineMs: Date.now() + contract.timeline.full.setupMaxSeconds * 1000,
  });
  const migrationSteps = await runPublicMigrationFlow(async (args) => {
    try {
      const result = await execFileAsync(process.execPath, [lcm, "migration", ...args, "--json"], { cwd: project, env: environment, timeout: 120_000 });
      return JSON.parse(result.stdout);
    } catch (error) {
      if (typeof error?.stdout !== "string" || error.stdout.length === 0) throw error;
      return JSON.parse(error.stdout);
    }
  }, {
    beforeActivate: async (steps) => {
      writeFileSync(join(evidenceDirectory, "verification-receipt.json"), `${JSON.stringify({
        machine,
        at: new Date().toISOString(),
        steps,
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await waitForControl(join(evidenceDirectory, "activation-start.json"), {
        deadlineMs: Date.now() + contract.timeline.full.setupMaxSeconds * 1000,
      });
    },
  });
  writeFileSync(join(evidenceDirectory, "activation-receipt.json"), `${JSON.stringify({
    machine,
    at: new Date().toISOString(),
    steps: migrationSteps,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await waitForControl(join(evidenceDirectory, "runtime-ready.json"), {
    deadlineMs: Date.now() + contract.timeline.full.setupMaxSeconds * 1000,
  });
  environment.LCM_POSTGRES_URL = environment.LCM_POSTGRES_RUNTIME_URL;
  const tlsReadiness = {
    wrongCa: await requireTlsRejection(lcm, environment, environment.LCM_POSTGRES_URL, environment.LCM_CERT_WRONG_CA_FILE, "certificate-authority", project),
    wrongHostname: await requireTlsRejection(lcm, environment, environment.LCM_CERT_WRONG_HOST_URL, environment.LCM_POSTGRES_CA_FILE, "certificate-name", project),
  };
  const identity = await execFileAsync(process.execPath, [lcm, "machine", "show", "--json"], { cwd: project, env: environment, timeout: 60_000 });
  writeFileSync(join(evidenceDirectory, "identity.json"), identity.stdout, { mode: 0o600, flag: "wx" });
  const { DaemonClient } = await import(pathToFileURL("/opt/lcm/dist/src/daemon/client.js").href);
  const daemonTokenPath = join(configDirectory, "daemon.token");
  // Start the daemon through the packaged entrypoint itself. The daemon publishes
  // process.argv[1] as its entrypoint identity, and the CLI (compact, doctor)
  // authenticates a running daemon only when that identity is the packaged
  // /opt/lcm/dist/lcm.mjs; a wrapper script would make it unauthenticated.
  const daemon = await startForegroundDaemon({
    entrypoint: lcm,
    environment,
    cwd: project,
    healthProbe: async ({ signal, timeoutMs }) => {
      if (!await new DaemonClient("http://127.0.0.1:3737", daemonTokenPath).health({ signal, timeoutMs })) throw new Error("foreground daemon is not healthy");
    },
  });
  const daemonClient = new DaemonClient("http://127.0.0.1:3737", daemonTokenPath);
  try {
  writeFileSync(join(evidenceDirectory, "daemon-started.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  const doctor = await captureDoctorEvidence(() => execFileAsync(process.execPath, [lcm, "doctor", "--verbose"], { cwd: project, env: environment, timeout: 60_000 }));
  await runWithDeadline(60_000, undefined, (options) =>
    daemonClient.post("/store", { cwd: project, text: "certification readiness", tags: ["type:solution", "scope:project"], metadata: {} }, options));
  await runWithDeadline(60_000, undefined, (options) =>
    daemonClient.post("/search", { cwd: project, query: "certification readiness", limit: 5, layers: [], tags: [] }, options));
  writeFileSync(join(evidenceDirectory, "readiness.json"), `${JSON.stringify({
    machine,
    migrationSteps,
    tls: tlsReadiness,
    doctorExitCode: doctor.exitCode,
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
    await executeDeterministicSchedule({ schedule: warmup, scheduleStartWallMs: Date.parse(warmupControl.warmupStartAt), entrypoint: lcm, cwd: project, environment, daemonClient, evidenceDirectory });
    writeFileSync(join(evidenceDirectory, "warmup-complete.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    const control = await waitForControl(join(evidenceDirectory, "phase-control.json"), {
      deadlineMs: Date.now() + 120_000,
    });
    await executeDeterministicSchedule({ schedule, scheduleStartWallMs: Date.parse(control.steadyT0At), entrypoint: lcm, cwd: project, environment, daemonClient, evidenceDirectory });
    writeFileSync(join(evidenceDirectory, "steady-complete.json"), `${JSON.stringify({ machine, at: new Date().toISOString(), steadyT0At: control.steadyT0At })}\n`, { mode: 0o600, flag: "wx" });
    const settleUntil = Date.parse(control.steadyT0At) + timeline.steadySeconds * 1000 + (timeline.pendingSettleMaxSeconds ?? 0) * 1000;
    if (Date.now() < settleUntil) await new Promise((resolve) => setTimeout(resolve, settleUntil - Date.now()));
    writeFileSync(join(evidenceDirectory, "fault-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    if (profile === "full") {
      const partitionSchedule = createFaultSchedule({
        machine, runId: environment.LCM_CERT_RUN_ID, phase: "partition-recovery",
        durationSeconds: contract.thresholds.recovery.partition.rtoSeconds,
      });
      await executeDeterministicSchedule({ schedule: partitionSchedule, entrypoint: lcm, cwd: project, environment, daemonClient, evidenceDirectory });
      const partitionClearance = await waitForControl(join(evidenceDirectory, "partition-cleared.json"), {
        deadlineMs: Date.now() + timeline.partitionPhaseMaxSeconds * 1000,
      });
      const partitionCatchUp = await waitForAcknowledgmentCatchUp(
        environment.HOME, evidenceDirectory, "partition", partitionClearance.clearedAt,
        contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds,
      );
      if (partitionCatchUp.verdict !== "pass") throw new Error("partition acknowledgment catch-up failed");
      writeFileSync(join(evidenceDirectory, "partition-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      if (environment.LCM_CERT_LANE === "local") {
        writeFileSync(join(evidenceDirectory, "restart-ready.json"), `${JSON.stringify({ machine, at: new Date().toISOString(), priorCatchUp: partitionCatchUp.verdict })}\n`, { mode: 0o600, flag: "wx" });
        const restartSchedule = createFaultSchedule({
          machine, runId: environment.LCM_CERT_RUN_ID, phase: "restart-recovery",
          durationSeconds: contract.thresholds.recovery.restartDatabase.rtoSeconds,
        });
        await executeDeterministicSchedule({ schedule: restartSchedule, entrypoint: lcm, cwd: project, environment, daemonClient, evidenceDirectory });
        const restartClearance = await waitForControl(join(evidenceDirectory, "restart-cleared.json"), {
          deadlineMs: Date.now() + timeline.restartPhaseMaxSeconds * 1000,
        });
        const restartCatchUp = await waitForAcknowledgmentCatchUp(
          environment.HOME, evidenceDirectory, "restart", restartClearance.clearedAt,
          contract.thresholds.recovery.acknowledgmentCatchUpAfterClearedSeconds,
        );
        if (restartCatchUp.verdict !== "pass") throw new Error("restart acknowledgment catch-up failed");
        writeFileSync(join(evidenceDirectory, "restart-recovered.json"), `${JSON.stringify({ machine, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      }
    }
    const drainSeconds = environment.LCM_CERT_PROFILE === "full" ? 900 : 660;
    await new Promise((resolve) => setTimeout(resolve, drainSeconds * 1000));
  } catch (error) {
    daemon.assertRunning();
    throw error;
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
  const finalDoctor = await captureDoctorEvidence(() => execFileAsync(process.execPath, [lcm, "doctor", "--verbose"], { cwd: project, env: environment, timeout: 60_000 }));
  writeFileSync(join(evidenceDirectory, "final-diagnostics.json"), `${JSON.stringify({
    doctorSha256: createHash("sha256").update(finalDoctor.stdout).digest("hex"),
    doctor: finalDoctor.stdout,
    doctorExitCode: finalDoctor.exitCode,
    sweepTimestamps,
  })}\n`, { mode: 0o600, flag: "wx" });
  await waitForControl(join(evidenceDirectory, "clock-finished.json"), { deadlineMs: Date.now() + 120_000 });
  } finally {
    await daemon.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMachineAgent().catch((error) => {
    const diagnostics = [];
    const seen = new Set();
    for (let current = error; current && !seen.has(current); current = current.cause) {
      seen.add(current);
      diagnostics.push(String(current?.stack ?? current));
    }
    process.stderr.write(`machine agent failed: ${diagnostics.join("\nCaused by: ")}\n`);
    process.exitCode = 1;
  });
}
