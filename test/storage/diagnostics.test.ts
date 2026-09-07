import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqlitePool = vi.hoisted(() => ({
  get: vi.fn(() => ({
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    connections: [],
  })),
}));
vi.mock('../../src/db/connection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/db/connection.js')>(),
  getPoolStats: sqlitePool.get,
}));
import { BackendPublicationJournalError } from '../../src/storage/backend-publication.js';
import { backendDiagnosticFailure, collectBackendDiagnostics } from '../../src/storage/diagnostics.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, {recursive:true,force:true}); });
beforeEach(() => {
  sqlitePool.get.mockReset().mockReturnValue({
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    connections: [],
  });
});
describe('backend diagnostics', () => {
  it('observes missing SQLite state without creating a home or claiming a schema probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lcm-diagnostic-')); homes.push(home);
    const result = await collectBackendDiagnostics({homeDir:home});
    expect(result).toMatchObject({backend:'sqlite',classification:'unavailable',publication:'ready',schema:'unverified'});
    expect(readdirSync(home)).toEqual([]);
  });
  it.each(['unresolved-publication','publication-evidence-missing','backend-mismatch','checksum-mismatch','unexpected-state'] as const)('classifies publication refusal %s', reason => {
    const result = backendDiagnosticFailure(new BackendPublicationJournalError(reason,'secret host role payload'));
    expect(result.classification).toBe('stale-publication');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each(['invalid-input','unsafe-storage','malformed-journal','permit-mismatch'] as const)('classifies unsafe admission %s', reason => {
    expect(backendDiagnosticFailure(new BackendPublicationJournalError(reason,'secret')).classification).toBe('unavailable');
  });
  it.each(['EACCES','EPERM'])('maps trusted local code %s without error text', code => {
    expect(backendDiagnosticFailure(Object.assign(new Error('secret'),{code})).classification).toBe('permission-denied');
    expect(backendDiagnosticFailure(new Error('EACCES 42501 secret')).classification).toBe('unavailable');
  });
});

import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { PostgreSqlStorageOperationError } from '../../src/storage/postgresql/errors.js';
import type { BackendDiagnosticDependencies, BackendDiagnosticObservation, BackendDiagnosticRuntime } from '../../src/storage/diagnostics.js';
import type { PostgreSqlRuntimeHealth } from '../../src/storage/postgresql/contracts.js';
import type { PostgreSqlDiagnosticMetrics } from '../../src/storage/postgresql/diagnostics.js';

