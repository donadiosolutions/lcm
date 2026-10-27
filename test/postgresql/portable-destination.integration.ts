import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Query, type QueryConfig } from 'pg';
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER, type PortableRecordStream } from '../../src/storage/portable.js';
import { runPortableTransfer } from '../../src/storage/portable.js';
import { createPostgreSqlPortableSource } from '../../src/storage/portable.js';
import { createPostgreSqlPortableDestination } from '../../src/storage/portable.js';
import { listCanonicalHeaders } from '../../src/storage/postgresql/portable-mapping.js';
import type { PostgreSqlQueryExecutor, PostgreSqlQueryOptions } from '../../src/storage/postgresql/contracts.js';
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from './harness.js';
import { seedPortablePostgreSql, grantPortablePostgreSql, PORTABLE_POSTGRESQL_FIXTURE } from './portable-fixture.js';

import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from '../storage/sqlite-portable-fixture.js';
import { openSqlitePortableSource, sqlitePortableFileSha256 } from '../../src/storage/sqlite/portable-source.js';
import { PostgreSqlRuntime } from '../../src/storage/postgresql/runtime.js';
import { PostgreSqlPromotedMemoryRepository } from '../../src/storage/postgresql/memory-repositories.js';
import { openSqlitePortableDestination } from '../../src/storage/sqlite/portable-destination.js';
import { canonicalSha256, PORTABLE_LIMITS } from '../../src/storage/portable-record.js';
import { exportKnowledge, type ExportDocument } from '../../src/portable-knowledge.js';
import { hashProjectPath } from '../../src/project-map.js';
import { withSelectedPostgreSqlProject, restoreRuntimeGrants } from './operational-fixture.js';

import { assertPostgreSqlNativeCounts, assertRuntimeMemory, capture, expectEquivalent, pgSource } from './portable-corpus.js';

import { assertInterruptedPortableTransfer } from "./portable-resume.js";
import { emitCanonicalEvidence } from "./portable-evidence.js";

beforeAll(assertHarnessReady);
const context={domain:'factory',operation:'portableIntegration'} as const;

async function setup(sourceDb:PostgreSqlTestDatabase,targetDb:PostgreSqlTestDatabase){
  const seeded=await seedPortablePostgreSql(sourceDb.migrator);
  await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
  await grantPortablePostgreSql(sourceDb);
  await grantPortablePostgreSql(targetDb,{transfer:true});
  const expectedIdentity=seeded.expectedIdentity;
  const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity}));
  const input={settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity,generationId:'integration-generation',runId:'integration-run'};
  return {source,input,destination:await createPostgreSqlPortableDestination(input)};
}
async function applyEveryDomain(source:PortableRecordStream,destination:Awaited<ReturnType<typeof createPostgreSqlPortableDestination>>,startDomain:'machines'|'project'='machines'){
  for(const domain of PORTABLE_RECORD_DOMAIN_ORDER.slice(PORTABLE_RECORD_DOMAIN_ORDER.indexOf(startDomain))){
    let after;
    do{const batch=await source.readBatch({domain,after,maxRecords:1,maxBytes:150994944});after=await destination.applyBatch(batch);}while(!after.complete);
  }
}

