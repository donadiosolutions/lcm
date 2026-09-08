import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PrivateMutationLockContentionError } from '../../../dist/src/private-mutation-lock.js';
import { setTimeout as delay } from 'node:timers/promises';
import { findUserSystemdPid } from '../../../dist/src/daemon/lifecycle.js';
import { createDaemon } from '../../../dist/src/daemon/server.js';
import { loadDaemonConfig } from '../../../dist/src/daemon/config.js';
import { DaemonClient } from '../../../dist/src/daemon/client.js';
import { ensureAuthToken } from '../../../dist/src/daemon/auth.js';
import { setConfigValue } from '../../../dist/src/config-manager.js';
import { resolveStorageIdentityContext } from '../../../dist/src/storage/identity-context.js';
import { createStorageBackendFactory } from '../../../dist/src/storage/factory.js';
import { hashProjectPath, readProjectMapSnapshot, resolveExistingProjectIdentity } from '../../../dist/src/project-map.js';
import { createFaultHooks, runFaultScenario } from './surface-parity-faults.mjs';
import { runSurfaceScenario, snapshotSurfaceState, createSurfaceSnapshotReaders, assertSnapshotUnchanged, assertLogicalSnapshotUnchanged } from './surface-parity-workflows.mjs';

Error.stackTraceLimit = 30;

// The process owns one configuration for its entire lifetime. No inherited user
// HOME, daemon metadata, database selector, token or system-manager bus is used.
const homeDir = process.env.HOME;
const backend = process.env.LCM_SURFACE_BACKEND;
const projectPath = process.env.LCM_SURFACE_PROJECT_PATH;
const secondaryProjectPath = process.env.LCM_SURFACE_SECONDARY_PROJECT_PATH;
assert.ok(homeDir && projectPath && secondaryProjectPath, 'surface-worker:owned-roots');
assert.ok(backend === 'sqlite' || backend === 'postgresql', 'surface-worker:backend');
const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const bin = join(repository, 'dist/lcm.mjs');
const configPath = join(homeDir, '.lcm/config.json');
const tokenPath = join(homeDir, '.lcm/daemon.token');
const fullMatrix = JSON.parse(readFileSync(join(repository, 'test/surface-parity/surface-matrix.json'), 'utf8'));
const faultAssertions = new Set(['pool-exhaustion', 'cancellation', 'backend-denial', 'startup-unavailable']);
const matrix = fullMatrix.map(row => ({ ...row, assertions: row.assertions.filter(id => !faultAssertions.has(id)) }));
const childProcesses = new Set();
const adminPending = new Map();
let adminSequence = 0;
let baseline;
let baselineStarted = false;
let directDaemon;
let transport;
let mcpClient;
let mcpErrorBytes = 0;
let readFactory;
let busy = false;
let stopping = false;
let lastSequence = 0;
let activeScenario = 'startup';
let observedBookkeeping = new Map();
const streamLimit = 32768;

