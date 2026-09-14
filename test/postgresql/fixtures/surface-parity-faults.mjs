import { assertSanitizedDiagnostic } from '../../surface-parity/assertions.mjs';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStorageBackendFactory } from '../../../dist/src/storage/factory.js';
import { createPostgreSqlStorageBackendFactoryWithHome } from '../../../dist/src/storage/postgresql/factory.js';
import { PostgreSqlRuntime } from '../../../dist/src/storage/postgresql/runtime.js';
import { verifyPostgreSqlRuntimeSchema } from '../../../dist/src/storage/postgresql/runtime-readiness.js';
import { assertStorageBackendPublication, withStorageBackendConsumerLockAsync } from '../../../dist/src/storage/backend.js';
import { readBackendPublicationJournal, captureBackendPublicationState } from '../../../dist/src/storage/backend-publication.js';
import { normalizeProjectPath } from '../../../dist/src/project-map.js';
import { createAbortError, throwIfAborted } from '../../../dist/src/daemon/cancellation.js';

// Fixed assertion messages avoid embedding fixture paths, SQL or credentials in
// node:assert object diffs. Original operation errors are never rewritten here.
function requireFault(condition, id) {
  if (!condition) throw new Error(`surface-fault:${id}`);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, milliseconds, id) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`surface-fault:${id}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function cleanupAll(primaryError, operations) {
  let cleanupError;
  for (const operation of operations) {
    try { await operation(); } catch (error) { cleanupError ??= error; }
  }
  if (primaryError === undefined && cleanupError !== undefined) throw cleanupError;
}
async function until(predicate, milliseconds, id) {
  const start = performance.now();
  while (!predicate()) {
    requireFault(performance.now() - start < milliseconds, id);
    await delay(5);
  }
}

/** Retain real dependencies; only the SQLite open barrier changes scheduling. */
export function createFaultHooks() {
  const lifecycle = [];
  let runtime;
  let settings;
  let gate;
  const hooks = {
    lifecycle,
    get runtime() { return runtime; },
    get settings() { return settings; },
    onLifecycle(event, signal) { lifecycle.push({ event, signal }); },
    async createFactory(config, homeDir, publicationCheck = assertStorageBackendPublication, publicationLockToken) {
      if (config.backend === 'postgresql') {
        publicationCheck({ backend: config.backend, homeDir }, publicationLockToken);
        return createPostgreSqlStorageBackendFactoryWithHome(config, homeDir, {
          createRuntime(connectionSettings) {
            requireFault(runtime === undefined, 'one-selected-runtime');
            settings = connectionSettings;
            runtime = new PostgreSqlRuntime(connectionSettings);
            return runtime;
          },
          verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
          withConsumerLock: withStorageBackendConsumerLockAsync,
          assertPublication: assertStorageBackendPublication,
          readJournal: readBackendPublicationJournal,
          captureState: captureBackendPublicationState,
          normalizePath: normalizeProjectPath,
        });
      }
      const factory = await createStorageBackendFactory(config, homeDir, publicationCheck, publicationLockToken);
      return new Proxy(factory, {
        get(target, property) {
          const original = Reflect.get(target, property, target);
          if (property === 'openProject' || property === 'openExistingProject') {
            return async (identity, token, signal) => {
              const active = gate;
              if (active) {
                requireFault(signal instanceof AbortSignal, 'sqlite-open-signal');
                active.signal = signal;
                active.entered.resolve();
                throwIfAborted(signal);
                let abort;
                try {
                  await Promise.race([active.release.promise, new Promise((_, reject) => {
                    abort = () => reject(createAbortError());
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted) abort();
                  })]);
                } finally {
                  signal.removeEventListener('abort', abort);
                  active.settled.resolve();
                }
                throwIfAborted(signal);
              }
              return original.call(target, identity, token, signal);
            };
          }
          return typeof original === 'function' ? original.bind(target) : original;
        },
      });
    },
    armOpenGate() {
      requireFault(gate === undefined, 'sqlite-gate-single-owner');
      const active = { entered: deferred(), release: deferred(), settled: deferred(), signal: undefined };
      gate = active;
      return {
        entered: active.entered.promise,
        settled: active.settled.promise,
        get signal() { return active.signal; },
        release() { active.release.resolve(); if (gate === active) gate = undefined; },
      };
    },
  };
  return hooks;
}

function assertSanitized(context, value, expectedSqlState) {
  assertSanitizedDiagnostic(value, { canaries: context.canaries ?? [], expectedSqlState });
}
async function projectDatabases(home) {
  const found = [];
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await visit(next);
      else if (/^db\.sqlite(?:-wal|-shm)?$/u.test(entry.name)) found.push(next);
    }
  }
  await visit(home);
  return found.sort();
}
async function assertRecovery(context, before, { inspectSelectedPool = false } = {}) {
  const response = await context.request('POST', '/search', searchBody(context));
  requireFault(response.status === 200 && Array.isArray(response.body.episodic), 'same-query-recovered');
  const health = await context.client.health();
  requireFault(health?.storageBackend === context.backend && health?.status === 'ok', 'selected-backend-healthy');
  requireFault(typeof context.assertLogicalSnapshotUnchanged === 'function', 'native-snapshot-oracle-required');
  const bookkeeping = context.assertLogicalSnapshotUnchanged(await context.snapshot(), before, 'fault:no-logical-effects');
  context.recordBookkeeping(context.scenario, bookkeeping);
  if (context.backend === 'postgresql') {
    if (inspectSelectedPool) {
      const pool = context.faultHooks.runtime.poolDiagnostics();
      requireFault(pool.waiting === 0 && pool.total === pool.idle, 'pool-drained');
    }
    requireFault((await projectDatabases(context.homeDir)).length === 0, 'no-project-sqlite-fallback');
  }
  return response;
}
function searchBody(context) { return { cwd: context.projectPath, query: 'surfaceparity', layers: ['episodic'] }; }
function assertFailure(context, response) {
  requireFault(response.status === 503, 'bounded-storage-failure');
  assertSanitized(context, response.body);
  requireFault(JSON.stringify(response.body).includes('postgresql'), 'failure-identifies-postgresql');
}

async function poolFault(context) {
  const before = await context.snapshot();
  if (context.backend === 'sqlite') {
    // SQLite has no PostgreSQL pool; exercise its real public storage request
    // and prove no runtime pool has been substituted for this counterpart.
    requireFault(context.faultHooks.runtime === undefined, 'sqlite-no-pg-pool');
    await assertRecovery(context, before, { inspectSelectedPool: context.backend === 'postgresql' });
    return { variant: 'sqlite-no-pool', noEffects: true, recovered: true };
  }
  const { runtime, settings } = context.faultHooks;
  requireFault(settings.poolMax === 1 && settings.connectionTimeoutMs === 100 && settings.statementTimeoutMs === 5000, 'configured-fault-deadlines');
  const entered = deferred();
  const release = deferred();
  const hold = runtime.transaction(async () => { entered.resolve(); await release.promise; });
  // Observe errors promptly even when entry itself fails.
  hold.catch(() => {});
  let primaryError;
  try {
    await bounded(Promise.race([entered.promise, hold.then(() => { throw new Error('surface-fault:hold-not-entered'); })]), 2000, 'hold-entry-deadline');
    const pool = runtime.poolDiagnostics();
    requireFault(pool.total === 1 && pool.idle === 0, 'selected-pool-held');
    const start = performance.now();
    const response = await bounded(context.request('POST', '/search', searchBody(context)), 2000, 'acquisition-deadline');
    requireFault(performance.now() - start < 2000, 'acquisition-before-statement-timeout');
    assertFailure(context, response);
  } catch (error) { primaryError = error; throw error; } finally {
    release.resolve();
    await cleanupAll(primaryError, [() => bounded(hold, 2000, 'hold-release-deadline')]);
  }
  await assertRecovery(context, before, { inspectSelectedPool: context.backend === 'postgresql' });
  return { variant: 'postgresql-pool-exhaustion', noEffects: true, recovered: true };
}

async function cancellationBarrier(context, table) {
  if (context.backend === 'sqlite') {
    const gate = context.faultHooks.armOpenGate();
    return {
      wait: () => bounded(gate.entered, 2000, 'sqlite-open-entry'),
      settled: () => bounded(gate.settled, 2000, 'sqlite-open-settlement'),
      release: async () => gate.release(),
    };
  }
  await context.admin('lock.acquire', { table });
  let pid;
  return {
    async wait() {
      const witness = await context.admin('lock.wait', { table });
      requireFault(witness.blocked === true && Number.isInteger(witness.pid), 'active-pg-lock-witness');
      pid = witness.pid;
    },
    async settled() {
      const witness = await context.admin('lock.settled', { pid });
      requireFault(witness.settled === true, 'active-pg-query-settled');
    },
    async release() { await context.admin('lock.release', {}); },
  };
}

async function cancellationFault(context) {
  const before = await context.snapshot();
  const hooks = context.faultHooks;
  if (context.backend === 'postgresql') requireFault(hooks.settings.statementTimeoutMs === 5000, 'cancellation-independent-statement-timeout');
  const startIndex = hooks.lifecycle.length;
  const barrier = await cancellationBarrier(context, 'messages');
  const controller = new AbortController();
  let request;
  let primaryError;
  try {
    request = context.client.post('/search', searchBody(context), { signal: controller.signal, timeoutMs: 10000 })
      .then(value => ({ value }), error => ({ error }));
    await barrier.wait();
    const start = performance.now();
    controller.abort();
    const result = await bounded(request, 2000, 'transport-cancel-deadline');
    requireFault(result.error?.name === 'AbortError', 'transport-aborted');
    await until(() => hooks.lifecycle.slice(startIndex).some(entry => entry.event === 'cancelled' && entry.signal.aborted && hooks.lifecycle.some(other => other.event === 'settled' && other.signal === entry.signal)), 2000, 'same-request-abort-settlement');
    await barrier.settled();
    requireFault(performance.now() - start < 2000, 'active-cancellation-ceiling');
  } catch (error) { primaryError = error; throw error; } finally {
    controller.abort();
    await cleanupAll(primaryError, [
      () => barrier.release(),
      () => request && bounded(request, 6000, 'transport-finally-settlement'),
    ]);
  }
  await assertRecovery(context, before, { inspectSelectedPool: context.backend === 'postgresql' });

  const health = await context.client.observe();
  requireFault(typeof health?.daemonInstanceId === 'string', 'authenticated-invocation-generation');
  const invocation = { invocationId: randomUUID(), command: 'compact', daemonInstanceId: health.daemonInstanceId };
  const started = await context.client.startInvocation(invocation);
  requireFault(started.state === 'active', 'invocation-started');
  const compactBarrier = await cancellationBarrier(context, 'projects');
  let compact;
  let cancelled = false;
  primaryError = undefined;
  try {
    compact = context.request('POST', '/compact', {
      cwd: context.projectPath,
      session_id: context.sessionId ?? 'surface-parity-fault-session',
      invocation_id: invocation.invocationId,
      skip_ingest: true,
    });
    compact.catch(() => {});
    await compactBarrier.wait();
    const admitted = await context.client.heartbeatInvocation(invocation);
    requireFault(admitted.workCount === 1 && admitted.commitCount === 0, 'compact-work-active-before-write');
    const start = performance.now();
    const settled = await bounded(context.client.cancelInvocation(invocation), 2000, 'invocation-cancel-deadline');
    cancelled = true;
    requireFault(settled.state === 'cancelled' && settled.workCount === 0 && settled.commitCount === 0, 'invocation-drained');
    const response = await bounded(compact, 2000, 'compact-cancel-response');
    requireFault(response.status === 499 && response.body.status === 'cancelled', 'compact-cancelled-before-write');
    assertSanitized(context, response.body);
    await compactBarrier.settled();
    requireFault(performance.now() - start < 2000, 'compact-active-cancellation-ceiling');
  } catch (error) { primaryError = error; throw error; } finally {
    await cleanupAll(primaryError, [
      () => !cancelled && bounded(context.client.cancelInvocation(invocation), 2000, 'cleanup-invocation-cancel'),
      () => compactBarrier.release(),
      () => compact && bounded(compact, 6000, 'compact-finally-settlement'),
    ]);
  }
  await assertRecovery(context, before, { inspectSelectedPool: context.backend === 'postgresql' });
  return { variant: context.backend === 'postgresql' ? 'postgresql-server-cancel' : 'sqlite-abort-aware-open', transportAborted: true, invocationCancelled: true, settled: true, noEffects: true, recovered: true };
}

function assertDeniedDiagnosticText(text) {
  requireFault(text.includes('Storage backend: postgresql')
    && /Classification: (?:unavailable|permission-denied)(?:\s|$)/u.test(text), 'denied-diagnostic-classification');
}

async function denialFault(context) {
  const before = await context.snapshot();
  if (context.backend === 'sqlite') {
    requireFault(context.faultHooks.runtime === undefined, 'sqlite-no-pg-grants');
    await assertRecovery(context, before);
    return { variant: 'sqlite-no-runtime-grants', noEffects: true, recovered: true };
  }
  await context.admin('denial.revoke', {});
  let primaryError;
  try {
    const deniedSearch = await context.request('POST', '/search', searchBody(context));
    assertFailure(context, deniedSearch);
    assertSanitized(context, deniedSearch.body, '42501');
    for (const command of ['search', 'stats', 'doctor']) {
      const result = await context.cli(command === 'search' ? ['search', 'surfaceparity']
        : command === 'stats' ? ['stats', '--json'] : [command]);
      // Ordinary stats exits 1 on StatsUnavailableError; --pool deliberately
      // returns its diagnostic snapshot with exit 0 and is checked separately.
      requireFault(result.code === 1, 'denied-cli-fails');
      assertSanitized(context, result.stdout + result.stderr);
      if (command === 'stats') {
        const diagnostics = JSON.parse(result.stdout).backendDiagnostics;
        requireFault(diagnostics?.backend === 'postgresql'
          && ['unavailable', 'permission-denied'].includes(diagnostics.classification), 'denied-cli-stats-classification');
      } else if (command === 'doctor') {
        assertDeniedDiagnosticText(result.stdout);
      }
    }
    const pool = await context.cli(['stats', '--pool', '--json']);
    assertSanitized(context, pool.stdout + pool.stderr);
    const poolDiagnostic = JSON.parse(pool.stdout).backendDiagnostics;
    requireFault(pool.code === 0 && poolDiagnostic?.backend === 'postgresql'
      && ['unavailable', 'permission-denied'].includes(poolDiagnostic.classification), 'denied-cli-pool-classification');
    for (const tool of ['lcm_search', 'lcm_stats', 'lcm_doctor']) {
      const result = await context.mcp(tool, tool === 'lcm_search' ? { query: 'surfaceparity', cwd: context.projectPath } : {});
      assertSanitized(context, result);
      if (tool === 'lcm_search') {
        requireFault(result.isError === true, 'denied-mcp-search-fails');
      } else {
        // Local MCP diagnostics intentionally return successful tool content
        // whose rendered backend classification carries storage availability.
        requireFault(result.isError !== true && Array.isArray(result.content), 'denied-mcp-diagnostic-content');
        const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        assertDeniedDiagnosticText(text);
      }
    }
  } catch (error) { primaryError = error; throw error; } finally {
    await cleanupAll(primaryError, [() => context.admin('denial.restore', {})]);
  }
  await assertRecovery(context, before);
  return { variant: 'postgresql-select-denied', noEffects: true, recovered: true };
}

export async function runFaultScenario(context, name) {
  if (context.backend === 'postgresql') {
    requireFault((await projectDatabases(context.homeDir)).length === 0, 'no-project-sqlite-before-fault');
  }
  if (name === 'fault-pool') return poolFault(context);
  if (name === 'fault-cancellation') return cancellationFault(context);
  if (name === 'fault-denial') return denialFault(context);
  if (name === 'fault-unavailable') {
    if (context.backend === 'sqlite') {
      const before = await context.snapshot();
      requireFault(context.faultHooks.runtime === undefined, 'sqlite-no-pg-endpoint');
      const start = performance.now();
      const response = await bounded(assertRecovery(context, before), 10000, 'sqlite-healthy-endpoint-deadline');
      requireFault(performance.now() - start < 10000, 'sqlite-healthy-endpoint-bounded');
      assertSanitized(context, response.body);
      return { variant: 'sqlite-no-pg-endpoint', bounded: true, sanitized: true, noFallback: true };
    }
    requireFault(typeof context.unavailableStartup === 'function', 'unavailable-startup-fixture-required');
    const before = await context.snapshot();
    const result = await context.unavailableStartup();
    requireFault(result.rejectedConnections > 0 && result.code !== 0 && result.elapsedMs < 10000, 'owned-unavailable-endpoint');
    assertSanitized(context, result.stdout + result.stderr);
    requireFault(result.code === 1 && result.stdout.trim() === '', 'unavailable-public-exit');
    requireFault(result.stderr.split(/\r?\n/u).filter(line => line === 'LCM command failed. Check the command inputs and selected storage configuration.').length === 1, 'unavailable-generic-refusal');
    requireFault(result.backend === 'postgresql' && result.projectDatabaseCount === 0 && result.daemonHealthy === false, 'unavailable-no-fallback');
    await assertRecovery(context, before);
    return { variant: 'postgresql-unavailable', bounded: true, sanitized: true, noFallback: true };
  }
  throw new Error('surface-fault:unknown-scenario');
}
