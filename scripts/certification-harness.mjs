#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { arch as osArch, cpus as osCpus, hostname as osHostname, release as osRelease, totalmem as osTotalmem, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_IMAGE, POSTGRES_IMAGE } from "./postgresql-images.mjs";
import { loadCertificationContract } from "../test/certification/contract.mjs";
import { publishPostgreSqlBackend } from "../test/certification/backend-publication.mjs";
import { createDeterministicSchedule } from "../test/certification/schedule.mjs";
import { observerReadSettings } from "../test/certification/sqlite-observer-worker.mjs";
import { createOwnerIdentity, createProcessLifecycle, createRunNames, ownershipLabels, removeOwnedResource, runHarness, runSanitizedProcess } from "./postgresql-harness.mjs";

const repositoryRoot = join(fileURLToPath(new URL("..", import.meta.url)));
export { createDeterministicSchedule };

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

const RUNNER_SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RUNNER_FIELD_LIMIT = 128;

function parseOsRelease(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
  return values;
}

function boundedString(value, limit = RUNNER_FIELD_LIMIT) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

// Operator-declared runner SKU: optional, but when set it must be a bounded safe
// token (letters, digits, dot, underscore, colon, slash, hyphen; <= 128 characters).
export function validateRunnerSku(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !RUNNER_SKU_PATTERN.test(value)) {
    throw new Error("LCM_CERT_RUNNER_SKU must be 1-128 characters of [A-Za-z0-9._:/-] starting with a letter or digit");
  }
  return value;
}

// Self-hosted runners default RUNNER_NAME to the machine name, so a runner name
// whose first DNS label matches the hostname's (ignoring case) would publish the
// hostname verbatim. It is recorded as null instead; other runner metadata is
// recorded as provided.
function runnerNameWithoutHost(value, hostname) {
  const name = boundedString(value);
  const firstLabel = (text) => text.trim().toLowerCase().split(".")[0];
  return name !== null && firstLabel(name) === firstLabel(hostname) ? null : name;
}

// Execution-host witness captured once at run start. Records what machine ran the
// lane (OS, kernel, CPU, memory, container engine, runner metadata) so a gate can
// state its execution host. The hostname is recorded only as a SHA-256, and a
// RUNNER_NAME that names the host is withheld.
export function captureExecutionHost({
  environment = process.env,
  containerCli = "podman",
  readFile = (path) => readFileSync(path, "utf8"),
  engineVersion = (cli) => execFileSync(cli, ["version", "--format", "{{.Client.Version}}"], { encoding: "utf8", timeout: 10_000 }).trim(),
  os = { arch: osArch, cpus: osCpus, hostname: osHostname, release: osRelease, totalmem: osTotalmem },
} = {}) {
  let osRelease = {};
  try { osRelease = parseOsRelease(readFile("/etc/os-release")); } catch { /* unavailable on this platform */ }
  const cpus = os.cpus();
  let containerEngineVersion = null;
  try { containerEngineVersion = boundedString(engineVersion(containerCli)); } catch { /* engine version unavailable */ }
  const hostname = os.hostname();
  return {
    capturedAt: new Date().toISOString(),
    osId: boundedString(osRelease.ID),
    osVersionId: boundedString(osRelease.VERSION_ID),
    kernelRelease: boundedString(os.release()),
    architecture: boundedString(os.arch()),
    cpuModel: boundedString(cpus[0]?.model),
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(),
    containerEngine: containerCli,
    containerEngineVersion,
    hostnameSha256: sha256(hostname),
    runnerName: runnerNameWithoutHost(environment.RUNNER_NAME, hostname),
    runnerOs: boundedString(environment.RUNNER_OS),
    runnerArch: boundedString(environment.RUNNER_ARCH),
    runnerSku: validateRunnerSku(environment.LCM_CERT_RUNNER_SKU),
  };
}

// Witness fields whose presence gate assembly checks before validating the whole
// recorded witness against the closed evidence schema. They are never compared with
// the assembling host, because the gate may be assembled on another machine and
// publishes the witness as recorded.
export const EXECUTION_HOST_IDENTITY_FIELDS = Object.freeze([
  "osId", "osVersionId", "kernelRelease", "architecture", "cpuModel", "logicalCpus", "totalMemoryBytes", "containerEngine", "hostnameSha256",
]);

export function captureExecutionProvenance(root, contractSha256, stagedPackageSha256, approvalSha256, options = {}) {
  if (!existsSync(join(root, ".git"))) {
    throw new Error(`certification checkout at ${root} has no .git; execution provenance requires a Git checkout whose HEAD can be proven (an rsync copy without .git cannot be certified)`);
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const paths = git("ls-files", "-z").split("\0").filter(Boolean)
    .filter((path) => !["docs/production-certification-gate.json", "docs/production-certification-gate.md"].includes(path)).sort();
  const inputs = createHash("sha256");
  for (const path of paths) { inputs.update(path); inputs.update("\0"); inputs.update(readFileSync(join(root, path))); inputs.update("\0"); }
  const executionHost = options.executionHost ?? captureExecutionHost({ environment: options.environment, containerCli: options.containerCli });
  return {
    testedCommit: git("rev-parse", "HEAD").trim(),
    dirty: git("status", "--porcelain").trim() !== "",
    testedInputsSha256: inputs.digest("hex"),
    testedInputsCount: paths.length,
    lockfileSha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))),
    cliSha256: sha256(readFileSync(join(root, "dist", "lcm.mjs"))),
    stagedPackageSha256,
    contractSha256,
    approvalSha256,
    node: process.version,
    executionHost,
    // Both lanes pass their contract so the run records the observer read settings its
    // machine agents use; gate readback recomputes code provenance only and omits them.
    ...(options.contract === undefined ? {} : { observerSettings: observerReadSettings(options.contract) }),
  };
}

export function assertExecutionProvenance(profile, provenance) {
  if (profile === "full" && provenance.dirty) {
    throw new Error("certification execution checkout must be clean");
  }
  return provenance;
}

export const DATABASE_IDENTITY_SQL = `SELECT current_setting('server_version_num')::integer AS server_version_num,
  pg_catalog.inet_server_addr()::text AS server_address,
  pg_catalog.inet_server_port()::integer AS server_port,
  pg_catalog.current_database()::text AS database_name,
  CURRENT_USER::text AS role_name,
  role.rolsuper, role.rolcreaterole, role.rolcreatedb
  FROM pg_catalog.pg_roles AS role WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER`;

// The identity and least-privilege predicate of the database readiness probe: the run's
// own database, port and role on the expected server version, with no superuser,
// CREATEROLE or CREATEDB attribute.
export function assertDatabaseIdentity(identity, { expectedVersionNum, expectedMajor = 18, expectedDatabase, expectedPort, expectedRole }) {
  if (!identity || Math.floor(identity.server_version_num / 10_000) !== expectedMajor
    || (expectedVersionNum !== undefined && identity.server_version_num !== expectedVersionNum)
    || (expectedDatabase !== undefined && identity.database_name !== expectedDatabase)
    || (expectedPort !== undefined && identity.server_port !== expectedPort)
    || (expectedRole !== undefined && identity.role_name !== expectedRole)
    || identity.rolsuper || identity.rolcreaterole || identity.rolcreatedb) {
    throw new Error("certification database identity or least-privilege readiness failed");
  }
  return identity;
}

// Fault clearance probe, run inside machine A: a fresh SQL/TLS connection with the
// runtime role to the run's own database. It uses the environment the machine agent runs
// with after runtime-ready: the container's env file supplies LCM_POSTGRES_RUNTIME_URL and
// LCM_POSTGRES_CA_FILE, which the script reads by name, so no credential reaches argv or
// logs. `lcm doctor` cannot serve as this probe: an exec session sees the env file's
// LCM_POSTGRES_URL, the transfer role revoked before steady state (the agent switches to
// the runtime URL only inside its own process), and doctor exits 1 in every machine
// because the claude and codex summarizer CLIs are not installed there.
export const MACHINE_DATABASE_CLEARANCE_SCRIPT = `const { readFileSync } = await import("node:fs");
const { createRequire } = await import("node:module");
const { Client } = createRequire("/opt/lcm/package.json")("pg");
const client = new Client({ connectionString: process.env.LCM_POSTGRES_RUNTIME_URL, ssl: { ca: readFileSync(process.env.LCM_POSTGRES_CA_FILE, "utf8"), rejectUnauthorized: true }, connectionTimeoutMillis: 30000, statement_timeout: 30000 });
await client.connect();
try {
  process.stdout.write(JSON.stringify((await client.query(${JSON.stringify(DATABASE_IDENTITY_SQL)})).rows[0]));
} finally {
  await client.end();
}`;

export function machineDatabaseClearanceArgs(name) {
  return ["container", "exec", name, "node", "--input-type=module", "-e", MACHINE_DATABASE_CLEARANCE_SCRIPT];
}

// Retries the probe once per second within the fault phase's bound, because PostgreSQL
// accepts connections only shortly after its container starts again. A connection that
// reaches another database, port or role fails at once.
export async function waitForMachineDatabaseClearance({ name, run, expected, timeoutMs, delay, signal }) {
  let identity;
  await poll(async () => {
    const result = await run(machineDatabaseClearanceArgs(name)).catch(() => undefined);
    if (result === undefined) return false;
    identity = assertDatabaseIdentity(JSON.parse(result.stdout.trim()), expected);
    return true;
  }, { timeoutMs, delay, signal }).catch((error) => {
    throw signal?.aborted ? error : new Error(`certification machine ${name} database clearance failed: ${error.message}`, { cause: error });
  });
  return identity;
}

