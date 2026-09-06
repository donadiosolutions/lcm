import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryConfig } from 'pg';
import { createPostgreSqlPortableDestination, applyPortableBatchInTransaction, type PostgreSqlPortableDestinationInput } from '../../src/storage/postgresql/portable-destination.js';
import { PortableIndex } from '../../src/storage/portable-index.js';
import { PortableTransferError, type PortableRecordWriter } from '../../src/storage/portable-transfer.js';
import { PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_LIMITS, createPortableRecord, createPortableRecordStream, type PortableRecord, type PortableRecordStream, type PortableDomain, type PortableBatch } from '../../src/storage/portable-record-stream.js';
import { createGeneration, createFixtureSource, postgresGeneration, MACHINE_A_UUID, SHARED_PROJECT_UUID } from '../fixtures/portable-records.js';

const boundaries = vi.hoisted(() => ({
  client: vi.fn(), config: vi.fn(), schema: vi.fn(), witness: vi.fn(),
  headers: vi.fn(), row: vi.fn(), insert: vi.fn(), capability: vi.fn(), source: vi.fn(),
}));
vi.mock('pg', () => ({ Client: class { constructor() { return boundaries.client(); } } }));
vi.mock('../../src/storage/postgresql/client-config.js', () => ({ buildPostgreSqlClientConfig: boundaries.config }));
vi.mock('../../src/storage/postgresql/runtime-readiness.js', () => ({ verifyPostgreSqlTransferSchema: boundaries.schema }));
vi.mock('../../src/storage/postgresql/portable-mapping.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/storage/postgresql/portable-mapping.js')>(),
  listCanonicalHeaders: boundaries.headers, readCanonicalRow: boundaries.row,
  insertCanonicalRecord: boundaries.insert, assertPostgreSqlRecordCapability: boundaries.capability,
}));
vi.mock('../../src/storage/postgresql/portable-source.js', () => ({
  readPostgreSqlPortableWitness: boundaries.witness, createPostgreSqlPortableSource: boundaries.source,
}));

type Row = Record<string, unknown>;
type Receipt = Row & { domain: PortableDomain; prior: string; checkpoint_sha256: string; checkpoint_bytes: Uint8Array; next_ordinal: number };
type Saved = { run?: Row; receipts: Receipt[]; identities: Map<string, string>; records: Map<PortableDomain, PortableRecord[]> };

// Model durable data separately from transaction-local changes. SQL is accepted
// only at the adapter's documented ledger seams; unexpected queries fail closed.
class Database {
  run?: Row;
  receipts: Receipt[] = [];
  identities = new Map<string, string>();
  records = new Map<PortableDomain, PortableRecord[]>();
  transaction?: Saved;
  foreignRows: Row[] = [];
  clients: FakeClient[] = [];
  queryLog: string[] = [];
  beforeQuery?: (config: QueryConfig) => void | Promise<void>;
  safety: Row[] = [{ tls: true, version: 180000, encoding: 'UTF8' }];
  binding: Row[] = [{ project_id: SHARED_PROJECT_UUID }];
  machines: Row[] = [{ machine_id: MACHINE_A_UUID, identity_key: 'installation:0b7715' }];
  lock = true;
  isolation: Row[] = [{ isolation: 'read committed', readonly: 'off' }];
  cas = true;
  extraRuns = false;
  commitFailure: 'before' | 'after' | undefined;
  rollbackFailure = false;
  endFailure = false;
  connectFailure = false;

