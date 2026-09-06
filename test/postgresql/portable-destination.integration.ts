import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createPortableRecordStream, PORTABLE_RECORD_DOMAIN_ORDER, type PortableRecordStream } from '../../src/storage/portable-record-stream.js';
import { runPortableTransfer } from '../../src/storage/portable-transfer.js';
import { createPostgreSqlPortableSource } from '../../src/storage/postgresql/portable-source.js';
import { createPostgreSqlPortableDestination } from '../../src/storage/postgresql/portable-destination.js';
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from './harness.js';
import { seedPortablePostgreSql, grantPortablePostgreSql, PORTABLE_POSTGRESQL_FIXTURE } from './portable-fixture.js';

import { seedPortableSqlite, SQLITE_PORTABLE_FIXTURE } from '../storage/sqlite-portable-fixture.js';
import { openSqlitePortableSource, sqlitePortableFileSha256 } from '../../src/storage/sqlite/portable-source.js';
import { PostgreSqlRuntime } from '../../src/storage/postgresql/runtime.js';

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
    await withPostgreSqlTestDatabase('portable-source',async sourceDb=>withPostgreSqlTestDatabase('portable-target',async targetDb=>{
      const {source,destination}=await setup(sourceDb,targetDb);
      const manifest=source.describe();
      expect(manifest.domains.every(domain=>domain.recordCount>0)).toBe(true);
      const result=await runPortableTransfer({source,destination,maxRecords:2});
      expect(result.contentSha256).toBe(manifest.contentSha256);
      const rows=await targetDb.migrator.query({text:'SELECT state FROM lcm.transfer_runs'},context);
      expect(rows.rows).toEqual([{state:'completed'}]);
      const native=await targetDb.migrator.query({text:"SELECT memory_id::text,metadata->>'source' AS source FROM lcm.promoted_memories"},context);
      expect(native.rows).toHaveLength(2);
      expect(native.rows[0]!.memory_id).toMatch(/^[0-9a-f-]{14}4/);
      const statuses=await targetDb.migrator.query({text:'SELECT status FROM lcm.passive_event_inbox ORDER BY status'},context);
      expect(statuses.rows.map(row=>row.status)).toEqual(['applied','pending','quarantined']);
    }));
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
        seedPortableSqlite(path,{projectIdentity:{scope:'shared',projectId:fixture.projectId},identityFacts:{machines:machines.rows,aliases:aliases.rows}});
        const content='private-vector-canary '+Array.from({length:100000},(_,index)=>'portablelexeme'+index.toString(36).padStart(6,'0')).join(' ');
        expect(Buffer.byteLength(content)).toBeLessThan(3*1024*1024);
        const db=new DatabaseSync(path);
        try{db.prepare('UPDATE promoted SET content=? WHERE id=?').run(content,SQLITE_PORTABLE_FIXTURE.memoryId);}finally{db.close();}
        // Prove this is an actual generated-column representation limit rather
        // than a fabricated adapter failure or an oversized portable record.
        await expect(probe.query({text:"SELECT pg_catalog.pg_column_size(pg_catalog.to_tsvector('lcm.search_v1'::regconfig,lcm.normalize_search_text($1)))",values:[content]},context)).rejects.toMatchObject({sqlState:'54000'});
        source=await createPortableRecordStream(await openSqlitePortableSource({databasePath:path,projectIdentity:{scope:'shared',projectId:fixture.projectId},expectedFileSha256:sqlitePortableFileSha256(path),capturedAt:'2026-09-06T12:00:00.000000Z',scratchParent:root}));
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
