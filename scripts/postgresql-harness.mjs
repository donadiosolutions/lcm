#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  NODE_IMAGE,
  POSTGRES_IMAGE,
} from "./postgresql-images.mjs";
import {
  POSTGRES_TEMPLATE_MARKER,
  validatePostgreSqlTemplateArchive,
} from "./ci-environment.mjs";
import {
  canonicalCandidateParents,
  candidateTemporaryParents,
  createTestTempDirectory,
  nonLivePlatformFallbackParents,
  parseOriginalTemporaryParents,
} from "./test-temp-root.mjs";

export { NODE_IMAGE, POSTGRES_IMAGE };
export const RUN_LABEL = "com.donadiosolutions.lcm.postgresql-test-run";
export const OWNER_SCHEMA_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-schema";
export const OWNER_PID_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-pid";
export const OWNER_BIRTH_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-birth";
export const OWNER_SCOPE_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-scope";
export const RESOURCE_KIND_LABEL = "com.donadiosolutions.lcm.postgresql-test-resource-kind";
export const OWNER_SCHEMA_VERSION = "2";
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
export const MAX_DOCKER_REMOVE_ATTEMPTS = 3;
export const ORPHAN_WORKER_STABILITY_DELAY_MS = 250;
export const HARNESS_CLEANUP_RETRY_DELAYS_MS = Object.freeze([
  250,
  500,
  750,
  1_000,
]);
export const DEFAULT_SIGNAL_PROBE_READINESS_TIMEOUT_MS = 90_000;
export const MIN_SIGNAL_PROBE_READINESS_TIMEOUT_MS = 1_000;
export const MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS = 300_000;
export const HARNESS_ALLOCATION_MARKER = "PostgreSQL harness allocated run:";
export const MAX_HARNESS_ALLOCATION_MARKER_LINE_LENGTH =
  HARNESS_ALLOCATION_MARKER.length + 1 + 32;
export const SIGNAL_CLEANUP_FAILURE_MARKER = "PostgreSQL harness cleanup failed:";
export const SIGNAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS = 5_000;

export const CONTAINER_CLI_VARIABLE = "LCM_TEST_CONTAINER_CLI";
const CONTAINER_FLAVOURS = Object.freeze(["docker", "podman"]);

/**
 * Select the container engine CLI once per harness run. Unset selects Docker;
 * otherwise only "docker", "podman" or an absolute path to one of them is valid.
 * A Windows ".exe" suffix on the path's basename is ignored, case-insensitively.
 */
export function resolveContainerEngine(environment = process.env) {
  const configured = environment[CONTAINER_CLI_VARIABLE];
  if (configured === undefined) return { cli: "docker", flavour: "docker" };
  if (typeof configured === "string" && !configured.includes("\0")) {
    if (CONTAINER_FLAVOURS.includes(configured)) return { cli: configured, flavour: configured };
    if (isAbsolute(configured)) {
      const executable = basename(configured);
      const flavour = /\.exe$/iu.test(executable) ? executable.slice(0, -4).toLowerCase() : executable;
      if (CONTAINER_FLAVOURS.includes(flavour)) return { cli: configured, flavour };
    }
  }
  throw new Error(
    `${CONTAINER_CLI_VARIABLE} must be "docker", "podman", or an absolute path to a docker or podman executable`,
  );
}

/** Reject Podman configurations the local harness cannot run safely, before any side effect. */
export function assertContainerEngineSupported(engine, ci, environment = process.env) {
  if (engine.flavour !== "podman") return;
  if (ci) {
    throw new Error(
      "the Podman PostgreSQL harness supports only local mode; run it without GITHUB_ACTIONS",
    );
  }
  if (String(environment.LCM_POSTGRES_TEMPLATE_ARCHIVE ?? "").trim().length > 0) {
    throw new Error(
      "the Podman PostgreSQL harness does not support LCM_POSTGRES_TEMPLATE_ARCHIVE; unset it",
    );
  }
}

export function createContainerRunner(cli) {
  return (args, options) => runProcess(cli, args, options);
}

export function resolveSignalProbeReadinessTimeout(environment = process.env) {
  const configured = environment.LCM_TEST_POSTGRES_SIGNAL_READY_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_SIGNAL_PROBE_READINESS_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new Error("invalid PostgreSQL signal probe readiness timeout");
  }
  const milliseconds = Number(configured);
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < MIN_SIGNAL_PROBE_READINESS_TIMEOUT_MS
    || milliseconds > MAX_SIGNAL_PROBE_READINESS_TIMEOUT_MS
  ) {
    throw new Error("invalid PostgreSQL signal probe readiness timeout");
  }
  return milliseconds;
}

export function signalCleanupFailed(output) {
  return String(output).includes(SIGNAL_CLEANUP_FAILURE_MARKER);
}

export function createSignalCleanupDiagnosticParser() {
  const marker = Buffer.from(SIGNAL_CLEANUP_FAILURE_MARKER);
  const captured = Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES);
  let markerTail = Buffer.alloc(0);
  let capturedBytes = 0;
  let markerFound = false;
  const append = (bytes) => {
    const length = Math.min(bytes.length, captured.length - capturedBytes);
    if (length > 0) {
      bytes.copy(captured, capturedBytes, 0, length);
      capturedBytes += length;
    }
  };
  return {
    write(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (markerFound) {
        append(bytes);
        return;
      }
      const searchable = markerTail.length === 0
        ? bytes
        : Buffer.concat([markerTail, bytes]);
      const markerIndex = searchable.indexOf(marker);
      if (markerIndex >= 0) {
        markerFound = true;
        markerTail = Buffer.alloc(0);
        append(searchable.subarray(markerIndex));
        return;
      }
      const retainedBytes = Math.min(marker.length - 1, searchable.length);
      markerTail = Buffer.from(searchable.subarray(searchable.length - retainedBytes));
    },
    diagnostic() {
      if (!markerFound) return undefined;
      return captured.subarray(0, capturedBytes).toString("utf8").replace(/\r?\n$/u, "");
    },
    retainedByteCount() {
      return markerTail.length + capturedBytes;
    },
  };
}

export function writeHarnessDiagnostic(message, dependencies = {}) {
  const stream = dependencies.stream ?? process.stderr;
  const scheduleTimeout = dependencies.scheduleTimeout ?? setTimeout;
  const cancelTimeout = dependencies.cancelTimeout ?? clearTimeout;
  const timeoutMs = dependencies.timeoutMs ?? SIGNAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const onError = () => settle();
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) cancelTimeout(timer);
      stream.removeListener?.("error", onError);
      resolve();
    };
    stream.once?.("error", onError);
    try {
      stream.write(message, (error) => {
        if (!error) settle();
      });
    } catch {
      settle();
    }
    if (!settled) timer = scheduleTimeout(settle, timeoutMs);
  });
}

export async function completeSignalExit(signal, teardown, dependencies = {}) {
  try {
    await teardown();
  } catch {
    // Cleanup failure was reported and flushed by teardown before conventional exit.
  }
  dependencies.removeSignalHandlers?.();
  const exit = dependencies.exit ?? process.exit;
  exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
}

export function createSingleFlightOperation(operation) {
  let operationPromise;
  return () => {
    operationPromise ??= operation();
    return operationPromise;
  };
}

export function createHarnessAllocationMarkerParser(runIds) {
  const prefix = `${HARNESS_ALLOCATION_MARKER} `;
  let line = "";
  let discardingLine = false;
  const finishLine = () => {
    if (!discardingLine && line.startsWith(prefix)) {
      const runId = line.slice(prefix.length);
      if (/^[0-9a-f]{32}$/u.test(runId)) runIds.add(runId);
    }
    line = "";
    discardingLine = false;
  };
  return {
    write(chunk) {
      for (const character of String(chunk)) {
        if (character === "\n") {
          finishLine();
        } else if (!discardingLine) {
          if (
            line.length + character.length
            > MAX_HARNESS_ALLOCATION_MARKER_LINE_LENGTH
          ) {
            line = "";
            discardingLine = true;
          } else {
            line += character;
          }
        }
      }
    },
    end() {
      if (line || discardingLine) finishLine();
    },
    retainedCharacterCount() {
      return line.length;
    },
  };
}