  snapshot(): Saved {
    return { run: this.run && structuredClone(this.run), receipts: structuredClone(this.receipts), identities: new Map(this.identities), records: new Map([...this.records].map(([domain, rows]) => [domain, [...rows]])) };
  }
  restore(saved: Saved): void {
    this.run = saved.run; this.receipts = saved.receipts; this.identities = saved.identities; this.records = saved.records;
  }
  async query(config: QueryConfig): Promise<{ rows: Row[]; rowCount: number }> {
    const text = config.text;
    const values = config.values ?? [];
    this.queryLog.push(text);
    if(this.queryLog.length > 10000) throw new Error('fake query runaway');
    await this.beforeQuery?.(config);
    const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
    if (text.startsWith('BEGIN')) { this.transaction = this.snapshot(); return result(); }
    if (text === 'ROLLBACK') {
      if (this.rollbackFailure) throw new Error('secret rollback canary');
      if (this.transaction) this.restore(this.transaction);
      this.transaction = undefined; return result();
    }
    if (text === 'COMMIT') {
      const failure = this.commitFailure; this.commitFailure = undefined;
      if (failure === 'before' && this.transaction) this.restore(this.transaction);
      this.transaction = undefined;
      if (failure) throw new Error('secret commit canary');
      return result();
    }
    if (text === "SELECT pg_catalog.pg_column_size(pg_catalog.to_tsvector('lcm.search_v1'::regconfig,lcm.normalize_search_text($1))) AS bytes") return result([{ bytes: 8 }]);
    if (text.startsWith('SELECT EXISTS (SELECT 1 FROM lcm.') && text.endsWith(') AS conflict')) {
      const foreign = this.foreignRows.filter(row => row.project_id !== values[0]);
      if (text.includes('FROM lcm.message_parts r')) return result([{ conflict: foreign.some(row => row.table === 'message_parts' && row.part_id === values[1]) }]);
      if (text.includes('FROM lcm.promoted_memories r')) return result([{ conflict: foreign.some(row => row.table === 'promoted_memories' && row.memory_id === values[1]) }]);
      if (text.includes('FROM lcm.passive_event_inbox r')) return result([{ conflict: foreign.some(row => row.table === 'passive_event_inbox' && row.identity_key === values[1] && (row.event_id === values[2] || row.machine_sequence === values[3])) }]);
    }
    if (text.includes("current_setting('server_version_num')")) return result(this.safety);
    if (text.includes('pg_try_advisory_lock')) return result([{ held: this.lock }]);
    if (text.includes('JOIN lcm.project_aliases')) return result(this.binding);
    if (text.includes('FROM lcm.machines WHERE')) return result(this.machines.filter(row => String(row.machine_id) > values[0]).slice(0, 1));
    if (text.includes("current_setting('transaction_isolation')")) return result(this.isolation);
    if (text.includes('pg_current_xact_id_if_assigned')) return result([{ transaction_id: this.transaction ? '1001' : null }]);
    if (text.includes('FROM lcm.transfer_runs')) return result(this.run ? (this.extraRuns ? [this.run, this.run] : [this.run]) : []);
    if (text.startsWith('INSERT INTO lcm.transfer_runs')) {
      this.run = { run_id: values[0], target_generation: values[1], project_id: values[2], manifest_bytes: values[3], manifest_sha256: values[4], project_sha256: values[6], state: 'active', current_domain: null, checkpoint_bytes: null, checkpoint_sha256: null };
      return result([], 1);
    }
    if (text.includes('FROM lcm.transfer_batches')) {
      const rows = this.receipts.filter(row => row.domain === values[1]);
      if (text.includes('prior_checkpoint_sha256=$3')) return result(rows.filter(row => row.prior === values[2]));
      if (text.includes('checkpoint_sha256=$3')) return result(rows.filter(row => row.checkpoint_sha256 === values[2]));
      return result(rows.sort((a, b) => b.next_ordinal - a.next_ordinal).slice(0, 1));
    }
    if (text.includes('FROM lcm.transfer_identities')) {
      const key = this.identities.get(`${values[1]}:${values[2]}`);
      return result(key === undefined ? [] : [{ native_key: key }]);
    }
    if (text.startsWith('INSERT INTO lcm.transfer_identities')) {
      this.identities.set(`${values[1]}:${values[2]}`, values[4]); return result([], 1);
    }
    if (text.startsWith('INSERT INTO lcm.transfer_batches')) {
      this.receipts.push({ domain: values[1], prior: values[2], batch_sha256: values[3], checkpoint_bytes: values[4], checkpoint_sha256: values[5], next_ordinal: Number(values[7]) });
      return result([], 1);
    }
    if (text.startsWith('UPDATE lcm.transfer_runs SET current_domain')) {
      if (!this.cas || this.run?.checkpoint_sha256 !== values[4]) return result([], 0);
      Object.assign(this.run!, { current_domain: values[1], checkpoint_bytes: values[2], checkpoint_sha256: values[3] }); return result([], 1);
    }
    if (text.includes("SET state='completed'")) { this.run!.state = 'completed'; return result([], 1); }
    throw new Error(`unexpected fake SQL: ${text}`);
  }
}
class FakeClient extends EventEmitter {
  ended = false;
  constructor(readonly db: Database) { super(); }
  async connect(): Promise<void> { if (this.db.connectFailure) throw new Error('secret connect canary'); }
  async query(config: QueryConfig) { if (this.ended) throw new Error('closed connection'); return this.db.query(config); }
  async end(): Promise<void> { this.ended = true; if (this.db.endFailure) throw new Error('secret close canary'); }
}

let db: Database;
let generation: ReturnType<typeof createGeneration>;
let scratch: string;
let input: PostgreSqlPortableDestinationInput;
let writers: PortableRecordWriter[];
let streams: PortableRecordStream[];
const identityDomains = new Set(['machines', 'project', 'project-aliases']);

