import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Client, type QueryConfig, type QueryResult, type QueryResultRow } from 'pg';
import { normalizeProjectPath } from '../../project-map.js';
import type { StorageIdentityContext } from '../contracts.js';
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, canonicalJson, sha256,
  serializePortableManifest, serializePortableCheckpoint,
  parsePortableCheckpoint, negotiatePortableManifest, createPortableRecordStream,
  type PortableBatch, type PortableCheckpoint, type PortableDomain,
  type PortableManifest, type PortableRecordStream,
} from '../portable-record-stream.js';
import {
  PortableTransferError, normalizePortableTransferError, validatePortableTransferBatch,
  type PortableRecordWriter, type PortablePreflight,
  type PortableDestinationProgress, type PortableDestinationVerification,
} from '../portable-transfer.js';
import { createPortableIndex, type PortableIndex } from '../portable-index.js';
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from './contracts.js';
import { buildPostgreSqlClientConfig } from './client-config.js';
import { verifyPostgreSqlTransferSchema } from './runtime-readiness.js';
import { assertPostgreSqlRecordCapability, insertCanonicalRecord, listCanonicalHeaders, readCanonicalRow, assertPostgreSqlExistingConstraints, listPostgreSqlRecordUniqueKeys, validatePostgreSqlRecordRelations } from './portable-mapping.js';
import { createPostgreSqlPortableSource, readPostgreSqlPortableWitness } from './portable-source.js';

export interface PostgreSqlPortableDestinationInput {
  readonly settings: PostgreSqlConnectionSettings;
  readonly expectedOwner: string;
  readonly expectedIdentity: StorageIdentityContext;
  readonly generationId: string;
  readonly runId: string;
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
}

