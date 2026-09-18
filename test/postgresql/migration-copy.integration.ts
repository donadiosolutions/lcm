import { beforeAll, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from './harness.js';
import { seedPortablePostgreSql, grantPortablePostgreSql } from './portable-fixture.js';
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER } from '../../src/storage/portable-record-stream.js';
import { createPostgreSqlPortableSource } from '../../src/storage/postgresql/portable-source.js';
import * as copy from '../../src/migration/copy-destination.js';
beforeAll(assertHarnessReady);

it('fences real transactions and proves a server-committed response loss before completing all domains',async()=>{
  await withPostgreSqlTestDatabase('migration-copy-source',async sourceDb=>withPostgreSqlTestDatabase('migration-copy-target',async targetDb=>{
    const seeded=await seedPortablePostgreSql(sourceDb.migrator);
    await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
    await grantPortablePostgreSql(sourceDb);await grantPortablePostgreSql(targetDb,{transfer:true});
    const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:seeded.expectedIdentity}));
    let destination:Awaited<ReturnType<typeof copy.openMigrationCopyDestination>>|undefined;
    try{
    destination=await copy.openMigrationCopyDestination({settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:seeded.expectedIdentity,
      generationId:'migration-generation-test',runId:'migration-copy-test',source,ownerProcessId:'test-owner',leaseTtlMs:300000,maximumTransactionAttempts:3,
      withSourceAuthority:async operation=>operation(async()=>{})});
      await destination.admit(false);
      const first=await source.readBatch({domain:'machines',maxRecords:1,maxBytes:150994944});
      const original=Client.prototype.query;let lost=false;
      const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
        const promise=Reflect.apply(original,this,args) as Promise<unknown>;
        const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text;
        if(!lost&&text==='COMMIT'){
          // Arm only once the canonical receipt has actually been submitted on
          // this same connection, not during acquisition/renewal transactions.
          const marked=(this as Client & {copyReceipt?:boolean}).copyReceipt;
          if(marked){lost=true;return promise.then(()=>{throw Object.assign(new Error('post-server-commit-response-loss'),{code:'ECONNRESET'});}) as never;}
        }
        if(text?.startsWith('INSERT INTO lcm.transfer_batches'))(this as Client & {copyReceipt?:boolean}).copyReceipt=true;
        return promise as never;
      });
      try{expect(await destination.applyBatch(first)).toMatchObject({checkpoint:first.checkpoint});}finally{spy.mockRestore();}
      expect(lost).toBe(true);
      for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
        let after=domain==='machines'?first.checkpoint:undefined;
        if(after?.complete)continue;
        do{const batch=await source.readBatch({domain,after,maxRecords:1,maxBytes:150994944});
          after=(await destination.applyBatch(batch)).checkpoint;
        }while(!after.complete);
      }
      const verification=await destination.verify();
      await destination.complete(verification);
      expect(await destination.readCompleted(verification)).toBe(true);
      const rows=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},{domain:'factory',operation:'checkCopy'});
      expect(rows.rows).toEqual([{state:'completed'}]);
    }finally{await destination?.close();await source.close();}
  }));
},120000);

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope } from '../../src/migration/receipts.js';
import { withMigrationQueueEvidence } from '../../src/migration/queue-evidence.js';
import { localProjectIdentity } from '../../src/daemon/project.js';
import { prepareSqliteMigrationEnrollment, authenticateSqliteMigrationSource, authenticateSqliteMigrationSourceBytes, captureAuthenticatedSqliteMigrationSource } from '../../src/migration/maintenance.js';
import { BackendPublicationCoordinator, withBackendPublicationAppendBarrierAsync, readBackendMaintenanceJournal, type BackendPublicationDriver } from '../../src/storage/backend-publication.js';
import { PostgreSqlIdentityRepository } from '../../src/storage/postgresql/identity-repository.js';
import { appendLocalHookEvents } from '../../src/hooks/local-enqueue.js';
import { readMachineIdentity } from '../../src/machine-identity.js';
import { closeLcmConnection } from '../../src/db/connection.js';
import { seedPortableSqlite } from '../storage/sqlite-portable-fixture.js';
import { createMigrationManifest, beginMigrationEffect, completeMigrationEffect } from '../../src/migration/protocol.js';
import { MigrationManifestStore } from '../../src/migration/manifest-store.js';