const machineId = '01912345-1234-7123-8123-123456789abc';
const metrics: PostgreSqlDiagnosticMetrics = { projects:1,conversations:2,compactedConversations:1,messages:4,summaries:2,maxDepth:1,rawTokens:200,summaryTokens:100,ratio:2,promotedCount:1,redactionCounts:{builtIn:1,global:2,project:3,total:6},recallStats:{memoriesSurfaced:3,memoriesActedUpon:1,recallPrecision:1/3} };
const outbox = {captured:3,unprocessed:2,errors:0,lastCapture:null,deliveryPending:1,deliveryClaimed:0,deliveryRetry:0,deliveryReplicated:0,deliveryAcknowledged:0,deliveryAwaitingRemotePrune:0,deliveryQuarantined:0,oldestDeliveryAt:null};
function fixture() {
  const config = parseDaemonConfig('{}');
  config.storage = {backend:'postgresql',postgresql:{url:'postgresql://secret:secret@secret.example/secret',caFile:'/secret/ca',migrationRole:'secret-role',poolMax:5,connectionTimeoutMs:10000,idleTimeoutMs:30000,statementTimeoutMs:60000}};
  const observation: BackendDiagnosticObservation = {config,witness:'a',machineId,mapContent:null};
  const health = {status:'healthy',backend:'postgresql',tls:true,serverMajorVersion:18,serverEncoding:'UTF8',timezone:'UTC',role:'secret-role',extensions:['pg_stat_statements','pg_trgm','pgcrypto','unaccent'].map(name => ({name,status:'current'})),searchConfiguration:{ready:true}} as PostgreSqlRuntimeHealth;
  const runtime: BackendDiagnosticRuntime = {query:vi.fn(),health:vi.fn(async()=>health),poolDiagnostics:vi.fn(()=>({configuredMax:5,total:1,idle:1,waiting:0,failed:false})),close:vi.fn(async()=>{})};
  const dependencies: BackendDiagnosticDependencies = {observePublication:vi.fn(()=>observation),createRuntime:vi.fn(()=>runtime),verifySchema:vi.fn(async()=>({} as never)),readMetrics:vi.fn(async()=>metrics),readOutbox:vi.fn(async()=>outbox)};
  return {observation,runtime,dependencies,health};
}
describe('bounded authenticated probe', () => {
  it('returns only safe verified fields and closes its probe exactly once', async()=>{
    const {dependencies,runtime}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result).toMatchObject({classification:'healthy',schema:'ready',tls:'ready',pool:{origin:'diagnostic-probe',total:1},identity:{machineId},metrics,outbox:{status:'ready',captured:3}});
    expect(JSON.stringify(result)).not.toMatch(/secret|postgresql:\/\/|sqlState|serverEncoding|role/);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(dependencies.observePublication).toHaveBeenCalledTimes(2);
    expect(dependencies.readOutbox).toHaveBeenCalledWith(expect.objectContaining({pruneOrphanSidecars:false,signal:expect.any(AbortSignal)}));
  });
  it.each(['42501','28000','28P01','57014','08006'])('maps typed SQLSTATE %s and drops partial metrics',async code=>{
    const {dependencies}=fixture();
    dependencies.readMetrics=vi.fn(async()=>{throw new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},code,false);});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe(code==='57014'?'timeout':code==='08006'?'unavailable':'permission-denied');
    expect(result.metrics).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(code);
  });
  it('never probes after publication admission refusal',async()=>{
    const {dependencies}=fixture(); dependencies.observePublication=()=>{throw new BackendPublicationJournalError('backend-mismatch','secret');};
    expect((await collectBackendDiagnostics({_dependencies:dependencies})).classification).toBe('stale-publication');
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
  });
  it('discards every remote field when publication changes',async()=>{
    const {dependencies,observation}=fixture(); dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'b'});
    expect(await collectBackendDiagnostics({_dependencies:dependencies})).toMatchObject({classification:'stale-publication',schema:'unverified',identity:{status:'unverified'},outbox:{status:'unverified'}});
  });
  it('preserves publication refusal precedence over a failed remote query',async()=>{
    const {dependencies,observation}=fixture(); dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockImplementationOnce(()=>{throw new BackendPublicationJournalError('unexpected-state','secret');});
    dependencies.readMetrics=async()=>{throw Object.assign(new Error('secret'),{code:'EACCES'});};
    expect((await collectBackendDiagnostics({_dependencies:dependencies})).classification).toBe('stale-publication');
  });
  it('bounds a stuck health probe and closes despite rejected cleanup',async()=>{
    const {dependencies,runtime}=fixture(); runtime.health=()=>new Promise(()=>{}); runtime.close=vi.fn(async()=>{throw new Error('secret');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10});
    expect(result.classification).toBe('timeout'); expect(runtime.close).toHaveBeenCalledTimes(1); expect(dependencies.verifySchema).not.toHaveBeenCalled();
  });
  it('closes a runtime acquired after the deadline exactly once without late queries',async()=>{
    const {dependencies,runtime}=fixture(); let complete!:(value:BackendDiagnosticRuntime)=>void;
    dependencies.createRuntime=()=>new Promise(resolve=>{complete=resolve;});
    expect((await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10})).classification).toBe('timeout');
    complete(runtime); await new Promise(resolve=>setImmediate(resolve));
    expect(runtime.close).toHaveBeenCalledTimes(1); expect(runtime.health).not.toHaveBeenCalled();
  });
  it('composes caller cancellation and avoids remote work for pre-aborted callers',async()=>{
    const {dependencies}=fixture(); const controller=new AbortController(); controller.abort();
    expect((await collectBackendDiagnostics({_dependencies:dependencies,signal:controller.signal})).classification).toBe('timeout');
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
  });
  it('cancels a running probe and does not advance when ignored health resolves late',async()=>{
    const {dependencies,runtime,health}=fixture(); const controller=new AbortController(); let complete!:(health:PostgreSqlRuntimeHealth)=>void;
    runtime.health=()=>new Promise(resolve=>{complete=resolve;});
    const work=collectBackendDiagnostics({_dependencies:dependencies,signal:controller.signal});
    await new Promise(resolve=>setImmediate(resolve)); controller.abort();
    expect((await work).classification).toBe('timeout'); complete(health); await new Promise(resolve=>setImmediate(resolve));
    expect(dependencies.verifySchema).not.toHaveBeenCalled(); expect(runtime.close).toHaveBeenCalledTimes(1);
  });
  it('reports a borrowed daemon pool and never closes the factory',async()=>{
    const {dependencies,runtime}=fixture(); const close=vi.fn(); const factory={backend:'postgresql',getDiagnosticPool:()=>({configuredMax:8,total:4,idle:2,waiting:1,failed:true}),close} as never;
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:factory});
    expect(result).toMatchObject({classification:'degraded',pool:{origin:'daemon',configuredMax:8,total:4,failed:true}});
    expect(close).not.toHaveBeenCalled(); expect(runtime.close).toHaveBeenCalledTimes(1);
  });
  it('refuses unverifiable telemetry and does not pretend pool failure is zero',async()=>{
    const {dependencies,runtime}=fixture(); runtime.poolDiagnostics=()=>({configuredMax:5,total:NaN,idle:0,waiting:0,failed:false});
    expect(await collectBackendDiagnostics({_dependencies:dependencies})).toMatchObject({classification:'unavailable',pool:{status:'unverified'}});
  });
  it('does not report healthy without all live prerequisites',async()=>{
    const {dependencies,health}=fixture(); delete (health as {tls?:boolean}).tls;
    expect((await collectBackendDiagnostics({_dependencies:dependencies})).classification).toBe('unavailable');
  });
  it('keeps failed outbox counters absent',async()=>{
    const {dependencies}=fixture(); dependencies.readOutbox=async()=>({...outbox,scanErrors:1});
    expect(await collectBackendDiagnostics({_dependencies:dependencies})).toMatchObject({classification:'unavailable',outbox:{status:'unavailable'}});
  });
  it('uses authenticated SQLite policy and detects config replacement during reads',async()=>{
    const home=mkdtempSync(join(tmpdir(),'lcm-diagnostic-'));homes.push(home);mkdirSync(join(home,'.lcm'),{mode:0o700});
    const path=join(home,'.lcm','config.json');writeFileSync(path,'{}',{mode:0o600});
    const result=await collectBackendDiagnostics({homeDir:home,collectSqlite:async options=>{
      expect(options).toMatchObject({homeDir:home,staleAfterDays:90,staleSurfacingWithoutUseLimit:5});
      writeFileSync(path,'{"restoration":{"staleAfterDays":60}}');
    }});
    expect(result.classification).toBe('stale-publication');
  });
});

