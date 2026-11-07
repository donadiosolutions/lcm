import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/storage/postgresql/portable-source.js';
import * as codec from '../../src/storage/portable-record.js';
import { PortableIndex } from '../../src/storage/portable-index.js';
import { PortableTransferError } from '../../src/storage/portable-transfer.js';
import * as mapping from '../../src/storage/postgresql/portable-mapping.js';
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER, serializePortableRecord, type PortableDomain } from '../../src/storage/portable-record-stream.js';
import type { StorageIdentityContext } from '../../src/storage/contracts.js';
import { isPostgreSqlSnapshotTerminationError, PostgreSqlStorageOperationError } from '../../src/storage/postgresql/errors.js';

const projectId = '01990000-0000-7000-8000-000000000001';
const machineId = '01990000-0000-7000-8000-000000000002';
const identity = (): StorageIdentityContext => ({id:projectId, remoteProjectId:projectId,
  localProjectId:'a'.repeat(64), machineId, selectedPath:'/source', displayName:'source'} as StorageIdentityContext);
const settings = {url:'postgresql://runtime:secret@localhost/source', caFile:'/ca.pem',
  poolMax:2, connectionTimeoutMs:1000, idleTimeoutMs:1000, statementTimeoutMs:1000};

function harness() {
  const session = { identity:{sessionId:'snapshot-one', backendPid:123,projectId},
    query:vi.fn(async (_config:any, options:any) => {
      switch(options.operation) {
        case 'portableRegisteredIdentity': return {rows:[{admitted:true}]};
        case 'portableSourceWitness': return {rows:[{database_name:'source',database_oid:'123',server_address:'127.0.0.1',server_port:'5432'}]};
        case 'portableSnapshotState': return {rows:[{admitted:true,backend_pid:123,tls:true,isolation:'repeatable read',read_only:'on',captured_at:'2026-09-06T12:34:56.123456Z'}]};
        default: throw new Error('unexpected SQL '+options.operation);
      }
    }), close:vi.fn(async()=>{})};
  const runtime = {health:vi.fn(async()=>({status:'healthy',backend:'postgresql',tls:true,serverMajorVersion:18,serverEncoding:'UTF8'})),
    query:session.query, openReadOnlySnapshot:vi.fn(async()=>session), close:vi.fn(async()=>{})};
  const dependencies = {createRuntime:vi.fn(()=>runtime),verifyRuntimeSchema:vi.fn(async()=>({})), normalizePath:(path:string)=>path};
  return {session,runtime,dependencies};
}

describe('PostgreSQL portable source admission', () => {
  it('exposes the production source opener', () => {
    expect(adapter).toHaveProperty('createPostgreSqlPortableSource', expect.any(Function));
  });
  it('refuses an unregistered path before acquiring a snapshot', async()=>{
    const h=harness(); h.runtime.query.mockResolvedValue({rows:[{admitted:false}]} as never);
    await expect(adapter.createPostgreSqlPortableSource({settings, expectedOwner:'owner',expectedIdentity:identity()},h.dependencies as never)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('refuses missing authenticated identity before creating a runtime', async()=>{
    const h=harness();
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:{id:projectId} as never},h.dependencies as never)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
  });
  it('requires current TLS before schema checks or snapshot acquisition', async()=>{
    const h=harness(); h.runtime.health.mockResolvedValue({status:'healthy',backend:'postgresql',tls:false} as never);
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity()},h.dependencies as never)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.dependencies.verifyRuntimeSchema).not.toHaveBeenCalled();
    expect(h.runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('normalizes driver failures and preserves them across cleanup failure', async()=>{
    const h=harness(); h.dependencies.verifyRuntimeSchema.mockRejectedValue(new Error('password-canary'));
    h.runtime.close.mockRejectedValue(new Error('cleanup-canary'));
    const error=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity()},h.dependencies as never).catch((error:unknown)=>error);
    expect(error).toMatchObject({code:'source-unavailable'});
    expect(JSON.stringify(error)).not.toMatch(/canary/);
  });
  it('observes pre-aborted requests without acquiring a connection', async()=>{
    const h=harness(), controller=new AbortController();controller.abort();
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),signal:controller.signal},h.dependencies as never)).rejects.toMatchObject({code:'aborted'});
    expect(h.dependencies.createRuntime).not.toHaveBeenCalled();
  });
  it('attaches an already-sanitized storage cause but never a raw driver error', async()=>{
    const h=harness();
    const sanitizedCause=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true,
    );
    h.dependencies.verifyRuntimeSchema.mockRejectedValue(sanitizedCause);
    const error=await adapter.createPostgreSqlPortableSource(
      {settings,expectedOwner:'owner',expectedIdentity:identity()},h.dependencies as never,
    ).catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable'});
    expect((error as {cause?:unknown}).cause).toBe(sanitizedCause);

    const h2=harness();
    h2.dependencies.verifyRuntimeSchema.mockRejectedValue(new Error('raw driver secret'));
    const error2=await adapter.createPostgreSqlPortableSource(
      {settings,expectedOwner:'owner',expectedIdentity:identity()},h2.dependencies as never,
    ).catch((e:unknown)=>e);
    expect(error2).toMatchObject({code:'source-unavailable'});
    expect((error2 as {cause?:unknown}).cause).toBeUndefined();
    expect(JSON.stringify(error2)).not.toContain('raw driver secret');
  });
});


afterEach(()=>vi.restoreAllMocks());
const timestamp='2026-09-06T12:34:56.123456Z';
/** A header page whose sentinel says whether a row follows its last header. */
const headerPage=<H extends mapping.CanonicalHeader>(headers:H[],more=false):mapping.CanonicalHeaderPage<H>=>({headers,more});
/** Rewrites each header of a page, keeping its sentinel. */
const mapHeaders=<H extends mapping.CanonicalHeader>(page:mapping.CanonicalHeaderPage<H>,map:(header:H)=>H):mapping.CanonicalHeaderPage<H>=>({headers:page.headers.map(map),more:page.more});
function dataHarness(extra:Partial<Record<PortableDomain,Record<string,unknown>[]>>={}) {
  const data:Partial<Record<PortableDomain,Record<string,unknown>[]>>={
    machines:[{machine_id:machineId,identity_key:'machine-source'}],
    project:[{project_id:projectId}],
    'project-aliases':[{machine_id:machineId,machine_identity_key:'machine-source',path:'/source',normalized_path:'/source'}],
    ...extra,
  };
  const locator=(domain:PortableDomain,row:Record<string,unknown>)=>JSON.stringify(mapping.mappingForDomain(domain).keys.map(key=>String(row[key])));
  const ordered=new Map(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,[...(data[domain]??[])].sort((a,b)=>Buffer.from(locator(domain,a)).compare(Buffer.from(locator(domain,b))))]));
  const rows=(domain:PortableDomain)=>ordered.get(domain)!;
  const byLocator=new Map(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,new Map(rows(domain).map(row=>[locator(domain,row),row]))]));
  const positions=new Map(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,new Map(rows(domain).map((row,i)=>[locator(domain,row),i]))]));
  const list=vi.spyOn(mapping,'listCanonicalHeaders').mockImplementation(async(_db,_project,domain,after,limit)=>{
    const values=rows(domain); const start=after===null?0:positions.get(domain)!.get(after)!+1;
    return headerPage(values.slice(start,start+limit).map(row=>({locator:locator(domain,row),byteLength:'1000'})),start+limit<values.length);
  });
  const read=vi.spyOn(mapping,'readCanonicalRow').mockImplementation(async(_db,_project,domain,key)=>
    byLocator.get(domain)!.get(key)??null);
  const contentRows=vi.spyOn(mapping,'readCanonicalContentRows').mockImplementation(async(_db,_project,domain,locators)=>{
    const found=new Map<string,Record<string,unknown>>();
    for (const locator of locators) {
      const row=byLocator.get(domain)!.get(locator);
      if (row!==undefined) found.set(locator,row);
    }
    return found;
  });
  vi.spyOn(mapping,'listConversationMessageHeaders').mockImplementation(async(_db,_project,conversation,after,limit)=>{
    const values=(data.messages??[]).filter(row=>row.conversation_id===conversation&&(after===null||BigInt(String(row.seq))>BigInt(after)))
      .sort((a,b)=>BigInt(String(a.seq))<BigInt(String(b.seq))?-1:1);
    return headerPage(values.slice(0,limit).map(row=>({locator:locator('messages',row),byteLength:'1000',seq:String(row.seq)})),values.length>limit);
  });
  // Occupancy follows the live fixture data, which some tests extend after the harness exists.
  const occupancy=vi.spyOn(mapping,'readCanonicalDomainOccupancy').mockImplementation(async(_db,_project,domains)=>
    new Map(domains.map(domain=>[domain,(data[domain]?.length??0)>0])));
  return {...harness(),data,list,read,contentRows,occupancy};
}
const page=(domain:PortableDomain,afterOrdinal=0,includePredecessor=false)=>({domain,afterOrdinal,includePredecessor,maxRecords:500 as const,maxBytes:150994944 as const});
const open=(h:ReturnType<typeof harness>,expectedIdentity=identity())=>adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity},h.dependencies as never);

