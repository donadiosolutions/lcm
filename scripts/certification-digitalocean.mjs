#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareEvidenceDirectory, runManagedMachinePair } from "./certification-harness.mjs";

const API_ORIGIN = "https://api.digitalocean.com";
const FAMILY_TAG = "lcm-cert";

export function readDigitalOceanToken(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("DigitalOcean token file is required");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error("DigitalOcean token path must be a regular file");
    if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
      throw new Error("DigitalOcean token file must use mode 0600");
    }
    if (status.size <= 0 || status.size > 16_384) throw new Error("DigitalOcean token file has an invalid size");
    const token = readFileSync(descriptor, "utf8").trim();
    if (!token || token.includes("\n") || token.includes("\r")) throw new Error("DigitalOcean token file is invalid");
    return token;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function registerResponseSecrets(value, registerSecret) {
  if (Array.isArray(value)) {
    for (const entry of value) registerResponseSecrets(entry, registerSecret);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "password" || key === "uri" || key.endsWith("_uri")) && typeof entry === "string" && entry.length > 0) {
      registerSecret(entry);
    }
    registerResponseSecrets(entry, registerSecret);
  }
}
export function createDigitalOceanClient({
  token,
  registerSecret,
  fetch: fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
}) {
  if (typeof token !== "string" || token.length === 0) throw new Error("DigitalOcean token is required");
  if (typeof registerSecret !== "function") throw new Error("DigitalOcean redactor registration is required");
  registerSecret(token);
  return {
    registerSecret,
    async request(method, path, body, options = {}) {
      if (typeof path !== "string" || !path.startsWith("/v2/") || path.includes("://")) {
        throw new Error("DigitalOcean request path must be relative to the fixed API origin");
      }
      const response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.redirected) throw new Error("DigitalOcean API redirect refused");
      const text = await response.text();
      let parsed = {};
      if (text) {
        try { parsed = JSON.parse(text); }
        catch { throw new Error(`DigitalOcean API returned invalid JSON (HTTP ${response.status})`); }
      }
      registerResponseSecrets(parsed, registerSecret);
      if (!response.ok && !(options.allow404 && response.status === 404)) {
        const error = new Error(`DigitalOcean API request failed (HTTP ${response.status})`);
        error.status = response.status;
        throw error;
      }
      return { status: response.status, body: parsed };
    },
  };
}

function validIpv4(value) {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255 && String(Number(part)) === part);
}

function assertOwnedCluster(cluster, ownership) {
  if (!cluster || cluster.id !== ownership.id || cluster.name !== ownership.name
    || !Array.isArray(cluster.tags) || !ownership.tags.every((tag) => cluster.tags.includes(tag))) {
    throw new Error("refusing to mutate a DigitalOcean cluster with changed ownership");
  }
}

function allowlistedCluster(cluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    host: cluster.host,
    port: cluster.port,
    status: cluster.status,
    tags: [...cluster.tags].sort(),
  };
}

function databaseUrl(user, password, host, port, database) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

async function listByTag(client, tag) {
  const response = await client.request("GET", `/v2/databases?tag_name=${encodeURIComponent(tag)}`);
  if (!Array.isArray(response.body.databases)) throw new Error("DigitalOcean database list is malformed");
  return response.body.databases;
}

async function waitOnline(client, ownership, guard, delay) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    guard();
    const response = await client.request("GET", `/v2/databases/${ownership.id}`);
    const cluster = response.body.database;
    assertOwnedCluster(cluster, ownership);
    if (cluster.status === "online") return cluster;
    await delay(5_000);
  }
  throw new Error("DigitalOcean cluster did not become online before the poll limit");
}

async function destroyOwned(client, ownership, { delay, now, deadlineMs }) {
  const current = await client.request("GET", `/v2/databases/${ownership.id}`, undefined, { allow404: true });
  if (current.status !== 404) {
    assertOwnedCluster(current.body.database, ownership);
    await client.request("DELETE", `/v2/databases/${ownership.id}`);
  }
  let confirmed404 = false;
  while (now() < deadlineMs) {
    const witness = await client.request("GET", `/v2/databases/${ownership.id}`, undefined, { allow404: true });
    if (witness.status === 404) { confirmed404 = true; break; }
    await delay(5_000);
  }
  if (!confirmed404) throw new Error(`DigitalOcean destroy was not confirmed for cluster ${ownership.id}`);
  while (now() < deadlineMs) {
    if ((await listByTag(client, FAMILY_TAG)).length === 0) return;
    await delay(5_000);
  }
  throw new Error("DigitalOcean family tag is not empty after destroy");
}