beforeEach(() => {
  vi.resetAllMocks();
  db = new Database();
  generation = createGeneration(postgresGeneration());
  scratch = mkdtempSync(join(tmpdir(), 'lcm-pg-destination-'));
  writers = []; streams = [];
  input = { settings: {} as never, expectedOwner: 'fixture_owner', expectedIdentity: { id: SHARED_PROJECT_UUID, remoteProjectId: SHARED_PROJECT_UUID, machineId: MACHINE_A_UUID, localProjectId: 'a'.repeat(64), selectedPath: '/fixture/project' }, generationId: 'generation_1', runId: 'run_1', scratchParent: scratch };
  for (const [domain, records] of generation.records) db.records.set(domain, identityDomains.has(domain) ? [...records] : []);
  boundaries.client.mockImplementation(() => { const client = new FakeClient(db); db.clients.push(client); return client; });
  boundaries.config.mockReturnValue({});
  boundaries.schema.mockResolvedValue(undefined);
  boundaries.witness.mockResolvedValue('f'.repeat(64));
  boundaries.headers.mockImplementation(async (_executor, _project, domain: PortableDomain, after: string | null) => (db.records.get(domain) ?? []).filter(row => after === null || String(row.ordinal).padStart(8, '0') > after).slice(0, 1).map(row => ({ locator: String(row.ordinal).padStart(8, '0'), byteLength: '128' })));
  boundaries.row.mockImplementation(async (_executor, _project, domain: PortableDomain, locator: string) => { if(boundaries.row.mock.calls.length>10000) throw new Error('fake header runaway'); return db.records.get(domain)?.[Number(locator)]?.value; });
  boundaries.insert.mockImplementation(async (_executor, _project, record: PortableRecord, resolve: (domain: PortableDomain, identity: string) => Promise<string>) => {
    if (!identityDomains.has(record.domain)) {
      for (const dependency of record.dependencies) await resolve(dependency.domain, dependency.identitySha256);
      db.records.get(record.domain)!.push(record);
    }
    return `${record.domain}:${record.identitySha256}`;
  });
  boundaries.source.mockImplementation(async () => createFixtureSource({ description: generation.description, records: db.records }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(writers.map(writer => writer.close()));
  await Promise.allSettled(streams.map(stream => stream.close()));
  rmSync(scratch, { recursive: true, force: true });
});
async function open(overrides: Partial<PostgreSqlPortableDestinationInput> = {}) {
  const writer = await createPostgreSqlPortableDestination({ ...input, ...overrides }); writers.push(writer); return writer;
}
async function source() {
  const stream = await createPortableRecordStream(createFixtureSource({ description: generation.description, records: generation.records })); streams.push(stream); return stream;
}
async function admitted() {
  const writer = await open(); const stream = await source(); const manifest = stream.describe();
  const token = await writer.preflight(manifest, stream); await writer.admit(manifest, token);
  return { writer, stream, manifest, token };
}
async function batch(stream: PortableRecordStream, domain: PortableDomain = 'machines', after?: PortableBatch['checkpoint'], maxRecords = 500) {
  return stream.readBatch({ domain, after, maxRecords, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
}
async function transferAll(writer: PortableRecordWriter, stream: PortableRecordStream) {
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) await writer.applyBatch(await batch(stream, domain));
}
function expectNoRun() {
  expect(db.run).toBeUndefined(); expect(db.receipts).toEqual([]); expect(db.identities.size).toBe(0);
  for (const [domain, records] of db.records) if (!identityDomains.has(domain)) expect(records).toEqual([]);
}

describe('PostgreSQL portable destination authority', () => {
  it.each([
    {}, { settings: undefined }, { expectedOwner: '' }, { expectedOwner: 1 },
    { generationId: '' }, { generationId: '/' }, { generationId: 1 },
    { runId: '' }, { runId: '/' }, { runId: 1 },
    { expectedIdentity: null }, { expectedIdentity: {} },
  ])('refuses malformed authority before opening a database: %j', async invalid => {
    const candidate = Object.keys(invalid).length ? { ...input, ...invalid } : {};
    await expect(createPostgreSqlPortableDestination(candidate as never)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(db.clients).toEqual([]); expectNoRun();
  });
  it.each([
    { id: 'invalid' }, { remoteProjectId: 'other' }, { machineId: 4 }, { machineId: 'invalid' },
    { localProjectId: 4 }, { localProjectId: 'bad' }, { selectedPath: 4 }, { selectedPath: '' }, { selectedPath: 'relative/project' }, { selectedPath: '/project\0x' },
  ])('refuses malformed identity fields: %j', async fields => {
    await expect(open({ expectedIdentity: { ...input.expectedIdentity, ...fields } as never })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(db.clients).toEqual([]); expectNoRun();
  });
  it('refuses already-aborted construction without acquiring a session', async () => {
    await expect(open({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted', retryable: true });
    expect(db.clients).toEqual([]); expectNoRun();
  });
  it('does not accept a caller-forged transaction authority', async () => {
    await expect(applyPortableBatchInTransaction({ query: async () => { throw new Error('secret SQL canary'); } }, {} as never, {} as never)).rejects.toEqual(new PortableTransferError('destination-conflict'));
    expect(db.queryLog).toEqual([]); expectNoRun();
  });
  it.each([
    [], [{ tls: false, version: 180000, encoding: 'UTF8' }],
    [{ tls: true, version: 170000, encoding: 'UTF8' }],
    [{ tls: true, version: 180000, encoding: 'LATIN1' }],
  ].map(safety => [safety]))('refuses unsafe server metadata %j and releases its session', async safety => {
    db.safety = safety;
    await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' });
    expect(db.clients.every(client => client.ended)).toBe(true); expectNoRun();
  });
  it('refuses another writer holding the destination lock', async () => {
    db.lock = false; await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('sanitizes connection failure even when cleanup fails', async () => {
    db.connectFailure = true; db.endFailure = true;
    await expect(open()).rejects.toEqual(new PortableTransferError('destination-failed')); expectNoRun();
  });
  it('sanitizes client configuration failure before a client exists', async () => {
    boundaries.config.mockImplementation(() => { throw new Error('secret password'); });
    await expect(open()).rejects.toEqual(new PortableTransferError('destination-failed')); expect(db.clients).toEqual([]);
  });
  it('refuses schema readiness failure without a run', async () => {
    boundaries.schema.mockRejectedValue(new Error('secret schema'));
    await expect(open()).rejects.toEqual(new PortableTransferError('destination-failed')); expectNoRun();
  });
  it('refuses missing registered identity binding', async () => {
    db.binding = []; await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('refuses oversized identity rows before decoding them', async () => {
    boundaries.headers.mockResolvedValue([{ locator: '0', byteLength: String(PORTABLE_LIMITS.maxBatchBytes + 1) }]);
    await expect(open()).rejects.toMatchObject({ code: 'unsupported-capability' }); expectNoRun();
  });
  it('refuses identity rows deleted after their header was read', async () => {
    boundaries.row.mockResolvedValue(undefined);
    await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('refuses a machine whose identity key exceeds the SQL bound', async () => {
    db.machines[0]!.identity_key = null;
    await expect(open()).rejects.toMatchObject({ code: 'unsupported-capability' }); expectNoRun();
  });
  it('refuses nonempty data without a matching durable run', async () => {
    db.records.set('conversations', [...generation.records.get('conversations')!]);
    await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.run).toBeUndefined();
  });
  it('rejects identity object mutation and revokes closed authority', async () => {
    const { writer, stream } = await admitted();
    const first = await batch(stream);
    Object.assign(input.expectedIdentity, { selectedPath: '/other/project' });
    await expect(writer.readProgress(stream.describe().manifestSha256)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(applyPortableBatchInTransaction({ transactionScope: 'active', query: (config: QueryConfig) => db.query(config) } as never, writer, first)).rejects.toMatchObject({ code: 'destination-conflict' });
    await writer.close();
    await expect(applyPortableBatchInTransaction({ transactionScope: 'active', query: (config: QueryConfig) => db.query(config) } as never, writer, first)).rejects.toMatchObject({ code: 'destination-conflict' });
    expect(db.receipts).toEqual([]);
  });
  it('rejects live identity drift before writing', async () => {
    const { writer, stream } = await admitted(); db.machines[0]!.identity_key = 'changed';
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.receipts).toEqual([]);
  });
});

describe('complete preflight and durable admission', () => {
  it('scans every domain without materializing data and only accepts its branded token', async () => {
    const writer = await open(); const stream = await source(); const manifest = stream.describe();
    const token = await writer.preflight(manifest, stream);
    expect(Object.isFrozen(token)).toBe(true); expectNoRun();
    await expect(writer.admit(manifest, { ...token })).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
    await writer.admit(manifest, token);
    expect(await writer.readProgress(manifest.manifestSha256)).toMatchObject({ manifestSha256: manifest.manifestSha256, checkpoints: [], complete: false });
    expect(db.run).toMatchObject({ run_id: 'run_1', target_generation: 'generation_1', state: 'active' });
  });
  it('refuses mismatched source manifests and self-copy witnesses', async () => {
    const writer = await open(); const stream = await source(); const other = await createPortableRecordStream(createGeneration({ ...postgresGeneration(), sharedWitness: false, generation: 'other' }).source); streams.push(other);
    await expect(writer.preflight(other.describe(), stream)).rejects.toMatchObject({ code: 'invalid-input' });
    boundaries.witness.mockResolvedValue(stream.describe().source.sourceWitnessSha256);
    const selfWriter = await open();
    await expect(selfWriter.preflight(stream.describe(), stream)).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('rejects foreign and superseded preflight tokens', async () => {
    const writer = await open(); const other = await open(); const stream = await source(); const manifest = stream.describe();
    const old = await writer.preflight(manifest, stream);
    await expect(other.admit(manifest, old)).rejects.toMatchObject({ code: 'destination-conflict' });
    const current = await writer.preflight(manifest, stream);
    await expect(writer.admit(manifest, old)).rejects.toMatchObject({ code: 'destination-conflict' });
    await writer.admit(manifest, current); expect(db.run?.state).toBe('active');
  });
  it('rejects an unsupported late record without writing any earlier records and removes its index', async () => {
    boundaries.capability.mockImplementation((record: PortableRecord) => { if (record.domain === 'passive-events') throw new PortableTransferError('unsupported-capability'); });
    const writer = await open(); const stream = await source();
    await expect(writer.preflight(stream.describe(), stream)).rejects.toMatchObject({ code: 'unsupported-capability' });
    expectNoRun(); expect(readdirSync(scratch)).toEqual([]);
  });
  it('requires exact registered alias cardinality', async () => {
    const writer = await open(); const stream = await source();
    boundaries.headers.mockImplementation(async (_e, _p, domain: PortableDomain, after: string | null) => {
      const records = db.records.get(domain) ?? [];
      const row = records.filter(r => after === null || String(r.ordinal).padStart(8, '0') > after)[0];
      if (row) return [{ locator: String(row.ordinal).padStart(8, '0'), byteLength: '128' }];
      return domain === 'project-aliases' && after !== 'extra' ? [{ locator: 'extra', byteLength: '128' }] : [];
    });
    boundaries.row.mockImplementation(async (_e, _p, domain: PortableDomain, locator: string) => locator === 'extra' ? {} : db.records.get(domain)?.[Number(locator)]?.value);
    await expect(writer.preflight(stream.describe(), stream)).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('does not let identity preflight resolve payload dependencies', async () => {
    boundaries.insert.mockImplementation(async (_e, _p, _r, resolve) => resolve('machines', 'forged'));
    const writer = await open(); const stream = await source();
    await expect(writer.preflight(stream.describe(), stream)).rejects.toMatchObject({ code: 'invalid-input' }); expectNoRun();
  });
  it('refuses data appearing between preflight and admission', async () => {
    const writer = await open(); const stream = await source(); const token = await writer.preflight(stream.describe(), stream);
    db.records.set('conversations', [...generation.records.get('conversations')!]);
    await expect(writer.admit(stream.describe(), token)).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.run).toBeUndefined();
  });
  it('resumes an exact durable run without adding another ledger and rejects wrong run or generation', async () => {
    const { writer, stream, manifest, token } = await admitted(); await writer.admit(manifest, token);
    await writer.applyBatch(await batch(stream)); await writer.close();
    const resumed = await open(); const preflight = await resumed.preflight(manifest, stream); await resumed.admit(manifest, preflight);
    expect((await resumed.readProgress(manifest.manifestSha256)).checkpoints).toHaveLength(1);
    await expect(open({ runId: 'other' })).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(open({ generationId: 'other' })).rejects.toMatchObject({ code: 'destination-conflict' });
    db.run!.project_sha256 = '0'.repeat(64);
    await expect(open()).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.receipts).toHaveLength(1);
  });
});

describe('transactional batches and authenticated receipts', () => {
  it('writes all domains and verifies materialized content before marking completion', async () => {
    const { writer, stream, manifest } = await admitted();
    await transferAll(writer, stream);
    for (const [domain, records] of generation.records) expect(db.records.get(domain)).toEqual(records);
    expect(db.receipts).toHaveLength(22); expect(db.run!.state).toBe('active');
    const verified = await writer.verifyComplete(manifest);
    expect(verified).toMatchObject({ complete: true, manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256 });
    expect(verified.domains).toHaveLength(22);
    expect((await writer.readProgress(manifest.manifestSha256)).complete).toBe(true);
    const saved = db.snapshot(); await writer.applyBatch(await batch(stream)); expect(db.snapshot()).toEqual(saved);
  });
  it('advances a domain in durable prefixes and replays exact earlier batches harmlessly', async () => {
    const { writer, stream, manifest } = await admitted();
    const first = await batch(stream, 'machines', undefined, 1);
    expect(first.complete).toBe(false);
    expect(await writer.applyBatch(first)).toEqual(first.checkpoint);
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([first.checkpoint]);
    const second = await batch(stream, 'machines', first.checkpoint, 1);
    await writer.applyBatch(second); const saved = db.snapshot();
    expect(await writer.applyBatch(first)).toEqual(first.checkpoint); expect(await writer.applyBatch(second)).toEqual(second.checkpoint);
    expect(db.snapshot()).toEqual(saved);
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toEqual([second.checkpoint]);
  });
  it('rejects a skipped domain and a missing prior receipt before writing', async () => {
    const { writer, stream } = await admitted(); const saved = db.snapshot();
    await expect(writer.applyBatch(await batch(stream, 'project'))).rejects.toMatchObject({ code: 'checkpoint-mismatch' });
    const first = await batch(stream, 'machines', undefined, 1);
    await expect(writer.applyBatch(await batch(stream, 'machines', first.checkpoint))).rejects.toMatchObject({ code: 'checkpoint-mismatch' });
    expect(db.snapshot()).toEqual(saved);
  });
  it('rolls back materialized rows, dependency mappings, and receipt when CAS loses', async () => {
    const { writer, stream } = await admitted();
    for (const domain of ['machines', 'project', 'project-aliases'] as const) await writer.applyBatch(await batch(stream, domain));
    const saved = db.snapshot(); db.cas = false;
    await expect(writer.applyBatch(await batch(stream, 'conversations'))).rejects.toMatchObject({ code: 'checkpoint-mismatch' });
    expect(db.snapshot()).toEqual(saved);
  });
  it('rolls back a batch when a required durable dependency mapping disappears', async () => {
    const { writer, stream } = await admitted();
    for (const domain of ['machines', 'project', 'project-aliases'] as const) await writer.applyBatch(await batch(stream, domain));
    db.identities.clear(); const saved = db.snapshot();
    await expect(writer.applyBatch(await batch(stream, 'conversations'))).rejects.toMatchObject({ code: 'checkpoint-mismatch' }); expect(db.snapshot()).toEqual(saved);
  });
  it.each(['batch_sha256', 'checkpoint_sha256', 'checkpoint_bytes'] as const)('rejects a corrupted replay receipt %s without reapplying rows', async field => {
    const { writer, stream } = await admitted(); const first = await batch(stream); await writer.applyBatch(first);
    db.receipts[0]![field] = field === 'checkpoint_bytes' ? Buffer.from('corrupt') : '0'.repeat(64);
    const saved = db.snapshot();
    await expect(writer.applyBatch(first)).rejects.toMatchObject({ code: 'checkpoint-mismatch' }); expect(db.snapshot()).toEqual(saved);
  });
  it.each([
    [], [{ isolation: 'serializable', readonly: 'off' }], [{ isolation: 'read committed', readonly: 'on' }],
  ].map(isolation => [isolation]))('refuses incompatible caller transaction metadata %j', async isolation => {
    const { writer, stream } = await admitted(); db.isolation = isolation; const saved = db.snapshot();
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.snapshot()).toEqual(saved);
  });
  it('refuses an unadmitted branded writer and a changed transaction witness', async () => {
    const writer = await open(); const stream = await source();
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
    const token = await writer.preflight(stream.describe(), stream); await writer.admit(stream.describe(), token);
    boundaries.witness.mockResolvedValue('0'.repeat(64));
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.receipts).toEqual([]);
  });
  it('applies inside the caller transaction without starting or committing it', async () => {
    const { writer, stream } = await admitted(); const first = await batch(stream); const saved = db.snapshot();
    await db.query({ text: 'BEGIN' }); db.queryLog = [];
    expect(await applyPortableBatchInTransaction({ transactionScope: 'active', query: (config: QueryConfig) => db.query(config) } as never, writer, first)).toEqual(first.checkpoint);
    expect(db.queryLog.some(text => text === 'COMMIT' || text.startsWith('BEGIN'))).toBe(false);
    await db.query({ text: 'ROLLBACK' }); expect(db.snapshot()).toEqual(saved);
  });
  it('refuses new mutation when the run is not active', async () => {
    const { writer, stream } = await admitted(); db.run!.state = 'completed'; const saved = db.snapshot();
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.snapshot()).toEqual(saved);
  });
});

describe('uncertain commits, cancellation and release', () => {
  it('recovers a lost COMMIT response from the durable exact receipt', async () => {
    const { writer, stream } = await admitted(); const first = await batch(stream); db.commitFailure = 'after';
    expect(await writer.applyBatch(first)).toEqual(first.checkpoint);
    expect(db.receipts).toHaveLength(1); expect(db.clients).toHaveLength(2); expect(db.clients[0]!.ended).toBe(true);
  });
  it('reports uncertain when a failed COMMIT has no durable receipt', async () => {
    const { writer, stream } = await admitted(); const saved = db.snapshot(); db.commitFailure = 'before';
    await expect(writer.applyBatch(await batch(stream))).rejects.toEqual(new PortableTransferError('destination-uncertain', true)); expect(db.snapshot()).toEqual(saved);
  });
  it('cannot acknowledge a receipt through a changed target witness after reconnect', async () => {
    const { writer, stream } = await admitted();
    db.commitFailure = 'after'; boundaries.witness.mockResolvedValueOnce('f'.repeat(64)).mockResolvedValue('0'.repeat(64));
    await expect(writer.applyBatch(await batch(stream))).rejects.toEqual(new PortableTransferError('destination-uncertain', true));
    expect(db.receipts).toHaveLength(1);
  });
  it('sanitizes query errors and permanently refuses a session with failed rollback', async () => {
    const { writer, stream, manifest } = await admitted();
    db.beforeQuery = config => { if (config.text.includes('transaction_isolation')) throw new Error('secret query'); };
    db.rollbackFailure = true;
    await expect(writer.applyBatch(await batch(stream))).rejects.toEqual(new PortableTransferError('destination-failed'));
    db.beforeQuery = undefined;
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toEqual(new PortableTransferError('destination-failed')); expect(db.receipts).toEqual([]);
  });
  it('fails closed after an asynchronous client error', async () => {
    const { writer, manifest } = await admitted(); db.clients[0]!.emit('error', new Error('secret socket'));
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toEqual(new PortableTransferError('destination-failed')); expect(db.receipts).toEqual([]);
  });
  it('cancels in-flight SQL, preserves aborted classification when close fails, and ends the connection', async () => {
    const { writer, manifest } = await admitted(); const controller = new AbortController(); db.endFailure = true;
    db.beforeQuery = () => { controller.abort(); throw new Error('secret cancelled query'); };
    await expect(writer.readProgress(manifest.manifestSha256, controller.signal)).rejects.toEqual(new PortableTransferError('aborted', true));
    expect(db.clients[0]!.ended).toBe(true); expect(db.receipts).toEqual([]);
  });
  it('rejects pre-aborted work without issuing SQL', async () => {
    const { writer, manifest } = await admitted(); const queries = db.queryLog.length;
    await expect(writer.readProgress(manifest.manifestSha256, AbortSignal.abort())).rejects.toMatchObject({ code: 'aborted' }); expect(db.queryLog).toHaveLength(queries);
  });
  it('closes once, drains accepted work and rejects newly enqueued work', async () => {
    const { writer, manifest } = await admitted(); const pending = writer.readProgress(manifest.manifestSha256);
    const closing = writer.close(); expect(writer.close()).toBe(closing);
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(pending).resolves.toMatchObject({ checkpoints: [] }); await closing;
    expect(db.clients.every(client => client.ended)).toBe(true); expect(readdirSync(scratch)).toEqual([]);
  });
  it('reports sanitized close failure without leaking raw driver messages', async () => {
    const writer = await open(); db.endFailure = true;
    await expect(writer.close()).rejects.toEqual(new PortableTransferError('close-failed'));
  });
});

describe('ledger drift and readback failures', () => {
  it('refuses progress until a manifest is admitted and rejects another manifest hash', async () => {
    const writer = await open(); const stream = await source();
    await expect(writer.readProgress(stream.describe().manifestSha256)).rejects.toMatchObject({ code: 'destination-conflict' });
    const token = await writer.preflight(stream.describe(), stream); await writer.admit(stream.describe(), token);
    await expect(writer.readProgress('0'.repeat(64))).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.receipts).toEqual([]);
  });
  it.each(['run_id', 'target_generation', 'project_id', 'manifest_sha256', 'project_sha256', 'manifest_bytes'] as const)('refuses altered durable run %s at admission, progress and apply', async field => {
    const { writer, stream, manifest, token } = await admitted();
    db.run![field] = field === 'manifest_bytes' ? Buffer.from('different') : 'wrong'; const saved = db.snapshot();
    await expect(writer.admit(manifest, token)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' });
    expect(db.snapshot()).toEqual(saved);
  });
  it.each(['missing', 'duplicates', 'checkpoint-bytes-only', 'checkpoint-hash-only'])('refuses inconsistent run state: %s', async fault => {
    const { writer, stream, manifest } = await admitted();
    if (fault === 'missing') db.run = undefined;
    if (fault === 'duplicates') db.extraRuns = true;
    if (fault === 'checkpoint-bytes-only') db.run!.checkpoint_bytes = Buffer.from('inconsistent');
    if (fault === 'checkpoint-hash-only') db.run!.checkpoint_sha256 = '0'.repeat(64);
    const saved = db.snapshot();
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(writer.applyBatch(await batch(stream))).rejects.toMatchObject({ code: 'destination-conflict' });
    expect(db.snapshot()).toEqual(saved);
  });
  it('requires caller executor transaction scope plus a server assigned transaction id', async () => {
    const { writer, stream } = await admitted(); const first = await batch(stream); const saved = db.snapshot();
    await expect(applyPortableBatchInTransaction({ query: (config: QueryConfig) => db.query(config) } as never, writer, first)).rejects.toMatchObject({ code: 'destination-conflict' });
    await expect(applyPortableBatchInTransaction({ transactionScope: 'active', query: (config: QueryConfig) => db.query(config) } as never, writer, first)).rejects.toMatchObject({ code: 'destination-conflict' });
    expect(db.snapshot()).toEqual(saved);
  });
  it('requires the source to contain every preexisting registered alias', async () => {
    db.records.get('project-aliases')!.push(createPortableRecord({ domain: 'project-aliases', ordinal: 3, value: { machineIdentityKey: 'installation:0b7715', path: '/extra/project', normalizedPath: '/extra/project' }, context: { projectIdentity: { scope: 'shared', projectId: SHARED_PROJECT_UUID } } }));
    const writer = await open(); const stream = await source();
    await expect(writer.preflight(stream.describe(), stream)).rejects.toMatchObject({ code: 'destination-conflict' }); expectNoRun();
  });
  it('refuses completion before every domain has a complete receipt', async () => {
    const { writer, stream, manifest } = await admitted();
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: 'verification-failed' });
    await writer.applyBatch(await batch(stream, 'machines', undefined, 1));
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: 'verification-failed' }); expect(db.run!.state).toBe('active');
  });
  it('detects materialized data loss independently of intact receipts', async () => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream);
    db.records.get('passive-events')!.pop();
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: 'verification-failed' });
    expect(db.run!.state).toBe('active'); expect(db.receipts).toHaveLength(22);
  });
  it.each(['recordCount', 'prefixSha256'] as const)('requires the caller manifest %s to match actual domain readback', async field => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream);
    const domains = manifest.domains.map((domain, i) => i ? domain : { ...domain, [field]: field === 'recordCount' ? domain.recordCount + 1 : '0'.repeat(64) });
    await expect(writer.verifyComplete({ ...manifest, domains })).rejects.toMatchObject({ code: 'verification-failed' }); expect(db.run!.state).toBe('active');
  });
  it('rechecks the run under lock before publishing successful readback', async () => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream);
    db.beforeQuery = config => { if (config.text.includes('FOR UPDATE')) db.run!.run_id = 'changed'; };
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: 'destination-conflict' }); expect(db.run!.state).toBe('active');
  });
  it('closes an uninitialized readback source and preserves its primary failure if close also fails', async () => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream);
    const readback = createFixtureSource({ description: generation.description, records: db.records, describeOverride: () => { throw new Error('secret readback source'); }, onClose: () => { throw new Error('secret close'); } });
    boundaries.source.mockResolvedValue(readback);
    await expect(writer.verifyComplete(manifest)).rejects.toMatchObject({ code: 'source-failed' });
    expect(readback.closed()).toBe(true); expect(db.run!.state).toBe('active');
  });
  it('reports close-failed after otherwise successful readback', async () => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream);
    const readback = createFixtureSource({ description: generation.description, records: db.records, onClose: () => { throw new Error('secret close'); } }); boundaries.source.mockResolvedValue(readback);
    await expect(writer.verifyComplete(manifest)).rejects.toEqual(new PortableTransferError('close-failed'));
    expect(readback.closed()).toBe(true); expect(db.run!.state).toBe('completed');
  });
  it('preserves verification-failed when readback cleanup also fails', async () => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream); db.records.get('passive-events')!.pop();
    boundaries.source.mockResolvedValue(createFixtureSource({ description: generation.description, records: db.records, onClose: () => { throw new Error('secret close'); } }));
    await expect(writer.verifyComplete(manifest)).rejects.toEqual(new PortableTransferError('verification-failed')); expect(db.run!.state).toBe('active');
  });
});

