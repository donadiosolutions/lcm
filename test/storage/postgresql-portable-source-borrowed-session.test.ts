import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/storage/postgresql/portable-source.js';
import * as mapping from '../../src/storage/postgresql/portable-mapping.js';
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from '../../src/storage/portable-record-stream.js';
import type { StorageIdentityContext } from '../../src/storage/contracts.js';
import type { PostgreSqlSnapshotSession } from '../../src/storage/postgresql/snapshot-session.js';

/**
 * Additive coverage for the two approved changes in portable-source.ts: an
 * optional borrowed PostgreSqlSnapshotSession and the read-only domain
 * census accessor. See test/storage/postgresql-portable-source.test.ts for
 * the pre-existing owned-runtime suite, which is unmodified by this file
 * and proves every existing call site stays behaviourally unchanged with
 * the new parameter absent.
 */

const projectId = '01990000-0000-7000-8000-000000000001';
const machineId = '01990000-0000-7000-8000-000000000002';
const timestamp = '2026-09-06T12:34:56.123456Z';
const identity = (): StorageIdentityContext => ({ id: projectId, remoteProjectId: projectId,
  localProjectId: 'a'.repeat(64), machineId, selectedPath: '/source', displayName: 'source' } as StorageIdentityContext);
const settings = { url: 'postgresql://runtime:secret@localhost/source', caFile: '/ca.pem',
  poolMax: 2, connectionTimeoutMs: 1000, idleTimeoutMs: 1000, statementTimeoutMs: 1000 };

function borrowedSessionHarness(overrides: { backendPid?: number; projectId?: string } = {}) {
  const session = {
    identity: { sessionId: 'borrowed-session-1', backendPid: overrides.backendPid ?? 777, projectId: overrides.projectId ?? projectId },
    query: vi.fn(async (_config: unknown, options: { operation: string }) => {
      switch (options.operation) {
        case 'portableRegisteredIdentity': return { rows: [{ admitted: true }] };
        case 'portableSourceWitness': return { rows: [{ database_name: 'source', database_oid: '123', server_address: '127.0.0.1', server_port: '5432' }] };
        case 'portableSnapshotState': return { rows: [{ backend_pid: overrides.backendPid ?? 777, tls: true, isolation: 'repeatable read', read_only: 'on', captured_at: timestamp }] };
        default: throw new Error('unexpected SQL ' + options.operation);
      }
    }),
    close: vi.fn(async () => { /* borrowed: must never be invoked by the source under test */ }),
  };
  const runtime = { health: vi.fn(async () => ({ status: 'healthy', backend: 'postgresql', tls: true, serverMajorVersion: 18, serverEncoding: 'UTF8' })),
    query: session.query, openReadOnlySnapshot: vi.fn(async () => session), close: vi.fn(async () => { /* never opened, never closed */ }) };
  const dependencies = { createRuntime: vi.fn(() => runtime), verifyRuntimeSchema: vi.fn(async () => ({})), normalizePath: (path: string) => path };
  const data = {
    machines: [{ machine_id: machineId, identity_key: 'machine-source' }],
    project: [{ project_id: projectId }],
    'project-aliases': [{ machine_id: machineId, machine_identity_key: 'machine-source', path: '/source', normalized_path: '/source' }],
  } as Partial<Record<PortableDomain, Record<string, unknown>[]>>;
  const locator = (domain: PortableDomain, row: Record<string, unknown>) => JSON.stringify(mapping.mappingForDomain(domain).keys.map((key) => String(row[key])));
  const rows = (domain: PortableDomain) => (data[domain] ?? []) as Record<string, unknown>[];
  const byLocator = new Map(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, new Map(rows(domain).map((row) => [locator(domain, row), row]))]));
  const positions = new Map(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, new Map(rows(domain).map((row, index) => [locator(domain, row), index]))]));
  vi.spyOn(mapping, 'listCanonicalHeaders').mockImplementation(async (_db, _project, domain, after, limit) => {
    const values = rows(domain); const start = after === null ? 0 : positions.get(domain)!.get(after)! + 1;
    return values.slice(start, start + limit).map((row) => ({ locator: locator(domain, row), byteLength: '1000' }));
  });
  vi.spyOn(mapping, 'readCanonicalRow').mockImplementation(async (_db, _project, domain, key) => byLocator.get(domain)!.get(key) ?? null);
  vi.spyOn(mapping, 'listConversationMessageHeaders').mockImplementation(async () => []);
  return { session, runtime, dependencies };
}

afterEach(() => vi.restoreAllMocks());

