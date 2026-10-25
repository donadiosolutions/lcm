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
import { DatabaseSync } from 'node:sqlite';
import { collectEventStats } from '../../src/db/events-stats.js';
import { EventsDb } from '../../src/hooks/events-db.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { PostgreSqlStorageOperationError } from '../../src/storage/postgresql/errors.js';
import type { BackendDiagnosticDependencies, BackendDiagnosticObservation, BackendDiagnosticRuntime } from '../../src/storage/diagnostics.js';
import type { PostgreSqlRuntimeHealth } from '../../src/storage/postgresql/contracts.js';
import type { PostgreSqlDiagnosticMetrics } from '../../src/storage/postgresql/diagnostics.js';
import { createQueryStatisticsFamily } from '../../src/storage/postgresql/query-statistics.js';

const machineId = '01912345-1234-7123-8123-123456789abc';
const metrics: PostgreSqlDiagnosticMetrics = { projects:1,conversations:2,compactedConversations:1,messages:4,summaries:2,maxDepth:1,rawTokens:200,summaryTokens:100,ratio:2,promotedCount:1,redactionCounts:{builtIn:1,global:2,project:3,total:6},recallStats:{memoriesSurfaced:3,memoriesActedUpon:1,recallPrecision:1/3} };
const outbox = {captured:3,unprocessed:2,errors:0,lastCapture:null,deliveryPending:1,deliveryClaimed:0,deliveryRetry:0,deliveryReplicated:0,deliveryAcknowledged:0,deliveryAwaitingRemotePrune:0,deliveryQuarantined:0,oldestDeliveryAt:null,oldestPendingAt:null};
const ledger = {expected:[{id:'0001_a',sha256:'a'},{id:'0002_b',sha256:'b'}],rows:[{id:'0001_a',checksum_sha256:'a'},{id:'0002_b',checksum_sha256:'b'}]};
const queueRead = {capReached:false,claimed:'0',quarantined:'0',lagSeconds:null};
function fixture() {
  const config = parseDaemonConfig('{}');
  config.storage = {backend:'postgresql',postgresql:{url:'postgresql://secret:secret@secret.example/secret',caFile:'/secret/ca',migrationRole:'secret-role',poolMax:5,connectionTimeoutMs:10000,idleTimeoutMs:30000,statementTimeoutMs:60000}};
  const observation: BackendDiagnosticObservation = {config,witness:'a',machineId,mapContent:null};
  const health = {status:'healthy',backend:'postgresql',tls:true,serverMajorVersion:18,serverEncoding:'UTF8',timezone:'UTC',role:'secret-role',extensions:['pg_stat_statements','pg_trgm','pgcrypto','unaccent'].map(name => ({name,status:'current',installedVersion:'1.0',defaultVersion:'1.0'})),searchConfiguration:{ready:true}} as PostgreSqlRuntimeHealth;
  const runtime: BackendDiagnosticRuntime = {query:vi.fn(),health:vi.fn(async()=>health),poolDiagnostics:vi.fn(()=>({configuredMax:5,total:1,idle:1,waiting:0,failed:false})),close:vi.fn(async()=>{})};
  const dependencies: BackendDiagnosticDependencies = {observePublication:vi.fn(()=>observation),createRuntime:vi.fn(()=>runtime),verifySchema:vi.fn(async()=>({} as never)),readMetrics:vi.fn(async()=>metrics),readOutbox:vi.fn(async()=>outbox),readStatements:vi.fn(async()=>({family:createQueryStatisticsFamily('observed',1234),commit:vi.fn(()=>true)})),readMigrationHistory:vi.fn(async()=>ledger),readQueue:vi.fn(async()=>queueRead)};
  return {observation,runtime,dependencies,health};
}
describe('bounded authenticated probe', () => {
  it('returns only safe verified fields and closes its probe exactly once', async()=>{
    const {dependencies,runtime}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result).toMatchObject({classification:'healthy',schema:'ready',tls:'ready',pool:{origin:'diagnostic-probe',total:1},identity:{machineId},metrics,outbox:{status:'ready',captured:3},telemetry:{statements:{status:'observed',observedAt:1234,scope:'aggregate'}}});
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
    expect(result.telemetry.statements.status).toBe(code==='57014'?'timeout':'unavailable');
    expect(result.metrics).toBeUndefined();
    expect(dependencies.readStatements).not.toHaveBeenCalled();
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
  it('runs query statistics after outbox handling and commits only after the final witness',async()=>{
    const {dependencies}=fixture();
    let familySignal: AbortSignal | undefined;
    const commit=vi.fn(()=>{
      expect(familySignal?.aborted).toBe(false);
      return true;
    });
    dependencies.readStatements=vi.fn(async(_runtime,options)=>{
      familySignal=options.signal;
      return {family:createQueryStatisticsFamily('observed',5),commit};
    });
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.statements.status).toBe('observed');
    expect(dependencies.readOutbox.mock.invocationCallOrder[0]).toBeLessThan(dependencies.readStatements.mock.invocationCallOrder[0]);
    expect(dependencies.readStatements.mock.invocationCallOrder[0]).toBeLessThan(dependencies.observePublication.mock.invocationCallOrder[1]);
    expect(dependencies.observePublication.mock.invocationCallOrder[1]).toBeLessThan(commit.mock.invocationCallOrder[0]);
    expect(dependencies.readStatements).toHaveBeenCalledWith(runtimeLike(),expect.objectContaining({publicationWitness:'a',signal:expect.any(AbortSignal)}));
  });
  it('keeps a hanging statement family local to telemetry and clears its deadline',async()=>{
    vi.useFakeTimers();
    try {
      const {dependencies}=fixture();
      dependencies.readStatements=vi.fn(()=>new Promise(()=>{}));
      const work=collectBackendDiagnostics({_dependencies:dependencies});
      await vi.advanceTimersByTimeAsync(751);
      const result=await work;
      expect(result.classification).toBe('healthy');
      expect(result.telemetry.statements.status).toBe('timeout');
      expect(dependencies.observePublication).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('uses the remaining-time launch guard without starting statement probes',async()=>{
    const {dependencies}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:50});
    expect(result.classification).toBe('healthy');
    expect(result.telemetry.statements.status).toBe('timeout');
    expect(dependencies.readStatements).not.toHaveBeenCalled();
  });
  it('propagates parent cancellation to the child family and classifies a synchronous throw as timeout',async()=>{
    const {dependencies}=fixture();
    const controller=new AbortController();
    dependencies.readStatements=vi.fn((_runtime,options)=>{
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      throw new Error('PRIVATE ABORT');
    });
    const result=await collectBackendDiagnostics({_dependencies:dependencies,signal:controller.signal});
    expect(result.telemetry.statements.status).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('ignores a statement result that arrives after the child deadline',async()=>{
    vi.useFakeTimers();
    try {
      const {dependencies}=fixture();
      const commit=vi.fn(()=>true);
      let resolveFamily!: (value: {family:ReturnType<typeof createQueryStatisticsFamily>;commit:()=>boolean})=>void;
      dependencies.readStatements=vi.fn(()=>new Promise(resolve=>{resolveFamily=resolve;}));
      const work=collectBackendDiagnostics({_dependencies:dependencies});
      await vi.advanceTimersByTimeAsync(751);
      const result=await work;
      resolveFamily({family:createQueryStatisticsFamily('observed'),commit});
      await Promise.resolve();
      expect(result.telemetry.statements.status).toBe('timeout');
      expect(commit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('contains an unexpected statement collector failure without changing backend health',async()=>{
    const {dependencies}=fixture();
    dependencies.readStatements=vi.fn(async()=>{throw new Error('PRIVATE QUERY PLAN');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('healthy');
    expect(result.telemetry.statements.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not commit statement context when publication changes',async()=>{
    const {dependencies,observation}=fixture();
    const commit=vi.fn(()=>true);
    dependencies.readStatements=vi.fn(async()=>({family:createQueryStatisticsFamily('observed'),commit}));
    dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'changed'});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('stale-publication');
    expect(commit).not.toHaveBeenCalled();
    expect(result.telemetry.statements.status).toBe('unavailable');
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
    expect(await collectBackendDiagnostics({_dependencies:dependencies,projectId:machineId})).toMatchObject({classification:'unavailable',outbox:{status:'unverified'},telemetry:{statements:{status:'observed',scope:'aggregate'}}});
    expect(dependencies.readOutbox).not.toHaveBeenCalled();
    expect(dependencies.readStatements).toHaveBeenCalledOnce();
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

function runtimeLike() { return expect.objectContaining({query:expect.any(Function)}); }


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


import { performance as monotonicClock } from 'node:perf_hooks';
import { RUNTIME_HEALTH_ACTIONS, PROBE_MIN_REMAINING_MS } from '../../src/storage/runtime-health.js';

const statusesOf = (snapshot: Awaited<ReturnType<typeof collectBackendDiagnostics>>) => Object.values(snapshot.telemetry).map(family => family.status);
const sqliteFixture = () => { const parts = fixture(); parts.observation.config.storage = {backend:'sqlite'}; return parts; };
const typedFailure = (code: string) => new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},code,false);

describe('runtime health telemetry on a healthy PostgreSQL probe', () => {
  it('observes all five families and reads in the documented order', async () => {
    const {dependencies,runtime}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('healthy');
    expect(result.telemetry.pool).toMatchObject({status:'observed',health:'healthy',saturationRatio:0,omitted:[]});
    expect(result.telemetry.migration).toMatchObject({status:'observed',health:'healthy',historyStatus:'current',appliedCount:2,expectedCount:2});
    expect(result.telemetry.extensions).toMatchObject({status:'observed',health:'healthy',entries:[{name:'pg_stat_statements',status:'current',installedVersion:'1.0',defaultVersion:'1.0'},expect.anything(),expect.anything(),expect.anything()]});
    expect(result.telemetry.queue).toMatchObject({status:'observed',health:'healthy',inboxClaimed:0,inboxQuarantined:0});
    expect(result.telemetry.statements).toMatchObject({status:'observed',scope:'aggregate'});
    for (const family of Object.values(result.telemetry)) expect(Number.isSafeInteger((family as {observedAt:number}).observedAt)).toBe(true);
    const order = (fn: unknown) => vi.mocked(fn as () => unknown).mock.invocationCallOrder[0];
    expect(order(dependencies.readMigrationHistory)).toBeLessThan(order(dependencies.readMetrics));
    expect(order(dependencies.verifySchema)).toBeLessThan(order(dependencies.readQueue));
    expect(order(dependencies.readQueue)).toBeLessThan(order(dependencies.readOutbox));
    expect(order(dependencies.readOutbox)).toBeLessThan(order(dependencies.readStatements));
    expect(dependencies.readMigrationHistory).toHaveBeenCalledExactlyOnceWith(runtime,expect.any(AbortSignal));
    expect(dependencies.readQueue).toHaveBeenCalledExactlyOnceWith(runtime,expect.any(AbortSignal),undefined);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
  it('binds the admitted selected project for the server queue read', async () => {
    const {dependencies,observation}=fixture(); const id='a'.repeat(64);
    observation.mapContent=JSON.stringify({[id]:{canonical:'/diagnostic/project',aliases:[],remoteProjectId:machineId}});
    await collectBackendDiagnostics({_dependencies:dependencies,cwd:'/diagnostic/project'});
    expect(dependencies.readQueue).toHaveBeenCalledWith(expect.anything(),expect.any(AbortSignal),machineId);
  });
  it('captures the daemon pool before any await and degrades on saturation with waiters', async () => {
    const {dependencies}=fixture();
    const factory={backend:'postgresql',getDiagnosticPool:()=>({configuredMax:2,total:2,idle:0,waiting:1,failed:false})} as never;
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:factory});
    expect(result.telemetry.pool).toMatchObject({status:'observed',health:'degraded',saturationRatio:1,remediation:RUNTIME_HEALTH_ACTIONS.poolSaturated});
    expect(result.classification).toBe('degraded');
    expect(result.remediation).toBe('Run lcm doctor to recheck backend readiness.'.replace('lcm doctor','\u0060lcm doctor\u0060'));
  });
  it('marks an invalid pool relationship partial', async () => {
    const {dependencies,runtime}=fixture(); runtime.poolDiagnostics=()=>({configuredMax:0,total:0,idle:0,waiting:0,failed:false});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.pool).toMatchObject({status:'partial',health:'unavailable',omitted:[{field:'saturationRatio',reason:'invalid-input'}]});
    expect(result.classification).toBe('healthy');
  });
});

import { PostgreSqlRuntime } from '../../src/storage/postgresql/runtime.js';
import { renderBackendDiagnostics } from '../../src/storage/diagnostic-renderer.js';

describe('invalid pool counters at the real observation boundary', () => {
  const outOfRange={status:'partial',observedAt:expect.any(Number),health:'unavailable',omitted:[{field:'saturationRatio',reason:'out-of-range'}],remediation:RUNTIME_HEALTH_ACTIONS.unavailable};
  const unavailable={status:'unavailable',health:'unavailable',omitted:[{field:'saturationRatio',reason:'unavailable'}]};
  const invalidNumbers=[-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,2**53];
  /** The real PostgreSqlRuntime with only the underlying pg pool counters injected; health and close are stubbed. */
  function realRuntime(counts: Record<string, unknown>, poolMax = 5) {
    const {health}=fixture();
    const pgPool={totalCount:2,idleCount:1,waitingCount:0,on:()=>undefined,end:async()=>undefined,...counts};
    const runtime=new PostgreSqlRuntime({url:'postgresql://secret:secret@secret.example/secret',caFile:'/secret/ca',poolMax,connectionTimeoutMs:10000,idleTimeoutMs:30000,statementTimeoutMs:60000},{createPool:()=>pgPool as never,createClient:()=>({}) as never,buildConfig:()=>({})});
    vi.spyOn(runtime,'health').mockResolvedValue(health);
    vi.spyOn(runtime,'close').mockResolvedValue(undefined);
    return runtime;
  }
  const daemonFactory=(runtime: PostgreSqlRuntime)=>({backend:'postgresql',getDiagnosticPool:()=>runtime.poolDiagnostics()}) as never;
  const expectSanitizedPool=(result: Awaited<ReturnType<typeof collectBackendDiagnostics>>, origin: string)=>{
    expect(result.pool).toEqual({origin,status:'unverified'});
    expect(result.telemetry.pool).toEqual(outOfRange);
    const rendered=renderBackendDiagnostics(result);
    expect(rendered).toContain(`Pool: unverified; origin: ${origin}`);
    expect(rendered).toContain('Pool counts: configured max: unverified; total: unverified; idle: unverified; waiting: unverified; failed: unverified');
    expect(rendered).toContain('Telemetry pool: partial; health: unavailable; saturation ratio: unverified; omitted: saturationRatio=out-of-range');
    return rendered;
  };
  it.each(invalidNumbers)('daemon delegation: counter %j finalizes only the pool family as out-of-range', async bad => {
    const {dependencies,runtime}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:daemonFactory(realRuntime({idleCount:bad}))});
    expectSanitizedPool(result,'daemon');
    expect(result.classification).toBe('unavailable');
    expect(result.telemetry.migration).toMatchObject({status:'observed',health:'healthy',historyStatus:'current'});
    expect(result.telemetry.queue).toMatchObject({status:'observed',health:'healthy'});
    expect(result.telemetry.extensions).toMatchObject({status:'observed'});
    expect(runtime.poolDiagnostics).not.toHaveBeenCalled();
  });
  it.each(invalidNumbers)('probe collection: counter %j keeps migration, readiness and queue running', async bad => {
    const {dependencies}=fixture(); const probe=realRuntime({totalCount:bad});
    dependencies.createRuntime=vi.fn(()=>probe);
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expectSanitizedPool(result,'diagnostic-probe');
    expect(result.classification).toBe('unavailable');
    expect(result).toMatchObject({schema:'ready',metrics,outbox:{status:'ready'},project:{scope:'aggregate',status:'ready'}});
    expect(result.telemetry.migration).toMatchObject({status:'observed',health:'healthy',historyStatus:'current',appliedCount:2,expectedCount:2});
    expect(result.telemetry.queue).toMatchObject({status:'observed',health:'healthy',inboxClaimed:0,inboxQuarantined:0});
    expect(result.telemetry.extensions).toMatchObject({status:'observed',health:'healthy'});
    for (const read of [dependencies.readMigrationHistory,dependencies.readMetrics,dependencies.verifySchema,dependencies.readQueue,dependencies.readOutbox]) expect(read).toHaveBeenCalledTimes(1);
    expect(probe.close).toHaveBeenCalledTimes(1);
  });
  it('probe collection: a negative configured maximum is out of range', async () => {
    const {dependencies}=fixture(); dependencies.createRuntime=vi.fn(()=>realRuntime({},-4));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expectSanitizedPool(result,'diagnostic-probe');
    expect(dependencies.readQueue).toHaveBeenCalledTimes(1);
  });
  it('timeout DTO: keeps the authenticated out-of-range reason and nothing else from the pool', async () => {
    const {dependencies,runtime}=fixture(); runtime.health=()=>new Promise(()=>{});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:daemonFactory(realRuntime({waitingCount:-2})),_deadlineMs:10});
    expect(result.classification).toBe('timeout');
    expectSanitizedPool(result,'daemon');
    for (const family of [result.telemetry.migration,result.telemetry.extensions,result.telemetry.queue]) expect(family).toMatchObject({status:'timeout'});
  });
  it('never emits the rejected counter in JSON or rendered text', async () => {
    const {dependencies}=fixture(); const sentinel=-7919;
    const daemon=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:daemonFactory(realRuntime({totalCount:sentinel}))});
    dependencies.createRuntime=vi.fn(()=>realRuntime({idleCount:sentinel}));
    const probe=await collectBackendDiagnostics({_dependencies:dependencies});
    for (const [result,origin] of [[daemon,'daemon'],[probe,'diagnostic-probe']] as const) {
      const rendered=expectSanitizedPool(result,origin);
      for (const key of ['configuredMax','total','idle','waiting','failed','saturationRatio']) { expect(result.pool).not.toHaveProperty(key); expect(result.telemetry.pool).not.toHaveProperty(key); }
      expect(JSON.stringify(result)).not.toContain('7919');
      expect(rendered).not.toContain('7919');
    }
  });
  it.each([['missing',undefined],['non-numeric','private']] as const)('daemon delegation: a %s counter stays unavailable', async (_kind, value) => {
    const {dependencies}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:daemonFactory(realRuntime({totalCount:value}))});
    expect(result.pool).toEqual({origin:'daemon',status:'unverified'});
    expect(result.telemetry.pool).toMatchObject(unavailable);
    expect(result.telemetry.migration).toMatchObject({status:'observed'});
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([['missing',undefined],['non-numeric','private']] as const)('probe collection: a %s counter still fails the probe as unavailable', async (_kind, value) => {
    const {dependencies}=fixture(); dependencies.createRuntime=vi.fn(()=>realRuntime({idleCount:value}));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('unavailable');
    expect(result.pool).toEqual({origin:'diagnostic-probe',status:'unverified'});
    expect(result.telemetry.pool).toMatchObject(unavailable);
    expect(result.telemetry.extensions).toMatchObject({status:'observed'});
    expect(statusesOf(result).filter(status=>status==='unavailable')).toHaveLength(4);
    expect(dependencies.readMigrationHistory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('timeout DTO: a missing daemon counter stays unavailable', async () => {
    const {dependencies,runtime}=fixture(); runtime.health=()=>new Promise(()=>{});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:daemonFactory(realRuntime({idleCount:undefined})),_deadlineMs:10});
    expect(result.classification).toBe('timeout');
    expect(result.pool).toEqual({origin:'daemon',status:'unverified'});
    expect(result.telemetry.pool).toMatchObject(unavailable);
  });
});

describe('runtime health telemetry never overrides the existing classification', () => {
  it('folds a degraded family into a healthy classification only', async () => {
    const {dependencies}=fixture();
    dependencies.readMigrationHistory=vi.fn(async()=>({...ledger,rows:[ledger.rows[0]]}));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.migration).toMatchObject({status:'observed',health:'degraded',historyStatus:'behind',appliedCount:1,remediation:RUNTIME_HEALTH_ACTIONS.migrationBehind});
    expect(result.classification).toBe('degraded');
  });
  it('keeps unavailable when the outbox is not ready even if a family is degraded', async () => {
    const {dependencies}=fixture();
    dependencies.readMigrationHistory=vi.fn(async()=>({...ledger,rows:[]}));
    dependencies.readOutbox=async()=>({...outbox,scanErrors:1});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.migration).toMatchObject({health:'degraded',historyStatus:'behind',appliedCount:0});
    expect(result.classification).toBe('unavailable');
  });
  it('keeps unavailable and reports degraded extensions when the readiness check already failed', async () => {
    const {dependencies,health}=fixture();
    (health as {extensions:unknown}).extensions=[{name:'pg_stat_statements',status:'not-preloaded',installedVersion:'1.0',defaultVersion:'1.0'},...['pg_trgm','pgcrypto','unaccent'].map(name=>({name,status:'current',installedVersion:'1.0',defaultVersion:'1.0'}))];
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('unavailable');
    expect(result.telemetry.extensions).toMatchObject({status:'observed',health:'degraded',remediation:RUNTIME_HEALTH_ACTIONS.extensions});
  });
  it('degrades on an inbox quarantine', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=vi.fn(async()=>({...queueRead,quarantined:'2'}));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'observed',health:'degraded',inboxQuarantined:2,remediation:RUNTIME_HEALTH_ACTIONS.quarantine});
    expect(result.classification).toBe('degraded');
  });
  it('degrades on a ready local quarantine count', async () => {
    const {dependencies}=fixture(); dependencies.readOutbox=async()=>({...outbox,deliveryQuarantined:3});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({health:'degraded',remediation:RUNTIME_HEALTH_ACTIONS.quarantine});
    expect(result.classification).toBe('degraded');
  });
  it('derives local pending age from the raw outbox and degrades above 900 seconds', async () => {
    vi.spyOn(Date,'now').mockReturnValue(Date.UTC(2026,1,3,12,0,0));
    const {dependencies}=fixture(); dependencies.readOutbox=async()=>({...outbox,oldestPendingAt:'2026-02-03 11:00:00'});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'observed',health:'degraded',outboxOldestPendingAgeSeconds:3600,remediation:RUNTIME_HEALTH_ACTIONS.backlog});
    expect(result.outbox).not.toHaveProperty('oldestPendingAt');
    expect(JSON.stringify(result)).not.toContain('2026-02-03 11:00:00');
    expect(result.classification).toBe('degraded');
  });
  it.each([
    ['unread source', undefined, 'unavailable'],
    ['invalid timestamp', 'garbage', 'out-of-range'],
    ['future timestamp', '2099-01-01 00:00:00', 'out-of-range'],
  ] as const)('omits local pending age for an %s', async (_name, value, reason) => {
    const {dependencies}=fixture(); dependencies.readOutbox=async()=>({...outbox,oldestPendingAt:value});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable',omitted:expect.arrayContaining([{field:'outboxOldestPendingAgeSeconds',reason}])});
    expect(result.classification).toBe('healthy');
  });
  it('omits local age when the outbox scan is unavailable and keeps server observations', async () => {
    const {dependencies}=fixture(); dependencies.readOutbox=async()=>({...outbox,scanSkipped:1});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'partial',inboxClaimed:0,omitted:expect.arrayContaining([{field:'outboxOldestPendingAgeSeconds',reason:'unavailable'}])});
  });
  it('omits local age when a valid sidecar would otherwise mask an invalid sibling timestamp', async () => {
    vi.spyOn(Date,'now').mockReturnValue(Date.UTC(2026,1,3,12,0,0));
    const home=mkdtempSync(join(tmpdir(),'lcm-diagnostic-')); homes.push(home);
    const eventsHome=join(home,'.lcm','events'); mkdirSync(eventsHome,{recursive:true,mode:0o700});
    for (const [file,createdAt] of [['a-valid.db','2026-02-03 11:59:00'],['b-invalid.db','not-a-timestamp']] as const) {
      const path=join(eventsHome,file);
      const db=new EventsDb(path);
      db.insertEvent('s',{type:'decision',category:'decision',data:'d',priority:1},'PostToolUse');
      db.close();
      const raw=new DatabaseSync(path);
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("UPDATE events SET created_at = '"+createdAt+"', delivery_state = 'pending'");
      raw.close();
    }
    const {dependencies}=fixture(); dependencies.readOutbox=options=>collectEventStats(options);
    const result=await collectBackendDiagnostics({homeDir:home,_dependencies:dependencies});
    expect(result.outbox.status).toBe('ready');
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable',inboxClaimed:0,inboxQuarantined:0,omitted:expect.arrayContaining([{field:'outboxOldestPendingAgeSeconds',reason:'out-of-range'}])});
    expect(result.telemetry.queue).not.toHaveProperty('outboxOldestPendingAgeSeconds');
    expect(JSON.stringify(result)).not.toMatch(/not-a-timestamp|2026-02-03 11:59:00/);
  });
  it('keeps the selected remote scope server-only when no local binding exists', async () => {
    const {dependencies}=fixture();
    const result=await collectBackendDiagnostics({_dependencies:dependencies,projectId:machineId});
    expect(result.telemetry.queue).toMatchObject({status:'partial',inboxClaimed:0,inboxQuarantined:0,omitted:expect.arrayContaining([{field:'outboxOldestPendingAgeSeconds',reason:'unavailable'}])});
    expect(result.classification).toBe('unavailable');
    expect(dependencies.readQueue).toHaveBeenCalledWith(expect.anything(),expect.any(AbortSignal),machineId);
  });
});

