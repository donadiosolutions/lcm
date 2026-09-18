import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { populatedFixture, heldSource, REGISTERED_MACHINE } from '../fixtures/migration-copy.js';
import { captureAuthenticatedSqliteMigrationSource } from '../../src/migration/maintenance.js';
import { MigrationManifestStore } from '../../src/migration/manifest-store.js';
import { createMigrationManifest, beginMigrationEffect, completeMigrationEffect } from '../../src/migration/protocol.js';
import { inspectSqliteMigrationCopy, runSqliteMigrationCopy } from '../../src/migration/batch-copy.js';
import { canonicalSha256 } from '../../src/storage/portable-record.js';
import type { PortableBatch } from '../../src/storage/portable-record-stream.js';

// #623 W1 (owner-adjudicated correction to plan-v2 section 2, recorded in
// .superpowers/623/impl/phase-attribution-measurement.md): a full fenced copy
// in this file legitimately spends ~59% of its own wall time inside
// reauthenticateHeld's per-publish full snapshot re-inspection (~20-30ms per
// call, ~44% of a whole test's time), which is the fence re-proving source
// authority under the held publication token before every checkpoint
// publish. That cost is pre-existing, #622/maintenance-owned fencing
// behavior, not a #623 defect: every step inside reauthenticateHeld,
// including the "doubled" authenticate, was traced line-by-line and serves a
// distinct purpose (the second authenticate/journal read closes a TOCTOU gap
// around the awaited async re-inspection), so none of it was touched. Fixture
// sharing was evaluated and intentionally not attempted: eliminating all
// 466ms of prepared()'s fixture cost would only take the lightest test from
// 2.95s to ~2.48s isolated, which under the measured ~1.93x pool-contention
// multiplier (5694ms vs 2950ms for the identical test, zero code change --
// the independently filed main-wide at-edge condition, Bug #1366) is still
// ~4.8s against a 5000ms deadline, i.e. not a fix. The worst pool-contended
// duration observed for this file was 5957ms; 15000ms clears roughly 2x that
// (~11914ms) with real headroom while still catching a genuine hang. See
// docs/migration-cutover.md's "Copy cost and the publication fence" section
// for the documented boundedness characteristic (#623 W8).
vi.setConfig({ testTimeout: 15000 });