import * as identities from '../../src/machine-identity.js';
afterEach(()=>vi.restoreAllMocks());
describe('diagnostic boundary failures and scope',()=>{
  it('does not trust SQLSTATE-looking plain objects or message text',()=>{
    expect(backendDiagnosticFailure({sqlState:'42501',code:'42501',message:'secret'}).classification).toBe('unavailable');
    expect(backendDiagnosticFailure(new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},null,false)).classification).toBe('unavailable');
  });
  it('uses the real verified runtime constructor and sanitizes bad credential settings',async()=>{
    const {observation}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:{observePublication:()=>observation}});
    expect(result.classification).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('detects config changes within the same retained synchronous observation',async()=>{
    const home=mkdtempSync(join(tmpdir(),'lcm-diagnostic-'));homes.push(home);mkdirSync(join(home,'.lcm'),{mode:0o700});
    const path=join(home,'.lcm','config.json');writeFileSync(path,'{}',{mode:0o600});
    vi.spyOn(identities,'readMachineIdentity').mockImplementation(()=>{writeFileSync(path,'{"restoration":{"staleAfterDays":60}}');return null;});
    expect((await collectBackendDiagnostics({homeDir:home})).classification).toBe('stale-publication');
  });
  it('scopes PostgreSQL metrics and local outbox independently from one authenticated binding',async()=>{
    const {dependencies,observation}=fixture(); const id='a'.repeat(64);
    observation.mapContent=JSON.stringify({[id]:{canonical:'/diagnostic/project',aliases:[],remoteProjectId:machineId}});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/project'});
    expect(result.classification).toBe('healthy');
    expect(dependencies.readMetrics).toHaveBeenCalledWith(expect.anything(),expect.any(AbortSignal),machineId);
    expect(dependencies.readOutbox).toHaveBeenCalledWith(expect.objectContaining({projectId:id}));
  });
  it('refuses an unknown cwd without querying all projects',async()=>{
    const {dependencies,observation}=fixture(); delete observation.mapContent;
    expect((await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/missing'})).classification).toBe('unavailable');
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
  });
  it('keeps selected remote outbox unverified when no local binding was observed',async()=>{
    const {dependencies}=fixture();
    expect(await collectBackendDiagnostics({_dependencies:dependencies,projectId:machineId})).toMatchObject({classification:'unavailable',outbox:{status:'unverified'}});
    expect(dependencies.readOutbox).not.toHaveBeenCalled();
  });
  it.each(['extensions-absent','extensions-bad','search-absent','search-bad','health-failed','health-degraded'] as const)('reports live readiness outcome %s',async mode=>{
    const {dependencies,health}=fixture();
    if(mode==='extensions-absent') delete (health as {extensions?:unknown}).extensions;
    if(mode==='extensions-bad') (health as {extensions:unknown}).extensions=[];
    if(mode==='search-absent') delete (health as {searchConfiguration?:unknown}).searchConfiguration;
    if(mode==='search-bad') (health as {searchConfiguration:unknown}).searchConfiguration={ready:false};
    if(mode==='health-failed') (health as {status:string}).status='unavailable';
    if(mode==='health-degraded') (health as {status:string}).status='degraded';
    expect((await collectBackendDiagnostics({_dependencies:dependencies})).classification).toBe(mode==='health-degraded'?'degraded':'unavailable');
  });
  it.each(['metrics','schema','sqlite','outbox'] as const)('cancellation at %s cannot publish completed data',async stage=>{
    const {dependencies,observation}=fixture(); const controller=new AbortController();
    if(stage==='metrics') dependencies.readMetrics=async()=>{controller.abort();return metrics;};
    if(stage==='schema') dependencies.verifySchema=async()=>{controller.abort();return {} as never;};
    if(stage==='outbox') dependencies.readOutbox=async()=>{controller.abort();throw new Error('secret');};
    if(stage==='sqlite') observation.config.storage={backend:'sqlite'};
    const result=await collectBackendDiagnostics({_dependencies:dependencies,signal:controller.signal,collectSqlite:async()=>{controller.abort();}});
    expect(result.classification).toBe('timeout');expect(result.metrics).toBeUndefined();
  });
  it('detects synchronous elapsed deadline even before timer delivery',async()=>{
    const {dependencies,observation}=fixture();let reads=0;
    dependencies.observePublication=()=>{if(++reads===2){const until=performance.now()+15;while(performance.now()<until){ /* Exercise synchronous work preventing timer delivery. */ }}return observation;};
    expect((await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10})).classification).toBe('timeout');
  });
});