it('resumes a real authenticated SQLite copy after durable receipt and before local publication',async()=>{
 await withPostgreSqlTestDatabase('migration-copy-assembled',async db=>{
  await grantPortablePostgreSql(db,{transfer:true});
  const home=mkdtempSync(join(tmpdir(),'migration-copy-assembled-'));
  vi.stubEnv('HOME',home);vi.stubEnv('USERPROFILE',home);
  try{
   const cwd=join(home,'project');mkdirSync(cwd,{mode:0o700});
   const local=localProjectIdentity(cwd,home);const projectDir=join(home,'.lcm','projects',local.id);
   mkdirSync(projectDir,{recursive:true,mode:0o700});writeFileSync(join(projectDir,'meta.json'),JSON.stringify({cwd})+'\n',{mode:0o600});
   const enrolled=await prepareSqliteMigrationEnrollment({cwd,homeDir:home,targetConfig:{backend:'postgresql',postgresql:{...settings(db.runtimeUrl),migrationRole:'lcm_test_migrator'}}});
   const remote=await new PostgreSqlIdentityRepository(db.runtime).createProject({machineId:enrolled.identity.machineId,displayName:'copy target',path:cwd,normalizedPath:cwd});
   const expectedIdentity={id:remote.projectId,remoteProjectId:remote.projectId,localProjectId:local.id,machineId:enrolled.identity.machineId,canonical:cwd,selectedPath:cwd};
   const machine=readMachineIdentity(home)!;
   const seed=seedPortableSqlite(join(projectDir,'db.sqlite'),{projectIdentity:{scope:'shared',projectId:remote.projectId},sourceLocalProjectId:local.id,
    identityFacts:{machines:[{identityKey:machine.identityKey,machineId:machine.machineId}],aliases:[{machineIdentityKey:machine.identityKey,path:cwd,normalizedPath:cwd}]}});
   // These files belong only to the general-purpose seed, not this runtime topology.
   if(Array.isArray(seed.capturedSidecars!.instructions))for(const file of seed.capturedSidecars!.instructions)rmSync(file.databasePath);
   if('databasePath' in seed.capturedSidecars!.events)rmSync(seed.capturedSidecars!.events.databasePath);
   await appendLocalHookEvents({cwd,sessionId:'retained',sourceHook:'SessionStart',events:['applied','no-effect','retained'].map(data=>({type:'decision',category:'decision',data,priority:1}))});
   closeLcmConnection();
   const eventsPath=join(home,'.lcm','events',local.id+'.db');
   const project=new DatabaseSync(join(projectDir,'db.sqlite')),events=new DatabaseSync(eventsPath);
   try{
    const epoch=getMigrationReceiptEpoch(project,local.id,machine.machineId!)!;
    const envelopes=events.prepare('SELECT event_uuid AS eventUuid,event_version AS eventVersion,machine_id AS machineId,machine_sequence AS machineSequence,session_id AS sessionId,seq AS sessionSequence,type,category,data,priority,source_hook AS sourceHook,created_at AS createdAt FROM events ORDER BY machine_sequence').all() as unknown as MigrationReceiptEnvelope[];
    const memory=project.prepare('SELECT id FROM promoted ORDER BY id LIMIT 1').get() as {id:string};
    project.exec('BEGIN IMMEDIATE');
    for(const [index,envelope] of envelopes.slice(0,2).entries())recordMigrationReceipt(project,{projectId:local.id,epochId:epoch.epochId,envelope,
     effectWitness:index===0?{version:1,outcome:'applied',promotedMemoryId:memory.id}:{version:1,outcome:'no-effect',reason:'unreinforced-pattern'},committedAt:'2026-09-14T03:00:00.000000Z'});
    project.exec('COMMIT');events.exec("UPDATE events SET processed_at='2026-09-14T03:00:00.000Z' WHERE data IN ('applied','no-effect')");
   }finally{events.close();project.close();}
   const unavailable=async():Promise<never>=>{throw new Error('no publication');};
   const driver:BackendPublicationDriver={observeLocalState:unavailable,publishProjectMap:unavailable,publishConfig:unavailable,restoreConfig:unavailable,restoreProjectMap:unavailable};
   const entered=await withBackendPublicationAppendBarrierAsync(home,async token=>{
    const authority=authenticateSqliteMigrationSource(cwd,home,token);
    const expectedSourceBytes=await authenticateSqliteMigrationSourceBytes(authority,{homeDir:home,lockToken:token});
    const held=await new BackendPublicationCoordinator({homeDir:home,driver}).enterMaintenance({publicationId:'copy:all.1',generationId:'copy:all.1',sourceSelectionSha256:authority.sourceSelectionSha256,queueEvidenceSha256:expectedSourceBytes.checksumSha256,
     roster:[{machineId:machine.machineId!,queueCutoff:'0000000000000000002',evidenceSha256:expectedSourceBytes.checksumSha256}]},token);
    return {authority,expectedSourceBytes,held};
   });
   const snapshot=await captureAuthenticatedSqliteMigrationSource(entered.authority,{homeDir:home,generationId:entered.held.generationId,maintenanceChecksumSha256:entered.held.checksumSha256,expectedSourceBytes:entered.expectedSourceBytes});
   const evidence=await withMigrationQueueEvidence(home,snapshot.artifact,entered.held,async(_reference,records)=>[...records]);
   expect(evidence.map(record=>record.disposition)).toEqual(['represented','represented','retained']);
   await appendLocalHookEvents({cwd,sessionId:'post-cutoff',sourceHook:'SessionStart',events:[{type:'decision',category:'decision',data:'after sealed cutoff',priority:1}]});
   closeLcmConnection();
   const queueBytes=readFileSync(eventsPath);
   const sourceBytes=readFileSync(join(projectDir,'db.sqlite'));
   const preserved=[join(projectDir,'db.sqlite'),eventsPath,entered.authority.machineSequenceDbPath].map(path=>({path,bytes:readFileSync(path),mode:statSync(path).mode}));
   const api=await import('../../src/migration/batch-copy.js');
   const input={generationId:snapshot.artifact.generationId,homeDir:home,settings:settings(db.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity,ownerProcessId:'assembled-owner',maxRecords:1,maxBytes:150994944};
   const witness=await api.inspectSqliteMigrationCopy({...input,destinationCapturedAt:'2026-09-14T03:00:00.000Z'});
   const store=new MigrationManifestStore({homeDir:home});
   let journal=store.create(createMigrationManifest({generationId:input.generationId,source:witness.source,destination:witness.destination,parentGenerationId:null,preservedSourceGenerationId:input.generationId,createdAt:'2026-09-14T03:00:00.000Z'}));
   journal=store.update(input.generationId,journal.checksumSha256,current=>beginMigrationEffect(current,{kind:'verify-dry-run',effectId:'dryrun',inputSha256:'a'.repeat(64),startedAt:current.updatedAt}));
   store.update(input.generationId,journal.checksumSha256,current=>completeMigrationEffect(current,{effectId:'dryrun',completedAt:current.updatedAt,report:{kind:'dry-run',reportId:'verified',reportSha256:'b'.repeat(64),createdAt:current.updatedAt}}));
   let interrupted=false;
   await expect(api.runSqliteMigrationCopy(input,{observe:async boundary=>{if(boundary==='after-batch-readback'&&!interrupted){interrupted=true;throw new Error('simulated process interruption');}}})).rejects.toThrow();
   expect(store.read(input.generationId).pendingEffect?.kind).toBe('copy-batch');
   const result=await api.runSqliteMigrationCopy(input);
   expect(result.phase).toBe('copied');expect(result.checkpoints).toHaveLength(22);
   expect(await api.runSqliteMigrationCopy(input)).toEqual(result);
   expect(readFileSync(join(projectDir,'db.sqlite'))).toEqual(sourceBytes);
   expect(readFileSync(eventsPath)).toEqual(queueBytes);
   for(const evidence of preserved){expect(readFileSync(evidence.path)).toEqual(evidence.bytes);expect(statSync(evidence.path).mode).toBe(evidence.mode);}
   expect(readBackendMaintenanceJournal(home)?.phase).toBe('maintenance-held');
   expect(store.read(input.generationId).activationEligible).toBe(false);
  }finally{closeLcmConnection();vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});}
 });
},120000);