describe('PostgreSQL canonical destination native persistence',()=>{
  it('copies independently seeded22 domains and verifies actual SQL content',async()=>{
    const manifest=await withPostgreSqlTestDatabase('portable-source',async sourceDb=>withPostgreSqlTestDatabase('portable-target',async targetDb=>{
      const {source,input,destination}=await setup(sourceDb,targetDb);
      let readback:PortableRecordStream|undefined;
      try {
        const manifest=source.describe();
        const corpus=await capture(source);
        expect(manifest.domains.every(domain=>domain.recordCount>0)).toBe(true);
        const result=await assertInterruptedPortableTransfer({source,destination,
          reopenDestination:()=>createPostgreSqlPortableDestination(input),
          openWrongDestination:()=>createPostgreSqlPortableDestination({...input,generationId:'wrong-direct-generation'}),
          openDifferentSource:async()=>createPortableRecordStream(await createPostgreSqlPortableSource({
            settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:PORTABLE_POSTGRESQL_FIXTURE.expectedIdentity,
          })),
          async readNativeProgress(){
            const result=await targetDb.migrator.query<{receipts:number;transferredMachines:number;nativeMachines:number}>({
              text:`SELECT (SELECT count(*)::int FROM lcm.transfer_batches WHERE run_id=$1) AS receipts,
                (SELECT count(*)::int FROM lcm.transfer_identities WHERE run_id=$1 AND domain='machines') AS "transferredMachines",
                (SELECT count(*)::int FROM lcm.machines) AS "nativeMachines"`,values:[input.runId],
            },context);
            return result.rows[0];
          },
        });
        expect(result.contentSha256).toBe(manifest.contentSha256);
        const rows=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context);
        expect(rows.rows).toEqual([{state:'completed'}]);
        const native=await targetDb.migrator.query({text:"SELECT memory_id::text,metadata->>'source' AS source FROM lcm.promoted_memories"},context);
        expect(native.rows).toHaveLength(3);
        expect(native.rows[0]!.memory_id).toMatch(/^[0-9a-f-]{14}4/);
        const statuses=await targetDb.migrator.query({text:'SELECT status FROM lcm.passive_event_inbox ORDER BY status'},context);
        expect(statuses.rows.map(row=>row.status)).toEqual(['applied','pending','quarantined']);
        readback=await pgSource(targetDb,PORTABLE_POSTGRESQL_FIXTURE.expectedIdentity);
        expectEquivalent(readback.describe(),manifest);
        expect(await capture(readback)).toEqual(corpus);
        await assertPostgreSqlNativeCounts(targetDb,PORTABLE_POSTGRESQL_FIXTURE.projectId,corpus);
        await assertRuntimeMemory(new PostgreSqlPromotedMemoryRepository(targetDb.runtime,PORTABLE_POSTGRESQL_FIXTURE.projectId),corpus,PORTABLE_POSTGRESQL_FIXTURE.projectId);
        return manifest;
      } finally {
        const closed=await Promise.allSettled([readback?.close(),destination.close(),source.close()]);
        const failure=closed.find(result=>result.status==='rejected');
        if(failure?.status==='rejected') throw failure.reason;
      }
    }));
    emitCanonicalEvidence("postgresql->postgresql", manifest);
  },120000);

  it('retains durable exact receipts across destination reopen and rejects altered replay',async()=>{
    await withPostgreSqlTestDatabase('portable-resume-source',async sourceDb=>withPostgreSqlTestDatabase('portable-resume-target',async targetDb=>{
      const {source,input,destination}=await setup(sourceDb,targetDb);
      const manifest=source.describe();
      let reopened;
      try{
        await destination.admit(manifest,await destination.preflight(manifest,source));
        const batch=await source.readBatch({domain:'machines',maxRecords:500,maxBytes:150994944});
        const checkpoint=await destination.applyBatch(batch);
        await expect(destination.applyBatch({...batch,records:[{...batch.records[0]!,value:{...batch.records[0]!.value,machineId:null}} as never]})).rejects.toMatchObject({code:'invalid-input'});
        await destination.close();
        reopened=await createPostgreSqlPortableDestination(input);
        await reopened.admit(manifest,await reopened.preflight(manifest,source));
        await expect(reopened.applyBatch(batch)).resolves.toEqual(checkpoint);
        const saved=await reopened.readProgress(manifest.manifestSha256);
        expect(saved.checkpoints).toEqual([checkpoint]);
        const receipts=await targetDb.migrator.query({text:'SELECT count(*)::int AS count FROM lcm.transfer_batches'},context);
        expect(receipts.rows).toEqual([{count:1}]);
        await expect(createPostgreSqlPortableDestination({...input,runId:'competing-run'})).rejects.toMatchObject({code:'destination-conflict'});
      }finally{await destination.close();await reopened?.close();await source.close();}
    }));
  },120000);

  it('reconciles a response lost after COMMIT and rejects final native SQL tampering',async()=>{
    await withPostgreSqlTestDatabase('portable-commit-source',async sourceDb=>withPostgreSqlTestDatabase('portable-commit-target',async targetDb=>{
      const {source,destination}=await setup(sourceDb,targetDb);
      try{
        const manifest=source.describe();
        await destination.admit(manifest,await destination.preflight(manifest,source));
        const batch=await source.readBatch({domain:'machines',maxRecords:500,maxBytes:150994944});
        const original=Client.prototype.query;
        let lost=false;
        const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
          const promise=Reflect.apply(original,this,args) as Promise<unknown>;
          if(!lost && (args[0] as {text?:string})?.text==='COMMIT'){
            lost=true;return promise.then(()=>{throw new Error('private-driver-canary');}) as never;
          }
          return promise as never;
        });
        try{await expect(destination.applyBatch(batch)).resolves.toEqual(batch.checkpoint);}finally{spy.mockRestore();}
        expect(lost).toBe(true);
        await applyEveryDomain(source,destination,'project');
        await targetDb.migrator.query({text:"UPDATE lcm.messages SET content='tampered' WHERE message_id=(SELECT min(message_id) FROM lcm.messages)"},context);
        await expect(destination.verifyComplete(manifest)).rejects.toMatchObject({code:'verification-failed'});
        const run=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context);
        expect(run.rows).toEqual([{state:'active'}]);
      }finally{await destination.close();await source.close();}
    }));
  },120000);
  it('refuses completion when another writer commits a canonical row after verification, then completes once it is gone',async()=>{
    await withPostgreSqlTestDatabase('portable-foreign-source',async sourceDb=>withPostgreSqlTestDatabase('portable-foreign-target',async targetDb=>{
      const {source,input,destination}=await setup(sourceDb,targetDb);
      try{
        const manifest=source.describe();
        await destination.admit(manifest,await destination.preflight(manifest,source));
        await applyEveryDomain(source,destination);
        const machine=await targetDb.migrator.query({text:'SELECT machine_id FROM lcm.machines ORDER BY machine_id LIMIT 1'},context);
        const insertForeign=()=>targetDb.migrator.query({text:"INSERT INTO lcm.session_instructions(project_id,machine_id,scope_hash,client_name,session_id,worktree_path,cwd_path,content,content_hash) VALUES ($1,$2,$3,'codex','foreign-session','/foreign','/foreign','Foreign instruction',$4)",values:[input.expectedIdentity.id,machine.rows[0]!.machine_id,'9'.repeat(64),'a'.repeat(64)]},context);
        // The completion transaction is the first read-write transaction after the
        // verification stream; a writer commits just before it begins.
        const original=Client.prototype.query;
        let armed=true;
        const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
          if(armed && (args[0] as {text?:string})?.text==='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'){
            armed=false;
            return insertForeign().then(()=>Reflect.apply(original,this,args)) as never;
          }
          return Reflect.apply(original,this,args) as never;
        });
        try{await expect(destination.verifyComplete(manifest)).rejects.toMatchObject({code:'destination-unexpected-rows'});}finally{spy.mockRestore();}
        expect(armed).toBe(false);
        expect((await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context)).rows).toEqual([{state:'active'}]);
        await targetDb.migrator.query({text:"DELETE FROM lcm.session_instructions WHERE session_id='foreign-session'"},context);
        await expect(destination.verifyComplete(manifest)).resolves.toMatchObject({contentSha256:manifest.contentSha256,complete:true});
        expect((await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context)).rows).toEqual([{state:'completed'}]);
      }finally{await destination.close();await source.close();}
    }));
  },120000);
  it('rolls back native rows if the connection fails immediately before COMMIT, then retries once',async()=>{
    await withPostgreSqlTestDatabase('portable-before-source',async sourceDb=>withPostgreSqlTestDatabase('portable-before-target',async targetDb=>{
      const {source,destination}=await setup(sourceDb,targetDb);
      try{
        const manifest=source.describe();
        await destination.admit(manifest,await destination.preflight(manifest,source));
        for(const domain of ['machines','project','project-aliases'] as const){
          await destination.applyBatch(await source.readBatch({domain,maxRecords:500,maxBytes:150994944}));
        }
        const batch=await source.readBatch({domain:'conversations',maxRecords:1,maxBytes:150994944});
        const original=Client.prototype.query;
        let interrupted=false;
        const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
          if(!interrupted && (args[0] as {text?:string})?.text==='COMMIT'){
            interrupted=true;return Promise.reject(new Error('before-commit-private-canary')) as never;
          }
          return Reflect.apply(original,this,args) as never;
        });
        try{await expect(destination.applyBatch(batch)).rejects.toMatchObject({code:'destination-uncertain'});}finally{spy.mockRestore();}
        expect(interrupted).toBe(true);
        const absent=await targetDb.migrator.query({text:"SELECT (SELECT count(*)::int FROM lcm.conversations) AS native_count,(SELECT count(*)::int FROM lcm.transfer_identities WHERE domain='conversations') AS identity_count,(SELECT count(*)::int FROM lcm.transfer_batches WHERE domain='conversations') AS receipt_count"},context);
        expect(absent.rows).toEqual([{native_count:0,identity_count:0,receipt_count:0}]);
        await expect(destination.applyBatch(batch)).resolves.toEqual(batch.checkpoint);
        await expect(destination.applyBatch(batch)).resolves.toEqual(batch.checkpoint);
        const once=await targetDb.migrator.query({text:'SELECT count(*)::int AS count FROM lcm.conversations'},context);
        expect(once.rows).toEqual([{count:1}]);
        const unchanged=await sourceDb.migrator.query({text:'SELECT count(*)::int AS count FROM lcm.conversations'},context);
        expect(unchanged.rows).toEqual([{count:2}]);
      }finally{await destination.close();await source.close();}
    }));
  },120000);

  it('rejects a global UUID collision owned by another project during preflight without mutation',async()=>{
    await withPostgreSqlTestDatabase('portable-collision-source',async sourceDb=>withPostgreSqlTestDatabase('portable-collision-target',async targetDb=>{
      const {source,destination}=await setup(sourceDb,targetDb);
      try{
        const foreignId='01990000-0000-7000-8000-000000000099';
        await targetDb.migrator.query({text:"INSERT INTO lcm.projects(project_id,identity_key,display_name) VALUES ($1,$2,'Unrelated project')",values:[foreignId,'9'.repeat(64)]},context);
        const memory=await sourceDb.migrator.query<{memory_id:string}>({text:'SELECT memory_id::text FROM lcm.promoted_memories ORDER BY memory_id LIMIT 1'},context);
        await targetDb.migrator.query({text:"INSERT INTO lcm.promoted_memories(memory_id,project_id,content) VALUES ($1,$2,'Preserved unrelated memory')",values:[memory.rows[0]!.memory_id,foreignId]},context);
        await expect(destination.preflight(source.describe(),source)).rejects.toMatchObject({code:'unsupported-capability'});
        const unchanged=await targetDb.migrator.query({text:'SELECT content FROM lcm.promoted_memories'},context);
        expect(unchanged.rows).toEqual([{content:'Preserved unrelated memory'}]);
        const ledger=await targetDb.migrator.query({text:'SELECT count(*)::int AS count FROM lcm.transfer_runs'},context);
        expect(ledger.rows).toEqual([{count:0}]);
      }finally{await destination.close();await source.close();}
    }));
  },120000);

  it('refuses a valid canonical SQLite corpus whose text overflows PostgreSQL generated search before any target mutation',async()=>{
    await withPostgreSqlTestDatabase('portable-search-overflow',async targetDb=>{
      const fixture=await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
      await grantPortablePostgreSql(targetDb,{transfer:true});
      const root=mkdtempSync(join(tmpdir(),'lcm-portable-vector-'));
      const path=join(root,'source.sqlite');
      let source:PortableRecordStream|undefined;
      let destination:Awaited<ReturnType<typeof createPostgreSqlPortableDestination>>|undefined;
      const probe=new PostgreSqlRuntime(settings(targetDb.migratorUrl,{statementTimeoutMs:60000}));
      try{
        const machines=await targetDb.migrator.query<{identityKey:string;machineId:string}>({text:'SELECT identity_key AS "identityKey",machine_id::text AS "machineId" FROM lcm.machines ORDER BY identity_key'},context);
        const aliases=await targetDb.migrator.query<{machineIdentityKey:string;path:string;normalizedPath:string}>({text:'SELECT m.identity_key AS "machineIdentityKey",a.path,a.normalized_path AS "normalizedPath" FROM lcm.project_aliases a JOIN lcm.machines m ON m.machine_id=a.machine_id ORDER BY m.identity_key,a.normalized_path'},context);
        const sqliteCapture=seedPortableSqlite(path,{projectIdentity:{scope:'shared',projectId:fixture.projectId},identityFacts:{machines:machines.rows,aliases:aliases.rows}});
        const content='private-vector-canary '+Array.from({length:100000},(_,index)=>'portablelexeme'+index.toString(36).padStart(6,'0')).join(' ');
        expect(Buffer.byteLength(content)).toBeLessThan(3*1024*1024);
        const db=new DatabaseSync(path);
        try{db.prepare('UPDATE promoted SET content=? WHERE id=?').run(content,SQLITE_PORTABLE_FIXTURE.memoryId);}finally{db.close();}
        // Prove this is an actual generated-column representation limit rather
        // than a fabricated adapter failure or an oversized portable record.
        await expect(probe.query({text:"SELECT pg_catalog.pg_column_size(pg_catalog.to_tsvector('lcm.search_v1'::regconfig,lcm.normalize_search_text($1)))",values:[content]},context)).rejects.toMatchObject({sqlState:'54000'});
        source=await createPortableRecordStream(await openSqlitePortableSource({...sqliteCapture,databasePath:path,projectIdentity:{scope:'shared',projectId:fixture.projectId},expectedFileSha256:sqlitePortableFileSha256(path),capturedAt:'2026-09-06T12:00:00.000000Z',scratchParent:root}));
        destination=await createPostgreSqlPortableDestination({settings:settings(targetDb.runtimeUrl,{statementTimeoutMs:60000}),expectedOwner:'lcm_test_migrator',expectedIdentity:PORTABLE_POSTGRESQL_FIXTURE.expectedIdentity,generationId:'vector-generation',runId:'vector-run',scratchParent:root});
        const error=await destination.preflight(source.describe(),source).then(()=>undefined,error=>error);
        expect(error).toMatchObject({code:'unsupported-capability'});
        expect(String(error)).not.toContain('private-vector-canary');
        expect(error).not.toHaveProperty('cause');
        const counts=await targetDb.migrator.query({text:'SELECT (SELECT count(*)::int FROM lcm.transfer_runs) AS runs,(SELECT count(*)::int FROM lcm.messages) AS messages,(SELECT count(*)::int FROM lcm.promoted_memories) AS memories'},context);
        expect(counts.rows).toEqual([{runs:0,messages:0,memories:0}]);
      }finally{await destination?.close();await source?.close();await probe.close();rmSync(root,{recursive:true,force:true});}
    });
  },120000);

});