describe('runtime health telemetry lifecycle', () => {
  it('derives pool and extensions before the health-status throw and fails the unrun families', async () => {
    const {dependencies,health}=fixture(); const error=typedFailure('42501');
    Object.assign(health,{status:'unavailable',error});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('permission-denied');
    expect(result.telemetry.pool).toMatchObject({status:'observed'});
    expect(result.telemetry.extensions).toMatchObject({status:'observed',health:'healthy'});
    expect(result.telemetry.migration).toMatchObject({status:'permission-denied',health:'unavailable'});
    expect(result.telemetry.queue).toMatchObject({status:'permission-denied',health:'unavailable'});
    expect(dependencies.readMigrationHistory).not.toHaveBeenCalled();
    expect(dependencies.readQueue).not.toHaveBeenCalled();
  });
  it.each([['42501','permission-denied'],['57014','timeout'],['08006','unavailable']] as const)('reports the classified failure %s for extensions when health() carries none', async (code, status) => {
    const {dependencies,health}=fixture();
    Object.assign(health,{status:'unavailable',error:typedFailure(code),extensions:undefined});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe(status);
    expect(result.telemetry.pool).toMatchObject({status:'observed'});
    expect(result.telemetry.extensions).toEqual({status,observedAt:expect.any(Number),health:'unavailable',entries:[],remediation:RUNTIME_HEALTH_ACTIONS.unavailable,
      omitted:['pg_stat_statements','pg_trgm','pgcrypto','unaccent'].map(field=>({field,reason:status}))});
  });
  it.each(['healthy','degraded'] as const)('mirrors a later classified failure in extensions when %s health() carries none', async healthStatus => {
    const {dependencies,health}=fixture();
    Object.assign(health,{status:healthStatus,extensions:undefined});
    dependencies.readMetrics=vi.fn(async()=>{throw typedFailure('42501');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('permission-denied');
    expect(result.telemetry.extensions).toMatchObject({status:'permission-denied',health:'unavailable',entries:[],remediation:RUNTIME_HEALTH_ACTIONS.unavailable});
    expect((result.telemetry.extensions as {omitted:unknown[]}).omitted).toHaveLength(4);
  });
  it('keeps extensions when reading the probe pool throws', async () => {
    const {dependencies,runtime}=fixture(); runtime.poolDiagnostics=()=>{throw new Error('private pool');};
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('unavailable');
    expect(result.telemetry.extensions).toMatchObject({status:'observed'});
    expect(statusesOf(result).filter(status=>status==='unavailable')).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([['42501','permission-denied'],['57014','timeout'],['08006','unavailable']] as const)('isolates a migration probe failure %s', async (code, status) => {
    const {dependencies}=fixture(); dependencies.readMigrationHistory=vi.fn(async()=>{throw typedFailure(code);});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.migration).toMatchObject({status,health:'unavailable',historyStatus:'unavailable'});
    expect(result.telemetry.queue).toMatchObject({status:'observed'});
    expect(result.classification).toBe('healthy');
    expect(JSON.stringify(result)).not.toContain(code);
  });
  it.each([['42501','permission-denied'],['57014','timeout'],['08006','unavailable']] as const)('isolates a queue probe failure %s next to local data', async (code, status) => {
    const {dependencies}=fixture(); dependencies.readQueue=vi.fn(async()=>{throw typedFailure(code);});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable'});
    expect((result.telemetry.queue as {omitted:{field:string;reason:string}[]}).omitted).toEqual([
      {field:'inboxClaimed',reason:status},{field:'inboxQuarantined',reason:status},{field:'replayLagSeconds',reason:status},{field:'outboxOldestPendingAgeSeconds',reason:'no-entry'}].sort((a,b)=>['outboxOldestPendingAgeSeconds','inboxClaimed','inboxQuarantined','replayLagSeconds'].indexOf(a.field)-['outboxOldestPendingAgeSeconds','inboxClaimed','inboxQuarantined','replayLagSeconds'].indexOf(b.field)));
    expect(result.classification).toBe('healthy');
  });
  it('reports a reached queue cap as partial without exact totals', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=vi.fn(async()=>({capReached:true,claimed:'4097',quarantined:'4097',lagSeconds:'9999'}));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable'});
    expect(result.telemetry.queue).not.toHaveProperty('inboxQuarantined');
    expect(JSON.stringify(result.telemetry.queue)).not.toContain('4097');
    expect(result.classification).toBe('healthy');
  });
  it('keeps migration drift visible when schema verification then fails', async () => {
    const {dependencies}=fixture();
    dependencies.readMigrationHistory=vi.fn(async()=>({...ledger,rows:[ledger.rows[0],{id:'0003_x',checksum_sha256:'x'}]}));
    dependencies.verifySchema=vi.fn(async()=>{throw typedFailure('08006');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('unavailable');
    expect(result.telemetry.migration).toMatchObject({health:'degraded',historyStatus:'drift'});
    expect(result.telemetry.queue).toMatchObject({status:'unavailable'});
    expect(dependencies.readQueue).not.toHaveBeenCalled();
  });
  it('does not read the queue when metrics admission fails', async () => {
    const {dependencies}=fixture(); dependencies.readMetrics=vi.fn(async()=>{throw typedFailure('57014');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('timeout');
    expect(result.telemetry.migration).toMatchObject({status:'observed'});
    expect(result.telemetry.queue).toMatchObject({status:'timeout'});
    expect(dependencies.readQueue).not.toHaveBeenCalled();
  });
  it('keeps usable inbox counts when the local scan then fails', async () => {
    const {dependencies}=fixture(); dependencies.readOutbox=vi.fn(async()=>{throw Object.assign(new Error('private path'),{code:'EACCES'});});
    dependencies.readQueue=vi.fn(async()=>({...queueRead,claimed:'3'}));
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('permission-denied');
    expect(result.telemetry.queue).toMatchObject({status:'partial',inboxClaimed:3,inboxQuarantined:0,omitted:expect.arrayContaining([{field:'outboxOldestPendingAgeSeconds',reason:'permission-denied'}])});
    expect(result.telemetry.migration).toMatchObject({status:'observed'});
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('reports every family as timeout when the caller cancels during the migration probe', async () => {
    const {dependencies}=fixture(); const controller=new AbortController();
    dependencies.readMigrationHistory=vi.fn(async()=>{controller.abort();throw new Error('private');});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,signal:controller.signal});
    expect(result.classification).toBe('timeout');
    expect(statusesOf(result)).toEqual(['timeout','timeout','timeout','timeout','timeout']);
    expect(dependencies.verifySchema).not.toHaveBeenCalled();
  });
  it('discards every telemetry family when publication changes', async () => {
    const {dependencies,observation}=fixture(); dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'b'});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('stale-publication');
    expect(statusesOf(result)).toEqual(['unavailable','unavailable','unavailable','unavailable','unavailable']);
    expect(JSON.stringify(result.telemetry)).not.toMatch(/historyStatus":"current|pg_trgm":|saturationRatio":0/);
    expect((result.telemetry.extensions as {entries:unknown[]}).entries).toEqual([]);
  });
});

describe('runtime health timeout snapshot', () => {
  it('retains only the authenticated pool at its capture time', async () => {
    vi.useFakeTimers({toFake:['Date']});
    try {
      vi.setSystemTime(1_000);
      const {dependencies,runtime}=fixture();
      runtime.health=()=>{vi.setSystemTime(5_000);return new Promise(()=>{});};
      const factory={backend:'postgresql',getDiagnosticPool:()=>({configuredMax:8,total:4,idle:2,waiting:1,failed:false})} as never;
      const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:factory,_deadlineMs:10});
      expect(result.classification).toBe('timeout');
      expect(result.telemetry.pool).toMatchObject({status:'observed',observedAt:1_000,saturationRatio:0.25});
      for (const family of [result.telemetry.migration,result.telemetry.extensions,result.telemetry.queue,result.telemetry.statements]) expect(family).toMatchObject({status:'timeout',observedAt:5_000});
    } finally { vi.useRealTimers(); }
  });
  it('reports every family as timeout without an authenticated pool', async () => {
    const {dependencies,runtime}=fixture(); runtime.health=()=>new Promise(()=>{});
    expect(statusesOf(await collectBackendDiagnostics({_dependencies:dependencies,_deadlineMs:10}))).toEqual(['timeout','timeout','timeout','timeout','timeout']);
  });
  it('retains an unverified borrowed pool as an unavailable family', async () => {
    const {dependencies,runtime}=fixture(); runtime.health=()=>new Promise(()=>{});
    const factory={backend:'postgresql',getDiagnosticPool:()=>undefined} as never;
    const result=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:factory,_deadlineMs:10});
    expect(result.telemetry.pool).toMatchObject({status:'unavailable'});
    expect(result.telemetry.queue).toMatchObject({status:'timeout'});
  });
});