import { PostgreSqlWorkCoordinator } from '../../src/storage/postgresql/coordination.js';
import { PostgreSqlRuntime } from '../../src/storage/postgresql/runtime.js';
import { setTimeout as pause } from 'node:timers/promises';

it.each(['end-expiry','lock-wait-expiry','takeover','unresolved-publication'] as const)('refuses %s before any admission or canonical mutation',async scenario=>{
 await withPostgreSqlTestDatabase('copy-fence-source',async sourceDb=>withPostgreSqlTestDatabase('copy-fence-target',async targetDb=>{
  const seeded=await seedPortablePostgreSql(sourceDb.migrator);await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
  await grantPortablePostgreSql(sourceDb);await grantPortablePostgreSql(targetDb,{transfer:true});
  const identity=seeded.expectedIdentity;
  const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity}));
  const competing=new PostgreSqlRuntime(settings(targetDb.runtimeUrl));
  let destination:Awaited<ReturnType<typeof copy.openMigrationCopyDestination>>|undefined;
  let takeoverToken:bigint|undefined;
  try{
   if(scenario==='unresolved-publication'){
    await competing.backendPublicationGuard().acquire({projectId:identity.id,machineId:identity.machineId!,publicationId:'unresolved-copy-test',targetBackend:'postgresql',evidenceSha256:'a'.repeat(64),ttlMs:1});
    await pause(10);
   }
   destination=await copy.openMigrationCopyDestination({settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity,
    generationId:'fence-generation',runId:'fence-run',source,ownerProcessId:'stale-owner',leaseTtlMs:1000,maximumTransactionAttempts:3,
    withSourceAuthority:async operation=>{
     if(scenario==='end-expiry'){
      let checked=0;return operation(async()=>{if(++checked===2)await pause(1100);});
     }
     if(scenario==='takeover'){
      await pause(1100);
      const lease=await new PostgreSqlWorkCoordinator(competing,identity.id,identity.machineId!).acquireLease({resourceType:'migration-copy',resourceKey:'copy',processId:'replacement-owner',operation:'migration-copy',ttlMs:300000});
      expect(lease).not.toBeNull();takeoverToken=lease!.fencingToken;
      return operation(async()=>{});
     }
     let ready!:()=>void;let release!:()=>void;
     const readyPromise=new Promise<void>(resolve=>{ready=resolve;});const releasePromise=new Promise<void>(resolve=>{release=resolve;});
     const holding=competing.transaction(async executor=>{
      await executor.query({text:"SELECT 1 FROM lcm.fenced_leases WHERE project_id=$1 AND resource_type='migration-copy' AND resource_key='copy' FOR UPDATE",values:[identity.id]},{domain:'factory',operation:'holdCopyLease',projectId:identity.id});ready();await releasePromise;
     },{domain:'factory',operation:'holdCopyLease',projectId:identity.id,transactionMode:'read-committed-read-write'});
     await readyPromise;
     const waiting=operation(async()=>{}).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
     await pause(1100);release();await holding;
     const result=await waiting;if(!result.ok)throw result.error;return result.value;
    }});
   await expect(destination.admit(false)).rejects.toThrow();
   const observed=await targetDb.migrator.query({text:'SELECT (SELECT count(*)::int FROM lcm.transfer_runs) AS runs,(SELECT count(*)::int FROM lcm.transfer_batches) AS batches,(SELECT count(*)::int FROM lcm.transfer_identities) AS mappings'},{domain:'factory',operation:'assertFencedCopy'});
   expect(observed.rows).toEqual([{runs:0,batches:0,mappings:0}]);
   await destination.close();destination=undefined;
   if(takeoverToken){
    const rows=await targetDb.migrator.query({text:"SELECT owner_process_id,released_at FROM lcm.fenced_leases WHERE project_id=$1 AND resource_type='migration-copy'",values:[identity.id]},{domain:'factory',operation:'assertTakeover'});
    expect(rows.rows).toEqual([{owner_process_id:'replacement-owner',released_at:null}]);
   }
  }finally{await destination?.close();await competing.close();await source.close();}
 }));
},120000);