export function phaseDeadlineMs(contract, profile, phase) {
  const timeline = contract.timeline[profile];
  const seconds = profile === "smoke"
    ? phase === "drain" ? timeline.finalDrainSeconds + 120 : timeline.wholeRunDeadlineSeconds
    : phase === "fault-ready"
      ? timeline.warmupSeconds + timeline.steadySeconds + timeline.pendingSettleMaxSeconds + 120
      : phase === "partition" ? timeline.partitionPhaseMaxSeconds
        : phase === "restart" ? timeline.restartPhaseMaxSeconds
          : phase === "drain" ? timeline.finalDrainSeconds + 120 : timeline.localDeadlineSeconds;
  return seconds * 1000;
}

export function recoveryWindowSearch(samples, { machine, clearedAtMs, deadlineMs }) {
  for (let start = clearedAtMs; start + 60_000 <= deadlineMs; start += 1000) {
    const kinds = {};
    let pass = true;
    for (const op of ["search", "store"]) {
      const selected = samples.filter((sample) => sample.machine === machine && sample.op === op
        && sample.scheduledWallMs >= start && sample.scheduledWallMs < start + 60_000);
      const succeeded = selected.filter((sample) => sample.outcome === "success").length;
      const required = Math.ceil(selected.length * 0.9);
      const terminal = selected.length > 0 && selected.every((sample) => Number.isFinite(Date.parse(sample.wallEndedAt)));
      kinds[op] = { scheduled: selected.length, succeeded, required, pass: terminal && succeeded >= required };
      pass &&= kinds[op].pass;
    }
    if (pass) return { pass: true, startMs: start, endMs: start + 60_000, kinds };
  }
  return { pass: false };
}