function failure(error) {
  const message = String(error?.message ?? error);
  const symbolic = message.match(/^(?:surface[-\w]*:)[a-zA-Z0-9:._-]+/u)?.[0];
  const knownNames = new Set(['ConfigValidationError', 'BackendPublicationJournalError', 'PrivateMutationLockContentionError', 'TypeError', 'SyntaxError', 'StorageOperationError', 'PostgreSqlStorageOperationError']);
  const errorName = knownNames.has(error?.name) ? error.name : knownNames.has(error?.constructor?.name) ? error.constructor.name : undefined;
  const knownCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBADF', 'EBUSY', 'EAGAIN', 'ESTALE', 'ERR_INVALID_STATE', 'ERR_INVALID_ARG_TYPE', 'ERR_SQLITE_ERROR']);
  const fallbackId = errorName ? `surface-worker:${errorName}` : knownCodes.has(error?.code) ? `surface-worker:${error.code}` : 'surface-worker:assertion';
  const frame = String(error?.stack ?? '').match(/(surface-parity-[a-z-]+\.mjs):(\d+):\d+/u);
  return { id: `${symbolic ?? fallbackId}${frame ? `:${frame[1]}:${frame[2]}` : ''}`.slice(0, 80), digest: error?.surfaceEvidence?.stderrDigest ?? createHash('sha256').update(message).digest('hex') };
}
function send(message) {
  const json = JSON.stringify(message);
  assert.ok(Buffer.byteLength(json) <= 262144, 'surface-worker:ipc-bound');
  if (!process.connected) throw new Error('surface-worker:ipc-disconnected');
  process.send(message);
}
function bounded(promise, milliseconds, id) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`surface-worker:${id}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function launch(args, options = {}) {
  const env = { ...process.env, PWD: options.cwd ?? projectPath };
  // Administrative credentials are passed only to the explicit owned migration.
  delete env.LCM_SURFACE_ADMIN_URL;
  delete env.LCM_SURFACE_MIGRATOR_URL;
  if (options.administrator) env.LCM_POSTGRES_URL = process.env.LCM_SURFACE_MIGRATOR_URL;
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: options.cwd ?? projectPath, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  childProcesses.add(child);
  child.once('exit', () => childProcesses.delete(child));
  return child;
}
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  try { await bounded(exited, 10000, 'child-shutdown'); }
  catch (error) { child.kill('SIGKILL'); await bounded(exited, 2000, 'child-kill'); throw error; }
}
async function cli(args, options = {}) {
  assert.ok(!stopping, 'surface-worker:cli-after-stop');
  const child = launch(args, options);
  let stdout = '';
  let stderr = '';
  let overflow = false;
  for (const [stream, append] of [[child.stdout, bytes => { stdout += bytes; }], [child.stderr, bytes => { stderr += bytes; }]]) {
    stream.on('data', bytes => {
      append(bytes);
      if (Buffer.byteLength(stdout) > streamLimit || Buffer.byteLength(stderr) > streamLimit) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
  }
  const complete = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  child.stdin.end(options.stdin ?? '');
  try {
    const result = await bounded(complete, 25000, 'cli-timeout');
    assert.ok(!overflow, 'surface-worker:cli-output-bound');
    assert.equal(result.signal, null, 'surface-worker:cli-signal');
    return { code: result.code, stdout, stderr };
  } finally { await terminate(child); }
}
async function availablePort() {
  const listener = createServer();
  await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen));
  const port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
  return port;
}
function selectPort(port) {
  setConfigValue({ configPath, path: 'daemon.port', value: String(port), json: true });
}
function projectDatabasePaths(root = join(homeDir, '.lcm/projects')) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('surface-worker:unexpected-symlink');
    return entry.isDirectory() ? projectDatabasePaths(path)
      : /^db\.sqlite(?:-wal|-shm)?$/u.test(entry.name) ? [path] : [];
  });
}
async function assertNoFallback() {
  await withReadAdmission(() => {
    assert.equal(loadDaemonConfig(configPath).storage.backend, backend, 'surface-worker:selection-changed');
    if (backend === 'postgresql') assert.equal(projectDatabasePaths().length, 0, 'surface-worker:sqlite-fallback-file');
  });
}

async function request(method, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.auth !== false && options.authenticated !== false) headers.Authorization = `Bearer ${readFileSync(tokenPath, 'utf8').trim()}`;
  const response = await fetch(`${context.baseUrl}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.signal ?? AbortSignal.timeout(20000),
  });
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= streamLimit, 'surface-worker:http-output-bound');
  return { status: response.status, body: text.length ? JSON.parse(text) : null };
}
async function withReadAdmission(operation) {
  const deadline = performance.now() + 2000;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      // This is solely the test observer's admission, never a public operation
      // or its returned status. Preserve every other failure without retrying.
      if (!(error instanceof PrivateMutationLockContentionError) || performance.now() >= deadline) throw error;
      await delay(10);
    }
  }
}
async function readProject(id, callback) {
  const storage = await withReadAdmission(async () => {
    // Retain the fixed selected configuration. The separate config witness
    // still checks the real persisted backend around every public scenario.
    readFactory ??= await createStorageBackendFactory(context.config.storage, homeDir);
    const matches = Object.entries(readProjectMapSnapshot()).filter(([localId, entry]) => localId === id || entry.remoteProjectId === id);
    assert.equal(matches.length, 1, 'surface-worker:read-project-unique-binding');
    const canonical = resolve(matches[0][1].canonical);
    assert.ok([homeDir, dirname(projectPath)].some(root => canonical === root || canonical.startsWith(`${root}/`)), 'surface-worker:read-project-owned-path');
    const identity = resolveExistingProjectIdentity(canonical);
    assert.ok(identity && (id === identity.id || id === identity.remoteProjectId), 'surface-worker:read-project-identity');
    return readFactory.openExistingProject(resolveStorageIdentityContext(context.config.storage, identity, homeDir, canonical));
  });
  assert.ok(storage, 'surface-worker:existing-project');
  try { return await callback(storage); } finally { await storage.close(); }
}

