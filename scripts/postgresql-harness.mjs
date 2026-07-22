#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const POSTGRES_IMAGE = "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";
export const NODE_IMAGE = "node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
export const RUN_LABEL = "com.donadiosolutions.lcm.postgresql-test-run";
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const initScript = join(repositoryRoot, "test", "postgresql", "init.sh");

export function createRunNames(runId) {
  const short = runId.slice(0, 20);
  return {
    container: `lcm-pg-${short}`,
    network: `lcm-pg-net-${short}`,
    volume: `lcm-pg-data-${short}`,
    runner: `lcm-pg-runner-${short}`,
    alias: `lcm-pg-${short}.test`,
    wrongAlias: `lcm-pg-wrong-${short}.test`,
    controlDatabase: `lcm_harness_${short}`,
  };
}

export function validateRunNames(names, runId) {
  if (!/^[0-9a-f]{32}$/u.test(runId)) throw new Error("invalid PostgreSQL harness run ID");
  const expected = createRunNames(runId);
  for (const key of Object.keys(expected)) {
    if (names[key] !== expected[key]) throw new Error(`invalid PostgreSQL harness ${key}`);
  }
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const maxCapturedOutputBytes = MAX_CAPTURED_OUTPUT_BYTES;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const appendTail = (current, chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (next.length >= maxCapturedOutputBytes) return next.subarray(-maxCapturedOutputBytes);
      if (current.length + next.length <= maxCapturedOutputBytes) return Buffer.concat([current, next]);
      return Buffer.concat([current.subarray(current.length + next.length - maxCapturedOutputBytes), next]);
    };
    child.stdout?.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const capturedStdout = stdout.toString("utf8");
      const capturedStderr = stderr.toString("utf8");
      if (code === 0) resolve({ stdout: capturedStdout.trim(), stderr: capturedStderr.trim() });
      else reject(Object.assign(new Error(`${command} failed`), {
        code,
        signal,
        stdout: capturedStdout,
        stderr: capturedStderr,
      }));
    });
  });
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

async function inspectLabels(type, name) {
  const result = await docker([type, "inspect", name]);
  const record = JSON.parse(result.stdout)[0];
  return type === "container" ? record?.Config?.Labels ?? {} : record?.Labels ?? {};
}

async function removeLabeled(type, name, runId) {
  let labels;
  try {
    labels = await inspectLabels(type, name);
  } catch {
    return;
  }
  if (labels[RUN_LABEL] !== runId) throw new Error(`refusing to remove unlabeled ${type}`);
  const args = type === "container"
    ? ["container", "rm", "--force", name]
    : [type, "rm", name];
  await docker(args);
}

