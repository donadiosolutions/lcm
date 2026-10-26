#!/usr/bin/env node
import { constants, closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { prepareEvidenceDirectory, runManagedMachinePair } from "./certification-harness.mjs";

const API_ORIGIN = "https://api.digitalocean.com";
const FAMILY_TAG = "lcm-cert";

function parseDigitalOceanToken(contents) {
  const text = contents.trim();
  if (!text) throw new Error("DigitalOcean token file is invalid");
  const matches = contents.split(/\r?\n/u).filter((line) => /^access-token\s*:/u.test(line));
  if (matches.length === 0) {
    if (text.includes("\n") || text.includes("\r") || text.includes(":")) {
      throw new Error("DigitalOcean doctl config must contain exactly one top-level access-token");
    }
    return text;
  }
  if (matches.length !== 1) {
    throw new Error("DigitalOcean doctl config must contain exactly one top-level access-token");
  }
  const scalar = matches[0].replace(/^access-token\s*:/u, "").trim();
  let token;
  if (/^"(?:[^"\\]|\\.)*"$/u.test(scalar)) {
    token = JSON.parse(scalar);
  } else if (/^'(?:[^']|'')*'$/u.test(scalar)) {
    token = scalar.slice(1, -1).replace(/''/gu, "'");
  } else if (/^\S+$/u.test(scalar)) {
    token = scalar;
  }
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error("DigitalOcean access-token scalar is invalid");
  }
  return token;
}

export function readDigitalOceanToken(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("DigitalOcean token file is required");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error("DigitalOcean token path must be a regular file");
    if (process.platform !== "win32" && process.getuid && status.uid !== process.getuid()) {
      throw new Error("DigitalOcean token file must be owned by the current user");
    }
    if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
      throw new Error("DigitalOcean token file must use mode 0600");
    }
    if (status.size <= 0 || status.size > 16_384) throw new Error("DigitalOcean token file has an invalid size");
    const buffer = Buffer.alloc(Number(status.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== status.size) throw new Error("DigitalOcean token file changed while reading");
    return parseDigitalOceanToken(buffer.toString("utf8"));
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

async function readBoundedResponse(response, maximumBytes = 1024 * 1024) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) throw new Error("DigitalOcean API response exceeded the safe limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error("DigitalOcean API response exceeded the safe limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
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
  let absoluteDeadlineMs;
  let monotonicNow = () => performance.now();
  return {
    registerSecret,
    setDeadline(deadlineMs, now = monotonicNow) { absoluteDeadlineMs = deadlineMs; monotonicNow = now; },
    async request(method, path, body, options = {}) {
      if (typeof path !== "string" || !path.startsWith("/v2/") || path.includes("://")) {
        throw new Error("DigitalOcean request path must be relative to the fixed API origin");
      }
      const remainingMs = absoluteDeadlineMs === undefined ? requestTimeoutMs : Math.max(1, absoluteDeadlineMs - monotonicNow());
      const timeoutSignal = AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs));
      const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: requestSignal,
      });
      if (response.redirected) throw new Error("DigitalOcean API redirect refused");
      const text = await readBoundedResponse(response);
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

