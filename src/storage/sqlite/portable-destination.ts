import { closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../db/migration.js";
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, canonicalJson, canonicalSha256,
  createPortableRecord, createPortableRecordStream, negotiatePortableManifest, parsePortableCheckpoint,
  serializePortableCheckpoint, serializePortableManifest,
} from "../portable-record-stream.js";
import type { PortableBatch, PortableCheckpoint, PortableDomain, PortableManifest, PortableProjectIdentity, PortableRecord, PortableRecordStream } from "../portable-record-stream.js";
import {
  PortableTransferError, normalizePortableTransferError, validatePortableTransferBatch,
} from "../portable-transfer.js";
import type { PortableDestinationProgress, PortablePreflight, PortableRecordWriter } from "../portable-transfer.js";
import { createPortableIndex } from "../portable-index.js";
import { initializePortableArchive, PORTABLE_ARCHIVE_DOMAINS, writePortableArchiveRecord } from "./portable-archive.js";
import { writePortableRuntimeRecord } from "./portable-runtime-mapping.js";
import { openSqlitePortableSource, sqlitePortableFileSha256, validateSqlitePortableSchema } from "./portable-source.js";

export interface OpenSqlitePortableDestinationInput {
  readonly databasePath:string;
  readonly projectIdentity:PortableProjectIdentity;
  /** Stable random run identity, supplied again only for this exact owned target. */
  readonly generationIdentitySha256:string;
  readonly mode:"create"|"resume";
  readonly scratchParent?:string;
  readonly signal?:AbortSignal;
  /** @internal Deterministic fault injection at the durable transaction boundary. */
  readonly _transactionObserver?:(stage:"before-commit"|"after-commit")=>void;
}
interface TargetAuthority {readonly path:string;readonly dev:number;readonly ino:number;active:boolean;db?:DatabaseSync;projectJson?:string;run?:string;manifestSha?:string;schemaVersion?:number;}
const targetAuthorities=new WeakMap<object,TargetAuthority>();
const heldTargets=new Map<string,object>();
const admittedTargets=new WeakMap<object,{db:DatabaseSync;generationIdentitySha256:string;projectIdentity:PortableProjectIdentity;manifest:PortableManifest;index:ReturnType<typeof createPortableIndex>}>();
const preflights=new WeakMap<PortablePreflight,{token:object;index:ReturnType<typeof createPortableIndex>}>();
const LEDGER_SCHEMA=`
CREATE TABLE transfer_runs(generation_sha TEXT PRIMARY KEY, project_json TEXT NOT NULL,
 manifest_sha TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL, source_identity TEXT NOT NULL,
 source_witness TEXT NOT NULL, checkpoints_json TEXT NOT NULL DEFAULT '[]', schema_ready INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1)));
CREATE TABLE transfer_batches(run_sha TEXT NOT NULL REFERENCES transfer_runs(generation_sha),domain TEXT NOT NULL,
 prior_sha TEXT NOT NULL,result_sha TEXT NOT NULL,checkpoint_json TEXT NOT NULL,batch_sha TEXT NOT NULL,
 PRIMARY KEY(run_sha,domain,prior_sha),UNIQUE(run_sha,result_sha));
CREATE TABLE transfer_identities(run_sha TEXT NOT NULL REFERENCES transfer_runs(generation_sha),domain TEXT NOT NULL,
 identity_sha TEXT NOT NULL,ordinal INTEGER NOT NULL,locator TEXT NOT NULL,record_sha TEXT NOT NULL,
 PRIMARY KEY(run_sha,domain,identity_sha),UNIQUE(run_sha,domain,ordinal));
CREATE TRIGGER transfer_batches_no_update BEFORE UPDATE ON transfer_batches BEGIN SELECT RAISE(ABORT,'immutable receipt');END;
CREATE TRIGGER transfer_batches_no_delete BEFORE DELETE ON transfer_batches BEGIN SELECT RAISE(ABORT,'immutable receipt');END;
`;
function guard(token:object,signal?:AbortSignal,database?:DatabaseSync|null):void {
  if(signal?.aborted)throw new PortableTransferError("aborted",true);
  const state=targetAuthorities.get(token);
  if(!state?.active)throw new PortableTransferError("destination-conflict");
  try{
    const stat=lstatSync(state.path);const parent=lstatSync(dirname(state.path));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==state.dev||stat.ino!==state.ino
      ||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||parent.uid!==stat.uid||(parent.mode&0o077)!==0
      ||realpathSync(state.path)!==state.path){state.active=false;throw new PortableTransferError("destination-conflict");}
    const checked=database===undefined?state.db:database;
    const hasLedger=checked&&state.run?ledgerExists(checked):false;
    if(checked&&state.run&&!hasLedger&&(state.manifestSha!==undefined||state.schemaVersion!==undefined))throw new PortableTransferError("destination-conflict");
    if(checked&&state.run&&hasLedger){
      const row=checked.prepare("SELECT project_json,manifest_sha,schema_ready FROM transfer_runs WHERE generation_sha=?").get(state.run);
      if(!row||row.project_json!==state.projectJson||(state.manifestSha!==undefined&&row.manifest_sha!==state.manifestSha)){
        state.active=false;throw new PortableTransferError("destination-conflict");
      }
      if(row.schema_ready!==0&&row.schema_ready!==1)throw new PortableTransferError("destination-conflict");
      if(row.schema_ready===0&&(state.schemaVersion!==undefined||checked.prepare("SELECT 1 FROM transfer_batches WHERE run_sha=? LIMIT 1").get(state.run)!==undefined))throw new PortableTransferError("destination-conflict");
      if(row.schema_ready===1){
        const version=Number(checked.prepare("PRAGMA schema_version").get()!.schema_version);
        if(state.schemaVersion===undefined){validateSqlitePortableSchema(checked);state.schemaVersion=version;}
        else if(version!==state.schemaVersion)throw new PortableTransferError("unsupported-capability");
      }
    }
  }catch(error){state.active=false;throw normalizePortableTransferError(error,"destination-conflict");}
}
function ledgerExists(db:DatabaseSync):boolean {return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_runs'").get()!==undefined;}
function checkpoint(text:string):PortableCheckpoint {return parsePortableCheckpoint(Buffer.from(text));}
function receipt(db:DatabaseSync,run:string,batch:PortableBatch):Record<string,unknown>|undefined {
  return db.prepare("SELECT checkpoint_json,batch_sha FROM transfer_batches WHERE run_sha=? AND domain=? AND prior_sha=?").get(run,batch.domain,batch.priorCheckpointSha256??"");
}
function committedReceipt(authority:object,run:string,batch:PortableBatch):Record<string,unknown>|undefined {
  guard(authority,undefined,null);
  const reader=new DatabaseSync(targetAuthorities.get(authority)!.path,{readOnly:true});
  try {
    reader.exec("PRAGMA query_only=ON");
    guard(authority,undefined,reader);
    const result=receipt(reader,run,batch);
    guard(authority,undefined,reader);
    return result;
  } finally {reader.close();}
}
function progress(db:DatabaseSync,run:string,manifestSha:string):PortableDestinationProgress {
  const row=db.prepare("SELECT manifest_sha,checkpoints_json,complete FROM transfer_runs WHERE generation_sha=?").get(run);
  if(!row||row.manifest_sha!==manifestSha)throw new PortableTransferError("destination-conflict");
  const entries=JSON.parse(String(row.checkpoints_json)) as string[];
  if(!Array.isArray(entries)||entries.length>22)throw new PortableTransferError("checkpoint-mismatch");
  const checkpoints=entries.map(checkpoint);
  for(const [index,value] of checkpoints.entries()){
    if(value.domain!==PORTABLE_RECORD_DOMAIN_ORDER[index]||value.manifestSha256!==manifestSha||(!value.complete&&index!==checkpoints.length-1))throw new PortableTransferError("checkpoint-mismatch");
    const durable=db.prepare("SELECT checkpoint_json FROM transfer_batches WHERE run_sha=? AND result_sha=?").get(run,value.checkpointSha256);
    if(!durable||durable.checkpoint_json!==entries[index])throw new PortableTransferError("checkpoint-mismatch");
  }
  return {generationIdentitySha256:run,manifestSha256:manifestSha,checkpoints,complete:row.complete===1};
}

function validateRelations(record:PortableRecord,index:ReturnType<typeof createPortableIndex>):void {
  const value=record.value as unknown as Record<string,unknown>;
  const namespace="sqlite.conversation-membership";
  const message=(key:unknown):string=>canonicalJson(["messages",key]);
  const summary=(key:unknown):string=>canonicalJson(["summaries",key]);
  if(record.domain==="messages")index.bindScope(namespace,message(record.identitySha256),String(value.conversationIdentitySha256));
  if(record.domain==="summaries")index.bindScope(namespace,summary(value.summaryId),String(value.conversationIdentitySha256));
  if(record.domain==="summary-message-links"||record.domain==="summary-parent-links"){
    const conversation=index.getScope(namespace,summary(value.summaryId));
    if(conversation===null)throw new PortableTransferError("unsupported-capability");
    index.requireScope(namespace,record.domain==="summary-message-links"?message(value.messageIdentitySha256):summary(value.parentSummaryId),conversation);
    if(record.domain==="summary-parent-links")index.addEdge("sqlite.summary-dag",String(value.summaryId),String(value.parentSummaryId));
  }
  if(record.domain==="context-items"||record.domain==="native-transcript-message-links"){
    index.requireScope(namespace,record.domain==="context-items"&&value.itemType==="summary"?summary(value.summaryId):message(value.messageIdentitySha256),String(value.conversationIdentitySha256));
  }
}

/** Internal same-transaction seam for future fenced callers. It never begins or commits. */
export function applyPortableBatchInTransaction(db:DatabaseSync,authority:object,batch:PortableBatch):PortableCheckpoint {
  guard(authority);
  if(!db.isTransaction)throw new PortableTransferError("destination-conflict");
  const context=admittedTargets.get(authority);
  if(!context||context.db!==db)throw new PortableTransferError("destination-conflict");
  for(const record of batch.records){
    const entry=context.index.lookupIdentity(record.domain,record.identitySha256);
    if(!entry||entry.ordinal!==record.ordinal||entry.recordSha256!==record.recordSha256)throw new PortableTransferError("checkpoint-mismatch");
  }
  const run=context.generationIdentitySha256;
  const batchSha=canonicalSha256(batch);
  const prior=batch.priorCheckpointSha256===null?undefined:db.prepare("SELECT checkpoint_json FROM transfer_batches WHERE run_sha=? AND result_sha=?").get(run,batch.priorCheckpointSha256);
  if(batch.priorCheckpointSha256!==null&&!prior)throw new PortableTransferError("checkpoint-mismatch");
  const validated=validatePortableTransferBatch(batch,context.manifest,prior?checkpoint(String(prior.checkpoint_json)):undefined);
  const existing=receipt(db,run,validated);
  if(existing){if(existing.batch_sha!==batchSha||String(existing.checkpoint_json)!==Buffer.from(serializePortableCheckpoint(validated.checkpoint)).toString())throw new PortableTransferError("checkpoint-mismatch");return checkpoint(String(existing.checkpoint_json));}
  const current=progress(db,run,context.manifest.manifestSha256);
  if(current.complete)throw new PortableTransferError("destination-conflict");
  const domainIndex=PORTABLE_RECORD_DOMAIN_ORDER.indexOf(validated.domain);
  const active=current.checkpoints.at(-1);
  const expectedIndex=active?.complete?current.checkpoints.length:Math.max(0,current.checkpoints.length-1);
  if(domainIndex!==expectedIndex||(active&&!active.complete&&active.checkpointSha256!==validated.priorCheckpointSha256)
    ||((!active||active.complete)&&validated.priorCheckpointSha256!==null))throw new PortableTransferError("checkpoint-mismatch");
  const lookup=(domain:PortableDomain,identity:string):string=>{
    const found=db.prepare("SELECT locator FROM transfer_identities WHERE run_sha=? AND domain=? AND identity_sha=?").get(run,domain,identity);
    if(!found)throw new PortableTransferError("invalid-input");return String(found.locator);
  };
  for(const record of validated.records){
    let locator:string;
    if((PORTABLE_ARCHIVE_DOMAINS as readonly string[]).includes(record.domain)){writePortableArchiveRecord(db,record);locator=record.identitySha256;}
    else locator=writePortableRuntimeRecord(db,record,lookup,context.projectIdentity);
    db.prepare("INSERT INTO transfer_identities(run_sha,domain,identity_sha,ordinal,locator,record_sha) VALUES(?,?,?,?,?,?)").run(run,record.domain,record.identitySha256,record.ordinal,locator,record.recordSha256);
  }
  const encoded=Buffer.from(serializePortableCheckpoint(validated.checkpoint)).toString();
  db.prepare("INSERT INTO transfer_batches(run_sha,domain,prior_sha,result_sha,checkpoint_json,batch_sha) VALUES(?,?,?,?,?,?)").run(run,validated.domain,validated.priorCheckpointSha256??"",validated.checkpoint.checkpointSha256,encoded,batchSha);
  const next=[...current.checkpoints];next[domainIndex]=validated.checkpoint;
  db.prepare("UPDATE transfer_runs SET checkpoints_json=? WHERE generation_sha=?").run(JSON.stringify(next.map(value=>Buffer.from(serializePortableCheckpoint(value)).toString())),run);
  return validated.checkpoint;
}

export async function openSqlitePortableDestination(input:OpenSqlitePortableDestinationInput):Promise<PortableRecordWriter> {
  let db:DatabaseSync|undefined;const token=Object.freeze({});let ownedIndex:ReturnType<typeof createPortableIndex>|undefined;
  let manifest:PortableManifest|undefined;let closed=false;
  try{
    const projectIdentity=createPortableRecord({domain:"project",ordinal:0,context:null,value:{identity:input.projectIdentity}}).value.identity;
    if(!/^[0-9a-f]{64}$/.test(input.generationIdentitySha256)||(input.mode!=="create"&&input.mode!=="resume"))throw new PortableTransferError("invalid-input");
    const path=resolve(input.databasePath);
    if(heldTargets.has(path))throw new PortableTransferError("destination-conflict");
    const parent=lstatSync(dirname(path));
    if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0||realpathSync(dirname(path))!==dirname(path))throw new PortableTransferError("destination-conflict");
    let createdIdentity:{dev:number;ino:number}|undefined;
    if(input.mode==="create"){
      try{const fd=openSync(path,"wx",0o600);try{const created=fstatSync(fd);createdIdentity={dev:created.dev,ino:created.ino};}finally{closeSync(fd);}}
      catch{throw new PortableTransferError("destination-conflict");}
    }
    const stat=lstatSync(path);
    if(createdIdentity&&(stat.dev!==createdIdentity.dev||stat.ino!==createdIdentity.ino))throw new PortableTransferError("destination-conflict");targetAuthorities.set(token,{path,dev:stat.dev,ino:stat.ino,active:true});guard(token,input.signal);
    db=new DatabaseSync(path);const connection=db;
    Object.assign(targetAuthorities.get(token)!,{db:connection,projectJson:canonicalJson(projectIdentity),run:input.generationIdentitySha256});
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    if(db.prepare("PRAGMA journal_mode").get()!.journal_mode!=="delete")throw new PortableTransferError("unsupported-capability");
    guard(token,input.signal);
    if(input.mode==="resume"){
      if(!ledgerExists(db))throw new PortableTransferError("destination-conflict");
      const row=db.prepare("SELECT project_json FROM transfer_runs WHERE generation_sha=?").get(input.generationIdentitySha256);
      if(!row||row.project_json!==canonicalJson(projectIdentity)||db.prepare("SELECT count(*) AS count FROM transfer_runs").get()!.count!==1)throw new PortableTransferError("destination-conflict");
    }
    const witness=canonicalSha256(["sqlite-exclusive-target-v1",input.generationIdentitySha256,projectIdentity,stat.dev,stat.ino]);
    const writer:PortableRecordWriter={
      async preflight(rawManifest:PortableManifest,source:PortableRecordStream,signal?:AbortSignal){
        guard(token,signal);
        try{
          const normalized=negotiatePortableManifest(rawManifest);
          if(source.describe().manifestSha256!==normalized.manifestSha256)throw new PortableTransferError("checkpoint-mismatch");
          ownedIndex?.close();ownedIndex=createPortableIndex({scratchParent:input.scratchParent,signal});
          let projectCount=0;
          for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){let prior:PortableCheckpoint|undefined;
            do{const batch=validatePortableTransferBatch(await source.readBatch({domain,after:prior,maxRecords:500,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal}),normalized,prior);
              for(const record of batch.records){
                guard(token,signal);ownedIndex.add(String(record.ordinal),record);validateRelations(record,ownedIndex);
                const v=record.value as unknown as Record<string,unknown>;
                if(domain==="project"){projectCount++;if(canonicalJson(v.identity)!==canonicalJson(projectIdentity))throw new PortableTransferError("unsupported-capability");}
                if(domain==="summary-message-links")ownedIndex.claimUnique("summary-message",canonicalJson([v.summaryId,v.messageIdentitySha256]));
                if(domain==="summary-parent-links")ownedIndex.claimUnique("summary-parent",canonicalJson([v.summaryId,v.parentSummaryId]));
                if(domain==="message-parts"){ownedIndex.claimUnique("part-id",String(v.partId));ownedIndex.claimUnique("message-part",canonicalJson([v.messageIdentitySha256,v.ordinal]));}
                if(domain==="summary-file-links"||domain==="promoted-memory-tags"){
                  const key=String(domain==="summary-file-links"?v.summaryId:v.memoryId);
                  const ordinal=String((v.ordinal as {$integer:string}).$integer);
                  if(String(ownedIndex.allocateOccurrence(domain,key))!==ordinal)throw new PortableTransferError("unsupported-capability");
                  ownedIndex.consumeBudget(domain,key,Buffer.byteLength(canonicalJson(domain==="summary-file-links"?v.fileId:v.tag))+1,PORTABLE_LIMITS.maxRecordBytes-2-Buffer.byteLength(key));
                }
              }
              prior=batch.checkpoint;
            }while(!prior.complete);
            ownedIndex.finalizeDomain(domain);
          }
          if(projectCount!==1)throw new PortableTransferError("invalid-input");
          ownedIndex.verifyDependencies();ownedIndex.verifyScopesAndAcyclic();guard(token,signal);
          const result=Object.freeze({manifestSha256:normalized.manifestSha256,destinationWitnessSha256:witness});
          preflights.set(result,{token,index:ownedIndex});return result;
        }catch(error){ownedIndex?.close();ownedIndex=undefined;throw normalizePortableTransferError(error);}
      },
      async admit(rawManifest,preflight,signal){
        guard(token,signal);
        const evidence=preflights.get(preflight);
        if(!evidence||evidence.token!==token||evidence.index!==ownedIndex||preflight.destinationWitnessSha256!==witness||preflight.manifestSha256!==rawManifest.manifestSha256)throw new PortableTransferError("destination-conflict");
        const normalized=negotiatePortableManifest(rawManifest);
        try{
          connection.exec("BEGIN IMMEDIATE");
          if(ledgerExists(connection)){
            const row=connection.prepare("SELECT manifest_json,project_json FROM transfer_runs WHERE generation_sha=?").get(input.generationIdentitySha256);
            if(!row||row.manifest_json!==Buffer.from(serializePortableManifest(normalized)).toString()||row.project_json!==canonicalJson(projectIdentity))throw new PortableTransferError("destination-conflict");
          }else{
            if(connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()!==undefined)throw new PortableTransferError("destination-conflict");
            connection.exec(LEDGER_SCHEMA);
            connection.prepare("INSERT INTO transfer_runs(generation_sha,project_json,manifest_sha,manifest_json,source_identity,source_witness) VALUES(?,?,?,?,?,?)").run(input.generationIdentitySha256,canonicalJson(projectIdentity),normalized.manifestSha256,Buffer.from(serializePortableManifest(normalized)).toString(),normalized.source.sourceIdentitySha256,normalized.source.sourceWitnessSha256);
          }
          guard(token,signal);connection.exec("COMMIT");
          // Schema bootstrap owns internal migration transactions. Persist the
          // exact run first so a process crash remains an authenticated resume.
          const ready=connection.prepare("SELECT schema_ready FROM transfer_runs WHERE generation_sha=?").get(input.generationIdentitySha256)!;
          if(ready.schema_ready!==1){
            runLcmMigrations(connection);
            connection.exec("BEGIN IMMEDIATE");initializePortableArchive(connection);
            connection.prepare("UPDATE transfer_runs SET schema_ready=1 WHERE generation_sha=?").run(input.generationIdentitySha256);
            guard(token,signal);connection.exec("COMMIT");
          }
          manifest=normalized;targetAuthorities.get(token)!.manifestSha=normalized.manifestSha256;
          admittedTargets.set(writer,{db:connection,generationIdentitySha256:input.generationIdentitySha256,projectIdentity:projectIdentity,manifest:normalized,index:ownedIndex!});
        }catch(error){try{connection.exec("ROLLBACK");}catch{/* Preserve original failure. */}throw normalizePortableTransferError(error);}
      },
      async readProgress(manifestSha256,signal){guard(token,signal);try{return progress(connection,input.generationIdentitySha256,manifestSha256);}catch(error){throw normalizePortableTransferError(error);}},
      async applyBatch(batch,signal){
        guard(token,signal);if(!manifest||!ownedIndex)throw new PortableTransferError("destination-conflict");
        let committing=false;
        try{
          connection.exec("BEGIN IMMEDIATE");
          const ack=applyPortableBatchInTransaction(connection,writer,batch);
          guard(token,signal);input._transactionObserver?.("before-commit");committing=true;connection.exec("COMMIT");input._transactionObserver?.("after-commit");
          return ack;
        }catch(error){
          if(committing){
            // SQLITE_BUSY leaves COMMIT's transaction open. Its own connection
            // can see pending receipts, so settle it before independent readback.
            try{if(connection.isTransaction)connection.exec("ROLLBACK");}
            catch{throw new PortableTransferError("destination-uncertain",true);}
            try{
              const found=committedReceipt(token,input.generationIdentitySha256,batch);
              if(found&&found.batch_sha===canonicalSha256(batch))return checkpoint(String(found.checkpoint_json));
              if(found)throw new PortableTransferError("checkpoint-mismatch");
            }catch(reconciliation){
              if(reconciliation instanceof PortableTransferError&&reconciliation.code==="checkpoint-mismatch")throw reconciliation;
              throw new PortableTransferError("destination-uncertain",true);
            }
            throw new PortableTransferError("destination-failed",true);
          }
          try{connection.exec("ROLLBACK");}catch{/* A confirmed absent receipt allows a retry; never advance. */}
          throw normalizePortableTransferError(error);
        }
      },
      async verifyComplete(rawManifest,signal){
        guard(token,signal);const expected=negotiatePortableManifest(rawManifest);
        if(!manifest||manifest.manifestSha256!==expected.manifestSha256)throw new PortableTransferError("destination-conflict");
        const current=progress(connection,input.generationIdentitySha256,expected.manifestSha256);
        if(current.checkpoints.length!==22||current.checkpoints.some(value=>!value.complete))throw new PortableTransferError("checkpoint-mismatch");
        let readback:PortableRecordStream|undefined;
        try{
          readback=await createPortableRecordStream(await openSqlitePortableSource({databasePath:path,projectIdentity:projectIdentity,expectedFileSha256:sqlitePortableFileSha256(path),capturedAt:expected.source.capturedAt,scratchParent:input.scratchParent,signal}));
          const actual=readback.describe();
          // Source admission rehashes all actual SQL domains against this
          // target's immutable ledger manifest. The retained target guard pins
          // that manifest identity before and after the independent readback.
          await readback.close();readback=undefined;
          guard(token,signal);connection.exec("BEGIN IMMEDIATE");
          connection.prepare("UPDATE transfer_runs SET complete=1 WHERE generation_sha=? AND manifest_sha=?").run(input.generationIdentitySha256,expected.manifestSha256);
          connection.exec("COMMIT");
          return {manifestSha256:expected.manifestSha256,contentSha256:actual.contentSha256,domains:actual.domains.map(({domain,recordCount,prefixSha256})=>({domain,recordCount,prefixSha256})),complete:true};
        }catch(error){try{await readback?.close();}catch{/* Preserve failed verification. */}try{connection.exec("ROLLBACK");}catch{/* No active transaction. */}throw normalizePortableTransferError(error,"verification-failed");}
      },
      async close(){if(closed)return;closed=true;const state=targetAuthorities.get(token)!;state.active=false;heldTargets.delete(path);let failed=false;try{ownedIndex?.close();}catch{failed=true;}try{connection.close();}catch{failed=true;}db=undefined;if(failed)throw new PortableTransferError("close-failed");},
    };
    targetAuthorities.set(writer,targetAuthorities.get(token)!);
    heldTargets.set(path,token);
    return Object.freeze(writer);
  }catch(error){targetAuthorities.delete(token);try{db?.close();}catch{/* Preserve admission failure. */}throw normalizePortableTransferError(error,"destination-conflict");}
}
