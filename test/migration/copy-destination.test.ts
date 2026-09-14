import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrationCopyLimits } from '../../src/migration/copy-destination.js';

describe('migration copy bounds',()=>{
  it.each([0,-1,501,NaN,Infinity,1.5])('rejects unsupported record bounds %s',maxRecords=>{
    expect(()=>migrationCopyLimits({maxRecords,maxBytes:1024})).toThrow();
  });
  it('bounds bytes, leases and whole-operation attempts before any target access',()=>{
    for(const input of [{maxBytes:150994945},{leaseTtlMs:999},{leaseTtlMs:86400001},{maximumTransactionAttempts:11},{maximumTransactionAttempts:0}]){
      expect(()=>migrationCopyLimits({maxRecords:1,maxBytes:1024,...input})).toThrow();
    }
    expect(migrationCopyLimits({maxRecords:1,maxBytes:1024})).toEqual({maxRecords:1,maxBytes:1024,leaseTtlMs:300000,maximumTransactionAttempts:3});
  });
});

it('reads committed proof after response loss instead of repeating the mutation',async()=>{
  const { settleMigrationCopyOperation } = await import('../../src/migration/copy-destination.js');
  const { PostgreSqlCommitOutcomeUnknownError } = await import('../../src/storage/postgresql/errors.js');
  let durable=0; const events:string[]=[];
  const result=await settleMigrationCopyOperation({maximumTransactionAttempts:3,
    mutate:async()=>{durable++;events.push('commit');throw new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});},
    reconnect:async()=>{events.push('reconnect');},readback:async()=>{events.push('proof');return durable===1?'exact':null;}});
  expect(result).toBe('exact');expect(durable).toBe(1);expect(events).toEqual(['commit','reconnect','proof']);
});
it('requires proof even after acknowledged commit and leaves unavailable proof unresolved',async()=>{
  const { settleMigrationCopyOperation } = await import('../../src/migration/copy-destination.js');
  let durable=0;
  await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,mutate:async()=>{durable++;},reconnect:async()=>{},readback:async()=>{throw new Error('unavailable');}})).rejects.toThrow();
  expect(durable).toBe(1);
});

const state=vi.hoisted(()=>({run:false,completed:false,receipt:false,lease:false,fences:0,expires:false,owned:true,locked:true,
 failure:'' as string,closed:0,writerClosed:0,transactions:0,renew:false}));
vi.mock('../../src/storage/postgresql/runtime.js',()=>({PostgreSqlRuntime:class{
 constructor(){if(state.failure.includes('runtime-construction'))throw new Error('runtime construction');}
 async query(){throw new Error('unscoped mutation');}
 async transaction<T>(operation:(executor:unknown)=>Promise<T>){
  const saved={run:state.run,completed:state.completed,receipt:state.receipt};state.transactions++;
  const executor={transactionScope:'active',query:async()=>({rows:state.locked?[{locked:1}]:[]}),savepoint:async(fn:(value:unknown)=>unknown)=>fn(executor)};
  try{return await operation(executor);}catch(error){Object.assign(state,saved);throw error;}
 }
 async close(){state.closed++;if(state.failure.includes('runtime-close'))throw new Error('runtime close');}
}}));
vi.mock('../../src/storage/postgresql/coordination.js',()=>({PostgreSqlWorkCoordinator:class{
 async acquireLease(){state.lease=state.owned;return state.owned?{fencingToken:1n}:null;}
 async renewLease(){state.renew=true;return state.owned?{fencingToken:1n}:null;}
 async assertLeaseFence(){state.fences++;if(state.expires&&state.fences%2===0)throw new Error('expired');}
 async releaseLease(){state.lease=false;if(state.failure==='release')throw new Error('release');}
}}));
vi.mock('../../src/storage/postgresql/portable-destination.js',()=>({
 createPostgreSqlPortableDestination:async()=>({preflight:async()=>{if(state.failure.includes('preflight'))throw new Error('preflight');return {};},close:async()=>{state.writerClosed++;if(state.failure.includes('writer-close'))throw new Error('writer close');}}),
 admitPortableDestinationInTransaction:async()=>{state.run=true;},
 readPortableRunInTransaction:async()=>state.run?{state:state.completed?'completed':'active'}:null,
 readPortableBatchReceiptInTransaction:async()=>state.receipt?{checkpoint:{nextOrdinal:1},batchSha256:'a'.repeat(64)}:null,
 applyPortableBatchInTransaction:async()=>{state.receipt=true;return {nextOrdinal:1};},
 verifyPortableDestinationComplete:async()=>({complete:true}),
 completePortableDestinationInTransaction:async()=>{state.completed=true;},
 readPortableCompletedRunInTransaction:async()=>state.completed,
}));
beforeEach(()=>{Object.assign(state,{run:false,completed:false,receipt:false,lease:false,fences:0,expires:false,owned:true,locked:true,failure:'',closed:0,writerClosed:0,transactions:0,renew:false});});
async function destination(){
 const api=await import('../../src/migration/copy-destination.js');
 return api.openMigrationCopyDestination({settings:{} as never,expectedOwner:'owner',expectedIdentity:{id:'project',machineId:'machine'},generationId:'generation',runId:'run',source:{describe:()=>({manifestSha256:'b'.repeat(64)})} as never,
  ownerProcessId:'owner',leaseTtlMs:1000,maximumTransactionAttempts:3,withSourceAuthority:async operation=>operation(async()=>{})});
}
it('uses the fenced transaction for admission, data and completion and closes only its lease',async()=>{
 const target=await destination();
 await target.admit(false);expect(state.run).toBe(true);
 expect(await target.readBatch({} as never)).toBeNull();
 expect(await target.applyBatch({} as never)).toMatchObject({checkpoint:{nextOrdinal:1}});
 const proof=await target.verify();expect(await target.readCompleted(proof)).toBe(false);
 await target.complete(proof);expect(await target.readCompleted(proof)).toBe(true);
 expect(state.completed).toBe(true);expect(state.renew).toBe(true);expect(state.fences).toBe(6);
 await target.admit(true);await target.close();expect(state.lease).toBe(false);expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});
