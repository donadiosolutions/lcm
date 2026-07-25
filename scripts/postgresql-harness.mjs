#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_IMAGE,
  POSTGRES_IMAGE,
} from "./postgresql-images.mjs";
import {
  POSTGRES_TEMPLATE_MARKER,
  validatePostgreSqlTemplateArchive,
} from "./ci-environment.mjs";

export { NODE_IMAGE, POSTGRES_IMAGE };
export const RUN_LABEL = "com.donadiosolutions.lcm.postgresql-test-run";
export const OWNER_SCHEMA_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-schema";
export const OWNER_PID_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-pid";
export const OWNER_BIRTH_LABEL = "com.donadiosolutions.lcm.postgresql-test-owner-birth";
export const RESOURCE_KIND_LABEL = "com.donadiosolutions.lcm.postgresql-test-resource-kind";
export const OWNER_SCHEMA_VERSION = "1";
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
export const MAX_DOCKER_REMOVE_ATTEMPTS = 3;

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const initScript = join(repositoryRoot, "test", "postgresql", "init.sh");
const cachedRunInitScript = join(repositoryRoot, "test", "postgresql", "cached-run-init.sh");
const bootIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const bootIdRegex = new RegExp(`^${bootIdPattern}$`, "u");
const processBirthPattern = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const consumerOwnerFile = "consumer-owner.json";

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
  if (!observed || !processBirthPattern.test(fingerprint)) {
    throw new Error("unsupported PostgreSQL harness process identity evidence");
  }
  return fingerprint;
}

export function createOwnerIdentity(pid = process.pid, dependencies = {}) {
  return {
    pid,
    birth: readProcessBirthFingerprint(pid, dependencies),
  };
}

export function ownershipLabels(runId, kind, owner) {
  return {
    [RUN_LABEL]: runId,
    [OWNER_SCHEMA_LABEL]: OWNER_SCHEMA_VERSION,
    [OWNER_PID_LABEL]: String(owner.pid),
    [OWNER_BIRTH_LABEL]: owner.birth,
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

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      options.onSpawn?.(child);
    } catch (error) {
      child.kill();
      throw error;
    }
    const maxCapturedOutputBytes = MAX_CAPTURED_OUTPUT_BYTES;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
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
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const appended = appendTail(stderr, chunk);
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
      const capturedStdout = stdout.toString("utf8");
      const capturedStderr = stderr.toString("utf8");
      if (code === 0) {
        resolve({
          stdout: capturedStdout.trim(),
          stderr: capturedStderr.trim(),
          stdoutTruncated,
          stderrTruncated,
        });
      }
      else reject(Object.assign(new Error(`${command} failed`), {
        code,
        signal,
        stdout: capturedStdout,
        stderr: capturedStderr,
        stdoutTruncated,
        stderrTruncated,
      }));
    }));
  });
}

function sanitizedCapturedOutput(result, secrets) {
  if (result?.stdoutTruncated || result?.stderrTruncated) {
    throw new Error("PostgreSQL harness child output exceeded the safe capture limit");
  }
  const stdout = sanitizeHarnessText(result?.stdout ?? "", secrets);
  const stderr = sanitizeHarnessText(result?.stderr ?? "", secrets);
  if (Buffer.byteLength(stdout) > MAX_CAPTURED_OUTPUT_BYTES
    || Buffer.byteLength(stderr) > MAX_CAPTURED_OUTPUT_BYTES) {
    throw new Error("PostgreSQL harness sanitized output exceeded the safe capture limit");
  }
  return { stdout, stderr };
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
    const result = await processRunner(command, args, processOptions);
    const output = sanitizedCapturedOutput(result, secrets);
    surfaceCapturedOutput(output, { stdout, stderr });
    return output;
  } catch (error) {
    const output = sanitizedCapturedOutput(error, secrets);
    surfaceCapturedOutput(output, { stdout, stderr });
    if (error && typeof error === "object") Object.assign(error, output);
    throw error;
  }
}