export async function auditHarnessRunResources(runIds, dockerRunner = docker) {
  const failures = [];
  const queries = [
    ["container", ["ps", "--all", "--quiet"]],
    ["network", ["network", "ls", "--quiet"]],
    ["volume", ["volume", "ls", "--quiet"]],
  ];
  for (const runId of runIds) {
    if (!/^[0-9a-f]{32}$/u.test(runId)) {
      failures.push(new Error("PostgreSQL signal resource audit received an invalid run ID"));
      continue;
    }
    for (const [resourceClass, args] of queries) {
      try {
        const { stdout } = await dockerRunner([
          ...args,
          "--filter",
          `label=${RUN_LABEL}=${runId}`,
        ]);
        if (String(stdout).trim()) {
          failures.push(new Error(
            `PostgreSQL signal resource audit found leaked ${resourceClass} resources for run ${runId}`,
          ));
        }
      } catch {
        failures.push(new Error(
          `PostgreSQL signal resource audit could not query ${resourceClass} resources for run ${runId}`,
        ));
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "PostgreSQL signal resource audit failed");
  }
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const initScript = join(repositoryRoot, "test", "postgresql", "init.sh");
const cachedRunInitScript = join(repositoryRoot, "test", "postgresql", "cached-run-init.sh");
const bootIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const bootIdRegex = new RegExp(`^${bootIdPattern}$`, "u");
const linuxBirthRegex = new RegExp(`^linux:(${bootIdPattern}):([1-9][0-9]*)$`, "u");
const darwinDayPattern = "(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)";
const darwinMonthPattern = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const dateDayPattern = "(?:0[1-9]|[12][0-9]|3[01])";
const darwinBirthRegex = new RegExp(
  `^darwin:(${darwinDayPattern}) (${darwinMonthPattern}) ( [1-9]|[12][0-9]|3[01])`
  + ` ((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9]) ([1-9][0-9]{3})$`,
  "u",
);
const windowsBirthRegex = new RegExp(
  `^win32:([1-9][0-9]{3})-(0[1-9]|1[0-2])-(${dateDayPattern})`
  + `T((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9])\\.[0-9]{7}Z$`,
  "u",
);
const linuxScopeRegex = new RegExp(
  `^linux:([0-9a-f]{64}):(${bootIdPattern}):pid:\\[([1-9][0-9]*)\\]$`,
  "u",
);
const portableScopeRegex = /^(?:darwin|win32):[0-9a-f]{64}$/u;
const consumerOwnerFile = "consumer-owner.json";
const darwinMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const darwinDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function validUtcCalendar(year, month, day, hour, minute, second, expectedWeekday) {
  const observed = new Date(0);
  observed.setUTCFullYear(year, month, day);
  observed.setUTCHours(hour, minute, second, 0);
  return observed.getUTCFullYear() === year
    && observed.getUTCMonth() === month
    && observed.getUTCDate() === day
    && observed.getUTCHours() === hour
    && observed.getUTCMinutes() === minute
    && observed.getUTCSeconds() === second
    && (expectedWeekday === undefined || observed.getUTCDay() === expectedWeekday);
}

export function isValidProcessBirthFingerprint(fingerprint) {
  if (typeof fingerprint !== "string") return false;
  if (linuxBirthRegex.test(fingerprint)) return true;
  const darwinMatch = fingerprint.match(darwinBirthRegex);
  if (darwinMatch) {
    return validUtcCalendar(
      Number(darwinMatch[7]),
      darwinMonths.indexOf(darwinMatch[2]),
      Number(darwinMatch[3]),
      Number(darwinMatch[4]),
      Number(darwinMatch[5]),
      Number(darwinMatch[6]),
      darwinDays.indexOf(darwinMatch[1]),
    );
  }
  const windowsMatch = fingerprint.match(windowsBirthRegex);
  return Boolean(windowsMatch && validUtcCalendar(
    Number(windowsMatch[1]),
    Number(windowsMatch[2]) - 1,
    Number(windowsMatch[3]),
    Number(windowsMatch[4]),
    Number(windowsMatch[5]),
    Number(windowsMatch[6]),
  ));
}

export function processIdentityEvidenceConsistent(birth, scope) {
  const birthPlatform = typeof birth === "string" ? birth.split(":", 1)[0] : undefined;
  const scopePlatform = typeof scope === "string" ? scope.split(":", 1)[0] : undefined;
  if (!birthPlatform || birthPlatform !== scopePlatform) return false;
  if (birthPlatform !== "linux") return birthPlatform === "darwin" || birthPlatform === "win32";
  const birthMatch = birth.match(linuxBirthRegex);
  const scopeMatch = scope.match(linuxScopeRegex);
  return Boolean(birthMatch && scopeMatch && birthMatch[1] === scopeMatch[2]);
}

function hashedIdentity(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readOwnerScopeFingerprint(dependencies = {}) {
  const currentPlatform = dependencies.platform?.() ?? platform();
  const readFile = dependencies.readFile ?? readFileSync;
  const execute = dependencies.execFile ?? execFileSync;
  if (currentPlatform === "linux") {
    const readLink = dependencies.readLink ?? readlinkSync;
    const machineId = String(readFile("/etc/machine-id", "utf8")).trim();
    const bootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const pidNamespace = String(readLink("/proc/self/ns/pid")).trim();
    if (!/^[0-9a-f]{32}$/u.test(machineId)
      || !bootIdRegex.test(bootId)
      || !/^pid:\[[1-9][0-9]*\]$/u.test(pidNamespace)) {
      throw new Error("unsupported PostgreSQL harness process scope evidence");
    }
    return `linux:${hashedIdentity(machineId)}:${bootId}:${pidNamespace}`;
  }
  if (currentPlatform !== "darwin" && currentPlatform !== "win32") {
    throw new Error("unsupported PostgreSQL harness process scope platform");
  }
  const command = currentPlatform === "win32" ? "powershell.exe" : "sysctl";
  const args = currentPlatform === "win32"
    ? [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
    ]
    : ["-n", "kern.hostuuid"];
  let machineId;
  try {
    machineId = String(execute(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 2_000,
      windowsHide: true,
    })).trim().toLowerCase();
  } catch (error) {
    throw new Error("unsupported PostgreSQL harness process scope evidence", { cause: error });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(machineId)) {
    throw new Error("unsupported PostgreSQL harness process scope evidence");
  }
  return `${currentPlatform}:${hashedIdentity(machineId)}`;
}

export function createRunNames(runId) {
  const short = runId.slice(0, 20);
  return {
    container: `lcm-pg-${short}`,
    network: `lcm-pg-net-${short}`,
    volume: `lcm-pg-data-${short}`,
    restore: `lcm-pg-restore-${short}`,
    runner: `lcm-pg-runner-${short}`,
    alias: `lcm-pg-${short}.test`,
    wrongAlias: `lcm-pg-wrong-${short}.test`,
    controlDatabase: `lcm_harness_${short}`,
  };
}

const resourceSpecs = [
  { type: "container", key: "restore", kind: "restore" },
  { type: "container", key: "runner", kind: "runner" },
  { type: "container", key: "container", kind: "database" },
  { type: "volume", key: "volume", kind: "data" },
  { type: "network", key: "network", kind: "network" },
];

function resourceSpec(type, name, runId) {
  const names = createRunNames(runId);
  return resourceSpecs.find((candidate) => candidate.type === type && names[candidate.key] === name);
}

export function readProcessBirthFingerprint(pid, dependencies = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid PostgreSQL harness owner PID");
  const readFile = dependencies.readFile ?? readFileSync;
  const currentPlatform = dependencies.platform?.() ?? platform();
  if (currentPlatform === "linux") {
    let bootId;
    try {
      bootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    } catch (error) {
      throw new Error("unsupported PostgreSQL harness boot identity evidence", { cause: error });
    }
    let stat;
    try {
      stat = String(readFile(`/proc/${pid}/stat`, "utf8")).trim();
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw Object.assign(new Error("PostgreSQL harness owner PID is absent"), { code: "ESRCH" });
      }
      throw new Error("unsupported PostgreSQL harness process identity evidence", { cause: error });
    }
    const closingParenthesis = stat.lastIndexOf(")");
    if (!bootIdRegex.test(bootId) || closingParenthesis < 1) {
      throw new Error("unsupported PostgreSQL harness process identity evidence");
    }
    const fieldsAfterCommand = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    if (!/^[1-9][0-9]*$/u.test(startTime ?? "")) {
      throw new Error("unsupported PostgreSQL harness process identity evidence");
    }
    return `linux:${bootId}:${startTime}`;
  }
  const execute = dependencies.execFile ?? execFileSync;
  const command = currentPlatform === "win32" ? "powershell.exe" : "ps";
  const args = currentPlatform === "win32"
    ? [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('O')`,
    ]
    : ["-o", "lstart=", "-p", String(pid)];
  let observed;
  try {
    observed = String(execute(command, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
      maxBuffer: 16 * 1024,
      timeout: 2_000,
      windowsHide: true,
    })).trim();
  } catch (error) {
    throw new Error("unsupported PostgreSQL harness process identity evidence", { cause: error });
  }
  const fingerprint = `${currentPlatform}:${observed}`;
  if (!observed || !isValidProcessBirthFingerprint(fingerprint)) {
    throw new Error("unsupported PostgreSQL harness process identity evidence");
  }
  return fingerprint;
}

export function createOwnerIdentity(pid = process.pid, dependencies = {}) {
  return {
    pid,
    birth: readProcessBirthFingerprint(pid, dependencies),
    scope: readOwnerScopeFingerprint(dependencies),
  };
}

export function recordConsumerIdentity(path, pid, dependencies = {}) {
  const createIdentity = dependencies.createIdentity ?? createOwnerIdentity;
  let record;
  try {
    record = { version: 1, ...createIdentity(pid) };
  } catch {
    return recordAmbiguousConsumerIdentity(path, dependencies);
  }
  const writeFile = dependencies.writeFile ?? writeFileSync;
  writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function recordAmbiguousConsumerIdentity(path, dependencies = {}) {
  const writeFile = dependencies.writeFile ?? writeFileSync;
  const record = { version: 1, ambiguous: true };
  writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function ownershipLabels(runId, kind, owner) {
  return {
    [RUN_LABEL]: runId,
    [OWNER_SCHEMA_LABEL]: OWNER_SCHEMA_VERSION,
    [OWNER_PID_LABEL]: String(owner.pid),
    [OWNER_BIRTH_LABEL]: owner.birth,
    [OWNER_SCOPE_LABEL]: owner.scope,
    [RESOURCE_KIND_LABEL]: kind,
  };
}

function dockerLabelArgs(labels) {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

export function validateRunNames(names, runId) {
  if (!/^[0-9a-f]{32}$/u.test(runId)) throw new Error("invalid PostgreSQL harness run ID");
  const expected = createRunNames(runId);
  for (const key of Object.keys(expected)) {
    if (names[key] !== expected[key]) throw new Error(`invalid PostgreSQL harness ${key}`);
  }
}

export function resolveConfiguredTemplateArchive(configuredPath, dependencies = {}) {
  const candidate = String(configuredPath ?? "").trim();
  if (!candidate) return "";
  const resolveRealpath = dependencies.realpath ?? realpathSync;
  const inspectPath = dependencies.stat ?? statSync;
  let resolvedPath;
  try {
    resolvedPath = resolveRealpath(candidate);
  } catch (error) {
    throw new Error(`configured PostgreSQL template archive could not be resolved: ${candidate}`, {
      cause: error,
    });
  }
  let archiveStat;
  try {
    archiveStat = inspectPath(resolvedPath);
  } catch (error) {
    throw new Error(`configured PostgreSQL template archive could not be inspected: ${resolvedPath}`, {
      cause: error,
    });
  }
  if (!archiveStat.isFile()) {
    throw new Error(`configured PostgreSQL template archive is not a regular file: ${resolvedPath}`);
  }
  return resolvedPath;
}

export function sanitizeHarnessText(value, secrets) {
  let sanitized = String(value);
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized
    .replace(/postgresql:\/\/[^\s]+/giu, "postgresql://[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED PEM]");
}

const PEM_BEGIN_MARKER = "-----BEGIN ";
const PEM_END_MARKER = "-----END ";
const PEM_BEGIN_LINE = /-----BEGIN [^-]+-----/u;
const PEM_END_LINE = /-----END [^-]+-----/u;

// Redacts a child stream one complete line at a time, so every byte passes
// through secret, URL, and PEM redaction with full state before the bounded
// capture ring may discard any of it. A PEM block is dropped from its BEGIN line
// through its END line, also when the stream ends inside it. The unterminated
// trailing line is held in a buffer bounded by MAX_CAPTURED_OUTPUT_BYTES; a
// longer line is dropped and replaced by a marker, and a PEM BEGIN inside it
// keeps the following lines redacted until an END line. Returns undefined when
// a secret spans lines, which line-wise redaction cannot cover.
export function createStreamRedactor(secrets) {
  const needles = secrets.filter(Boolean);
  if (needles.some((secret) => String(secret).includes("\n"))) return undefined;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  let inPem = false;
  let droppedInPem = false;
  let droppedTail = "";
  const redactLine = (line) => {
    if (inPem) {
      if (PEM_END_LINE.test(line)) inPem = false;
      return undefined;
    }
    let redacted = line;
    for (const secret of needles) redacted = redacted.split(secret).join("[REDACTED]");
    redacted = redacted.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED PEM]");
    if (PEM_BEGIN_LINE.test(redacted)) {
      inPem = true;
      return "[REDACTED PEM]";
    }
    return redacted.replace(/postgresql:\/\/[^\s]+/giu, "postgresql://[REDACTED]");
  };
  const noteDropped = (text) => {
    const window = droppedTail + text;
    const begin = window.lastIndexOf(PEM_BEGIN_MARKER);
    const end = window.lastIndexOf(PEM_END_MARKER);
    if (begin >= 0 || end >= 0) droppedInPem = begin > end;
    droppedTail = window.slice(-(PEM_BEGIN_MARKER.length - 1));
  };
  const finishDropped = () => {
    if (droppedInPem) inPem = true;
    discarding = false;
    droppedInPem = false;
    droppedTail = "";
    return `[redacted: output line exceeded ${MAX_CAPTURED_OUTPUT_BYTES} bytes]`;
  };
  const consume = (text) => {
    let output = "";
    let start = 0;
    for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", start)) {
      const line = text.slice(start, newline);
      start = newline + 1;
      let emitted;
      if (discarding) {
        noteDropped(line);
        emitted = finishDropped();
      } else {
        emitted = redactLine(line);
      }
      if (emitted !== undefined) output += `${emitted}\n`;
    }
    const rest = text.slice(start);
    if (discarding || Buffer.byteLength(rest) > MAX_CAPTURED_OUTPUT_BYTES) {
      discarding = true;
      noteDropped(rest);
      pending = "";
    } else {
      pending = rest;
    }
    return output;
  };
  return {
    write(chunk) {
      return consume(pending + (typeof chunk === "string" ? chunk : decoder.write(chunk)));
    },
    end() {
      const text = pending + decoder.end();
      pending = "";
      if (discarding) {
        noteDropped(text);
        return finishDropped();
      }
      return text === "" ? "" : redactLine(text) ?? "";
    },
  };
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      detached: options.detached === true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      options.onSpawn?.(child);
    } catch (error) {
      try {
        child.kill();
      } catch {
        // Preserve the setup failure when the child exits before best-effort termination.
      }
      throw error;
    }
    const maxCapturedOutputBytes = MAX_CAPTURED_OUTPUT_BYTES;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    // Redaction precedes the ring, so a truncated tail never holds unredacted bytes.
    const stdoutRedactor = options.redactSecrets === undefined
      ? undefined
      : createStreamRedactor(options.redactSecrets);
    const stderrRedactor = options.redactSecrets === undefined
      ? undefined
      : createStreamRedactor(options.redactSecrets);
    const redacted = stdoutRedactor !== undefined;
    const appendTail = (current, chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (next.length >= maxCapturedOutputBytes) {
        return { value: next.subarray(-maxCapturedOutputBytes), truncated: current.length > 0 || next.length > maxCapturedOutputBytes };
      }
      if (current.length + next.length <= maxCapturedOutputBytes) {
        return { value: Buffer.concat([current, next]), truncated: false };
      }
      return {
        value: Buffer.concat([current.subarray(current.length + next.length - maxCapturedOutputBytes), next]),
        truncated: true,
      };
    };
    child.stdout?.on("data", (chunk) => {
      const appended = appendTail(stdout, stdoutRedactor ? stdoutRedactor.write(chunk) : chunk);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const appended = appendTail(stderr, stderrRedactor ? stderrRedactor.write(chunk) : chunk);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      operation();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) => settle(() => {
      if (redacted) {
        const flushedStdout = appendTail(stdout, stdoutRedactor.end());
        stdout = flushedStdout.value;
        stdoutTruncated ||= flushedStdout.truncated;
        const flushedStderr = appendTail(stderr, stderrRedactor.end());
        stderr = flushedStderr.value;
        stderrTruncated ||= flushedStderr.truncated;
      }
      const capturedStdout = stdout.toString("utf8");
      const capturedStderr = stderr.toString("utf8");
      if (code === 0) {
        resolve({
          stdout: capturedStdout.trim(),
          stderr: capturedStderr.trim(),
          stdoutTruncated,
          stderrTruncated,
          ...(redacted ? { redacted } : {}),
        });
      }
      else reject(Object.assign(new Error(`${command} failed`), {
        code,
        signal,
        stdout: capturedStdout,
        stderr: capturedStderr,
        stdoutTruncated,
        stderrTruncated,
        ...(redacted ? { redacted } : {}),
      }));
    }));
  });
}

// Bytes of redacted child output that a failed harness run reports when a
// stream exceeded the capture limit. Kept below half of the final diagnostic so
// the head of the combined harness diagnostic still holds all of it.
const CHILD_DIAGNOSTIC_EXCERPT_BYTES = 24 * 1024;

function utf8HeadEnd(bytes, end) {
  let boundary = end;
  while (boundary > 0 && (bytes[boundary] & 0xc0) === 0x80) boundary -= 1;
  return boundary;
}

function utf8TailStart(bytes, start) {
  let boundary = start;
  while (boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) boundary += 1;
  return boundary;
}

function utf8Tail(value, limit) {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  return bytes.subarray(utf8TailStart(bytes, bytes.length - limit)).toString("utf8");
}

// Bounds already sanitized text to `limit` bytes: a marker with the original
// size, the head, an elision line, and the tail, cut on code point boundaries.
export function boundedDiagnosticExcerpt(value, limit = MAX_CAPTURED_OUTPUT_BYTES) {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  const marker = (head, tail) => `[PostgreSQL harness diagnostic truncated: ${bytes.length} bytes, showing first ${head} and last ${tail}]\n`;
  const elision = "\n[... diagnostic output elided ...]\n";
  const available = limit - Buffer.byteLength(marker(limit, limit)) - Buffer.byteLength(elision);
  const headEnd = utf8HeadEnd(bytes, Math.floor(available / 2));
  const tailStart = utf8TailStart(bytes, bytes.length - (available - Math.floor(available / 2)));
  return marker(headEnd, bytes.length - tailStart)
    + bytes.subarray(0, headEnd).toString("utf8")
    + elision
    + bytes.subarray(tailStart).toString("utf8");
}

const capturedOutputFailures = new WeakSet();
const CAPTURE_LIMIT_MESSAGE = "PostgreSQL harness child output exceeded the safe capture limit";
const EXPANDED_LIMIT_MESSAGE = "PostgreSQL harness sanitized output exceeded the safe capture limit";

function capturedOutputFailure(error, output, streams) {
  const notice = `${output.limit}; showing the sanitized tail of each stream`;
  const sections = [["stdout", output.stdout], ["stderr", output.stderr]].filter(([, text]) => text !== "");
  const labelBytes = sections.reduce((total, [name]) => total + Buffer.byteLength(`\n[${name} tail]\n`), 0);
  const share = Math.floor(
    (CHILD_DIAGNOSTIC_EXCERPT_BYTES - Buffer.byteLength(notice) - labelBytes) / Math.max(sections.length, 1),
  );
  const diagnostic = [
    notice,
    ...sections.map(([name, text]) => `[${name} tail]\n${utf8Tail(text, share)}`),
  ].join("\n");
  streams.stderr.write(`${diagnostic}\n`);
  capturedOutputFailures.add(error);
  // The run still fails. The redacted excerpt travels in stderr, which harnessErrorDetails reads.
  return Object.assign(error, {
    stdout: "",
    stderr: diagnostic,
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: true,
  });
}

function sanitizedCapturedOutput(result, secrets) {
  const truncated = Boolean(result?.stdoutTruncated || result?.stderrTruncated);
  if (result?.redacted === true) {
    // The runner redacted each line before its ring could discard any byte.
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", limit: truncated ? CAPTURE_LIMIT_MESSAGE : undefined };
  }
  if (truncated) {
    // A raw truncated tail may begin inside a secret or PEM block; surface nothing.
    throw new Error(CAPTURE_LIMIT_MESSAGE);
  }
  const stdout = sanitizeHarnessText(result?.stdout ?? "", secrets);
  const stderr = sanitizeHarnessText(result?.stderr ?? "", secrets);
  const expanded = Buffer.byteLength(stdout) > MAX_CAPTURED_OUTPUT_BYTES
    || Buffer.byteLength(stderr) > MAX_CAPTURED_OUTPUT_BYTES;
  return { stdout, stderr, limit: expanded ? EXPANDED_LIMIT_MESSAGE : undefined };
}

function surfaceCapturedOutput(output, streams) {
  if (output.stdout) streams.stdout.write(`${output.stdout}\n`);
  if (output.stderr) streams.stderr.write(`${output.stderr}\n`);
}

export async function runSanitizedProcess(command, args, options = {}) {
  const {
    secrets = [],
    processRunner = runProcess,
    stdout = process.stdout,
    stderr = process.stderr,
    ...processOptions
  } = options;
  try {
    const result = await processRunner(command, args, { ...processOptions, redactSecrets: secrets });
    const output = sanitizedCapturedOutput(result, secrets);
    if (output.limit) throw capturedOutputFailure(new Error(output.limit), output, { stdout, stderr });
    surfaceCapturedOutput(output, { stdout, stderr });
    return { stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    if (capturedOutputFailures.has(error)) throw error;
    const output = sanitizedCapturedOutput(error, secrets);
    if (output.limit) throw capturedOutputFailure(error, output, { stdout, stderr });
    surfaceCapturedOutput(output, { stdout, stderr });
    if (error && typeof error === "object") Object.assign(error, { stdout: output.stdout, stderr: output.stderr });
    throw error;
  }
}

export function createProcessLifecycle(processRunner = runProcess, dependencies = {}) {
  const active = new Set();
  let stopping = false;
  const currentPlatform = dependencies.platform?.() ?? platform();
  const signalProcess = dependencies.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const terminateWindowsTree = dependencies.terminateWindowsTree ?? ((pid, force) => {
    execFileSync("taskkill.exe", [
      "/PID", String(pid), "/T", ...(force ? ["/F"] : []),
    ], { windowsHide: true, stdio: "ignore" });
  });
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const treeGraceAttempts = dependencies.treeGraceAttempts ?? 80;
  const treeKillAttempts = dependencies.treeKillAttempts ?? 80;

  const signalEntry = (entry, signal) => {
    if (!entry.processTree || !Number.isSafeInteger(entry.child?.pid) || entry.child.pid <= 0) {
      entry.child?.kill(signal);
      return;
    }
    if (currentPlatform === "win32") {
      terminateWindowsTree(entry.child.pid, signal === "SIGKILL");
      return;
    }
    signalProcess(-entry.child.pid, signal);
  };

  const processTreeAlive = dependencies.processTreeAlive ?? ((entry) => {
    if (currentPlatform === "win32") {
      return entry.child?.exitCode === null && entry.child?.signalCode === null;
    }
    try {
      signalProcess(-entry.child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });

  const waitForProcessTreeExit = async (entry, attempts) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!processTreeAlive(entry)) return true;
      await delay(25);
    }
    return !processTreeAlive(entry);
  };

  const terminateProcessTree = async (entry) => {
    try {
      signalEntry(entry, "SIGTERM");
    } catch {
      // Liveness verification below decides whether escalation is still needed.
    }
    if (await waitForProcessTreeExit(entry, treeGraceAttempts)) return;
    try {
      signalEntry(entry, "SIGKILL");
    } catch {
      // Liveness verification below remains authoritative.
    }
    if (!await waitForProcessTreeExit(entry, treeKillAttempts)) {
      throw new Error("PostgreSQL harness test process tree did not exit");
    }
  };

  const run = (command, args, options) => {
    if (stopping) return Promise.reject(new Error("PostgreSQL harness setup is stopping"));
    const entry = {
      operation: undefined,
      child: undefined,
      terminateOnStop: options?.terminateOnStop === true,
      processTree: options?.terminateProcessTree === true,
      escalation: undefined,
    };
    const processOptions = entry.terminateOnStop ? {
      ...options,
      detached: entry.processTree && currentPlatform !== "win32",
      onSpawn: (child) => {
        entry.child = child;
        options?.onSpawn?.(child);
      },
    } : options;
    let operation;
    try {
      operation = Promise.resolve(processRunner(command, args, processOptions));
    } catch (error) {
      operation = Promise.reject(error);
    }
    entry.operation = operation;
    active.add(entry);
    const remove = () => {
      if (entry.escalation) clearTimeout(entry.escalation);
      if (!entry.processTree || !entry.child || !processTreeAlive(entry)) {
        active.delete(entry);
      }
    };
    void operation.then(remove, remove);
    return operation;
  };

  const stop = async () => {
    stopping = true;
    const stoppingEntries = [...active];
    const treeTerminations = [];
    for (const entry of stoppingEntries) {
      if (!entry.terminateOnStop || !entry.child) continue;
      if (entry.processTree) {
        treeTerminations.push(terminateProcessTree(entry));
        continue;
      }
      try {
        signalEntry(entry, "SIGTERM");
      } catch {
        // The close/error event remains the authoritative settlement signal.
      }
      entry.escalation = setTimeout(() => {
        try {
          signalEntry(entry, "SIGKILL");
        } catch {
          // The child may have exited between settlement and escalation.
        }
      }, 2_000);
      entry.escalation.unref?.();
    }
    await Promise.all(treeTerminations);
    await Promise.allSettled(stoppingEntries.map((entry) => entry.operation));
    for (const entry of stoppingEntries) {
      if (entry.escalation) clearTimeout(entry.escalation);
      if (entry.processTree && entry.child && processTreeAlive(entry)) {
        throw new Error("PostgreSQL harness test process tree remained live after settlement");
      }
      active.delete(entry);
    }
  };

  return { run, stop };
}

async function docker(args, options) {
  return runProcess("docker", args, options);
}

async function writeTlsFixtures(directory, alias, processRunner = runProcess) {
  const extensionFile = join(directory, "server-ext.cnf");
  writeFileSync(extensionFile, [
    "basicConstraints=CA:FALSE",
    "keyUsage=digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=DNS:${alias},IP:127.0.0.1`,
    "",
  ].join("\n"), { mode: 0o600 });
  await processRunner("openssl", ["genrsa", "-out", join(directory, "ca.key"), "2048"]);
  await processRunner("openssl", [
    "req", "-x509", "-new", "-sha256", "-days", "2",
    "-key", join(directory, "ca.key"), "-subj", "/CN=LCM PostgreSQL Test CA",
    "-out", join(directory, "ca.crt"),
  ]);
  await processRunner("openssl", ["genrsa", "-out", join(directory, "server.key"), "2048"]);
  await processRunner("openssl", [
    "req", "-new", "-sha256", "-key", join(directory, "server.key"),
    "-subj", `/CN=${alias}`, "-out", join(directory, "server.csr"),
  ]);
  await processRunner("openssl", [
    "x509", "-req", "-sha256", "-days", "2", "-in", join(directory, "server.csr"),
    "-CA", join(directory, "ca.crt"), "-CAkey", join(directory, "ca.key"),
    "-CAcreateserial", "-extfile", extensionFile, "-out", join(directory, "server.crt"),
  ]);
  await processRunner("openssl", ["genrsa", "-out", join(directory, "wrong-ca.key"), "2048"]);
  await processRunner("openssl", [
    "req", "-x509", "-new", "-sha256", "-days", "2",
    "-key", join(directory, "wrong-ca.key"), "-subj", "/CN=LCM Wrong Test CA",
    "-out", join(directory, "wrong-ca.crt"),
  ]);
  chmodSync(join(directory, "server.key"), 0o600);
}

