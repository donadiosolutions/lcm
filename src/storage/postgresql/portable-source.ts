import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { normalizeUuidV7 } from "../../machine-identity.js";
import { normalizeProjectPath } from "../../project-map.js";
import type { StorageIdentityContext } from "../contracts.js";
import {
  PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256,
  PortableStreamError, canonicalJson, createPortableRecord, serializePortableRecord, sha256,
  type PortableDomain, type PortableOrderScalar, type PortableRawConversationOrder,
  type PortableRawMessageOrder, type PortableRecord,
} from "../portable-record.js";
import type {
  PortableRecordSource, PortableSourceDescription, PortableSourcePageInput,
  PortableSourceVerificationInput,
} from "../portable-record-stream.js";
import type {
  PostgreSqlConnectionSettings, PostgreSqlQueryExecutor, PostgreSqlRuntimeHealth,
} from "./contracts.js";
import { PostgreSqlRuntime } from "./runtime.js";
import { verifyPostgreSqlRuntimeSchema, verifyPostgreSqlTransferSchema } from "./runtime-readiness.js";
import { PortableTransferError } from "../portable-transfer.js";
import { createPortableIndex, type PortableIndex } from "../portable-index.js";
import {
  decodeCanonicalRow, listCanonicalHeaders, listConversationMessageHeaders,
  readCanonicalRow,
} from "./portable-mapping.js";

type Snapshot = PostgreSqlQueryExecutor & {
  readonly identity: Readonly<{ sessionId: string; backendPid: number; projectId: string }>;
  close(): Promise<void>;
};
type SourceRuntime = PostgreSqlQueryExecutor & {
  health(): Promise<PostgreSqlRuntimeHealth>;
  openReadOnlySnapshot(options: { projectId: string; signal?: AbortSignal }): Promise<Snapshot>;
  close(): Promise<void>;
};

export interface PostgreSqlPortableSourceOptions {
  readonly settings: PostgreSqlConnectionSettings;
  readonly expectedOwner: string;
  readonly expectedIdentity: StorageIdentityContext;
  readonly admission?: "runtime" | "transfer";
  /** Parent directory for the source-owned bounded disk index. */
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
}

/** Internal dependency seam; the curated facade exposes only the one-argument opener. */
export interface PostgreSqlPortableSourceDependencies {
  createRuntime(settings: PostgreSqlConnectionSettings): SourceRuntime;
  verifyRuntimeSchema: typeof verifyPostgreSqlRuntimeSchema;
  verifyTransferSchema?: typeof verifyPostgreSqlTransferSchema;
  normalizePath(path: string): string;
}
const dependencies: PostgreSqlPortableSourceDependencies = {
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
  verifyTransferSchema: verifyPostgreSqlTransferSchema,
  normalizePath: normalizeProjectPath,
};
const brands = new WeakMap<PortableRecordSource, string>();

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortableStreamError("aborted");
}
function safeError(error: unknown): PortableStreamError {
  if (error instanceof PortableStreamError) return error;
  if (error instanceof PortableTransferError) {
    if (error.code === "aborted") return new PortableStreamError("aborted");
    if (error.code === "unsupported-capability") return new PortableStreamError("record-unrepresentable");
    if (error.code === "invalid-input") return new PortableStreamError("source-invalid");
  }
  return new PortableStreamError("source-unavailable");
}
function invalid(): never { throw new PortableStreamError("source-invalid"); }
function rawOrder(order: readonly PortableOrderScalar[]): unknown[] {
  return order.map((value) => value !== null && typeof value === "object" ? value.$integer : value);
}
function identityHash(identity: StorageIdentityContext): string {
  return sha256(canonicalJson([identity.id, identity.remoteProjectId,
    identity.machineId, identity.localProjectId, identity.selectedPath]));
}
function assertIdentity(identity: StorageIdentityContext): void {
  if (normalizeUuidV7(identity.id) !== identity.id
      || identity.remoteProjectId !== identity.id
      || typeof identity.machineId !== "string" || normalizeUuidV7(identity.machineId) !== identity.machineId
      || typeof identity.localProjectId !== "string" || !/^[a-f0-9]{64}$/u.test(identity.localProjectId)
      || typeof identity.selectedPath !== "string" || !isAbsolute(identity.selectedPath)
      || /[\0-\x1f\x7f]/u.test(identity.selectedPath)) invalid();
}
async function registeredIdentity(executor: PostgreSqlQueryExecutor, identity: StorageIdentityContext,
  normalizedPath: string, signal?: AbortSignal): Promise<void> {
  abort(signal);
  const result = await executor.query({text: `SELECT EXISTS (
    SELECT 1 FROM lcm.projects p JOIN lcm.project_aliases a ON a.project_id = p.project_id
    JOIN lcm.machines m ON m.machine_id = a.machine_id
    WHERE p.project_id = $1::uuid AND m.machine_id = $2::uuid
      AND a.path = $3 AND a.normalized_path = $4) AS admitted`,
  values: [identity.id, identity.machineId, identity.selectedPath, normalizedPath]},
  {domain:"identity",operation:"portableRegisteredIdentity",signal});
  if (result.rows.length !== 1 || result.rows[0].admitted !== true) invalid();
  abort(signal);
}