describe('durable admission and completion reconciliation', () => {
  it.each(['before', 'after'] as const)('reconciles admission after a lost commit %s durability', async outcome => {
    const writer = await open(); const stream = await source(); const manifest = stream.describe(); const token = await writer.preflight(manifest, stream);
    db.commitFailure = outcome;
    if (outcome === 'after') {
      await writer.admit(manifest, token);
      expect(await writer.readProgress(manifest.manifestSha256)).toMatchObject({ checkpoints: [], complete: false });
    } else {
      await expect(writer.admit(manifest, token)).rejects.toEqual(new PortableTransferError('destination-uncertain', true)); expectNoRun();
    }
  });
  it.each(['before', 'after'] as const)('reconciles completion after a lost commit %s durability', async outcome => {
    const { writer, stream, manifest } = await admitted(); await transferAll(writer, stream); db.commitFailure = outcome;
    if (outcome === 'after') {
      await expect(writer.verifyComplete(manifest)).resolves.toMatchObject({ complete: true }); expect(db.run!.state).toBe('completed');
    } else {
      await expect(writer.verifyComplete(manifest)).rejects.toEqual(new PortableTransferError('destination-uncertain', true)); expect(db.run!.state).toBe('active');
    }
  });
  it('does not acknowledge admission if its run changes during reconnect', async () => {
    const writer = await open(); const stream = await source(); const manifest = stream.describe(); const token = await writer.preflight(manifest, stream);
    db.commitFailure = 'after';
    db.beforeQuery = config => { if (db.clients.length > 1 && config.text.includes('FROM lcm.transfer_runs')) db.run!.target_generation = 'other'; };
    await expect(writer.admit(manifest, token)).rejects.toEqual(new PortableTransferError('destination-uncertain', true)); expect(db.receipts).toEqual([]);
  });
  it('retains lifetime cancellation after construction and combines operation signals', async () => {
    const controller = new AbortController(); const writer = await open({ signal: controller.signal }); const stream = await source(); const manifest = stream.describe();
    const operation = new AbortController(); const token = await writer.preflight(manifest, stream, operation.signal); await writer.admit(manifest, token, operation.signal);
    await expect(writer.readProgress(manifest.manifestSha256, operation.signal)).resolves.toMatchObject({ complete: false });
    controller.abort();
    await expect(writer.readProgress(manifest.manifestSha256)).rejects.toEqual(new PortableTransferError('aborted', true));
    await expect(writer.readProgress(manifest.manifestSha256, operation.signal)).rejects.toEqual(new PortableTransferError('aborted', true)); expect(db.receipts).toEqual([]);
  });
});