it('refuses a dangling root symlink without following or repairing it',async()=>{
  const home=mkdtempSync(join(tmpdir(),'lcm-diagnostic-'));homes.push(home);
  symlinkSync(join(home,'missing-target'),join(home,'.lcm'));
  const result=await collectBackendDiagnostics({homeDir:home});
  expect(result.classification).toBe('unavailable');
  expect(readdirSync(home)).toEqual(['.lcm']);
});

it('refuses a daemon factory backend mismatch without SQLite fallback',async()=>{
  const {dependencies,observation}=fixture(); observation.config.storage={backend:'sqlite'};
  const sqlite=vi.fn(async()=>{});
  const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:{backend:'postgresql'} as never,collectSqlite:sqlite});
  expect(result).toMatchObject({backend:'postgresql',classification:'stale-publication',publication:'unavailable'});
  expect(result.metrics).toBeUndefined();expect(sqlite).not.toHaveBeenCalled();expect(dependencies.createRuntime).not.toHaveBeenCalled();
});

it.each(['DIAGNOSTIC_SQLITE_TIMEOUT','DIAGNOSTIC_SQLITE_ABORTED'])('classifies trusted child outcome %s as timeout',code=>{
  expect(backendDiagnosticFailure(Object.assign(new Error('private-child-error'),{code})).classification).toBe('timeout');
});
it('reports daemon origin for a borrowed SQLite pool',async()=>{
  const {dependencies,observation}=fixture();observation.config.storage={backend:'sqlite'};
  const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:{backend:'sqlite'} as never,collectSqlite:async()=>{}});
  expect(result).toMatchObject({classification:'healthy',pool:{origin:'daemon',status:'ready'}});
});