it('rolls admission back when the ending fence expires',async()=>{
 state.expires=true;const target=await destination();
 try{await expect(target.admit(false)).rejects.toThrow('expired');expect(state.run).toBe(false);}finally{await target.close();}
});
it('refuses a competing owner before admission',async()=>{
 state.owned=false;const target=await destination();
 try{await expect(target.admit(false)).rejects.toThrow('another worker');expect(state.run).toBe(false);}finally{await target.close();}
});
it('requires a serialized matching run on resume',async()=>{
 const target=await destination();
 try{await expect(target.admit(true)).rejects.toThrow('missing');state.locked=false;await expect(target.admit(true)).rejects.toThrow('serialization');}finally{await target.close();}
});
it.each(['release','runtime-close','writer-close'])('attempts all cleanup when %s fails',async failure=>{
 const target=await destination();await target.admit(false);state.failure=failure;
 await expect(target.close()).rejects.toThrow();expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});
it('closes both owners after preflight refusal',async()=>{
 state.failure='preflight';await expect(destination()).rejects.toThrow('preflight');expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});

it('keeps readback mode after unavailable proof and counts recovery against the same budget',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 let writes=0,reads=0,reconnections=0;
 expect(await settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{writes++;},readback:async()=>{if(++reads===1)throw new Error('unavailable');return 'exact';},reconnect:async()=>{reconnections++;}})).toBe('exact');
 expect({writes,reads,reconnections}).toEqual({writes:1,reads:2,reconnections:1});
});
it('retries whole transactions only for the two supported serialization states',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlStorageOperationError}=await import('../../src/storage/postgresql/errors.js');
 let attempt=0;
 expect(await settleMigrationCopyOperation({maximumTransactionAttempts:4,mutate:async()=>{
  if(++attempt<3)throw new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},attempt===1?'40001':'40P01',true);
 },readback:async()=>true,reconnect:async()=>{throw new Error('unexpected reconnect');}})).toBe(true);
 expect(attempt).toBe(3);
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},'53300',true);},readback:async()=>true,reconnect:async()=>{}})).rejects.toMatchObject({sqlState:'53300'});
});
it('retains uncertainty when serialized absence consumes the remaining budget',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const original=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,mutate:async()=>{throw original;},readback:async()=>null,reconnect:async()=>{}})).rejects.toBe(original);
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:1,mutate:async()=>{},readback:async()=>true,reconnect:async()=>{}})).rejects.toThrow('authoritative');
});
it('reacquires an expired own lease before retrying work',async()=>{
 const target=await destination();await target.admit(false);state.owned=false;
 try{await expect(target.applyBatch({} as never)).rejects.toThrow('another worker');expect(state.receipt).toBe(false);}finally{await target.close();}
});

it.each(['runtime-construction','runtime-construction writer-close'])('releases the writer if %s fails',async failure=>{
 state.failure=failure;await expect(destination()).rejects.toThrow('runtime construction');expect(state.writerClosed).toBe(1);
});

it('preserves uncertain commit when rebuilding the readback connection fails',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const unknown=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw unknown;},
  readback:async()=>null,reconnect:async()=>{throw new Error('connection unavailable');}})).rejects.toBe(unknown);
});

it('preserves proof failure when reconnect also fails',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');const primary=new Error('proof unavailable');
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{},readback:async()=>{throw primary;},reconnect:async()=>{throw new Error('reconnect');}})).rejects.toBe(primary);
});
it('refuses storage failure without a retryable SQLSTATE',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');const {PostgreSqlStorageOperationError}=await import('../../src/storage/postgresql/errors.js');
 const error=new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw error;},readback:async()=>null,reconnect:async()=>{}})).rejects.toBe(error);
});
it('uses a fresh runtime for unknown admission and proves its durable run',async()=>{
 const {PostgreSqlRuntime}=await import('../../src/storage/postgresql/runtime.js');const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const transaction=PostgreSqlRuntime.prototype.transaction;
 const spy=vi.spyOn(PostgreSqlRuntime.prototype,'transaction').mockImplementationOnce(async function(...args){await transaction.apply(this,args);throw new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'admit'});});
 const target=await destination();try{await target.admit(false);expect(state.run).toBe(true);expect(state.closed).toBe(1);}finally{spy.mockRestore();await target.close();}
 expect(state.closed).toBe(2);
});
it('does not acknowledge completion when the exact completed readback is absent',async()=>{
 const api=await import('../../src/storage/postgresql/portable-destination.js');const target=await destination();await target.admit(false);
 const spy=vi.spyOn(api,'readPortableCompletedRunInTransaction').mockResolvedValue(false);
 try{await expect(target.complete(await target.verify())).rejects.toThrow('authoritative');}finally{spy.mockRestore();await target.close();}
});
it('preserves preflight failure when both cleanup operations fail',async()=>{
 state.failure='preflight runtime-close writer-close';await expect(destination()).rejects.toThrow('preflight');expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});
