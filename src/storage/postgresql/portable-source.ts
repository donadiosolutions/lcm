import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { normalizeUuidV7 } from "../../machine-identity.js";
import { normalizeProjectPath } from "../../project-map.js";
import type { StorageIdentityContext } from "../contracts.js";
import { StorageOperationError } from "../errors.js";
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
import { isPostgreSqlSnapshotTerminationError } from "./errors.js";
import type { PostgreSqlSnapshotSession } from "./snapshot-session.js";
import { PostgreSqlRuntime } from "./runtime.js";
import { verifyPostgreSqlRuntimeSchema, verifyPostgreSqlTransferSchema } from "./runtime-readiness.js";
import { PortableTransferError } from "../portable-transfer.js";
import { createPortableIndex, type PortableIndex } from "../portable-index.js";
import {
  decodeCanonicalRow, listCanonicalHeaders, listConversationMessageHeaders,
  canonicalBatchItemBytes, readCanonicalContentRows, readCanonicalDomainOccupancy, readCanonicalRow,
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
  /**
   * A borrowed, already-open read-only snapshot session. When present, this
   * call skips opening an owned runtime and snapshot; the caller already
   * admitted and opened it (for example, the #624 verification driver's
   * single fenced census window). `close()` never closes a session it did
   * not open: the caller retains ownership of a borrowed session, including
   * on abort and error.
   */
  readonly session?: PostgreSqlSnapshotSession;
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

/**
 * The per-domain {recordCount, prefixSha256, terminalIdentity} values the
 * canonicalisation path in buildSource already derives while indexing. This
 * additive read-only boundary accessor surfaces exactly that cached data; it
 * never recomputes a digest or reads from the database.
 */
export type PostgreSqlPortableSourceDomainCensus = Readonly<{
  domain: PortableDomain;
  recordCount: number;
  prefixSha256: string;
  /** The final indexed record's identity digest, or null when the domain has no records. */
  terminalIdentitySha256: string | null;
}>;
const domainCensusAccessors = new WeakMap<PortableRecordSource, (domain: PortableDomain) => PostgreSqlPortableSourceDomainCensus>();

/** Read one domain's already-derived boundary evidence from an open PostgreSQL portable source. */
export function readPostgreSqlPortableSourceDomainCensus(
  source: PortableRecordSource, domain: PortableDomain,
): PostgreSqlPortableSourceDomainCensus {
  const accessor=domainCensusAccessors.get(source);
  if (accessor === undefined) throw new PortableStreamError("source-invalid");
  return accessor(domain);
}

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
  // Attach the cause only when it already arrived sanitized (a
  // StorageOperationError never carries connection strings, credentials or
  // raw driver detail such as internalQuery/host). A raw, unnormalized
  // error is never attached: that is the leak path.
  // retryable marks a genuine connection termination or idle-in-transaction
  // kill so the backend-neutral stream can retry it without knowing
  // PostgreSQL SQLSTATE semantics.
  return new PortableStreamError("source-unavailable", {
    cause: error instanceof StorageOperationError ? error : undefined,
    retryable: isPostgreSqlSnapshotTerminationError(error),
  });
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
const REGISTERED_IDENTITY_SQL = `EXISTS (
    SELECT 1 FROM lcm.projects p JOIN lcm.project_aliases a ON a.project_id = p.project_id
    JOIN lcm.machines m ON m.machine_id = a.machine_id
    WHERE p.project_id = $1::uuid AND m.machine_id = $2::uuid
      AND a.path = $3 AND a.normalized_path = $4) AS admitted`;
async function registeredIdentity(executor: PostgreSqlQueryExecutor, identity: StorageIdentityContext,
  normalizedPath: string, signal?: AbortSignal): Promise<void> {
  abort(signal);
  const result = await executor.query({text: `SELECT ${REGISTERED_IDENTITY_SQL}`,
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
/**
 * One snapshot authentication check: the registered-identity proof and the
 * live session state in one statement (#1869). The identity proof is an
 * MVCC read fixed by the snapshot; the pid, TLS, isolation and timestamp are
 * live values read at statement time, as before. Refusals keep their order:
 * an unadmitted identity, then any state mismatch, are source-invalid.
 */
async function snapshotAuthentication(session: Snapshot, identity: StorageIdentityContext,
  normalizedPath: string, signal?: AbortSignal): Promise<string> {
  abort(signal);
  const result = await session.query({text: `SELECT ${REGISTERED_IDENTITY_SQL},
    pg_backend_pid() AS backend_pid,
    COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls,
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`,
  values: [identity.id, identity.machineId, identity.selectedPath, normalizedPath]},
  {domain:"factory",operation:"portableSnapshotState",signal});
  const row=result.rows[0];
  if (result.rows.length !== 1 || row.admitted !== true) invalid();
  abort(signal);
  if (row.backend_pid !== session.identity.backendPid
    || row.tls !== true || row.isolation !== "repeatable read" || row.read_only !== "on"
    || typeof row.captured_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.captured_at)) invalid();
  abort(signal);
  return row.captured_at;
}

function assertHeaderLength(length: string): void {
  if (!/^(0|[1-9]\d*)$/u.test(length)) invalid();
  if (BigInt(length) > BigInt(PORTABLE_LIMITS.maxBatchBytes)) throw new PortableStreamError("record-unrepresentable");
}

/**
 * Splits locator picks into consecutive chunks whose aggregate budget stays
 * within PORTABLE_LIMITS.maxBatchBytes, so one batched read never fetches
 * more than one batch of payload. Each item is budgeted as its SQL-measured
 * byteLength plus its two locator copies (canonicalBatchItemBytes), so a
 * multi-item chunk never exceeds the budget. A single item always forms its
 * own chunk, which means a lone row admitted at the per-row limit
 * (assertHeaderLength) may exceed the budget by at most those two locator
 * copies; admission is deliberately unchanged. An item without a numeric
 * byteLength fails closed. An empty list yields no chunks.
 */
function splitByBytes<T extends {readonly locator: string; readonly byteLength?: string}>(items: readonly T[]): T[][] {
  const budget=BigInt(PORTABLE_LIMITS.maxBatchBytes);
  const chunks:T[][]=[];
  let current:T[]=[];
  let currentBytes=0n;
  for (const item of items) {
    if (item.byteLength === undefined || !/^(0|[1-9]\d*)$/u.test(item.byteLength)) invalid();
    const size=canonicalBatchItemBytes(BigInt(item.byteLength),item.locator);
    if (current.length > 0 && currentBytes+size > budget) { chunks.push(current); current=[]; currentBytes=0n; }
    current.push(item); currentBytes+=size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Opens one owned read-only snapshot; its identity cannot survive session replacement. */
export async function createPostgreSqlPortableSource(options: PostgreSqlPortableSourceOptions,
  injected: PostgreSqlPortableSourceDependencies = dependencies): Promise<PortableRecordSource> {
  let runtime: SourceRuntime | undefined;
  let session: Snapshot | undefined;
  let index: PortableIndex | undefined;
  const ownsSession=options.session === undefined;
  let verify: PostgreSqlPortableSourceDependencies["verifyRuntimeSchema"] | PostgreSqlPortableSourceDependencies["verifyTransferSchema"];
  try {
    abort(options.signal);
    assertIdentity(options.expectedIdentity);
    const expectedHash=identityHash(options.expectedIdentity);
    const expectedIdentity=structuredClone(options.expectedIdentity);
    const normalizedPath=injected.normalizePath(expectedIdentity.selectedPath!);
    if (options.session === undefined) {
      runtime=injected.createRuntime(options.settings);
      const health=await runtime.health();
      if (health.status !== "healthy" || health.tls !== true || health.serverMajorVersion !== 18
        || health.serverEncoding !== "UTF8") invalid();
      abort(options.signal);
      verify=options.admission === "transfer" ? injected.verifyTransferSchema : injected.verifyRuntimeSchema;
      if (!verify) invalid();
      await verify(runtime,{expectedOwner:options.expectedOwner,signal:options.signal});
      await registeredIdentity(runtime,expectedIdentity,normalizedPath,options.signal);
      session=await runtime.openReadOnlySnapshot({projectId:expectedIdentity.id,signal:options.signal});
    } else {
      // Borrowed: the caller already admitted and opened this session on
      // its own runtime. No owned runtime is created, so none is closed.
      session=options.session;
    }
    if (session.identity.projectId !== expectedIdentity.id) invalid();
    // Snapshot-session opens REPEATABLE READ READ ONLY and pins it with its pid query, so
    // this recheck joins the snapshot used for every export read; DDL committed before the
    // pin is caught here. The verifier only SELECTs, except transaction-local set_config
    // calls that last until the snapshot rollback and do not affect schema-qualified SQL.
    // Non-MVCC probes (pg_stat_ssl, current_setting) are live state; snapshotState rechecks them.
    // A borrowed session's admission belongs to the caller that opened it; the
    // borrowing caller re-runs it inside the snapshot (verify-generation.ts).
    if (verify !== undefined) await verify(session,{expectedOwner:options.expectedOwner,signal:options.signal});
    const capturedAt=await snapshotAuthentication(session,expectedIdentity,normalizedPath,options.signal);
    const sourceWitnessSha256=await readPostgreSqlPortableWitness(session,expectedIdentity.id,options.signal);
    const sourceIdentitySha256=sha256(canonicalJson(["lcm-postgresql-snapshot-v1",sourceWitnessSha256,session.identity]));
    index=createPortableIndex({scratchParent:options.scratchParent,signal:options.signal});
    return await buildSource({options, runtime, session, ownsSession, index,expectedHash,expectedIdentity,normalizedPath,
      capturedAt,sourceIdentitySha256,sourceWitnessSha256});
  } catch (error) {
    try { index?.close(); } catch { /* Preserve primary sanitized failure. */ }
    // A borrowed session outlives this call's failure; only a session this
    // call opened is ever closed here.
    if (ownsSession) {
      try { await session?.close(); } catch { /* Runtime must still be released. */ }
    }
    try { await runtime?.close(); } catch { /* Preserve primary sanitized failure. */ }
    throw safeError(error);
  }
}

type BuildInput = {
  options: PostgreSqlPortableSourceOptions; runtime: SourceRuntime | undefined; session: Snapshot; ownsSession: boolean; index: PortableIndex;
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
  const {options,runtime,session,ownsSession,index,expectedIdentity,expectedHash,normalizedPath}=input;
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
  /**
   * Walks one conversation's message closure in pages of up to maxBatchRecords
   * headers, each page split into byte-bounded chunks that take one batched
   * content read. It still yields exactly one token per message (plus the
   * prefix and suffix), so segmentation and closure hashes do not depend on
   * page or chunk boundaries. A chunk's rows are taken from its Map and
   * dropped as they are consumed. Memory: the walk holds at most one fetched
   * chunk of projected rows, and the paired closures of finalizeConversations
   * (and the prepass conversation chunk plus its closure) may each hold one,
   * so those paths peak at up to two batch-budget chunks where the per-message
   * walk held a few individual rows.
   */
  const closureFromRow=async function* (row: Record<string,unknown>, signal?: AbortSignal): AsyncGenerator<string> {
    const conversation=draftConversation(row,"0");
    const value=conversation.value;
    yield `["lcm-portable-conversation-closure-v1",{"bootstrappedAt":${canonicalJson(value.bootstrappedAt)},"createdAt":${canonicalJson(value.createdAt)},"messages":[`;
    let cursor: string | null=null;
    let first=true;
    while (true) {
      abort(signal); abort(options.signal);
      const page=await listConversationMessageHeaders(session,expectedIdentity.id,String(row.conversation_id),cursor,PORTABLE_LIMITS.maxBatchRecords,signal);
      const headers=page.headers;
      if (headers.length === 0) break;
      if (headers.length > PORTABLE_LIMITS.maxBatchRecords) invalid();
      for (const chunk of splitByBytes(headers)) {
        // Only this chunk's headers are checked before its fetch, so a later
        // oversized header cannot turn an earlier finalize mismatch into
        // record-unrepresentable.
        for (const header of chunk) assertHeaderLength(header.byteLength);
        abort(signal); abort(options.signal);
        const rows=await readCanonicalContentRows(session,expectedIdentity.id,"messages",chunk.map(header=>header.locator),signal);
        for (const header of chunk) {
          const messageRow=rows.get(header.locator) ?? invalid();
          rows.delete(header.locator);
          const message=createPortableRecord({...decodeCanonicalRow("messages",messageRow,{projectIdentity,
            conversation:{identitySha256:conversation.identitySha256,
              order:rawOrder(conversation.order) as unknown as PortableRawConversationOrder}}),ordinal:0}) as PortableRecord<"messages">;
          const m=message.value;
          const next=m.seq.$integer;
          if (cursor !== null && BigInt(next) <= BigInt(cursor)) invalid();
          cursor=next;
          yield `${first ? "" : ","}${canonicalJson([m.seq,m.role,m.content,m.tokenCount,m.createdAt])}`;
          first=false;
        }
      }
      // The page's own sentinel proves no message follows; no terminator read.
      if (!page.more) break;
    }
    yield `],"sessionId":${canonicalJson(value.sessionId)},"title":${canonicalJson(value.title)},"updatedAt":${canonicalJson(value.updatedAt)}}]`;
  };
  const closure=async function* (locator: string, signal?: AbortSignal): AsyncGenerator<string> {
    yield* closureFromRow(await queryRow("conversations",locator,signal),signal);
  };
  const eachHeaderPage=async (domain: PortableDomain,
    visitPage:(headers:readonly {readonly locator:string;readonly byteLength:string}[])=>Promise<void>) => {
    let after: string | null=null;
    while (true) {
      abort(options.signal);
      // A page may hold fewer headers than the record bound while rows remain:
      // listCanonicalHeaders also cuts a page by aggregate locator bytes (#1388).
      // Resuming after the last returned locator therefore skips nothing.
      const page=await listCanonicalHeaders(session,expectedIdentity.id,domain,after,PORTABLE_LIMITS.maxBatchRecords,options.signal);
      const headers=page.headers;
      if (headers.length > PORTABLE_LIMITS.maxBatchRecords) invalid();
      let previous: string | null=after;
      for (const header of headers) {
        assertHeaderLength(header.byteLength);
        if (header.locator === previous) invalid();
        previous=header.locator;
      }
      await visitPage(headers);
      // The page's own sentinel proves no row follows; no terminator read.
      if (!page.more) break;
      after=previous;
    }
  };
  // One key-only presence statement in this snapshot (#1869): an empty domain
  // skips header paging entirely, while every occupied domain pages exactly
  // as before. Each value is checked when its domain is reached.
  const occupancy=await readCanonicalDomainOccupancy(session,expectedIdentity.id,PORTABLE_RECORD_DOMAIN_ORDER,false,options.signal);
  const occupied=(domain: PortableDomain): boolean => {
    const value=occupancy.get(domain);
    if (typeof value !== "boolean") invalid();
    return value;
  };

  // Conversations are read one byte-bounded chunk per batched read. Each row
  // is taken from its chunk Map before its closure is walked, so a consumed
  // conversation is not retained while its messages stream; the prepass peaks
  // at the remaining chunk rows plus one message chunk.
  if (occupied("conversations")) await eachHeaderPage("conversations",async(headers) => {
    for (const chunk of splitByBytes(headers)) {
      abort(options.signal);
      const rows=await readCanonicalContentRows(session,expectedIdentity.id,"conversations",chunk.map(header=>header.locator),options.signal);
      for (const header of chunk) {
        const row=rows.get(header.locator) ?? invalid();
        rows.delete(header.locator);
        const record=draftConversation(row,"0");
        const digest=createHash("sha256");
        for await (const part of closureFromRow(row,options.signal)) digest.update(part);
        index.addConversation({locator:header.locator,headerOrder:record.order.slice(0,5),closureSha256:digest.digest("hex")});
      }
    }
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
  const recordFromRow=(domain:PortableDomain,row:Record<string,unknown>,locator:string,ordinal:number):PortableRecord => {
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
  const recordAt=async(domain:PortableDomain,locator:string,ordinal:number,signal?:AbortSignal):Promise<PortableRecord> => {
    const row=await queryRow(domain,locator,signal);
    return recordFromRow(domain,row,locator,ordinal);
  };
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    let count=0;
    // One batched read per byte-bounded chunk of each header page (#1388).
    // Chunks are finished in order, and rows are consumed in header order, so
    // occurrence allocation and index ordinals match the per-record walk.
    if (occupied(domain)) await eachHeaderPage(domain,async(headers) => {
      for (const chunk of splitByBytes(headers)) {
        abort(options.signal);
        const rows=await readCanonicalContentRows(session,expectedIdentity.id,domain,chunk.map(header=>header.locator),options.signal);
        for (const header of chunk) {
          const draft=recordFromRow(domain,rows.get(header.locator) ?? invalid(),header.locator,0);
          index.add(header.locator,draft,header.byteLength);
          count++;
        }
      }
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
  const assertBoundaryMatches=(domain:PortableDomain,ordinal:number,record:PortableRecord) => {
    const expected=cachedBoundary(domain,ordinal+1).last;
    if (expected?.recordSha256 !== record.recordSha256 || expected.identitySha256 !== record.identitySha256) {
      throw new PortableStreamError("source-changed");
    }
  };
  const checkedRecordAt=async(domain:PortableDomain,locator:string,ordinal:number,signal?:AbortSignal) => {
    const record=await recordAt(domain,locator,ordinal,signal);
    assertBoundaryMatches(domain,ordinal,record);
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
      const entries=index.entries(domain,{afterOrdinal:ordinal-1,limit:Math.min(PORTABLE_LIMITS.maxBatchRecords,nextOrdinal-ordinal),
        maxBytes:PORTABLE_LIMITS.maxBatchBytes,signal});
      if (entries.length === 0) invalid();
      // Batched: one round trip per aggregate-byte-bounded chunk answers the
      // locators in this ordinal window (bounded by PORTABLE_LIMITS.maxBatchRecords
      // above) instead of one round trip per record. See #1388; the
      // incremental digest chain below still processes rows strictly in
      // entries' order, so boundary/ordering semantics do not change.
      // Chunking (splitByBytes) additionally bounds each round trip's
      // aggregate SQL payload bytes to PORTABLE_LIMITS.maxBatchBytes: index.entries' own
      // maxBytes bound only limits JSON-stringified index metadata, not the
      // record payload readCanonicalContentRows fetches. The digest loop
      // runs immediately after each chunk's read, inside this loop, instead
      // of after accumulating every chunk's rows into one map first: the
      // Node process's peak resident payload is therefore one chunk (at
      // most PORTABLE_LIMITS.maxBatchBytes), not the whole entries page.
      for (const chunk of splitByBytes(entries)) {
        abort(signal); abort(options.signal);
        const chunkRows=await readCanonicalContentRows(session,expectedIdentity.id,domain,chunk.map(item=>item.locator),signal);
        for (const item of chunk) {
          const row=chunkRows.get(item.locator);
          if (row === undefined) invalid();
          const record=recordFromRow(domain,row,item.locator,item.ordinal);
          if (!capture) assertBoundaryMatches(domain,item.ordinal,record);
          prefix=appendDigest(prefix,serializePortableRecord(record));
          last={recordSha256:record.recordSha256,identitySha256:record.identitySha256};ordinal++;
          if (capture) index.bindScope(prefixScope(domain),String(ordinal),JSON.stringify({prefix,last}));
        }
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
    if (await snapshotAuthentication(session,expectedIdentity,normalizedPath,signal) !== input.capturedAt) throw new PortableStreamError("source-changed");
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
        // One batched read per byte-bounded chunk. Memory: the accumulated
        // output (at most request.maxBytes) plus one fetched chunk of
        // projected rows; each row is taken from its Map as its record is
        // built. Records are checked in entry order and the page stops at the
        // first record that does not fit, after its boundary check, so no
        // later entry or chunk is examined or fetched.
        pageChunks: for (const chunk of splitByBytes(entries)) {
          abort(request.signal); abort(options.signal);
          const rows=await readCanonicalContentRows(session,expectedIdentity.id,request.domain,chunk.map(entry=>entry.locator),request.signal);
          for (const entry of chunk) {
            const row=rows.get(entry.locator) ?? invalid();
            rows.delete(entry.locator);
            const record=recordFromRow(request.domain,row,entry.locator,entry.ordinal);
            assertBoundaryMatches(request.domain,entry.ordinal,record);
            const length=serializePortableRecord(record).byteLength+8;
            if (bytes+length > request.maxBytes) break pageChunks;
            records.push(record);bytes+=length;
          }
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
        let cause: unknown;
        try { index.close(); } catch (error) { failed=true; cause=error; }
        // A borrowed session is retained and closed by its owner; closing
        // one here would be a defect surfacing only under crash or reuse.
        if (ownsSession) {
          try {
            await session.close();
          } catch (error) {
            // Tolerate a session already dead from a 25P03 idle-kill,
            // 08xxx/57P0x connection termination, or a message-only torn
            // connection that survives normalization as retryable with no
            // sqlState (isPostgreSqlSnapshotTerminationError). It does NOT
            // tolerate a generic "not queryable" local rejection (no
            // sqlState, not retryable) unless the snapshot checkout's
            // async-failure listener already captured a real diagnostic and
            // reattached it (PostgreSqlSnapshotSession.normalize); an
            // undiagnosed dead session still fails loudly here. Disk-index
            // and pool close failures below always propagate; this
            // tolerance is scoped to the session arm only.
            if (!isPostgreSqlSnapshotTerminationError(error)) { failed=true; cause??=error; }
          }
        }
        if (runtime !== undefined) { try { await runtime.close(); } catch (error) { failed=true; cause??=error; } }
        if (failed) {
          throw new PortableStreamError("source-unavailable", {
            cause: cause instanceof StorageOperationError ? cause : undefined,
          });
        }
      });
      return closePromise;
    },
  });
  brands.set(source,expectedHash);
  domainCensusAccessors.set(source,(domain)=> {
    stable();
    const boundary=cachedBoundary(domain,counts.get(domain)!);
    return Object.freeze({domain,recordCount:counts.get(domain)!,prefixSha256:boundary.prefix,
      terminalIdentitySha256:boundary.last?.identitySha256 ?? null});
  });
  await authenticate(options.signal);
  return source;
}
