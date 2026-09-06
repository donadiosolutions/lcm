import { buildRecords, buildDomainDrafts, POSTGRES_DIALECT, postgresGeneration } from "../fixtures/portable-records.js";
import { PortableIndex } from "../../src/storage/portable-index.js";
import { describe, expect, it, vi } from "vitest";
import * as mapping from "../../src/storage/postgresql/portable-mapping.js";
import { canonicalSha256, createPortableRecord, PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import type { PostgreSqlQueryExecutor } from "../../src/storage/postgresql/contracts.js";

const projectId = "018f7766-1c40-7a11-b3d6-5c1f0a2b7e94";
const timestamp = "2026-08-13T10:20:30.123456Z";
const conversationId = canonicalSha256(["lcm-portable-identity-v1","conversations",[canonicalSha256(["lcm-portable-conversation-value-v1","session",null,null,timestamp,timestamp]),{$integer:"0"}]]);
function executor(rows: Record<string, unknown>[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] }));
  return { db: { query } as unknown as PostgreSqlQueryExecutor, query };
}

describe("PostgreSQL portable native mapping", () => {
  it("maps every canonical domain to a native table", () => {
    expect(mapping.mappingForDomain).toBeTypeOf("function");
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(mapping.mappingForDomain(domain).table).toMatch(/^lcm\./);
      expect(mapping.mappingForDomain(domain).keys.length).toBeGreaterThan(0);
    }
  });
  it("preserves unsafe bigint values and six-digit timestamps on native insertion", async () => {
    const {db, query} = executor([{locator:'["9007199254740999"]'}]);
    const record = createPortableRecord({ domain:"messages",ordinal:0,
      context:{conversationOrder:["session",null,null,timestamp,timestamp,"0"]},
      value:{conversationIdentitySha256:conversationId,seq:"9007199254740993",role:"user",content:"hello",tokenCount:"9007199254740995",createdAt:timestamp} });
    const resolve = vi.fn(async () => '["9007199254740997"]');
    expect(await mapping.insertCanonicalRecord(db,projectId,record,resolve)).toBe('["9007199254740999"]');
    expect(query.mock.calls[0][0].text).toContain("INSERT INTO lcm.messages");
    expect(query.mock.calls[0][0].values).toEqual([projectId,"9007199254740997","9007199254740993","user","hello","9007199254740995",timestamp]);
    expect(query.mock.calls[0][0].text).toContain("RETURNING");
  });
  it("fetches bounded headers before payloads and retains exact SQL timestamp precision", async () => {
    const {db, query} = executor([]);
    await mapping.listCanonicalHeaders(db,projectId,"messages",null,2);
    expect(query.mock.calls[0][0].text).toContain("LIMIT");
    expect(query.mock.calls[0][0].text).toContain("octet_length");
    expect(query.mock.calls[0][0].text).not.toContain("SELECT r.*");
    await mapping.readCanonicalRow(db,projectId,"messages",'["9007199254740997"]');
    expect(query.mock.calls[1][0].text).toContain('YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    expect(query.mock.calls[1][0].text).toContain("token_count::text");
    await expect(mapping.listCanonicalHeaders(db,projectId,"messages",null,501)).rejects.toThrow();
  });
  it("refuses nonrepresentable memory UUID and empty content before SQL", async () => {
    const {db, query} = executor([]);
    const record = createPortableRecord({domain:"promoted-memories",ordinal:0,context:{projectIdentity:{scope:"shared",projectId}},value:{memoryId:"legacy-memory",content:"",metadata:{},sourceProjectId:null,sourceSummaryId:null,sessionId:null,depth:0,confidence:1,createdAt:timestamp,archivedAt:null}});
    await expect(mapping.insertCanonicalRecord(db,projectId,record,async()=>"unused")).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("decodes physical message rows through parent canonical identity", () => {
    const decoded = mapping.decodeCanonicalRow("messages",{conversation_id:"8",message_id:"9",seq:"9007199254740993",role:"user",content:"hello",token_count:"1",created_at:timestamp},{projectIdentity:{scope:"shared",projectId},conversation:{identitySha256:conversationId,order:["session",null,null,timestamp,timestamp,"0"]}});
    expect(createPortableRecord({...decoded,ordinal:0}).value).toMatchObject({conversationIdentitySha256:conversationId,seq:{$integer:"9007199254740993"},createdAt:timestamp});
  });
});

it("roundtrips every field of all 22 decoded SQL domain families through the canonical codec", async () => {
  const drafts = buildDomainDrafts({dialect:POSTGRES_DIALECT,projectIdentity:{scope:"shared",projectId}});
  for (const draft of drafts) for (const [index,value] of draft.values.entries()) {
    const row:Record<string,unknown> = {};
    for (const [property,raw] of Object.entries(value)) {
      const column = property === "subtaskDescription" ? "subtask_desc" : property.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`);
      row[column] = raw !== null && typeof raw === "object" ? JSON.stringify(raw) : raw;
    }
    row.message_id = value.messageIdentitySha256 === null ? null : "9";
    const originalContext = draft.contexts[index] as Record<string,unknown> | null;
    const conversationOrder = originalContext?.conversationOrder as import("../../src/storage/portable-record.js").PortableRawConversationOrder | undefined;
    const messageOrder = originalContext?.messageOrder as import("../../src/storage/portable-record.js").PortableRawMessageOrder | undefined;
    row.status = value.disposition;
    if (draft.domain === "passive-events") for (const key of ["sessionId","sessionSequence","category","data","priority","sourceHook","createdAt"]) row[key] = String(value[key]);
    const context = {projectIdentity:{scope:"shared" as const,projectId},occurrenceOrdinal:String(value.occurrenceOrdinal ?? 0),
      conversation:{identitySha256:String(value.conversationIdentitySha256 ?? conversationId),order:conversationOrder ?? ["session",null,null,timestamp,timestamp,"0"] as const},
      message:{identitySha256:String(value.messageIdentitySha256),order:messageOrder ?? ["session",null,null,timestamp,timestamp,"0","0"] as const}};
    const decoded = mapping.decodeCanonicalRow(draft.domain,row,context);
    const expected = createPortableRecord({domain:draft.domain,ordinal:index,value,context:originalContext} as import("../../src/storage/portable-record.js").PortableRecordInput);
    const actual = createPortableRecord({...decoded,ordinal:index});
    expect(actual,`${draft.domain} ${index}`).toEqual(expected);
  }
});

it("uses a numerically ordered bounded conversation closure query", async()=>{
  const {db,query}=executor([]);
  await mapping.listConversationMessageHeaders(db,projectId,"9007199254740993","9",1);
  expect(query.mock.calls[0][0]).toMatchObject({values:[projectId,"9007199254740993","9",1,"150994944"]});
  expect(query.mock.calls[0][0].text).toContain("ORDER BY r.seq LIMIT");
});

it("preflights PostgreSQL unique constraints that differ from canonical identities", async()=>{
  const records = buildRecords(postgresGeneration());
  const first = records.get("message-parts")![0];
  expect(mapping.listPostgreSqlRecordUniqueKeys).toBeTypeOf("function");
  expect(mapping.listPostgreSqlRecordUniqueKeys(first)).toContainEqual({namespace:"postgresql.message_parts.part_id",key:JSON.stringify([(first.value as {partId:string}).partId])});
  const edge = records.get("summary-message-links")![0];
  expect(mapping.listPostgreSqlRecordUniqueKeys(edge).map(key=>key.namespace)).toEqual(["postgresql.summary_messages.summary_message","postgresql.summary_messages.summary_ordinal"]);
  const event = records.get("passive-events")![0];
  expect(mapping.listPostgreSqlRecordUniqueKeys(event).map(key=>key.namespace)).toContain("postgresql.passive_event_inbox.machine_sequence");
});

it("refuses legacy machine keys against the effective machine schema before SQL", ()=>{
  const machine = createPortableRecord({domain:"machines",ordinal:0,context:null,value:{identityKey:"installation:legacy",machineId:"018f7765-7b5c-7d92-8a2e-c6f6a15fca34"}});
  expect(()=>mapping.assertPostgreSqlRecordCapability(machine,projectId)).toThrow();
});

it("writes every supported domain into native semantic columns with engine-owned IDs", async()=>{
  const memoryId="550e8400-e29b-41d4-a716-446655440000";
  const drafts = buildDomainDrafts({...postgresGeneration(),mutate:(domain,rows)=>rows.map(row=>{
    const value={...row};
    if (typeof value.machineIdentityKey === "string") value.machineIdentityKey = "machine:"+canonicalSha256(value.machineIdentityKey);
    if (domain === "machines") {value.identityKey="machine:"+canonicalSha256(value.identityKey);value.machineId="018f7765-7b5c-7d92-8a2e-c6f6a15fca34";}
    if (domain === "conversations" && value.bootstrappedAt !== null) {value.bootstrappedAt=value.createdAt;value.conversationFingerprint=canonicalSha256(["lcm-portable-conversation-value-v1",value.sessionId,value.title,value.bootstrappedAt,value.createdAt,value.updatedAt]);}
    if (domain === "message-parts") value.partId=memoryId;
    if (domain === "promoted-memories" || domain === "promoted-memory-tags") value.memoryId=memoryId;
    if (domain === "promoted-memories" && value.content === "") value.content="nonempty";
    return value;
  })});
  for (const draft of drafts) for (const [index,value] of draft.values.entries()) {
    const domain=draft.domain;
    let context=draft.contexts[index];
    if (domain === "native-transcripts") {
      const {nativePayload,...metadata}=value;
      context={projectIdentity:{scope:"shared",projectId},canonicalPayloadBytes:Buffer.byteLength(JSON.stringify(nativePayload)),canonicalMetadataBytes:Buffer.byteLength(JSON.stringify({...metadata,sourceOrdinal:{$integer:String(metadata.sourceOrdinal)}}))};
    }
    const record=createPortableRecord({domain,ordinal:index,value,context} as import("../../src/storage/portable-record.js").PortableRecordInput);
    const calls:{text:string;values:unknown[]}[]=[];
    const db={query:async(config:{text:string;values:unknown[]})=>{
      calls.push(config);
      return {rows:[{id:"8",conversation_id:"7",locator:'["8"]'}],rowCount:1,fields:[],command:"SELECT",oid:0};
    }} as unknown as PostgreSqlQueryExecutor;
    const locator=await mapping.insertCanonicalRecord(db,projectId,record,async()=> '["7"]');
    expect(locator).toBe('["8"]');
    const inserts=calls.filter(call=>call.text.startsWith("INSERT"));
    if (["machines","project","project-aliases"].includes(domain)) expect(inserts).toHaveLength(0);
    else {
      expect(inserts,domain).toHaveLength(1);
      expect(inserts[0].text).toContain(`INSERT INTO ${mapping.mappingForDomain(domain).table}`);
      expect(inserts[0].values[0]).toBe(projectId);
      expect(inserts[0].text).not.toContain("ON CONFLICT");
      if (domain === "message-parts") {
        expect(inserts[0].text).toContain("subtask_desc");
        expect(inserts[0].text).toContain("is_synthetic");
      }
      if (domain === "passive-events") {
        const payload=inserts[0].values.find(value=>typeof value==="string"&&value.startsWith('{"category"')) as string;
        expect(JSON.parse(payload).sessionSequence).toBeTypeOf("number");
        expect(JSON.parse(payload).priority).toBeTypeOf("number");
      }
    }
  }
});

it("refuses cross-conversation relations during disk preflight", async()=>{
  const records=buildRecords(postgresGeneration());
  const index=new PortableIndex();
  try {
    expect(mapping.validatePostgreSqlRecordRelations).toBeTypeOf("function");
    for(const domain of ["messages","summaries"] as const) for(const record of records.get(domain)!) mapping.validatePostgreSqlRecordRelations(record,index);
    const edge=records.get("summary-message-links")![0];
    mapping.validatePostgreSqlRecordRelations(edge,index);
    index.verifyScopesAndAcyclic();
    const context=records.get("context-items")![0];
    mapping.validatePostgreSqlRecordRelations({...context,value:{...context.value,conversationIdentitySha256:"f".repeat(64)}} as import("../../src/storage/portable-record.js").PortableRecord,index);
    expect(()=>index.verifyScopesAndAcyclic()).toThrow();
  } finally {index.close();}
});

it("bounds scoped header and payload queries for every native family including joined text", async()=>{
  const {db,query}=executor([{test:"payload"}]);
  for(const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    const locator=JSON.stringify(mapping.mappingForDomain(domain).keys.map(()=>"key"));
    await mapping.listCanonicalHeaders(db,projectId,domain,locator,500);
    expect(await mapping.readCanonicalRow(db,projectId,domain,locator)).toEqual({test:"payload"});
  }
  expect(query.mock.calls.map(call=>call[0].text).join("\n")).toContain("m.identity_key AS machine_identity_key");
  expect(query.mock.calls.map(call=>call[0].text).join("\n")).toContain("p.summary_id AS parent_summary_id");
  expect(query.mock.calls.map(call=>call[0].text).join("\n")).not.toContain("row_to_json(r)");
  expect(query.mock.calls.map(call=>call[0].text).join("\n")).toContain("row_to_json(portable_row)");
  expect(query.mock.calls[1][0].values?.[2]).toBe(String(144*1024*1024));
  expect(()=>mapping.mappingForDomain("unknown" as never)).toThrow();
  for(const bad of ["bad",'{}','[]','[1]']) await expect(mapping.readCanonicalRow(db,projectId,"messages",bad)).rejects.toThrow();
  for(const limit of [0,501,1.5]) await expect(mapping.listConversationMessageHeaders(db,projectId,"1",null,limit)).rejects.toThrow();
});

it("refuses missing decode evidence instead of inventing parent identities or duplicate occurrences",()=>{
  const context={projectIdentity:{scope:"shared" as const,projectId}};
  expect(()=>mapping.decodeCanonicalRow("messages",{},context)).toThrow();
  const row={seq:"0",role:"user",content:"a",token_count:"0",created_at:timestamp};
  expect(()=>mapping.decodeCanonicalRow("messages",row,context)).toThrow();
  expect(()=>mapping.decodeCanonicalRow("conversations",{session_id:"session",title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp},context)).toThrow();
  expect(()=>mapping.decodeCanonicalRow("recall-surfacings",{memory_id:"orphan",session_id:null,surfaced_at:timestamp},context)).toThrow();
  const part=buildDomainDrafts(postgresGeneration()).find(draft=>draft.domain==="message-parts")!.values[0];
  const partRow=Object.fromEntries(Object.entries(part).map(([key,value])=>[key==="subtaskDescription" ? "subtask_desc" : key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`),value]));
  expect(()=>mapping.decodeCanonicalRow("message-parts",partRow,context)).toThrow();
  expect(()=>mapping.decodeCanonicalRow("passive-events",{event_id:"a",event_version:"1",machine_sequence:"0",event_type:"x",machine_identity_key:42},context)).toThrow();
  const memory=buildDomainDrafts(postgresGeneration()).find(draft=>draft.domain==="promoted-memories")!.values[0];
  const memoryRow=Object.fromEntries(Object.entries(memory).map(([key,value])=>[key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`),typeof value === "object" && value !== null ? JSON.stringify(value) : value]));
  memoryRow.source_project_id=projectId;
  expect(mapping.decodeCanonicalRow("promoted-memories",memoryRow,context).value).toMatchObject({sourceProjectId:null});
});

it("enforces PostgreSQL-only UUID, identity, content, path and timestamp checks",async()=>{
  const records=buildRecords(postgresGeneration());
  const base=(domain:import("../../src/storage/portable-record.js").PortableDomain,patch:Record<string,unknown>)=>({...records.get(domain)![0],value:{...records.get(domain)![0].value,...patch}} as import("../../src/storage/portable-record.js").PortableRecord);
  const machineKey="machine:"+"a".repeat(64);
  for(const record of [
    base("project",{identity:{scope:"local",projectId}}),
    base("project",{identity:{scope:"shared",projectId:"018f7766-1c40-7a11-b3d6-5c1f0a2b7e95"}}),
    base("machines",{identityKey:machineKey,machineId:null}),
    base("machines",{identityKey:machineKey,machineId:"not-a-uuid"}),
    base("message-parts",{partId:"legacy-part"}),
    base("promoted-memories",{memoryId:"550e8400-e29b-41d4-a716-446655440000",content:""}),
    base("conversations",{}),
    base("large-files",{storageUri:"   "}),
    base("project-aliases",{machineIdentityKey:machineKey,normalizedPath:" /untrimmed "}),
  ]) expect(()=>mapping.assertPostgreSqlRecordCapability(record,projectId)).toThrow();
  const {db}=executor([]);
  await expect(mapping.insertCanonicalRecord(db,projectId,records.get("project")![0],async()=>"unused")).rejects.toThrow();
});

it("checks both context target types, native message ownership, and summary cycles",()=>{
  const records=buildRecords(postgresGeneration());
  const index=new PortableIndex();
  try {
    for(const domain of PORTABLE_RECORD_DOMAIN_ORDER) for(const record of records.get(domain)!) mapping.validatePostgreSqlRecordRelations(record,index);
    index.verifyScopesAndAcyclic();
    const edge=records.get("summary-parent-links")![0];
    const value=edge.value as {summaryId:string;parentSummaryId:string};
    mapping.validatePostgreSqlRecordRelations({...edge,value:{...edge.value,summaryId:value.parentSummaryId,parentSummaryId:value.summaryId}} as import("../../src/storage/portable-record.js").PortableRecord,index);
    expect(()=>index.verifyScopesAndAcyclic()).toThrow();
  } finally {index.close();}
  const absent=new PortableIndex();
  try {expect(()=>mapping.validatePostgreSqlRecordRelations(records.get("summary-parent-links")![0],absent)).toThrow();} finally {absent.close();}
});

it("refuses an archived machine without any project association before target mutation",()=>{
  const machine=createPortableRecord({domain:"machines",ordinal:0,context:null,value:{identityKey:"machine:"+"a".repeat(64),machineId:"018f7765-7b5c-7d92-8a2e-c6f6a15fca34"}});
  const index=new PortableIndex();
  try {
    mapping.validatePostgreSqlRecordRelations(machine,index);
    expect(()=>index.verifyScopesAndAcyclic()).toThrow();
  } finally {index.close();}
});

it("accepts a registered machine linked to the project by repeated alias evidence",()=>{
  const machineIdentityKey="machine:"+"a".repeat(64);
  const machine=createPortableRecord({domain:"machines",ordinal:0,context:null,value:{identityKey:machineIdentityKey,machineId:"018f7765-7b5c-7d92-8a2e-c6f6a15fca34"}});
  const index=new PortableIndex();
  try {
    mapping.validatePostgreSqlRecordRelations(machine,index);
    for(const [ordinal,path] of ["/repo","/repo/worktree"].entries()) mapping.validatePostgreSqlRecordRelations(createPortableRecord({domain:"project-aliases",ordinal,context:{projectIdentity:{scope:"shared",projectId}},value:{machineIdentityKey,path,normalizedPath:path}}),index);
    expect(()=>index.verifyScopesAndAcyclic()).not.toThrow();
  } finally {index.close();}
});

it("suppresses oversized locator output in SQL while returning the measured row length",async()=>{
  const {db,query}=executor([{locator:"",byteLength:"150994945"}]);
  expect(await mapping.listCanonicalHeaders(db,projectId,"native-transcript-checkpoints",null,1)).toEqual([{locator:"",byteLength:"150994945"}]);
  expect(query.mock.calls[0][0].text).toContain("SELECT CASE WHEN");
  expect(query.mock.calls[0][0].text).toContain("<= $4::bigint THEN json_build_array(");
  expect(query.mock.calls[0][0].text).toContain("ELSE '' END AS locator");
  expect(query.mock.calls[0][0].values).toEqual([projectId,null,1,"150994944"]);
  await mapping.listConversationMessageHeaders(db,projectId,"1",null,1);
  expect(query.mock.calls[1][0].text).toContain("<= $5::bigint THEN json_build_array(");
  expect(query.mock.calls[1][0].text).toContain("ELSE '' END AS locator");
  expect(query.mock.calls[1][0].values).toEqual([projectId,"1",null,1,"150994944"]);
});

it("rejects IDs already owned by another project before any native insertion",async()=>{
  const records=buildRecords(postgresGeneration());
  expect(mapping.assertPostgreSqlExistingConstraints).toBeTypeOf("function");
  for(const domain of ["message-parts","promoted-memories","passive-events"] as const) {
    const {db,query}=executor([{conflict:true,bytes:8}]);
    const controller=new AbortController();
    await expect(mapping.assertPostgreSqlExistingConstraints(db,projectId,records.get(domain)![0],controller.signal)).rejects.toThrow();
    const globalCalls=query.mock.calls.filter(call=>call[1].operation==="portable-existing-constraints");
    expect(globalCalls).toHaveLength(1);
    expect(globalCalls[0][0].text).toContain("SELECT EXISTS");
    expect(globalCalls[0][0].text).toContain("r.project_id <> $1::uuid");
    expect(globalCalls[0][0].values?.[0]).toBe(projectId);
    expect(globalCalls[0][1].signal).toBe(controller.signal);
    expect(globalCalls[0][0].text).not.toMatch(/INSERT|UPDATE|DELETE/);
  }
});

it("allows absent global collisions and skips engine-generated identifiers",async()=>{
  const records=buildRecords(postgresGeneration());
  const {db,query}=executor([{conflict:false,bytes:8}]);
  for(const domain of PORTABLE_RECORD_DOMAIN_ORDER) await mapping.assertPostgreSqlExistingConstraints(db,projectId,records.get(domain)![0]);
  const globalCalls=query.mock.calls.filter(call=>call[1].operation==="portable-existing-constraints");
  expect(globalCalls).toHaveLength(3);
  expect(globalCalls[0][0].text).toContain("r.part_id = $2::uuid");
  expect(globalCalls[1][0].text).toContain("r.memory_id = $2::uuid");
  expect(globalCalls[2][0].text).toContain("m.identity_key = $2");
  expect(globalCalls[2][0].text).toContain("r.event_id = $3::uuid OR r.machine_sequence = $4::bigint");
  expect(globalCalls[2][0].values?.[3]).toBe((records.get("passive-events")![0].value as {machineSequence:{$integer:string}}).machineSequence.$integer);
  const missing=executor([]);
  await expect(mapping.assertPostgreSqlExistingConstraints(missing.db,projectId,records.get("message-parts")![0])).rejects.toThrow();
});

it("evaluates the generated search expression for every search-bearing domain before mutation",async()=>{
  const records=buildRecords(postgresGeneration());
  for(const domain of ["messages","summaries","promoted-memories","promoted-memory-tags"] as const) {
    const {db,query}=executor([{bytes:8,conflict:false}]);
    await mapping.assertPostgreSqlExistingConstraints(db,projectId,records.get(domain)![0]);
    const search=query.mock.calls.find(call=>call[0].text.includes("pg_column_size"));
    expect(search).toBeDefined();
    expect(search![0].text).toBe("SELECT pg_catalog.pg_column_size(pg_catalog.to_tsvector('lcm.search_v1'::regconfig,lcm.normalize_search_text($1))) AS bytes");
    const value=records.get(domain)![0].value as {content?:string;tag?:string};
    expect(search![0].values).toEqual([domain==="promoted-memory-tags" ? value.tag : value.content]);
  }
});

it("sanitizes generated search rejection and preserves cancellation",async()=>{
  const record=buildRecords(postgresGeneration()).get("messages")![0];
  const {db,query}=executor([]);
  query.mockRejectedValue(new Error("secret search input from PostgreSQL"));
  await expect(mapping.assertPostgreSqlExistingConstraints(db,projectId,record)).rejects.toMatchObject({code:"record-unrepresentable"});
  const controller=new AbortController();controller.abort();
  await expect(mapping.assertPostgreSqlExistingConstraints(db,projectId,record,controller.signal)).rejects.toMatchObject({code:"aborted"});
  const during=new AbortController();
  query.mockImplementation(async()=>{during.abort();throw new Error("driver cancelled secret");});
  await expect(mapping.assertPostgreSqlExistingConstraints(db,projectId,record,during.signal)).rejects.toMatchObject({code:"aborted"});
  const after=new AbortController();
  query.mockImplementation(async()=>{after.abort();return {rows:[{bytes:8}],rowCount:1,fields:[],command:"SELECT",oid:0};});
  await expect(mapping.assertPostgreSqlExistingConstraints(db,projectId,record,after.signal)).rejects.toMatchObject({code:"aborted"});
  for(const rows of [[],[{bytes:-1}],[{bytes:"8"}]]) await expect(mapping.assertPostgreSqlExistingConstraints(executor(rows).db,projectId,record)).rejects.toMatchObject({code:"record-unrepresentable"});
});
