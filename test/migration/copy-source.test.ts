import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  BackendPublicationJournalError,
  assertBackendPublicationConsumerAccess,
  withBackendPublicationAppendBarrier,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import {
  assertMigrationReplayAdmission,
  prepareSqliteMigrationEnrollment,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  classifyImmutableSqliteSnapshot,
  inspectImmutableSqliteSnapshot,
  dryRunAuthenticatedSqliteMigrationSource,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { writeFileSync } from "node:fs";
import * as identityApi from "../../src/machine-identity.js";
import * as publicationApi from "../../src/storage/backend-publication.js";
import * as identityService from "../../src/identity-service.js";
import { type IdentityRepository } from "../../src/identity-service.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import * as connectionApi from "../../src/db/connection.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { getMigrationReceiptEpoch } from "../../src/migration/receipts.js";

import { home, enrollmentFixture, populatedFixture, heldSource, REGISTERED_MACHINE } from "../fixtures/migration-copy.js";
import { openMigrationCopySource } from "../../src/migration/copy-source.js";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";

it("opens authenticated local captures under the target identity and retains main instructions", async () => {
  const fixture = await populatedFixture();
  const db = new DatabaseSync(join(fixture.projectDir, "db.sqlite"));
  db.prepare("INSERT INTO session_instruction_cache VALUES (?,?,?,?,?,?,?,?,?)").run(
    fixture.local.id, "f".repeat(64), "codex", "session", fixture.cwd, fixture.cwd,
    "captured instructions", "e".repeat(64), "2026-09-07 03:04:05.000");
  db.close();
  const held = await heldSource(fixture);
  const snapshot = await captureAuthenticatedSqliteMigrationSource(held.authority, held.options);
  const expectedIdentity = { id: "018f0b5d-1234-7abc-8def-1234567890ac", remoteProjectId: "018f0b5d-1234-7abc-8def-1234567890ac",
    localProjectId: fixture.local.id, machineId: REGISTERED_MACHINE, selectedPath: fixture.cwd, canonical: fixture.cwd };
  const source = await openMigrationCopySource({ generationId: snapshot.artifact.generationId, homeDir: fixture.homeDir, expectedIdentity, scratchParent: fixture.homeDir });
  try {
    expect(source.stream.describe().domains.map(row => row.domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
    const batch = await source.stream.readBatch({ domain: "session-instructions", maxRecords: 1, maxBytes: 150994944 });
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]?.value).toMatchObject({ content: "captured instructions" });
    const api = await import('../../src/migration/copy-source.js');
    const binding = api.bindMigrationCopySource(source, { expectedOwner:'owner', expectedIdentity,
      destinationCapturedAt:'2026-09-07T03:04:05.000Z', targetProbe:{destinationWitnessSha256:'a'.repeat(64),identityFingerprintSha256:'b'.repeat(64),nonIdentityDomainsEmpty:true,existingRun:null} });
    expect(binding.runId).toMatch(/^migration-copy-[a-f0-9]{64}$/);
    expect(binding.binding.generationId).toBe(snapshot.artifact.generationId);
    expect(binding.binding.portableManifestSha256).toBe(source.stream.describe().manifestSha256);
    const extra = await openMigrationCopySource({ generationId:snapshot.artifact.generationId,homeDir:fixture.homeDir,expectedIdentity,scratchParent:fixture.homeDir,capturedSidecars:[] } as never)
      .then(async opened=>{await opened.stream.close();return 'admitted';},()=> 'refused');
    expect(extra).toBe('refused');
    await source.reauthenticate();
    await expect(openMigrationCopySource({ generationId: "wrong-generation", homeDir: fixture.homeDir, expectedIdentity, scratchParent: fixture.homeDir })).rejects.toThrow();
    await expect(openMigrationCopySource({ generationId: snapshot.artifact.generationId, homeDir: fixture.homeDir, expectedIdentity: {...expectedIdentity, localProjectId: "a".repeat(64)}, scratchParent: fixture.homeDir })).rejects.toThrow();
  } finally { await source.stream.close(); }
});

it('binds the original colon generation to legal deterministic target identifiers', async () => {
  const api = await import('../../src/migration/copy-source.js');
  expect(api.migrationCopyTargetGeneration('copy:generation.1')).toMatch(/^migration-generation-[a-f0-9]{64}$/);
  expect(api.migrationCopyTargetGeneration('copy:generation.1')).not.toBe(api.migrationCopyTargetGeneration('copy:generation.2'));
});

it('refuses arbitrary extra capture facts before source admission', async () => {
  await expect(openMigrationCopySource({generationId:'g',homeDir:home(),expectedIdentity:{} as never,scratchParent:home(),capturedSidecars:[]} as never)).rejects.toThrow();
});

import * as evidenceApi from '../../src/migration/queue-evidence.js';
import * as sourceApi from '../../src/storage/sqlite/portable-source.js';
import * as streamApi from '../../src/storage/portable-record-stream.js';
import { readdirSync, symlinkSync, unlinkSync } from 'node:fs';
async function captureFixture(){
 const fixture=await populatedFixture();const held=await heldSource(fixture);
 const snapshot=await captureAuthenticatedSqliteMigrationSource(held.authority,held.options);
 const id='018f0b5d-1234-7abc-8def-1234567890ac';
 return {fixture,snapshot,input:{generationId:snapshot.artifact.generationId,homeDir:fixture.homeDir,scratchParent:fixture.homeDir,
  expectedIdentity:{id,remoteProjectId:id,localProjectId:fixture.local.id,machineId:REGISTERED_MACHINE,canonical:fixture.cwd,selectedPath:fixture.cwd}}};
}
it('refuses every disconnected maintenance field and target identity before opening a stream',async()=>{
 const {input,fixture}=await captureFixture();const actual=publicationApi.readBackendMaintenanceJournal(fixture.homeDir)!;
 const cases=[null,{...actual,phase:'selection-prepared'},{...actual,generationId:'other'},{...actual,checksumSha256:'a'.repeat(64)},
  {...actual,sourceSelectionSha256:'a'.repeat(64)},{...actual,roster:[]},
  ...[{machineId:'other'},{queueCutoff:null},{evidenceSha256:'a'.repeat(64)}].map(change=>({...actual,roster:[{...actual.roster[0],...change}]}))];
 for(const value of cases){const spy=vi.spyOn(publicationApi,'readBackendMaintenanceJournal').mockReturnValue(value as never);try{await expect(openMigrationCopySource(input)).rejects.toThrow();}finally{spy.mockRestore();}}
 for(const change of [{remoteProjectId:'other'},{machineId:'other'},{canonical:'other'},{selectedPath:''},{selectedPath:'/other'}])await expect(openMigrationCopySource({...input,expectedIdentity:{...input.expectedIdentity,...change}})).rejects.toThrow();
 await expect(openMigrationCopySource({...input,[Symbol('extra')]:true})).rejects.toThrow();
 await expect(openMigrationCopySource({...input,signal:AbortSignal.abort()})).rejects.toThrow('cancelled');
});
it('refuses snapshot drift across an awaited authentication boundary',async()=>{
 const {input,snapshot}=await captureFixture();
 vi.spyOn(evidenceApi,'inspectAuthenticatedSqliteMigrationSnapshot').mockResolvedValueOnce(snapshot).mockResolvedValue({...snapshot,checksumSha256:'f'.repeat(64)});
 await expect(openMigrationCopySource(input)).rejects.toThrow('authority');
});
it('rechecks selection and maintenance after asynchronous snapshot inspection',async()=>{
 const {input,fixture}=await captureFixture();
 const inspect=evidenceApi.inspectAuthenticatedSqliteMigrationSnapshot;
 let call=0;
 vi.spyOn(evidenceApi,'inspectAuthenticatedSqliteMigrationSnapshot').mockImplementation(async(...args)=>{
  const snapshot=await inspect(...args);
  if(++call===2)writeFileSync(fixture.metadata,JSON.stringify({cwd:fixture.cwd,changed:true})+'\n',{mode:0o600});
  return snapshot;
 });
 await expect(openMigrationCopySource(input)).rejects.toThrow('authority');
});
it.each([false,true])('preserves setup failure and closes the raw source with close failure=%s',async closeFails=>{
 const {input}=await captureFixture();const open=sourceApi.openSqlitePortableSource;let closed=false;
 vi.spyOn(sourceApi,'openSqlitePortableSource').mockImplementation(async options=>{
  const raw=await open(options);return {describeSource:raw.describeSource,readDomainPage:raw.readDomainPage,verifySource:raw.verifySource,get recoveryArchive(){return raw.recoveryArchive;},close:async()=>{closed=true;await raw.close();if(closeFails)throw new Error('secondary close');}};
 });
 const primary=new Error('source stream setup failed');vi.spyOn(streamApi,'createPortableRecordStream').mockRejectedValue(primary);
 await expect(openMigrationCopySource(input)).rejects.toBe(primary);expect(closed).toBe(true);
});
it('closes a constructed stream when final source reauthentication fails',async()=>{
 const {input}=await captureFixture();const inspect=evidenceApi.inspectAuthenticatedSqliteMigrationSnapshot;const open=sourceApi.openSqlitePortableSource;let closed=false,count=0;
 vi.spyOn(sourceApi,'openSqlitePortableSource').mockImplementation(async options=>{const raw=await open(options);return {describeSource:raw.describeSource,readDomainPage:raw.readDomainPage,verifySource:raw.verifySource,get recoveryArchive(){return raw.recoveryArchive;},close:async()=>{closed=true;await raw.close();}};});
 vi.spyOn(evidenceApi,'inspectAuthenticatedSqliteMigrationSnapshot').mockImplementation(async(...args)=>{if(++count===3)throw new Error('late source drift');return inspect(...args);});
 await expect(openMigrationCopySource(input)).rejects.toThrow('late source drift');expect(closed).toBe(true);
});
it('rejects changed symlink resolution while the captured lexical alias stays fixed',async()=>{
 const fixture=await populatedFixture();const worktree=join(fixture.homeDir,'worktree');const other=join(fixture.homeDir,'other');const alias=join(fixture.homeDir,'alias');
 mkdirSync(worktree);mkdirSync(other);symlinkSync(worktree,alias);
 writeFileSync(projectMapPath(fixture.homeDir),JSON.stringify({[fixture.local.id]:{canonical:fixture.cwd,aliases:[alias]}})+'\n',{mode:0o600});
 const held=await heldSource(fixture);const snapshot=await captureAuthenticatedSqliteMigrationSource(held.authority,held.options);
 const id='018f0b5d-1234-7abc-8def-1234567890ac';
 const source=await openMigrationCopySource({generationId:snapshot.artifact.generationId,homeDir:fixture.homeDir,scratchParent:fixture.homeDir,expectedIdentity:{id,remoteProjectId:id,localProjectId:fixture.local.id,machineId:REGISTERED_MACHINE,canonical:fixture.cwd,selectedPath:alias}});
 try{unlinkSync(alias);symlinkSync(other,alias);await expect(source.reauthenticate()).rejects.toThrow('authority');}finally{await source.stream.close();}
});

import { initializePortableArchive } from '../../src/storage/sqlite/portable-archive.js';
it('preserves the accepted archive remap refusal for a real authenticated capture',async()=>{
 const fixture=await populatedFixture();const db=new DatabaseSync(join(fixture.projectDir,'db.sqlite'));
 initializePortableArchive(db);db.close();
 const held=await heldSource(fixture);const snapshot=await captureAuthenticatedSqliteMigrationSource(held.authority,held.options);
 const id='018f0b5d-1234-7abc-8def-1234567890ac';
 await expect(openMigrationCopySource({generationId:snapshot.artifact.generationId,homeDir:fixture.homeDir,scratchParent:fixture.homeDir,
  expectedIdentity:{id,remoteProjectId:id,localProjectId:fixture.local.id,machineId:REGISTERED_MACHINE,canonical:fixture.cwd,selectedPath:fixture.cwd}})).rejects.toMatchObject({code:'unsupported-capability'});
});

it.each([null,{checksumSha256:'f'.repeat(64)}])('refuses binding after maintenance evidence changes to %j',async changed=>{
 const {input}=await captureFixture();const source=await openMigrationCopySource(input);
 try{
  const api=await import('../../src/migration/copy-source.js');vi.spyOn(publicationApi,'readBackendMaintenanceJournal').mockReturnValue(changed as never);
  expect(()=>api.bindMigrationCopySource(source,{expectedOwner:'owner',expectedIdentity:input.expectedIdentity,destinationCapturedAt:'2026-09-14T03:00:00.000Z',targetProbe:{destinationWitnessSha256:'a'.repeat(64),identityFingerprintSha256:'b'.repeat(64),nonIdentityDomainsEmpty:true,existingRun:null}})).toThrow('authority');
 }finally{await source.stream.close();}
});