export function createProcessLifecycle(processRunner = runProcess) {
  const active = new Set();
  let stopping = false;

  const run = (command, args, options) => {
    if (stopping) return Promise.reject(new Error("PostgreSQL harness setup is stopping"));
    let operation;
    try {
      operation = Promise.resolve(processRunner(command, args, options));
    } catch (error) {
      operation = Promise.reject(error);
    }
    active.add(operation);
    const remove = () => active.delete(operation);
    void operation.then(remove, remove);
    return operation;
  };

  const stop = async () => {
    stopping = true;
    while (active.size > 0) await Promise.allSettled([...active]);
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

export async function inspectLabels(type, name, dockerRunner = docker) {
  const record = await inspectDockerObject(type, name, dockerRunner);
  return type === "container" ? record?.Config?.Labels ?? {} : record?.Labels ?? {};
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
    ? `No such container: ${name}`
    : type === "network"
      ? `network ${name} not found`
      : `get ${name}: no such volume`;
  return message === expected;
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
  const kind = labels[RESOURCE_KIND_LABEL];
  if (labels[OWNER_SCHEMA_LABEL] !== OWNER_SCHEMA_VERSION
    || !/^[0-9a-f]{32}$/u.test(runId ?? "")
    || !/^[1-9][0-9]*$/u.test(pidText ?? "")
    || !processBirthPattern.test(birth ?? "")
    || typeof kind !== "string"
    || kind.length === 0) {
    return undefined;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) return undefined;
  return { runId, pid, birth, kind };
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
    let labels;
    try {
      labels = await inspectLabels(type, name, dockerRunner);
    } catch (error) {
      if (isMissingDockerObjectError(error, type, name)) return;
      throw error;
    }
    if (!labelsMatchOwnership(labels, expectedLabels)) {
      throw new Error(`refusing to remove ${type} with changed PostgreSQL harness ownership`);
    }
    const args = type === "container"
      ? ["container", "rm", "--force", name]
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

function harnessDirectoryFromRecord(record) {
  const mounts = (record?.Mounts ?? []).filter((mount) => mount?.Destination === "/run/lcm-harness");
  if (mounts.length !== 1) return undefined;
  const mount = mounts[0];
  if (mount.Type !== "bind" || mount.RW !== false || typeof mount.Source !== "string") return undefined;
  try {
    const resolved = realpathSync(mount.Source);
    const temporaryRoot = realpathSync(tmpdir());
    if (dirname(resolved) !== temporaryRoot
      || !/^lcm-postgresql-harness-[A-Za-z0-9_-]+$/u.test(basename(resolved))) return undefined;
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
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.size > 1024) {
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
      || !processBirthPattern.test(value.birth ?? "")) {
      throw new Error("invalid PostgreSQL harness consumer identity evidence");
    }
    return { pid: value.pid, birth: value.birth };
  } finally {
    if (descriptor !== undefined) closeFile(descriptor);
  }
}

export function classifyOwnerIdentity(owner, dependencies = {}) {
  const readFingerprint = dependencies.readFingerprint ?? readProcessBirthFingerprint;
  const processProbe = dependencies.processProbe ?? ((pid) => process.kill(pid, 0));
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
    const labels = resource.type === "container" ? record?.Config?.Labels ?? {} : record?.Labels ?? {};
    const ownership = requiredOwnership(labels);
    const spec = ownership && resourceSpec(resource.type, resource.name, ownership.runId);
    if (!ownership || !spec || spec.kind !== ownership.kind) {
      const labeledRunId = /^[0-9a-f]{32}$/u.test(labels[RUN_LABEL] ?? "")
        ? labels[RUN_LABEL]
        : undefined;
      const key = ownership?.runId ?? labeledRunId ?? `ambiguous:${resource.type}:${resource.name}`;
      const run = runs.get(key) ?? {
        runId: ownership?.runId ?? labeledRunId,
        owner: ownership ? { pid: ownership.pid, birth: ownership.birth } : undefined,
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
      { pid: ownership.pid, birth: ownership.birth },
    );
    const run = runs.get(ownership.runId) ?? {
      runId: ownership.runId,
      owner: { pid: ownership.pid, birth: ownership.birth },
      classification: undefined,
      resources: [],
    };
    if (!run.owner || run.owner.pid !== ownership.pid || run.owner.birth !== ownership.birth) {
      run.classification = "ambiguous";
    }
    if (resource.type === "container" && typeof record?.State?.Running !== "boolean") {
      run.classification = "ambiguous";
    }
    const harnessDirectory = ownership.kind === "database"
      ? (dependencies.resolveHarnessDirectory?.(record) ?? harnessDirectoryFromRecord(record))
      : undefined;
    if (ownership.kind === "database" && !harnessDirectory) run.classification = "ambiguous";
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

export async function reclaimProvenOrphans(dependencies = {}) {
  const dockerRunner = dependencies.dockerRunner ?? docker;
  const runs = await discoverHarnessRuns({ ...dependencies, dockerRunner });
  const failures = [];
  const ambiguousCount = runs.filter((run) => run.classification === "ambiguous").length;
  if (ambiguousCount > 0) {
    const stderr = dependencies.stderr ?? process.stderr;
    stderr.write(
      `PostgreSQL harness preserved ${ambiguousCount} ambiguous labeled Docker run${ambiguousCount === 1 ? "" : "s"}; manual reconciliation required.\n`,
    );
  }
  for (const run of runs) {
    if (run.classification !== "stale") continue;
    const byKind = new Map(run.resources.map((resource) => [resource.kind, resource]));
    const database = byKind.get("database");
    if (database?.running) {
      try {
        await (dependencies.verifySentinel
          ? dependencies.verifySentinel(createRunNames(run.runId), run.runId, dockerRunner)
          : waitForContainerSentinel(createRunNames(run.runId), run.runId, dockerRunner));
      } catch (error) {
        failures.push(error);
        continue;
      }
    }
    for (const kind of ["restore", "runner", "database", "data", "network"]) {
      const resource = byKind.get(kind);
      if (!resource) continue;
      try {
        await removeOwnedResource(
          resource.type,
          resource.name,
          resource.labels,
          dockerRunner,
          dependencies,
        );
      } catch (error) {
        failures.push(error);
      }
    }
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
  if (!match || match[1] === "5432") throw new Error("Docker did not allocate a safe random loopback port");
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
  return String(error?.stderr ?? error?.message ?? error);
}

function sanitizedHarnessErrorDetails(error, secrets) {
  const sanitized = sanitizeHarnessText(harnessErrorDetails(error), secrets);
  return Buffer.byteLength(sanitized) <= MAX_CAPTURED_OUTPUT_BYTES
    ? sanitized
    : "PostgreSQL harness diagnostic exceeded the safe capture limit";
}

export async function cleanupHarnessResources(context, dependencies = {}) {
  const { names, runId, directory, sentinelReady, owner } = context;
  const removeResource = dependencies.removeResource
    ?? ((type, name) => {
      const spec = resourceSpec(type, name, runId);
      if (!owner || !spec) return removeLabeled(type, name, runId);
      return removeOwnedResource(type, name, ownershipLabels(runId, spec.kind, owner));
    });
  const verifySentinel = dependencies.verifySentinel
    ?? (() => verifyContainerSentinel(names, runId));
  const removeDirectory = dependencies.removeDirectory
    ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const failures = [];
  const attempt = async (operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
  };

  try {
    await attempt(() => removeResource("container", names.restore));
    await attempt(() => removeResource("container", names.runner));
    const containerOwned = !sentinelReady || await attempt(verifySentinel);
    if (containerOwned) await attempt(() => removeResource("container", names.container));
    await attempt(() => removeResource("volume", names.volume));
    await attempt(() => removeResource("network", names.network));
  } finally {
    await attempt(() => removeDirectory(directory));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "PostgreSQL harness cleanup failed");
  }
}

async function runTests(context, ci, setupDocker = docker, testProcess = runProcess) {
  const env = { ...process.env, ...context.environment };
  const secrets = context.secrets ?? [];
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG") || key === "LCM_POSTGRES_URL" || key === "LCM_POSTGRES_CA_FILE") delete env[key];
  }
  if (!ci) {
    const consumerPath = join(context.directory, consumerOwnerFile);
    const testArguments = context.consumerProbe
      ? ["-e", "setInterval(() => undefined, 1_000)"]
      : [
        join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
        "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
      ];
    try {
      return await runSanitizedProcess(process.execPath, testArguments, {
        cwd: repositoryRoot,
        env,
        secrets,
        processRunner: testProcess,
        onSpawn: (child) => {
          const consumer = createOwnerIdentity(child.pid);
          writeFileSync(
            consumerPath,
            `${JSON.stringify({ version: 1, ...consumer })}\n`,
            { mode: 0o600 },
          );
          if (context.consumerProbe) {
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

  await runSanitizedProcess(process.execPath, [
    join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
    "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
    join(repositoryRoot, "test", "postgresql", "signal.integration.ts"),
  ], { cwd: repositoryRoot, env, secrets });
  const envFile = join(context.directory, "runner.env");
  writeFileSync(envFile, Object.entries({
    ...context.environment,
    LCM_TEST_POSTGRES_INNER_CI: "true",
  }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  await setupDocker([
    "create", "--name", context.names.runner,
    ...dockerLabelArgs(ownershipLabels(context.runId, "runner", context.owner)),
    "--network", context.names.network,
    "--env-file", envFile,
    "--volume", `${repositoryRoot}:/workspace:ro`,
    "--volume", `${context.directory}:${context.directory}:ro`,
    "--workdir", "/workspace",
    NODE_IMAGE,
    "node", "/workspace/node_modules/vitest/vitest.mjs", "run",
    "--configLoader", "runner",
    "--config", "/workspace/vitest.postgresql.config.ts",
  ]);
  await runSanitizedProcess("docker", ["start", "--attach", context.names.runner], {
    processRunner: (_command, args, processOptions) => docker(args, processOptions),
    secrets,
  });
}

export async function runHarness(options = {}) {
  const ci = options.ci ?? process.env.GITHUB_ACTIONS === "true";
  let owner;
  try {
    await reclaimProvenOrphans();
    owner = createOwnerIdentity();
  } catch (error) {
    process.stderr.write(`PostgreSQL harness startup failed: ${sanitizedHarnessErrorDetails(error, [])}\n`);
    throw error;
  }
  const runId = randomBytes(16).toString("hex");
  const names = createRunNames(runId);
  const directory = mkdtempSync(join(tmpdir(), "lcm-postgresql-harness-"));
  chmodSync(directory, 0o700);
  const passwords = {
    admin: randomBytes(32).toString("base64url"),
    migrator: randomBytes(32).toString("base64url"),
    runtime: randomBytes(32).toString("base64url"),
  };
  const secrets = [...Object.values(passwords), directory];
  validateRunNames(names, runId);
  const processLifecycle = createProcessLifecycle();
  const setupProcess = processLifecycle.run;
  const setupDocker = (args, processOptions) => setupProcess("docker", args, processOptions);
  let cleanupPromise;
  let sentinelReady = false;
  const cleanup = () => {
    cleanupPromise ??= cleanupHarnessResources({ names, runId, directory, sentinelReady, owner })
      .catch((error) => {
        const details = sanitizedHarnessErrorDetails(error, secrets);
        process.stderr.write(`PostgreSQL harness cleanup failed: ${details}\n`);
        throw error;
      });
    return cleanupPromise;
  };
  let teardownPromise;
  const teardown = () => {
    teardownPromise ??= (async () => {
      await processLifecycle.stop();
      await cleanup();
    })();
    return teardownPromise;
  };
  let exitSignal;
  let signalExitPromise;
  const removeSignalHandlers = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  };
  const onSignal = (signal) => {
    exitSignal ??= signal;
    signalExitPromise ??= teardown()
      .catch(() => undefined)
      .then(() => {
        removeSignalHandlers();
        process.exit(exitSignal === "SIGINT" ? 130 : exitSignal === "SIGHUP" ? 129 : 143);
      });
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
    const publish = ci ? [] : ["--publish", "127.0.0.1::5432"];
    const containerArgs = [
      "create", "--name", names.container,
      ...dockerLabelArgs(ownershipLabels(runId, "database", owner)),
      "--network", names.network,
      "--network-alias", names.alias,
      "--network-alias", names.wrongAlias,
      ...publish,
      "--env", `LCM_POSTGRES_TEMPLATE_MARKER=${POSTGRES_TEMPLATE_MARKER}`,
      "--volume", `${names.volume}:/var/lib/postgresql`,
      "--volume", `${directory}:/run/lcm-harness:ro`,
      "--volume", `${cachedRunInitScript}:/run/lcm-cached-init.sh:ro`,
    ];
    if (!usingCachedTemplate) {
      containerArgs.push(
        "--volume", `${initScript}:/docker-entrypoint-initdb.d/10-lcm-harness.sh:ro`,
        "--env", "POSTGRES_USER=lcm_harness_admin",
        "--env", `POSTGRES_DB=${names.controlDatabase}`,
        "--env", "POSTGRES_PASSWORD_FILE=/run/lcm-private/admin-password",
        "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      );
    }
    containerArgs.push(
      "--entrypoint", "/bin/bash",
      POSTGRES_IMAGE,
      "-ceu",
      "install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/certs /run/lcm-private; install -o postgres -g postgres -m 0600 /run/lcm-harness/server.key /var/lib/postgresql/certs/server.key; install -o postgres -g postgres -m 0644 /run/lcm-harness/server.crt /run/lcm-harness/ca.crt /var/lib/postgresql/certs/; install -o postgres -g postgres -m 0600 /run/lcm-harness/admin-password /run/lcm-harness/migrator-password /run/lcm-harness/runtime-password /run/lcm-harness/run-id /run/lcm-harness/database-name /run/lcm-private/; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/certs/server.crt -c ssl_key_file=/var/lib/postgresql/certs/server.key -c ssl_ca_file=/var/lib/postgresql/certs/ca.crt -c shared_preload_libraries=pg_stat_statements -c listen_addresses=* -c password_encryption=scram-sha-256 -c timezone=UTC",
    );
    await setupDocker(containerArgs);
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
      const logs = await docker(["logs", names.container]).catch(() => ({ stdout: "", stderr: "" }));
      throw Object.assign(error, { stderr: `${error?.stderr ?? ""}\n${logs.stdout}\n${logs.stderr}` });
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
      if (options.runTests) await options.runTests({ runId, names, directory, environment }, ci);
      else await runTests(
        { runId, names, directory, environment, secrets, owner, consumerProbe: options.consumerProbe },
        ci,
        setupDocker,
        setupProcess,
      );
    } catch (error) {
      const logs = await docker(["logs", names.container]).catch(() => ({ stdout: "", stderr: "" }));
      throw Object.assign(error, { stderr: `${error?.stderr ?? ""}\n${logs.stdout}\n${logs.stderr}` });
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
  runHarness(signalProbe ? {
    runTests: async ({ runId }) => {
      process.stderr.write(`PostgreSQL harness signal probe ready: ${runId}\n`);
      await new Promise(() => { setInterval(() => undefined, 1_000); });
    },
  } : { consumerProbe, ci: consumerProbe ? false : undefined }).catch(() => { process.exitCode = 1; });
}