it.each(['batch','finalize'] as const)('rolls back the actual %s transaction when its ending fence expires',async stage=>{
 await withPostgreSqlTestDatabase('copy-stale-source',async sourceDb=>withPostgreSqlTestDatabase('copy-stale-target',async targetDb=>{
  const seeded=await seedPortablePostgreSql(sourceDb.migrator);await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
  await grantPortablePostgreSql(sourceDb);await grantPortablePostgreSql(targetDb,{transfer:true});
  const identity=seeded.expectedIdentity;
  const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity}));
  let expire=false;
  const target=await copy.openMigrationCopyDestination({settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity,
   generationId:'stale-generation',runId:'stale-run',source,ownerProcessId:'stale-owner',leaseTtlMs:1000,maximumTransactionAttempts:3,
   withSourceAuthority:async operation=>{let checked=0;return operation(async()=>{if(expire&&++checked===2)await pause(1100);});}});
  try{
   await target.admit(false);
   if(stage==='batch'){
    const first=await source.readBatch({domain:'machines',maxRecords:1,maxBytes:150994944});expire=true;
    await expect(target.applyBatch(first)).rejects.toThrow();
    const observed=await targetDb.migrator.query({text:'SELECT (SELECT count(*)::int FROM lcm.transfer_batches) AS batches,(SELECT count(*)::int FROM lcm.transfer_identities) AS mappings'},{domain:'factory',operation:'assertStaleBatch'});
    expect(observed.rows).toEqual([{batches:0,mappings:0}]);expire=false;
    expect(await target.applyBatch(first)).toMatchObject({checkpoint:first.checkpoint});
   }else{
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER){
     let after;
     do{const batch=await source.readBatch({domain,after,maxRecords:1,maxBytes:150994944});after=(await target.applyBatch(batch)).checkpoint;}while(!after.complete);
    }
    const verified=await target.verify();expire=true;
    await expect(target.complete(verified)).rejects.toThrow();expect(await target.readCompleted(verified)).toBe(false);
    const observed=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},{domain:'factory',operation:'assertStaleCompletion'});
    expect(observed.rows).toEqual([{state:'active'}]);expire=false;
    await target.complete(verified);expect(await target.readCompleted(verified)).toBe(true);
   }
  }finally{await target.close();await source.close();}
 }));
},120000);