type RunRow = QueryResultRow & {
  run_id: string; target_generation: string; project_id: string;
  manifest_bytes: Buffer; manifest_sha256: string; state: string;
  current_domain: PortableDomain | null; checkpoint_bytes: Buffer | null;
  checkpoint_sha256: string | null; project_sha256: string;
};
type ReceiptRow = QueryResultRow & {
  batch_sha256: string; checkpoint_bytes: Buffer; checkpoint_sha256: string;
};
interface DestinationState {
  readonly input: PostgreSqlPortableDestinationInput;
  readonly expectedInput: StorageIdentityContext;
  readonly expectedIdentityBytes: string;
  readonly generationIdentitySha256: string;
  client: Client;
  executor: PostgreSqlQueryExecutor;
  witness: string;
  identityFingerprint: string;
  index?: PortableIndex;
  manifest?: PortableManifest;
  closed: boolean;
  closing: boolean;
  broken: boolean;
  tail: Promise<unknown>;
  closePromise?: Promise<void>;
}
const authorities = new WeakMap<PortableRecordWriter, DestinationState>();
const preflights = new WeakMap<PortablePreflight, {state:DestinationState; index:PortableIndex;manifestBytes:string}>();
const INITIAL = sha256('lcm-portable-initial-v1');
const IDENTITY_DOMAINS = ['machines','project','project-aliases'] as const;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(code: ConstructorParameters<typeof PortableTransferError>[0]): never {
  throw new PortableTransferError(code, code === 'aborted' || code === 'destination-uncertain');
}
function abort(signal?: AbortSignal): void { if(signal?.aborted) fail('aborted'); }
function options(state:DestinationState, signal?:AbortSignal):PostgreSqlQueryOptions {
  return {domain:'factory',operation:'portableTransfer',projectId:state.input.expectedIdentity.id,signal};
}
function checkedState(authority:PortableRecordWriter):DestinationState {
  const state=authorities.get(authority);
  if(!state || state.closed || state.expectedIdentityBytes !== canonicalJson(state.expectedInput)) fail('destination-conflict');
  return state;
}
function inputValid(input:PostgreSqlPortableDestinationInput): boolean {
  const identity=input?.expectedIdentity;
  return !!input && !!input.settings && typeof input.expectedOwner==='string' && input.expectedOwner.length>0
    && typeof input.generationId==='string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.generationId)
    && typeof input.runId==='string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.runId)
    && !!identity && UUID7.test(identity.id) && identity.remoteProjectId===identity.id
    && typeof identity.machineId==='string' && UUID7.test(identity.machineId)
    && typeof identity.localProjectId==='string' && /^[0-9a-f]{64}$/u.test(identity.localProjectId)
    && typeof identity.selectedPath==='string' && isAbsolute(identity.selectedPath) && !/[\0-\x1f\x7f]/u.test(identity.selectedPath);
}
function batchDigest(batch:PortableBatch):string {
  return sha256(canonicalJson([batch.version,batch.manifestSha256,batch.domain,
    batch.priorCheckpointSha256,batch.framedBytes,batch.complete,
    batch.records.map(record=>record.recordSha256),batch.checkpoint]));
}
function bytesEqual(a:Uint8Array,b:Uint8Array):boolean { return Buffer.from(a).equals(Buffer.from(b)); }
function runMatches(state:DestinationState,row:RunRow,manifest:PortableManifest):boolean {
  return row.run_id===state.input.runId && row.target_generation===state.input.generationId
    && row.project_id===state.input.expectedIdentity.id && row.manifest_sha256===manifest.manifestSha256
    && row.project_sha256===state.identityFingerprint
    && bytesEqual(row.manifest_bytes,serializePortableManifest(manifest));
}
async function runRow(state:DestinationState,executor:PostgreSqlQueryExecutor,lock=false,signal?:AbortSignal):Promise<RunRow|undefined> {
  const result=await executor.query<RunRow>({text:`SELECT run_id,target_generation,project_id::text,CASE WHEN octet_length(manifest_bytes)<=1048576 THEN manifest_bytes END AS manifest_bytes,manifest_sha256,state,current_domain,CASE WHEN octet_length(checkpoint_bytes)<=1048576 THEN checkpoint_bytes END AS checkpoint_bytes,checkpoint_sha256,project_sha256 FROM lcm.transfer_runs WHERE project_id=$1 ${lock?'FOR UPDATE':''}`,values:[state.input.expectedIdentity.id]},options(state,signal));
  if(result.rows.length>1) fail('destination-conflict');
  return result.rows[0];
}
async function readIdentityFingerprint(state:DestinationState,signal?:AbortSignal,executor:PostgreSqlQueryExecutor=state.executor):Promise<string> {
  const binding=await executor.query({text:`SELECT p.project_id::text FROM lcm.projects p JOIN lcm.project_aliases a ON a.project_id=p.project_id JOIN lcm.machines m ON m.machine_id=a.machine_id WHERE p.project_id=$1 AND a.machine_id=$2 AND a.path=$3 AND a.normalized_path=$4`,values:[state.input.expectedIdentity.id,state.input.expectedIdentity.machineId,state.input.expectedIdentity.selectedPath,normalizeProjectPath(state.input.expectedIdentity.selectedPath!)]},options(state,signal));
  if(binding.rows.length!==1) fail('destination-conflict');
  const digest=createHash('sha256');
  // Identity rows are small, but read individually and bound their SQL framing
  // before decoding so an enormous alias cannot allocate an unbounded array.
  for(const domain of ['project','project-aliases'] as const){
    let after:string|null=null;
    for(;;){
      const headers=await listCanonicalHeaders(executor,state.input.expectedIdentity.id,domain,after,1,signal);
      if(headers.length===0) break;
      const header=headers[0]!;
      if(BigInt(header.byteLength)>BigInt(PORTABLE_LIMITS.maxBatchBytes))fail('unsupported-capability');
      const row=await readCanonicalRow(executor,state.input.expectedIdentity.id,domain,header.locator,signal);
      if(!row)fail('destination-conflict');
      digest.update(canonicalJson([domain,row]));
      after=header.locator;
    }
  }
  let machineAfter='';
  for(;;){
    const result=await executor.query({text:`SELECT machine_id::text,CASE WHEN octet_length(identity_key)<=$2 THEN identity_key END AS identity_key FROM lcm.machines WHERE machine_id::text COLLATE \"C\">$1 COLLATE \"C\" ORDER BY machine_id::text COLLATE \"C\" LIMIT 1`,values:[machineAfter,PORTABLE_LIMITS.maxControlBytes]},options(state,signal));
    if(!result.rows.length)break;
    const row=result.rows[0]!;if(typeof row.identity_key!=='string')fail('unsupported-capability');digest.update(canonicalJson(['machines',row]));machineAfter=String(row.machine_id);
  }
  return digest.digest('hex');
}
async function assertIdentity(state:DestinationState,signal?:AbortSignal,executor:PostgreSqlQueryExecutor=state.executor):Promise<void> {
  abort(signal);
  if(state.closed || state.expectedIdentityBytes!==canonicalJson(state.expectedInput)) fail('destination-conflict');
  if(await readIdentityFingerprint(state,signal,executor)!==state.identityFingerprint) fail('destination-conflict');
}
async function assertEmpty(state:DestinationState,signal?:AbortSignal):Promise<void> {
  for(const domain of PORTABLE_RECORD_DOMAIN_ORDER.slice(3)){
    if((await listCanonicalHeaders(state.executor,state.input.expectedIdentity.id,domain,null,1,signal)).length) fail('destination-conflict');
  }
}
async function connect(state:DestinationState,signal?:AbortSignal):Promise<void> {
  abort(signal);
  const client=new Client(buildPostgreSqlClientConfig(state.input.settings));
  client.on('error',()=>{state.broken=true;});
  state.client=client;
  await client.connect();
  state.broken=false;
  state.executor={query:async <R extends QueryResultRow=QueryResultRow,I extends unknown[]=unknown[]>(config:QueryConfig<I>,queryOptions:PostgreSqlQueryOptions):Promise<QueryResult<R>>=>{
    const querySignal=queryOptions.signal;
    abort(querySignal);
    if(state.broken) fail('destination-failed');
    const onAbort=()=>{state.broken=true;void client.end().catch(()=>undefined);};
    querySignal?.addEventListener('abort',onAbort,{once:true});
    try{return await client.query<R,I>(config);}
    catch(error){if(querySignal?.aborted) fail('aborted');throw normalizePortableTransferError(error);}
    finally{querySignal?.removeEventListener('abort',onAbort);}
  }};
  await verifyPostgreSqlTransferSchema(state.executor,{expectedOwner:state.input.expectedOwner,signal});
  const safety=await state.executor.query({text:`SELECT current_setting('server_version_num')::int AS version,current_setting('server_encoding') AS encoding,s.ssl AS tls FROM pg_catalog.pg_stat_ssl s WHERE s.pid=pg_backend_pid()`},options(state,signal));
  if(safety.rows[0]?.tls!==true || Math.floor(Number(safety.rows[0]?.version)/10000)!==18 || safety.rows[0]?.encoding!=='UTF8') fail('destination-conflict');
  const acquired=await state.executor.query({text:`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1,618)) AS held`,values:[state.input.expectedIdentity.id]},options(state,signal));
  if(acquired.rows[0]?.held!==true) fail('destination-conflict');
  const witness=await readPostgreSqlPortableWitness(state.executor,state.input.expectedIdentity.id,signal);
  if(state.witness && state.witness!==witness) fail('destination-conflict');
  state.witness=witness;
}
async function transaction<T>(state:DestinationState,fn:(executor:PostgreSqlQueryExecutor)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  abort(signal);
  await state.executor.query({text:'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'},options(state,signal));
  let committing=false;
  try{
    const scoped:PostgreSqlQueryExecutor={transactionScope:'active',query:state.executor.query};
    const result=await fn(scoped);
    abort(signal);
    committing=true;
    await state.executor.query({text:'COMMIT'},options(state,signal));
    return result;
  }catch(error){
    if(committing) fail('destination-uncertain');
    try{await state.executor.query({text:'ROLLBACK'},options(state));}catch{state.broken=true;}
    throw normalizePortableTransferError(error);
  }
}
function enqueue<T>(state:DestinationState,fn:()=>Promise<T>):Promise<T>{
  if(state.closing)return Promise.reject(new PortableTransferError('destination-conflict'));
  const pending=state.tail.then(async()=>{try{return await fn();}catch(error){throw normalizePortableTransferError(error);}});
  state.tail=pending.catch(()=>undefined);
  return pending;
}
async function receipt(state:DestinationState,executor:PostgreSqlQueryExecutor,batch:PortableBatch,signal?:AbortSignal):Promise<PortableCheckpoint|undefined>{
  const result=await executor.query<ReceiptRow>({text:'SELECT batch_sha256,CASE WHEN octet_length(checkpoint_bytes)<=1048576 THEN checkpoint_bytes END AS checkpoint_bytes,checkpoint_sha256 FROM lcm.transfer_batches WHERE run_id=$1 AND domain=$2 AND prior_checkpoint_sha256=$3',values:[state.input.runId,batch.domain,batch.priorCheckpointSha256??INITIAL]},options(state,signal));
  const row=result.rows[0];if(!row)return undefined;
  if(row.batch_sha256!==batchDigest(batch)||row.checkpoint_sha256!==batch.checkpoint.checkpointSha256||!bytesEqual(row.checkpoint_bytes,serializePortableCheckpoint(batch.checkpoint))) fail('checkpoint-mismatch');
  return parsePortableCheckpoint(row.checkpoint_bytes);
}
async function preflight(state:DestinationState,manifestInput:PortableManifest,source:PortableRecordStream,signal?:AbortSignal):Promise<PortablePreflight>{
  const manifest=negotiatePortableManifest(manifestInput);
  if(source.describe().manifestSha256!==manifest.manifestSha256) fail('invalid-input');
  await assertIdentity(state,signal);
  if(manifest.source.sourceWitnessSha256===state.witness) fail('destination-conflict');
  const index=createPortableIndex({scratchParent:state.input.scratchParent,signal});
  try{
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
      let after:PortableCheckpoint|undefined;
      let count=0;
      do{
        const batch=await source.readBatch({domain,after,maxRecords:PORTABLE_LIMITS.maxBatchRecords,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal});
        const normalized=validatePortableTransferBatch(batch,manifest,after);
        for(const record of normalized.records){
          assertPostgreSqlRecordCapability(record,state.input.expectedIdentity.id);
          await assertPostgreSqlExistingConstraints(state.executor,state.input.expectedIdentity.id,record,signal);
          for(const {namespace,key} of listPostgreSqlRecordUniqueKeys(record))index.claimUnique(namespace,key);
          validatePostgreSqlRecordRelations(record,index);
          index.add(String(record.ordinal),record);
          if((IDENTITY_DOMAINS as readonly string[]).includes(domain)){
            await insertCanonicalRecord(state.executor,state.input.expectedIdentity.id,record,async()=>fail('invalid-input'),signal);
          }
        }
        count+=normalized.records.length;
        after=normalized.checkpoint;
        await source.verify(after);
      }while(!after.complete);
      index.finalizeDomain(domain);
      if(domain==='project'||domain==='project-aliases'){
        let actualCount=0;let cursor:string|null=null;
        for(;;){const headers=await listCanonicalHeaders(state.executor,state.input.expectedIdentity.id,domain,cursor,1,signal);if(!headers.length)break;actualCount++;cursor=headers[0]!.locator;}
        if(actualCount!==count) fail('destination-conflict');
      }
    }
    index.verifyDependencies();
    index.verifyScopesAndAcyclic();
    await assertIdentity(state,signal);
    const token=Object.freeze({manifestSha256:manifest.manifestSha256,destinationWitnessSha256:state.witness});
    preflights.set(token,{state,index,manifestBytes:Buffer.from(serializePortableManifest(manifest)).toString('base64')});
    state.index?.close();state.index=index;
    return token;
  }catch(error){index.close();throw normalizePortableTransferError(error);}
}
async function admit(state:DestinationState,manifestInput:PortableManifest,token:PortablePreflight,signal?:AbortSignal):Promise<void>{
  const manifest=negotiatePortableManifest(manifestInput);
  const validation=preflights.get(token);
  if(!validation || validation.state!==state || validation.index!==state.index || token.destinationWitnessSha256!==state.witness || validation.manifestBytes!==Buffer.from(serializePortableManifest(manifest)).toString('base64')) fail('destination-conflict');
  await assertIdentity(state,signal);
  try{await transaction(state,async executor=>{
    const existing=await runRow(state,executor,true,signal);
    if(existing){if(!runMatches(state,existing,manifest))fail('destination-conflict');return;}
    await assertEmpty(state,signal);
    await executor.query({text:`INSERT INTO lcm.transfer_runs (run_id,target_generation,project_id,manifest_bytes,manifest_sha256,schema_sha256,project_sha256,source_sha256,source_witness_sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,values:[state.input.runId,state.input.generationId,state.input.expectedIdentity.id,Buffer.from(serializePortableManifest(manifest)),manifest.manifestSha256,manifest.schemaSha256,state.identityFingerprint,manifest.source.sourceIdentitySha256,manifest.source.sourceWitnessSha256]},options(state,signal));
  },signal);}catch(error){
    if(!(error instanceof PortableTransferError)||error.code!=='destination-uncertain')throw error;
    await reconcileRun(state,manifest,false);
  }
  state.manifest=manifest;
}
async function progress(state:DestinationState,manifestSha256:string,signal?:AbortSignal):Promise<PortableDestinationProgress>{
  await assertIdentity(state,signal);
  if(!state.manifest || state.manifest.manifestSha256!==manifestSha256)fail('destination-conflict');
  const row=await runRow(state,state.executor,false,signal);
  if(!row||!runMatches(state,row,state.manifest)||(row.checkpoint_bytes===null)!==(row.checkpoint_sha256===null))fail('destination-conflict');
  const checkpoints:PortableCheckpoint[]=[];
  // At most22 rows, independently bounded checkpoint bytea at schema control limit.
  for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
    const found=await state.executor.query<{checkpoint_bytes:Buffer}>({text:'SELECT CASE WHEN octet_length(checkpoint_bytes)<=1048576 THEN checkpoint_bytes END AS checkpoint_bytes FROM lcm.transfer_batches WHERE run_id=$1 AND domain=$2 ORDER BY next_ordinal DESC LIMIT 1',values:[state.input.runId,domain]},options(state,signal));
    if(!found.rows.length)break;
    const checkpoint=parsePortableCheckpoint(found.rows[0]!.checkpoint_bytes);
    checkpoints.push(checkpoint);if(!checkpoint.complete)break;
  }
  return {generationIdentitySha256:state.generationIdentitySha256,manifestSha256,checkpoints,complete:row.state==='completed'};
}

/** Same-transaction seam for future migration fences; never starts or commits SQL. */
export async function applyPortableBatchInTransaction(executor:PostgreSqlQueryExecutor,authority:PortableRecordWriter,batchInput:PortableBatch,signal?:AbortSignal):Promise<PortableCheckpoint>{
  const state=checkedState(authority);
  if(!state.manifest || !state.index || executor.transactionScope!=='active')fail('destination-conflict');
  await assertIdentity(state,signal,executor);
  if(await readPostgreSqlPortableWitness(executor,state.input.expectedIdentity.id,signal)!==state.witness)fail('destination-conflict');
  const isolation=await executor.query({text:"SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly"},options(state,signal));
  if(isolation.rows[0]?.isolation!=='read committed'||isolation.rows[0]?.readonly!=='off')fail('destination-conflict');
  const row=await runRow(state,executor,true,signal);
  if(!row||!runMatches(state,row,state.manifest)||(row.checkpoint_bytes===null)!==(row.checkpoint_sha256===null))fail('destination-conflict');
  const transactionId=await executor.query({text:'SELECT pg_catalog.pg_current_xact_id_if_assigned()::text AS transaction_id'},options(state,signal));
  if(typeof transactionId.rows[0]?.transaction_id!=='string')fail('destination-conflict');
  let replayPrior:PortableCheckpoint|undefined;
  if(batchInput.priorCheckpointSha256!==null){
    const priorRows=await executor.query<{checkpoint_bytes:Buffer}>({text:'SELECT CASE WHEN octet_length(checkpoint_bytes)<=1048576 THEN checkpoint_bytes END AS checkpoint_bytes FROM lcm.transfer_batches WHERE run_id=$1 AND domain=$2 AND checkpoint_sha256=$3',values:[state.input.runId,batchInput.domain,batchInput.priorCheckpointSha256]},options(state,signal));
    if(priorRows.rows.length!==1)fail('checkpoint-mismatch');
    replayPrior=parsePortableCheckpoint(priorRows.rows[0]!.checkpoint_bytes);
  }
  const replayBatch=validatePortableTransferBatch(batchInput,state.manifest,replayPrior);
  for(const record of replayBatch.records){
    const indexed=state.index.lookupIdentity(record.domain,record.identitySha256);
    if(!indexed||indexed.ordinal!==record.ordinal||indexed.recordSha256!==record.recordSha256)fail('checkpoint-mismatch');
  }
  // Prior receipt is immutable and makes an exact response-loss replay harmless.
  const existing=await receipt(state,executor,replayBatch,signal);
  if(existing)return existing;
  if(row.state!=='active')fail('destination-conflict');
  const current=row.checkpoint_bytes?parsePortableCheckpoint(row.checkpoint_bytes):undefined;
  const sameDomain=current?.domain===batchInput.domain;
  const prior=sameDomain?current:undefined;
  const expectedDomain=current===undefined?PORTABLE_RECORD_DOMAIN_ORDER[0]:current.complete?PORTABLE_RECORD_DOMAIN_ORDER[PORTABLE_RECORD_DOMAIN_ORDER.indexOf(current.domain)+1]:current.domain;
  if(expectedDomain!==batchInput.domain)fail('checkpoint-mismatch');
  const batch=validatePortableTransferBatch(batchInput,state.manifest,prior);
  for(const record of batch.records){
    const key=await insertCanonicalRecord(executor,state.input.expectedIdentity.id,record,async(domain,identity)=>{
      const mapping=await executor.query<{native_key:string}>({text:'SELECT native_key FROM lcm.transfer_identities WHERE run_id=$1 AND domain=$2 AND identity_sha256=$3',values:[state.input.runId,domain,identity]},options(state,signal));
      if(mapping.rows.length!==1)fail('checkpoint-mismatch');return mapping.rows[0]!.native_key;
    },signal);
    await executor.query({text:'INSERT INTO lcm.transfer_identities (run_id,domain,identity_sha256,ordinal,native_key,record_sha256) VALUES ($1,$2,$3,$4,$5,$6)',values:[state.input.runId,record.domain,record.identitySha256,String(record.ordinal),key,record.recordSha256]},options(state,signal));
  }
  const checkpointBytes=Buffer.from(serializePortableCheckpoint(batch.checkpoint));
  await executor.query({text:'INSERT INTO lcm.transfer_batches (run_id,domain,prior_checkpoint_sha256,batch_sha256,checkpoint_bytes,checkpoint_sha256,first_ordinal,next_ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',values:[state.input.runId,batch.domain,batch.priorCheckpointSha256??INITIAL,batchDigest(batch),checkpointBytes,batch.checkpoint.checkpointSha256,String(prior?.nextOrdinal??0),String(batch.checkpoint.nextOrdinal)]},options(state,signal));
  const updated=await executor.query({text:'UPDATE lcm.transfer_runs SET current_domain=$2,checkpoint_bytes=$3,checkpoint_sha256=$4 WHERE run_id=$1 AND checkpoint_sha256 IS NOT DISTINCT FROM $5',values:[state.input.runId,batch.domain,checkpointBytes,batch.checkpoint.checkpointSha256,current?.checkpointSha256??null]},options(state,signal));
  if(updated.rowCount!==1)fail('checkpoint-mismatch');
  return batch.checkpoint;
}
async function reconnect(state:DestinationState):Promise<void>{
  await state.client.end().catch(()=>undefined);
  await connect(state);
  await assertIdentity(state);
}
async function reconcileRun(state:DestinationState,manifest:PortableManifest,completed:boolean):Promise<void>{
  try{
    await reconnect(state);
    const row=await runRow(state,state.executor);
    if(!row||!runMatches(state,row,manifest)||(completed&&row.state!=='completed'))fail('destination-uncertain');
  }catch{fail('destination-uncertain');}
}
async function apply(state:DestinationState,authority:PortableRecordWriter,batch:PortableBatch,signal?:AbortSignal):Promise<PortableCheckpoint>{
  try{return await transaction(state,executor=>applyPortableBatchInTransaction(executor,authority,batch,signal),signal);}
  catch(error){
    if(!(error instanceof PortableTransferError)||error.code!=='destination-uncertain')throw error;
    try{
      await reconnect(state);
      const acknowledged=await receipt(state,state.executor,batch);
      if(acknowledged)return acknowledged;
    }catch{fail('destination-uncertain');}
    fail('destination-uncertain');
  }
}
async function verify(state:DestinationState,manifest:PortableManifest,signal?:AbortSignal):Promise<PortableDestinationVerification>{
  const saved=await progress(state,manifest.manifestSha256,signal);
  if(saved.checkpoints.length!==PORTABLE_RECORD_DOMAIN_ORDER.length||saved.checkpoints.some(checkpoint=>!checkpoint.complete))fail('verification-failed');
  const source=await createPostgreSqlPortableSource({settings:state.input.settings,expectedOwner:state.input.expectedOwner,expectedIdentity:state.input.expectedIdentity,admission:'transfer',signal});
  let stream:PortableRecordStream|undefined;
  let primary:unknown;
  try{
    stream=await createPortableRecordStream(source);
    const actual=stream.describe();
    if(actual.contentSha256!==manifest.contentSha256 || actual.domains.some((domain,index)=>domain.recordCount!==manifest.domains[index]!.recordCount||domain.prefixSha256!==manifest.domains[index]!.prefixSha256))fail('verification-failed');
    await assertIdentity(state,signal);
    try{await transaction(state,async executor=>{
      const row=await runRow(state,executor,true,signal);
      if(!row||!runMatches(state,row,manifest))fail('destination-conflict');
      await executor.query({text:"UPDATE lcm.transfer_runs SET state='completed' WHERE run_id=$1",values:[state.input.runId]},options(state,signal));
    },signal);}catch(error){
      if(!(error instanceof PortableTransferError)||error.code!=='destination-uncertain')throw error;
      await reconcileRun(state,manifest,true);
    }
    return {manifestSha256:manifest.manifestSha256,contentSha256:actual.contentSha256,domains:actual.domains.map(({domain,recordCount,prefixSha256})=>({domain,recordCount,prefixSha256})),complete:true};
  }catch(error){primary=error;throw error;}
  finally{try{if(stream)await stream.close();else await source.close();}catch{if(primary===undefined)fail('close-failed');}}
}

/** Admit a fresh isolated project generation, or resume its exact durable run. */
export async function createPostgreSqlPortableDestination(input:PostgreSqlPortableDestinationInput):Promise<PortableRecordWriter>{
  if(!inputValid(input))fail('invalid-input');
  abort(input.signal);
  const frozenInput={...input,settings:{...input.settings},expectedIdentity:{...input.expectedIdentity}};
  const state={input:frozenInput,expectedInput:input.expectedIdentity,expectedIdentityBytes:canonicalJson(input.expectedIdentity),generationIdentitySha256:sha256(canonicalJson(['postgresql-portable-generation-v1',input.generationId,input.expectedIdentity.id])),witness:'',identityFingerprint:'',closed:false,closing:false,broken:false,tail:Promise.resolve()} as DestinationState;
  try{
    await connect(state,input.signal);
    state.identityFingerprint=await readIdentityFingerprint(state,input.signal);
    const existing=await runRow(state,state.executor,false,input.signal);
    if(existing){if(existing.run_id!==input.runId||existing.target_generation!==input.generationId||existing.project_sha256!==state.identityFingerprint)fail('destination-conflict');}
    else await assertEmpty(state,input.signal);
    const boundSignal=(signal?:AbortSignal):AbortSignal|undefined=>state.input.signal&&signal?AbortSignal.any([state.input.signal,signal]):signal??state.input.signal;
    const writer:PortableRecordWriter={
      preflight:(manifest,source,signal)=>enqueue(state,()=>preflight(state,manifest,source,boundSignal(signal))),
      admit:(manifest,token,signal)=>enqueue(state,()=>admit(state,manifest,token,boundSignal(signal))),
      readProgress:(manifest,signal)=>enqueue(state,()=>progress(state,manifest,boundSignal(signal))),
      applyBatch:(batch,signal)=>enqueue(state,()=>apply(state,writer,batch,boundSignal(signal))),
      verifyComplete:(manifest,signal)=>enqueue(state,()=>verify(state,manifest,boundSignal(signal))),
      close:()=>{
        if(!state.closePromise){
          state.closing=true;
          state.closePromise=state.tail.then(async()=>{state.closed=true;authorities.delete(writer);try{state.index?.close();}finally{await state.client.end();}}).catch(()=>{throw new PortableTransferError('close-failed');});
        }
        return state.closePromise;
      },
    };
    authorities.set(writer,state);return writer;
  }catch(error){if(state.client)await state.client.end().catch(()=>undefined);throw normalizePortableTransferError(error);}
}