async function waitForPostgreSql(container, database, dockerRunner = docker) {
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await dockerRunner(["exec", container, "pg_isready", "--quiet", "--username", "lcm_harness_admin", "--dbname", database]);
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

async function runTests(context, ci, setupDocker = docker) {
  const env = { ...process.env, ...context.environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG") || key === "LCM_POSTGRES_URL" || key === "LCM_POSTGRES_CA_FILE") delete env[key];
  }
  if (!ci) {
    return runProcess(process.execPath, [
      join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
      "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
    ], { cwd: repositoryRoot, env, stdio: "inherit" });
  }

  await runProcess(process.execPath, [
    join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
    "run", "--config", join(repositoryRoot, "vitest.postgresql.config.ts"),
    join(repositoryRoot, "test", "postgresql", "signal.integration.ts"),
  ], { cwd: repositoryRoot, env, stdio: "inherit" });
  const envFile = join(context.directory, "runner.env");
  writeFileSync(envFile, Object.entries({
    ...context.environment,
    LCM_TEST_POSTGRES_INNER_CI: "true",
  }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  await setupDocker([
    "create", "--name", context.names.runner,
    "--label", `${RUN_LABEL}=${context.runId}`,
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
  await docker(["start", "--attach", context.names.runner], { stdio: "inherit" });
}

export async function runHarness(options = {}) {
  const ci = options.ci ?? process.env.GITHUB_ACTIONS === "true";
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
    cleanupPromise ??= (async () => {
      await removeLabeled("container", names.runner, runId).catch(() => undefined);
      if (sentinelReady) await verifyContainerSentinel(names, runId);
      await removeLabeled("container", names.container, runId);
      await removeLabeled("volume", names.volume, runId);
      await removeLabeled("network", names.network, runId);
      rmSync(directory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const onSignal = (signal) => {
    void processLifecycle.stop()
      .then(cleanup)
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    writeFileSync(join(directory, "run-id"), `${runId}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "admin-password"), `${passwords.admin}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "migrator-password"), `${passwords.migrator}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "runtime-password"), `${passwords.runtime}\n`, { mode: 0o600 });
    await writeTlsFixtures(directory, names.alias, setupProcess);
    await setupDocker(["network", "create", "--label", `${RUN_LABEL}=${runId}`, names.network]);
    await setupDocker(["volume", "create", "--label", `${RUN_LABEL}=${runId}`, names.volume]);
    const publish = ci ? [] : ["--publish", "127.0.0.1::5432"];
    await setupDocker([
      "create", "--name", names.container,
      "--label", `${RUN_LABEL}=${runId}`,
      "--network", names.network,
      "--network-alias", names.alias,
      "--network-alias", names.wrongAlias,
      ...publish,
      "--volume", `${names.volume}:/var/lib/postgresql`,
      "--volume", `${directory}:/run/lcm-harness:ro`,
      "--volume", `${initScript}:/docker-entrypoint-initdb.d/10-lcm-harness.sh:ro`,
      "--env", "POSTGRES_USER=lcm_harness_admin",
      "--env", `POSTGRES_DB=${names.controlDatabase}`,
      "--env", "POSTGRES_PASSWORD_FILE=/run/lcm-private/admin-password",
      "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "--entrypoint", "/bin/bash",
      POSTGRES_IMAGE,
      "-ceu",
      "install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/certs /run/lcm-private; install -o postgres -g postgres -m 0600 /run/lcm-harness/server.key /var/lib/postgresql/certs/server.key; install -o postgres -g postgres -m 0644 /run/lcm-harness/server.crt /run/lcm-harness/ca.crt /var/lib/postgresql/certs/; install -o postgres -g postgres -m 0600 /run/lcm-harness/admin-password /run/lcm-harness/migrator-password /run/lcm-harness/runtime-password /run/lcm-harness/run-id /run/lcm-private/; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/certs/server.crt -c ssl_key_file=/var/lib/postgresql/certs/server.key -c ssl_ca_file=/var/lib/postgresql/certs/ca.crt -c shared_preload_libraries=pg_stat_statements -c listen_addresses=* -c password_encryption=scram-sha-256 -c timezone=UTC",
    ]);
    await setupDocker(["start", names.container]);
    try {
      await waitForPostgreSql(names.container, names.controlDatabase, setupDocker);
    } catch (error) {
      const logs = await docker(["logs", names.container]).catch(() => ({ stdout: "", stderr: "" }));
      throw Object.assign(error, { stderr: `${logs.stdout}\n${logs.stderr}` });
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
      else await runTests({ runId, names, directory, environment }, ci, setupDocker);
    } catch (error) {
      const logs = await docker(["logs", names.container]).catch(() => ({ stdout: "", stderr: "" }));
      throw Object.assign(error, { stderr: `${error?.stderr ?? ""}\n${logs.stdout}\n${logs.stderr}` });
    }
  } catch (error) {
    const details = sanitizeHarnessText(error?.stderr ?? error?.message ?? error, secrets);
    process.stderr.write(`PostgreSQL harness failed: ${details}\n`);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await processLifecycle.stop();
    await cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const signalProbe = process.argv.includes("--signal-probe");
  runHarness(signalProbe ? {
    runTests: async ({ runId }) => {
      process.stderr.write(`PostgreSQL harness signal probe ready: ${runId}\n`);
      await new Promise(() => { setInterval(() => undefined, 1_000); });
    },
  } : {}).catch(() => { process.exitCode = 1; });
}