it('retains provenance filters and exports all owner-held knowledge after PostgreSQL-SQLite-PostgreSQL transfer',async()=>{
  await withPostgreSqlTestDatabase('portable-self-origin',async origin=>{
    const originSettings=settings(origin.runtimeUrl);
    await grantPortablePostgreSql(origin);
    await withSelectedPostgreSqlProject('portable-self-return',async selected=>{
    const {database:target,project,machine,projectPath,projectRoot,administrator}=selected;
    const localProjectId=hashProjectPath(projectPath);
    const expectedIdentity={id:project.projectId,localProjectId,canonical:projectPath,selectedPath:projectPath,remoteProjectId:project.projectId,machineId:machine.machineId};
    const ownId=PORTABLE_POSTGRESQL_FIXTURE.ownProjectMemoryId;
    const externalId=PORTABLE_POSTGRESQL_FIXTURE.memoryId;
    const ownContent='Own project portable memory';
    const externalContent='External provenance memory';
    await origin.migrator.query({text:'INSERT INTO lcm.machines(machine_id,identity_key,display_name) VALUES ($1,$2,$3)',values:[machine.machineId,machine.identityKey,machine.displayName]},context);
    await origin.migrator.query({text:'INSERT INTO lcm.projects(project_id,identity_key,display_name) VALUES ($1,$2,$3)',values:[project.projectId,localProjectId,project.displayName]},context);
    for(const alias of project.aliases) await origin.migrator.query({text:'INSERT INTO lcm.project_aliases(project_id,machine_id,path,normalized_path) VALUES ($1,$2,$3,$4)',values:[project.projectId,alias.machineId,alias.path,alias.normalizedPath]},context);
    await origin.migrator.query({text:"INSERT INTO lcm.promoted_memories(memory_id,project_id,source_project_id,content) VALUES ($1,$2,$6,$3),($4,$2,'external-project',$5)",values:[ownId,project.projectId,ownContent,externalId,externalContent,project.projectId]},context);
    const targetSettings={...originSettings,url:target.runtimeUrl};
    const transferSql=readFileSync(join(process.cwd(),'src/storage/postgresql/reference/postgresql-transfer-grants.sql'),'utf8').split('\n').filter(line=>!line.startsWith('\\')).join('\n').replaceAll(':"lcm_runtime_role"','"lcm_test_runtime"');
    await administrator.query({text:transferSql},context);
    const path=join(projectRoot,'self-intermediate.sqlite');
    const handles:Array<{close():Promise<void>}>=[];
    try{
      const source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:originSettings,expectedOwner:'lcm_test_migrator',expectedIdentity,scratchParent:projectRoot}));handles.push(source);
      const manifest=source.describe();
      const sqlite=await openSqlitePortableDestination({databasePath:path,mode:'create',projectIdentity:{scope:'shared',projectId:project.projectId},generationIdentitySha256:canonicalSha256('self-provenance'),scratchParent:projectRoot});handles.push(sqlite);
      await runPortableTransfer({source,destination:sqlite,maxRecords:1});
      const intermediate=await createPortableRecordStream(await openSqlitePortableSource({databasePath:path,projectIdentity:{scope:'shared',projectId:project.projectId},expectedFileSha256:sqlitePortableFileSha256(path),capturedAt:'2026-09-06T16:00:00.000000Z',scratchParent:projectRoot}));handles.push(intermediate);
      expect(intermediate.describe().contentSha256).toBe(manifest.contentSha256);
      const destination=await createPostgreSqlPortableDestination({settings:targetSettings,expectedOwner:'lcm_test_migrator',expectedIdentity,generationId:'self-provenance-return',runId:'self-provenance-run',scratchParent:projectRoot});handles.push(destination);
      expect((await runPortableTransfer({source:intermediate,destination,maxRecords:1})).contentSha256).toBe(manifest.contentSha256);
      // A different owner cannot enter this project's reads or export even when
      // its provenance claims the selected project. All rows are private fixtures.
      const foreignProjectId='01990000-0000-7000-8000-000000000099';
      const foreignMemoryId=PORTABLE_POSTGRESQL_FIXTURE.archivedMemoryId;
      const foreignContent='Foreign owner memory must remain private';
      await administrator.query({text:"INSERT INTO lcm.projects(project_id,identity_key,display_name) VALUES ($1,$2,'Foreign export owner')",values:[foreignProjectId,'f'.repeat(64)]},context);
      await administrator.query({text:'INSERT INTO lcm.promoted_memories(memory_id,project_id,source_project_id,content) VALUES ($1,$2,$3,$4)',values:[foreignMemoryId,foreignProjectId,project.projectId,foreignContent]},context);
      const repository=new PostgreSqlPromotedMemoryRepository(target.runtime,project.projectId);
      expect(await repository.getAll({sourceProjectId:project.projectId})).toEqual([expect.objectContaining({id:ownId,content:ownContent,projectId:project.projectId})]);
      expect(await repository.getAll({sourceProjectId:'external-project'})).toEqual([expect.objectContaining({id:externalId,projectId:'external-project'})]);
      // The dedicated transfer profile intentionally exceeds ordinary runtime
      // grants. Restore the isolated role before exercising real CLI admission.
      await administrator.query({text:transferSql.replace(/\bGRANT\b/g,'REVOKE').replace(/\bTO "lcm_test_runtime"/g,'FROM "lcm_test_runtime"')},context);
      await restoreRuntimeGrants(administrator);
      const output=join(projectRoot,'roundtrip-knowledge.json');
      expect(await exportKnowledge(projectPath,{output,skipScrub:true})).toEqual({exported:2,projectCwd:projectPath});
      const document=JSON.parse(readFileSync(output,'utf8')) as ExportDocument;
      expect(document).toMatchObject({version:1,projectCwd:projectPath});
      expect(document.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({content:ownContent,sessionId:null}),
        expect.objectContaining({content:externalContent,sessionId:null}),
      ]));
      expect(document.entries).toHaveLength(2);
      expect(document.entries.some(entry=>entry.content===foreignContent)).toBe(false);
      const foreign=new PostgreSqlPromotedMemoryRepository(target.runtime,foreignProjectId);
      expect(await foreign.getAll()).toEqual([expect.objectContaining({id:foreignMemoryId,content:foreignContent,projectId:project.projectId})]);
    }finally{for(const handle of handles.reverse()) await handle.close();}
    });
  });
},120000);