const remote=vi.hoisted(()=>({run:null as null|{runId:string;targetGenerationId:string;manifestSha256:string;projectFingerprintSha256:string;state:'active'|'completed'},receipts:new Map<string,{checkpoint:PortableBatch['checkpoint'];batchSha256:string}>(),empty:true}));
vi.mock('../../src/storage/postgresql/portable-destination.js',async original=>({
 ...await original<typeof import('../../src/storage/postgresql/portable-destination.js')>(),
 probePostgreSqlPortableDestination:async()=>({destinationWitnessSha256:'a'.repeat(64),identityFingerprintSha256:'b'.repeat(64),nonIdentityDomainsEmpty:remote.empty,existingRun:remote.run}),
}));
vi.mock('../../src/migration/copy-destination.js',async original=>({
 ...await original<typeof import('../../src/migration/copy-destination.js')>(),
 openMigrationCopyDestination:async(input:Record<string,any>)=>{
  const manifest=input.source.describe();
  return {
   admit:async(required:boolean)=>{if(required&&!remote.run)throw new Error('missing');remote.run??={runId:input.runId,targetGenerationId:input.generationId,manifestSha256:manifest.manifestSha256,projectFingerprintSha256:'b'.repeat(64),state:'active'};},
   readBatch:async(batch:PortableBatch)=>remote.receipts.get(batch.checkpoint.checkpointSha256)??null,
   applyBatch:async(batch:PortableBatch)=>{const receipt={checkpoint:batch.checkpoint,batchSha256:canonicalSha256([batch.domain,batch.checkpoint.checkpointSha256])};remote.receipts.set(batch.checkpoint.checkpointSha256,receipt);return receipt;},
   verify:async()=>({complete:true}),readCompleted:async()=>remote.run?.state==='completed',
   complete:async()=>{remote.run!.state='completed';},close:async()=>{},
  };
 },
}));
beforeEach(()=>{remote.run=null;remote.receipts.clear();remote.empty=true;});
async function prepared(multiple=false){
 const fixture=await populatedFixture();
 if(multiple){const db=new DatabaseSync(join(fixture.projectDir,'db.sqlite'));try{for(const session of ['one','two','three'])db.prepare('INSERT INTO session_instruction_cache VALUES (?,?,?,?,?,?,?,?,?)').run(fixture.local.id,canonicalSha256(session),'codex',session,fixture.cwd,fixture.cwd,'captured instructions','e'.repeat(64),'2026-09-07 03:04:05.000');}finally{db.close();}}
 const held=await heldSource(fixture);
 const snapshot=await captureAuthenticatedSqliteMigrationSource(held.authority,held.options);
 const id='018f0b5d-1234-7abc-8def-1234567890ac';
 const input={generationId:snapshot.artifact.generationId,homeDir:fixture.homeDir,settings:fixture.request.targetConfig.postgresql,expectedOwner:'owner',expectedIdentity:{id,remoteProjectId:id,localProjectId:fixture.local.id,machineId:REGISTERED_MACHINE,canonical:fixture.cwd,selectedPath:fixture.cwd},ownerProcessId:'owner',maxRecords:1,maxBytes:150994944};
 const at='2026-09-14T03:00:00.000Z';const witness=await inspectSqliteMigrationCopy({...input,destinationCapturedAt:at});
 const store=new MigrationManifestStore({homeDir:fixture.homeDir});
 let journal=store.create(createMigrationManifest({generationId:input.generationId,source:witness.source,destination:witness.destination,parentGenerationId:null,preservedSourceGenerationId:input.generationId,createdAt:at}));
 journal=store.update(input.generationId,journal.checksumSha256,current=>beginMigrationEffect(current,{kind:'verify-dry-run',effectId:'dryrun',inputSha256:'a'.repeat(64),startedAt:at}));
 store.update(input.generationId,journal.checksumSha256,current=>completeMigrationEffect(current,{effectId:'dryrun',completedAt:at,report:{kind:'dry-run',reportId:'verified',reportSha256:'b'.repeat(64),createdAt:at}}));
 return {input,store,fixture};
}
it('publishes all exact checkpoints and proves copied reruns',async()=>{
 const {input,store}=await prepared();
 const result=await runSqliteMigrationCopy(input);
 expect(result.phase).toBe('copied');expect(result.checkpoints).toHaveLength(22);
 expect(remote.receipts.size).toBe(22);expect(store.read(input.generationId).activationEligible).toBe(false);
 expect(await runSqliteMigrationCopy(input)).toEqual(result);
});
it.each(['after-begin','after-batch-readback','before-checkpoint','after-checkpoint','before-completion','after-completion-readback'] as const)('recovers interruption at %s',async boundary=>{
 const {input}=await prepared();let interrupted=false;
 await expect(runSqliteMigrationCopy(input,{observe:async observed=>{if(observed===boundary&&!interrupted){interrupted=true;throw new Error('interrupted');}}})).rejects.toThrow();
 expect((await runSqliteMigrationCopy(input)).phase).toBe('copied');expect(remote.receipts.size).toBe(22);
});