it.each(['40001','40P01','before-commit','exhaustion'] as const)('retries %s only after a full rollback and preserves high allocators',async failure=>{
 await withPostgreSqlTestDatabase('copy-retry-source',async sourceDb=>withPostgreSqlTestDatabase('copy-retry-target',async targetDb=>{
  const seeded=await seedPortablePostgreSql(sourceDb.migrator);await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
  await grantPortablePostgreSql(sourceDb);await grantPortablePostgreSql(targetDb,{transfer:true});
  const identity=seeded.expectedIdentity,context={domain:'factory' as const,operation:'assertCopyRetry'};
  await targetDb.migrator.query({text:"SELECT setval(pg_get_serial_sequence('lcm.conversations','conversation_id'),900000,true)"},context);
  const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity}));
  let failed=false,rollbackObserved=false;
  const target=await copy.openMigrationCopyDestination({settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:identity,
   generationId:'retry-generation',runId:'retry-run',source,ownerProcessId:'retry-owner',leaseTtlMs:300000,maximumTransactionAttempts:4,
   withSourceAuthority:async operation=>{
    if(failed&&!rollbackObserved){
     const rows=await targetDb.migrator.query({text:"SELECT (SELECT count(*)::int FROM lcm.conversations) AS native,(SELECT count(*)::int FROM lcm.transfer_identities WHERE domain='conversations') AS mappings,(SELECT count(*)::int FROM lcm.transfer_batches WHERE domain='conversations') AS receipts"},context);
     expect(rows.rows).toEqual([{native:0,mappings:0,receipts:0}]);rollbackObserved=true;
    }
    return operation(async()=>{});
   }});
  try{
   await target.admit(false);
   for(const domain of ['machines','project','project-aliases'] as const){let after;do{const batch=await source.readBatch({domain,after,maxRecords:1,maxBytes:150994944});after=(await target.applyBatch(batch)).checkpoint;}while(!after.complete);}
   const next=await source.readBatch({domain:'conversations',maxRecords:1,maxBytes:150994944});
   if(failure==='exhaustion'){
    await targetDb.migrator.query({text:"SELECT setval(pg_get_serial_sequence('lcm.conversations','conversation_id'),9223372036854775807,true)"},context);
    await expect(target.applyBatch(next)).rejects.toThrow();
    const rows=await targetDb.migrator.query({text:"SELECT (SELECT count(*)::int FROM lcm.conversations) AS native,(SELECT count(*)::int FROM lcm.transfer_identities WHERE domain='conversations') AS mappings,(SELECT count(*)::int FROM lcm.transfer_batches WHERE domain='conversations') AS receipts"},context);
    expect(rows.rows).toEqual([{native:0,mappings:0,receipts:0}]);return;
   }
   const original=Client.prototype.query;let receiptConnection:Client|undefined;
   const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
    const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text;
    if(!failed&&text?.startsWith('INSERT INTO lcm.transfer_batches')){
     receiptConnection=this;
     if(failure!=='before-commit'){failed=true;return Reflect.apply(original,this,[{text:`DO $$ BEGIN RAISE EXCEPTION 'retry injection' USING ERRCODE = '${failure}'; END $$`}]) as never;}
    }
    if(!failed&&failure==='before-commit'&&this===receiptConnection&&text==='COMMIT'){
     failed=true;return this.end().then(()=>{throw Object.assign(new Error('connection lost before COMMIT'),{code:'ECONNRESET'});}) as never;
    }
    return Reflect.apply(original,this,args) as never;
   });
   try{expect(await target.applyBatch(next)).toMatchObject({checkpoint:next.checkpoint});}finally{spy.mockRestore();}
   expect(failed).toBe(true);expect(rollbackObserved).toBe(true);
   expect(await target.applyBatch(next)).toMatchObject({checkpoint:next.checkpoint});
   const copied=await targetDb.migrator.query<{id:string;count:number}>({text:'SELECT max(conversation_id)::text AS id,count(*)::int AS count FROM lcm.conversations'},context);
   expect(copied.rows[0]!.count).toBe(1);expect(BigInt(copied.rows[0]!.id)).toBeGreaterThan(900000n);
   const ordinary=await targetDb.migrator.query<{id:string}>({text:"INSERT INTO lcm.conversations(project_id,session_id) VALUES ($1,'ordinary-after-copy') RETURNING conversation_id::text AS id",values:[identity.id]},context);
   expect(BigInt(ordinary.rows[0]!.id)).toBeGreaterThan(BigInt(copied.rows[0]!.id));
  }finally{await target.close();await source.close();}
 }));
},120000);
