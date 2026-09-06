import {
  canonicalJson, canonicalSha256, PORTABLE_LIMITS, PortableStreamError,
  type PortableDomain, type PortableProjectIdentity, type PortableRawConversationOrder,
  type PortableRawMessageOrder, type PortableRawRecordInput, type PortableRecord,
} from "../portable-record.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";

type Row = Record<string, unknown>;
type Field = readonly [property: string, column: string, kind?: "integer" | "timestamp" | "json"];
interface Mapping { readonly table: string; readonly keys: readonly string[]; readonly fields: readonly Field[]; readonly joins?: string; }
const fields = (names: string): readonly Field[] => names.split(" ").map((name) => {
  const [property, kind] = name.split(":");
  const column = property === "subtaskDescription" ? "subtask_desc" : property.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return [property, column, kind as Field[2]];
});
const machineJoin = " JOIN lcm.machines m ON m.machine_id = r.machine_id";
const summaryJoin = " JOIN lcm.summaries s ON s.project_id = r.project_id AND s.conversation_id = r.conversation_id AND s.summary_key = r.summary_key";
const mappings: Record<PortableDomain, Mapping> = {
  machines: {table:"lcm.machines", keys:["machine_id"],fields:fields("identityKey machineId")},
  project: {table:"lcm.projects",keys:["project_id"],fields:[]},
  "project-aliases":{table:"lcm.project_aliases",keys:["machine_id","normalized_path"],fields:fields("path normalizedPath"),joins:machineJoin},
  conversations:{table:"lcm.conversations",keys:["conversation_id"],fields:fields("sessionId title bootstrappedAt:timestamp createdAt:timestamp updatedAt:timestamp")},
  messages:{table:"lcm.messages",keys:["message_id"],fields:fields("seq:integer role content tokenCount:integer createdAt:timestamp")},
  "message-parts":{table:"lcm.message_parts",keys:["part_id"],fields:fields("partId sessionId partType ordinal:integer textContent isIgnored isSynthetic toolCallId toolName toolStatus toolInput toolOutput toolError toolTitle patchHash patchFiles fileMime fileName fileUrl subtaskPrompt subtaskDescription subtaskAgent stepReason stepCost stepTokensIn:integer stepTokensOut:integer snapshotHash compactionAuto metadata")},
  "large-files":{table:"lcm.large_files",keys:["file_key"],fields:fields("fileId fileName mimeType byteSize:integer storageUri explorationSummary createdAt:timestamp")},
  summaries:{table:"lcm.summaries",keys:["summary_key"],fields:fields("summaryId kind depth:integer content tokenCount:integer earliestAt:timestamp latestAt:timestamp descendantCount:integer descendantTokenCount:integer sourceMessageTokenCount:integer createdAt:timestamp")},
  "summary-file-links":{table:"lcm.summary_large_files",keys:["summary_key","ordinal"],fields:fields("ordinal:integer fileId"),joins:summaryJoin},
  "summary-message-links":{table:"lcm.summary_messages",keys:["summary_key","message_id"],fields:fields("ordinal:integer"),joins:summaryJoin},
  "summary-parent-links":{table:"lcm.summary_parents",keys:["summary_key","parent_summary_key"],fields:fields("ordinal:integer"),joins:summaryJoin+" JOIN lcm.summaries p ON p.project_id=r.project_id AND p.conversation_id=r.conversation_id AND p.summary_key=r.parent_summary_key"},
  "context-items":{table:"lcm.context_items",keys:["conversation_id","ordinal"],fields:fields("ordinal:integer itemType createdAt:timestamp"),joins:" LEFT JOIN lcm.summaries s ON s.project_id=r.project_id AND s.conversation_id=r.conversation_id AND s.summary_key=r.summary_key"},
  "promoted-memories":{table:"lcm.promoted_memories",keys:["memory_id"],fields:fields("memoryId content metadata:json sourceProjectId sourceSummaryId sessionId depth:integer confidence createdAt:timestamp archivedAt:timestamp")},
  "promoted-memory-tags":{table:"lcm.promoted_memory_tags",keys:["memory_id","ordinal"],fields:fields("memoryId ordinal:integer tag")},
  "recall-surfacings":{table:"lcm.recall_surfacing",keys:["surfacing_id"],fields:fields("memoryId sessionId surfacedAt:timestamp")},
  "redaction-counters":{table:"lcm.redaction_counters",keys:["category"],fields:fields("category count:integer")},
  "session-ingest":{table:"lcm.session_ingest_log",keys:["ingest_key"],fields:fields("sessionId messageCount:integer completedAt:timestamp")},
  "session-instructions":{table:"lcm.session_instructions",keys:["instruction_id"],fields:fields("scopeHash clientName sessionId worktreePath cwdPath content contentHash updatedAt:timestamp"),joins:machineJoin},
  "native-transcripts":{table:"lcm.native_transcripts",keys:["transcript_id"],fields:fields("clientName formatName formatVersion nativeSessionId sourceLocator sourceOrdinal:integer observedAt:timestamp ingestedAt:timestamp scrubberVersion contentSha256 ingestKey nativePayload:json"),joins:machineJoin},
  "native-transcript-message-links":{table:"lcm.transcript_messages",keys:["transcript_id","message_id"],fields:fields("sourceOrdinal:integer"),joins:" JOIN lcm.native_transcripts t ON t.project_id=r.project_id AND t.transcript_id=r.transcript_id JOIN lcm.machines m ON m.machine_id=t.machine_id"},
  "native-transcript-checkpoints":{table:"lcm.ingest_checkpoints",keys:["machine_id","client_name","source_locator"],fields:fields("clientName sourceLocator revision:integer lastSourceOrdinal:integer importedCount:integer skippedCount:integer quarantinedCount:integer checkpoint:json updatedAt:timestamp"),joins:machineJoin},
  "passive-events":{table:"lcm.passive_event_inbox",keys:["inbox_id"],fields:fields("eventId eventVersion:integer machineSequence:integer eventType"),joins:machineJoin},
};
const conversationDomains = new Set<PortableDomain>(["messages","message-parts","large-files","summaries","summary-file-links","summary-message-links","summary-parent-links","context-items","native-transcript-message-links"]);
const messageDomains = new Set<PortableDomain>(["message-parts","summary-message-links","context-items","native-transcript-message-links"]);
function fail(): never { throw new PortableStreamError("record-unrepresentable"); }
function text(value: unknown): string { if (typeof value !== "string") fail(); return value; }
function scalar(value: unknown): unknown {
  return value !== null && typeof value === "object" && "$integer" in value ? text((value as {$integer:unknown}).$integer) : value;
}
function locatorExpression(mapping: Mapping, alias = "r"): string {
  return `json_build_array(${mapping.keys.map((key) => `${alias}.${key}::text`).join(", ")})::text`;
}
function keyExpression(mapping: Mapping): string {
  return `ARRAY[${mapping.keys.map((key) => `r.${key}::text COLLATE "C"`).join(", ")}]`;
}
function parseLocator(locator: string, count: number): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(locator); } catch { return fail(); }
  if (!Array.isArray(parsed) || parsed.length !== count || !parsed.every((v) => typeof v === "string")) fail();
  return parsed as string[];
}
function scope(domain: PortableDomain): string {
  if (domain !== "machines") return "r.project_id = $1::uuid";
  return `EXISTS (SELECT 1 FROM lcm.project_aliases a WHERE a.project_id=$1::uuid AND a.machine_id=r.machine_id)
    OR EXISTS (SELECT 1 FROM lcm.session_instructions i WHERE i.project_id=$1::uuid AND i.machine_id=r.machine_id)
    OR EXISTS (SELECT 1 FROM lcm.native_transcripts t WHERE t.project_id=$1::uuid AND t.machine_id=r.machine_id)
    OR EXISTS (SELECT 1 FROM lcm.ingest_checkpoints c WHERE c.project_id=$1::uuid AND c.machine_id=r.machine_id)
    OR EXISTS (SELECT 1 FROM lcm.passive_event_inbox e WHERE e.project_id=$1::uuid AND e.machine_id=r.machine_id)`;
}
function projection(domain: PortableDomain, mapping: Mapping): string {
  const columns = new Map<string,string>();
  for (const key of mapping.keys) columns.set(key,`r.${key}::text AS ${key}`);
  for (const [,column,kind] of mapping.fields) columns.set(column,kind === "timestamp"
    ? `to_char(r.${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`
    : `r.${column}${kind === "integer" || kind === "json" ? "::text" : ""} AS ${column}`);
  if (conversationDomains.has(domain)) columns.set("conversation_id","r.conversation_id::text AS conversation_id");
  if (messageDomains.has(domain)) columns.set("message_id","r.message_id::text AS message_id");
  if (mapping.joins?.includes("lcm.machines m")) columns.set("machine_identity_key","m.identity_key AS machine_identity_key");
  if (mapping.joins?.includes("lcm.summaries s")) columns.set("summary_id","s.summary_id AS summary_id");
  if (domain === "summary-parent-links") columns.set("parent_summary_id","p.summary_id AS parent_summary_id");
  if (domain === "native-transcript-message-links") columns.set("ingest_key","t.ingest_key AS ingest_key");
  if (domain === "passive-events") {
    columns.set("status","r.status AS status");
    for (const key of ["sessionId","sessionSequence","category","data","priority","sourceHook","createdAt"]) columns.set(key,`r.payload->>'${key}' AS "${key}"`);
  }
  return [...columns.values()].join(", ");
}
export function mappingForDomain(domain: PortableDomain): Mapping & {readonly selectColumns:string} {
  const mapping = mappings[domain];
  if (mapping === undefined) fail();
  return {...mapping,selectColumns:projection(domain,mapping)};
}
function sizeExpression(domain:PortableDomain,mapping:Mapping):string {
  // Only count the projected wire row. Generated search vectors and unused native
  // fields must not turn a representable record into an oversized singleton.
  return `(SELECT octet_length(row_to_json(portable_row)::text)::bigint FROM (SELECT ${projection(domain,mapping)}) portable_row)`;
}
export interface CanonicalHeader { readonly locator:string; readonly byteLength:string; }
export async function listCanonicalHeaders(executor:PostgreSqlQueryExecutor,projectId:string,domain:PortableDomain,after:string|null,limit:number,signal?:AbortSignal):Promise<CanonicalHeader[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PortableStreamError("invalid-limit");
  const mapping = mappingForDomain(domain);
  const keys = after === null ? null : parseLocator(after,mapping.keys.length);
  const result = await executor.query<{locator:string;byteLength:string}>({text:`SELECT CASE WHEN ${sizeExpression(domain,mapping)} <= $4::bigint THEN ${locatorExpression(mapping)} ELSE '' END AS locator, ${sizeExpression(domain,mapping)}::text AS "byteLength" FROM ${mapping.table} r${mapping.joins ?? ""} WHERE (${scope(domain)}) AND ($2::text[] IS NULL OR ${keyExpression(mapping)} > $2::text[] COLLATE "C") ORDER BY ${keyExpression(mapping)} COLLATE "C" LIMIT $3`,values:[projectId,keys,limit,String(PORTABLE_LIMITS.maxBatchBytes)]},{domain:"transaction",operation:"portable-headers",projectId,signal});
  return result.rows;
}
/** Message closure traversal uses numeric seq, independently of opaque locator order. */
export async function listConversationMessageHeaders(executor:PostgreSqlQueryExecutor,projectId:string,conversationId:string,afterSeq:string|null,limit:number,signal?:AbortSignal):Promise<(CanonicalHeader & {readonly seq:string})[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PortableStreamError("invalid-limit");
  const domain = "messages";
  const mapping = mappings.messages;
  const result = await executor.query<{locator:string;byteLength:string;seq:string}>({text:`SELECT CASE WHEN ${sizeExpression(domain,mapping)} <= $5::bigint THEN ${locatorExpression(mappings.messages)} ELSE '' END AS locator, ${sizeExpression(domain,mapping)}::text AS "byteLength", r.seq::text AS seq FROM lcm.messages r${mapping.joins ?? ""} WHERE r.project_id=$1::uuid AND r.conversation_id=$2::bigint AND ($3::bigint IS NULL OR r.seq>$3::bigint) ORDER BY r.seq LIMIT $4`,values:[projectId,conversationId,afterSeq,limit,String(PORTABLE_LIMITS.maxBatchBytes)]},{domain:"transaction",operation:"portable-message-closure",projectId,signal});
  return result.rows;
}
export async function readCanonicalRow(executor:PostgreSqlQueryExecutor,projectId:string,domain:PortableDomain,locator:string,signal?:AbortSignal):Promise<Row|null> {
  const mapping = mappingForDomain(domain);
  const result = await executor.query({text:`SELECT ${mapping.selectColumns} FROM ${mapping.table} r${mapping.joins ?? ""} WHERE (${scope(domain)}) AND ${keyExpression(mapping)} = $2::text[] COLLATE "C" AND ${sizeExpression(domain,mapping)} <= $3::bigint LIMIT 1`,values:[projectId,parseLocator(locator,mapping.keys.length),String(PORTABLE_LIMITS.maxBatchBytes)]},{domain:"transaction",operation:"portable-read",projectId,signal});
  return result.rows[0] ?? null;
}
export interface CanonicalDecodeContext {
  readonly projectIdentity:PortableProjectIdentity;
  readonly conversation?:{readonly identitySha256:string;readonly order:PortableRawConversationOrder};
  readonly message?:{readonly identitySha256:string;readonly order:PortableRawMessageOrder};
  readonly occurrenceOrdinal?:string;
  readonly conversationFingerprint?:string;
}
export function decodeCanonicalRow(domain:PortableDomain,row:Row,parent:CanonicalDecodeContext):Omit<PortableRawRecordInput,"ordinal"> {
  const value:Row = {};
  for (const [property,column,kind] of mappings[domain].fields) {
    const raw = row[column];
    if (raw === undefined) fail();
    value[property] = kind === "json" ? JSON.parse(text(raw)) : raw;
  }
  let context:unknown = null;
  const projectIdentity = parent.projectIdentity;
  const projectDomains:PortableDomain[] = ["project-aliases","conversations","promoted-memories","recall-surfacings","redaction-counters","session-ingest","session-instructions","native-transcript-checkpoints","passive-events"];
  if (projectDomains.includes(domain)) context = {projectIdentity};
  if (domain === "project") value.identity = projectIdentity;
  if (mappings[domain].joins?.includes("lcm.machines m")) value.machineIdentityKey = text(row.machine_identity_key);
  if (["messages","large-files","summaries","context-items","native-transcript-message-links"].includes(domain)) {
    if (!parent.conversation) fail();
    value.conversationIdentitySha256 = parent.conversation.identitySha256;
  }
  if (domain === "messages" || domain === "context-items") context = {conversationOrder:parent.conversation!.order};
  if (messageDomains.has(domain)) {
    value.messageIdentitySha256 = domain === "context-items" && row.message_id === null ? null : parent.message?.identitySha256 ?? fail();
  }
  if (domain === "message-parts") context = {messageOrder:parent.message!.order};
  if (mappings[domain].joins?.includes("lcm.summaries s")) value.summaryId = row.summary_id;
  if (domain === "summary-parent-links") value.parentSummaryId = text(row.parent_summary_id);
  if (domain === "native-transcript-message-links") value.ingestKey = text(row.ingest_key);
  if (domain === "conversations") {
    value.occurrenceOrdinal = parent.occurrenceOrdinal ?? fail();
    value.conversationFingerprint = parent.conversationFingerprint ?? canonicalSha256(["lcm-portable-conversation-value-v1",value.sessionId,value.title,value.bootstrappedAt,value.createdAt,value.updatedAt]);
  }
  if (domain === "recall-surfacings") value.occurrenceOrdinal = parent.occurrenceOrdinal ?? fail();
  if (domain === "promoted-memories" && value.sourceProjectId === projectIdentity.projectId) value.sourceProjectId = null;
  if (domain === "native-transcripts") {
    const {nativePayload,...metadata} = value;
    context = {projectIdentity,canonicalPayloadBytes:Buffer.byteLength(canonicalJson(nativePayload)),canonicalMetadataBytes:Buffer.byteLength(canonicalJson({...metadata,sourceOrdinal:{$integer:metadata.sourceOrdinal}}))};
  }
  if (domain === "passive-events") {
    for (const key of ["sessionId","sessionSequence","category","data","priority","sourceHook","createdAt"]) value[key] = text(row[key]);
    value.disposition = row.status === "applied" ? "applied" : row.status === "quarantined" ? "quarantined" : "pending";
  }
  return {domain,value,context} as Omit<PortableRawRecordInput,"ordinal">;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertPostgreSqlRecordCapability(record:PortableRecord,projectId:string):void {
  const value = record.value as unknown as Row;
  if (record.domain === "project") {
    const identity = value.identity as PortableProjectIdentity;
    if (identity.scope !== "shared" || identity.projectId !== projectId) fail();
  }
  const machineIdentity = record.domain === "machines" ? value.identityKey : value.machineIdentityKey;
  if (machineIdentity !== undefined && !/^machine:[a-f0-9]{64}$/.test(text(machineIdentity))) fail();
  if (record.domain === "machines" && (value.machineId === null || !uuid.test(text(value.machineId)))) fail();
  if (record.domain === "message-parts" && !uuid.test(text(value.partId))) fail();
  if (["promoted-memories","promoted-memory-tags"].includes(record.domain) && !uuid.test(text(value.memoryId))) fail();
  if (record.domain === "promoted-memories" && value.content === "") fail();
  for (const [earlier,later] of [["createdAt","updatedAt"],["createdAt","bootstrappedAt"],["createdAt","archivedAt"],["earliestAt","latestAt"],["observedAt","ingestedAt"]]) {
    if (typeof value[earlier] === "string" && typeof value[later] === "string" && value[earlier] > value[later]) fail();
  }
  for (const property of ["storageUri","eventType","clientName","formatName","formatVersion","nativeSessionId","scrubberVersion"]) {
    if (typeof value[property] === "string" && value[property].trim() === "") fail();
  }
  if (record.domain === "project-aliases" && text(value.normalizedPath).trim() !== value.normalizedPath) fail();
}
export type ResolveCanonicalIdentity = (domain:PortableDomain,identitySha256:string)=>Promise<string>;
export async function insertCanonicalRecord(executor:PostgreSqlQueryExecutor,projectId:string,record:PortableRecord,resolveIdentity:ResolveCanonicalIdentity,signal?:AbortSignal):Promise<string> {
  assertPostgreSqlRecordCapability(record,projectId);
  const domain = record.domain;
  const mapping = mappings[domain];
  const value = record.value as unknown as Row;
  const query = async (sql:string,values:unknown[]):Promise<Row> => {
    const result = await executor.query({text:sql,values},{domain:"transaction",operation:"portable-insert",projectId,signal});
    if (result.rows.length !== 1) fail();
    return result.rows[0];
  };
  const lookup = async (table:string,key:string,property:string,input:unknown):Promise<Row> => query(`SELECT ${key}::text AS id, conversation_id::text AS conversation_id FROM ${table} WHERE project_id=$1::uuid AND ${property}=$2 LIMIT 2`,[projectId,input]);
  const machine = async ():Promise<string> => text((await query("SELECT machine_id::text AS id FROM lcm.machines WHERE identity_key=$1 LIMIT 2",[value.machineIdentityKey])).id);
  if (domain === "machines") return text((await query(`SELECT ${locatorExpression(mapping)} AS locator FROM lcm.machines r WHERE r.identity_key=$1 AND r.machine_id=$2::uuid LIMIT 2`,[value.identityKey,value.machineId])).locator);
  if (domain === "project") return text((await query(`SELECT ${locatorExpression(mapping)} AS locator FROM lcm.projects r WHERE r.project_id=$1::uuid LIMIT 2`,[projectId])).locator);
  if (domain === "project-aliases") return text((await query(`SELECT ${locatorExpression(mapping)} AS locator FROM lcm.project_aliases r JOIN lcm.machines m ON m.machine_id=r.machine_id WHERE r.project_id=$1::uuid AND m.identity_key=$2 AND r.path=$3 AND r.normalized_path=$4 LIMIT 2`,[projectId,value.machineIdentityKey,value.path,value.normalizedPath])).locator);
  const columns = ["project_id"];
  const values:unknown[] = [projectId];
  const expressions:string[] = ["$1"];
  const add = (column:string,input:unknown,expression?:string):void => {
    columns.push(column); values.push(input); expressions.push(expression?.replaceAll("?",`$${values.length}`) ?? `$${values.length}`);
  };
  const physical = async (dependency:PortableDomain,identity:unknown):Promise<string> => parseLocator(await resolveIdentity(dependency,text(identity)),mappings[dependency].keys.length)[0];
  let conversation:string|undefined;
  if (value.conversationIdentitySha256 !== undefined) conversation = await physical("conversations",value.conversationIdentitySha256);
  if (domain === "message-parts") {
    const messageId = await physical("messages",value.messageIdentitySha256);
    const message = await lookup("lcm.messages","message_id","message_id",messageId);
    conversation = text(message.conversation_id); add("conversation_id",conversation); add("message_id",messageId);
  } else if (conversation !== undefined) add("conversation_id",conversation);
  if (["summary-file-links","summary-message-links","summary-parent-links"].includes(domain)) {
    const summary = await lookup("lcm.summaries","summary_key","summary_id",value.summaryId);
    add("conversation_id",summary.conversation_id); add("summary_key",summary.id);
  }
  if (domain === "summary-parent-links") add("parent_summary_key",(await lookup("lcm.summaries","summary_key","summary_id",value.parentSummaryId)).id);
  if (["summary-message-links","native-transcript-message-links"].includes(domain)) add("message_id",await physical("messages",value.messageIdentitySha256));
  if (domain === "context-items") {
    add("message_id",value.messageIdentitySha256 === null ? null : await physical("messages",value.messageIdentitySha256));
    add("summary_key",value.summaryId === null ? null : (await lookup("lcm.summaries","summary_key","summary_id",value.summaryId)).id);
  }
  if (["session-instructions","native-transcripts","native-transcript-checkpoints","passive-events"].includes(domain)) add("machine_id",await machine());
  if (domain === "native-transcript-message-links") {
    const transcript = await query("SELECT t.transcript_id::text AS id FROM lcm.native_transcripts t JOIN lcm.machines m ON m.machine_id=t.machine_id WHERE t.project_id=$1::uuid AND m.identity_key=$2 AND t.ingest_key=$3 LIMIT 2",[projectId,value.machineIdentityKey,value.ingestKey]);
    add("transcript_id",transcript.id);
  }
  for (const [property,column,kind] of mapping.fields) add(column,kind === "json" ? canonicalJson(value[property]) : scalar(value[property]),kind === "json" ? "?::jsonb" : undefined);
  if (domain === "passive-events") {
    const payload:Row = {};
    for (const key of ["sessionId","category","data","sourceHook","createdAt"]) payload[key] = value[key];
    const json = canonicalJson(payload);
    // Both counters remain exact JSON numbers in the native event envelope.
    const suffix = `,"sessionSequence":${text(scalar(value.sessionSequence))},"priority":${text(scalar(value.priority))}}`;
    add("payload",json.slice(0,-1)+suffix,"?::jsonb");
    add("status",value.disposition); add("received_at",value.createdAt); add("next_attempt_at",value.createdAt);
    add("applied_at",value.disposition === "applied" ? value.createdAt : null);
    add("quarantined_at",value.disposition === "quarantined" ? value.createdAt : null);
    add("quarantine_reason",value.disposition === "quarantined" ? "portable-recovery" : null);
  }
  return text((await query(`INSERT INTO ${mapping.table} AS r (${columns.join(", ")}) VALUES (${expressions.join(", ")}) RETURNING ${locatorExpression(mapping)} AS locator`,values)).locator);
}

export interface PostgreSqlRecordUniqueKey {
  readonly namespace:string;
  readonly key:string;
}
/** Native uniqueness is checked across the complete corpus before target mutation. */
export function listPostgreSqlRecordUniqueKeys(record:PortableRecord):readonly PostgreSqlRecordUniqueKey[] {
  const value = record.value as unknown as Row;
  const constraints:Record<PortableDomain,readonly (readonly [string,...string[]])[]> = {
    machines:[["identity_key","identityKey"],["machine_id","machineId"]],
    project:[["project"]],
    "project-aliases":[["machine_normalized_path","machineIdentityKey","normalizedPath"],["machine_path","machineIdentityKey","path"]],
    conversations:[],
    messages:[["conversation_seq","conversationIdentitySha256","seq"]],
    "message-parts":[["part_id","partId"],["message_ordinal","messageIdentitySha256","ordinal"]],
    "large-files":[["file_id","fileId"]],
    summaries:[["summary_id","summaryId"]],
    "summary-file-links":[["summary_ordinal","summaryId","ordinal"]],
    "summary-message-links":[["summary_message","summaryId","messageIdentitySha256"],["summary_ordinal","summaryId","ordinal"]],
    "summary-parent-links":[["summary_parent","summaryId","parentSummaryId"],["summary_ordinal","summaryId","ordinal"]],
    "context-items":[["conversation_ordinal","conversationIdentitySha256","ordinal"]],
    "promoted-memories":[["memory_id","memoryId"]],
    "promoted-memory-tags":[["memory_ordinal","memoryId","ordinal"]],
    "recall-surfacings":[],
    "redaction-counters":[["category","category"]],
    "session-ingest":[["session_id","sessionId"]],
    "session-instructions":[["machine_scope","machineIdentityKey","scopeHash"]],
    "native-transcripts":[["machine_ingest","machineIdentityKey","ingestKey"]],
    "native-transcript-message-links":[["transcript_message","machineIdentityKey","ingestKey","messageIdentitySha256"],["transcript_ordinal","machineIdentityKey","ingestKey","sourceOrdinal"]],
    "native-transcript-checkpoints":[["machine_client_source","machineIdentityKey","clientName","sourceLocator"]],
    "passive-events":[["machine_event","machineIdentityKey","eventId"],["machine_sequence","machineIdentityKey","machineSequence"]],
  };
  return constraints[record.domain].map(([name,...properties])=>({
    namespace:`postgresql.${mappings[record.domain].table.slice(4)}.${name}`,
    key:canonicalJson(properties.map(property=>scalar(value[property]))),
  }));
}

interface RelationIndex {
  bindScope(namespace:string,key:string,value:string):void;
  getScope(namespace:string,key:string):string|null;
  requireScope(namespace:string,key:string,value:string):void;
  addEdge(namespace:string,from:string,to:string):void;
}
/** Emit native FK ownership and DAG claims into the bounded preflight index. */
export function validatePostgreSqlRecordRelations(record:PortableRecord,index:RelationIndex):void {
  const value=record.value as unknown as Row;
  // PostgreSQL has no standalone project-machine membership row. Every imported
  // machine must remain discoverable through project aliases or native records.
  if (record.domain === "machines") index.requireScope("pg:machine-used",text(value.identityKey),"yes");
  if (value.machineIdentityKey !== undefined) {
    const identityKey=text(value.machineIdentityKey);
    if (index.getScope("pg:machine-used",identityKey) === null) index.bindScope("pg:machine-used",identityKey,"yes");
  }
  const namespace="postgresql.conversation-membership";
  const messageKey=(identity:unknown):string=>canonicalJson(["messages",text(identity)]);
  const summaryKey=(identity:unknown):string=>canonicalJson(["summaries",text(identity)]);
  if(record.domain === "messages") index.bindScope(namespace,messageKey(record.identitySha256),text(value.conversationIdentitySha256));
  if(record.domain === "summaries") index.bindScope(namespace,summaryKey(value.summaryId),text(value.conversationIdentitySha256));
  if(record.domain === "summary-message-links" || record.domain === "summary-parent-links") {
    const conversation=index.getScope(namespace,summaryKey(value.summaryId)) ?? fail();
    const target=record.domain === "summary-message-links" ? messageKey(value.messageIdentitySha256) : summaryKey(value.parentSummaryId);
    index.requireScope(namespace,target,conversation);
    if(record.domain === "summary-parent-links") index.addEdge("postgresql.summary-dag",text(value.summaryId),text(value.parentSummaryId));
  }
  if(record.domain === "context-items" || record.domain === "native-transcript-message-links") {
    const target=record.domain === "context-items" && value.itemType === "summary" ? summaryKey(value.summaryId) : messageKey(value.messageIdentitySha256);
    index.requireScope(namespace,target,text(value.conversationIdentitySha256));
  }
}

/**
 * These supplied identifiers are unique across projects. Check the complete
 * destination database during preflight, while preserving unrelated projects.
 * Evaluate generated search values too: an oversized tsvector can reject an
 * otherwise valid portable record, independently of native field sizes.
 */
export async function assertPostgreSqlExistingConstraints(
  executor:PostgreSqlQueryExecutor,
  projectId:string,
  record:PortableRecord,
  signal?:AbortSignal,
):Promise<void> {
  if (signal?.aborted) throw new PortableStreamError("aborted");
  const value=record.value as unknown as Row;
  if (["messages","summaries","promoted-memories","promoted-memory-tags"].includes(record.domain)) {
    try {
      const search=await executor.query<{bytes:number}>({
        text:"SELECT pg_catalog.pg_column_size(pg_catalog.to_tsvector('lcm.search_v1'::regconfig,lcm.normalize_search_text($1))) AS bytes",
        values:[record.domain === "promoted-memory-tags" ? value.tag : value.content],
      },{domain:"transaction",operation:"portable-search-capability",projectId,signal});
      const bytes=search.rows[0]?.bytes;
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail();
    } catch {
      if (signal?.aborted) throw new PortableStreamError("aborted");
      fail();
    }
    if (signal?.aborted) throw new PortableStreamError("aborted");
  }
  let from:string;
  let condition:string;
  let values:unknown[];
  if (record.domain === "message-parts") {
    from="lcm.message_parts r";
    condition="r.part_id = $2::uuid";
    values=[projectId,value.partId];
  } else if (record.domain === "promoted-memories") {
    from="lcm.promoted_memories r";
    condition="r.memory_id = $2::uuid";
    values=[projectId,value.memoryId];
  } else if (record.domain === "passive-events") {
    from="lcm.passive_event_inbox r JOIN lcm.machines m ON m.machine_id = r.machine_id";
    condition="m.identity_key = $2 AND (r.event_id = $3::uuid OR r.machine_sequence = $4::bigint)";
    values=[projectId,value.machineIdentityKey,value.eventId,scalar(value.machineSequence)];
  } else {
    return;
  }
  const result=await executor.query<{conflict:boolean}>({
    text:`SELECT EXISTS (SELECT 1 FROM ${from} WHERE r.project_id <> $1::uuid AND ${condition}) AS conflict`,
    values,
  },{domain:"transaction",operation:"portable-existing-constraints",projectId,signal});
  if (result.rows[0]?.conflict !== false) fail();
}