/** Physical database/project witness shared with destination self-copy refusal. */
export async function readPostgreSqlPortableWitness(executor: PostgreSqlQueryExecutor,
  projectId: string, signal?: AbortSignal): Promise<string> {
  abort(signal);
  const result = await executor.query({text: `SELECT current_database() AS database_name,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
    inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port`},
  {domain:"factory",operation:"portableSourceWitness",signal});
  const row=result.rows[0];
  if (result.rows.length !== 1 || !row || [row.database_name,row.database_oid,row.server_address,row.server_port]
    .some((value) => typeof value !== "string" || value.length === 0)) invalid();
  return sha256(canonicalJson({databaseName:row.database_name,databaseOid:row.database_oid,
    serverAddress:row.server_address,serverPort:row.server_port,projectId}));
}
async function snapshotState(session: Snapshot, signal?: AbortSignal): Promise<string> {
  abort(signal);
  const result = await session.query({text: `SELECT pg_backend_pid() AS backend_pid,
    COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls,
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`},
  {domain:"factory",operation:"portableSnapshotState",signal});
  const row=result.rows[0];
  if (result.rows.length !== 1 || !row || row.backend_pid !== session.identity.backendPid
    || row.tls !== true || row.isolation !== "repeatable read" || row.read_only !== "on"
    || typeof row.captured_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.captured_at)) invalid();
  abort(signal);
  return row.captured_at;
}

function assertHeaderLength(length: string): void {
  if (!/^(0|[1-9]\d*)$/u.test(length)) invalid();
  if (BigInt(length) > BigInt(PORTABLE_LIMITS.maxBatchBytes)) throw new PortableStreamError("record-unrepresentable");
}

/** Opens one owned read-only snapshot; its identity cannot survive session replacement. */
export async function createPostgreSqlPortableSource(options: PostgreSqlPortableSourceOptions,
  injected: PostgreSqlPortableSourceDependencies = dependencies): Promise<PortableRecordSource> {
  let runtime: SourceRuntime | undefined;
  let session: Snapshot | undefined;
  let index: PortableIndex | undefined;
  try {
    abort(options.signal);
    assertIdentity(options.expectedIdentity);
    const expectedHash=identityHash(options.expectedIdentity);
    const expectedIdentity=structuredClone(options.expectedIdentity);
    const normalizedPath=injected.normalizePath(expectedIdentity.selectedPath!);
    runtime=injected.createRuntime(options.settings);
    const health=await runtime.health();
    if (health.status !== "healthy" || health.tls !== true || health.serverMajorVersion !== 18
      || health.serverEncoding !== "UTF8") invalid();
    abort(options.signal);
    const verify=options.admission === "transfer" ? injected.verifyTransferSchema : injected.verifyRuntimeSchema;
    if (!verify) invalid();
    await verify(runtime,{expectedOwner:options.expectedOwner,signal:options.signal});
    await registeredIdentity(runtime,expectedIdentity,normalizedPath,options.signal);
    session=await runtime.openReadOnlySnapshot({projectId:expectedIdentity.id,signal:options.signal});
    if (session.identity.projectId !== expectedIdentity.id) invalid();
    await registeredIdentity(session,expectedIdentity,normalizedPath,options.signal);
    const capturedAt=await snapshotState(session,options.signal);
    const sourceWitnessSha256=await readPostgreSqlPortableWitness(session,expectedIdentity.id,options.signal);
    const sourceIdentitySha256=sha256(canonicalJson(["lcm-postgresql-snapshot-v1",sourceWitnessSha256,session.identity]));
    index=createPortableIndex({scratchParent:options.scratchParent,signal:options.signal});
    return await buildSource({options, runtime, session,index,expectedHash,expectedIdentity,normalizedPath,
      capturedAt,sourceIdentitySha256,sourceWitnessSha256});
  } catch (error) {
    try { index?.close(); } catch { /* Preserve primary sanitized failure. */ }
    try { await session?.close(); } catch { /* Runtime must still be released. */ }
    try { await runtime?.close(); } catch { /* Preserve primary sanitized failure. */ }
    throw safeError(error);
  }
}