export function normalizeFirewallRules(rules) {
  if (!Array.isArray(rules)) throw new Error("DigitalOcean firewall readback is malformed");
  return rules.map((rule) => ({ type: rule?.type, value: rule?.value }))
    .sort((left, right) => `${left.type}:${left.value}`.localeCompare(`${right.type}:${right.value}`));
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

export async function listByTag(client, tag) {
  const databases = [];
  let path = `/v2/databases?tag_name=${encodeURIComponent(tag)}&per_page=200`;
  for (let page = 0; path !== undefined && page < 100; page += 1) {
    const response = await client.request("GET", path);
    if (!Array.isArray(response.body.databases)) throw new Error("DigitalOcean database list is malformed");
    databases.push(...response.body.databases);
    const next = response.body.links?.pages?.next;
    if (next === undefined || next === null || next === "") { path = undefined; continue; }
    const parsed = new URL(next, API_ORIGIN);
    if (parsed.origin !== API_ORIGIN || !parsed.pathname.startsWith("/v2/databases")) throw new Error("DigitalOcean pagination escaped the fixed API origin");
    path = `${parsed.pathname}${parsed.search}`;
  }
  if (path !== undefined) throw new Error("DigitalOcean database pagination exceeded the safe page limit");
  return databases;
}

async function waitOnline(client, ownership, guard, delay) {
  while (true) {
    guard();
    const response = await client.request("GET", `/v2/databases/${ownership.id}`);
    const cluster = response.body.database;
    assertOwnedCluster(cluster, ownership);
    if (cluster.status === "online") return cluster;
    await delay(5_000);
  }
}

function reserveCreatedIdReceipt(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("DigitalOcean created-ID receipt path must be absolute");
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let committed = false;
  return {
    commit(value) {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      ftruncateSync(descriptor, 0);
      if (writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("DigitalOcean created-ID receipt write was incomplete");
      committed = true;
    },
    close() {
      closeSync(descriptor);
      if (!committed) unlinkSync(path);
    },
  };
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

async function runDigitalOceanLifecycleCore({
  client,
  runId,
  trustedIpv4,
  receiptPath,
  useCluster,
  now = () => performance.now(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  modeledHourlyUsd = 0.04531,
  modeledSpendCeilingUsd = 5,
  absoluteDeadlineSeconds = 21_600,
  stopNewWorkAtSeconds = 20_700,
  receipt,
  signal,
}) {
  if (!/^[a-z0-9]{8,32}$/u.test(runId)) throw new Error("invalid certification run ID");
  if (!validIpv4(trustedIpv4)) throw new Error("trusted source must be a canonical IPv4 address");
  const started = now();
  client.setDeadline?.(started + absoluteDeadlineSeconds * 1000, now);
  const guard = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("DigitalOcean certification aborted");
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
  if (typeof cluster?.id !== "string" || cluster.id.length === 0) {
    const candidates = await listByTag(client, runTag);
    const exact = candidates.filter((candidate) => candidate.name === name && tags.every((tag) => candidate.tags?.includes(tag)));
    if (exact.length !== 1) throw new Error("DigitalOcean create response omitted an ID and reconciliation was not unique");
    cluster = exact[0];
  }
  const ownership = { id: cluster.id, name, tags };
  const createdCluster = cluster;
  if (typeof ownership.id !== "string" || ownership.id.length === 0) throw new Error("DigitalOcean create response omitted the cluster ID");
  let useResult;
  let online;
  let primaryError;
  try {
    receipt.commit({ version: 1, ...ownership });
    assertOwnedCluster(cluster, ownership);
    online = await waitOnline(client, ownership, guard, delay);
    guard();
    const rules = [{ type: "ip_addr", value: trustedIpv4 }];
    await client.request("PUT", `/v2/databases/${ownership.id}/firewall`, { rules });
    const readback = await client.request("GET", `/v2/databases/${ownership.id}/firewall`);
    if (JSON.stringify(normalizeFirewallRules(readback.body.rules)) !== JSON.stringify(rules)) {
      throw new Error("DigitalOcean firewall readback did not equal the trusted IPv4 rule");
    }
    guard();
    const databaseName = `lcm_cert_${runId}`.slice(0, 63);
    const migratorName = `lcm_cert_migrator_${runId}`.slice(0, 63);
    const runtimeName = `lcm_cert_runtime_${runId}`.slice(0, 63);
    const caResponse = await client.request("GET", `/v2/databases/${ownership.id}/ca`);
    const ca = caResponse.body?.ca?.certificate ?? caResponse.body?.ca;
    if (typeof ca !== "string" || !ca.includes("BEGIN CERTIFICATE")) throw new Error("DigitalOcean CA response is malformed");
    guard();
    await client.request("POST", `/v2/databases/${ownership.id}/dbs`, { name: databaseName });
    guard();
    const migratorResponse = await client.request("POST", `/v2/databases/${ownership.id}/users`, { name: migratorName });
    guard();
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
    const spendDeadlineMs = modeledSpendCeilingUsd / modeledHourlyUsd * 3600 * 1000;
    const remainingWorkMs = Math.max(1, Math.min(stopNewWorkAtSeconds * 1000, spendDeadlineMs) - elapsedMs);
    const workloadController = new AbortController();
    const workloadDeadline = setTimeout(() => workloadController.abort(new Error("DigitalOcean certification stop-new-work deadline reached")), remainingWorkMs);
    try {
      const workloadSignal = signal ? AbortSignal.any([workloadController.signal, signal]) : workloadController.signal;
      useResult = await useCluster(allowlistedCluster(online), privateConnection, { signal: workloadSignal });
    } finally {
      clearTimeout(workloadDeadline);
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupStarted = now();
  try {
    await destroyOwned(client, ownership, { delay, now, deadlineMs: started + absoluteDeadlineSeconds * 1000 });
  } catch (cleanupError) {
    const failure = new Error(`DigitalOcean cleanup failed for cluster ${ownership.id}; reconcile ownership, then run: doctl databases delete ${ownership.id} --force`);
    failure.cause = cleanupError;
    failure.providerCleanup = { destroyedId: ownership.id, confirmed404: false, emptyFamilyTag: false, seconds: (now() - cleanupStarted) / 1000 };
    if (primaryError) {
      const combined = new AggregateError([primaryError, failure], "DigitalOcean certification and cleanup failed");
      combined.providerCleanup = failure.providerCleanup;
      throw combined;
    }
    throw failure;
  }
  const providerCleanup = { destroyedId: ownership.id, confirmed404: true, emptyFamilyTag: true, seconds: (now() - cleanupStarted) / 1000 };
  if (primaryError) {
    primaryError.providerCleanup = providerCleanup;
    throw primaryError;
  }
  return { cluster: allowlistedCluster(online), result: useResult, cleanup: providerCleanup };
}

export async function runDigitalOceanLifecycle(input) {
  const receipt = (input.reserveReceipt ?? reserveCreatedIdReceipt)(input.receiptPath);
  try { return await runDigitalOceanLifecycleCore({ ...input, receipt }); }
  finally { receipt.close(); }
}

export async function runManagedCertification(options, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const secrets = dependencies.secrets ?? [];
  const registerSecret = dependencies.registerSecret ?? ((secret) => secrets.push(secret));
  const token = dependencies.token ?? readDigitalOceanToken(environment.LCM_CERT_DIGITALOCEAN_TOKEN_FILE);
  registerSecret(token);
  const client = dependencies.client ?? createDigitalOceanClient({
    token,
    registerSecret,
    fetch: dependencies.fetch,
  });
  const lifecycle = dependencies.runLifecycle ?? runDigitalOceanLifecycle;
  if (dependencies.prepareEvidence !== false) {
    prepareEvidenceDirectory(options.evidenceDirectory, {
      lane: "managed",
      profile: options.profile,
      runId: environment.LCM_CERT_RUN_ID,
      contractSha256: options.contractSha256,
      approval: options.approval,
      startedAt: new Date().toISOString(),
    });
  }
  const receiptPath = environment.LCM_CERT_CREATED_ID_RECEIPT;
  const lockPath = environment.LCM_CERT_FAMILY_LOCK_FILE ?? join(dirname(receiptPath), "lcm-cert-family.lock");
  const openLock = dependencies.openLock ?? (() => openSync(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ));
  const lock = openLock();
  const signalEmitter = dependencies.signalEmitter ?? process;
  const signalController = new AbortController();
  let receivedSignal;
  const onSignal = (signal) => {
    receivedSignal ??= signal;
    signalController.abort(new Error(`managed certification received ${signal}`));
  };
  const handlers = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
    SIGHUP: () => onSignal("SIGHUP"),
  };
  for (const [signal, handler] of Object.entries(handlers)) signalEmitter.on(signal, handler);
  try {
    writeFileSync(lock, `${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    const result = await lifecycle({
      client,
      runId: environment.LCM_CERT_RUN_ID,
      trustedIpv4: environment.LCM_CERT_TRUSTED_IPV4,
      receiptPath,
      signal: signalController.signal,
      useCluster: (cluster, privateConnection, workload) => (dependencies.runMachinePair ?? runManagedMachinePair)({
        cluster,
        privateConnection,
        wrongCa: dependencies.wrongCa,
        runId: environment.LCM_CERT_RUN_ID,
        profile: options.profile,
        contract: options.contract,
        contractSha256: options.contractSha256,
        evidenceDirectory: options.evidenceDirectory,
        secrets,
        signal: workload.signal,
      }, dependencies.machineDependencies),
    });
    writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({
      verdict: "pass",
      residualResources: 0,
      labeledContainers: 0,
      labeledNetworks: 0,
      labeledVolumes: 0,
      familyTaggedProviderClusters: 0,
      privateRootsAbsent: true,
      ownedProcessesExited: true,
      providerDestroyConfirmedWithinSeconds: result.cleanup.seconds,
      provider: result.cleanup,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (receivedSignal) {
      const error = new Error(`managed certification received ${receivedSignal}`);
      error.providerCleanup = result.cleanup;
      error.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 129;
      throw error;
    }
    return result;
  } catch (error) {
    if (!existsSync(join(options.evidenceDirectory, "cleanup.json"))) {
      const provider = error.providerCleanup;
      const providerClean = provider?.confirmed404 === true && provider?.emptyFamilyTag === true;
      const localClean = error.localCleanupIncomplete !== true;
      writeFileSync(join(options.evidenceDirectory, "cleanup.json"), `${JSON.stringify({
        verdict: providerClean && localClean ? "pass" : "incomplete",
        residualResources: 0,
        labeledContainers: 0,
        labeledNetworks: 0,
        labeledVolumes: 0,
        familyTaggedProviderClusters: providerClean ? 0 : 1,
        privateRootsAbsent: localClean,
        ownedProcessesExited: localClean,
        providerDestroyConfirmedWithinSeconds: provider?.seconds ?? 0,
        ...(provider ? { provider } : {}),
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    if (receivedSignal) error.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 129;
    throw error;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) signalEmitter.removeListener(signal, handler);
    closeSync(lock);
    (dependencies.releaseLock ?? unlinkSync)(lockPath);
  }
}