describe('PostgreSQL portable source borrowed snapshot session', () => {
  it('admits using a borrowed session without opening an owned runtime or snapshot', async () => {
    const h = borrowedSessionHarness();
    const source = await adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    );
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
    expect(h.runtime.health).not.toHaveBeenCalled();
    expect(h.runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
    expect(source.describeSource().sourceWitnessSha256).toMatch(/^[0-9a-f]{64}$/u);
    await source.close();
  });

  it('close() never closes a borrowed session on the happy path', async () => {
    const h = borrowedSessionHarness();
    const source = await adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    );
    await source.close();
    expect(h.session.close).not.toHaveBeenCalled();
    expect(h.runtime.close).not.toHaveBeenCalled();
  });

  it('close() never closes a borrowed session when a later operation fails', async () => {
    const h = borrowedSessionHarness();
    const source = await adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    );
    // Force the internal liveness check to fail without touching the borrowed session.
    h.session.query.mockRejectedValueOnce(new Error('read-failure-canary'));
    await expect(source.readDomainPage({ domain: 'project', afterOrdinal: 0, includePredecessor: false, maxRecords: 500, maxBytes: 150994944 }))
      .rejects.toBeDefined();
    await source.close();
    expect(h.session.close).not.toHaveBeenCalled();
  });

  it('does not close a borrowed session when admission itself fails (error path)', async () => {
    const h = borrowedSessionHarness();
    h.dependencies.verifyRuntimeSchema.mockRejectedValue(new Error('should not be called for a borrowed session'));
    // Force admission to fail after the borrowed session is assigned but
    // before buildSource completes, by making the identity registration
    // check on the borrowed session itself fail.
    h.session.query.mockImplementation(async (_config: unknown, options: { operation: string }) => {
      if (options.operation === 'portableRegisteredIdentity') return { rows: [{ admitted: false }] };
      throw new Error('unexpected SQL ' + options.operation);
    });
    await expect(adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    )).rejects.toMatchObject({ code: 'source-invalid' });
    expect(h.session.close).not.toHaveBeenCalled();
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
  });

  it('does not close a borrowed session when the request is already aborted (abort path)', async () => {
    const h = borrowedSessionHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession, signal: controller.signal },
      h.dependencies as never,
    )).rejects.toMatchObject({ code: 'aborted' });
    expect(h.session.close).not.toHaveBeenCalled();
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
  });

  it('refuses a borrowed session whose identity does not match the expected project', async () => {
    const h = borrowedSessionHarness({ projectId: '01990000-0000-7000-8000-000000000099' });
    await expect(adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    )).rejects.toMatchObject({ code: 'source-invalid' });
    expect(h.session.close).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL portable source domain census accessor', () => {
  it('reads cached per-domain census evidence without recomputation', async () => {
    const h = borrowedSessionHarness();
    const source = await adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    );
    const machinesCensus = adapter.readPostgreSqlPortableSourceDomainCensus(source, 'machines');
    expect(machinesCensus.domain).toBe('machines');
    expect(machinesCensus.recordCount).toBe(1);
    expect(machinesCensus.prefixSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(machinesCensus.terminalIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    // An empty domain (no fixture rows) has no terminal record.
    const summariesCensus = adapter.readPostgreSqlPortableSourceDomainCensus(source, 'summaries');
    expect(summariesCensus.recordCount).toBe(0);
    expect(summariesCensus.terminalIdentitySha256).toBeNull();
    // Reading twice returns byte-identical cached evidence.
    expect(adapter.readPostgreSqlPortableSourceDomainCensus(source, 'machines')).toEqual(machinesCensus);
    expect(h.session.query.mock.calls.filter((call) => (call[1] as { operation: string }).operation === 'portableRegisteredIdentity').length)
      .toBeGreaterThan(0);
    await source.close();
  });

  it('refuses a source not tracked by this module', () => {
    expect(() => adapter.readPostgreSqlPortableSourceDomainCensus({} as never, 'machines'))
      .toThrow(expect.objectContaining({ code: 'source-invalid' }));
  });

  it('refuses a closed source', async () => {
    const h = borrowedSessionHarness();
    const source = await adapter.createPostgreSqlPortableSource(
      { settings, expectedOwner: 'owner', expectedIdentity: identity(), session: h.session as unknown as PostgreSqlSnapshotSession },
      h.dependencies as never,
    );
    await source.close();
    expect(() => adapter.readPostgreSqlPortableSourceDomainCensus(source, 'machines'))
      .toThrow(expect.objectContaining({ code: 'closed' }));
  });
});