it('refuses unknown passive-envelope keys and coercible native types before target mutation',async()=>{
  await withPostgreSqlTestDatabase('portable-envelope-source',async sourceDb=>withPostgreSqlTestDatabase('portable-envelope-target',async targetDb=>{
    const fixture=await seedPortablePostgreSql(sourceDb.migrator);
    await seedPortablePostgreSql(targetDb.migrator,{identityOnly:true});
    await grantPortablePostgreSql(sourceDb);
    await grantPortablePostgreSql(targetDb,{transfer:true});
    await sourceDb.migrator.query({text:"UPDATE lcm.passive_event_inbox SET payload=payload || jsonb_build_object('extraEnvelope',repeat('private-extra-canary',100000)) WHERE status='pending'"},context);
    const destination=await createPostgreSqlPortableDestination({settings:settings(targetDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:fixture.expectedIdentity,generationId:'extra-envelope',runId:'extra-envelope'});
    const wireRows:unknown[]=[];
    const original=Client.prototype.query;
    const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
      const watched=(args[0] as {text?:string})?.text?.includes('payload_envelope_supported');
      // Abort-aware snapshot reads submit pg.Query objects. Observe completion
      // without treating the returned Query handle as a Promise or changing
      // the runtime's callback/cancellation path.
      const query=args[0];
      if(watched && query instanceof Query)query.once('end',value=>wireRows.push(...value.rows));
      const result=Reflect.apply(original,this,args);
      if(watched && !(query instanceof Query))return (result as Promise<{rows:unknown[]}>).then(value=>{wireRows.push(...value.rows);return value;}) as never;
      return result as never;
    });
    try{
      const error=await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:fixture.expectedIdentity}).then(async source=>{await source.close();return undefined;},error=>error);
      expect(error).toMatchObject({code:'record-unrepresentable'});
      expect(String(error)).not.toContain('private-extra-canary');
      expect(JSON.stringify(wireRows)).not.toContain('private-extra-canary');
      expect(wireRows.some(row=>(row as {payload_envelope_supported?:boolean}).payload_envelope_supported===false)).toBe(true);
      const counts=await targetDb.migrator.query({text:'SELECT (SELECT count(*)::int FROM lcm.transfer_runs) AS runs,(SELECT count(*)::int FROM lcm.passive_event_inbox) AS events,(SELECT count(*)::int FROM lcm.promoted_memories) AS memories'},context);
      expect(counts.rows).toEqual([{runs:0,events:0,memories:0}]);
      const preserved=await sourceDb.migrator.query({text:"SELECT payload ? 'extraEnvelope' AS extra,payload->>'data' AS data,status FROM lcm.passive_event_inbox WHERE status='pending'"},context);
      expect(preserved.rows).toEqual([{extra:true,data:'pending data',status:'pending'}]);
      const nativePayload={sessionId:'portable-session',sessionSequence:1,category:'context',data:'pending data',priority:0,sourceHook:'fixture',createdAt:'2026-01-02T03:04:05.123456Z'};
      const invalidTypes:ReadonlyArray<readonly [string,unknown]>=[['data',{nested:'opaque-object'}],['data',123],['sessionSequence','1'],['priority','0'],['sessionId',123],['category',false],['sourceHook',null],['createdAt',123]];
      for(const [field,value] of invalidTypes){
        await sourceDb.migrator.query({text:"UPDATE lcm.passive_event_inbox SET payload=$1::jsonb WHERE status='pending'",values:[JSON.stringify({...nativePayload,[field]:value})]},context);
        wireRows.length=0;
        const typeError=await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:fixture.expectedIdentity}).then(async source=>{await source.close();return undefined;},error=>error);
        expect(typeError).toMatchObject({code:'record-unrepresentable'});
        expect(wireRows.some(row=>(row as {payload_envelope_supported?:boolean}).payload_envelope_supported===false)).toBe(true);
        const untouched=await targetDb.migrator.query({text:'SELECT (SELECT count(*)::int FROM lcm.transfer_runs) AS runs,(SELECT count(*)::int FROM lcm.passive_event_inbox) AS events,(SELECT count(*)::int FROM lcm.promoted_memories) AS memories'},context);
        expect(untouched.rows).toEqual([{runs:0,events:0,memories:0}]);
      }
      const opaqueData='{"unknownDataKey":[1,"unchanged"],"spacing":  true}';
      await sourceDb.migrator.query({text:"UPDATE lcm.passive_event_inbox SET payload=$1::jsonb WHERE status='pending'",values:[JSON.stringify({...nativePayload,data:opaqueData})]},context);
      const supported=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:fixture.expectedIdentity}));
      try{
        const events=await supported.readBatch({domain:'passive-events',maxRecords:500,maxBytes:150994944});
        expect(events.records.map(record=>record.value)).toContainEqual(expect.objectContaining({data:opaqueData,disposition:'pending'}));
        expect(events.records.map(record=>(record.value as {disposition:string}).disposition).sort()).toEqual(['applied','pending','quarantined']);
      }finally{await supported.close();}

    }finally{spy.mockRestore();await destination.close();}
  }));
},120000);

