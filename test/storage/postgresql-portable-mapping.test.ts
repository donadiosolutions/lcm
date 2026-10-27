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
  it("counts canonical rows database-side over the scope the header stream pages", async () => {
    const {db, query} = executor([{count:"0"}]);
    const signal = new AbortController().signal;
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(await mapping.countCanonicalRows(db,projectId,domain,signal)).toBe(0);
      await mapping.listCanonicalHeaders(db,projectId,domain,null,1);
      const [count, headers] = query.mock.calls.slice(-2).map(call => (call as unknown as [{text:string;values:unknown[]}])[0]);
      expect(headers!.text).toContain(count!.text.slice(count!.text.indexOf(" FROM ")));
      expect(count!.text).toMatch(/^SELECT COUNT\(\*\)::text AS count FROM /);
      expect(count!.text).not.toMatch(/octet_length|row_to_json|LIMIT|ORDER BY/);
      expect(count!.values).toEqual([projectId]);
    }
    const options = (query.mock.calls[0] as unknown as [unknown, {operation:string;domain:string;projectId:string;signal:AbortSignal}])[1];
    expect(options).toEqual({domain:"transaction",operation:"portable-count",projectId,signal});
  });
  it("parses counts exactly and refuses non-canonical results", async () => {
    expect(await mapping.countCanonicalRows(executor([{count:"12"}]).db,projectId,"messages")).toBe(12);
    for (const rows of [[], [{}], [{count:7}], [{count:""}], [{count:"-1"}], [{count:"01"}], [{count:"1.5"}], [{count:"9007199254740993"}]])
      await expect(mapping.countCanonicalRows(executor(rows).db,projectId,"messages")).rejects.toMatchObject({code:"record-unrepresentable"});
    const db = {query: vi.fn(async () => { throw new Error("driver"); })} as unknown as PostgreSqlQueryExecutor;
    await expect(mapping.countCanonicalRows(db,projectId,"messages")).rejects.toThrow("driver");
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
    row.payload_envelope_supported = true;
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

it("fingerprints a canonical row projection deterministically and sensitively to content",()=>{
  const a=mapping.canonicalRowContentSha256({one:"1",two:"2"});
  const b=mapping.canonicalRowContentSha256({two:"2",one:"1"});
  const c=mapping.canonicalRowContentSha256({one:"1",two:"3"});
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});
it("batches canonical row reads by locator instead of one query per record",async()=>{
  const locators=[0,1,2].map(index=>JSON.stringify(["key"+index]));
  const {db,query}=executor([
    {test:"payload-0",__locator:locators[0]},
    {test:"payload-2",__locator:locators[2]},
  ]);
  const found=await mapping.readCanonicalContentRows(db,projectId,"machines",locators);
  expect(query.mock.calls).toHaveLength(1);
  expect(query.mock.calls[0][0].text).toContain('COLLATE "C" = ANY($2::text[])');
  expect(query.mock.calls[0][0].values?.[1]).toEqual(locators);
  expect(found.size).toBe(2);
  expect(found.get(locators[0]!)).toEqual({test:"payload-0"});
  expect(found.get(locators[2]!)).toEqual({test:"payload-2"});
  expect(found.has(locators[1]!)).toBe(false);
});
it("compares batch locators under the C collation, exactly as the single-row read does",async()=>{
  const single=executor([]);
  await mapping.readCanonicalContentRows(single.db,projectId,"session-ingest",[JSON.stringify(["a"])]);
  expect(single.query.mock.calls[0][0].text).toContain('json_build_array(r.ingest_key::text)::text COLLATE "C" = ANY($2::text[])');
  const multi=executor([]);
  await mapping.readCanonicalContentRows(multi.db,projectId,"promoted-memory-tags",[JSON.stringify(["a","1"])]);
  expect(multi.query.mock.calls[0][0].text).toContain('json_build_array(r.memory_id::text, r.ordinal::text)::text COLLATE "C" = ANY($2::text[])');
});
it("returns an empty map without querying when there are no locators to check",async()=>{
  const {db,query}=executor([]);
  expect(await mapping.readCanonicalContentRows(db,projectId,"machines",[])).toEqual(new Map());
  expect(query).not.toHaveBeenCalled();
});
it("refuses batches larger than the shared portable batch-record bound",async()=>{
  const {db}=executor([]);
  const {PORTABLE_LIMITS}=await import("../../src/storage/portable-record.js");
  const oversized=Array.from({length:PORTABLE_LIMITS.maxBatchRecords+1},(_,index)=>JSON.stringify(["key"+index]));
  await expect(mapping.readCanonicalContentRows(db,projectId,"machines",oversized)).rejects.toThrow();
});
it("refuses a malformed locator in a batch before issuing SQL",async()=>{
  const {db,query}=executor([]);
  for(const bad of ["bad",'{}','[]','[1]']) await expect(mapping.readCanonicalContentRows(db,projectId,"messages",[bad])).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
it("reads canonical content sizes without projecting payload columns or bounding row size",async()=>{
  const locators=[0,1,2].map(index=>JSON.stringify(["key"+index]));
  const {db,query}=executor([
    {__locator:locators[0],__bytes:"17"},
    {__locator:locators[2],__bytes:"150994944"},
  ]);
  const sizes=await mapping.readCanonicalContentSizes(db,projectId,"machines",locators);
  expect(query.mock.calls).toHaveLength(1);
  expect(query.mock.calls[0][0].text).toContain('COLLATE "C" = ANY($2::text[])');
  expect(query.mock.calls[0][0].text).toContain("octet_length");
  expect(query.mock.calls[0][0].text).not.toContain("<= $3");
  expect(query.mock.calls[0][0].values).toEqual([projectId,locators]);
  expect(query.mock.calls[0][1].operation).toBe("portable-content-sizes");
  expect(sizes.get(locators[0]!)).toBe(17n);
  expect(sizes.get(locators[2]!)).toBe(150994944n);
});
it("omits a locator missing from the size result instead of reporting it as zero bytes",async()=>{
  const locators=[0,1].map(index=>JSON.stringify(["key"+index]));
  const {db,query}=executor([{__locator:locators[1],__bytes:"0"}]);
  const sizes=await mapping.readCanonicalContentSizes(db,projectId,"session-instructions",locators);
  expect(query.mock.calls[0][0].text).toContain("JOIN lcm.machines m");
  expect(sizes.size).toBe(1);
  expect(sizes.has(locators[0]!)).toBe(false);
  expect(sizes.get(locators[1]!)).toBe(0n);
});
it("returns an empty size map without querying when there are no locators to size",async()=>{
  const {db,query}=executor([]);
  expect(await mapping.readCanonicalContentSizes(db,projectId,"machines",[])).toEqual(new Map());
  expect(query).not.toHaveBeenCalled();
});
it("refuses size batches larger than the shared portable batch-record bound",async()=>{
  const {db,query}=executor([]);
  const {PORTABLE_LIMITS}=await import("../../src/storage/portable-record.js");
  const oversized=Array.from({length:PORTABLE_LIMITS.maxBatchRecords+1},(_,index)=>JSON.stringify(["key"+index]));
  await expect(mapping.readCanonicalContentSizes(db,projectId,"machines",oversized)).rejects.toThrow(/invalid-limit/);
  expect(query).not.toHaveBeenCalled();
});
it("refuses a malformed locator before issuing a size query",async()=>{
  const {db,query}=executor([]);
  for(const bad of ["bad",'{}','[]','[1]']) await expect(mapping.readCanonicalContentSizes(db,projectId,"messages",[bad])).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
it("refuses a non-numeric canonical size value instead of coercing or dropping it",async()=>{
  const locator=JSON.stringify(["key0"]);
  for(const bad of ["","17.5","-1","1e3","NaN",null]){
    const {db}=executor([{__locator:locator,__bytes:bad}]);
    await expect(mapping.readCanonicalContentSizes(db,projectId,"machines",[locator])).rejects.toThrow(/malformed-record/);
  }
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
  expect(()=>mapping.decodeCanonicalRow("passive-events",{event_id:"a",event_version:"1",machine_sequence:"0",event_type:"x",machine_identity_key:42,payload_envelope_supported:true},context)).toThrow();
  const memory=buildDomainDrafts(postgresGeneration()).find(draft=>draft.domain==="promoted-memories")!.values[0];
  const memoryRow=Object.fromEntries(Object.entries(memory).map(([key,value])=>[key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`),typeof value === "object" && value !== null ? JSON.stringify(value) : value]));
  memoryRow.source_project_id=projectId;
  expect(mapping.decodeCanonicalRow("promoted-memories",memoryRow,context).value).toMatchObject({sourceProjectId:null});
});

it("normalizes authenticated local and remote self-provenance while preserving external origins", () => {
  const localProjectId = "a".repeat(64);
  const externalProjectId = "b".repeat(64);
  const memory = buildDomainDrafts(postgresGeneration()).find(draft => draft.domain === "promoted-memories")!.values[0];
  const row = Object.fromEntries(Object.entries(memory).map(([key, value]) => [
    key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
    typeof value === "object" && value !== null ? JSON.stringify(value) : value,
  ]));
  for (const [source, expected] of [[localProjectId, null], [projectId, null], [null, null], [externalProjectId, externalProjectId]] as const) {
    expect(mapping.decodeCanonicalRow("promoted-memories", { ...row, source_project_id: source }, {
      projectIdentity: { scope: "shared", projectId }, localProjectId,
    }).value).toMatchObject({ sourceProjectId: expected });
  }
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

it("bounds a multi-row header page by aggregate locator bytes in SQL while always keeping its first row (#1388)",async()=>{
  const {db,query}=executor([]);
  await mapping.listCanonicalHeaders(db,projectId,"project-aliases",JSON.stringify(["m","/p"]),500);
  const {text,values}=query.mock.calls[0][0];
  expect(values).toEqual([projectId,["m","/p"],500,"150994944"]);
  // The scan stops at the page limit before the window sees any row, in the
  // same C-collated key order the window then accumulates over.
  expect(text).toContain('ORDER BY ARRAY[r.machine_id::text COLLATE "C", r.normalized_path::text COLLATE "C"] COLLATE "C" LIMIT $3) sized WINDOW page_order AS (ORDER BY ARRAY[sized.machine_id::text COLLATE "C", sized.normalized_path::text COLLATE "C"] COLLATE "C" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
  // Running projected-locator bytes cut the page against the shared batch
  // budget; an oversized row still projects '' and adds nothing to the sum.
  expect(text).toContain("row_number() OVER page_order AS page_row");
  expect(text).toContain("sum(octet_length(CASE WHEN sized.byte_length <= $4::bigint THEN json_build_array(sized.machine_id::text, sized.normalized_path::text)::text ELSE '' END)) OVER page_order AS page_bytes");
  expect(text).toContain("WHERE page.page_row = 1 OR page.page_bytes <= $4::bigint ORDER BY page.page_row");
  // The projected row size is measured once per scanned row, inside the limited scan.
  expect(text.split("row_to_json(portable_row)")).toHaveLength(2);
  expect(text).toContain("AS byte_length FROM lcm.project_aliases r JOIN lcm.machines m ON m.machine_id = r.machine_id WHERE (r.project_id = $1::uuid)");
  // The conversation closure keeps its one-row reads without the aggregate window.
  await mapping.listConversationMessageHeaders(db,projectId,"1",null,1);
  expect(query.mock.calls[1][0].text).not.toContain("OVER");
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

it("stores canonical self memory provenance as the destination project UUID and preserves external provenance",async()=>{
  for(const [sourceProjectId,stored] of [[null,projectId],["external-project","external-project"]] as const) {
    const record=createPortableRecord({domain:"promoted-memories",ordinal:0,context:{projectIdentity:{scope:"shared",projectId}},value:{memoryId:"550e8400-e29b-41d4-a716-446655440000",content:"own memory",metadata:{},sourceProjectId,sourceSummaryId:null,sessionId:null,depth:0,confidence:1,createdAt:timestamp,archivedAt:null}});
    const {db,query}=executor([{locator:'["550e8400-e29b-41d4-a716-446655440000"]'}]);
    await mapping.insertCanonicalRecord(db,projectId,record,async()=>"unused");
    expect(query.mock.calls[0][0].text).toContain("source_project_id");
    expect(query.mock.calls[0][0].values?.[4]).toBe(stored);
  }
});

it("refuses unsupported passive envelope metadata without fetching unknown payload values",async()=>{
  const context={projectIdentity:{scope:"shared" as const,projectId}};
  const row={event_id:"01990000-0000-7000-8000-000000000010",event_version:"1",machine_sequence:"0",event_type:"context",machine_identity_key:"machine:"+"a".repeat(64),status:"applied",sessionId:"session",sessionSequence:"1",category:"context",data:'{"unknownOpaqueDataKey":"preserved"}',priority:"0",sourceHook:"fixture",createdAt:timestamp};
  for(const unsupported of [false,undefined]) expect(()=>mapping.decodeCanonicalRow("passive-events",{...row,payload_envelope_supported:unsupported},context)).toThrow();
  expect(mapping.decodeCanonicalRow("passive-events",{...row,payload_envelope_supported:true},context).value).toMatchObject({data:row.data,disposition:"applied"});
  const {db,query}=executor([]);
  await mapping.readCanonicalRow(db,projectId,"passive-events",'["1"]');
  expect(query.mock.calls[0][0].text).toContain("jsonb_object_keys(r.payload)");
  expect(query.mock.calls[0][0].text).toContain("AS payload_envelope_supported");
  expect(query.mock.calls[0][0].text).not.toContain("r.payload::text");
});

it("requires native JSON types before extracting passive-event envelope text",()=>{
  const sql=mapping.mappingForDomain("passive-events").selectColumns;
  for(const key of ["sessionId","category","data","sourceHook","createdAt"]) expect(sql).toContain(`pg_catalog.jsonb_typeof(r.payload->'${key}') = 'string'`);
  for(const key of ["sessionSequence","priority"]) expect(sql).toContain(`pg_catalog.jsonb_typeof(r.payload->'${key}') = 'number'`);
});

it("budgets a batch item as its row bytes plus its two UTF-8 locator copies",()=>{
  expect(mapping.canonicalBatchItemBytes(1000n,'["12"]')).toBe(1000n+2n*6n);
  // Buffer.byteLength, not UTF-16 length: "é" is two bytes and "€" is three.
  expect(mapping.canonicalBatchItemBytes(7n,'["é€"]')).toBe(7n+2n*BigInt(Buffer.byteLength('["é€"]')));
  expect(Buffer.byteLength('["é€"]')).toBe(9);
  expect(mapping.canonicalBatchItemBytes(5n,"")).toBe(5n);
});

it("maps the optional conversation parent column only when it holds a value",async()=>{
  const context={projectIdentity:{scope:"shared" as const,projectId},occurrenceOrdinal:"0"};
  const row={session_id:"session",title:null,bootstrapped_at:null,created_at:timestamp,updated_at:timestamp};
  const plain=mapping.decodeCanonicalRow("conversations",{...row,parent_session_id:null},context);
  expect(plain.value).not.toHaveProperty("parentSessionId");
  expect(mapping.decodeCanonicalRow("conversations",row,context).value).not.toHaveProperty("parentSessionId");
  const linked=mapping.decodeCanonicalRow("conversations",{...row,parent_session_id:"parent-thread"},context);
  expect(linked.value).toMatchObject({parentSessionId:"parent-thread"});
  const record=(input:typeof plain)=>createPortableRecord({...input,ordinal:0} as import("../../src/storage/portable-record.js").PortableRecordInput);
  expect(record(linked).identitySha256).toBe(record(plain).identitySha256);
  for(const [input,expected] of [[plain,false],[linked,true]] as const){
    const calls:{text:string;values:unknown[]}[]=[];
    const db={query:async(config:{text:string;values:unknown[]})=>{
      calls.push(config);
      return {rows:[{locator:'["8"]'}],rowCount:1,fields:[],command:"SELECT",oid:0};
    }} as unknown as PostgreSqlQueryExecutor;
    await mapping.insertCanonicalRecord(db,projectId,record(input),async()=> '["7"]');
    const insert=calls.find(call=>call.text.startsWith("INSERT"))!;
    expect(insert.text.includes("parent_session_id")).toBe(expected);
    expect(insert.values.includes("parent-thread")).toBe(expected);
  }
});