describe('PostgreSQL portable source ordering and lifetime',()=>{
  it('exports SQL-domain facts with all22 coverage and verifies its complete manifest',async()=>{
    const h=dataHarness();const source=await open(h);
    const stream=await createPortableRecordStream(source);
    expect(stream.describe().domains).toHaveLength(22);
    expect(stream.describe().source.capturedAt).toBe(timestamp);
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const batch=await stream.readBatch({domain,maxRecords:500,maxBytes:150994944});
      expect(batch.complete).toBe(true);
      expect((await stream.verify(batch.checkpoint)).authoritative).toBe(true);
    }
    await stream.close();
    expect(h.session.close).toHaveBeenCalledTimes(1);expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('assigns duplicate header occurrence by message closure independently of native ids',async()=>{
    const capture=async(reverse:boolean)=>{
      const ids=reverse?['99','11']:['11','99'];
      const conversations=ids.map(id=>({conversation_id:id,session_id:'duplicate',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}));
      const messages=ids.map((id,i)=>({message_id:String(i+300),conversation_id:id,seq:'9007199254740993',role:'user',content:i===0?'alpha':'omega',token_count:'9007199254740995',created_at:timestamp}));
      const h=dataHarness({conversations,messages});const source=await open(h);
      try {return (await source.readDomainPage(page('messages'))).records.map(record=>Buffer.from(serializePortableRecord(record)).toString());}
      finally {await source.close();vi.restoreAllMocks();}
    };
    const first=await capture(false),second=await capture(true);
    expect(first).toEqual(second);expect(first.join('')).toContain('9007199254740995');
  });
  it('retains identical conversation multiplicity and repeated orphan recall tuples',async()=>{
    const conversations=['1','2'].map(conversation_id=>({conversation_id,session_id:'same',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}));
    const recall=['1','2'].map(surfacing_id=>({surfacing_id,memory_id:'orphan',session_id:null,surfaced_at:timestamp}));
    const h=dataHarness({conversations,'recall-surfacings':recall}),source=await open(h);
    expect((await source.readDomainPage(page('conversations'))).records.map(r=>r.value.occurrenceOrdinal)).toEqual([{$integer:'0'},{$integer:'1'}]);
    expect((await source.readDomainPage(page('recall-surfacings'))).records.map(r=>r.value.occurrenceOrdinal)).toEqual([{$integer:'0'},{$integer:'1'}]);
    await source.close();
  });
  it('paginates more than500 records, returns predecessor and rejects tampered boundaries',async()=>{
    const h=dataHarness({'session-ingest':Array.from({length:501},(_,i)=>({ingest_key:String(i),session_id:`session-${String(i).padStart(4,'0')}`,message_count:'9007199254740993',completed_at:timestamp}))});
    const source=await open(h),stream=await createPortableRecordStream(source);
    const first=await stream.readBatch({domain:'session-ingest',maxRecords:500,maxBytes:150994944});
    expect(first.records).toHaveLength(500);expect(first.complete).toBe(false);
    expect((await stream.verify(first.checkpoint)).recordCount).toBe(500);
    const last=await source.readDomainPage(page('session-ingest',500,true));
    expect(last.records).toHaveLength(1);expect(last.predecessor?.ordinal).toBe(499);expect(last.complete).toBe(true);
    const desc=source.describeSource();
    expect(await source.verifySource({...desc,sourceIdentitySha256:'0'.repeat(64)})).toBe('changed');
    expect(await source.verifySource({...desc,contentSha256:'0'.repeat(64)})).toBe('changed');
    expect(await source.verifySource({...desc,boundary:{...first.checkpoint,prefixSha256:'0'.repeat(64)}})).toBe('changed');
    expect(await source.verifySource({...desc,boundary:{...first.checkpoint,nextOrdinal:502,recordCount:502}})).toBe('invalid');
    await stream.close();
  });
  it('revokes source authority on identity drift and closes independently failing resources once',async()=>{
    const h=dataHarness(),mutable=identity(),source=await open(h,mutable);
    (mutable as {selectedPath:string}).selectedPath='/changed';
    expect(()=>source.describeSource()).toThrow(expect.objectContaining({code:'source-changed'}));
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'source-changed'});
    h.session.close.mockRejectedValue(new Error('secret-close'));
    await expect(source.close()).rejects.toMatchObject({code:'source-unavailable'});
    await expect(source.close()).rejects.toMatchObject({code:'source-unavailable'});
    expect(h.runtime.close).toHaveBeenCalledTimes(1);expect(h.session.close).toHaveBeenCalledTimes(1);
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'closed'});
  });
  it('refuses oversized source metadata before fetching a payload',async()=>{
    const h=dataHarness();h.list.mockResolvedValueOnce(headerPage([{locator:'["1"]',byteLength:'150994945'}]));
    await expect(open(h)).rejects.toMatchObject({code:'record-unrepresentable'});
    expect(h.read).not.toHaveBeenCalled();expect(h.session.close).toHaveBeenCalledTimes(1);
  });
  it('fetches canonical headers in batches bounded by the shared portable batch size',async()=>{
    const h=dataHarness(),source=await open(h);
    expect(h.list.mock.calls.every(call=>call[4]===codec.PORTABLE_LIMITS.maxBatchRecords)).toBe(true);
    await source.close();
  });
  it('admits projected raw rows through144MiB before exact canonical encoding',async()=>{
    const h=dataHarness(),list=h.list.getMockImplementation()!;
    h.list.mockImplementation(async(...args)=>mapHeaders(await list(...args),header=>({...header,byteLength:'150994944'})));
    const source=await open(h);
    expect((await source.readDomainPage(page('project'))).records).toHaveLength(1);
    await source.close();
  });
  it('checks operation cancellation and rejects invalid cursor limits',async()=>{
    const h=dataHarness(),source=await open(h),controller=new AbortController();controller.abort();
    await expect(source.readDomainPage({...page('project'),signal:controller.signal})).rejects.toMatchObject({code:'aborted'});
    for(const afterOrdinal of [-1,-0,2,NaN]) await expect(source.readDomainPage(page('project',afterOrdinal))).rejects.toMatchObject({code:'invalid-limit'});
    await source.close();
  });
  it('refuses a replaced backend session even if caller source digest is unchanged',async()=>{
    const h=dataHarness(),source=await open(h),description=source.describeSource();
    h.session.identity.sessionId='replaced';
    await expect(source.verifySource(description)).rejects.toMatchObject({code:'source-changed'});
    await source.close();
  });
});