it('retains historical source machine authority across unrelated registration, resume and native membership growth',async()=>{
  await withPostgreSqlTestDatabase('r2-machine-source',async sourceDb=>withPostgreSqlTestDatabase('r2-machine-target',async targetDb=>{
    const initial=await setup(sourceDb,targetDb);
    await initial.source.close();await initial.destination.close();
    const root=mkdtempSync(join(tmpdir(),'lcm-pg-machine-authority-'));
    const historicalId='01990000-0000-7000-8000-000000000044';
    const historicalKey='machine:'+'4'.repeat(64);
    let source:PortableRecordStream|undefined;
    let destination:Awaited<ReturnType<typeof createPostgreSqlPortableDestination>>|undefined;
    try{
      for(const db of [sourceDb,targetDb])await db.migrator.query({text:"INSERT INTO lcm.machines(machine_id,identity_key,display_name) VALUES ($1,$2,'Historical machine')",values:[historicalId,historicalKey]},context);
      await sourceDb.migrator.query({text:"INSERT INTO lcm.session_instructions(project_id,machine_id,scope_hash,client_name,session_id,worktree_path,cwd_path,content,content_hash) VALUES ($1,$2,$3,'codex','historical-session','/historical','/historical','Retained historical instruction',$4)",values:[initial.input.expectedIdentity.id,historicalId,'4'.repeat(64),'5'.repeat(64)]},context);
      source=await createPortableRecordStream(await createPostgreSqlPortableSource({settings:settings(sourceDb.runtimeUrl),expectedOwner:'lcm_test_migrator',expectedIdentity:initial.input.expectedIdentity,scratchParent:root}));
      const manifest=source.describe();
      expect(manifest.domains.find(domain=>domain.domain==='machines')!.recordCount).toBe(3);
      const input={...initial.input,scratchParent:root};
      destination=await createPostgreSqlPortableDestination(input);
      await destination.admit(manifest,await destination.preflight(manifest,source));
      const unrelatedId='01990000-0000-7000-8000-000000000055';
      await targetDb.migrator.query({text:"INSERT INTO lcm.machines(machine_id,identity_key,display_name) VALUES ($1,$2,'Unrelated machine')",values:[unrelatedId,'machine:'+'6'.repeat(64)]},context);
      await expect(destination.readProgress(manifest.manifestSha256)).resolves.toMatchObject({checkpoints:[],complete:false});
      await destination.close();
      destination=await createPostgreSqlPortableDestination(input);
      await destination.admit(manifest,await destination.preflight(manifest,source));
      await targetDb.migrator.query({text:'UPDATE lcm.machines SET identity_key=$2 WHERE machine_id=$1',values:[unrelatedId,'machine:'+'7'.repeat(64)]},context);
      await expect(destination.readProgress(manifest.manifestSha256)).resolves.toMatchObject({checkpoints:[],complete:false});
      await targetDb.migrator.query({text:'UPDATE lcm.machines SET identity_key=$2 WHERE machine_id=$1',values:[historicalId,'machine:'+'8'.repeat(64)]},context);
      await expect(destination.readProgress(manifest.manifestSha256)).rejects.toMatchObject({code:'destination-conflict'});
      await targetDb.migrator.query({text:'UPDATE lcm.machines SET identity_key=$2 WHERE machine_id=$1',values:[historicalId,historicalKey]},context);
      await applyEveryDomain(source,destination);
      await expect(destination.verifyComplete(manifest)).resolves.toMatchObject({contentSha256:manifest.contentSha256,complete:true});
      const history=await targetDb.migrator.query({text:'SELECT content FROM lcm.session_instructions WHERE machine_id=$1',values:[historicalId]},context);
      expect(history.rows).toEqual([{content:'Retained historical instruction'}]);
    }finally{await destination?.close();await source?.close();rmSync(root,{recursive:true,force:true});}
  }));
},120000);