describe('preflight index corruption', () => {
  it.each(['missing', 'ordinal', 'record-digest'])('rejects %s indexed evidence before applying a batch', async fault => {
    const { writer, stream } = await admitted(); const first = await batch(stream); const record = first.records[0]!; const saved = db.snapshot();
    const original = PortableIndex.prototype.lookupIdentity;
    vi.spyOn(PortableIndex.prototype, 'lookupIdentity').mockImplementationOnce(function (domain, identity) {
      const found = original.call(this, domain, identity)!;
      return fault === 'missing' ? null : { ...found, ...(fault === 'ordinal' ? { ordinal: record.ordinal + 1 } : { recordSha256: '0'.repeat(64) }) };
    });
    await expect(writer.applyBatch(first)).rejects.toMatchObject({ code: 'checkpoint-mismatch' }); expect(db.snapshot()).toEqual(saved);
  });
});

describe('bounded preflight and terminal progress', () => {
  it('consumes multiple actual batches per domain before granting admission', async () => {
    const writer = await open(); const stream = await source(); const manifest = stream.describe();
    const bounded: PortableRecordStream = { ...stream, readBatch: request => stream.readBatch({ ...request, maxRecords: 1 }) };
    const token = await writer.preflight(manifest, bounded); expectNoRun();
    await writer.admit(manifest, token); expect(db.run!.state).toBe('active');
  });
  it('refuses completion when only the last domain remains incomplete', async () => {
    const { writer, stream, manifest } = await admitted();
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER.slice(0, -1)) await writer.applyBatch(await batch(stream, domain));
    const partial = await batch(stream, 'passive-events', undefined, 1); await writer.applyBatch(partial);
    expect((await writer.readProgress(manifest.manifestSha256)).checkpoints).toHaveLength(22);
    await expect(writer.verifyComplete(manifest)).rejects.toEqual(new PortableTransferError('verification-failed')); expect(db.run!.state).toBe('active');
  });
  it('can reconcile a durable receipt even when ending the lost session fails', async () => {
    const { writer, stream } = await admitted(); const first = await batch(stream);
    db.commitFailure = 'after'; db.endFailure = true;
    await expect(writer.applyBatch(first)).resolves.toEqual(first.checkpoint); expect(db.receipts).toHaveLength(1);
  });
});


