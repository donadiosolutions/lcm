import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { createGeneration,createFixtureSource,postgresGeneration } from '../fixtures/portable-records.js';
import { createPortableRecordStream,serializePortableCheckpoint } from '../../src/storage/portable-record-stream.js';
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