function generatedUrl(user, password, host, port, database) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

async function inspectDockerObject(type, name, dockerRunner = docker) {
  const result = await dockerRunner([type, "inspect", name]);
  return JSON.parse(result.stdout)[0];
}

/** Read ownership labels from an inspect record; Podman reports network labels in lowercase. */
export function inspectedLabels(type, record) {
  if (type === "container") return record?.Config?.Labels ?? {};
  if (type === "network") return record?.Labels ?? record?.labels ?? {};
  return record?.Labels ?? {};
}

export async function inspectLabels(type, name, dockerRunner = docker) {
  const record = await inspectDockerObject(type, name, dockerRunner);
  return inspectedLabels(type, record);
}

export function isMissingDockerObjectError(error, type, name) {
  if (typeof error?.code !== "number" || error.code === 0) return false;
  if (type !== "container" && type !== "network" && type !== "volume") return false;
  const lines = String(error?.stderr ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.pop();
  if (!diagnostic || lines.some((line) => !line.startsWith("WARNING:"))) return false;
  const message = diagnostic.startsWith("Error response from daemon: ")
    ? diagnostic.slice("Error response from daemon: ".length)
    : diagnostic.startsWith("Error: ")
      ? diagnostic.slice("Error: ".length)
      : diagnostic;
  const expected = type === "container"
    ? [
      `No such container: ${name}`,
      `no such container "${name}"`,
      `no container with name or ID "${name}" found: no such container`,
      `no container with ID or name "${name}" found: no such container`,
    ]
    : type === "network"
      ? [
        `network ${name} not found`,
        `network ${name}: unable to find network with name or ID ${name}: network not found`,
        `unable to find network with name or ID ${name}: network not found`,
      ]
      : [
        `get ${name}: no such volume`,
        `no such volume ${name}`,
        `no volume with name "${name}" found: no such volume`,
      ];
  return expected.includes(message);
}

export async function removeLabeled(type, name, runId, dockerRunner = docker) {
  let labels;
  try {
    labels = await inspectLabels(type, name, dockerRunner);
  } catch (error) {
    if (isMissingDockerObjectError(error, type, name)) return;
    throw error;
  }
  if (labels[RUN_LABEL] !== runId) throw new Error(`refusing to remove unlabeled ${type}`);
  const args = type === "container"
    ? ["container", "rm", "--force", name]
    : [type, "rm", name];
  await dockerRunner(args);
}

function requiredOwnership(labels) {
  const runId = labels[RUN_LABEL];
  const pidText = labels[OWNER_PID_LABEL];
  const birth = labels[OWNER_BIRTH_LABEL];
  const scope = labels[OWNER_SCOPE_LABEL];
  const kind = labels[RESOURCE_KIND_LABEL];
  if (labels[OWNER_SCHEMA_LABEL] !== OWNER_SCHEMA_VERSION
    || !/^[0-9a-f]{32}$/u.test(runId ?? "")
    || !/^[1-9][0-9]*$/u.test(pidText ?? "")
    || !isValidProcessBirthFingerprint(birth)
    || !(linuxScopeRegex.test(scope ?? "") || portableScopeRegex.test(scope ?? ""))
    || !processIdentityEvidenceConsistent(birth, scope)
    || typeof kind !== "string"
    || kind.length === 0) {
    return undefined;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) return undefined;
  return { runId, pid, birth, scope, kind };
}

function labelsMatchOwnership(labels, expected) {
  return Object.entries(expected).every(([key, value]) => labels[key] === String(value));
}

export async function removeOwnedResource(
  type,
  name,
  expectedLabels,
  dockerRunner = docker,
  dependencies = {},
) {
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  for (let attempt = 0; attempt < MAX_DOCKER_REMOVE_ATTEMPTS; attempt += 1) {
    let record;
    try {
      record = await inspectDockerObject(type, name, dockerRunner);
    } catch (error) {
      if (isMissingDockerObjectError(error, type, name)) return;
      throw error;
    }
    const labels = inspectedLabels(type, record);
    if (!labelsMatchOwnership(labels, expectedLabels)) {
      throw new Error(`refusing to remove ${type} with changed PostgreSQL harness ownership`);
    }
    if (type === "container" && dependencies.requireStoppedContainer === true) {
      if (record?.State?.Running === true) {
        throw new Error(`refusing to reclaim active PostgreSQL harness container ${name}`);
      }
      if (record?.State?.Running !== false) {
        throw new Error(`refusing to reclaim PostgreSQL harness container ${name} with uncertain state`);
      }
    }
    const args = type === "container"
      ? [
        "container",
        "rm",
        ...(dependencies.requireStoppedContainer === true ? [] : ["--force"]),
        name,
      ]
      : [type, "rm", name];
    try {
      await dockerRunner(args);
      return;
    } catch (error) {
      if (isMissingDockerObjectError(error, type, name)) return;
      lastError = error;
      if (attempt + 1 < MAX_DOCKER_REMOVE_ATTEMPTS) await delay(100 * (attempt + 1));
    }
  }
  throw lastError ?? new Error(`failed to remove PostgreSQL harness ${type}`);
}

async function listLabeledResources(dockerRunner = docker) {
  const listed = [];
  for (const [type, args] of [
    ["container", ["container", "ls", "--all", "--format", "{{.Names}}", "--filter", `label=${RUN_LABEL}`]],
    ["network", ["network", "ls", "--format", "{{.Name}}", "--filter", `label=${RUN_LABEL}`]],
    ["volume", ["volume", "ls", "--format", "{{.Name}}", "--filter", `label=${RUN_LABEL}`]],
  ]) {
    const result = await dockerRunner(args);
    for (const name of result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
      listed.push({ type, name });
    }
  }
  return listed;
}

function shortRunPrefixFromName(name) {
  return name.match(/^lcm-pg-(?:net-|data-|restore-|runner-)?([0-9a-f]{20})$/u)?.[1];
}

export function harnessDirectoryFromRecord(record, dependencies = {}) {
  const mounts = (record?.Mounts ?? []).filter((mount) => mount?.Destination === "/run/lcm-harness");
  if (mounts.length !== 1) return undefined;
  const mount = mounts[0];
  if (mount.Type !== "bind" || mount.RW !== false || typeof mount.Source !== "string") return undefined;
  try {
    const resolvePath = dependencies.realpath ?? realpathSync;
    const resolved = resolvePath(mount.Source);
    const environment = dependencies.environment ?? process.env;
    const handoff = environment.LCM_TEST_HARNESS_TMPDIR;
    const platformName = dependencies.platformName ?? platform();
    const snapshot = parseOriginalTemporaryParents(
      environment.LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS,
      platformName,
    );
    const candidateParents = handoff === undefined
      ? candidateTemporaryParents(environment, platformName, null, dependencies.temporaryRoot)
      : [
        ...(typeof handoff === "string"
          && handoff.length > 0
          && !handoff.includes("\0")
          && (platformName === "win32" ? win32.isAbsolute(handoff) : isAbsolute(handoff))
          ? [handoff]
          : []),
        ...(snapshot ?? nonLivePlatformFallbackParents(environment, platformName)),
      ];
    const allowedParents = canonicalCandidateParents({
      environment,
      platformName,
      candidateParents,
      realpath: resolvePath,
    });
    const pathApi = platformName === "win32" ? win32 : { dirname, basename };
    const resolvedParent = pathApi.dirname(resolved);
    const normalizePath = pathApi.normalize ?? normalize;
    const parentKey = (value) => {
      const normalized = normalizePath(value);
      return platformName === "win32" ? normalized.toLowerCase() : normalized;
    };
    if (!allowedParents.some((parent) => parentKey(parent) === parentKey(resolvedParent))
      || !/^lcm-postgresql-harness-[A-Za-z0-9_-]+$/u.test(pathApi.basename(resolved))) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function readConsumerOwner(directory, dependencies = {}) {
  const openFile = dependencies.open ?? openSync;
  const inspectFile = dependencies.fstat ?? fstatSync;
  const readFile = dependencies.read ?? readSync;
  const closeFile = dependencies.close ?? closeSync;
  const path = join(directory, consumerOwnerFile);
  let descriptor;
  try {
    try {
      descriptor = openFile(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error("PostgreSQL harness consumer identity could not be opened securely", { cause: error });
    }
    const status = inspectFile(descriptor);
    const currentPlatform = dependencies.platform?.() ?? platform();
    if (!status.isFile()
      || (currentPlatform !== "win32" && (status.mode & 0o077) !== 0)
      || status.size > 1024) {
      throw new Error("invalid PostgreSQL harness consumer identity evidence");
    }
    const contents = Buffer.alloc(1025);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readFile(descriptor, contents, offset, contents.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1024) throw new Error("invalid PostgreSQL harness consumer identity evidence");
    let value;
    try {
      value = JSON.parse(contents.subarray(0, offset).toString("utf8"));
    } catch (error) {
      throw new Error("invalid PostgreSQL harness consumer identity evidence", { cause: error });
    }
    if (value?.version !== 1
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || !isValidProcessBirthFingerprint(value.birth)
      || !(linuxScopeRegex.test(value.scope ?? "") || portableScopeRegex.test(value.scope ?? ""))
      || !processIdentityEvidenceConsistent(value.birth, value.scope)) {
      throw new Error("invalid PostgreSQL harness consumer identity evidence");
    }
    return { pid: value.pid, birth: value.birth, scope: value.scope };
  } finally {
    if (descriptor !== undefined) closeFile(descriptor);
  }
}

function ownerFromPreviousLinuxBoot(owner, dependencies = {}) {
  const currentPlatform = dependencies.platform?.() ?? platform();
  const recordedBootId = owner.birth.match(linuxBirthRegex)?.[1];
  if (currentPlatform !== "linux" || !recordedBootId) return false;
  try {
    const readFile = dependencies.readFile ?? readFileSync;
    const currentBootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return bootIdRegex.test(currentBootId) && currentBootId !== recordedBootId;
  } catch {
    return false;
  }
}

export function classifyOwnerIdentity(owner, dependencies = {}) {
  const readFingerprint = dependencies.readFingerprint ?? readProcessBirthFingerprint;
  const readScope = dependencies.readScope ?? readOwnerScopeFingerprint;
  const processProbe = dependencies.processProbe ?? ((pid) => process.kill(pid, 0));
  let currentScope;
  try {
    currentScope = readScope();
  } catch {
    return "ambiguous";
  }
  if (currentScope !== owner.scope) {
    const recordedLinux = owner.scope?.match(linuxScopeRegex);
    const currentLinux = currentScope.match(linuxScopeRegex);
    if (recordedLinux && currentLinux
      && recordedLinux[1] === currentLinux[1]
      && recordedLinux[2] !== currentLinux[2]) {
      return "stale";
    }
    return "ambiguous";
  }
  try {
    processProbe(owner.pid);
  } catch (error) {
    return error?.code === "ESRCH" ? "stale" : "ambiguous";
  }
  try {
    return readFingerprint(owner.pid) === owner.birth ? "live" : "stale";
  } catch (error) {
    return error?.code === "ESRCH" ? "stale" : "ambiguous";
  }
}

export async function discoverHarnessRuns(dependencies = {}) {
  const dockerRunner = dependencies.dockerRunner ?? docker;
  const resources = await listLabeledResources(dockerRunner);
  const runs = new Map();
  for (const resource of resources) {
    let record;
    try {
      record = await inspectDockerObject(resource.type, resource.name, dockerRunner);
    } catch (error) {
      if (isMissingDockerObjectError(error, resource.type, resource.name)) continue;
      runs.set(`ambiguous:${resource.type}:${resource.name}`, {
        classification: "ambiguous",
        resources: [{
          ...resource,
          error,
          shortRunPrefix: shortRunPrefixFromName(resource.name),
        }],
      });
      continue;
    }
    const labels = inspectedLabels(resource.type, record);
    const ownership = requiredOwnership(labels);
    const spec = ownership && resourceSpec(resource.type, resource.name, ownership.runId);
    if (!ownership || !spec || spec.kind !== ownership.kind) {
      const labeledRunId = /^[0-9a-f]{32}$/u.test(labels[RUN_LABEL] ?? "")
        ? labels[RUN_LABEL]
        : undefined;
      const key = ownership?.runId ?? labeledRunId ?? `ambiguous:${resource.type}:${resource.name}`;
      const run = runs.get(key) ?? {
        runId: ownership?.runId ?? labeledRunId,
        owner: ownership ? { pid: ownership.pid, birth: ownership.birth, scope: ownership.scope } : undefined,
        classification: "ambiguous",
        resources: [],
      };
      run.classification = "ambiguous";
      run.resources.push({
        ...resource,
        labels,
        shortRunPrefix: shortRunPrefixFromName(resource.name),
      });
      runs.set(key, run);
      continue;
    }
    const expectedLabels = ownershipLabels(
      ownership.runId,
      ownership.kind,
      { pid: ownership.pid, birth: ownership.birth, scope: ownership.scope },
    );
    const run = runs.get(ownership.runId) ?? {
      runId: ownership.runId,
      owner: { pid: ownership.pid, birth: ownership.birth, scope: ownership.scope },
      classification: undefined,
      resources: [],
    };
    if (!run.owner
      || run.owner.pid !== ownership.pid
      || run.owner.birth !== ownership.birth
      || run.owner.scope !== ownership.scope) {
      run.classification = "ambiguous";
    }
    if (resource.type === "container" && typeof record?.State?.Running !== "boolean") {
      run.classification = "ambiguous";
    }
    const harnessDirectory = ownership.kind === "database"
      ? (dependencies.resolveHarnessDirectory?.(record) ?? harnessDirectoryFromRecord(record, dependencies))
      : undefined;
    const resourceEntry = {
      ...resource,
      kind: ownership.kind,
      labels: expectedLabels,
      harnessDirectory,
      ...(resource.type === "container" ? { running: record?.State?.Running } : {}),
    };
    run.resources.push(resourceEntry);
    runs.set(ownership.runId, run);
  }
  const runIdsByPrefix = new Map();
  for (const run of runs.values()) {
    if (!/^[0-9a-f]{32}$/u.test(run.runId ?? "")) continue;
    const prefix = run.runId.slice(0, 20);
    const runIds = runIdsByPrefix.get(prefix) ?? new Set();
    runIds.add(run.runId);
    runIdsByPrefix.set(prefix, runIds);
  }
  for (const runIds of runIdsByPrefix.values()) {
    if (runIds.size < 2) continue;
    for (const runId of runIds) {
      const run = runs.get(runId);
      if (run) run.classification = "ambiguous";
    }
  }
  const ambiguousPrefixes = [...runs.values()]
    .filter((run) => run.classification === "ambiguous")
    .flatMap((run) => run.resources.map((resource) => resource.shortRunPrefix).filter(Boolean));
  for (const run of runs.values()) {
    if (run.runId && ambiguousPrefixes.some((prefix) => run.runId.startsWith(prefix))) {
      run.classification = "ambiguous";
    }
  }
  for (const run of runs.values()) {
    if (run.classification !== "ambiguous") {
      run.classification = classifyOwnerIdentity(run.owner, dependencies);
      if (run.classification === "stale") {
        const activeWorker = run.resources.some(
          (resource) => (resource.kind === "runner" || resource.kind === "restore") && resource.running,
        );
        if (activeWorker) {
          run.classification = "live";
          continue;
        }
        const database = run.resources.find((resource) => resource.kind === "database");
        if (database) {
          if (!database.harnessDirectory) {
            run.classification = !database.running && ownerFromPreviousLinuxBoot(run.owner, dependencies)
              ? "stale"
              : "ambiguous";
            continue;
          }
          try {
            const consumer = readConsumerOwner(database.harnessDirectory, dependencies);
            if (consumer) run.classification = classifyOwnerIdentity(consumer, dependencies);
          } catch {
            run.classification = "ambiguous";
          }
        }
      }
    }
  }
  return [...runs.values()];
}

async function inspectReclaimableWorkers(run, names, dockerRunner) {
  const workers = [];
  for (const [kind, name] of [
    ["restore", names.restore],
    ["runner", names.runner],
  ]) {
    const expectedLabels = ownershipLabels(run.runId, kind, run.owner);
    let record;
    try {
      record = await inspectDockerObject("container", name, dockerRunner);
    } catch (error) {
      if (isMissingDockerObjectError(error, "container", name)) continue;
      throw error;
    }
    const labels = record?.Config?.Labels ?? {};
    if (!labelsMatchOwnership(labels, expectedLabels)) {
      throw new Error(`refusing to reclaim ${kind} container with changed PostgreSQL harness ownership`);
    }
    if (record?.State?.Running === true) return { live: true, workers: [] };
    if (record?.State?.Running !== false) {
      throw new Error(`refusing to reclaim ${kind} container with uncertain state`);
    }
    workers.push({
      type: "container",
      name,
      kind,
      labels: expectedLabels,
    });
  }
  return { live: false, workers };
}

export async function reclaimProvenOrphans(dependencies = {}) {
  const dockerRunner = dependencies.dockerRunner ?? docker;
  const removeDirectory = dependencies.removeDirectory
    ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const delay = dependencies.delay
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const runs = await discoverHarnessRuns({ ...dependencies, dockerRunner });
  const failures = [];
  const ambiguousCount = runs.filter((run) => run.classification === "ambiguous").length;
  if (ambiguousCount > 0) {
    const stderr = dependencies.stderr ?? process.stderr;
    stderr.write(
      `PostgreSQL harness preserved ${ambiguousCount} ambiguous labeled run${ambiguousCount === 1 ? "" : "s"}; manual reconciliation required.\n`,
    );
  }
  for (const run of runs) {
    if (run.classification !== "stale") continue;
    const runFailures = [];
    const byKind = new Map(run.resources.map((resource) => [resource.kind, resource]));
    const names = createRunNames(run.runId);
    const database = byKind.get("database");
    let workerSnapshot;
    try {
      workerSnapshot = await inspectReclaimableWorkers(run, names, dockerRunner);
      if (!workerSnapshot.live) {
        await delay(ORPHAN_WORKER_STABILITY_DELAY_MS);
        workerSnapshot = await inspectReclaimableWorkers(run, names, dockerRunner);
      }
    } catch (error) {
      runFailures.push(error);
    }
    if (workerSnapshot?.live) {
      run.classification = "live";
      continue;
    }
    if (runFailures.length > 0) {
      failures.push(...runFailures);
      continue;
    }
    for (const worker of workerSnapshot.workers) {
      try {
        await removeOwnedResource(
          worker.type,
          worker.name,
          worker.labels,
          dockerRunner,
          { ...dependencies, requireStoppedContainer: true },
        );
      } catch (error) {
        runFailures.push(error);
        break;
      }
    }
    if (runFailures.length > 0) {
      failures.push(...runFailures);
      continue;
    }
    let databaseAbsent = false;
    if (database?.running) {
      try {
        await (dependencies.verifySentinel
          ? dependencies.verifySentinel(names, run.runId, dockerRunner)
          : waitForContainerSentinel(names, run.runId, dockerRunner));
      } catch (error) {
        if (!isMissingDockerObjectError(error, "container", database.name)) {
          runFailures.push(error);
          failures.push(...runFailures);
          continue;
        }
        databaseAbsent = true;
      }
    }
    for (const kind of ["database", "data", "network"]) {
      const resource = byKind.get(kind);
      if (!resource) continue;
      if (kind === "database" && databaseAbsent) continue;
      try {
        await removeOwnedResource(
          resource.type,
          resource.name,
          resource.labels,
          dockerRunner,
          dependencies,
        );
        if (kind === "database") databaseAbsent = true;
      } catch (error) {
        runFailures.push(error);
      }
    }
    if (databaseAbsent && database?.harnessDirectory) {
      try {
        await removeDirectory(database.harnessDirectory);
      } catch (error) {
        runFailures.push(error);
      }
    }
    failures.push(...runFailures);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "PostgreSQL harness orphan recovery failed");
  return runs;
}

async function waitForPostgreSql(container, database, dockerRunner = docker, username = "lcm_harness_admin") {
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await dockerRunner(["exec", container, "pg_isready", "--quiet", "--username", username, "--dbname", database]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("PostgreSQL readiness timed out");
}

async function hostPort(container, dockerRunner = docker) {
  const result = await dockerRunner(["port", container, "5432/tcp"]);
  const match = result.stdout.match(/127\.0\.0\.1:(\d+)$/u);
  if (!match || match[1] === "5432") throw new Error("the container engine did not allocate a safe random loopback port");
  return Number(match[1]);
}

async function verifyContainerSentinel(names, runId, dockerRunner = docker) {
  validateRunNames(names, runId);
  const result = await dockerRunner([
    "exec", names.container,
    "psql", "--username", "lcm_harness_admin", "--dbname", names.controlDatabase,
    "--tuples-only", "--no-align", "--field-separator", "|",
    "--command", `SELECT current_setting('server_version_num'), current_user,
                         sentinel.run_id, sentinel.database_name, sentinel.runtime_role
                  FROM public.__lcm_test_run_sentinel AS sentinel`,
  ]);
  const fields = result.stdout.trim().split("|");
  if (
    Math.floor(Number(fields[0]) / 10_000) !== 18
    || fields[1] !== "lcm_harness_admin"
    || fields[2] !== runId
    || fields[3] !== names.controlDatabase
    || fields[4] !== "lcm_test_runtime"
  ) throw new Error("refusing to clean an unowned PostgreSQL harness container");
}

async function waitForContainerSentinel(names, runId, dockerRunner = docker) {
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await verifyContainerSentinel(names, runId, dockerRunner);
      return;
    } catch (error) {
      if (isMissingDockerObjectError(error, "container", names.container)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("PostgreSQL harness sentinel readiness timed out");
}

export function harnessErrorDetails(error) {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((nested) => harnessErrorDetails(nested))].join("\n");
  }
  return String(harnessErrorStderr(error) ?? error?.message ?? error);
}

const RAW_OUTPUT_OMITTED = "[raw child output omitted: capture exceeded the safe limit before redaction]";

// A raw ring tail that overflowed may start inside a secret or PEM block, and
// redacting it afterwards cannot recover that state, so it is never reported.
function harnessErrorStderr(error) {
  return error?.stderrTruncated === true && error.redacted !== true
    ? RAW_OUTPUT_OMITTED
    : error?.stderr;
}

export function appendContainerLogs(error, logs) {
  const rawLogsOverflowed = logs.redacted !== true && (logs.stdoutTruncated || logs.stderrTruncated);
  return Object.assign(error, {
    stderr: `${harnessErrorStderr(error) ?? ""}\n${rawLogsOverflowed ? RAW_OUTPUT_OMITTED : `${logs.stdout}\n${logs.stderr}`}`,
    stderrTruncated: false,
  });
}

export function sanitizedHarnessErrorDetails(error, secrets) {
  return boundedDiagnosticExcerpt(sanitizeHarnessText(harnessErrorDetails(error), secrets));
}

export async function cleanupHarnessResources(context, dependencies = {}) {
  const { names, runId, directory, sentinelReady, owner } = context;
  const dockerRunner = dependencies.dockerRunner ?? docker;
  const removeResource = dependencies.removeResource
    ?? ((type, name) => {
      const spec = resourceSpec(type, name, runId);
      if (!owner || !spec) return removeLabeled(type, name, runId, dockerRunner);
      return removeOwnedResource(type, name, ownershipLabels(runId, spec.kind, owner), dockerRunner);
    });
  const verifySentinel = dependencies.verifySentinel
    ?? (() => verifyContainerSentinel(names, runId, dockerRunner));
  const removeDirectory = dependencies.removeDirectory
    ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const retryDelays = dependencies.retryDelays ?? HARNESS_CLEANUP_RETRY_DELAYS_MS;
  const delay = dependencies.delay
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let failures = [];

  for (let pass = 0; pass <= retryDelays.length; pass += 1) {
    const passFailures = [];
    const attempt = async (operation) => {
      try {
        await operation();
        return true;
      } catch (error) {
        passFailures.push(error);
        return false;
      }
    };

    await attempt(() => removeResource("container", names.restore));
    await attempt(() => removeResource("container", names.runner));
    let containerOwned = !sentinelReady;
    if (sentinelReady) {
      try {
        await verifySentinel();
        containerOwned = true;
      } catch (error) {
        if (!isMissingDockerObjectError(error, "container", names.container)) {
          passFailures.push(error);
        }
      }
    }
    if (containerOwned) await attempt(() => removeResource("container", names.container));
    await attempt(() => removeResource("volume", names.volume));
    await attempt(() => removeResource("network", names.network));

    failures = passFailures;
    if (failures.length === 0) break;
    if (pass < retryDelays.length) await delay(retryDelays[pass]);
  }

  try {
    await removeDirectory(directory);
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "PostgreSQL harness cleanup failed");
  }
}

export function createHarnessCleanupOperations(context, dependencies = {}) {
  const cleanupResources = dependencies.cleanupResources ?? cleanupHarnessResources;
  const writeDiagnostic = dependencies.writeDiagnostic ?? writeHarnessDiagnostic;
  const stop = dependencies.stop ?? (() => Promise.resolve());
  const secrets = dependencies.secrets ?? [];
  const cleanup = createSingleFlightOperation(
    () => cleanupResources(context, dependencies.cleanupDependencies)
      .catch(async (error) => {
        const details = sanitizedHarnessErrorDetails(error, secrets);
        await writeDiagnostic(`${SIGNAL_CLEANUP_FAILURE_MARKER} ${details}\n`);
        throw error;
      }),
  );
  const teardown = createSingleFlightOperation(
    async () => {
      await stop();
      await cleanup();
    },
  );
  return { cleanup, teardown };
}

function createDockerRunnerEnvironment(environment, censusCost = false) {
  return {
    ...environment,
    // The opt-in census-cost measurement selects its file through this flag,
    // so the separate runner process only sees it when the caller asked.
    ...(censusCost ? { LCM_TEST_POSTGRES_CENSUS_COST: "true" } : {}),
    // The runner is a separate process and only receives the values written to
    // runner.env. Preserve CI's established Vitest pool there as well.
    CI: "true",
    LCM_TEST_POSTGRES_INNER_CI: "true",
  };
}

/** Build the one owned CI runner; the runner-provided init reaps CLI orphans. */
export function createCiRunnerContainerArgs(context, envFile) {
  return [
    "create", "--name", context.names.runner,
    ...dockerLabelArgs(ownershipLabels(context.runId, "runner", context.owner)),
    "--init",
    "--network", context.names.network,
    "--env-file", envFile,
    "--volume", `${repositoryRoot}:/workspace:ro`,
    "--volume", `${context.directory}:${context.directory}:ro`,
    "--workdir", "/workspace",
    NODE_IMAGE,
    "node", "/workspace/node_modules/vitest/vitest.mjs", "run",
    "--configLoader", "runner",
    "--config", "/workspace/vitest.postgresql.config.ts",
  ];
}

/**
 * Build the database container arguments. Every bind source is a harness-owned
 * path (the run directory and the scripts staged inside it), never a checkout
 * file. Docker keeps the shared SELinux label (`z`); Podman, which runs one
 * container per private run directory, relabels privately (`Z`).
 */
export function createDatabaseContainerArgs(context) {
  const { names, runId, owner, directory, stagedScripts, publish, usingCachedTemplate, flavour } = context;
  const podman = flavour === "podman";
  const mode = podman ? "ro,Z" : "ro,z";
  const args = [
    "create", "--name", names.container,
    ...dockerLabelArgs(ownershipLabels(runId, "database", owner)),
    "--network", names.network,
    "--network-alias", names.alias,
    "--network-alias", names.wrongAlias,
    ...publish,
    "--env", `LCM_POSTGRES_TEMPLATE_MARKER=${POSTGRES_TEMPLATE_MARKER}`,
    "--volume", `${names.volume}:/var/lib/postgresql`,
    "--volume", `${directory}:/run/lcm-harness:${mode}`,
    "--volume", `${stagedScripts.cachedRunInitScript}:/run/lcm-cached-init.sh:${mode}`,
  ];
  if (!usingCachedTemplate) {
    args.push(
      "--volume", `${stagedScripts.initScript}:/docker-entrypoint-initdb.d/10-lcm-harness.sh:${mode}`,
      "--env", "POSTGRES_USER=lcm_harness_admin",
      "--env", `POSTGRES_DB=${names.controlDatabase}`,
      "--env", "POSTGRES_PASSWORD_FILE=/run/lcm-private/admin-password",
      "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
    );
  }
  args.push(
    "--entrypoint", "/bin/bash",
    POSTGRES_IMAGE,
    "-ceu",
    "install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/certs /run/lcm-private; install -o postgres -g postgres -m 0600 /run/lcm-harness/server.key /var/lib/postgresql/certs/server.key; install -o postgres -g postgres -m 0644 /run/lcm-harness/server.crt /run/lcm-harness/ca.crt /var/lib/postgresql/certs/; install -o postgres -g postgres -m 0600 /run/lcm-harness/admin-password /run/lcm-harness/migrator-password /run/lcm-harness/runtime-password /run/lcm-harness/run-id /run/lcm-harness/database-name /run/lcm-private/; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/certs/server.crt -c ssl_key_file=/var/lib/postgresql/certs/server.key -c ssl_ca_file=/var/lib/postgresql/certs/ca.crt -c shared_preload_libraries=pg_stat_statements -c listen_addresses=* -c password_encryption=scram-sha-256 -c timezone=UTC",
  );
  return args;
}

export async function runTests(context, ci, setupDocker = docker, testProcess = runProcess) {
  const env = { ...process.env, ...context.environment };
  delete env.LCM_TEST_POSTGRES_FORK_PROBE;
  delete env.LCM_TEST_POSTGRES_FORK_WORKER_PID_FILE;
  delete env.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT;
  delete env.LCM_TEST_HARNESS_TMPDIR;
  if (!ci) env.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT = context.directory;
  env.LCM_TEST_HARNESS_TMPDIR = context.parent;
  const secrets = context.secrets ?? [];
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG") || key === "LCM_POSTGRES_URL" || key === "LCM_POSTGRES_CA_FILE") delete env[key];
  }
  if (!ci) {
    const consumerPath = join(context.directory, consumerOwnerFile);
    const workerPidPath = join(context.directory, "fork-worker.pid");
    if (context.forkConsumerProbe) {
      env.LCM_TEST_POSTGRES_FORK_PROBE = "true";
      env.LCM_TEST_POSTGRES_FORK_WORKER_PID_FILE = workerPidPath;
    }
    const testArguments = context.consumerProbe
      ? ["-e", "setInterval(() => undefined, 1_000)"]
      : [
        join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
        "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
      ];
    try {
      recordAmbiguousConsumerIdentity(consumerPath);
      return await runSanitizedProcess(process.execPath, testArguments, {
        cwd: repositoryRoot,
        env,
        secrets,
        processRunner: testProcess,
        terminateOnStop: true,
        terminateProcessTree: true,
        onSpawn: (child) => {
          recordConsumerIdentity(consumerPath, child.pid);
          if (context.forkConsumerProbe) {
            const readiness = setInterval(() => {
              try {
                const workerPid = String(readFileSync(workerPidPath, "utf8")).trim();
                if (!/^[1-9][0-9]*$/u.test(workerPid)) return;
                clearInterval(readiness);
                process.stderr.write(`PostgreSQL harness fork consumer probe ready: ${context.runId}\n`);
              } catch (error) {
                if (error?.code !== "ENOENT") clearInterval(readiness);
              }
            }, 25);
            readiness.unref?.();
            child.once("close", () => clearInterval(readiness));
          } else if (context.consumerProbe) {
            process.stderr.write(`PostgreSQL harness consumer probe ready: ${context.runId}\n`);
          }
        },
      });
    } finally {
      try {
        unlinkSync(consumerPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  // The census-cost configuration excludes the signal file, so the pre-run
  // would collect nothing and fail; the measurement runs only in the runner.
  const censusCost = env.LCM_TEST_POSTGRES_CENSUS_COST === "true";
  if (!censusCost) {
    await runSanitizedProcess(process.execPath, [
      join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
      "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
      join(repositoryRoot, "test", "postgresql", "signal.integration.ts"),
    ], {
      cwd: repositoryRoot,
      env,
      secrets,
      processRunner: testProcess,
      terminateOnStop: true,
      terminateProcessTree: true,
    });
  }
  const envFile = join(context.directory, "runner.env");
  writeFileSync(envFile, Object.entries(createDockerRunnerEnvironment(context.environment, censusCost))
    .map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  await setupDocker(createCiRunnerContainerArgs(context, envFile));
  await runSanitizedProcess(context.containerCli ?? "docker", ["start", "--attach", context.names.runner], {
    processRunner: (_command, args, processOptions) => setupDocker(args, processOptions),
    secrets,
    terminateOnStop: true,
  });
}

// Copies the database container's init scripts into the harness-owned run
// directory so SELinux relabeling applies to the copies, not the checkout.
export function stageHarnessScripts(directory) {
  const staged = {
    initScript: join(directory, "init.sh"),
    cachedRunInitScript: join(directory, "cached-run-init.sh"),
  };
  copyFileSync(initScript, staged.initScript);
  copyFileSync(cachedRunInitScript, staged.cachedRunInitScript);
  chmodSync(staged.initScript, 0o644);
  chmodSync(staged.cachedRunInitScript, 0o644);
  return staged;
}

export async function runHarness(options = {}) {
  resolveSignalProbeReadinessTimeout(process.env);
  const ci = options.ci ?? process.env.GITHUB_ACTIONS === "true";
  let engine;
  try {
    engine = resolveContainerEngine(process.env);
    assertContainerEngineSupported(engine, ci, process.env);
  } catch (error) {
    process.stderr.write(`PostgreSQL harness startup failed: ${error.message}\n`);
    throw error;
  }
  const containerRunner = createContainerRunner(engine.cli);
  const runId = randomBytes(16).toString("hex");
  process.stderr.write(`${HARNESS_ALLOCATION_MARKER} ${runId}\n`);
  let owner;
  try {
    await options.afterRunAllocation?.({ runId });
    await reclaimProvenOrphans({ dockerRunner: containerRunner });
    owner = createOwnerIdentity();
  } catch (error) {
    process.stderr.write(`PostgreSQL harness startup failed: ${sanitizedHarnessErrorDetails(error, [])}\n`);
    throw error;
  }
  const names = createRunNames(runId);
  const harnessEnvironment = { ...process.env };
  const hasHarnessParent = harnessEnvironment.LCM_TEST_HARNESS_TMPDIR !== undefined;
  if (!hasHarnessParent) delete harnessEnvironment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT;
  const allocation = createTestTempDirectory({
    environment: harnessEnvironment,
    explicitVariable: hasHarnessParent ? "LCM_TEST_HARNESS_TMPDIR" : undefined,
    prefix: "lcm-postgresql-harness-",
    createDirectory: mkdtempSync,
    secureDirectory: chmodSync,
    removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
  });
  const directory = allocation.root;
  const parent = allocation.parent;
  const passwords = {
    admin: randomBytes(32).toString("base64url"),
    migrator: randomBytes(32).toString("base64url"),
    runtime: randomBytes(32).toString("base64url"),
  };
  const secrets = [...Object.values(passwords), directory];
  validateRunNames(names, runId);
  const processLifecycle = createProcessLifecycle();
  const setupProcess = processLifecycle.run;
  const setupDocker = (args, processOptions) => setupProcess(engine.cli, args, processOptions);
  let sentinelReady = false;
  const { teardown } = createHarnessCleanupOperations(
    {
      names,
      runId,
      directory,
      get sentinelReady() {
        return sentinelReady;
      },
      owner,
    },
    {
      stop: processLifecycle.stop,
      secrets,
      cleanupDependencies: { dockerRunner: containerRunner },
    },
  );
  let exitSignal;
  let signalExitPromise;
  const removeSignalHandlers = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  };
  const onSignal = (signal) => {
    exitSignal ??= signal;
    signalExitPromise ??= completeSignalExit(exitSignal, teardown, { removeSignalHandlers });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const onSighup = () => onSignal("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    writeFileSync(join(directory, "run-id"), `${runId}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "database-name"), `${names.controlDatabase}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "admin-password"), `${passwords.admin}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "migrator-password"), `${passwords.migrator}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "runtime-password"), `${passwords.runtime}\n`, { mode: 0o600 });
    const stagedScripts = stageHarnessScripts(directory);
    await writeTlsFixtures(directory, names.alias, setupProcess);
    await setupDocker([
      "network", "create",
      ...dockerLabelArgs(ownershipLabels(runId, "network", owner)),
      names.network,
    ]);
    await setupDocker([
      "volume", "create",
      ...dockerLabelArgs(ownershipLabels(runId, "data", owner)),
      names.volume,
    ]);
    const configuredTemplateArchive = String(process.env.LCM_POSTGRES_TEMPLATE_ARCHIVE ?? "").trim();
    const templateArchive = resolveConfiguredTemplateArchive(configuredTemplateArchive);
    const usingCachedTemplate = templateArchive.length > 0;
    if (usingCachedTemplate) {
      await validatePostgreSqlTemplateArchive(templateArchive);
      await setupDocker([
        "create", "--name", names.restore,
        ...dockerLabelArgs(ownershipLabels(runId, "restore", owner)),
        "--network", "none",
        "--volume", `${names.volume}:/target`,
        "--volume", `${templateArchive}:/cache/postgresql-template.tar:ro`,
        "--entrypoint", "/bin/bash",
        POSTGRES_IMAGE,
        "-ceu",
        "tar --extract --file /cache/postgresql-template.tar --directory /target; chown -R postgres:postgres /target",
      ]);
      await setupDocker(["start", "--attach", names.restore]);
      await removeOwnedResource(
        "container",
        names.restore,
        ownershipLabels(runId, "restore", owner),
        setupDocker,
      );
    }
    await setupDocker(createDatabaseContainerArgs({
      names,
      runId,
      owner,
      directory,
      stagedScripts,
      publish: ci ? [] : ["--publish", "127.0.0.1::5432"],
      usingCachedTemplate,
      flavour: engine.flavour,
    }));
    await setupDocker(["start", names.container]);
    try {
      await waitForPostgreSql(
        names.container,
        usingCachedTemplate ? "postgres" : names.controlDatabase,
        setupDocker,
        usingCachedTemplate ? "postgres" : "lcm_harness_admin",
      );
      if (usingCachedTemplate) {
        await setupDocker(["exec", names.container, "/bin/bash", "/run/lcm-cached-init.sh"]);
      }
    } catch (error) {
      const logs = await containerRunner(["logs", names.container], { redactSecrets: secrets })
        .catch(() => ({ stdout: "", stderr: "" }));
      throw appendContainerLogs(error, logs);
    }
    await waitForContainerSentinel(names, runId, setupDocker);
    sentinelReady = true;
    const host = ci ? names.alias : "127.0.0.1";
    const port = ci ? 5432 : await hostPort(names.container, setupDocker);
    const environment = {
      LCM_TEST_POSTGRES_RUN_ID: runId,
      LCM_TEST_POSTGRES_CONTAINER: names.container,
      LCM_TEST_POSTGRES_CONTROL_DATABASE: names.controlDatabase,
      LCM_TEST_POSTGRES_ADMIN_URL: generatedUrl("lcm_harness_admin", passwords.admin, host, port, names.controlDatabase),
      LCM_TEST_POSTGRES_MIGRATOR_URL: generatedUrl("lcm_test_migrator", passwords.migrator, host, port, names.controlDatabase),
      LCM_TEST_POSTGRES_RUNTIME_URL: generatedUrl("lcm_test_runtime", passwords.runtime, host, port, names.controlDatabase),
      LCM_TEST_POSTGRES_CA_FILE: join(directory, "ca.crt"),
      LCM_TEST_POSTGRES_WRONG_CA_FILE: join(directory, "wrong-ca.crt"),
      LCM_TEST_POSTGRES_WRONG_HOST: ci ? names.wrongAlias : "localhost",
    };
    try {
      if (options.runTests) await options.runTests({ runId, names, directory, parent, environment }, ci);
      else await runTests(
        {
          runId,
          names,
          directory,
          parent,
          environment,
          secrets,
          owner,
          containerCli: engine.cli,
          consumerProbe: options.consumerProbe,
          forkConsumerProbe: options.forkConsumerProbe,
        },
        // A fork probe uses the normal Vitest command with a fixture-only config include.
        ci,
        setupDocker,
        setupProcess,
      );
    } catch (error) {
      const logs = await containerRunner(["logs", names.container], { redactSecrets: secrets })
        .catch(() => ({ stdout: "", stderr: "" }));
      throw appendContainerLogs(error, logs);
    }
  } catch (error) {
    const details = sanitizedHarnessErrorDetails(error, secrets);
    process.stderr.write(`PostgreSQL harness failed: ${details}\n`);
    throw error;
  } finally {
    try {
      await teardown();
    } finally {
      if (!signalExitPromise) removeSignalHandlers();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const signalProbe = process.argv.includes("--signal-probe");
  const consumerProbe = process.argv.includes("--consumer-signal-probe");
  const forkConsumerProbe = process.argv.includes("--fork-consumer-signal-probe");
  const allocationFailureProbe = process.argv.includes("--allocation-failure-probe");
  runHarness(allocationFailureProbe ? {
    afterRunAllocation: () => {
      throw new Error("injected pre-readiness failure");
    },
  } : signalProbe ? {
    runTests: async ({ runId }) => {
      process.stderr.write(`PostgreSQL harness signal probe ready: ${runId}\n`);
      await new Promise(() => { setInterval(() => undefined, 1_000); });
    },
  } : {
    consumerProbe,
    forkConsumerProbe,
    ci: consumerProbe || forkConsumerProbe ? false : undefined,
  }).catch(() => { process.exitCode = 1; });
}
