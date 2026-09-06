import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/storage/postgresql/portable-source.js';
import * as codec from '../../src/storage/portable-record.js';
import { PortableIndex } from '../../src/storage/portable-index.js';
import { PortableTransferError } from '../../src/storage/portable-transfer.js';
import * as mapping from '../../src/storage/postgresql/portable-mapping.js';
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER, serializePortableRecord, type PortableDomain } from '../../src/storage/portable-record-stream.js';
import type { StorageIdentityContext } from '../../src/storage/contracts.js';

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
        case 'portableSnapshotState': return {rows:[{backend_pid:123,tls:true,isolation:'repeatable read',read_only:'on',captured_at:'2026-09-06T12:34:56.123456Z'}]};
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
});


afterEach(()=>vi.restoreAllMocks());
const timestamp='2026-09-06T12:34:56.123456Z';
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
  const list=vi.spyOn(mapping,'listCanonicalHeaders').mockImplementation(async(_db,_project,domain,after,limit)=>{
    const values=rows(domain); const start=after===null?0:values.findIndex(row=>locator(domain,row)===after)+1;
    return values.slice(start,start+limit).map(row=>({locator:locator(domain,row),byteLength:'1000'}));
  });
  const read=vi.spyOn(mapping,'readCanonicalRow').mockImplementation(async(_db,_project,domain,key)=>
    byLocator.get(domain)!.get(key)??null);
  vi.spyOn(mapping,'listConversationMessageHeaders').mockImplementation(async(_db,_project,conversation,after,limit)=>
    (data.messages??[]).filter(row=>row.conversation_id===conversation&&(after===null||BigInt(String(row.seq))>BigInt(after)))
      .sort((a,b)=>BigInt(String(a.seq))<BigInt(String(b.seq))?-1:1).slice(0,limit)
      .map(row=>({locator:locator('messages',row),byteLength:'1000',seq:String(row.seq)})));
  return {...harness(),data,list,read};
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
    const h=dataHarness();h.list.mockResolvedValueOnce([{locator:'["1"]',byteLength:'150994945'}]);
    await expect(open(h)).rejects.toMatchObject({code:'record-unrepresentable'});
    expect(h.read).not.toHaveBeenCalled();expect(h.session.close).toHaveBeenCalledTimes(1);
  });
  it('fetches one source header at a time so textual locators cannot aggregate',async()=>{
    const h=dataHarness(),source=await open(h);
    expect(h.list.mock.calls.every(call=>call[4]===1)).toBe(true);
    await source.close();
  });
  it('admits projected raw rows through144MiB before exact canonical encoding',async()=>{
    const h=dataHarness(),list=h.list.getMockImplementation()!;
    h.list.mockImplementation(async(...args)=>(await list(...args)).map(header=>({...header,byteLength:'150994944'})));
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
    expect(verifyTransferSchema).toHaveBeenCalledTimes(1);expect(h.dependencies.verifyRuntimeSchema).not.toHaveBeenCalled();await source.close();
  });
  it.each([
    ['portableSourceWitness',{database_name:'source',database_oid:1,server_address:'localhost',server_port:'5432'}],
    ['portableSnapshotState',{backend_pid:123,tls:false,isolation:'repeatable read',read_only:'on',captured_at:timestamp}],
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
    const h=dataHarness();h.list.mockResolvedValueOnce([{locator:'["1"]',byteLength:'-1'}]);
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    h.read.mockResolvedValue(null);
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('refuses a backend header page exceeding the row bound or repeating its cursor',async()=>{
    const h=dataHarness();h.list.mockResolvedValueOnce(Array.from({length:501},()=>({locator:'["1"]',byteLength:'1'})));
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
    h.data.conversations=[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}];
    h.list.mockResolvedValue([{locator:'["1"]',byteLength:'1'}]);
    h.read.mockImplementation(async(_db,_project,domain)=>domain==='conversations'?h.data.conversations![0]:null);
    await expect(open(h)).rejects.toMatchObject({code:'source-invalid'});
  });
  it('hashes multiple messages in sequence and rejects a regressing closure cursor',async()=>{
    const conversations=[{conversation_id:'1',session_id:'s',title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp}];
    const messages=['1','2'].map(seq=>({conversation_id:'1',message_id:seq,seq,role:'user',content:'content '+seq,token_count:'1',created_at:timestamp}));
    const h=dataHarness({conversations,messages}),source=await open(h);await source.close();
    vi.mocked(mapping.listConversationMessageHeaders).mockResolvedValue([{locator:'["1"]',byteLength:'1',seq:'1'}]);
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
});