it('refuses an unrelated populated target without a transfer run',async()=>{
 const {input,store}=await prepared();remote.empty=false;
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(store.read(input.generationId).pendingEffect).toBeNull();expect(remote.receipts.size).toBe(0);
 await expect(inspectSqliteMigrationCopy({...input,destinationCapturedAt:'2026-09-14T03:00:00.000Z'})).rejects.toThrow();
});
it.each(['runId','targetGenerationId','manifestSha256'] as const)('refuses conflicting immutable target %s',async field=>{
 const {input}=await prepared();await runSqliteMigrationCopy(input);remote.run![field]='changed';
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();
});
it('requires the exact earlier receipt even for a locally copied journal',async()=>{
 const {input}=await prepared();await runSqliteMigrationCopy(input);
 const first=remote.receipts.entries().next().value!;
 remote.receipts.set(first[0],{...first[1],batchSha256:'f'.repeat(64)});
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();
 remote.receipts.delete(first[0]);await expect(runSqliteMigrationCopy(input)).rejects.toThrow();
});
it('refuses missing remote admission after local copying has started',async()=>{
 const {input,store}=await prepared();let stopped=false;
 await expect(runSqliteMigrationCopy(input,{observe:async boundary=>{if(boundary==='after-checkpoint'&&!stopped){stopped=true;throw new Error('stop');}}})).rejects.toThrow();
 expect(store.read(input.generationId).phase).toBe('copying');remote.run=null;
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();
});
it('accepts only the exact legal CAS successor after a lost publication acknowledgment',async()=>{
 const {input}=await prepared();const original=MigrationManifestStore.prototype.update;
 vi.spyOn(MigrationManifestStore.prototype,'update').mockImplementationOnce(function(...args){original.apply(this,args);throw new Error('lost acknowledgment');});
 expect((await runSqliteMigrationCopy(input)).phase).toBe('copied');
});
it('leaves conflicting CAS publication unresolved before data mutation',async()=>{
 const {input,store}=await prepared();vi.spyOn(MigrationManifestStore.prototype,'update').mockImplementationOnce(()=>{throw new Error('CAS conflict');});
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.receipts.size).toBe(0);expect(store.read(input.generationId).pendingEffect).toBeNull();
});
it('refuses a pending effect with a different logical input before receipt recovery',async()=>{
 const {input,store}=await prepared();const current=store.read(input.generationId);
 store.update(input.generationId,current.checksumSha256,value=>beginMigrationEffect(value,{kind:'copy-batch',effectId:'different-effect',inputSha256:'f'.repeat(64),startedAt:value.updatedAt}));
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.receipts.size).toBe(0);
});
it('refuses a non-copy pending effect and cancels before source inspection',async()=>{
 const {input,store}=await prepared();const current=store.read(input.generationId);
 store.update(input.generationId,current.checksumSha256,value=>beginMigrationEffect(value,{kind:'abort',effectId:'abort',inputSha256:'f'.repeat(64),startedAt:value.updatedAt}));
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.run).toBeNull();
 await expect(runSqliteMigrationCopy({...input,signal:AbortSignal.abort()})).rejects.toThrow();
});
it('rejects unsupported caller configuration before opening a source or target',async()=>{
 const {input}=await prepared();
 for(const patch of [{ownerProcessId:''},{ownerProcessId:1},{homeDir:''},{homeDir:1},{maxRecords:0},{capturedSidecars:[]},{[Symbol('extra')]:true}])await expect(runSqliteMigrationCopy({...input,...patch} as never)).rejects.toThrow();
 await expect(inspectSqliteMigrationCopy({...input,destinationCapturedAt:'invalid'})).rejects.toThrow();
 await expect(inspectSqliteMigrationCopy({...input,destinationCapturedAt:'2026-09-14T03:00:00Z'})).rejects.toThrow();
 expect(remote.run).toBeNull();
});
it('cancels immediately after an awaited observation without creating a pending effect',async()=>{
 const {input,store}=await prepared();const controller=new AbortController();
 await expect(runSqliteMigrationCopy({...input,signal:controller.signal},{observe:async()=>{controller.abort();}})).rejects.toThrow();
 expect(store.read(input.generationId).pendingEffect).toBeNull();expect(remote.run).toBeNull();
});