describe('independent SQLite pool observation', () => {
  const observedPool = {
    totalConnections: 7,
    activeConnections: 4,
    idleConnections: 3,
    connections: [{path:'/private/project/database.sqlite',refs:4,status:'active' as const}],
  };

  it.each([
    ['local', undefined],
    ['daemon', {backend:'sqlite',close:vi.fn()}],
  ] as const)('retains authenticated %s counters when SQLite collection stalls', async (origin, storageFactory) => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'};
    sqlitePool.get.mockReturnValue(observedPool);
    const collectSqlite=vi.fn(()=>new Promise<void>(()=>{}));
    const result=await collectBackendDiagnostics({
      _dependencies:dependencies,
      _deadlineMs:10,
      collectSqlite,
      ...(storageFactory === undefined ? {} : {storageFactory:storageFactory as never}),
    });
    expect(result).toMatchObject({
      classification:'timeout',
      publication:'ready',
      pool:{origin,status:'ready',total:7,idle:3},
      schema:'unverified',
      project:{status:'unverified'},
      outbox:{status:'unverified'},
    });
    expect(result.pool).not.toHaveProperty('connections');
    expect(JSON.stringify(result)).not.toContain('/private/project');
    expect(sqlitePool.get).toHaveBeenCalledOnce();
    expect(sqlitePool.get.mock.invocationCallOrder[0]).toBeLessThan(collectSqlite.mock.invocationCallOrder[0]);
    expect(dependencies.observePublication).toHaveBeenCalledTimes(2);
    if (storageFactory !== undefined) expect(storageFactory.close).not.toHaveBeenCalled();
  });

  it('retains only pool counters when the outbox observation stalls', async () => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'};
    dependencies.readOutbox=vi.fn(()=>new Promise(()=>{}));
    sqlitePool.get.mockReturnValue(observedPool);
    const result=await collectBackendDiagnostics({
      _dependencies:dependencies,
      _deadlineMs:10,
      collectSqlite:async()=>{},
    });
    expect(result).toMatchObject({
      classification:'timeout',
      pool:{origin:'local',status:'ready',total:7,idle:3},
      schema:'unverified',
      project:{status:'unverified'},
      outbox:{status:'unverified'},
    });
    expect(result.metrics).toBeUndefined();
  });

  it('captures safe counters before honoring a pre-aborted caller', async () => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'};
    sqlitePool.get.mockReturnValue(observedPool);
    const controller=new AbortController();controller.abort();
    const collectSqlite=vi.fn(async()=>{});
    const result=await collectBackendDiagnostics({
      _dependencies:dependencies,
      signal:controller.signal,
      collectSqlite,
    });
    expect(result).toMatchObject({classification:'timeout',pool:{origin:'local',status:'ready',total:7,idle:3}});
    expect(sqlitePool.get).toHaveBeenCalledOnce();
    expect(collectSqlite).not.toHaveBeenCalled();
    expect(dependencies.readOutbox).not.toHaveBeenCalled();
  });

  it.each(['changed','refused'] as const)('discards SQLite counters when the timeout witness is %s', async mode => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'};
    dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockImplementation(()=>{
      if(mode==='refused') throw new BackendPublicationJournalError('unexpected-state','private authority');
      return {...observation,witness:'changed'};
    });
    sqlitePool.get.mockReturnValue(observedPool);
    const result=await collectBackendDiagnostics({
      _dependencies:dependencies,
      _deadlineMs:10,
      collectSqlite:()=>new Promise(()=>{}),
    });
    expect(result).toMatchObject({classification:'stale-publication',publication:'unavailable',pool:{status:'unverified'}});
    expect(result.pool.total).toBeUndefined();
    expect(result.pool.idle).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/private|database\.sqlite/);
  });

  it.each([
    ['throws', undefined],
    ['negative total', {...observedPool,totalConnections:-1}],
    ['fractional idle', {...observedPool,idleConnections:1.5}],
    ['unsafe total', {...observedPool,totalConnections:Number.MAX_SAFE_INTEGER+1}],
  ] as const)('keeps SQLite unhealthy when pool observation %s', async (_mode, value) => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'};
    if(value === undefined) sqlitePool.get.mockImplementation(()=>{throw new Error('/private/pool');});
    else sqlitePool.get.mockReturnValue(value);
    const result=await collectBackendDiagnostics({_dependencies:dependencies,collectSqlite:async()=>{}});
    expect(result).toMatchObject({classification:'unavailable',pool:{origin:'local',status:'unverified'}});
    expect(result.pool.total).toBeUndefined();
    expect(result.pool.idle).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});