type BuildInput = {
  options: PostgreSqlPortableSourceOptions; runtime: SourceRuntime; session: Snapshot; index: PortableIndex;
  expectedHash: string; expectedIdentity: StorageIdentityContext; normalizedPath: string;
  capturedAt: string; sourceIdentitySha256: string; sourceWitnessSha256: string;
};
function appendDigest(previous: string, bytes: Uint8Array): string {
  const length=Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return sha256(Buffer.concat([Buffer.from(previous,"hex"),length,bytes]));
}
function initialPrefix(domain: PortableDomain): string {
  return sha256(canonicalJson(["lcm-portable-domain-v1",PORTABLE_RECORD_SCHEMA_SHA256,domain,1]));
}

async function buildSource(input: BuildInput): Promise<PortableRecordSource> {
  const {options,runtime,session,index,expectedIdentity,expectedHash,normalizedPath}=input;
  const projectIdentity={scope:"shared",projectId:expectedIdentity.id} as const;
  const sessionHash=sha256(canonicalJson(session.identity));
  const counts=new Map<PortableDomain,number>();

  const queryRow=async (domain: PortableDomain, locator: string, signal?: AbortSignal) => {
    abort(signal); abort(options.signal);
    const row=await readCanonicalRow(session,expectedIdentity.id,domain,locator,signal);
    if (row === null) invalid();
    return row;
  };
  const draftConversation=(row: Record<string,unknown>, occurrenceOrdinal: string) => createPortableRecord({
    ...decodeCanonicalRow("conversations",row,{projectIdentity,occurrenceOrdinal,
      conversationFingerprint:sha256(canonicalJson(["lcm-portable-conversation-value-v1",
        row.session_id,row.title,row.bootstrapped_at,row.created_at,row.updated_at]))}),ordinal:0,
  }) as PortableRecord<"conversations">;
  const closure=async function* (locator: string, signal?: AbortSignal): AsyncGenerator<string> {
    const row=await queryRow("conversations",locator,signal);
    const conversation=draftConversation(row,"0");
    const value=conversation.value;
    yield `["lcm-portable-conversation-closure-v1",{"bootstrappedAt":${canonicalJson(value.bootstrappedAt)},"createdAt":${canonicalJson(value.createdAt)},"messages":[`;
    let afterSeq: string | null=null;
    let first=true;
    while (true) {
      abort(signal); abort(options.signal);
      const headers=await listConversationMessageHeaders(session,expectedIdentity.id,String(row.conversation_id),afterSeq,1,signal);
      if (headers.length === 0) break;
      const header=headers[0]; assertHeaderLength(header.byteLength);
      const messageRow=await queryRow("messages",header.locator,signal);
      const message=createPortableRecord({...decodeCanonicalRow("messages",messageRow,{projectIdentity,
        conversation:{identitySha256:conversation.identitySha256,
          order:rawOrder(conversation.order) as unknown as PortableRawConversationOrder}}),ordinal:0}) as PortableRecord<"messages">;
      const m=message.value;
      yield `${first ? "" : ","}${canonicalJson([m.seq,m.role,m.content,m.tokenCount,m.createdAt])}`;
      first=false;
      const next=m.seq.$integer;
      if (afterSeq !== null && BigInt(next) <= BigInt(afterSeq)) invalid();
      afterSeq=next;
    }
    yield `],"sessionId":${canonicalJson(value.sessionId)},"title":${canonicalJson(value.title)},"updatedAt":${canonicalJson(value.updatedAt)}}]`;
  };
  const eachHeader=async (domain: PortableDomain, visit:(locator:string)=>Promise<void>) => {
    let after: string | null=null;
    while (true) {
      abort(options.signal);
      const headers=await listCanonicalHeaders(session,expectedIdentity.id,domain,after,1,options.signal);
      if (headers.length === 0) break;
      if (headers.length > 1) invalid();
      for (const header of headers) {
        assertHeaderLength(header.byteLength);
        if (header.locator === after) invalid();
        await visit(header.locator);
        after=header.locator;
      }
    }
  };
  await eachHeader("conversations",async (locator) => {
    const row=await queryRow("conversations",locator,options.signal);
    const record=draftConversation(row,"0");
    const digest=createHash("sha256");
    for await (const chunk of closure(locator,options.signal)) digest.update(chunk);
    index.addConversation({locator,headerOrder:record.order.slice(0,5),closureSha256:digest.digest("hex")});
  });
  await index.finalizeConversations(async(left,right) => {
    const l=closure(left,options.signal),r=closure(right,options.signal);
    try {
      while (true) {
        const a=await l.next(), b=await r.next();
        if (a.done || b.done) return a.done === b.done;
        if (a.value !== b.value) return false;
      }
    } finally { await l.return(undefined); await r.return(undefined); }
  });
  const recordAt=async(domain:PortableDomain,locator:string,ordinal:number,signal?:AbortSignal):Promise<PortableRecord> => {
    const row=await queryRow(domain,locator,signal);
    const parent=(parentDomain:"conversations"|"messages",column:string) => {
      if (row[column] === undefined || row[column] === null || domain === parentDomain) return undefined;
      const located=index.lookup(parentDomain,JSON.stringify([String(row[column])]));
      if (located === null) invalid();
      return {identitySha256:located.identitySha256,order:rawOrder(located.order)};
    };
    const conversation=parent("conversations","conversation_id");
    const message=parent("messages","message_id");
    let occurrenceOrdinal: string | undefined;
    if (domain === "conversations") {
      const occurrence=index.conversation(locator);
      if (occurrence === null) invalid();
      return createPortableRecord({...decodeCanonicalRow(domain,row,{projectIdentity,
        occurrenceOrdinal:String(occurrence.occurrenceOrdinal),
        conversationFingerprint:sha256(canonicalJson(["lcm-portable-conversation-value-v1",
          row.session_id,row.title,row.bootstrapped_at,row.created_at,row.updated_at]))}),ordinal});
    }
    if (domain === "recall-surfacings") {
      const existing=index.lookup(domain,locator);
      occurrenceOrdinal=existing === null
        ? String(index.allocateOccurrence(domain,canonicalJson([row.memory_id,row.session_id,row.surfaced_at])))
        : String(rawOrder(existing.order).at(-1));
    }
    return createPortableRecord({...decodeCanonicalRow(domain,row,{projectIdentity,localProjectId:expectedIdentity.localProjectId,
      conversation:conversation as {identitySha256:string;order:PortableRawConversationOrder}|undefined,
      message:message as {identitySha256:string;order:PortableRawMessageOrder}|undefined,occurrenceOrdinal}),ordinal});
  };
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let count=0;
    await eachHeader(domain,async(locator) => {
      const draft=await recordAt(domain,locator,0,options.signal);
      index.add(locator,draft);
      count++;
    });
    index.finalizeDomain(domain); counts.set(domain,count);
  }
  index.verifyDependencies();
  type BoundaryEvidence={prefix:string;last:{recordSha256:string;identitySha256:string}|null};
  // This private bounded disk index is created once per admitted session. Store
  // digests at final canonical ordinals, never caller checkpoints or payloads.
  const prefixScope=(domain:PortableDomain) => `${input.sourceIdentitySha256}/${domain}`;
  const cachedBoundary=(domain:PortableDomain,nextOrdinal:number):BoundaryEvidence => {
    if (nextOrdinal === 0) return {prefix:initialPrefix(domain),last:null};
    const encoded=index.getScope(prefixScope(domain),String(nextOrdinal));
    if (encoded === null) invalid();
    return JSON.parse(encoded) as BoundaryEvidence;
  };
  const checkedRecordAt=async(domain:PortableDomain,locator:string,ordinal:number,signal?:AbortSignal) => {
    const record=await recordAt(domain,locator,ordinal,signal);
    const expected=cachedBoundary(domain,ordinal+1).last;
    if (expected?.recordSha256 !== record.recordSha256 || expected.identitySha256 !== record.identitySha256) {
      throw new PortableStreamError("source-changed");
    }
    return record;
  };
  const readOrdinal=async(domain:PortableDomain,ordinal:number,signal?:AbortSignal) => {
    const entry=index.entries(domain,{afterOrdinal:ordinal-1,limit:1,maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal})[0];
    if (entry === undefined) invalid();
    return checkedRecordAt(domain,entry.locator,entry.ordinal,signal);
  };
  const boundaryAt=async(domain:PortableDomain,nextOrdinal:number,capture:boolean,signal?:AbortSignal) => {
    let prefix=initialPrefix(domain);
    let last:BoundaryEvidence["last"]=null;
    let ordinal=0;
    while (ordinal < nextOrdinal) {
      const entries=index.entries(domain,{afterOrdinal:ordinal-1,limit:Math.min(500,nextOrdinal-ordinal),
        maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal});
      if (entries.length === 0) invalid();
      for (const entry of entries) {
        const record=await (capture ? recordAt : checkedRecordAt)(domain,entry.locator,entry.ordinal,signal);
        prefix=appendDigest(prefix,serializePortableRecord(record));
        last={recordSha256:record.recordSha256,identitySha256:record.identitySha256};ordinal++;
        if (capture) index.bindScope(prefixScope(domain),String(ordinal),JSON.stringify({prefix,last}));
      }
    }
    return {prefix,last};
  };
  let contentSha256=sha256(canonicalJson(["lcm-portable-content-v1",PORTABLE_RECORD_SCHEMA_SHA256]));
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const terminal=await boundaryAt(domain,counts.get(domain)!,true,options.signal);
    contentSha256=appendDigest(contentSha256,Buffer.from(terminal.prefix,"hex"));
  }
  const coverage=Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain,Object.freeze({
    state:"available" as const,evidenceSha256:sha256(canonicalJson([input.sourceIdentitySha256,domain])),
  })])) as PortableSourceDescription["coverage"];
  const description:PortableSourceDescription=Object.freeze({capturedAt:input.capturedAt,
    sourceIdentitySha256:input.sourceIdentitySha256,sourceWitnessSha256:input.sourceWitnessSha256,
    coverage:Object.freeze(coverage)});
  let closed=false;
  let tail:Promise<void>=Promise.resolve();
  let closePromise:Promise<void>|undefined;
  const stable=() => {
    if (closed || brands.get(source) !== expectedHash) throw new PortableStreamError("closed");
    if (identityHash(options.expectedIdentity) !== expectedHash
      || sha256(canonicalJson(session.identity)) !== sessionHash) throw new PortableStreamError("source-changed");
  };
  const authenticate=async(signal?:AbortSignal) => {
    stable();abort(signal);abort(options.signal);
    await registeredIdentity(session,expectedIdentity,normalizedPath,signal);
    if (await snapshotState(session,signal) !== input.capturedAt) throw new PortableStreamError("source-changed");
    stable();abort(signal);abort(options.signal);
  };
  const enqueue=<T>(work:()=>Promise<T>):Promise<T> => {
    try { stable(); } catch(error) { return Promise.reject(safeError(error)); }
    const result=tail.then(work).catch((error) => { throw safeError(error); });
    tail=result.then(()=>undefined,()=>undefined);
    return result;
  };
  const source:PortableRecordSource=Object.freeze({
    describeSource():PortableSourceDescription { stable(); return description; },
    readDomainPage(request:PortableSourcePageInput) {
      return enqueue(async()=> {
        await authenticate(request.signal);
        if (!PORTABLE_RECORD_DOMAIN_ORDER.includes(request.domain)
          || !Number.isSafeInteger(request.afterOrdinal) || request.afterOrdinal < 0 || Object.is(request.afterOrdinal,-0)
          || request.afterOrdinal > counts.get(request.domain)! || request.maxRecords !== 500
          || request.maxBytes !== PORTABLE_LIMITS.maxBatchBytes || typeof request.includePredecessor !== "boolean") {
          throw new PortableStreamError("invalid-limit");
        }
        const predecessor=request.includePredecessor && request.afterOrdinal > 0
          ? await readOrdinal(request.domain,request.afterOrdinal-1,request.signal) : null;
        const records:PortableRecord[]=[];let bytes=0;
        const entries=index.entries(request.domain,{afterOrdinal:request.afterOrdinal-1,limit:request.maxRecords,
          maxBytes:request.maxBytes,signal:request.signal});
        for (const entry of entries) {
          const record=await checkedRecordAt(request.domain,entry.locator,entry.ordinal,request.signal);
          const length=serializePortableRecord(record).byteLength+8;
          if (bytes+length > request.maxBytes) break;
          records.push(record);bytes+=length;
        }
        if (records.length === 0 && request.afterOrdinal < counts.get(request.domain)!) throw new PortableStreamError("record-unrepresentable");
        await authenticate(request.signal);
        return Object.freeze({predecessor,records:Object.freeze(records),
          complete:request.afterOrdinal+records.length === counts.get(request.domain)});
      });
    },
    verifySource(request:PortableSourceVerificationInput) {
      return enqueue(async()=> {
        await authenticate(request.signal);
        if (request.sourceIdentitySha256 !== description.sourceIdentitySha256
          || request.sourceWitnessSha256 !== description.sourceWitnessSha256
          || (request.contentSha256 !== undefined && request.contentSha256 !== contentSha256)) return "changed";
        if (request.boundary !== undefined) {
          const b=request.boundary;
          const count=counts.get(b.domain);
          if (count === undefined || !Number.isSafeInteger(b.nextOrdinal) || b.nextOrdinal < 0
            || b.recordCount !== b.nextOrdinal || b.nextOrdinal > count) return "invalid";
          const actual=cachedBoundary(b.domain,b.nextOrdinal);
          if (actual.prefix !== b.prefixSha256 || (actual.last?.recordSha256 ?? null) !== b.lastRecordSha256
            || (actual.last?.identitySha256 ?? null) !== b.lastRecordIdentitySha256) return "changed";
          if (b.nextOrdinal === count) {
            // Completion proves the whole actual SQL domain again. Intermediate
            // checkpoints use exact indexed evidence plus an actual boundary
            // read; the owned repeatable-read session protects its interior.
            const current=await boundaryAt(b.domain,count,false,request.signal);
            if (current.prefix !== actual.prefix) return "changed";
          } else if (b.nextOrdinal > 0) {
            await readOrdinal(b.domain,b.nextOrdinal-1,request.signal);
          }
        }
        await authenticate(request.signal);
        return "unchanged";
      });
    },
    close():Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed=true;brands.delete(source);
      closePromise=tail.then(async()=> {
        let failed=false;
        try { index.close(); } catch { failed=true; }
        try { await session.close(); } catch { failed=true; }
        try { await runtime.close(); } catch { failed=true; }
        if (failed) throw new PortableStreamError("source-unavailable");
      });
      return closePromise;
    },
  });
  brands.set(source,expectedHash);
  await authenticate(options.signal);
  return source;
}