describe('global constraints belonging to unrelated projects', () => {
  it.each([
    ['message-parts', 'partId'], ['promoted-memories', 'memoryId'],
    ['passive-events', 'eventId'], ['passive-events', 'machineSequence'],
  ] as const)('rejects a foreign %s %s conflict before materializing any prefix', async (domain, key) => {
    const record = generation.records.get(domain)![0]!;
    const value = record.value as unknown as Row;
    const collision: Row = { project_id: '018f7766-1c40-7a11-b3d6-5c1f0a2b7e95',
      table: domain === 'message-parts' ? 'message_parts' : domain === 'promoted-memories' ? 'promoted_memories' : 'passive_event_inbox',
      ...(key === 'partId' ? { part_id: value.partId } : key === 'memoryId' ? { memory_id: value.memoryId }
        : { identity_key: value.machineIdentityKey, event_id: key === 'eventId' ? value.eventId : 'different-event', machine_sequence: key === 'machineSequence' ? (value.machineSequence as { $integer: string }).$integer : '-1' }),
    };
    db.foreignRows = [collision]; const saved = db.snapshot();
    const writer = await open(); const stream = await source();
    await expect(writer.preflight(stream.describe(), stream)).rejects.toEqual(new PortableTransferError('unsupported-capability'));
    expectNoRun(); expect(db.snapshot()).toEqual(saved); expect(db.foreignRows).toEqual([collision]);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe('generated PostgreSQL search expressions', () => {
  it.each([
    ['messages', 'content'], ['summaries', 'content'],
    ['promoted-memories', 'content'], ['promoted-memory-tags', 'tag'],
  ] as const)('refuses an unrepresentable %s %s expression before any target mutation', async (domain, field) => {
    const record = generation.records.get(domain)![0]!;
    const text = (record.value as unknown as Row)[field];
    const canary = `private-generated-vector-${domain}`;
    db.beforeQuery = config => {
      if (config.text.includes('pg_catalog.pg_column_size(pg_catalog.to_tsvector(') && config.values?.[0] === text) throw new Error(canary);
    };
    const saved = db.snapshot(); const writer = await open(); const stream = await source();
    const failure = await writer.preflight(stream.describe(), stream).then(() => undefined, error => error);
    expect(failure).toEqual(new PortableTransferError('unsupported-capability'));
    expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain(canary);
    expect(failure).not.toHaveProperty('cause');
    expectNoRun(); expect(db.snapshot()).toEqual(saved); expect(readdirSync(scratch)).toEqual([]);
  });
});