describe('PostgreSQL source failure boundaries',()=>{
  it('uses the default runtime and sanitizes invalid connection settings',async()=>{
    await expect(adapter.createPostgreSqlPortableSource({settings:{...settings,url:'invalid-url'},expectedOwner:'owner',expectedIdentity:identity()})).rejects.toMatchObject({code:'source-unavailable'});
  });
  it('requires the separate strict transfer readiness profile for a transfer-role source',async()=>{
    const h=dataHarness();
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),admission:'transfer'},h.dependencies as never)).rejects.toMatchObject({code:'source-invalid'});
    const verifyTransferSchema=vi.fn(async()=>({}));
    const source=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),admission:'transfer'},{...h.dependencies,verifyTransferSchema} as never);
    expect(verifyTransferSchema).toHaveBeenCalledTimes(2);expect(h.dependencies.verifyRuntimeSchema).not.toHaveBeenCalled();await source.close();
  });
  it.each(['runtime','transfer'] as const)('rechecks %s readiness on the snapshot session after it opens',async(admission)=>{
    const h=dataHarness(),verifyTransferSchema=vi.fn(async(..._args:unknown[])=>({}));
    const verify=(admission==='transfer'?verifyTransferSchema:h.dependencies.verifyRuntimeSchema) as typeof verifyTransferSchema;
    const source=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),admission},{...h.dependencies,verifyTransferSchema} as never);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]![0]).toBe(h.runtime);expect(verify.mock.calls[1]![0]).toBe(h.session);
    expect(verify.mock.calls[0]![1]).toMatchObject({expectedOwner:'owner'});expect(verify.mock.calls[1]![1]).toMatchObject({expectedOwner:'owner'});
    expect(verify.mock.invocationCallOrder[0]!).toBeLessThan(h.runtime.openReadOnlySnapshot.mock.invocationCallOrder[0]!);
    expect(h.runtime.openReadOnlySnapshot.mock.invocationCallOrder[0]!).toBeLessThan(verify.mock.invocationCallOrder[1]!);
    await source.close();
  });
  it.each(['runtime','transfer'] as const)('reports an in-snapshot %s readiness failure as unavailable and closes once',async(admission)=>{
    const h=dataHarness(),verifyTransferSchema=vi.fn(async(..._args:unknown[])=>({}));
    const verify=(admission==='transfer'?verifyTransferSchema:h.dependencies.verifyRuntimeSchema) as typeof verifyTransferSchema;
    verify.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('password-canary'));
    const error=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),admission},{...h.dependencies,verifyTransferSchema} as never).catch((error:unknown)=>error);
    expect(error).toMatchObject({code:'source-unavailable'});expect(JSON.stringify(error)).not.toMatch(/canary/);
    expect(verify).toHaveBeenCalledTimes(2);expect(verify.mock.calls[1]![0]).toBe(h.session);
    expect(h.session.close).toHaveBeenCalledTimes(1);expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['portableSourceWitness',{database_name:'source',database_oid:1,server_address:'localhost',server_port:'5432'}],
    ['portableSnapshotState',{admitted:true,backend_pid:123,tls:false,isolation:'repeatable read',read_only:'on',captured_at:timestamp}],
  ])('refuses invalid %s evidence from the actual session',async(operation,row)=>{
    const h=dataHarness(),original=h.session.query.getMockImplementation()!;
    h.session.query.mockImplementation((config,options)=>options.operation===operation?Promise.resolve({rows:[row]} as never):original(config,options));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});expect(h.session.close).toHaveBeenCalledTimes(1);
  });
  it('rejects snapshot project mismatch before reading snapshot data',async()=>{
    const h=dataHarness();h.session.identity.projectId='other';
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.read).not.toHaveBeenCalled();
  });
  it('refuses malformed size evidence and missing rows without emitting data',async()=>{
    const h=dataHarness();h.list.mockResolvedValueOnce(headerPage([{locator:'["1"]',byteLength:'-1'}]));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    h.contentRows.mockResolvedValue(new Map());
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses a canonical row missing from a conversation prepass read',async()=>{
    const h=dataHarness({conversations:[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:timestamp,created_at:timestamp,updated_at:timestamp}]});
    const original=h.contentRows.getMockImplementation()!;
    h.contentRows.mockImplementation(async(...args)=>args[2]==='conversations'?new Map():original(...args));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses a canonical row missing from a batched boundary read',async()=>{
    const h=dataHarness(),original=h.contentRows.getMockImplementation()!;
    // machines, project and project-aliases each take one build-pass read; the
    // fourth call is the first capture-boundary read.
    let call=0;
    h.contentRows.mockImplementation(async(...args)=>++call===4?new Map():original(...args));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.contentRows).toHaveBeenCalledTimes(4);
  });
  it('refuses a backend header page exceeding the row bound or repeating its cursor',async()=>{
    const h=dataHarness();h.list.mockResolvedValueOnce(headerPage(Array.from({length:501},()=>({locator:'["1"]',byteLength:'1'}))));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    h.data.conversations=[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}];
    h.list.mockResolvedValue(headerPage([{locator:'["1"]',byteLength:'1'}],true));
    h.contentRows.mockImplementation(async(_db,_project,domain)=>domain==='conversations'?new Map([['["1"]',h.data.conversations![0]]]):new Map());
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('hashes multiple messages in sequence and rejects a regressing closure cursor',async()=>{
    const conversations=[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}];
    const messages=['1','2'].map(seq=>({conversation_id:'1',message_id:seq,seq,role:'user',content:'content '+seq,token_count:'1',created_at:timestamp}));
    const h=dataHarness({conversations,messages}),source=await open(h);await source.close();
    vi.mocked(mapping.listConversationMessageHeaders).mockResolvedValue(headerPage([{locator:'["1"]',byteLength:'1',seq:'1'}],true));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('compares complete closures and rejects a forced digest collision',async()=>{
    const conversations=['1','2'].map(conversation_id=>({conversation_id,session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}));
    const messages=['1','2'].map(id=>({conversation_id:id,message_id:id,seq:'1',role:'user',content:'content '+id,token_count:'1',created_at:timestamp}));
    const h=dataHarness({conversations,messages});
    const original=PortableIndex.prototype.addConversation;
    vi.spyOn(PortableIndex.prototype,'addConversation').mockImplementation(function(input){original.call(this,{...input,closureSha256:'a'.repeat(64)});});
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses missing parents or missing finalized conversation authority',async()=>{
    const h=dataHarness({messages:[{conversation_id:'1',message_id:'1',seq:'1',role:'user',content:'hello',token_count:'1',created_at:timestamp}]});
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    vi.restoreAllMocks();
    const h2=dataHarness({conversations:[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}]});
    vi.spyOn(PortableIndex.prototype,'conversation').mockReturnValue(null);
    await expect(open(h2)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses an index missing a required prefix and translates bounded index failures',async()=>{
    const h=dataHarness();
    vi.spyOn(PortableIndex.prototype,'entries').mockReturnValue([]);
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    for(const [code,expected] of [['aborted','aborted'],['unsupported-capability','record-unrepresentable'],['source-failed','source-unavailable']] as const) {
      vi.mocked(PortableIndex.prototype.entries).mockImplementation(()=>{throw new PortableTransferError(code);});
      await expect(open(h)).rejects.toMatchObject({code:expected});
    }
  });
  it('detects snapshot capture-time replacement during a read',async()=>{
    const h=dataHarness(),source=await open(h),original=h.session.query.getMockImplementation()!;
    h.session.query.mockImplementation(async(config,options)=>{
      const result=await original(config,options);
      if(options.operation==='portableSnapshotState') result.rows[0].captured_at='2026-09-07T12:34:56.123456Z';
      return result;
    });
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'source-changed'});await source.close();
  });
  it('refuses an unadmitted identity before comparing the capture time, in one statement per check (#1869)',async()=>{
    const h=dataHarness(),source=await open(h),original=h.session.query.getMockImplementation()!;
    h.session.query.mockClear();
    h.session.query.mockImplementation(async(config,options)=>{
      const result=await original(config,options);
      if(options.operation==='portableSnapshotState') Object.assign(result.rows[0],{admitted:false,captured_at:'2026-09-07T12:34:56.123456Z'});
      return result;
    });
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'source-invalid'});
    expect(h.session.query.mock.calls.map(call=>call[1].operation)).toEqual(['portableSnapshotState']);
    await source.close();
  });
  it('refuses a snapshot authentication statement without exactly one row',async()=>{
    const h=dataHarness(),original=h.session.query.getMockImplementation()!;
    h.session.query.mockImplementation((config,options)=>options.operation==='portableSnapshotState'?Promise.resolve({rows:[]} as never):original(config,options));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses a domain occupancy that is not a boolean (#1869)',async()=>{
    const h=dataHarness();
    h.occupancy.mockResolvedValue(new Map(PORTABLE_RECORD_DOMAIN_ORDER.map(domain=>[domain,
      domain==='session-ingest'?'yes':['machines','project','project-aliases'].includes(domain)])) as never);
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.list.mock.calls.map(call=>call[2])).toEqual(expect.arrayContaining(['machines','project','project-aliases']));
  });
  it('skips header paging for every domain the occupancy statement proves empty (#1869)',async()=>{
    const h=dataHarness(),source=await open(h);
    expect(h.occupancy).toHaveBeenCalledTimes(1);
    expect(h.occupancy.mock.calls[0]![2]).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    expect(h.occupancy.mock.calls[0]![3]).toBe(false);
    expect([...new Set(h.list.mock.calls.map(call=>call[2]))]).toEqual(['machines','project','project-aliases']);
    await source.close();
  });
  it('refuses a missing predecessor or zero-progress metadata page',async()=>{
    const h=dataHarness(),source=await open(h);
    vi.spyOn(PortableIndex.prototype,'entries').mockReturnValue([]);
    await expect(source.readDomainPage(page('project',1,true))).rejects.toMatchObject({code:'source-invalid'});
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'record-unrepresentable'});
    await source.close();
  });
  it('keeps a payload within the aggregate byte budget and fails an oversized first record',async()=>{
    const h=dataHarness({'session-ingest':['1','2'].map(ingest_key=>({ingest_key,session_id:ingest_key,message_count:'1',completed_at:timestamp}))}),source=await open(h);
    // Fault-inject encoded lengths at the public serialization seam, avoiding a
    // multi-hundred-megabyte allocation while exercising aggregate admission.
    vi.spyOn(codec,'serializePortableRecord').mockReturnValue({byteLength:100_000_000} as Uint8Array);
    const batch=await source.readDomainPage(page('session-ingest'));expect(batch.records).toHaveLength(1);expect(batch.complete).toBe(false);
    vi.mocked(codec.serializePortableRecord).mockReturnValue({byteLength:151_000_000} as Uint8Array);
    await expect(source.readDomainPage(page('session-ingest'))).rejects.toMatchObject({code:'record-unrepresentable'});
    await source.close();
  });
  it('releases every resource when both index and runtime close fail',async()=>{
    const h=dataHarness(),source=await open(h),original=PortableIndex.prototype.close;
    vi.spyOn(PortableIndex.prototype,'close').mockImplementation(function(){original.call(this);throw new Error('index-secret');});
    h.runtime.close.mockRejectedValue(new Error('runtime-secret'));
    await expect(source.close()).rejects.toMatchObject({code:'source-unavailable'});
    expect(h.session.close).toHaveBeenCalledTimes(1);expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('tolerates a 25P03 (or connection-termination) session close failure, unlike an ordinary one',async()=>{
    const idleKill=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true,
    );
    const h=dataHarness(),source=await open(h);
    h.session.close.mockRejectedValue(idleKill);
    await expect(source.close()).resolves.toBeUndefined();
    expect(h.session.close).toHaveBeenCalledTimes(1);expect(h.runtime.close).toHaveBeenCalledTimes(1);

    const h2=dataHarness(),source2=await open(h2);
    const ordinaryFailure=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'23505',false,
    );
    h2.session.close.mockRejectedValue(ordinaryFailure);
    const error=await source2.close().catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable'});
    expect((error as {cause?:unknown}).cause).toBe(ordinaryFailure);
  });
  it('tolerates a live message-only torn connection but not a live generic not-queryable close failure',async()=>{
    // What a session.close() ROLLBACK actually rejects with, live, after an
    // idle-in-transaction FATAL: either a message-only torn connection
    // that survives normalization as retryable with no sqlState, or, if
    // undiagnosed, a generic "not queryable" rejection that never carries
    // a code and is not retryable. Only the first is tolerated.
    const tornConnection=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},null,true,
    );
    const h=dataHarness(),source=await open(h);
    h.session.close.mockRejectedValue(tornConnection);
    await expect(source.close()).resolves.toBeUndefined();

    const notQueryable=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},null,false,
    );
    const h2=dataHarness(),source2=await open(h2);
    h2.session.close.mockRejectedValue(notQueryable);
    const error=await source2.close().catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable'});
    expect((error as {cause?:unknown}).cause).toBe(notQueryable);
  });
  it.each([
    ['a normalized 25P03 idle-in-transaction kill',()=>new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true),true],
    ['a normalized 57P01 shutdown',()=>new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'57P01',true),true],
    ['a normalized message-only torn connection',()=>new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},null,true),true],
    ['a raw 25P03 driver error',()=>Object.assign(new Error('raw secret'),{code:'25P03'}),true],
    ['a raw torn-connection driver error',()=>new Error('Connection terminated unexpectedly'),true],
    ['a normalized 42501 permission-denied failure',()=>new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'42501',false),false],
    ['a normalized generic not-queryable failure',()=>new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},null,false),false],
    ['a raw unrelated driver error',()=>new Error('raw secret'),false],
  ])('marks a readDomainPage source-unavailable retryable only for genuine termination: %s',async(_name,makeFailure,retryable)=>{
    const h=dataHarness(),source=await open(h),failure=makeFailure();
    h.contentRows.mockRejectedValue(failure);
    const error=await source.readDomainPage(page('project')).catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable',retryable});
    expect((error as codec.PortableStreamError).retryable).toBe(isPostgreSqlSnapshotTerminationError(failure));
    expect(JSON.stringify(error)).not.toContain('raw secret');
    await source.close();
  });
  it('lets the generic stream retry a PostgreSQL termination and fail fast on a non-transient source failure',async()=>{
    const retry=dataHarness(),retrySource=await open(retry),retryStream=await createPortableRecordStream(retrySource);
    retry.contentRows.mockRejectedValue(new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true));
    const retryError=await retryStream.readBatch({domain:'project',maxRecords:1,maxBytes:150994944}).catch((e:unknown)=>e);
    expect(retryError).toMatchObject({code:'source-unavailable',retryable:true});

    const denied=dataHarness(),deniedSource=await open(denied),deniedStream=await createPortableRecordStream(deniedSource);
    denied.contentRows.mockRejectedValue(new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'42501',false));
    const deniedError=await deniedStream.readBatch({domain:'project',maxRecords:1,maxBytes:150994944}).catch((e:unknown)=>e);
    expect(deniedError).toMatchObject({code:'source-invalid',retryable:false});
  });
  it('drives the generic stream close-cause-forwarding true arm through the real PostgreSQL source, not a synthetic double',async()=>{
    // portable-record-stream.ts's own close() forwards error.cause only
    // when the caught error is instanceof PortableStreamError. The one
    // production source that ever throws that shape from close() is this
    // PostgreSQL source (via safeError attaching an already-sanitized
    // StorageOperationError as cause); every other unit fixture in the
    // stream's own test file throws a plain Error, which never reaches
    // that arm. Wrap the real source in the real generic stream and close
    // the stream (not the source directly) so the true arm executes for a
    // genuine reason, not a hand-built PortableStreamError.
    const h=dataHarness(),source=await open(h),stream=await createPortableRecordStream(source);
    const ordinaryFailure=new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'23505',false,
    );
    h.session.close.mockRejectedValue(ordinaryFailure);
    const error=await stream.close().catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable',retryable:true});
    expect((error as {cause?:unknown}).cause).toBe(ordinaryFailure);
  });
  it('still fails a close when index closure fails, even alongside a tolerated 25P03 session close',async()=>{
    const h=dataHarness(),source=await open(h),original=PortableIndex.prototype.close;
    vi.spyOn(PortableIndex.prototype,'close').mockImplementation(function(){original.call(this);throw new Error('index-secret');});
    h.session.close.mockRejectedValue(new PostgreSqlStorageOperationError(
      'STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true,
    ));
    const error=await source.close().catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'source-unavailable'});
    expect(JSON.stringify(error)).not.toContain('index-secret');
  });
});