import * as sourceApi from '../../src/migration/copy-source.js';
import * as destinationApi from '../../src/migration/copy-destination.js';
import * as targetApi from '../../src/storage/postgresql/portable-destination.js';
import { PostgreSqlCommitOutcomeUnknownError } from '../../src/storage/postgresql/errors.js';
it.each(['inspect','copy'] as const)('preserves uncertain commit from the %s target boundary',async mode=>{
 const {input}=await prepared();const unknown=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 vi.spyOn(targetApi,'probePostgreSqlPortableDestination').mockRejectedValueOnce(unknown);
 await expect(mode==='inspect'?inspectSqliteMigrationCopy({...input,destinationCapturedAt:'2026-09-14T03:00:00.000Z'}):runSqliteMigrationCopy(input)).rejects.toBe(unknown);
});
it.each(['primary','success'] as const)('sanitizes inspection close failure while preserving %s outcome',async outcome=>{
 const {input}=await prepared();const open=sourceApi.openMigrationCopySource;
 vi.spyOn(sourceApi,'openMigrationCopySource').mockImplementationOnce(async args=>{
  const source=await open(args);const close=source.stream.close;
  return {...source,stream:{...source.stream,close:async()=>{await close();throw new Error('private close payload');}}};
 });
 const unknown=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 if(outcome==='primary')vi.spyOn(targetApi,'probePostgreSqlPortableDestination').mockRejectedValueOnce(unknown);
 const operation=inspectSqliteMigrationCopy({...input,destinationCapturedAt:'2026-09-14T03:00:00.000Z'});
 if(outcome==='primary')await expect(operation).rejects.toBe(unknown);
 else await expect(operation).rejects.toMatchObject({name:'MigrationCopyError'});
});
it('reauthenticates the source inside the destination transaction authority callback',async()=>{
 const {input}=await prepared();const open=destinationApi.openMigrationCopyDestination;
 vi.spyOn(destinationApi,'openMigrationCopyDestination').mockImplementationOnce(async args=>{
  await args.withSourceAuthority(async reauthenticate=>{await reauthenticate();});return open(args);
 });
 expect((await runSqliteMigrationCopy(input)).phase).toBe('copied');
});
it.each(['source','destination'] as const)('refuses a changed %s witness before admission',async field=>{
 const {input}=await prepared();const read=MigrationManifestStore.prototype.read;
 vi.spyOn(MigrationManifestStore.prototype,'read').mockImplementationOnce(function(...args){const current=read.apply(this,args);return {...current,[field]:{...current[field],contentSha256:'e'.repeat(64)}};});
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.run).toBeNull();
});
it.each(['source','destination','both'] as const)('sanitizes %s cleanup failure after a completed copy',async failure=>{
 const {input}=await prepared();const sourceOpen=sourceApi.openMigrationCopySource,targetOpen=destinationApi.openMigrationCopyDestination;
 if(failure!=='destination')vi.spyOn(sourceApi,'openMigrationCopySource').mockImplementationOnce(async args=>{const source=await sourceOpen(args);const close=source.stream.close;return {...source,stream:{...source.stream,close:async()=>{await close();throw new Error('private source close');}}};});
 if(failure!=='source')vi.spyOn(destinationApi,'openMigrationCopyDestination').mockImplementationOnce(async args=>{const target=await targetOpen(args);return {...target,close:async()=>{await target.close();throw new Error('private target close');}};});
 await expect(runSqliteMigrationCopy(input)).rejects.toMatchObject({name:'MigrationCopyError'});expect(remote.run?.state).toBe('completed');
});
it('refuses a copied journal when authoritative completion is absent',async()=>{
 const {input}=await prepared();await runSqliteMigrationCopy(input);remote.run!.state='active';
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.run?.state).toBe('active');
});

it('reconstructs every earlier tiny batch before accepting the terminal local prefix',async()=>{
 const {input}=await prepared(true);const result=await runSqliteMigrationCopy(input);expect(remote.receipts.size).toBe(24);
 expect(await runSqliteMigrationCopy(input)).toEqual(result);
});
it('refuses an already aborted signal before source inspection',async()=>{
 const {input}=await prepared();await expect(runSqliteMigrationCopy({...input,signal:AbortSignal.abort()})).rejects.toThrow();expect(remote.run).toBeNull();
});
it.each(['beyond-terminal','between-batches','missing-domain','extra-domain'] as const)('refuses locally claimed %s progress without advancing remote state',async fault=>{
 const {input}=await prepared(true);await runSqliteMigrationCopy(input);const read=MigrationManifestStore.prototype.read;
 vi.spyOn(MigrationManifestStore.prototype,'read').mockImplementationOnce(function(...args){const current=read.apply(this,args);
  const checkpoints=current.checkpoints.map(checkpoint=>checkpoint.domain==='session-instructions'&&fault==='beyond-terminal'?{...checkpoint,ordinal:99}:checkpoint);
  if(fault==='missing-domain')checkpoints.splice(checkpoints.findIndex(checkpoint=>checkpoint.domain==='session-instructions'),1);
  if(fault==='between-batches')checkpoints[checkpoints.findIndex(checkpoint=>checkpoint.domain==='session-instructions')]={...checkpoints.find(checkpoint=>checkpoint.domain==='session-instructions')!,ordinal:0};
  if(fault==='extra-domain')checkpoints.push({...checkpoints[0]!,domain:'unknown-domain'});
  return {...current,checkpoints};
 });
 await expect(runSqliteMigrationCopy(input)).rejects.toThrow();expect(remote.receipts.size).toBe(24);
});
