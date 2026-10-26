#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_IMAGE, POSTGRES_IMAGE } from "./postgresql-images.mjs";
import { loadCertificationContract } from "../test/certification/contract.mjs";
import { createDeterministicSchedule } from "../test/certification/schedule.mjs";
import { createOwnerIdentity, createProcessLifecycle, ownershipLabels, removeOwnedResource, runHarness, runSanitizedProcess } from "./postgresql-harness.mjs";

const repositoryRoot = join(fileURLToPath(new URL("..", import.meta.url)));
export { createDeterministicSchedule };

export function parseCertificationArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || value === undefined) throw new Error("invalid certification arguments");
    values.set(option, value);
  }
  const lane = values.get("--lane");
  const profile = values.get("--profile");
  const evidenceDirectory = values.get("--evidence-dir");
  if (!['local', 'managed'].includes(lane)) throw new Error("certification lane must be local or managed");
  if (!['smoke', 'full'].includes(profile)) throw new Error("certification profile must be smoke or full");
  if (!evidenceDirectory || !isAbsolute(evidenceDirectory)) throw new Error("certification evidence directory must be absolute");
  return { lane, profile, evidenceDirectory };
}
export function buildMachineContainerArgs(input) {
  if (!['a', 'b'].includes(input.machine)) throw new Error("invalid certification machine");
  const labels = Object.entries(input.ownerLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const args = [
    "container", "create", "--name", input.name,
    ...labels,
    "--hostname", input.hostname,
    "--network", input.network,
    "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
    "--user", "1000:1000",
  ];
  if (input.wrongHost) args.push("--add-host", `${input.wrongHost.host}:${input.wrongHost.address}`);
  if (input.environmentFile) args.push("--env-file", input.environmentFile);
  args.push(
    "--volume", `${input.stagedPackage}:/opt/lcm:ro,z`,
    "--volume", `${input.home}:/home/lcm:Z`,
    "--volume", `${input.caFile}:/run/lcm-ca/ca.crt:ro,z`,
    ...(input.wrongCaFile ? ["--volume", `${input.wrongCaFile}:/run/lcm-ca/wrong-ca.crt:ro,z`] : []),
    "--volume", `${input.evidenceDirectory}:/evidence:Z`,
    input.image,
    "node", "/opt/lcm/certification/machine-agent.mjs",
    "--machine", input.machine,
  );
  return args;
}

function urlAtHost(value, hostname) {
  const url = new URL(value);
  url.hostname = hostname;
  return url.toString();
}

async function poll(predicate, { attempts = 360, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("certification aborted");
    if (await predicate()) return;
    await delay(1000);
  }
  throw new Error("certification machine phase timed out");
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
export async function runManagedMachinePair(input, dependencies = {}) {
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
  const network = `lcm-cert-net-${input.runId.slice(0, 20)}`;
  const names = { machineA: `lcm-cert-machine-a-${input.runId.slice(0, 20)}`, machineB: `lcm-cert-machine-b-${input.runId.slice(0, 20)}` };
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
  const ownershipRunId = createHash("sha256").update(input.runId).digest("hex").slice(0, 32);
  const created = [];
  const homes = {};
  const machineLabels = new Map();
  const networkLabels = ownershipLabels(ownershipRunId, "network", owner);
  let networkCreated = false;
  const run = (args) => processRunner(containerCli, args, { redactSecrets: input.secrets });
  const exists = dependencies.exists ?? existsSync;
  const delay = dependencies.delay;
  let clockMonitor;
  try {
    await (dependencies.prepareDatabase ?? prepareManagedDatabase)({
      privateConnection: input.privateConnection,
      runRoot,
      caFile,
      containerCli,
      processRunner,
      secrets: input.secrets,
      sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
    });
    const databaseReadiness = await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
      url: input.privateConnection.runtimeUrl,
      ca: input.privateConnection.ca,
      expectedMajor: 18,
    });
    mkdirSync(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(input.evidenceDirectory, "database-readiness.json"), `${JSON.stringify({
      ...databaseReadiness,
      providerClusterId: input.cluster.id,
      providerHost: input.cluster.host,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await run(["network", "create", ...Object.entries(networkLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), network]);
    networkCreated = true;
    for (const machine of ['a', 'b']) {
      const name = machine === 'a' ? names.machineA : names.machineB;
      const home = join(runRoot, `home-${machine}`);
      const evidence = join(input.evidenceDirectory, `machine-${machine}`);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      homes[machine] = home;
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      const environmentFile = join(runRoot, `machine-${machine}.env`);
      writeEnvironmentFile(environmentFile, {
        HOME: "/home/lcm",
        LCM_CLIENT: "codex",
        LCM_POSTGRES_URL: input.privateConnection.runtimeUrl,
        LCM_POSTGRES_CA_FILE: "/run/lcm-ca/ca.crt",
        LCM_CERT_WRONG_CA_FILE: "/run/lcm-ca/wrong-ca.crt",
        LCM_CERT_WRONG_HOST_URL: urlAtHost(input.privateConnection.runtimeUrl, wrongHostname),
        LCM_CERT_EVIDENCE_DIR: "/evidence",
        LCM_CERT_PROFILE: input.profile,
        LCM_CERT_LANE: "managed",
        LCM_CERT_RUN_ID: input.runId,
      });
      const labels = ownershipLabels(ownershipRunId, `machine-${machine}`, owner);
      await run(buildMachineContainerArgs({
        machine, name, hostname: `lcm-cert-${machine}`, network, image: NODE_IMAGE,
        ownerLabels: labels,
        stagedPackage: stage.root, home, caFile, wrongCaFile, evidenceDirectory: evidence,
        environmentFile, wrongHost: { host: wrongHostname, address: endpointAddress },
      }));
      created.push(name);
      machineLabels.set(name, labels);
      await run(["container", "start", name]);
    }
    const waitForReady = dependencies.waitForReady ?? (() => poll(
      () => ['a', 'b'].every((machine) => exists(join(input.evidenceDirectory, `machine-${machine}`, "ready.json"))),
      { delay, signal: input.signal },
    ));
    await waitForReady();
    const identities = (dependencies.verifyIdentities ?? verifyDistinctMachineIdentities)(homes);
    writeFileSync(join(input.evidenceDirectory, "machine-identities.json"), `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    clockMonitor = await (dependencies.startClockMonitor ?? startClockMonitor)({
      machineNames: { a: names.machineA, b: names.machineB },
      run,
      url: input.privateConnection.runtimeUrl,
      ca: input.privateConnection.ca,
      evidenceDirectory: input.evidenceDirectory,
    });
    let fault;
    if (input.profile === "full") {
      const waitForFaultReady = dependencies.waitForFaultReady ?? (() => poll(
        () => ['a', 'b'].every((machine) => exists(join(input.evidenceDirectory, `machine-${machine}`, "fault-ready.json"))),
        { delay, signal: input.signal },
      ));
      await waitForFaultReady();
      const requestedAt = new Date().toISOString();
      await run(["network", "disconnect", network, names.machineA]);
      const appliedAt = new Date().toISOString();
      await Promise.race([
        (delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(60_000),
        aborted(input.signal),
      ]);
      await run(["network", "connect", network, names.machineA]);
      const clearedAt = new Date().toISOString();
      for (const machine of ['a', 'b']) {
        writeFileSync(join(input.evidenceDirectory, `machine-${machine}`, "partition-cleared.json"), `${JSON.stringify({ clearedAt })}\n`, { mode: 0o600, flag: "wx" });
      }
      const waitForPartitionRecovery = dependencies.waitForPartitionRecovery ?? (() => poll(
        () => ['a', 'b'].every((machine) => exists(join(input.evidenceDirectory, `machine-${machine}`, "partition-recovered.json"))),
        { attempts: 300, delay, signal: input.signal },
      ));
      await waitForPartitionRecovery();
      const recoveredAt = new Date().toISOString();
      fault = recordFaultStep({ id: "partition-a", kind: "partition-machine", target: "a" }, { requestedAt, appliedAt, clearedAt, recoveredAt });
      writeFileSync(join(input.evidenceDirectory, "fault-partition-a.json"), `${JSON.stringify(fault, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    const waitForDrain = dependencies.waitForDrain ?? (() => poll(
      () => ['a', 'b'].every((machine) => exists(join(input.evidenceDirectory, `machine-${machine}`, "drain.json"))),
      { attempts: 1200, delay, signal: input.signal },
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
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "managed certification machine cleanup failed");
  }
}

export async function prepareManagedDatabase(input) {
  const { privateConnection, runRoot, caFile, containerCli, processRunner, secrets, sourceRoot } = input;
  const setupSql = join(runRoot, "managed-setup.sql");
  writeFileSync(setupSql, [
    "\\set ON_ERROR_STOP on",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;",
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;",
    "GRANT CONNECT, CREATE ON DATABASE :\"database_name\" TO :\"migrator_role\";",
    "GRANT CONNECT ON DATABASE :\"database_name\" TO :\"runtime_role\";",
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  const credentialFile = join(runRoot, "managed-sql.env");
  writeEnvironmentFile(credentialFile, { LCM_CERT_ADMIN_URL: privateConnection.adminUrl });
  const grantsSource = join(sourceRoot, "src", "storage", "postgresql", "reference");
  const grantsDirectory = join(runRoot, "runtime-grants");
  mkdirSync(grantsDirectory, { mode: 0o700 });
  for (const name of readdirSync(grantsSource).filter((entry) => /^postgresql-runtime-.*-grants\.sql$/u.test(entry)).sort()) {
    cpSync(join(grantsSource, name), join(grantsDirectory, name), { errorOnExist: true });
  }
  const psqlScript = [
    "export PGSSLMODE=verify-full",
    "export PGSSLROOTCERT=/run/lcm-ca/ca.crt",
    "psql \"$LCM_CERT_ADMIN_URL\" --set=ON_ERROR_STOP=1 --set=database_name=\"$LCM_CERT_DATABASE\" --set=migrator_role=\"$LCM_CERT_MIGRATOR\" --set=runtime_role=\"$LCM_CERT_RUNTIME\" --file=/run/lcm-cert/setup.sql",
    "for grant in /run/lcm-grants/postgresql-runtime-*-grants.sql; do psql \"$LCM_CERT_ADMIN_URL\" --set=ON_ERROR_STOP=1 --set=lcm_runtime_role=\"$LCM_CERT_RUNTIME\" --file=\"$grant\"; done",
  ].join("\n");
  const basePsqlArgs = [
    "run", "--rm",
    "--env-file", credentialFile,
    "--env", `LCM_CERT_DATABASE=${privateConnection.databaseName}`,
    "--env", `LCM_CERT_MIGRATOR=${privateConnection.migratorName}`,
    "--env", `LCM_CERT_RUNTIME=${privateConnection.runtimeName}`,
    "--volume", `${caFile}:/run/lcm-ca/ca.crt:ro,Z`,
    "--volume", `${setupSql}:/run/lcm-cert/setup.sql:ro,Z`,
    "--volume", `${grantsDirectory}:/run/lcm-grants:ro,Z`,
    POSTGRES_IMAGE,
    "bash", "-ceu",
  ];
  await processRunner(containerCli, [...basePsqlArgs, psqlScript.split("\n")[0] + "\n" + psqlScript.split("\n")[1] + "\n" + psqlScript.split("\n")[2]], { redactSecrets: secrets });
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
  await processRunner(process.execPath, [entrypoint, "config", "set", "storage.backend", "postgresql", "--json"], { env: migrationEnvironment, redactSecrets: secrets });
  await processRunner(process.execPath, [entrypoint, "config", "set", "storage.postgresql.poolMax", "2", "--json"], { env: migrationEnvironment, redactSecrets: secrets });
  await processRunner(process.execPath, [entrypoint, "postgres", "migrate", "--json"], { env: migrationEnvironment, redactSecrets: secrets });
  await processRunner(containerCli, [...basePsqlArgs, psqlScript], { redactSecrets: secrets });
}

export async function collectDatabaseReadiness({ url, ca, expectedVersionNum, expectedMajor = 18 }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_setting('server_version_num')::integer AS server_version_num,
      pg_catalog.inet_server_addr()::text AS server_address,
      pg_catalog.inet_server_port()::integer AS server_port,
      pg_catalog.current_database()::text AS database_name,
      pg_catalog.current_user::text AS role_name,
      role.rolsuper, role.rolcreaterole, role.rolcreatedb
      FROM pg_catalog.pg_roles AS role WHERE role.rolname OPERATOR(pg_catalog.=) pg_catalog.current_user`)).rows[0];
    if (!identity || Math.floor(identity.server_version_num / 10_000) !== expectedMajor
      || (expectedVersionNum !== undefined && identity.server_version_num !== expectedVersionNum)
      || identity.rolsuper || identity.rolcreaterole || identity.rolcreatedb) {
      throw new Error("certification database identity or least-privilege readiness failed");
    }
    const extensions = (await client.query(`SELECT extension.extname::text AS name, namespace.nspname::text AS schema
      FROM pg_catalog.pg_extension AS extension
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) extension.extnamespace
      WHERE extension.extname OPERATOR(pg_catalog.=) ANY($1::text[]) ORDER BY extension.extname`,
    [["pg_stat_statements", "pg_trgm", "pgcrypto", "unaccent"]])).rows;
    if (extensions.length !== 4 || extensions.some((entry) => entry.schema !== "public")) {
      throw new Error("certification required extension readiness failed");
    }
    const migrations = (await client.query("SELECT pg_catalog.count(*)::integer AS count FROM lcm.schema_migrations")).rows[0]?.count;
    if (!Number.isInteger(migrations) || migrations <= 0) throw new Error("certification migration readiness failed");
    const maxConnections = Number((await client.query("SHOW max_connections")).rows[0]?.max_connections);
    const reservedConnections = Number((await client.query("SHOW superuser_reserved_connections")).rows[0]?.superuser_reserved_connections);
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
      maxConnections,
      reservedConnections,
      systemIdentifier,
    };
  } finally {
    await client.end();
  }
}

export async function startClockMonitor({ machineNames, run, url, ca, evidenceDirectory, intervalMs = 60_000 }) {
  const loaded = await import("pg");
  const Client = loaded.Client ?? loaded.default?.Client;
  const client = new Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, statement_timeout: 30_000 });
  await client.connect();
  const samples = [];
  const machineClock = async (name) => {
    const result = await run(["container", "exec", name, "node", "-e", "process.stdout.write(JSON.stringify({wallMs:Date.now(),monotonicNs:process.hrtime.bigint().toString()}))"]);
    return JSON.parse(result.stdout.trim());
  };
  const sample = async () => {
    for (const [machine, name] of Object.entries(machineNames)) {
      const t0 = await machineClock(name);
      const server = (await client.query(`SELECT pg_catalog.clock_timestamp()::text AS now,
        (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_stat_activity
          WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) AS database_connections`)).rows[0];
      const t1 = await machineClock(name);
      const radiusMs = Math.max(0, (t1.wallMs - t0.wallMs) / 2);
      samples.push({ machine, t0, serverTime: server?.now, databaseConnections: server?.database_connections, t1, radiusMs, verdict: radiusMs <= 250 ? "pass" : "fail" });
    }
  };
  await sample();
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
      await sample();
      await client.end();
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

