import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { createGeneration,createFixtureSource,postgresGeneration,sqliteUnboundGeneration,LOCAL_PROJECT_IDENTITY } from '../fixtures/portable-records.js';
import { createPortableRecordStream,createPortableRecord,serializePortableCheckpoint } from '../../src/storage/portable-record-stream.js';
import { migrationCopyBatchCommitSha256 } from '../../src/migration/batch-copy.js';

it('binds canonical checkpoint UTF8 bytes to the fixed recipe-v1 commit digest',async()=>{
 const generation=createGeneration(postgresGeneration());
 const stream=await createPortableRecordStream(createFixtureSource(generation));
 try{
  const batch=await stream.readBatch({domain:'machines',maxRecords:1,maxBytes:150994944});
  const bytes=serializePortableCheckpoint(batch.checkpoint);
  const checkpointBytes=Buffer.from(bytes).toString('utf8');
  expect(Buffer.from(checkpointBytes,'utf8')).toEqual(Buffer.from(bytes));
  const input={bindingSha256:'a'.repeat(64),runId:'migration-copy-golden',generationId:'copy:golden.1',targetGenerationId:'migration-generation-golden',targetProjectId:'01990000-0000-7000-8000-000000000001',manifestSha256:batch.manifestSha256,batch,batchSha256:'c'.repeat(64)};
  // Keys are explicitly in canonical order. The bytes stay text; they are never
  // parsed and reserialized as a second representation of the checkpoint.
  const preimage=JSON.stringify({batchSha256:input.batchSha256,bindingSha256:input.bindingSha256,checkpointBytes,
   checkpointSha256:batch.checkpoint.checkpointSha256,domain:batch.domain,generationId:input.generationId,
   kind:'migration-copy-batch-commit',manifestSha256:input.manifestSha256,priorCheckpointSha256:batch.priorCheckpointSha256,
   runId:input.runId,targetGenerationId:input.targetGenerationId,targetProjectId:input.targetProjectId,version:1});
  const expected=createHash('sha256').update(preimage,'utf8').digest('hex');
  expect(expected).toBe('0994b16d80db23fafc7ee5d9a51cf052db62039439e4749b9c30d18b06f3a3c5');
  expect(migrationCopyBatchCommitSha256(input)).toBe(expected);
 }finally{await stream.close();}
});

// #623 W6: the issue's required contract is that duplicate detection preserves
// predecessor identity before a batch is accepted, so createPortableBatch does
// not (re)admit a successor whose identitySha256 matches the record it directly
// follows. This proves both halves on the actual stream/copy path (readBatch),
// not a second batch builder: a poisoned successor sharing the predecessor's
// full identity/order is refused, and a legal distinct predecessor-inclusive
// successor is accepted normally.
it('refuses a successor whose identity matches the predecessor, and accepts a legal one',async()=>{
 const generation=createGeneration(sqliteUnboundGeneration());
 const conversations=generation.records.get('conversations')!;
 const predecessor=conversations[0]!;
 // Same value as the predecessor (only the wire ordinal differs): identitySha256
 // and order are both fully derived from value, so this reproduces the exact
 // "successor duplicates predecessor identity" shape, not merely a same-domain
 // record with an unrelated identity.
 const rawOccurrenceOrdinal=(predecessor.value as {occurrenceOrdinal:{$integer:string}}).occurrenceOrdinal.$integer;
 const poisonedSuccessor=createPortableRecord({domain:'conversations',ordinal:1,
  value:{...predecessor.value,occurrenceOrdinal:rawOccurrenceOrdinal},
  context:{projectIdentity:LOCAL_PROJECT_IDENTITY}} as never);
 expect(poisonedSuccessor.identitySha256).toBe(predecessor.identitySha256);

 const poisonedSource=createFixtureSource({description:generation.description,records:generation.records,
  readOverride:input=>(input.domain==='conversations'&&input.afterOrdinal===1&&input.includePredecessor
   ?{predecessor,records:[poisonedSuccessor],complete:false}:undefined)});
 const poisonedStream=await createPortableRecordStream(poisonedSource);
 try{
  const first=await poisonedStream.readBatch({domain:'conversations',maxRecords:1,maxBytes:150994944});
  expect(first.records).toEqual([predecessor]);
  await expect(poisonedStream.readBatch({domain:'conversations',after:first.checkpoint,maxRecords:1,maxBytes:150994944}))
   .rejects.toMatchObject({code:'order-regression'});
 }finally{await poisonedStream.close();}

 const legalStream=await createPortableRecordStream(generation.source);
 try{
  const first=await legalStream.readBatch({domain:'conversations',maxRecords:1,maxBytes:150994944});
  const second=await legalStream.readBatch({domain:'conversations',after:first.checkpoint,maxRecords:1,maxBytes:150994944});
  expect(second.records).toHaveLength(1);
  expect(second.records[0]!.identitySha256).not.toBe(first.records[0]!.identitySha256);
 }finally{await legalStream.close();}
});