/**
 * Poll for the fate of the canonical writer launched inside the completion
 * transaction: either it is waiting on the project advisory fence, or it
 * already committed while completion was still open.
 */
let lastCanonicalWriterActivity='';
async function observeCanonicalWriter(targetDb:PostgreSqlTestDatabase,settled:{value:boolean}):Promise<'blocked'|'committed'|'absent'>{
  for(let attempt=0;attempt<120;attempt+=1){
    if(settled.value)return 'committed';
    // Require the wait to be on an advisory lock specifically. Counting any
    // lock wait would let an unrelated heavyweight lock stand in for the
    // fence and make a passing observation meaningless.
    const waiting=await targetDb.migrator.query<{waiting:number;detail:string|null}>({text:"SELECT count(*) FILTER (WHERE wait_event_type='Lock' AND wait_event='advisory')::int AS waiting, pg_catalog.string_agg(pg_catalog.concat_ws(' ',pid::text,state,wait_event_type,wait_event,pg_catalog.left(query,40)),' | ') AS detail FROM pg_catalog.pg_stat_activity WHERE datname=pg_catalog.current_database() AND pid<>pg_catalog.pg_backend_pid()"},context);
    lastCanonicalWriterActivity=waiting.rows[0]?.detail??'';
    if((waiting.rows[0]?.waiting??0)>0)return 'blocked';
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return 'absent';
}

it('fences a project-scoped canonical writer between the completion recheck and COMMIT',async()=>{
  await withPostgreSqlTestDatabase('fence-source',async sourceDb=>withPostgreSqlTestDatabase('fence-target',async targetDb=>{
    const {source,destination}=await setup(sourceDb,targetDb);
    const settled={value:false};
    let drift:Promise<unknown>=Promise.resolve();
    let injected=false;
    let sawSizes=false;
    let observed:'blocked'|'committed'|'absent'|'unreached'='unreached';
    try{
      const manifest=source.describe();
      await destination.admit(manifest,await destination.preflight(manifest,source));
      await applyEveryDomain(source,destination);
      const original=Client.prototype.query;
      const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
        const promise=Reflect.apply(original,this,args) as Promise<unknown>;
        const statement=(args[0] as {text?:string})?.text;
        if(injected||typeof statement!=='string'||!statement.includes('FROM lcm.conversations r'))return promise as never;
        // Building the portable source also batch-reads conversations with the
        // same payload query, before the completion transaction. Only the
        // recheck reads sizes first, so wait for its size read and inject on
        // the payload read that follows, inside the fence.
        if(statement.includes('__bytes')){sawSizes=true;return promise as never;}
        if(!sawSizes||!statement.includes('__locator'))return promise as never;
        injected=true;
        return promise.then(async result=>{
          // Passing projectId is what makes this a guarded canonical writer:
          // PostgreSqlRuntime.query routes any query carrying a project scope
          // through runTransaction, which takes the shared project publication
          // guard for the whole transaction. The sibling test below drops the
          // project scope and shows that the unguarded path is not fenced.
          drift=targetDb.migrator.query({text:"UPDATE lcm.conversations SET title='fence-canary'"},{...context,projectId:PORTABLE_POSTGRESQL_FIXTURE.projectId});
          void drift.catch(()=>undefined).finally(()=>{settled.value=true;});
          observed=await observeCanonicalWriter(targetDb,settled);
          return result;
        }) as never;
      });
      try{await expect(destination.verifyComplete(manifest)).resolves.toMatchObject({complete:true});}
      finally{spy.mockRestore();}
      expect(injected).toBe(true);
      expect(observed,lastCanonicalWriterActivity).toBe('blocked');
    }finally{
      await drift.catch(()=>undefined);
      await destination.close();
      await source.close();
    }
  }));
},120000);