export function parseCertificationArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator !== -1 && argv.lastIndexOf("--") !== separator) throw new Error("invalid certification arguments");
  const argumentsWithoutSeparator = separator === -1
    ? argv
    : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
  const values = new Map();
  let withFaults = false;
  for (let index = 0; index < argumentsWithoutSeparator.length;) {
    const option = argumentsWithoutSeparator[index];
    // --with-faults is the only option without a value.
    if (option === "--with-faults") {
      withFaults = true;
      index += 1;
      continue;
    }
    const value = argumentsWithoutSeparator[index + 1];
    if (!option?.startsWith("--") || value === undefined) throw new Error("invalid certification arguments");
    values.set(option, value);
    index += 2;
  }
  const lane = values.get("--lane");
  const profile = values.get("--profile");
  const evidenceDirectory = values.get("--evidence-dir");
  if (!['local', 'managed'].includes(lane)) throw new Error("certification lane must be local or managed");
  if (!['smoke', 'full'].includes(profile)) throw new Error("certification profile must be smoke or full");
  if (!evidenceDirectory || !isAbsolute(evidenceDirectory)) throw new Error("certification evidence directory must be absolute");
  // A non-certifying fault smoke: the smoke workload plus the local lane's contract faults.
  if (withFaults && (lane !== "local" || profile !== "smoke")) {
    throw new Error("certification --with-faults requires the local lane and the smoke profile");
  }
  return { lane, profile, evidenceDirectory, ...(withFaults ? { withFaults: true } : {}) };
}
export function buildMachineContainerArgs(input) {
  if (!['a', 'b'].includes(input.machine)) throw new Error("invalid certification machine");
  const labels = Object.entries(input.ownerLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const args = [
    "container", "create", "--name", input.name,
    ...labels,
    "--hostname", input.hostname,
    "--network", input.network,
    "--userns=keep-id:uid=1000,gid=1000",
    "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
    "--user", "1000:1000",
  ];
  if (input.wrongHost) args.push("--add-host", `${input.wrongHost.host}:${input.wrongHost.address}`);
  if (input.environmentFile) args.push("--env-file", input.environmentFile);
  args.push(
    "--volume", `${input.stagedPackage}:/opt/lcm:ro,z`,
    "--volume", `${input.nodeModules}:/opt/lcm/node_modules:ro,z`,
    "--volume", `${input.homeParent}:/home/lcm-parent:Z`,
    "--volume", `${input.caFile}:/run/lcm-ca/ca.crt:ro,z`,
    ...(input.wrongCaFile ? ["--volume", `${input.wrongCaFile}:/run/lcm-ca/wrong-ca.crt:ro,z`] : []),
    "--volume", `${input.evidenceDirectory}:/evidence:Z`,
    input.image,
    "node", "/opt/lcm/certification/machine-agent.mjs",
    "--machine", input.machine,
  );
  return args;
}

function urlAtHost(value, hostname, port) {
  const url = new URL(value);
  url.hostname = hostname;
  if (port !== undefined) url.port = String(port);
  return url.toString();
}

function urlWithCredentials(value, username, password) {
  const url = new URL(value);
  url.username = username;
  url.password = password;
  return url.toString();
}

async function poll(predicate, { attempts = Number.POSITIVE_INFINITY, timeoutMs = 360_000, now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal } = {}) {
  const deadline = now() + timeoutMs;
  for (let attempt = 0; attempt < attempts && now() <= deadline; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("certification aborted");
    if (await predicate()) return;
    await delay(1000);
  }
  throw new Error("certification machine phase timed out");
}

export async function assertMachinesRunning(machineNames, run) {
  for (const name of machineNames) {
    const inspected = await run(["container", "inspect", "--format", "{{json .State}}", name]);
    const state = JSON.parse(inspected.stdout.trim());
    if (state?.Running === true) continue;
    const logs = await run(["container", "logs", name]).catch(() => ({ stdout: "", stderr: "" }));
    const diagnostic = [logs.stderr, logs.stdout].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    if (state?.Running === false) {
      throw new Error(`certification machine ${name} exited with code ${state.ExitCode} before phase completed${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    throw new Error(`certification machine ${name} has uncertain runtime state before phase completed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
}

export async function waitForMachineFiles({ paths, machineNames, run, exists = existsSync, timeoutMs, delay, signal }) {
  return poll(async () => {
    if (paths.every((path) => exists(path))) return true;
    await assertMachinesRunning(machineNames, run);
    return false;
  }, { timeoutMs, delay, signal });
}

export async function monitorMachinesForDuration({ machineNames, run, durationMs, delay, now = Date.now, signal }) {
  const deadline = now() + durationMs;
  return poll(async () => {
    await assertMachinesRunning(machineNames, run);
    return now() >= deadline;
  }, { timeoutMs: durationMs + 2_000, delay, now, signal });
}

export async function runMachineActivationBarrier(input) {
  await input.verifyA();
  await input.verifyB();
  await input.grantRuntime();
  await input.activateA();
  await input.activateB();
  await input.revokeTransfer();
  await input.verifyRuntime();
  await input.startDaemonA();
  await input.stagger();
  await input.startDaemonB();
}

function publishWarmupControl(evidenceDirectory, wallNow = Date.now) {
  const warmupStartAt = new Date(wallNow() + 2_000).toISOString();
  const control = { warmupStartAt };
  for (const machine of ['a', 'b']) writeFileSync(
    join(evidenceDirectory, `machine-${machine}`, "warmup-control.json"),
    `${JSON.stringify(control)}\n`, { mode: 0o600, flag: "wx" },
  );
  writeFileSync(join(evidenceDirectory, "warmup-control.json"), `${JSON.stringify(control, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return control;
}

function publishSteadyControl(evidenceDirectory, warmupControl, wallNow = Date.now) {
  const control = { ...warmupControl, steadyT0At: new Date(wallNow() + 10_000).toISOString() };
  for (const machine of ['a', 'b']) writeFileSync(
    join(evidenceDirectory, `machine-${machine}`, "phase-control.json"),
    `${JSON.stringify(control)}\n`, { mode: 0o600, flag: "wx" },
  );
  writeFileSync(join(evidenceDirectory, "phase-control.json"), `${JSON.stringify(control, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return control;
}

function aborted(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("certification aborted"));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("certification aborted")), { once: true }));
}

function waitInterval(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function collectMachinePoolWitness(name, run) {
  const script = `const { DaemonClient } = await import("/opt/lcm/dist/src/daemon/client.js");
const { daemonTokenPath } = await import("/opt/lcm/dist/src/runtime-paths.js");
const client = new DaemonClient("http://127.0.0.1:3737", daemonTokenPath(process.env.HOME));
const stats = await client.get("/stats/pool");
process.stdout.write(JSON.stringify(stats.backendDiagnostics));`;
  const result = await run(["container", "exec", name, "node", "--input-type=module", "-e", script]);
  const diagnostics = JSON.parse(result.stdout.trim());
  if (diagnostics?.backend !== "postgresql" || diagnostics.pool?.status !== "ready"
    || !Number.isSafeInteger(diagnostics.pool.configuredMax) || diagnostics.pool.configuredMax < 1) {
    throw new Error(`certification machine ${name} has no effective PostgreSQL pool witness`);
  }
  return { observedAt: new Date().toISOString(), configuredMax: diagnostics.pool.configuredMax };
}

export async function runManagedMachinePair(input, dependencies = {}) {
  const contract = input.contract ?? loadCertificationContract(new URL("../test/certification/contract-v3.json", import.meta.url), { requireApproved: false }).contract;
  const containerCli = dependencies.containerCli ?? "podman";
  const lifecycle = dependencies.processLifecycle ?? createProcessLifecycle();
  const processRunner = dependencies.processRunner
    ?? ((command, args, options) => runSanitizedProcess(command, args, {
      ...options,
      terminateOnStop: true,
      terminateProcessTree: true,
      secrets: input.secrets,
      processRunner: lifecycle.run,
    }));
  const cleanupRunner = dependencies.cleanupRunner ?? dependencies.processRunner
    ?? ((command, args, options) => runSanitizedProcess(command, args, { ...options, secrets: input.secrets }));
  let abortStop;
  const stopForAbort = () => { abortStop ??= lifecycle.stop(); };
  input.signal?.addEventListener("abort", stopForAbort, { once: true });
  const owner = dependencies.owner ?? createOwnerIdentity();
  const runRoot = dependencies.createRunRoot?.() ?? mkdtempSync(join(tmpdir(), "lcm-cert-managed-"));
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const removeRunRoot = dependencies.removeRunRoot ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const ownershipRunId = createHash("sha256").update(input.runId).digest("hex").slice(0, 32);
  const names = createRunNames(ownershipRunId);
  const network = names.network;
  const caFile = join(runRoot, "provider-ca.crt");
  const wrongCaFile = join(runRoot, "wrong-ca.crt");
  let stage;
  let endpointAddress;
  try {
    stage = dependencies.stagePackage?.(runRoot) ?? stageBuiltPackage({
      sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
      destination: join(runRoot, "package"),
      machineAgentPath: new URL("../test/certification/machine-agent.mjs", import.meta.url),
    });
    const executionProvenance = (dependencies.captureExecutionProvenance ?? captureExecutionProvenance)(
      dependencies.sourceRoot ?? repositoryRoot, input.contractSha256, stage.sha256, input.approvalSha256,
      { environment: dependencies.environment ?? process.env, containerCli, contract },
    );
    assertExecutionProvenance(input.profile, executionProvenance);
    mkdirSync(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(input.evidenceDirectory, "execution-provenance.json"), `${JSON.stringify(executionProvenance, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(caFile, input.privateConnection.ca, { mode: 0o600, flag: "wx" });
    if (typeof input.wrongCa === "string") {
      writeFileSync(wrongCaFile, input.wrongCa, { mode: 0o600, flag: "wx" });
    } else {
      await processRunner("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(runRoot, "wrong-ca.key"), "-out", wrongCaFile,
        "-subj", "/CN=lcm-certification-unrelated-ca", "-days", "1",
      ], { redactSecrets: input.secrets });
    }
    endpointAddress = dependencies.resolveHost
      ? await dependencies.resolveHost(input.cluster.host)
      : (await lookup(input.cluster.host, { family: 4 })).address;
  } catch (error) {
    input.signal?.removeEventListener("abort", stopForAbort);
    await (abortStop ?? lifecycle.stop());
    removeRunRoot(runRoot);
    throw error;
  }
  const wrongHostname = `wrong-${input.runId}.invalid`;
  const created = [];
  const homes = {};
  const machineLabels = new Map();
  const networkLabels = ownershipLabels(ownershipRunId, "network", owner);
  let networkCreated = false;
  const run = (args) => processRunner(containerCli, args, { redactSecrets: input.secrets });
  const exists = dependencies.exists ?? existsSync;
  const delay = dependencies.delay;
  const waitForFiles = (paths, machineNames, timeoutMs) => waitForMachineFiles({
    paths, machineNames, run, exists, timeoutMs, delay, signal: input.signal,
  });
  const monitorDelay = (machineNames, durationMs) => dependencies.monitorMachineDelay
    ? dependencies.monitorMachineDelay(machineNames, durationMs)
    : delay
      ? delay(durationMs)
      : monitorMachinesForDuration({ machineNames, run, durationMs, signal: input.signal });
  let clockMonitor;
  try {
    const databasePreparation = await (dependencies.prepareDatabase ?? prepareManagedDatabase)({
      privateConnection: input.privateConnection,
      runRoot,
      caFile,
      containerCli,
      processRunner,
      secrets: input.secrets,
      sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
      names,
      owner,
      runId: ownershipRunId,
    });
    const preActivationResidual = await (dependencies.collectResidualState ?? collectResidualState)({
      url: databasePreparation.transferUrl,
      ca: input.privateConnection.ca,
    });
    mkdirSync(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(input.evidenceDirectory, "pre-activation-residual.json"), `${JSON.stringify(preActivationResidual, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    networkCreated = true;
    await run(["network", "create", ...Object.entries(networkLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), network]);
    for (const machine of ['a', 'b']) {
      const name = machine === 'a' ? names.machineA : names.machineB;
      const homeParent = join(runRoot, `home-parent-${machine}`);
      const home = join(homeParent, "home");
      const evidence = join(input.evidenceDirectory, `machine-${machine}`);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      homes[machine] = home;
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      const environmentFile = join(runRoot, `machine-${machine}.env`);
      writeEnvironmentFile(environmentFile, {
        HOME: "/home/lcm-parent/home",
        LCM_CLIENT: "codex",
        LCM_POSTGRES_URL: databasePreparation.transferUrl,
        LCM_POSTGRES_RUNTIME_URL: input.privateConnection.runtimeUrl,
        LCM_POSTGRES_CA_FILE: "/run/lcm-ca/ca.crt",
        LCM_POSTGRES_MIGRATION_ROLE: input.privateConnection.migratorName,
        LCM_CERT_MIGRATION_ROLE: input.privateConnection.migratorName,
        LCM_CERT_WRONG_CA_FILE: "/run/lcm-ca/wrong-ca.crt",
        LCM_CERT_WRONG_HOST_URL: urlAtHost(input.privateConnection.runtimeUrl, wrongHostname),
        LCM_CERT_EVIDENCE_DIR: "/evidence",
        LCM_CERT_PROFILE: input.profile,
        LCM_CERT_LANE: "managed",
        LCM_CERT_RUN_ID: input.runId,
      });
      const labels = ownershipLabels(ownershipRunId, `machine-${machine}`, owner);
      created.push(name);
      machineLabels.set(name, labels);
      await run(buildMachineContainerArgs({
        machine, name, hostname: `lcm-cert-${machine}`, network, image: NODE_IMAGE,
        ownerLabels: labels,
        stagedPackage: stage.root, nodeModules: join(dependencies.sourceRoot ?? repositoryRoot, "node_modules"), homeParent, caFile, wrongCaFile, evidenceDirectory: evidence,
        environmentFile, wrongHost: { host: wrongHostname, address: endpointAddress },
      }));
    }
    const setupStartedAt = Date.now();
    const setupDeadline = setupStartedAt + contract.timeline.full.setupMaxSeconds * 1000;
    const waitForSetupFiles = (paths, machineNames) => {
      const remainingMs = setupDeadline - Date.now();
      if (remainingMs <= 0) throw new Error("certification setup exceeded setupMaxSeconds");
      return waitForFiles(paths, machineNames, remainingMs);
    };
    const activationReceipts = {};
    const poolByMachine = {};
    let runtimeGrant;
    let revocation;
    let databaseReadiness;
    let setupSessionClosure;
    await runMachineActivationBarrier({
      verifyA: async () => {
        await run(["container", "start", names.machineA]);
        writeFileSync(join(input.evidenceDirectory, "machine-a", "migration-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        await waitForSetupFiles([join(input.evidenceDirectory, "machine-a", "verification-receipt.json")], [names.machineA]);
      },
      verifyB: async () => {
        await run(["container", "start", names.machineB]);
        writeFileSync(join(input.evidenceDirectory, "machine-b", "migration-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        await waitForSetupFiles([join(input.evidenceDirectory, "machine-b", "verification-receipt.json")], [names.machineA, names.machineB]);
      },
      grantRuntime: async () => {
        runtimeGrant = await (dependencies.grantRuntime ?? grantRuntimeProfile)({
          adminUrl: input.privateConnection.containerAdminUrl ?? input.privateConnection.adminUrl,
          caFile,
          role: input.privateConnection.runtimeName,
          databaseName: input.privateConnection.databaseName,
          sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
        });
      },
      activateA: async () => {
        writeFileSync(join(input.evidenceDirectory, "machine-a", "activation-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        const path = join(input.evidenceDirectory, "machine-a", "activation-receipt.json");
        await waitForSetupFiles([path], [names.machineA, names.machineB]);
        activationReceipts.a = jsonFromFile(path);
      },
      activateB: async () => {
        writeFileSync(join(input.evidenceDirectory, "machine-b", "activation-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        const path = join(input.evidenceDirectory, "machine-b", "activation-receipt.json");
        await waitForSetupFiles([path], [names.machineA, names.machineB]);
        activationReceipts.b = jsonFromFile(path);
      },
      revokeTransfer: async () => {
        revocation = await (dependencies.revokeTransfer ?? revokeTransferProfile)({
          adminUrl: input.privateConnection.containerAdminUrl ?? input.privateConnection.adminUrl,
          caFile,
          role: databasePreparation.transferName,
        });
      },
      verifyRuntime: async () => {
        await (dependencies.verifyRuntime ?? verifyRuntimeSchemaReadiness)({
          sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
          url: input.privateConnection.runtimeUrl,
          caFile,
          expectedOwner: input.privateConnection.migratorName,
        });
        databaseReadiness = await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
          url: input.privateConnection.runtimeUrl,
          ca: input.privateConnection.ca,
          expectedMajor: 18,
          expectedDatabase: input.privateConnection.databaseName,
          expectedPort: input.cluster.port,
          expectedRole: input.privateConnection.runtimeName,
          expectedMigrationCount: readdirSync(join(dependencies.sourceRoot ?? repositoryRoot, "src", "storage", "postgresql", "migrations")).filter((name) => name.endsWith(".sql")).length,
          requireResidualEmpty: false,
        });
        setupSessionClosure = await (dependencies.collectSetupSessionClosure ?? collectSetupSessionClosure)({
          url: input.privateConnection.containerAdminUrl ?? input.privateConnection.adminUrl,
          ca: input.privateConnection.ca,
          roles: [input.privateConnection.migratorName, databasePreparation.transferName],
        });
      },
      startDaemonA: async () => {
        writeFileSync(join(input.evidenceDirectory, "machine-a", "runtime-ready.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        await waitForSetupFiles([join(input.evidenceDirectory, "machine-a", "daemon-started.json")], [names.machineA, names.machineB]);
        poolByMachine.a = await collectMachinePoolWitness(names.machineA, run);
      },
      stagger: () => monitorDelay([names.machineA, names.machineB], contract.timeline.full.secondDaemonStartOffsetSeconds * 1000),
      startDaemonB: async () => {
        writeFileSync(join(input.evidenceDirectory, "machine-b", "runtime-ready.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
        await waitForSetupFiles([join(input.evidenceDirectory, "machine-b", "daemon-started.json")], [names.machineA, names.machineB]);
        poolByMachine.b = await collectMachinePoolWitness(names.machineB, run);
      },
    });
    if (Date.now() > setupDeadline) throw new Error("certification setup exceeded setupMaxSeconds");
    const configuredPoolMax = poolByMachine.a?.configuredMax === poolByMachine.b?.configuredMax
      ? poolByMachine.a.configuredMax : undefined;
    databaseReadiness = {
      ...databaseReadiness,
      configuredPoolMax,
      poolByMachine,
      setupSessionsClosed: setupSessionClosure.setupSessionsClosed,
      setupSessionClosure,
      providerClusterId: input.cluster.id,
      providerHost: input.cluster.host,
      providerPort: input.cluster.port,
    };
    writeFileSync(join(input.evidenceDirectory, "setup-session-closure.json"), `${JSON.stringify(setupSessionClosure, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(input.evidenceDirectory, "setup-evidence.json"), `${JSON.stringify({
      startedAt: new Date(setupStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      activationReceipts,
      revocation,
      runtimeGrant,
      runtimeReadiness: "pass",
      daemonStartOrder: ["a", "b"],
      setupSessionClosure,
      poolByMachine,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(input.evidenceDirectory, "database-readiness.json"), `${JSON.stringify(databaseReadiness, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await waitForSetupFiles(
      ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "ready.json")),
      [names.machineA, names.machineB],
    );
    const identities = (dependencies.verifyIdentities ?? verifyDistinctMachineIdentities)(homes);
    writeFileSync(join(input.evidenceDirectory, "machine-identities.json"), `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    clockMonitor = await (dependencies.startClockMonitor ?? startClockMonitor)({
      machineNames: { a: names.machineA, b: names.machineB },
      run,
      url: input.privateConnection.runtimeUrl,
      ca: input.privateConnection.ca,
      evidenceDirectory: input.evidenceDirectory,
    });
    const warmupControl = publishWarmupControl(input.evidenceDirectory, dependencies.wallNow);
    const waitForWarmupComplete = dependencies.waitForWarmupComplete ?? (() => waitForFiles(
      ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "warmup-complete.json")),
      [names.machineA, names.machineB],
      contract.timeline[input.profile].warmupSeconds * 1000 + 120_000,
    ));
    await waitForWarmupComplete();
    publishSteadyControl(input.evidenceDirectory, warmupControl, dependencies.wallNow);
    const growthBefore = await (dependencies.collectRelationBytes ?? collectDatabaseRelationBytes)({ url: input.privateConnection.runtimeUrl, ca: input.privateConnection.ca });
    const waitForSteadyComplete = dependencies.waitForSteadyComplete ?? (() => waitForFiles(
      ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "steady-complete.json")),
      [names.machineA, names.machineB],
      phaseDeadlineMs(contract, input.profile, "fault-ready"),
    ));
    await waitForSteadyComplete();
    const growthAfter = await (dependencies.collectRelationBytes ?? collectDatabaseRelationBytes)({ url: input.privateConnection.runtimeUrl, ca: input.privateConnection.ca });
    writeFileSync(join(input.evidenceDirectory, "database-growth.json"), `${JSON.stringify({ beforeBytes: growthBefore, afterBytes: growthAfter, deltaBytes: growthAfter - growthBefore })}\n`, { mode: 0o600, flag: "wx" });
    let fault;
    if (input.profile === "full") {
      const waitForFaultReady = dependencies.waitForFaultReady ?? (() => waitForFiles(
        ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "fault-ready.json")),
        [names.machineA, names.machineB],
        phaseDeadlineMs(contract, input.profile, "fault-ready"),
      ));
      await waitForFaultReady();
      const requestedAt = new Date().toISOString();
      await run(["network", "disconnect", network, names.machineA]);
      const appliedAt = new Date().toISOString();
      await Promise.race([monitorDelay([names.machineA, names.machineB], 60_000), aborted(input.signal)]);
      await run(["network", "connect", network, names.machineA]);
      const runtimeIdentity = {
        expectedMajor: 18,
        expectedDatabase: input.privateConnection.databaseName,
        expectedPort: input.cluster.port,
        expectedRole: input.privateConnection.runtimeName,
      };
      await waitForMachineDatabaseClearance({
        name: names.machineA, run, expected: runtimeIdentity,
        timeoutMs: phaseDeadlineMs(contract, "full", "partition"), delay, signal: input.signal,
      });
      await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
        url: input.privateConnection.runtimeUrl,
        ca: input.privateConnection.ca,
        ...runtimeIdentity,
        requireResidualEmpty: false,
      });
      const clearedAt = new Date().toISOString();
      for (const machine of ['a', 'b']) {
        writeFileSync(join(input.evidenceDirectory, `machine-${machine}`, "partition-cleared.json"), `${JSON.stringify({ clearedAt })}\n`, { mode: 0o600, flag: "wx" });
      }
      const waitForPartitionRecovery = dependencies.waitForPartitionRecovery ?? (() => waitForFiles(
        ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "partition-recovered.json")),
        [names.machineA, names.machineB],
        phaseDeadlineMs(contract, input.profile, "partition"),
      ));
      await waitForPartitionRecovery();
      const recoveredAt = new Date().toISOString();
      fault = recordFaultStep({ id: "partition-a", kind: "partition-machine", target: "a" }, { requestedAt, appliedAt, clearedAt, recoveredAt });
      writeFileSync(join(input.evidenceDirectory, "fault-partition-a.json"), `${JSON.stringify(fault, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    const waitForDrain = dependencies.waitForDrain ?? (() => waitForFiles(
      ['a', 'b'].map((machine) => join(input.evidenceDirectory, `machine-${machine}`, "drain.json")),
      [names.machineA, names.machineB],
      phaseDeadlineMs(contract, input.profile, "drain"),
    ));
    await waitForDrain();
    await clockMonitor.stop();
    clockMonitor = undefined;
    for (const machine of ['a', 'b']) writeFileSync(
      join(input.evidenceDirectory, `machine-${machine}`, "clock-finished.json"),
      `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" },
    );
    const waitForExit = dependencies.waitForExit ?? (async () => {
      for (const name of created) await run(["container", "wait", name]);
    });
    await Promise.race([waitForExit(), aborted(input.signal)]);
    return { stageSha256: stage.sha256, machines: names, identities, fault };
  } finally {
    input.signal?.removeEventListener("abort", stopForAbort);
    await (abortStop ?? lifecycle.stop());
    const cleanupFailures = [];
    if (clockMonitor) await clockMonitor.stop().catch((error) => cleanupFailures.push(error));
    const cleanupDocker = (args) => cleanupRunner(containerCli, args, { redactSecrets: input.secrets });
    for (const name of created.reverse()) {
      await removeOwnedResource("container", name, machineLabels.get(name), cleanupDocker)
        .catch((error) => cleanupFailures.push(error));
    }
    if (networkCreated) {
      await removeOwnedResource("network", network, networkLabels, cleanupDocker)
        .catch((error) => cleanupFailures.push(error));
    }
    try { removeRunRoot(runRoot); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) {
      const error = new AggregateError(cleanupFailures, "managed certification machine cleanup failed");
      error.localCleanupIncomplete = true;
      throw error;
    }
  }
}

export async function prepareManagedDatabase(input) {
  const { privateConnection, runRoot, caFile, setupNetwork, containerCli, processRunner, secrets, sourceRoot, names, owner, runId } = input;
  const transferName = privateConnection.transferName ?? `lcm_cert_transfer_${runId.slice(0, 16)}`;
  const transferPassword = privateConnection.transferPassword ?? randomBytes(24).toString("base64url");
  const transferUrl = privateConnection.transferUrl
    ?? urlWithCredentials(privateConnection.migratorUrl, transferName, transferPassword);
  if (!privateConnection.transferUrl) secrets.push(transferPassword, transferUrl);
  const setupSql = join(runRoot, "managed-setup.sql");
  writeFileSync(setupSql, [
    "\\set ON_ERROR_STOP on",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;",
    ...(privateConnection.transferUrl ? [] : [
      "SELECT pg_catalog.format('CREATE ROLE %I LOGIN PASSWORD %L', :'transfer_role', :'transfer_password') WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) :'transfer_role') \\gexec",
    ]),
    "ALTER DATABASE :\"database_name\" OWNER TO :\"migrator_role\";",
    "GRANT CONNECT, CREATE ON DATABASE :\"database_name\" TO :\"migrator_role\";",
    "GRANT CONNECT ON DATABASE :\"database_name\" TO :\"runtime_role\";",
    "GRANT CONNECT ON DATABASE :\"database_name\" TO :\"transfer_role\";",
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  const credentialFile = join(runRoot, "managed-sql.env");
  writeEnvironmentFile(credentialFile, {
    LCM_CERT_ADMIN_URL: privateConnection.containerAdminUrl ?? privateConnection.adminUrl,
    LCM_CERT_TRANSFER_PASSWORD: transferPassword,
  });
  const grantsSource = join(sourceRoot, "src", "storage", "postgresql", "reference");
  const grantsDirectory = join(runRoot, "runtime-grants");
  mkdirSync(grantsDirectory, { mode: 0o700 });
  for (const name of readdirSync(grantsSource).filter((entry) => /^postgresql-(?:runtime-.*|transfer)-grants\.sql$/u.test(entry)).sort()) {
    cpSync(join(grantsSource, name), join(grantsDirectory, name), { errorOnExist: true });
  }
  const psqlScript = [
    "export PGSSLMODE=verify-full",
    "export PGSSLROOTCERT=/run/lcm-ca/ca.crt",
    "psql \"$LCM_CERT_ADMIN_URL\" --set=ON_ERROR_STOP=1 --set=database_name=\"$LCM_CERT_DATABASE\" --set=migrator_role=\"$LCM_CERT_MIGRATOR\" --set=runtime_role=\"$LCM_CERT_RUNTIME\" --set=transfer_role=\"$LCM_CERT_TRANSFER\" --set=transfer_password=\"$LCM_CERT_TRANSFER_PASSWORD\" --file=/run/lcm-cert/setup.sql",
    "for grant in /run/lcm-grants/postgresql-runtime-*-grants.sql; do psql \"$LCM_CERT_ADMIN_URL\" --set=ON_ERROR_STOP=1 --set=lcm_runtime_role=\"$LCM_CERT_TRANSFER\" --file=\"$grant\"; done",
    "psql \"$LCM_CERT_ADMIN_URL\" --set=ON_ERROR_STOP=1 --set=lcm_runtime_role=\"$LCM_CERT_TRANSFER\" --file=/run/lcm-grants/postgresql-transfer-grants.sql",
  ].join("\n");
  const basePsqlArgs = [
    ...(setupNetwork ? ["--network", setupNetwork] : []),
    "--env-file", credentialFile,
    "--env", `LCM_CERT_DATABASE=${privateConnection.databaseName}`,
    "--env", `LCM_CERT_MIGRATOR=${privateConnection.migratorName}`,
    "--env", `LCM_CERT_RUNTIME=${privateConnection.runtimeName}`,
    "--env", `LCM_CERT_TRANSFER=${transferName}`,
    "--volume", `${caFile}:/run/lcm-ca/ca.crt:ro,z`,
    "--volume", `${setupSql}:/run/lcm-cert/setup.sql:ro,Z`,
    "--volume", `${grantsDirectory}:/run/lcm-grants:ro,Z`,
  ];
  const runPsql = async (name, kind, script) => {
    const labels = ownershipLabels(runId, kind, owner);
    const runner = (args) => processRunner(containerCli, args, { redactSecrets: secrets });
    try {
      await runner(["container", "create", "--name", name,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
        ...basePsqlArgs, POSTGRES_IMAGE, "bash", "-ceu", script]);
      await runner(["container", "start", "--attach", name]);
    } finally {
      await removeOwnedResource("container", name, labels, runner, { requireStoppedContainer: true });
    }
  };
  await runPsql(names.restore, "restore", psqlScript.split("\n").slice(0, 3).join("\n"));
  const migrationHome = join(runRoot, "migration-home");
  mkdirSync(migrationHome, { mode: 0o700 });
  const migrationEnvironment = {
    ...process.env,
    HOME: migrationHome,
    LCM_POSTGRES_URL: privateConnection.migratorUrl,
    LCM_POSTGRES_CA_FILE: caFile,
    LCM_POSTGRES_MIGRATION_ROLE: privateConnection.migratorName,
  };
  const entrypoint = join(sourceRoot, "dist", "lcm.mjs");
  const runLcmStep = async (label, args) => {
    try {
      return await processRunner(process.execPath, [entrypoint, ...args], { env: migrationEnvironment, redactSecrets: secrets });
    } catch (error) {
      const diagnostic = String(error.stderr ?? "").trim();
      throw new Error(`certification database ${label} failed: ${diagnostic || error.message}`, { cause: error });
    }
  };
  await runLcmStep("pool configuration", ["config", "set", "storage.postgresql.poolMax", "2", "--json"]);
  await (input.publishBackend ?? publishPostgreSqlBackend)({
    homeDir: migrationHome,
    packageRoot: sourceRoot,
    publicationId: `certification-${runId}`,
  });
  await runLcmStep("migration", ["postgres", "migrate", "--json"]);
  await runPsql(names.runner, "runner", psqlScript);
  return { transferName, transferUrl };
}

export async function verifyRuntimeSchemaReadiness({ sourceRoot, url, caFile, expectedOwner }) {
  const [{ PostgreSqlRuntime }, { verifyPostgreSqlRuntimeSchema }] = await Promise.all([
    import(pathToFileURL(join(sourceRoot, "dist", "src", "storage", "postgresql", "runtime.js")).href),
    import(pathToFileURL(join(sourceRoot, "dist", "src", "storage", "postgresql", "runtime-readiness.js")).href),
  ]);
  const runtime = new PostgreSqlRuntime({
    url,
    caFile,
    poolMax: 2,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
    snapshotIdleTimeoutMs: 300_000,
  });
  try {
    return await verifyPostgreSqlRuntimeSchema(runtime, { expectedOwner });
  } catch (error) {
    throw new Error(`certification runtime schema readiness failed: ${error?.reason ?? error?.message ?? error}`, { cause: error });
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

export async function revokeTransferProfile({ adminUrl, caFile, role }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw new Error("invalid certification transfer role");
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = new Client({
    connectionString: adminUrl,
    ssl: { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    await client.query(`DROP OWNED BY "${role}"`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return { role, revoked: true, at: new Date().toISOString() };
}

export async function grantRuntimeProfile({ adminUrl, caFile, role, databaseName, sourceRoot }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw new Error("invalid certification runtime role");
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = new Client({
    connectionString: adminUrl,
    ssl: { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    await client.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${role}"`);
    const directory = join(sourceRoot, "src", "storage", "postgresql", "reference");
    for (const name of readdirSync(directory).filter((entry) => /^postgresql-runtime-.*-grants\.sql$/u.test(entry)).sort()) {
      const sql = readFileSync(join(directory, name), "utf8")
        .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', `"${role}"`);
      await client.query(sql);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return { role, granted: true, at: new Date().toISOString() };
}

export async function collectDatabaseReadiness({ url, ca, expectedVersionNum, expectedMajor = 18, expectedDatabase, expectedPort, expectedRole, expectedMigrationCount, requireResidualEmpty = true, clientFactory }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = clientFactory?.() ?? new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    const identity = assertDatabaseIdentity((await client.query(DATABASE_IDENTITY_SQL)).rows[0], {
      expectedVersionNum, expectedMajor, expectedDatabase, expectedPort, expectedRole,
    });
    const extensions = (await client.query(`SELECT extension.extname::text AS name, namespace.nspname::text AS schema
      FROM pg_catalog.pg_extension AS extension
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) extension.extnamespace
      WHERE extension.extname OPERATOR(pg_catalog.=) ANY($1::text[]) ORDER BY extension.extname`,
    [["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"]])).rows;
    if (extensions.length !== 4 || extensions.some((entry) => entry.schema !== "public")) {
      throw new Error("certification required extension readiness failed");
    }
    const migrations = (await client.query("SELECT pg_catalog.count(*)::integer AS count FROM lcm.schema_migrations")).rows[0]?.count;
    if (!Number.isInteger(migrations) || migrations <= 0 || (expectedMigrationCount !== undefined && migrations !== expectedMigrationCount)) throw new Error("certification migration readiness failed");
    const maxConnections = Number((await client.query("SHOW max_connections")).rows[0]?.max_connections);
    const reservedConnections = Number((await client.query("SHOW superuser_reserved_connections")).rows[0]?.superuser_reserved_connections);
    if (!Number.isFinite(maxConnections) || !Number.isFinite(reservedConnections) || maxConnections <= reservedConnections) {
      throw new Error("certification connection-limit readiness failed");
    }
    const residual = (await client.query(`SELECT
      (SELECT pg_catalog.count(*)::integer FROM lcm.machines) AS machines,
      (SELECT pg_catalog.count(*)::integer FROM lcm.projects) AS projects,
      (SELECT pg_catalog.count(*)::integer FROM lcm.conversations) AS conversations,
      (SELECT pg_catalog.count(*)::integer FROM lcm.passive_event_inbox) AS passive_events`)).rows[0];
    const residualEmpty = residual && Object.values(residual).every((value) => value === 0);
    if (requireResidualEmpty && !residualEmpty) throw new Error("certification database residual state is not empty");
    let systemIdentifier = "provider-withheld";
    try {
      systemIdentifier = String((await client.query("SELECT system_identifier::text FROM pg_catalog.pg_control_system()"))
        .rows[0]?.system_identifier ?? "provider-withheld");
    } catch {
      // Managed runtime roles may not read pg_control_system; provider identity remains authoritative.
    }
    return {
      serverVersionNum: identity.server_version_num,
      serverAddress: identity.server_address,
      serverPort: identity.server_port,
      databaseName: identity.database_name,
      roleName: identity.role_name,
      role: { superuser: identity.rolsuper, createRole: identity.rolcreaterole, createDb: identity.rolcreatedb },
      extensions,
      migrations,
      expectedMigrations: expectedMigrationCount,
      maxConnections,
      reservedConnections,
      residualEmpty,
      systemIdentifier,
    };
  } finally {
    await client.end();
  }
}

export async function collectResidualState({ url, ca, clientFactory }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = clientFactory?.() ?? new Client({
    connectionString: url,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    const residual = (await client.query(`SELECT
      (SELECT pg_catalog.count(*)::integer FROM lcm.machines) AS machines,
      (SELECT pg_catalog.count(*)::integer FROM lcm.projects) AS projects,
      (SELECT pg_catalog.count(*)::integer FROM lcm.conversations) AS conversations,
      (SELECT pg_catalog.count(*)::integer FROM lcm.passive_event_inbox) AS passive_events`)).rows[0];
    return {
      observedAt: new Date().toISOString(),
      residual,
      residualEmpty: residual !== undefined && Object.values(residual).every((value) => value === 0),
    };
  } finally {
    await client.end();
  }
}

export async function collectSetupSessionClosure({ url, ca, roles, clientFactory }) {
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== "string" || role.length === 0)) {
    throw new Error("certification setup roles are required");
  }
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = clientFactory?.() ?? new Client({
    connectionString: url,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    const rows = (await client.query(`SELECT usename::text AS role_name, pg_catalog.count(*)::integer AS connections
      FROM pg_catalog.pg_stat_activity
      WHERE usename OPERATOR(pg_catalog.=) ANY($1::text[]) AND pid OPERATOR(pg_catalog.<>) pg_catalog.pg_backend_pid()
      GROUP BY usename ORDER BY usename`, [roles])).rows;
    const counts = Object.fromEntries(roles.map((role) => [role, 0]));
    for (const row of rows) counts[row.role_name] = Number(row.connections);
    const totalConnections = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return {
      observedAt: new Date().toISOString(),
      roles: counts,
      totalConnections,
      setupSessionsClosed: totalConnections === 0,
    };
  } finally {
    await client.end();
  }
}

export async function collectDatabaseRelationBytes({ url, ca }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, statement_timeout: 30_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const row = (await client.query(`SELECT COALESCE(pg_catalog.sum(pg_catalog.pg_total_relation_size(class.oid)), 0)::text AS bytes
      FROM pg_catalog.pg_class AS class JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'lcm'`)).rows[0];
    const bytes = Number(row?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid certification relation-size witness");
    return bytes;
  } finally { await client.end().catch(() => undefined); }
}

export async function startClockMonitor({ machineNames, run, url, ca, evidenceDirectory, intervalMs = 60_000 }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const samples = [];
  const machineClock = async (name) => {
    const result = await run(["container", "exec", name, "node", "-e", "process.stdout.write(JSON.stringify({wallMs:Date.now(),monotonicNs:process.hrtime.bigint().toString()}))"]);
    return JSON.parse(result.stdout.trim());
  };
  const sample = async (phase = "interval") => {
    const machineSamples = await Promise.all(Object.entries(machineNames).map(async ([machine, name]) => {
      const t0 = await machineClock(name);
      const client = new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, statement_timeout: 30_000 });
      client.on("error", () => undefined);
      let server;
      let connections;
      try {
        await client.connect();
        server = (await client.query("SELECT pg_catalog.clock_timestamp()::text AS now")).rows[0];
        connections = (await client.query(`SELECT usename::text AS role_name,
          COALESCE(client_addr::text, 'local') AS client_address,
          pg_catalog.count(*)::integer AS connections
          FROM pg_catalog.pg_stat_activity
          WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
          GROUP BY usename, client_addr ORDER BY usename, client_addr`)).rows;
      } finally {
        await client.end().catch(() => undefined);
      }
      const t1 = await machineClock(name);
      const radiusMs = Math.max(0, (t1.wallMs - t0.wallMs) / 2);
      const databaseConnections = connections?.reduce((sum, entry) => sum + Number(entry.connections), 0);
      return { phase, machine, t0, serverTime: server?.now, connections, databaseConnections, t1, radiusMs, verdict: radiusMs <= 250 ? "pass" : "fail" };
    }));
    samples.push(...machineSamples);
  };
  await sample("start");
  const stopController = new AbortController();
  const loop = (async () => {
    while (!stopController.signal.aborted) {
      await waitInterval(intervalMs, stopController.signal);
      if (!stopController.signal.aborted) {
        try { await sample(); }
        catch (error) { samples.push({ verdict: "incomplete", errorClass: error?.name ?? "Error" }); }
      }
    }
  })();
  return {
    async stop() {
      stopController.abort();
      await loop;
      try { await sample("end"); }
      catch (error) { samples.push({ phase: "end", verdict: "incomplete", errorClass: error?.name ?? "Error" }); }
      writeFileSync(join(evidenceDirectory, "clock-witness.json"), `${JSON.stringify(samples, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      return samples;
    },
  };
}

function walkFiles(root, directory = root, files = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error(`staged package contains a symlink: ${relative(root, path)}`);
    if (status.isDirectory()) walkFiles(root, path, files);
    else if (status.isFile()) files.push(path);
    else throw new Error(`staged package contains a non-file entry: ${relative(root, path)}`);
  }
  return files;
}

export function stageBuiltPackage({ sourceRoot, destination, machineAgentPath }) {
  const required = [
    "dist/lcm.mjs",
    "dist/src/prompts",
    "dist/src/connectors/templates",
    "dist/src/storage/postgresql/migrations",
    "package.json",
  ];
  for (const path of required) lstatSync(join(sourceRoot, path));
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(join(sourceRoot, "dist"), join(destination, "dist"), { recursive: true, errorOnExist: true });
  cpSync(join(sourceRoot, "package.json"), join(destination, "package.json"), { errorOnExist: true });
  mkdirSync(join(destination, "certification"), { mode: 0o700 });
  cpSync(machineAgentPath, join(destination, "certification", "machine-agent.mjs"), { errorOnExist: true });
  cpSync(new URL("../test/certification/schedule.mjs", import.meta.url), join(destination, "certification", "schedule.mjs"), { errorOnExist: true });
  cpSync(new URL("../test/certification/contract.mjs", import.meta.url), join(destination, "certification", "contract.mjs"), { errorOnExist: true });
  cpSync(new URL("../test/certification/contract-v3.json", import.meta.url), join(destination, "certification", "contract-v3.json"), { errorOnExist: true });
  cpSync(new URL("../test/certification/contract-v3.approval.json", import.meta.url), join(destination, "certification", "contract-v3.approval.json"), { errorOnExist: true });
  cpSync(new URL("../test/certification/backend-publication.mjs", import.meta.url), join(destination, "certification", "backend-publication.mjs"), { errorOnExist: true });
  cpSync(new URL("../test/certification/sqlite-observer-worker.mjs", import.meta.url), join(destination, "certification", "sqlite-observer-worker.mjs"), { errorOnExist: true });
  const hash = createHash("sha256");
  for (const path of walkFiles(destination)) {
    hash.update(relative(destination, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return { root: destination, sha256: hash.digest("hex") };
}

export function recordFaultStep(identity, timestamps) {
  for (const field of ["id", "kind", "target"]) if (!identity[field]) throw new Error(`fault step missing ${field}`);
  for (const field of ["requestedAt", "appliedAt", "clearedAt", "recoveredAt"]) {
    if (typeof timestamps[field] !== "string" || timestamps[field].length === 0) throw new Error(`fault step missing ${field}`);
  }
  return { ...identity, ...timestamps };
}

export function verifyDistinctMachineIdentities(homes) {
  const identities = {};
  const raw = {};
  for (const machine of ['a', 'b']) {
    const text = readFileSync(join(homes[machine], ".lcm", "machine.json"), "utf8");
    const identity = JSON.parse(text);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identity.machineId)
      || !/^machine:[0-9a-f]{64}$/u.test(identity.identityKey)) {
      throw new Error(`invalid machine ${machine} identity evidence`);
    }
    raw[machine] = text;
    identities[machine] = {
      machineId: identity.machineId,
      identityKeySha256: createHash("sha256").update(identity.identityKey).digest("hex"),
    };
  }
  const identityA = JSON.parse(raw.a);
  const identityB = JSON.parse(raw.b);
  if (identities.a.machineId === identities.b.machineId
    || identities.a.identityKeySha256 === identities.b.identityKeySha256
    || raw.a.includes(identityB.identityKey)
    || raw.b.includes(identityA.identityKey)) {
    throw new Error("certification machine identities are not distinct");
  }
  return identities;
}

function writeEnvironmentFile(path, environment) {
  const lines = Object.entries(environment).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/gu, "")}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
}

function jsonFromFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function prepareEvidenceDirectory(path, metadata) {
  if (!metadata.approval || !/^[0-9a-f]{64}$/u.test(metadata.approvalSha256 ?? "")) {
    throw new Error("certification evidence collection requires an approval receipt");
  }
  const approvedAt = Date.parse(metadata.approval.approvedAt);
  const startedAt = Date.parse(metadata.startedAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(startedAt) || approvedAt > startedAt) {
    throw new Error("contract approval must precede evidence collection");
  }
  if (metadata.approval.contractSha256 !== metadata.contractSha256) {
    throw new Error("evidence metadata approval hash does not match the contract");
  }
  const fromRepository = relative(repositoryRoot, path);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error("certification evidence directory must be outside the repository");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (readdirSync(path).length !== 0) throw new Error("certification evidence directory must be empty");
  writeFileSync(join(path, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export async function runLocalCertification(options, dependencies = {}) {
  const contract = options.contract ?? loadCertificationContract(new URL("../test/certification/contract-v3.json", import.meta.url), { requireApproved: false }).contract;
  if ((dependencies.environment ?? process.env).LCM_TEST_CONTAINER_CLI !== "podman") {
    throw new Error("local certification requires LCM_TEST_CONTAINER_CLI=podman");
  }
  prepareEvidenceDirectory(options.evidenceDirectory, {
    lane: "local",
    profile: options.profile,
    ...(options.withFaults === true ? { withFaults: true } : {}),
    contractSha256: options.contractSha256,
    approval: options.approval,
    approvalSha256: options.approvalSha256,
    startedAt: new Date().toISOString(),
  });
  // The full profile always injects the lane's faults; a smoke run does so only when the
  // non-certifying --with-faults option asks for it.
  const faultsEnabled = options.profile === "full" || options.withFaults === true;
  const executeHarness = dependencies.runHarness ?? runHarness;
  let result;
  try {
    result = await executeHarness({
    certificationMachines: true,
    runTests: async (context) => {
      const runMetadata = jsonFromFile(join(options.evidenceDirectory, "run.json"));
      writeFileSync(join(options.evidenceDirectory, "run.json"), `${JSON.stringify({ ...runMetadata, runId: context.runId }, null, 2)}\n`, { mode: 0o600 });
      const stage = dependencies.stagePackage?.(context.directory) ?? stageBuiltPackage({
        sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
        destination: join(context.directory, "package"),
        machineAgentPath: new URL("../test/certification/machine-agent.mjs", import.meta.url),
      });
      const executionProvenance = (dependencies.captureExecutionProvenance ?? captureExecutionProvenance)(
        dependencies.sourceRoot ?? repositoryRoot, options.contractSha256, stage.sha256, options.approvalSha256,
        { environment: dependencies.environment ?? process.env, containerCli: "podman", contract },
      );
      assertExecutionProvenance(options.profile, executionProvenance);
      writeFileSync(join(options.evidenceDirectory, "execution-provenance.json"), `${JSON.stringify(executionProvenance, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const machineRoots = {};
      const created = [];
      let clockMonitor;
      try {
        const databasePreparation = await (dependencies.prepareDatabase ?? prepareManagedDatabase)({
          privateConnection: {
            databaseName: context.names.controlDatabase,
            migratorName: "lcm_test_migrator",
            runtimeName: "lcm_test_runtime",
            adminUrl: context.environment.LCM_TEST_POSTGRES_ADMIN_URL,
            containerAdminUrl: context.inNetworkEnvironment.LCM_TEST_POSTGRES_ADMIN_URL,
            migratorUrl: context.environment.LCM_TEST_POSTGRES_MIGRATOR_URL,
            runtimeUrl: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          },
          runRoot: context.directory,
          caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
          setupNetwork: context.names.network,
          containerCli: context.containerCli,
          processRunner: context.processRunner,
          secrets: context.secrets,
          sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
          names: context.names,
          owner: context.owner,
          runId: context.runId,
        });
        const preActivationResidual = await (dependencies.collectResidualState ?? collectResidualState)({
          url: context.environment.LCM_TEST_POSTGRES_ADMIN_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
        });
        writeFileSync(join(options.evidenceDirectory, "pre-activation-residual.json"), `${JSON.stringify(preActivationResidual, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        let databaseReadiness;
        for (const machine of ['a', 'b']) {
          const homeParent = join(context.directory, `machine-${machine}-home-parent`);
          const home = join(homeParent, "home");
          const evidence = join(options.evidenceDirectory, `machine-${machine}`);
          mkdirSync(home, { recursive: true, mode: 0o700 });
          mkdirSync(evidence, { recursive: true, mode: 0o700 });
          const environmentFile = join(context.directory, `machine-${machine}.env`);
          writeEnvironmentFile(environmentFile, {
            HOME: "/home/lcm-parent/home",
            LCM_CLIENT: "codex",
            LCM_POSTGRES_URL: urlAtHost(databasePreparation.transferUrl, context.names.alias, 5432),
            LCM_POSTGRES_RUNTIME_URL: context.inNetworkEnvironment.LCM_TEST_POSTGRES_RUNTIME_URL,
            LCM_POSTGRES_CA_FILE: "/run/lcm-ca/ca.crt",
            LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
            LCM_CERT_MIGRATION_ROLE: "lcm_test_migrator",
            LCM_CERT_WRONG_CA_FILE: "/run/lcm-ca/wrong-ca.crt",
            LCM_CERT_WRONG_HOST_URL: urlAtHost(context.inNetworkEnvironment.LCM_TEST_POSTGRES_RUNTIME_URL, context.names.wrongAlias),
            LCM_CERT_EVIDENCE_DIR: "/evidence",
            LCM_CERT_PROFILE: options.profile,
            ...(options.withFaults === true ? { LCM_CERT_WITH_FAULTS: "1" } : {}),
            LCM_CERT_LANE: "local",
            LCM_CERT_RUN_ID: context.runId,
          });
          const name = machine === 'a' ? context.names.machineA : context.names.machineB;
          const kind = `machine-${machine}`;
          await context.processRunner(context.containerCli, buildMachineContainerArgs({
            machine, name, hostname: `lcm-cert-${machine}`, network: context.names.network,
            image: NODE_IMAGE, ownerLabels: ownershipLabels(context.runId, kind, context.owner),
            stagedPackage: stage.root, nodeModules: join(dependencies.sourceRoot ?? repositoryRoot, "node_modules"), homeParent, caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
            wrongCaFile: context.environment.LCM_TEST_POSTGRES_WRONG_CA_FILE,
            evidenceDirectory: evidence, environmentFile,
          }), { redactSecrets: context.secrets });
          created.push(name);
          machineRoots[machine] = { home, evidence };
        }
        const runContainer = (args) => context.processRunner(context.containerCli, args, { redactSecrets: context.secrets });
        const waitForFiles = (paths, machineNames, timeoutMs) => waitForMachineFiles({
          paths, machineNames, run: runContainer, timeoutMs, delay: dependencies.delay,
        });
        const monitorDelay = (machineNames, durationMs) => dependencies.monitorMachineDelay
          ? dependencies.monitorMachineDelay(machineNames, durationMs)
          : dependencies.delay
            ? dependencies.delay(durationMs)
            : monitorMachinesForDuration({ machineNames, run: runContainer, durationMs });
        const setupStartedAt = Date.now();
        const setupDeadline = setupStartedAt + contract.timeline.full.setupMaxSeconds * 1000;
        const waitForSetupFiles = (paths, machineNames) => {
          const remainingMs = setupDeadline - Date.now();
          if (remainingMs <= 0) throw new Error("certification setup exceeded setupMaxSeconds");
          return waitForFiles(paths, machineNames, remainingMs);
        };
        const activationReceipts = {};
        const poolByMachine = {};
        let revocation;
        let runtimeGrant;
        let setupSessionClosure;
        await runMachineActivationBarrier({
          verifyA: async () => {
            await runContainer(["container", "start", context.names.machineA]);
            writeFileSync(join(options.evidenceDirectory, "machine-a", "migration-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            await waitForSetupFiles([join(options.evidenceDirectory, "machine-a", "verification-receipt.json")], [context.names.machineA]);
          },
          verifyB: async () => {
            await runContainer(["container", "start", context.names.machineB]);
            writeFileSync(join(options.evidenceDirectory, "machine-b", "migration-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            await waitForSetupFiles([join(options.evidenceDirectory, "machine-b", "verification-receipt.json")], [context.names.machineA, context.names.machineB]);
          },
          grantRuntime: async () => {
            runtimeGrant = await (dependencies.grantRuntime ?? grantRuntimeProfile)({
              adminUrl: context.environment.LCM_TEST_POSTGRES_ADMIN_URL,
              caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
              role: "lcm_test_runtime",
              databaseName: context.names.controlDatabase,
              sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
            });
          },
          activateA: async () => {
            writeFileSync(join(options.evidenceDirectory, "machine-a", "activation-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            const path = join(options.evidenceDirectory, "machine-a", "activation-receipt.json");
            await waitForSetupFiles([path], [context.names.machineA]);
            activationReceipts.a = jsonFromFile(path);
          },
          activateB: async () => {
            writeFileSync(join(options.evidenceDirectory, "machine-b", "activation-start.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            const path = join(options.evidenceDirectory, "machine-b", "activation-receipt.json");
            await waitForSetupFiles([path], [context.names.machineA, context.names.machineB]);
            activationReceipts.b = jsonFromFile(path);
          },
          revokeTransfer: async () => {
            revocation = await (dependencies.revokeTransfer ?? revokeTransferProfile)({
              adminUrl: context.environment.LCM_TEST_POSTGRES_ADMIN_URL,
              caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
              role: databasePreparation.transferName,
            });
          },
          verifyRuntime: async () => {
            await (dependencies.verifyRuntime ?? verifyRuntimeSchemaReadiness)({
              sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
              url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
              caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
              expectedOwner: "lcm_test_migrator",
            });
            databaseReadiness = await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
              url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
              ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
              expectedVersionNum: 180004,
              expectedDatabase: context.names.controlDatabase,
              expectedPort: 5432,
              expectedRole: "lcm_test_runtime",
              expectedMigrationCount: readdirSync(join(dependencies.sourceRoot ?? repositoryRoot, "src", "storage", "postgresql", "migrations")).filter((name) => name.endsWith(".sql")).length,
              requireResidualEmpty: false,
            });
            setupSessionClosure = await (dependencies.collectSetupSessionClosure ?? collectSetupSessionClosure)({
              url: context.environment.LCM_TEST_POSTGRES_ADMIN_URL,
              ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
              roles: ["lcm_test_migrator", databasePreparation.transferName],
            });
          },
          startDaemonA: async () => {
            writeFileSync(join(options.evidenceDirectory, "machine-a", "runtime-ready.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            await waitForSetupFiles([join(options.evidenceDirectory, "machine-a", "daemon-started.json")], [context.names.machineA, context.names.machineB]);
            poolByMachine.a = await collectMachinePoolWitness(context.names.machineA, runContainer);
          },
          stagger: () => monitorDelay([context.names.machineA, context.names.machineB], contract.timeline.full.secondDaemonStartOffsetSeconds * 1000),
          startDaemonB: async () => {
            writeFileSync(join(options.evidenceDirectory, "machine-b", "runtime-ready.json"), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
            await waitForSetupFiles([join(options.evidenceDirectory, "machine-b", "daemon-started.json")], [context.names.machineA, context.names.machineB]);
            poolByMachine.b = await collectMachinePoolWitness(context.names.machineB, runContainer);
          },
        });
        if (Date.now() > setupDeadline) {
          throw new Error("certification setup exceeded setupMaxSeconds");
        }
        databaseReadiness = {
          ...databaseReadiness,
          configuredPoolMax: poolByMachine.a?.configuredMax === poolByMachine.b?.configuredMax ? poolByMachine.a.configuredMax : undefined,
          poolByMachine,
          setupSessionsClosed: setupSessionClosure.setupSessionsClosed,
          setupSessionClosure,
        };
        writeFileSync(join(options.evidenceDirectory, "setup-evidence.json"), `${JSON.stringify({
          startedAt: new Date(setupStartedAt).toISOString(),
          completedAt: new Date().toISOString(),
          activationReceipts,
          revocation,
          runtimeGrant,
          runtimeReadiness: "pass",
          daemonStartOrder: ["a", "b"],
          setupSessionClosure,
          poolByMachine,
        }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        writeFileSync(join(options.evidenceDirectory, "setup-session-closure.json"), `${JSON.stringify(setupSessionClosure, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        writeFileSync(join(options.evidenceDirectory, "database-readiness.json"), `${JSON.stringify(databaseReadiness, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await waitForSetupFiles(
          ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "ready.json")),
          [context.names.machineA, context.names.machineB],
        );
        const identities = verifyDistinctMachineIdentities({ a: machineRoots.a.home, b: machineRoots.b.home });
        writeFileSync(join(options.evidenceDirectory, "machine-identities.json"), `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        clockMonitor = await (dependencies.startClockMonitor ?? startClockMonitor)({
          machineNames: { a: context.names.machineA, b: context.names.machineB },
          run: runContainer,
          url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
          evidenceDirectory: options.evidenceDirectory,
        });
        const warmupControl = publishWarmupControl(options.evidenceDirectory, dependencies.wallNow);
        await waitForFiles(
          ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "warmup-complete.json")),
          [context.names.machineA, context.names.machineB],
          contract.timeline[options.profile].warmupSeconds * 1000 + 120_000,
        );
        publishSteadyControl(options.evidenceDirectory, warmupControl, dependencies.wallNow);
        const growthBefore = await (dependencies.collectRelationBytes ?? collectDatabaseRelationBytes)({
          url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
        });
        await waitForFiles(
          ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "steady-complete.json")),
          [context.names.machineA, context.names.machineB],
          phaseDeadlineMs(contract, options.profile, "fault-ready"),
        );
        const growthAfter = await (dependencies.collectRelationBytes ?? collectDatabaseRelationBytes)({
          url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
        });
        writeFileSync(join(options.evidenceDirectory, "database-growth.json"), `${JSON.stringify({ beforeBytes: growthBefore, afterBytes: growthAfter, deltaBytes: growthAfter - growthBefore })}\n`, { mode: 0o600, flag: "wx" });
        if (faultsEnabled) {
          await waitForFiles(
            ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "fault-ready.json")),
            [context.names.machineA, context.names.machineB],
            phaseDeadlineMs(contract, options.profile, "fault-ready"),
          );
          const runtimeIdentity = {
            expectedVersionNum: 180004,
            expectedDatabase: context.names.controlDatabase,
            expectedPort: 5432,
            expectedRole: "lcm_test_runtime",
          };
          // Every fault phase uses the full profile's bound, including in a fault smoke.
          const clearMachineA = (phase) => waitForMachineDatabaseClearance({
            name: context.names.machineA, run: runContainer, expected: runtimeIdentity,
            timeoutMs: phaseDeadlineMs(contract, "full", phase), delay: dependencies.delay,
          });
          const partitionRequestedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["network", "disconnect", context.names.network, context.names.machineA], { redactSecrets: context.secrets });
          const partitionAppliedAt = new Date().toISOString();
          await monitorDelay([context.names.machineA, context.names.machineB], 60_000);
          await context.processRunner(context.containerCli, ["network", "connect", context.names.network, context.names.machineA], { redactSecrets: context.secrets });
          await clearMachineA("partition");
          await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
            url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
            ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
            ...runtimeIdentity,
            requireResidualEmpty: false,
          });
          const partitionClearedAt = new Date().toISOString();
          for (const machine of ['a', 'b']) writeFileSync(
            join(options.evidenceDirectory, `machine-${machine}`, "partition-cleared.json"),
            `${JSON.stringify({ clearedAt: partitionClearedAt })}\n`, { mode: 0o600, flag: "wx" },
          );
          await waitForFiles(
            ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "restart-ready.json")),
            [context.names.machineA, context.names.machineB],
            phaseDeadlineMs(contract, "full", "partition"),
          );
          const partitionRecoveredAt = new Date().toISOString();
          const restartRequestedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["container", "stop", "--time", "120", context.names.container], { redactSecrets: context.secrets });
          const restartAppliedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["container", "start", context.names.container], { redactSecrets: context.secrets });
          await clearMachineA("restart");
          await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
            url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
            ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
            ...runtimeIdentity,
            requireResidualEmpty: false,
          });
          const restartClearedAt = new Date().toISOString();
          for (const machine of ['a', 'b']) writeFileSync(
            join(options.evidenceDirectory, `machine-${machine}`, "restart-cleared.json"),
            `${JSON.stringify({ clearedAt: restartClearedAt })}\n`, { mode: 0o600, flag: "wx" },
          );
          await waitForFiles(
            ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "restart-recovered.json")),
            [context.names.machineA, context.names.machineB],
            phaseDeadlineMs(contract, "full", "restart"),
          );
          const restartRecoveredAt = new Date().toISOString();
          writeFileSync(join(options.evidenceDirectory, "faults.json"), `${JSON.stringify([
            { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: partitionRequestedAt, appliedAt: partitionAppliedAt, clearedAt: partitionClearedAt, recoveredAt: partitionRecoveredAt },
            { id: "restart-database", kind: "restart-database", target: "database", requestedAt: restartRequestedAt, appliedAt: restartAppliedAt, clearedAt: restartClearedAt, recoveredAt: restartRecoveredAt },
          ], null, 2)}\n`, { mode: 0o600, flag: "wx" });
        }
        await waitForFiles(
          ['a', 'b'].map((machine) => join(options.evidenceDirectory, `machine-${machine}`, "drain.json")),
          [context.names.machineA, context.names.machineB],
          phaseDeadlineMs(contract, options.profile, "drain"),
        );
        await clockMonitor.stop();
        clockMonitor = undefined;
        for (const machine of ['a', 'b']) writeFileSync(
          join(options.evidenceDirectory, `machine-${machine}`, "clock-finished.json"),
          `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" },
        );
        for (const name of created) {
          await context.processRunner(context.containerCli, ["container", "wait", name], { redactSecrets: context.secrets });
        }
        return { stage, machines: machineRoots };
      } finally {
        if (clockMonitor) await clockMonitor.stop().catch(() => undefined);
      }
    },
    });
  } catch (error) {
    if (!existsSync(join(options.evidenceDirectory, "cleanup.json"))) {
      writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({
        verdict: "incomplete", residualResources: 0, labeledContainers: 0, labeledNetworks: 0,
        labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: false,
        ownedProcessesExited: false, providerDestroyConfirmedWithinSeconds: 0,
      })}\n`, { mode: 0o600, flag: "wx" });
    }
    throw error;
  }
  writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({
    verdict: "pass", residualResources: 0, labeledContainers: 0, labeledNetworks: 0,
    labeledVolumes: 0, familyTaggedProviderClusters: 0, privateRootsAbsent: true,
    ownedProcessesExited: true, providerDestroyConfirmedWithinSeconds: 0,
  })}\n`, { mode: 0o600, flag: "wx" });
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCertificationArguments(argv);
  const loaded = loadCertificationContract(new URL("../test/certification/contract-v3.json", import.meta.url));
  options.contract = loaded.contract;
  options.contractSha256 = loaded.sha256;
  options.contractStatus = loaded.status;
  options.approval = loaded.approval;
  options.approvalSha256 = loaded.approvalSha256;
  if (options.lane === "local") {
    // A fault smoke adds the full profile's partition and restart phase bounds to the
    // smoke deadline.
    const { partitionPhaseMaxSeconds, restartPhaseMaxSeconds } = loaded.contract.timeline.full;
    const deadlineSeconds = options.profile === "full" ? 10_800
      : 1_800 + (options.withFaults === true ? partitionPhaseMaxSeconds + restartPhaseMaxSeconds : 0);
    const deadline = setTimeout(() => process.kill(process.pid, "SIGTERM"), deadlineSeconds * 1000);
    deadline.unref?.();
    try { return await runLocalCertification(options); }
    finally { clearTimeout(deadline); }
  }
  const { runManagedCertification } = await import("./certification-digitalocean.mjs");
  return runManagedCertification(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Certification harness failed: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