describe('selected and aggregate diagnostic identities', () => {
  it('leaves absent SQLite machine identity not applicable without registration', async () => {
    const {dependencies,observation}=fixture();
    observation.config.storage={backend:'sqlite'}; observation.machineId=null;
    const result=await collectBackendDiagnostics({_dependencies:dependencies,collectSqlite:async()=>{}});
    expect(result).toMatchObject({classification:'healthy',identity:{status:'not-applicable'},project:{scope:'aggregate',status:'ready'}});
  });
  it('publishes selected admitted remote and local identities without paths', async () => {
    const {dependencies,observation}=fixture(); const id='a'.repeat(64);
    observation.mapContent=JSON.stringify({[id]:{canonical:'/diagnostic/project',aliases:[],remoteProjectId:machineId}});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/project'});
    expect(result).toMatchObject({project:{scope:'selected',status:'ready',projectId:machineId,localProjectId:id}});
    expect(JSON.stringify(result)).not.toContain('/diagnostic/project');
  });
  it('keeps unknown requested scope selected and unavailable without IDs', async () => {
    const {dependencies}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/missing'});
    expect(result).toMatchObject({classification:'unavailable',project:{scope:'selected',status:'unavailable'}});
    expect(dependencies.readMetrics).not.toHaveBeenCalled();
  });
});

it.each(['sqlite','postgresql'] as const)('rejects unsafe selected %s IDs before reading and without echoing them',async backend=>{
  const {dependencies,observation}=fixture();
  if(backend==='sqlite') observation.config.storage={backend:'sqlite'};
  const collectSqlite=vi.fn(async()=>{});
  const result=await collectBackendDiagnostics({_dependencies:dependencies,projectId:'/private/secret',collectSqlite});
  expect(result).toMatchObject({classification:'unavailable',project:{scope:'selected',status:'unavailable'}});
  expect(JSON.stringify(result)).not.toContain('/private/secret');
  expect(collectSqlite).not.toHaveBeenCalled();expect(dependencies.readMetrics).not.toHaveBeenCalled();
});
it('retains required PostgreSQL machine identity as unverified when absent',async()=>{
  const {dependencies,observation}=fixture();observation.machineId=null;
  const result=await collectBackendDiagnostics({_dependencies:dependencies});
  expect(result).toMatchObject({classification:'unavailable',identity:{status:'unverified'}});
});
it('reports a selected observed SQLite project hash without requiring machine registration',async()=>{
  const {dependencies,observation}=fixture();observation.config.storage={backend:'sqlite'};observation.machineId=null;
  const id='b'.repeat(64);
  const result=await collectBackendDiagnostics({_dependencies:dependencies,projectId:id,collectSqlite:async()=>{}});
  expect(result).toMatchObject({classification:'healthy',project:{scope:'selected',status:'ready',projectId:id,localProjectId:id},identity:{status:'not-applicable'}});
});
it('preserves selected scope without identifiers after stale publication and pre-aborted collection',async()=>{
  const {dependencies,observation}=fixture(); const id='a'.repeat(64);
  observation.mapContent=JSON.stringify({[id]:{canonical:'/diagnostic/project',aliases:[],remoteProjectId:machineId}});
  dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'b'});
  expect(await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/project'})).toMatchObject({classification:'stale-publication',project:{scope:'selected',status:'unverified'}});
  const controller=new AbortController();controller.abort();
  expect(await collectBackendDiagnostics({_dependencies:dependencies,projectId:machineId,signal:controller.signal})).toMatchObject({classification:'timeout',project:{scope:'selected',status:'unverified'}});
});