it('refuses completion when an unguarded writer commits inside the recheck window',async()=>{
  await withPostgreSqlTestDatabase('unguarded-source',async sourceDb=>withPostgreSqlTestDatabase('unguarded-target',async targetDb=>{
    const {source,destination}=await setup(sourceDb,targetDb);
    const settled={value:false};
    let drift:Promise<unknown>=Promise.resolve();
    let injected=false;
    let observed:'blocked'|'committed'|'absent'|'unreached'='unreached';
    try{
      const manifest=source.describe();
      await destination.admit(manifest,await destination.preflight(manifest,source));
      await applyEveryDomain(source,destination);
      const original=Client.prototype.query;
      const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
        const promise=Reflect.apply(original,this,args) as Promise<unknown>;
        const statement=(args[0] as {text?:string})?.text;
        // The size read runs before the payload read for the same domain, so
        // an unfenced commit here lands inside the recheck rather than after
        // it.
        if(injected||typeof statement!=='string'||!statement.includes('__bytes')||!statement.includes('FROM lcm.conversations r'))return promise as never;
        injected=true;
        return promise.then(async result=>{
          // Nothing fences the migrator's autocommit path, so it commits while
          // the completion transaction holds the exclusive lock. The content
          // recheck is what has to refuse the completion.
          drift=targetDb.migrator.query({text:"UPDATE lcm.conversations SET title='unguarded-canary'"},context);
          void drift.catch(()=>undefined).finally(()=>{settled.value=true;});
          observed=await observeCanonicalWriter(targetDb,settled);
          return result;
        }) as never;
      });
      try{await expect(destination.verifyComplete(manifest)).rejects.toMatchObject({code:'verification-failed'});}
      finally{spy.mockRestore();}
      expect(injected).toBe(true);
      expect(observed,lastCanonicalWriterActivity).toBe('committed');
      const runs=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context);
      expect(runs.rows).toEqual([{state:'active'}]);
    }finally{
      await drift.catch(()=>undefined);
      await destination.close();
      await source.close();
    }
  }));
},120000);