describe('PostgreSQL source private scratch and authenticated prefix evidence',()=>{
  const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  function nextPrefix(previous:string,record:codec.PortableRecord):string {
    const bytes=serializePortableRecord(record),length=Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    return sha(Buffer.concat([Buffer.from(previous,'hex'),length,bytes]));
  }
  const rows=(count:number)=>Array.from({length:count},(_,i)=>({ingest_key:String(i),session_id:`s-${String(i).padStart(5,'0')}`,message_count:'1',completed_at:timestamp}));
  it('places and removes its private index in the supplied scratch directory',async()=>{
    const scratchParent=mkdtempSync(join(tmpdir(),'pg-source-scratch-'));
    const ambient=process.env.TMPDIR,h=dataHarness();
    let source:Awaited<ReturnType<typeof adapter.createPostgreSqlPortableSource>>|undefined;
    try {
      source=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),scratchParent},h.dependencies as never);
      expect(readdirSync(scratchParent)).toEqual([expect.stringMatching(/^lcm-portable-index-/)]);
      await source.close();source=undefined;
      expect(readdirSync(scratchParent)).toEqual([]);
      expect(process.env.TMPDIR).toBe(ambient);
    } finally {await source?.close();rmSync(scratchParent,{recursive:true,force:true});}
  });
  it('keeps SQL reads and prefix hashing linear while verifying every sequential batch',async()=>{
    const measure=async(count:number)=>{
      const h=dataHarness({'session-ingest':rows(count)}),hashes=vi.spyOn(codec,'sha256');
      const source=await open(h),description=source.describeSource();
      // Phase isolation: the index build and capture boundary already ran at open.
      const ingestReads=(mock:{mock:{calls:readonly (readonly unknown[])[]}})=>mock.mock.calls.filter(call=>call[2]==='session-ingest').length;
      const openBatches=ingestReads(h.contentRows);
      let pageReads=0,pageBatches=0;
      let prefix=sha(codec.canonicalJson(['lcm-portable-domain-v1',codec.PORTABLE_RECORD_SCHEMA_SHA256,'session-ingest',1]));
      try {
        for(let after=0;after<count;) {
          const singleBefore=ingestReads(h.read),batchesBefore=ingestReads(h.contentRows);
          const batch=await source.readDomainPage(page('session-ingest',after));
          pageReads+=ingestReads(h.read)-singleBefore;pageBatches+=ingestReads(h.contentRows)-batchesBefore;
          for(const record of batch.records) prefix=nextPrefix(prefix,record);
          after+=batch.records.length;
          const last=batch.records.at(-1)!;
          const boundary={domain:'session-ingest' as const,nextOrdinal:after,recordCount:after,prefixSha256:prefix,lastRecordSha256:last.recordSha256,lastRecordIdentitySha256:last.identitySha256};
          expect(await source.verifySource({...description,boundary})).toBe('unchanged');
        }
        const reads=ingestReads(h.read);
        // readDomainPage is batched like the index build pass and boundary
        // recomputation, so it makes no single-row reads and one batched read
        // per page. Only each non-terminal checkpoint check reads one row.
        expect(pageReads).toBe(0);
        expect(pageBatches).toBe(Math.ceil(count/codec.PORTABLE_LIMITS.maxBatchRecords));
        expect(reads).toBeLessThanOrEqual(Math.ceil(count/500));
        expect(hashes.mock.calls.length).toBeLessThanOrEqual(2*count+500);
        // #1388: the index build pass, the capture boundary, the page reads and
        // the completion recomputation each batch their row reads at
        // PORTABLE_LIMITS.maxBatchRecords locators per query, so the batched
        // call count stays O(count/500).
        const contentBatches=ingestReads(h.contentRows);
        expect(openBatches).toBe(2*Math.ceil(count/codec.PORTABLE_LIMITS.maxBatchRecords));
        expect(contentBatches).toBeLessThanOrEqual(4*Math.ceil(count/codec.PORTABLE_LIMITS.maxBatchRecords));
        return reads;
      } finally {await source.close();vi.restoreAllMocks();}
    };
    const first=await measure(1200),second=await measure(2400);
    expect(second-first).toBeLessThanOrEqual(5);
  },30000);
  it('bounds a batched boundary read by aggregate payload bytes, not just record count',async()=>{
    const rows2=['1','2'].map(ingest_key=>({ingest_key,session_id:ingest_key,message_count:'1',completed_at:timestamp}));
    const h=dataHarness({'session-ingest':rows2}),list=h.list.getMockImplementation()!;
    // Two records each well within the per-row 144MiB guard, but together
    // exceeding PORTABLE_LIMITS.maxBatchBytes: #1388's batching must not
    // fetch their content in a single round trip on the strength of
    // index.entries' own maxBytes bound alone, since that bound only limits
    // JSON-stringified index metadata, not the record payload this batch
    // reads. Before the aggregate-bytes chunking fix this issued exactly one
    // readCanonicalContentRows call for both locators.
    h.list.mockImplementation(async(...args)=>mapHeaders(await list(...(args as Parameters<typeof list>)),header=>({...header,byteLength:'90000000'})));
    const source=await open(h);
    // Two chunks for the index build pass plus two for the capture boundary.
    const calls=h.contentRows.mock.calls.filter(call=>call[2]==='session-ingest');
    expect(calls).toHaveLength(4);
    expect(calls.every(call=>call[3].length===1)).toBe(true);
    await source.close();
  });
  it('builds the index from one batched read per header page and no single-row reads',async()=>{
    const small=dataHarness({'session-ingest':rows(3)}),smallSource=await open(small);
    expect(small.read.mock.calls.filter(call=>call[2]!=='conversations')).toHaveLength(0);
    // One build-pass read plus one capture-boundary read for three small records.
    expect(small.contentRows.mock.calls.filter(call=>call[2]==='session-ingest').map(call=>call[3].length)).toEqual([3,3]);
    await smallSource.close();
  });
  it('walks byte-cut header pages exactly once in order while still asking for full pages (#1388)',async()=>{
    const h=dataHarness({'session-ingest':rows(5)}),list=h.list.getMockImplementation()!;
    // listCanonicalHeaders bounds a page by aggregate locator bytes in SQL, so
    // a page can be shorter than the record bound while rows remain. Emulate a
    // backend that cuts every page after two headers.
    h.list.mockImplementation(async(...args)=>{const page=await list(...(args as Parameters<typeof list>));return headerPage(page.headers.slice(0,2),page.more||page.headers.length>2);});
    const source=await open(h);
    const calls=h.list.mock.calls.filter(call=>call[2]==='session-ingest');
    expect(calls.every(call=>call[4]===codec.PORTABLE_LIMITS.maxBatchRecords)).toBe(true);
    // Each cursor is the last locator of the previous short page; the last
    // page's sentinel ends the walk without an empty page (#1869).
    expect(calls.map(call=>call[3])).toEqual([null,'["1"]','["3"]']);
    const build=h.contentRows.mock.calls.filter(call=>call[2]==='session-ingest').slice(0,3).map(call=>call[3]);
    expect(build).toEqual([['["0"]','["1"]'],['["2"]','["3"]'],['["4"]']]);
    const batch=await source.readDomainPage(page('session-ingest'));
    expect(batch.complete).toBe(true);
    expect(batch.records.map(record=>record.value.sessionId)).toEqual(rows(5).map(row=>row.session_id));
    await source.close();
  });
  it('splits a build-pass header page whose rows together exceed the batch budget',async()=>{
    const rows2=['1','2'].map(ingest_key=>({ingest_key,session_id:ingest_key,message_count:'1',completed_at:timestamp}));
    const big=dataHarness({'session-ingest':rows2}),list=big.list.getMockImplementation()!;
    big.list.mockImplementation(async(...args)=>mapHeaders(await list(...(args as Parameters<typeof list>)),header=>({...header,byteLength:'90000000'})));
    const bigSource=await open(big);
    // Each row fits the batch budget alone but the pair does not: two build-pass
    // chunks, each finished before the next read, in header order.
    const build=big.contentRows.mock.calls.filter(call=>call[2]==='session-ingest').slice(0,2).map(call=>call[3]);
    expect(build).toEqual([['["1"]'],['["2"]']]);
    await bigSource.close();
  });
  it('refuses a canonical row missing from a batched build-pass read before any boundary read',async()=>{
    const h=dataHarness();
    h.contentRows.mockResolvedValueOnce(new Map());
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    expect(h.contentRows).toHaveBeenCalledTimes(1);
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });
  it('passes the caller signal to build-pass reads and stops before the next chunk once aborted',async()=>{
    const rows2=['1','2'].map(ingest_key=>({ingest_key,session_id:ingest_key,message_count:'1',completed_at:timestamp}));
    const h=dataHarness({'session-ingest':rows2}),list=h.list.getMockImplementation()!,controller=new AbortController();
    h.list.mockImplementation(async(...args)=>mapHeaders(await list(...(args as Parameters<typeof list>)),header=>({...header,byteLength:'90000000'})));
    const original=h.contentRows.getMockImplementation()!;
    h.contentRows.mockImplementation(async(...args)=>{
      const found=await original(...args);
      if (args[2]==='session-ingest') controller.abort();
      return found;
    });
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),signal:controller.signal},h.dependencies as never))
      .rejects.toMatchObject({code:'aborted'});
    const ingest=h.contentRows.mock.calls.filter(call=>call[2]==='session-ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0][4]).toBe(controller.signal);
  });
  it('fails closed when a batched chunk entry lacks its captured byte length',async()=>{
    const h=dataHarness({'session-ingest':['1'].map(ingest_key=>({ingest_key,session_id:ingest_key,message_count:'1',completed_at:timestamp}))});
    const original=PortableIndex.prototype.entries;
    vi.spyOn(PortableIndex.prototype,'entries').mockImplementation(function(this:PortableIndex,domain,options){
      const result=original.call(this,domain,options);
      // Strip the captured byte lengths but keep every locator valid: the
      // fail-closed chunk guard must fire before any content read, so this
      // pins that guard rather than the pre-existing missing-row guard the
      // previous fake-locator injection reached instead.
      return domain==='session-ingest' ? result.map(entry=>({...entry,byteLength:undefined})) : result;
    });
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('validates zero and arbitrary resumed prefixes without accepting forged evidence',async()=>{
    const h=dataHarness({'session-ingest':rows(2)}),source=await open(h),description=source.describeSource();
    const first=(await source.readDomainPage(page('session-ingest'))).records[0];
    const initial=sha(codec.canonicalJson(['lcm-portable-domain-v1',codec.PORTABLE_RECORD_SCHEMA_SHA256,'session-ingest',1]));
    const zero={domain:'session-ingest' as const,nextOrdinal:0,recordCount:0,prefixSha256:initial,lastRecordSha256:null,lastRecordIdentitySha256:null};
    expect(await source.verifySource({...description,boundary:zero})).toBe('unchanged');
    const resumed={...zero,nextOrdinal:1,recordCount:1,prefixSha256:nextPrefix(initial,first),lastRecordSha256:first.recordSha256,lastRecordIdentitySha256:first.identitySha256};
    expect(await source.verifySource({...description,boundary:resumed})).toBe('unchanged');
    expect(await source.verifySource({...description,boundary:{...resumed,prefixSha256:'a'.repeat(64)}})).toBe('changed');
    await source.close();
  });
  it('fails closed when private prefix evidence is unavailable',async()=>{
    const h=dataHarness(),source=await open(h);
    vi.spyOn(PortableIndex.prototype,'getScope').mockReturnValue(null);
    await expect(source.readDomainPage(page('project'))).rejects.toMatchObject({code:'source-invalid'});
    await source.close();
  });
  it('recomputes completion rather than trusting a corrupted cached terminal prefix',async()=>{
    const h=dataHarness({'session-ingest':rows(2)}),source=await open(h),description=source.describeSource();
    const last=(await source.readDomainPage(page('session-ingest'))).records.at(-1)!;
    const original=PortableIndex.prototype.getScope,forged='a'.repeat(64);
    vi.spyOn(PortableIndex.prototype,'getScope').mockImplementation(function(namespace,key){
      const actual=JSON.parse(original.call(this,namespace,key)!);
      return JSON.stringify({...actual,prefix:forged});
    });
    expect(await source.verifySource({...description,boundary:{domain:'session-ingest',nextOrdinal:2,recordCount:2,prefixSha256:forged,lastRecordSha256:last.recordSha256,lastRecordIdentitySha256:last.identitySha256}})).toBe('changed');
    await source.close();
  });
  it('refuses same-length record mutations returned by the held snapshot',async()=>{
    const h=dataHarness({'session-ingest':rows(2)}),source=await open(h);
    h.data['session-ingest']![0].message_count='2';
    await expect(source.readDomainPage(page('session-ingest'))).rejects.toMatchObject({code:'source-changed'});
    await source.close();
  });
  it('rescans actual interior records at completion after building cached prefix evidence',async()=>{
    const h=dataHarness({'session-ingest':rows(2)}),source=await open(h),description=source.describeSource();
    const batch=await source.readDomainPage(page('session-ingest'));
    let prefix=sha(codec.canonicalJson(['lcm-portable-domain-v1',codec.PORTABLE_RECORD_SCHEMA_SHA256,'session-ingest',1]));
    for(const record of batch.records) prefix=nextPrefix(prefix,record);
    const last=batch.records.at(-1)!;
    h.data['session-ingest']![0].message_count='2';
    await expect(source.verifySource({...description,boundary:{domain:'session-ingest',nextOrdinal:2,recordCount:2,prefixSha256:prefix,lastRecordSha256:last.recordSha256,lastRecordIdentitySha256:last.identitySha256}})).rejects.toMatchObject({code:'source-changed'});
    await source.close();
  });
  it('rechecks the source signal before each completion boundary chunk when verifySource has no request signal',async()=>{
    const h=dataHarness({'session-ingest':rows(2)}),list=h.list.getMockImplementation()!,controller=new AbortController();
    h.list.mockImplementation(async(...args)=>mapHeaders(await list(...(args as Parameters<typeof list>)),header=>({...header,byteLength:'90000000'})));
    const source=await adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),signal:controller.signal},h.dependencies as never);
    const description=source.describeSource(),batch=await source.readDomainPage(page('session-ingest'));
    let prefix=sha(codec.canonicalJson(['lcm-portable-domain-v1',codec.PORTABLE_RECORD_SCHEMA_SHA256,'session-ingest',1]));
    for(const record of batch.records) prefix=nextPrefix(prefix,record);
    const last=batch.records.at(-1)!,original=h.contentRows.getMockImplementation()!;
    const ingestCalls=()=>h.contentRows.mock.calls.filter(call=>call[2]==='session-ingest');
    // Opening built the index and captured the boundary (two chunks each), and
    // the page read added one chunk per record: baseline the operation below.
    const baseline=ingestCalls().length;
    expect(baseline).toBe(6);
    // The private index shares the source signal and rejects every lookup once
    // it is aborted, which would stop the digest loop before the next chunk
    // regardless of boundaryAt's own checks. Replay scope evidence recorded
    // before the abort so only boundaryAt's per-chunk abort check is observed.
    const getScope=PortableIndex.prototype.getScope,recorded=new Map<string,string|null>();
    vi.spyOn(PortableIndex.prototype,'getScope').mockImplementation(function(this:PortableIndex,namespace,key){
      if (controller.signal.aborted) return recorded.get(namespace+'|'+key) as string|null;
      for (const ordinal of ['1','2']) recorded.set(namespace+'|'+ordinal,getScope.call(this,namespace,ordinal));
      return getScope.call(this,namespace,key);
    });
    h.contentRows.mockImplementation(async(...args)=>{
      const found=await original(...args);
      if (args[2]==='session-ingest') controller.abort();
      return found;
    });
    // The two records exceed one batch budget, so the completion scan needs two
    // chunks. Aborting the source after the first must stop the scan before
    // the second read even though no request signal was supplied.
    await expect(source.verifySource({...description,boundary:{domain:'session-ingest',nextOrdinal:2,recordCount:2,prefixSha256:prefix,lastRecordSha256:last.recordSha256,lastRecordIdentitySha256:last.identitySha256}})).rejects.toMatchObject({code:'aborted'});
    expect(ingestCalls()).toHaveLength(baseline+1);
    await source.close();
  });
});