function admin(action, payload = {}) {
  const seq = ++adminSequence;
  return bounded(new Promise((resolveAdmin, reject) => {
    adminPending.set(seq, { resolve: resolveAdmin, reject });
    send({ type: 'admin', seq, action, payload });
  }), 15000, 'admin-timeout').finally(() => adminPending.delete(seq));
}
let snapshotReaders = createSurfaceSnapshotReaders();
let snapshotCleanupFailed = false;
function closeSnapshotReaders() {
  try { snapshotReaders.close(); } catch (error) { snapshotCleanupFailed = true; throw error; }
}
function resetSnapshotReaders() {
  closeSnapshotReaders();
  snapshotReaders = createSurfaceSnapshotReaders();
  context.snapshotReaders = snapshotReaders;
}
function recordBookkeeping(phase, delta) {
  assert.equal(phase, activeScenario === 'compaction' ? 'compact-preview' : activeScenario === 'diagnostics' ? 'health-readiness' : activeScenario, 'surface-worker:bookkeeping-phase');
  assert.ok(['compact-preview', 'fault-denial', 'fault-pool', 'fault-cancellation', 'fault-unavailable', 'health-readiness'].includes(phase), 'surface-worker:bookkeeping-phase');
  for (const [field, action] of [['databaseBytesChanged', 'bytes-changed'], ['coordinationCreated', 'created'], ['coordinationRemoved', 'removed'], ['coordinationUpdated', 'updated']]) {
    assert.ok(Array.isArray(delta[field]), 'surface-worker:bookkeeping-delta');
    for (const path of delta[field]) {
      const suffix = action === 'bytes-changed' ? '' : path.endsWith('-wal') ? '-wal' : path.endsWith('-shm') ? '-shm' : undefined;
      assert.notEqual(suffix, undefined, 'surface-worker:bookkeeping-kind');
      const base = suffix ? path.slice(0, -suffix.length) : path;
      const scope = /^projects\/[a-f0-9]{64}\/db\.sqlite$/u.test(base) ? 'project-db'
        : /^projects\/[a-f0-9]{64}\/events\.db$/u.test(base) ? 'hook-outbox' : undefined;
      assert.ok(scope && (scope !== 'project-db' || backend === 'sqlite'), 'surface-worker:bookkeeping-scope');
      const kind = action === 'bytes-changed' ? 'database-bytes-changed' : `${suffix.slice(1)}-${action}`;
      const key = `${phase}|${kind}|${scope}`;
      const count = (observedBookkeeping.get(key) ?? 0) + 1;
      assert.ok(count <= 65535, 'surface-worker:bookkeeping-count');
      observedBookkeeping.set(key, count);
    }
  }
}
function bookkeepingResult() {
  return [...observedBookkeeping].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, count]) => [...key.split('|'), count]);
}
const context = {
  backend, homeDir, projectPath, secondaryProjectPath, scenario: activeScenario, recordBookkeeping,
  projectId: hashProjectPath(projectPath), secondaryProjectId: hashProjectPath(secondaryProjectPath),
  remoteProjectId: process.env.LCM_SURFACE_REMOTE_PROJECT_ID,
  secondaryRemoteProjectId: process.env.LCM_SURFACE_SECONDARY_REMOTE_PROJECT_ID,
  matrix, cli, request, readProject, admin, assertNoFallback, snapshotReaders, assertSnapshotUnchanged, assertLogicalSnapshotUnchanged, resetSnapshotReaders,
  canaries: ['SURFACEPRIVATE', 'surface_password_canary', 'surface_query_canary', 'SQLSTATE_PRIVATE_42501', homeDir, projectPath, ...(backend === 'postgresql' ? (() => { const url = new URL(process.env.LCM_POSTGRES_URL); return [process.env.LCM_POSTGRES_URL, decodeURIComponent(url.username), decodeURIComponent(url.password), decodeURIComponent(url.pathname.slice(1))]; })() : [])],
  snapshot: () => snapshotSurfaceState(context),
  snapshotPostgreSql: () => admin('snapshot'),
  unavailableStartup: () => admin('unavailable.start'),
  mcp: (name, args) => {
    assert.ok(mcpClient, 'surface-worker:mcp-initialized');
    assert.ok(mcpErrorBytes <= streamLimit, 'surface-worker:mcp-output-bound');
    return mcpClient.callTool({ name, arguments: args });
  },
};
async function quiesceReadState() {
  // Drain the fixture's own queued hooks before observing a read-only stage.
  // This setup never changes or retries the public operation under assertion.
  const drained = await request('POST', '/promote-events', { cwd: projectPath, drain: true });
  assert.equal(drained.status, 200, 'surface-worker:quiescence-drain-status');
  assert.equal(drained.body.errors, 0, 'surface-worker:quiescence-drain-errors');
  let before = await context.snapshot();
  const deadline = performance.now() + 3000;
  let stable = 0;
  while (stable < 3) {
    await delay(25);
    const after = await context.snapshot();
    try { assertLogicalSnapshotUnchanged(after, before, 'quiescence'); stable++; }
    catch (error) {
      if (!String(error?.message).startsWith('surface-parity:quiescence') || performance.now() >= deadline) throw error;
      stable = 0;
    }
    before = after;
    assert.ok(performance.now() < deadline, 'surface-worker:quiescence-timeout');
  }
}
async function closeMcp() {
  const current = mcpClient;
  mcpClient = undefined;
  await current?.close();
  await transport?.close();
  transport = undefined;
}
async function startDirect() {
  context.faultHooks = createFaultHooks();
  const routes = [];
  context.config = loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 } });
  directDaemon = await createDaemon(context.config, {
    tokenPath, publicationConfigPath: configPath,
    _createStorageBackendFactory: context.faultHooks.createFactory,
    _onRequestLifecycle: context.faultHooks.onLifecycle,
    _onBuiltInRouteRegistered: (key, admission, publicationMode) => routes.push({ key, admission, publicationMode }),
  });
  context.baseUrl = `http://127.0.0.1:${directDaemon.address().port}`;
  context.client = new DaemonClient(context.baseUrl, tokenPath);
  context.daemonInstanceId = directDaemon.daemonInstanceId;
  return routes;
}
async function startBaseline() {
  const port = await availablePort();
  selectPort(port);
  context.config = loadDaemonConfig(configPath);
  baselineStarted = false;
  baseline = launch(['daemon', 'start', '--foreground']);
  let output = '';
  let errors = '';
  baseline.stderr.on('data', bytes => { errors += bytes; if (Buffer.byteLength(errors) > streamLimit) baseline.kill('SIGKILL'); });
  await bounded(new Promise((resolveReady, reject) => {
    baseline.once('error', reject);
    baseline.once('close', (code, signal) => {
      const category = /configuration is invalid/iu.test(errors) ? 'config-invalid'
        : /STORAGE_|postgresql|storage.*(?:failed|unavailable)/iu.test(errors) ? 'storage-unavailable'
        : /LCM command failed/iu.test(errors) ? 'cli-failed' : 'other';
      const stderrDigest = createHash('sha256').update(errors).digest('hex');
      const stdoutDigest = createHash('sha256').update(output).digest('hex');
      const error = new Error(`surface-worker:startup-${backend}-${category}-exit${code ?? 'none'}-${signal ?? 'none'}`);
      error.surfaceEvidence = { stderrDigest, stdoutDigest };
      reject(error);
    });
    baseline.stdout.on('data', bytes => {
      output += bytes;
      if (Buffer.byteLength(output) > streamLimit) reject(new Error('surface-worker:daemon-output-bound'));
      if (output.includes(`lcm daemon started on port ${port}`)) resolveReady();
    });
  }), 25000, 'daemon-startup');
  baselineStarted = true;
  baseline.stdin.end();
  context.baseUrl = `http://127.0.0.1:${port}`;
  context.client = new DaemonClient(context.baseUrl, tokenPath);
  const health = await context.client.observe();
  assert.equal(health?.storageBackend, backend, 'surface-worker:daemon-backend');
  assert.equal(health.pid, baseline.pid, 'surface-worker:baseline-process-replaced');
  context.daemonPid = baseline.pid;
  context.daemonInstanceId = health.daemonInstanceId;
  transport = new StdioClientTransport({
    command: process.execPath, args: [bin, 'mcp'], cwd: projectPath,
    env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['LCM_SURFACE_ADMIN_URL', 'LCM_SURFACE_MIGRATOR_URL'].includes(key))),
    stderr: 'pipe',
  });
  mcpErrorBytes = 0;
  mcpClient = new Client({ name: 'surface-parity', version: '1.0.0' });
  const connecting = mcpClient.connect(transport);
  transport.stderr?.on('data', bytes => { mcpErrorBytes += bytes.length; });
  await bounded(connecting, 15000, 'mcp-startup');
  const tools = (await mcpClient.listTools()).tools;
  const afterMcp = await context.client.observe();
  assert.equal(afterMcp?.pid, baseline.pid, 'surface-worker:baseline-process-replaced');
  assert.equal(afterMcp?.daemonInstanceId, context.daemonInstanceId, 'surface-worker:baseline-generation-replaced');
  assert.ok(mcpErrorBytes <= streamLimit, 'surface-worker:mcp-output-bound');
  return tools;
}
async function stopBaseline() {
  if (!baseline) return;
  await terminate(baseline);
  // An already-reaped startup refusal is the primary error, not a shutdown
  // failure. A daemon that reached listening must still shut down cleanly.
  if (baselineStarted) assert.equal(baseline.exitCode, 0, 'surface-worker:baseline-cleanup-exit');
}
async function enterFaults() {
  if (directDaemon) return;
  await closeMcp();
  await readFactory?.close();
  readFactory = undefined;
  await stopBaseline();
  baseline = undefined;
  resetSnapshotReaders();
  // Ordinary public workflows use normal production tuning. Saturation and
  // active-cancel timing apply only to this separately owned fault lifetime.
  if (backend === 'postgresql') {
    for (const [path, value] of [['storage.postgresql.poolMax', 1], ['storage.postgresql.connectionTimeoutMs', 100], ['storage.postgresql.statementTimeoutMs', 5000]]) {
      setConfigValue({ configPath, path, value: String(value), json: true });
    }
  }
  await startDirect();
}
async function cleanup() {
  stopping = true;
  const errors = [];
  for (const operation of [closeMcp, () => readFactory?.close(), closeSnapshotReaders, () => directDaemon?.stop(), stopBaseline, ...[...childProcesses].map(child => () => terminate(child))]) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  assert.equal(childProcesses.size, 0, 'surface-worker:remaining-child');
  assert.equal(snapshotCleanupFailed, false, 'surface-worker:snapshot-cleanup-failed');
  await assertNoFallback();
  if (errors.length) throw errors[0];
  return { verdict: 'passed' };
}
process.on('message', message => {
  if (message?.type === 'admin-result' || message?.type === 'admin-failed') {
    const pending = adminPending.get(message.seq);
    if (!pending) return void send({ type: 'failed', backend, scenario: activeScenario, error: failure(new Error('surface-worker:unknown-admin-reply')) });
    if (message.type === 'admin-failed' || message.error) pending.reject(new Error('surface-worker:admin-failed'));
    else pending.resolve(message.result);
    return;
  }
  void (async () => {
    assert.ok(!busy && !stopping, 'surface-worker:concurrent-request');
    assert.ok(Number.isSafeInteger(message?.seq) && message.seq > lastSequence, 'surface-worker:sequence');
    lastSequence = message.seq;
    busy = true;
    if (message.type === 'stop') {
      send({ type: 'stopped', backend, cleanup: await cleanup() });
      process.disconnect();
      return;
    }
    assert.equal(message.type, 'run', 'surface-worker:request-type');
    activeScenario = message.scenario;
    context.scenario = activeScenario;
    observedBookkeeping = new Map();
    resetSnapshotReaders();
    await assertNoFallback();
    if (baseline) assert.equal(baseline.exitCode, null, 'surface-worker:baseline-exited');
    let result;
    if (message.scenario === 'diagnostics' || message.scenario.startsWith('fault-')) await quiesceReadState();
    if (message.scenario.startsWith('fault-')) {
      if (message.scenario === 'fault-pool' || message.scenario === 'fault-cancellation') await enterFaults();
      result = { rows: [], fault: await runFaultScenario(context, message.scenario) };
    } else result = { rows: await runSurfaceScenario(message.scenario, context) };
    await assertNoFallback();
    if (baseline) {
      const currentHealth = await context.client.observe();
      assert.equal(currentHealth?.pid, baseline.pid, 'surface-worker:baseline-process-replaced');
      assert.equal(currentHealth?.daemonInstanceId, context.daemonInstanceId, 'surface-worker:baseline-generation-replaced');
    }
    closeSnapshotReaders();
    send({ type: 'result', seq: message.seq, backend, scenario: message.scenario, ...result, bookkeeping: bookkeepingResult() });
  })().catch(error => {
    try { closeSnapshotReaders(); } catch { /* Preserve the primary failure; final cleanup also fails closed. */ }
    send({ type: 'failed', seq: message?.seq, backend, scenario: activeScenario, error: failure(error) });
  })
    .finally(() => { busy = false; });
});
process.once('SIGTERM', () => {
  if (!stopping) void cleanup().catch(() => {}).finally(() => process.exit(1));
});
process.on('disconnect', () => { if (!stopping) void cleanup().finally(() => process.exit(1)); });
try {
  assert.equal(findUserSystemdPid(), null, 'surface-worker:isolated-ci-manager-namespace-required');
  mkdirSync(join(homeDir, '.lcm/projects'), { recursive: true, mode: 0o700 });
  ensureAuthToken(tokenPath);
  for (const [path, value] of [
    ['summarizer.mock', true], ['daemon.idleTimeoutMs', 0],
    ['compaction.leafTokens', 64], ['compaction.autoCompactMinTokens', 1],
    ['security.sensitivePatterns', ['SURFACEPRIVATE']],
  ]) setConfigValue({ configPath, path, value: JSON.stringify(value), json: true });
  // Observe the real built registry, then fully stop this direct listener before
  // starting the canonical CLI daemon needed by CLI/MCP identity verification.
  const routes = await startDirect();
  await directDaemon.stop();
  directDaemon = undefined;
  const tools = await startBaseline();
  if (backend === 'postgresql') {
    const linked = await cli(['project', 'link', context.secondaryRemoteProjectId, secondaryProjectPath, '--json']);
    assert.equal(linked.code, 0, 'surface-worker:secondary-project-binding');
  }
  await assertNoFallback();
  send({ type: 'ready', backend, routes, tools });
} catch (error) {
  send({ type: 'failed', backend, scenario: 'startup', error: failure(error) });
  try { await cleanup(); } finally { process.disconnect(); }
}