describe('runtime health probe launch guard', () => {
  const clockFixture = (health: PostgreSqlRuntimeHealth) => {
    let now = 1_000;
    vi.spyOn(monotonicClock,'now').mockImplementation(()=>now);
    return {advance:(ms:number)=>{now+=ms;}};
  };
  it('launches both probes when exactly the minimum time remains', async () => {
    const {dependencies,runtime,health}=fixture(); const clock=clockFixture(health);
    runtime.health=async()=>{clock.advance(2000-PROBE_MIN_REMAINING_MS);return health;};
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(dependencies.readMigrationHistory).toHaveBeenCalledTimes(1);
    expect(dependencies.readQueue).toHaveBeenCalledTimes(1);
    expect(result.telemetry.migration).toMatchObject({status:'observed'});
  });
  it('skips both probes below the minimum and reports timeout without launching them', async () => {
    const {dependencies,runtime,health}=fixture(); const clock=clockFixture(health);
    runtime.health=async()=>{clock.advance(2000-PROBE_MIN_REMAINING_MS+1);return health;};
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(dependencies.readMigrationHistory).not.toHaveBeenCalled();
    expect(dependencies.readQueue).not.toHaveBeenCalled();
    expect(result.telemetry.migration).toMatchObject({status:'timeout',health:'unavailable'});
    expect(result.telemetry.queue).toMatchObject({status:'partial'});
    expect(result.classification).toBe('healthy');
  });
  it('skips only the queue probe when time runs short after the migration probe', async () => {
    const {dependencies,health}=fixture(); const clock=clockFixture(health);
    dependencies.readMetrics=vi.fn(async()=>{clock.advance(2000-PROBE_MIN_REMAINING_MS+1);return metrics;});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(dependencies.readMigrationHistory).toHaveBeenCalledTimes(1);
    expect(dependencies.readQueue).not.toHaveBeenCalled();
    expect(result.telemetry.migration).toMatchObject({status:'observed'});
    expect(result.telemetry.queue).toMatchObject({status:'partial',omitted:expect.arrayContaining([{field:'inboxClaimed',reason:'timeout'}])});
  });
});