export async function runDigitalOceanLifecycle({
  client,
  runId,
  trustedIpv4,
  receiptPath,
  useCluster,
  now = Date.now,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  modeledHourlyUsd = 0.04531,
  modeledSpendCeilingUsd = 5,
  absoluteDeadlineSeconds = 21_600,
  stopNewWorkAtSeconds = 20_700,
}) {
  if (!/^[a-z0-9]{8,32}$/u.test(runId)) throw new Error("invalid certification run ID");
  if (!validIpv4(trustedIpv4)) throw new Error("trusted source must be a canonical IPv4 address");
  const started = now();
  const guard = () => {
    const elapsedSeconds = Math.max(0, (now() - started) / 1000);
    const modeledSpend = elapsedSeconds / 3600 * modeledHourlyUsd;
    if (elapsedSeconds >= stopNewWorkAtSeconds || elapsedSeconds >= absoluteDeadlineSeconds || modeledSpend >= modeledSpendCeilingUsd) {
      throw new Error("DigitalOcean certification spend or deadline guard reached");
    }
  };
  if ((await listByTag(client, FAMILY_TAG)).length !== 0) {
    throw new Error("DigitalOcean family tag preflight is not empty");
  }
  const name = `lcm-cert-${runId}`;
  const runTag = `lcm-cert-run-${runId}`;
  const tags = [FAMILY_TAG, runTag];
  let cluster;
  try {
    guard();
    const created = await client.request("POST", "/v2/databases", {
      name, engine: "pg", version: "18", size: "db-s-1vcpu-2gb", region: "nyc3", num_nodes: 1, tags,
    });
    cluster = created.body.database;
  } catch (error) {
    const candidates = await listByTag(client, runTag);
    const exact = candidates.filter((candidate) => candidate.name === name && tags.every((tag) => candidate.tags?.includes(tag)));
    if (exact.length !== 1) throw error;
    cluster = exact[0];
  }
  const ownership = { id: cluster.id, name, tags };
  const createdCluster = cluster;
  assertOwnedCluster(cluster, ownership);
  writeFileSync(receiptPath, `${JSON.stringify({ version: 1, ...ownership })}\n`, { mode: 0o600, flag: "wx" });
  let useResult;
  let online;
  let primaryError;
  try {
    online = await waitOnline(client, ownership, guard, delay);
    guard();
    const rules = [{ type: "ip_addr", value: trustedIpv4 }];
    await client.request("PUT", `/v2/databases/${ownership.id}/firewall`, { rules });
    const readback = await client.request("GET", `/v2/databases/${ownership.id}/firewall`);
    if (JSON.stringify(readback.body.rules) !== JSON.stringify(rules)) {
      throw new Error("DigitalOcean firewall readback did not equal the trusted IPv4 rule");
    }
    guard();
    const databaseName = `lcm_cert_${runId}`.slice(0, 63);
    const migratorName = `lcm_cert_migrator_${runId}`.slice(0, 63);
    const runtimeName = `lcm_cert_runtime_${runId}`.slice(0, 63);
    const caResponse = await client.request("GET", `/v2/databases/${ownership.id}/ca`);
    const ca = caResponse.body?.ca?.certificate ?? caResponse.body?.ca;
    if (typeof ca !== "string" || !ca.includes("BEGIN CERTIFICATE")) throw new Error("DigitalOcean CA response is malformed");
    await client.request("POST", `/v2/databases/${ownership.id}/dbs`, { name: databaseName });
    const migratorResponse = await client.request("POST", `/v2/databases/${ownership.id}/users`, { name: migratorName });
    const runtimeResponse = await client.request("POST", `/v2/databases/${ownership.id}/users`, { name: runtimeName });
    const migrator = migratorResponse.body.user;
    const runtime = runtimeResponse.body.user;
    const adminUser = createdCluster.user ?? createdCluster.connection?.user;
    const adminPassword = createdCluster.password ?? createdCluster.connection?.password;
    if (![adminUser, adminPassword, migrator?.name, migrator?.password, runtime?.name, runtime?.password]
      .every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("DigitalOcean database credentials are incomplete");
    }
    const privateConnection = {
      ca,
      databaseName,
      migratorName,
      runtimeName,
      adminUrl: databaseUrl(adminUser, adminPassword, online.host, online.port, databaseName),
      migratorUrl: databaseUrl(migrator.name, migrator.password, online.host, online.port, databaseName),
      runtimeUrl: databaseUrl(runtime.name, runtime.password, online.host, online.port, databaseName),
    };
    for (const value of [privateConnection.adminUrl, privateConnection.migratorUrl, privateConnection.runtimeUrl]) {
      client.registerSecret(value);
    }
    const elapsedMs = Math.max(0, now() - started);
    const remainingWorkMs = Math.max(1, stopNewWorkAtSeconds * 1000 - elapsedMs);
    const workloadController = new AbortController();
    const workloadDeadline = setTimeout(() => workloadController.abort(new Error("DigitalOcean certification stop-new-work deadline reached")), remainingWorkMs);
    try {
      useResult = await useCluster(allowlistedCluster(online), privateConnection, { signal: workloadController.signal });
    } finally {
      clearTimeout(workloadDeadline);
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await destroyOwned(client, ownership, { delay, now, deadlineMs: started + absoluteDeadlineSeconds * 1000 });
  } catch (cleanupError) {
    const failure = new Error(`DigitalOcean cleanup failed for cluster ${ownership.id}; reconcile ownership, then run: doctl databases delete ${ownership.id} --force`);
    failure.cause = cleanupError;
    if (primaryError) throw new AggregateError([primaryError, failure], "DigitalOcean certification and cleanup failed");
    throw failure;
  }
  if (primaryError) throw primaryError;
  return { cluster: allowlistedCluster(online), result: useResult, cleanup: { destroyedId: ownership.id, confirmed404: true, emptyFamilyTag: true } };
}

export async function runManagedCertification(options, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const token = dependencies.token ?? readDigitalOceanToken(environment.LCM_CERT_DIGITALOCEAN_TOKEN_FILE);
  const secrets = dependencies.secrets ?? [];
  const registerSecret = dependencies.registerSecret ?? ((secret) => secrets.push(secret));
  const client = dependencies.client ?? createDigitalOceanClient({
    token,
    registerSecret,
    fetch: dependencies.fetch,
  });
  const lifecycle = dependencies.runLifecycle ?? runDigitalOceanLifecycle;
  if (dependencies.prepareEvidence !== false) {
    prepareEvidenceDirectory(options.evidenceDirectory, { lane: "managed", profile: options.profile, startedAt: new Date().toISOString() });
  }
  const receiptPath = environment.LCM_CERT_CREATED_ID_RECEIPT;
  const lockPath = environment.LCM_CERT_FAMILY_LOCK_FILE ?? join(dirname(receiptPath), "lcm-cert-family.lock");
  const openLock = dependencies.openLock ?? (() => openSync(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ));
  const lock = openLock();
  try {
    writeFileSync(lock, `${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    const result = await lifecycle({
      client,
      runId: environment.LCM_CERT_RUN_ID,
      trustedIpv4: environment.LCM_CERT_TRUSTED_IPV4,
      receiptPath,
      useCluster: (cluster, privateConnection, workload) => (dependencies.runMachinePair ?? runManagedMachinePair)({
        cluster,
        privateConnection,
        wrongCa: dependencies.wrongCa,
        runId: environment.LCM_CERT_RUN_ID,
        profile: options.profile,
        evidenceDirectory: options.evidenceDirectory,
        secrets,
        signal: workload.signal,
      }, dependencies.machineDependencies),
    });
    writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({
      verdict: "pass",
      residualResources: 0,
      provider: result.cleanup,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return result;
  } finally {
    closeSync(lock);
    (dependencies.releaseLock ?? unlinkSync)(lockPath);
  }
}