describe('PostgreSQL source batched closure and page reads (#1470, #1489)',()=>{
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
  const conversation=(id:string,session='s')=>({conversation_id:id,session_id:session,title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp});
  const message=(conversationId:string,id:string,seq:number,content='content '+seq)=>({conversation_id:conversationId,message_id:id,seq:String(seq),role:'user',content,token_count:'1',created_at:timestamp});
  const token=(seq:number,content='content '+seq)=>codec.canonicalJson([{$integer:String(seq)},'user',content,{$integer:'1'},timestamp]);
  const closureSha=(tokens:string[])=>sha('["lcm-portable-conversation-closure-v1",{"bootstrappedAt":null,"createdAt":"'+timestamp+'","messages":['+tokens.join(',')+'],"sessionId":"s","title":null,"updatedAt":"'+timestamp+'"}]');
  const ingest=(count:number)=>Array.from({length:count},(_,i)=>({ingest_key:String(i),session_id:'s-'+String(i).padStart(5,'0'),message_count:'1',completed_at:timestamp}));
  const closures=()=>{
    const added:string[]=[],original=PortableIndex.prototype.addConversation;
    vi.spyOn(PortableIndex.prototype,'addConversation').mockImplementation(function(this:PortableIndex,input){added.push(input.closureSha256);original.call(this,input);});
    return added;
  };
  const headerCalls=()=>vi.mocked(mapping.listConversationMessageHeaders).mock.calls;
  const messageBytes=(bytes:(conversationId:string)=>string)=>{
    const base=vi.mocked(mapping.listConversationMessageHeaders).getMockImplementation()!;
    vi.mocked(mapping.listConversationMessageHeaders).mockImplementation(async(...args)=>
      mapHeaders(await base(...args),header=>({...header,byteLength:bytes(args[2])})));
  };
  const batches=(h:ReturnType<typeof dataHarness>,domain:PortableDomain)=>h.contentRows.mock.calls.filter(call=>call[2]===domain);
  const ingestBytes=(h:ReturnType<typeof dataHarness>,bytes:string)=>{
    const list=h.list.getMockImplementation()!;
    h.list.mockImplementation(async(...args)=>mapHeaders(await list(...(args as Parameters<typeof list>)),header=>args[2]==='session-ingest'?{...header,byteLength:bytes}:header));
  };

  it('budgets rows plus their locator copies on the build pass, the capture boundary and the page read (#1489)',async()=>{
    // Two rows whose projected bytes sum to exactly the batch budget fit in one
    // chunk only if the two locator copies per row are ignored.
    const h=dataHarness({'session-ingest':ingest(2)});ingestBytes(h,String(codec.PORTABLE_LIMITS.maxBatchBytes/2));
    const source=await open(h);
    expect(batches(h,'session-ingest').map(call=>call[3])).toEqual([['["0"]'],['["1"]'],['["0"]'],['["1"]']]);
    expect((await source.readDomainPage(page('session-ingest'))).records).toHaveLength(2);
    expect(batches(h,'session-ingest').slice(4).map(call=>call[3])).toEqual([['["0"]'],['["1"]']]);
    await source.close();
  });
  it('keeps a lone row admitted at the per-row limit in a single chunk of its own (#1489)',async()=>{
    const h=dataHarness({'session-ingest':ingest(1)});ingestBytes(h,String(codec.PORTABLE_LIMITS.maxBatchBytes));
    const source=await open(h);
    expect(batches(h,'session-ingest').map(call=>call[3])).toEqual([['["0"]'],['["0"]']]);
    expect((await source.readDomainPage(page('session-ingest'))).records).toHaveLength(1);
    await source.close();
  });
  it('reads a domain page with one batched read per page and no single-row reads (#1470)',async()=>{
    const h=dataHarness({'session-ingest':ingest(1200)}),source=await open(h);
    h.read.mockClear();h.contentRows.mockClear();
    const first=await source.readDomainPage(page('session-ingest'));
    expect(first.records).toHaveLength(500);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.contentRows.mock.calls.map(call=>[call[2],call[3].length])).toEqual([['session-ingest',500]]);
    const second=await source.readDomainPage(page('session-ingest',500,true));
    expect(second.records).toHaveLength(500);
    // Only the predecessor is a single-row read.
    expect(h.read.mock.calls.map(call=>call[2])).toEqual(['session-ingest']);
    expect(h.contentRows).toHaveBeenCalledTimes(2);
    await source.close();
  });
  it('keeps the predecessor read as a retryable single-row read',async()=>{
    const h=dataHarness({'session-ingest':ingest(2)}),source=await open(h);
    h.read.mockRejectedValue(new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'transaction',operation:'snapshot',projectId},'25P03',true));
    await expect(source.readDomainPage(page('session-ingest',1,true))).rejects.toMatchObject({code:'source-unavailable',retryable:true});
    await source.close();
  });
  it('refuses a predecessor row missing from its single-row read',async()=>{
    const h=dataHarness({'session-ingest':ingest(2)}),source=await open(h);
    h.read.mockResolvedValue(null);
    await expect(source.readDomainPage(page('session-ingest',1,true))).rejects.toMatchObject({code:'source-invalid'});
    await source.close();
  });
  it('walks a closure of 501 messages in header pages and batched reads with a seq-ordered cursor',async()=>{
    const count=501,messages=Array.from({length:count},(_,i)=>message('1',String(10000-i),i+1));
    const h=dataHarness({conversations:[conversation('1')],messages}),added=closures();
    const source=await open(h);
    // ceil(501/500) pages, the last ended by its sentinel; the cursor is the last seq.
    expect(headerCalls().map(call=>[call[3],call[4]])).toEqual([[null,500],['500',500]]);
    expect(h.read.mock.calls.filter(call=>call[2]==='messages')).toHaveLength(0);
    expect(batches(h,'messages').slice(0,2).map(call=>call[3].length)).toEqual([500,1]);
    expect(added).toEqual([closureSha(messages.map((_,i)=>token(i+1)))]);
    await source.close();
  });
  it('yields the same closure whatever the page and chunk boundaries (#1470)',async()=>{
    const messages=[1,2,3].map(seq=>message('1',String(seq),seq));
    const expected=closureSha([1,2,3].map(seq=>token(seq)));
    for(const bytes of ['1000','80000000']) {
      const h=dataHarness({conversations:[conversation('1')],messages}),added=closures();messageBytes(()=>bytes);
      const source=await open(h);
      expect(added).toEqual([expected]);
      expect(batches(h,'messages')[0]![3]).toHaveLength(bytes==='1000'?3:1);
      await source.close();vi.restoreAllMocks();
    }
  });
  it('splits one message header page into byte-bounded chunks, one batched read each',async()=>{
    const h=dataHarness({conversations:[conversation('1')],messages:[1,2,3].map(seq=>message('1',String(seq),seq))});
    messageBytes(()=>'80000000');
    const source=await open(h);
    expect(batches(h,'messages').slice(0,3).map(call=>call[3])).toEqual([['["1"]'],['["2"]'],['["3"]']]);
    await source.close();
  });
  it('compares identical closures whose messages fall on different chunk boundaries (#1470)',async()=>{
    const messages=[...[1,2,3].map(seq=>message('1',String(seq),seq)),...[1,2,3].map(seq=>message('2',String(seq+10),seq))];
    const h=dataHarness({conversations:[conversation('1'),conversation('2')],messages}),added=closures();
    messageBytes(id=>id==='1'?'1000':'80000000');
    const source=await open(h);
    const expected=closureSha([1,2,3].map(seq=>token(seq)));
    expect(added).toEqual([expected,expected]);
    // Two prepass walks and two finalize walks, each one page ended by its sentinel.
    expect(headerCalls()).toHaveLength(4);
    expect(batches(h,'messages').slice(0,8).map(call=>call[3].length)).toEqual([3,1,1,1,3,1,1,1]);
    await source.close();
  });
  it('refuses a closure message row missing from its batched read',async()=>{
    const h=dataHarness({conversations:[conversation('1')],messages:[message('1','1',1)]}),original=h.contentRows.getMockImplementation()!;
    h.contentRows.mockImplementation(async(...args)=>args[2]==='messages'?new Map():original(...args));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses a record page row missing from its batched read',async()=>{
    const h=dataHarness({'session-ingest':ingest(2)}),source=await open(h);
    h.contentRows.mockResolvedValue(new Map());
    await expect(source.readDomainPage(page('session-ingest'))).rejects.toMatchObject({code:'source-invalid'});
    await source.close();
  });
  it('refuses a message seq that does not advance across a header page boundary',async()=>{
    const h=dataHarness({conversations:[conversation('1')],messages:Array.from({length:501},(_,i)=>message('1',String(i+1),i+1))});
    const base=vi.mocked(mapping.listConversationMessageHeaders).getMockImplementation()!;
    vi.mocked(mapping.listConversationMessageHeaders).mockImplementation(async(db,project,conversationId,after,limit,signal)=>
      base(db,project,conversationId,null,after===null?limit:1,signal));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it.each([
    ['more headers than the page bound',()=>Array.from({length:501},()=>({locator:'["1"]',byteLength:'1',seq:'1'})),'source-invalid'],
    ['a malformed byte length',()=>[{locator:'["1"]',byteLength:'x',seq:'1'}],'source-invalid'],
    ['an oversized row',()=>[{locator:'',byteLength:'150994945',seq:'1'}],'record-unrepresentable'],
  ])('refuses a message header page with %s',async(_name,headers,code)=>{
    const h=dataHarness({conversations:[conversation('1')],messages:[message('1','1',1)]});
    vi.mocked(mapping.listConversationMessageHeaders).mockResolvedValue(headerPage(headers()));
    await expect(open(h)).rejects.toMatchObject({code});
  });
  it('stops a page at the first record that does not fit after checking its boundary, without examining later rows',async()=>{
    const limited=()=>{vi.spyOn(codec,'serializePortableRecord').mockReturnValue({byteLength:100_000_000} as Uint8Array);};
    // One chunk: the over-budget record is still compared with its boundary...
    const tampered=dataHarness({'session-ingest':ingest(3)}),tamperedSource=await open(tampered);limited();
    tampered.data['session-ingest']![1].message_count='2';
    await expect(tamperedSource.readDomainPage(page('session-ingest'))).rejects.toMatchObject({code:'source-changed'});
    await tamperedSource.close();vi.restoreAllMocks();
    // ...while a change after the cutoff, in the same chunk, is not observed.
    const after=dataHarness({'session-ingest':ingest(3)}),afterSource=await open(after);limited();
    after.data['session-ingest']![2].message_count='2';
    const original=after.contentRows.getMockImplementation()!;
    after.contentRows.mockImplementation(async(...args)=>{const found=new Map(await original(...args));found.delete('["2"]');return found;});
    const batch=await afterSource.readDomainPage(page('session-ingest'));
    expect(batch.records).toHaveLength(1);expect(batch.complete).toBe(false);
    await afterSource.close();vi.restoreAllMocks();
    // One chunk per record: the chunk after the cutoff is never fetched.
    const chunked=dataHarness({'session-ingest':ingest(3)});ingestBytes(chunked,'90000000');
    const chunkedSource=await open(chunked);limited();
    chunked.contentRows.mockClear();chunked.data['session-ingest']![2].message_count='2';
    expect((await chunkedSource.readDomainPage(page('session-ingest'))).records).toHaveLength(1);
    expect(chunked.contentRows.mock.calls.map(call=>call[3])).toEqual([['["0"]'],['["1"]']]);
    await chunkedSource.close();
  });
  it('stops a closure before its next message chunk once aborted',async()=>{
    const h=dataHarness({conversations:[conversation('1')],messages:[1,2,3].map(seq=>message('1',String(seq),seq))}),controller=new AbortController();
    messageBytes(()=>'80000000');
    const original=h.contentRows.getMockImplementation()!;
    h.contentRows.mockImplementation(async(...args)=>{const found=await original(...args);if(args[2]==='messages')controller.abort();return found;});
    await expect(adapter.createPostgreSqlPortableSource({settings,expectedOwner:'owner',expectedIdentity:identity(),signal:controller.signal},h.dependencies as never))
      .rejects.toMatchObject({code:'aborted'});
    expect(batches(h,'messages')).toHaveLength(1);
    expect(batches(h,'messages')[0]![4]).toBe(controller.signal);
  });
  it('passes the request signal to page reads and stops before the next page chunk once aborted',async()=>{
    const h=dataHarness({'session-ingest':ingest(2)});ingestBytes(h,'90000000');
    const source=await open(h),controller=new AbortController(),original=h.contentRows.getMockImplementation()!;
    h.contentRows.mockClear();
    h.contentRows.mockImplementation(async(...args)=>{const found=await original(...args);controller.abort();return found;});
    await expect(source.readDomainPage({...page('session-ingest'),signal:controller.signal})).rejects.toMatchObject({code:'aborted'});
    expect(h.contentRows).toHaveBeenCalledTimes(1);
    expect(h.contentRows.mock.calls[0]![4]).toBe(controller.signal);
    await source.close();
  });
});