describe('runtime health telemetry for other backends', () => {
  it.each(['normal','stalled','failing','published-change'] as const)('keeps five not-applicable SQLite families on the %s path', async path => {
    const {dependencies,observation}=sqliteFixture();
    if (path==='published-change') dependencies.observePublication=vi.fn().mockReturnValueOnce(observation).mockReturnValue({...observation,witness:'b'});
    const collectSqlite = path==='stalled' ? vi.fn(()=>new Promise<void>(()=>{})) : path==='failing' ? vi.fn(async()=>{throw new Error('private');}) : vi.fn(async()=>{});
    const result=await collectBackendDiagnostics({_dependencies:dependencies,collectSqlite,...(path==='stalled'?{_deadlineMs:10}:{})});
    expect(statusesOf(result)).toEqual(['not-applicable','not-applicable','not-applicable','not-applicable','not-applicable']);
    for (const family of Object.values(result.telemetry)) expect(family).not.toHaveProperty('health');
    expect(dependencies.readMigrationHistory).not.toHaveBeenCalled();
    expect(dependencies.readQueue).not.toHaveBeenCalled();
  });
  it('keeps SQLite not-applicable for early failure and pre-aborted snapshots', async () => {
    const {dependencies}=fixture(); const controller=new AbortController(); controller.abort();
    const mismatch=await collectBackendDiagnostics({_dependencies:dependencies,storageFactory:{backend:'sqlite'} as never});
    expect(mismatch.backend).toBe('sqlite');
    expect(statusesOf(mismatch)).toEqual(['not-applicable','not-applicable','not-applicable','not-applicable','not-applicable']);
    const {dependencies:sqliteDeps}=sqliteFixture();
    expect(statusesOf(await collectBackendDiagnostics({_dependencies:sqliteDeps,signal:controller.signal}))).toEqual(['not-applicable','not-applicable','not-applicable','not-applicable','not-applicable']);
    expect(statusesOf(backendDiagnosticFailure(new Error('x'),'sqlite'))).toEqual(['not-applicable','not-applicable','not-applicable','not-applicable','not-applicable']);
  });
  it('mirrors failures for an unknown backend and never reports it as not-applicable', () => {
    expect(statusesOf(backendDiagnosticFailure(new Error('x')))).toEqual(['unavailable','unavailable','unavailable','unavailable','unavailable']);
    expect(statusesOf(backendDiagnosticFailure(Object.assign(new Error('x'),{code:'EACCES'})))).toEqual(['permission-denied','permission-denied','permission-denied','permission-denied','unavailable']);
    expect(statusesOf(backendDiagnosticFailure(Object.assign(new Error('x'),{code:'DIAGNOSTIC_SQLITE_TIMEOUT'}),'postgresql'))).toEqual(['timeout','timeout','timeout','timeout','timeout']);
  });
});