describe('independent borrowed daemon pool observation', () => {
  const pool = {configuredMax:8,total:4,idle:2,waiting:1,failed:true};
  it.each(['acquisition-stall','health-stall','acquisition-failure','health-failure'] as const)('retains authenticated pool counters during %s', async mode => {
    const {dependencies,runtime}=fixture();
    const getDiagnosticPool=vi.fn(()=>pool); const close=vi.fn();
    if (mode==='acquisition-stall') dependencies.createRuntime=vi.fn(()=>new Promise(()=>{}));
    if (mode==='health-stall') runtime.health=vi.fn(()=>new Promise(()=>{}));
    if (mode==='acquisition-failure') dependencies.createRuntime=vi.fn(()=>{throw new Error('private connection');});
    if (mode==='health-failure') runtime.health=vi.fn(async()=>{throw new Error('private connection');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10,
      storageFactory:{backend:'postgresql',getDiagnosticPool,close} as never});
    expect(result).toMatchObject({classification:mode.endsWith('stall')?'timeout':'unavailable',
      pool:{origin:'daemon',status:'ready',...pool}});
    expect(result.metrics).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
    expect(getDiagnosticPool).toHaveBeenCalledOnce();
    expect(getDiagnosticPool.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(dependencies.createRuntime).mock.invocationCallOrder[0]);
    expect(dependencies.observePublication).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });
  it.each(['changed','refused'] as const)('discards the borrowed pool when publication is %s at timeout', async mode => {
    const {dependencies,observation,runtime}=fixture();
    runtime.health=()=>new Promise(()=>{});
    dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockImplementation(()=>{
      if(mode==='refused') throw new BackendPublicationJournalError('unexpected-state','private authority');
      return {...observation,witness:'changed'};
    });
    const result=await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10,
      storageFactory:{backend:'postgresql',getDiagnosticPool:()=>pool} as never});
    expect(result).toMatchObject({classification:'stale-publication',publication:'unavailable',pool:{status:'unverified'}});
    expect(result.pool.total).toBeUndefined();
    expect(result.metrics).toBeUndefined();
  });
  it('does not inspect an incompatible factory pool', async()=>{
    const {dependencies}=fixture(); const getDiagnosticPool=vi.fn(()=>pool);
    const result=await collectBackendDiagnostics({_dependencies:dependencies,
      storageFactory:{backend:'sqlite',getDiagnosticPool} as never});
    expect(result).toMatchObject({classification:'stale-publication',pool:{status:'unverified'}});
    expect(getDiagnosticPool).not.toHaveBeenCalled();
  });
  it('does not retain a borrowed pool after ordinary failed-probe publication drift', async()=>{
    const {dependencies,observation,runtime}=fixture();
    runtime.health=async()=>{throw new Error('private connection');};
    dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'changed'});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,
      storageFactory:{backend:'postgresql',getDiagnosticPool:()=>pool} as never});
    expect(result).toMatchObject({classification:'stale-publication',pool:{status:'unverified'}});
    expect(result.pool.total).toBeUndefined();
  });
});

it.each(['absent','throws','invalid'] as const)('keeps unavailable borrowed telemetry honest when getter is %s', async mode=>{
  const {dependencies,runtime}=fixture();runtime.health=()=>new Promise(()=>{});
  const factory={backend:'postgresql', ...(mode==='absent'?{}:{getDiagnosticPool:()=>{
    if(mode==='throws') throw new Error('private pool');
    return {configuredMax:8,total:NaN,idle:0,waiting:0,failed:false};
  }})} as never;
  const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:factory,_deadlineMs:10});
  expect(result).toMatchObject({classification:'timeout',pool:{origin:'daemon',status:'unverified'}});
  expect(result.pool.total).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private');
});