export function prepareEvidenceDirectory(path, metadata) {
  const fromRepository = relative(repositoryRoot, path);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error("certification evidence directory must be outside the repository");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (readdirSync(path).length !== 0) throw new Error("certification evidence directory must be empty");
  writeFileSync(join(path, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export async function runLocalCertification(options, dependencies = {}) {
  if ((dependencies.environment ?? process.env).LCM_TEST_CONTAINER_CLI !== "podman") {
    throw new Error("local certification requires LCM_TEST_CONTAINER_CLI=podman");
  }
  prepareEvidenceDirectory(options.evidenceDirectory, { lane: "local", profile: options.profile, startedAt: new Date().toISOString() });
  const executeHarness = dependencies.runHarness ?? runHarness;
  const result = await executeHarness({
    certificationMachines: true,
    runTests: async (context) => {
      const stage = stageBuiltPackage({
        sourceRoot: dependencies.sourceRoot ?? repositoryRoot,
        destination: join(context.directory, "package"),
        machineAgentPath: new URL("../test/certification/machine-agent.mjs", import.meta.url),
      });
      const machineRoots = {};
      const created = [];
      let clockMonitor;
      try {
        const databaseReadiness = await (dependencies.collectReadiness ?? collectDatabaseReadiness)({
          url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
          expectedVersionNum: 180004,
        });
        mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(options.evidenceDirectory, "database-readiness.json"), `${JSON.stringify(databaseReadiness, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        for (const machine of ['a', 'b']) {
          const home = join(context.directory, `machine-${machine}-home`);
          const evidence = join(options.evidenceDirectory, `machine-${machine}`);
          mkdirSync(home, { recursive: true, mode: 0o700 });
          mkdirSync(evidence, { recursive: true, mode: 0o700 });
          const environmentFile = join(context.directory, `machine-${machine}.env`);
          writeEnvironmentFile(environmentFile, {
            HOME: "/home/lcm",
            LCM_CLIENT: "codex",
            LCM_POSTGRES_URL: context.inNetworkEnvironment.LCM_TEST_POSTGRES_RUNTIME_URL,
            LCM_POSTGRES_CA_FILE: "/run/lcm-ca/ca.crt",
            LCM_CERT_WRONG_CA_FILE: "/run/lcm-ca/wrong-ca.crt",
            LCM_CERT_WRONG_HOST_URL: urlAtHost(context.inNetworkEnvironment.LCM_TEST_POSTGRES_RUNTIME_URL, context.names.wrongAlias),
            LCM_CERT_EVIDENCE_DIR: "/evidence",
            LCM_CERT_PROFILE: options.profile,
            LCM_CERT_LANE: "local",
            LCM_CERT_RUN_ID: context.runId,
          });
          const name = machine === 'a' ? context.names.machineA : context.names.machineB;
          const kind = `machine-${machine}`;
          await context.processRunner(context.containerCli, buildMachineContainerArgs({
            machine, name, hostname: `lcm-cert-${machine}`, network: context.names.network,
            image: NODE_IMAGE, ownerLabels: ownershipLabels(context.runId, kind, context.owner),
            stagedPackage: stage.root, home, caFile: context.environment.LCM_TEST_POSTGRES_CA_FILE,
            wrongCaFile: context.environment.LCM_TEST_POSTGRES_WRONG_CA_FILE,
            evidenceDirectory: evidence, environmentFile,
          }), { redactSecrets: context.secrets });
          created.push(name);
          machineRoots[machine] = { home, evidence };
          await context.processRunner(context.containerCli, ["container", "start", name], { redactSecrets: context.secrets });
        }
        const waitForFile = (path) => poll(() => existsSync(path), { delay: dependencies.delay });
        for (const machine of ['a', 'b']) await waitForFile(join(options.evidenceDirectory, `machine-${machine}`, "ready.json"));
        const identities = verifyDistinctMachineIdentities({ a: machineRoots.a.home, b: machineRoots.b.home });
        writeFileSync(join(options.evidenceDirectory, "machine-identities.json"), `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        const runContainer = (args) => context.processRunner(context.containerCli, args, { redactSecrets: context.secrets });
        clockMonitor = await (dependencies.startClockMonitor ?? startClockMonitor)({
          machineNames: { a: context.names.machineA, b: context.names.machineB },
          run: runContainer,
          url: context.environment.LCM_TEST_POSTGRES_RUNTIME_URL,
          ca: readFileSync(context.environment.LCM_TEST_POSTGRES_CA_FILE, "utf8"),
          evidenceDirectory: options.evidenceDirectory,
        });
        if (options.profile === "full") {
          for (const machine of ['a', 'b']) await waitForFile(join(options.evidenceDirectory, `machine-${machine}`, "fault-ready.json"));
          const partitionRequestedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["network", "disconnect", context.names.network, context.names.machineA], { redactSecrets: context.secrets });
          const partitionAppliedAt = new Date().toISOString();
          await (dependencies.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(60_000);
          await context.processRunner(context.containerCli, ["network", "connect", context.names.network, context.names.machineA], { redactSecrets: context.secrets });
          const partitionClearedAt = new Date().toISOString();
          for (const machine of ['a', 'b']) writeFileSync(
            join(options.evidenceDirectory, `machine-${machine}`, "partition-cleared.json"),
            `${JSON.stringify({ clearedAt: partitionClearedAt })}\n`, { mode: 0o600, flag: "wx" },
          );
          for (const machine of ['a', 'b']) await waitForFile(join(options.evidenceDirectory, `machine-${machine}`, "restart-ready.json"));
          const partitionRecoveredAt = new Date().toISOString();
          const restartRequestedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["container", "stop", "--time", "120", context.names.container], { redactSecrets: context.secrets });
          const restartAppliedAt = new Date().toISOString();
          await context.processRunner(context.containerCli, ["container", "start", context.names.container], { redactSecrets: context.secrets });
          await poll(async () => {
            try {
              await context.processRunner(context.containerCli, ["exec", context.names.container, "pg_isready", "--quiet", "--username", "lcm_harness_admin", "--dbname", context.names.controlDatabase], { redactSecrets: context.secrets });
              return true;
            } catch { return false; }
          }, { attempts: 120, delay: dependencies.delay });
          const restartClearedAt = new Date().toISOString();
          for (const machine of ['a', 'b']) writeFileSync(
            join(options.evidenceDirectory, `machine-${machine}`, "restart-cleared.json"),
            `${JSON.stringify({ clearedAt: restartClearedAt })}\n`, { mode: 0o600, flag: "wx" },
          );
          for (const machine of ['a', 'b']) await waitForFile(join(options.evidenceDirectory, `machine-${machine}`, "restart-recovered.json"));
          const restartRecoveredAt = new Date().toISOString();
          writeFileSync(join(options.evidenceDirectory, "faults.json"), `${JSON.stringify([
            { id: "partition-a", kind: "partition-machine", target: "a", requestedAt: partitionRequestedAt, appliedAt: partitionAppliedAt, clearedAt: partitionClearedAt, recoveredAt: partitionRecoveredAt },
            { id: "restart-database", kind: "restart-database", target: "database", requestedAt: restartRequestedAt, appliedAt: restartAppliedAt, clearedAt: restartClearedAt, recoveredAt: restartRecoveredAt },
          ], null, 2)}\n`, { mode: 0o600, flag: "wx" });
        }
        for (const machine of ['a', 'b']) await waitForFile(join(options.evidenceDirectory, `machine-${machine}`, "drain.json"));
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
        for (const name of created.reverse()) {
          await context.processRunner(context.containerCli, ["container", "rm", "--force", name], { redactSecrets: context.secrets }).catch(() => undefined);
        }
      }
    },
  });
  writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({ verdict: "pass", residualResources: 0 })}\n`, { mode: 0o600, flag: "wx" });
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCertificationArguments(argv);
  loadCertificationContract(new URL("../test/certification/contract-v1.json", import.meta.url));
  if (options.lane === "local") {
    const deadlineSeconds = options.profile === "full" ? 10_800 : 1_800;
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
    process.exitCode = 1;
  });
}