describe('runtime health sanitization canaries', () => {
  const canaries = ['CANARY-638-"quote"\\\\n-ledger','CANARY-638-schema/path','CANARY-638-remediation sk-ant-638','CANARY-638-version','CANARY-638-checksum','CANARY-638-error','CANARY-638-timestamp'];
  const forms = (value: string): string[] => [value, JSON.stringify(value).slice(1,-1), encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')];
  it('never emits seeded values from any new source in JSON or rendered text', async () => {
    const {dependencies,health}=fixture();
    (health as {extensions:unknown}).extensions=['pg_stat_statements','pg_trgm','pgcrypto','unaccent'].map(name=>({name,status:'current',installedVersion:canaries[3],defaultVersion:canaries[3],installedSchema:canaries[1],remediation:canaries[2],available:true}));
    dependencies.readMigrationHistory=vi.fn(async()=>({...ledger,rows:[{id:canaries[0],checksum_sha256:canaries[4]},{id:'0002_b',checksum_sha256:'b'}]}));
    dependencies.readQueue=vi.fn(async()=>{throw new Error(canaries[5]);});
    dependencies.readOutbox=async()=>({...outbox,oldestPendingAt:canaries[6]});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    const { renderBackendDiagnostics } = await import('../../src/storage/diagnostic-renderer.js');
    const surfaces=[JSON.stringify(result),renderBackendDiagnostics(result)];
    for (const canary of canaries) for (const form of forms(canary)) for (const surface of surfaces) expect(surface).not.toContain(form);
    expect(result.telemetry.migration).toMatchObject({historyStatus:'drift'});
    expect(JSON.stringify(result.telemetry.extensions)).toContain('unrecognized');
  });
});

describe('verified local quarantine and cap sentinel establish a partial queue family', () => {
  const futureAge = '2999-01-01 00:00:00';
  const readQueueFor = (mode: string) => mode === 'cap'
    ? vi.fn(async()=>({capReached:true,claimed:'4097',quarantined:'4097',lagSeconds:'9999'}))
    : vi.fn(async()=>{throw typedFailure(({unavailable:'08006','permission-denied':'42501',timeout:'57014'} as Record<string,string>)[mode]!);});
  it.each(['unavailable','permission-denied','timeout','cap'] as const)('keeps a ready local quarantine count usable when the server read is %s', async mode => {
    const {dependencies}=fixture(); dependencies.readQueue=readQueueFor(mode);
    dependencies.readOutbox=async()=>({...outbox,deliveryQuarantined:2,oldestPendingAt:futureAge});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    const queue=result.telemetry.queue as {omitted:{field:string;reason:string}[]};
    expect(queue).toMatchObject({status:'partial',health:'degraded',remediation:RUNTIME_HEALTH_ACTIONS.quarantine});
    expect(queue.omitted).toContainEqual({field:'outboxOldestPendingAgeSeconds',reason:'out-of-range'});
    expect(queue.omitted).toContainEqual({field:'inboxQuarantined',reason:mode==='cap'?'limit-reached':mode});
    expect(queue).not.toHaveProperty('inboxQuarantined');
    expect(result.classification).toBe('degraded');
    const { renderBackendDiagnostics } = await import('../../src/storage/diagnostic-renderer.js');
    const text=renderBackendDiagnostics(result);
    expect(text).toContain('Telemetry queue: partial; health: degraded');
    expect(text).toContain('Telemetry queue action: '+RUNTIME_HEALTH_ACTIONS.quarantine);
  });
  it('treats a ready local zero as usable but not degraded', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=readQueueFor('unavailable');
    dependencies.readOutbox=async()=>({...outbox,deliveryQuarantined:0,oldestPendingAt:futureAge});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable',remediation:RUNTIME_HEALTH_ACTIONS.unavailable});
    expect(result.classification).toBe('healthy');
  });
  it('lets an unready outbox contribute no quarantine evidence', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=readQueueFor('unavailable');
    dependencies.readOutbox=async()=>({...outbox,scanErrors:1,deliveryQuarantined:2,oldestPendingAt:futureAge});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.telemetry.queue).toMatchObject({status:'unavailable',health:'unavailable',remediation:RUNTIME_HEALTH_ACTIONS.unavailable});
    expect(result.classification).toBe('unavailable');
  });
  it('reports a reached cap as partial for a selected project without a local binding', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=readQueueFor('cap');
    const result=await collectBackendDiagnostics({_dependencies:dependencies,projectId:machineId});
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable',omitted:[
      {field:'outboxOldestPendingAgeSeconds',reason:'unavailable'},{field:'inboxClaimed',reason:'limit-reached'},
      {field:'inboxQuarantined',reason:'limit-reached'},{field:'replayLagSeconds',reason:'limit-reached'}]});
    for (const field of ['inboxClaimed','inboxQuarantined','replayLagSeconds']) expect(result.telemetry.queue).not.toHaveProperty(field);
    expect(JSON.stringify(result.telemetry.queue)).not.toContain('4097');
    expect(dependencies.readOutbox).not.toHaveBeenCalled();
  });
  it('reports a reached cap as partial when the local read then fails', async () => {
    const {dependencies}=fixture(); dependencies.readQueue=readQueueFor('cap');
    dependencies.readOutbox=vi.fn(async()=>{throw Object.assign(new Error('private path'),{code:'EACCES'});});
    const result=await collectBackendDiagnostics({_dependencies:dependencies});
    expect(result.classification).toBe('permission-denied');
    expect(result.telemetry.queue).toMatchObject({status:'partial',health:'unavailable',omitted:expect.arrayContaining([
      {field:'outboxOldestPendingAgeSeconds',reason:'permission-denied'},{field:'inboxQuarantined',reason:'limit-reached'}])});
    expect(JSON.stringify(result)).not.toContain('4097');
  });
});