it('revalidates project identity after acquiring the completion fence',async()=>{
  await withPostgreSqlTestDatabase('fence-identity-source',async sourceDb=>withPostgreSqlTestDatabase('fence-identity-target',async targetDb=>{
    const {source,destination}=await setup(sourceDb,targetDb);
    let injected=false;
    try{
      const manifest=source.describe();
      await destination.admit(manifest,await destination.preflight(manifest,source));
      await applyEveryDomain(source,destination);
      const original=Client.prototype.query;
      const spy=vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
        const statement=(args[0] as {text?:string})?.text;
        // Match the exclusive fence only; the shared guard spells its own
        // function name with the _shared suffix.
        if(injected||typeof statement!=='string'||!statement.includes('pg_advisory_xact_lock('))return Reflect.apply(original,this,args) as never;
        injected=true;
        return (async()=>{
          // An identity change committed after the pre-lock identity check and
          // before the fence is granted. What matters is the timing, not the
          // writer's path: the ledger recheck skips IDENTITY_DOMAINS, so only
          // the identity revalidation that runs under the fence can catch it.
          await targetDb.migrator.query({text:'UPDATE lcm.machines SET identity_key=$2 WHERE machine_id=$1',values:[PORTABLE_POSTGRESQL_FIXTURE.machineId,'machine:'+'9'.repeat(64)]},context);
          return await (Reflect.apply(original,this,args) as Promise<unknown>);
        })() as never;
      });
      try{await expect(destination.verifyComplete(manifest)).rejects.toMatchObject({code:'destination-conflict'});}
      finally{spy.mockRestore();}
      expect(injected).toBe(true);
      const runs=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context);
      expect(runs.rows).toEqual([{state:'active'}]);
    }finally{
      await destination.close();
      await source.close();
    }
  }));
},120000);

describe('PostgreSQL canonical source header pages',()=>{
  it('cuts a multi-row header page by aggregate locator bytes in SQL and resumes without gaps or repeats (#1388)',async()=>{
    await withPostgreSqlTestDatabase('portable-header-bound',async db=>{
      const {projectId,machineId}=await seedPortablePostgreSql(db.migrator,{identityOnly:true});
      // Five checkpoints whose only unbounded key column holds about 1 KiB each.
      await db.migrator.query({text:`INSERT INTO lcm.ingest_checkpoints (project_id, machine_id, client_name, source_locator)
        SELECT $1::uuid, $2::uuid, 'codex', chr(97 + i) || repeat('x', 1023) FROM generate_series(0, 4) AS i`,values:[projectId,machineId]},context);
      const captured:QueryConfig<unknown[]>[]=[];
      const recording:PostgreSqlQueryExecutor={query:(config:QueryConfig<unknown[]>,options:PostgreSqlQueryOptions)=>{captured.push(config);return db.migrator.query(config,options);}} as PostgreSqlQueryExecutor;
      // Locators are PostgreSQL json text, which separates elements with ", ".
      const expected=['a','b','c','d','e'].map(letter=>`["${machineId}", "codex", "${letter}${'x'.repeat(1023)}"]`);
      // At the production bound the five ~1 KiB locators form one page in C order.
      const full=await listCanonicalHeaders(recording,projectId,'native-transcript-checkpoints',null,500);
      expect(full.map(header=>header.locator)).toEqual(expected);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.values).toEqual([projectId,null,500,String(PORTABLE_LIMITS.maxBatchBytes)]);
      // Every locator key column is a btree primary-key member, so PostgreSQL
      // caps each key near 2.7 KiB and real rows cannot reach the 144 MiB
      // aggregate. Prove the cut with the exact production SQL text and its
      // bound parameter set to two locators: the third row of the ordered
      // scan then exceeds the running sum, while a single row always fits.
      const budget=Buffer.byteLength(expected[0]!)+Buffer.byteLength(expected[1]!);
      const sql=captured[0]!.text;
      const run=async(after:string|null,bound:number)=>(await db.migrator.query<{locator:string;byteLength:string}>({text:sql,values:[projectId,after===null?null:JSON.parse(after),500,String(bound)]},context)).rows;
      const pages:string[][]=[];
      for(let after:string|null=null;;){
        const rows=await run(after,budget);
        if(rows.length===0)break;
        pages.push(rows.map(row=>row.locator));
        after=rows.at(-1)!.locator;
      }
      expect(pages).toEqual([[expected[0],expected[1]],[expected[2],expected[3]],[expected[4]]]);
      // Below every row's own size the single-row semantics are unchanged: the
      // locator is suppressed, the real size still travels, and the empty
      // locators add nothing to the running sum, so no row is hidden.
      const suppressed=await run(null,1);
      expect(suppressed.map(row=>row.locator)).toEqual(['','','','','']);
      expect(suppressed.map(row=>row.byteLength)).toEqual(full.map(header=>header.byteLength));
      expect(suppressed.every(row=>BigInt(row.byteLength)>1n)).toBe(true);
      expect(await run(null,budget).then(rows=>rows.length)).toBe(2);
    });
  },60000);
});
