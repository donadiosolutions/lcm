import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  iteratePortableRuntimeRows,
  readPortableRuntimeRow,
  writePortableRuntimeRecord,
} from "../../src/storage/sqlite/portable-runtime-mapping.js";
import { PORTABLE_LIMITS, PortableStreamError, type PortableDomain } from "../../src/storage/portable-record.js";
import { buildRecords, sqliteBoundGeneration } from "../fixtures/portable-records.js";

const options = sqliteBoundGeneration();
const domains: PortableDomain[] = [
  "conversations", "messages", "message-parts", "large-files", "summaries",
  "summary-file-links", "summary-message-links", "summary-parent-links", "context-items",
  "promoted-memories", "promoted-memory-tags", "recall-surfacings", "redaction-counters", "session-ingest",
];
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function unbrand(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "$integer" in value) {
    return BigInt(value.$integer as string);
  }
  return value;
}

describe("SQLite canonical runtime mapping", () => {
  it("persists and independently rereads every runtime domain with exact native values", () => {
    const db = database();
    const records = buildRecords(options);
    const identities = new Map<string, string>();
    const reverse = new Map<string, string>();
    const lookup = (domain: PortableDomain, identity: string) => {
      const locator = identities.get(`${domain}:${identity}`);
      if (locator === undefined) throw new Error("missing dependency");
      return locator;
    };
    db.exec("BEGIN");
    for (const domain of domains) {
      for (const record of records.get(domain)!) {
        const locator = writePortableRuntimeRecord(db, record, lookup, options.projectIdentity);
        identities.set(`${domain}:${record.identitySha256}`, locator);
        reverse.set(`${domain}:${locator}`, record.identitySha256);
      }
    }
    db.exec("COMMIT");
    for (const domain of domains) {
      const rows = [...iteratePortableRuntimeRows(db, domain, options)];
      expect(rows.length, domain).toBe(records.get(domain)!.length);
      for (const record of records.get(domain)!) {
        const row = readPortableRuntimeRow(db, domain, lookup(domain, record.identitySha256), options)!;
        expect(rows).toContainEqual(row);
        const actual = { ...row.value };
        for (const ref of row.references ?? []) actual[ref.field] = reverse.get(`${ref.domain}:${ref.locator}`);
        const expected = Object.fromEntries(Object.entries(record.value).map(([key, value]) => [key, unbrand(value)]));
        delete expected.conversationFingerprint;
        delete expected.occurrenceOrdinal;
        expect(actual, `${domain}:${row.locator}`).toEqual(expected);
      }
    }
    expect(db.prepare("SELECT subtask_desc, is_ignored, is_synthetic, compaction_auto, metadata FROM message_parts WHERE subtask_desc IS NOT NULL").get()).toMatchObject({ subtask_desc: expect.any(String) });
    expect(db.prepare("SELECT tags FROM promoted WHERE id='memory-alpha-1'").get()).toEqual({ tags: '["storage","protocol","storage"]' });
    expect(db.prepare("SELECT count(*) AS n FROM recall_surfacing").get()).toEqual({ n: 3 });
    const message = db.prepare("SELECT message_id FROM messages LIMIT 1").get()!;
    db.prepare("UPDATE messages SET content='native mutation' WHERE message_id=?").run(message.message_id);
    expect(readPortableRuntimeRow(db, "messages", String(message.message_id), options)?.value.content).toBe("native mutation");
  });

  it("reads a conversation message closure in numeric sequence order without including siblings", () => {
    const db = database();
    db.exec("INSERT INTO conversations(conversation_id,session_id) VALUES(1,'one'),(2,'two')");
    db.exec("INSERT INTO messages(conversation_id,seq,role,content,token_count) VALUES(1,10,'user','ten',0),(2,1,'user','other',0),(1,2,'user','two',0)");
    expect([...iteratePortableRuntimeRows(db, "messages", { conversationLocator: "1" })].map(row => row.value.content)).toEqual(["two", "ten"]);
  });

  it("allocates native IDs above the safe-number range and retains legal orphan recall provenance", () => {
    const db = database();
    db.exec("INSERT INTO sqlite_sequence(name,seq) VALUES('conversations',9007199254740993),('messages',9007199254740993)");
    const records = buildRecords(options);
    const conversation = records.get("conversations")![0];
    const message = records.get("messages")!.find(record => record.value.conversationIdentitySha256 === conversation.identitySha256)!;
    const locator = writePortableRuntimeRecord(db, conversation, () => "", options.projectIdentity);
    expect(locator).toBe("9007199254740994");
    const messageLocator = writePortableRuntimeRecord(db, message, () => locator, options.projectIdentity);
    expect(messageLocator).toBe("9007199254740994");
    expect(readPortableRuntimeRow(db, "messages", messageLocator)?.references).toEqual([{ field: "conversationIdentitySha256", domain: "conversations", locator: "9007199254740994" }]);
    db.exec("INSERT INTO recall_surfacing(memory_id,surfaced_at) VALUES('missing-memory','2026-09-06 12:00:00.1')");
    expect([...iteratePortableRuntimeRows(db, "recall-surfacings")][0].value).toEqual({ memoryId: "missing-memory", sessionId: null, surfacedAt: "2026-09-06T12:00:00.100000Z" });
  });

  it("normalizes native timestamps without losing microseconds and scopes redaction counters", () => {
    const db = database();
    db.prepare("INSERT INTO session_ingest_log VALUES(?,?,?)").run("session", "2026-09-06 12:34:56.123456", 9223372036854775807n);
    db.prepare("INSERT INTO redaction_stats VALUES(?,?,?)").run(options.projectIdentity.projectId, "project", 9223372036854775807n);
    db.prepare("INSERT INTO redaction_stats VALUES('other','global',99)").run();
    expect([...iteratePortableRuntimeRows(db, "session-ingest")][0].value).toEqual({ sessionId: "session", completedAt: "2026-09-06T12:34:56.123456Z", messageCount: 9223372036854775807n });
    expect([...iteratePortableRuntimeRows(db, "redaction-counters", options)].map(row => row.value)).toEqual([{ category: "project", count: 9223372036854775807n }]);
    expect(readPortableRuntimeRow(db, "redaction-counters", "global", options)).toBeUndefined();
  });

  it("rejects skipped or repeated array ordinals and preserves the surrounding transaction", () => {
    const db = database();
    const record = buildRecords(options).get("promoted-memory-tags")![0];
    db.prepare("INSERT INTO promoted(id,content,project_id) VALUES('memory-alpha-1','memory',?)").run(options.projectIdentity.projectId);
    const lookup = () => { throw new Error("array identity uses native preserved keys"); };
    db.exec("BEGIN");
    writePortableRuntimeRecord(db, record, lookup, options.projectIdentity);
    expect(() => writePortableRuntimeRecord(db, record, lookup, options.projectIdentity)).toThrow(PortableStreamError);
    db.exec("ROLLBACK");
    expect([...iteratePortableRuntimeRows(db, "promoted-memory-tags")]).toEqual([]);
    expect(readPortableRuntimeRow(db, "promoted-memory-tags", '["missing","0"]')).toBeUndefined();
  });

  it("rejects malformed locators, unsupported domains and unscoped provenance reads", () => {
    const db = database();
    for (const locator of ["not json", "[]", '[1,"0"]']) {
      expect(() => readPortableRuntimeRow(db, "summary-parent-links", locator)).toThrow(PortableStreamError);
    }
    expect(() => [...iteratePortableRuntimeRows(db, "machines")]).toThrow(PortableStreamError);
    expect(() => [...iteratePortableRuntimeRows(db, "redaction-counters")]).toThrow(PortableStreamError);
    const record = buildRecords(options).get("machines")![0];
    expect(() => writePortableRuntimeRecord(db, record, () => "", options.projectIdentity)).toThrow(PortableStreamError);
    expect(readPortableRuntimeRow(db, "messages", "999")).toBeUndefined();
  });

  it("fails closed on malformed native booleans, timestamps and JSON instead of coercing them", () => {
    const db = database();
    db.exec("INSERT INTO conversations(conversation_id,session_id) VALUES(1,'one')");
    db.exec("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count) VALUES(1,1,0,'user','hello',0)");
    db.exec("INSERT INTO message_parts(part_id,message_id,session_id,part_type,ordinal,is_ignored) VALUES('part',1,'one','text',0,7)");
    expect(() => readPortableRuntimeRow(db, "message-parts", "part")).toThrow(PortableStreamError);
    for (const value of ["broken", new Uint8Array([1, 2])]) {
      db.prepare("UPDATE conversations SET created_at=?").run(value);
      expect(() => readPortableRuntimeRow(db, "conversations", "1")).toThrow(PortableStreamError);
    }
    db.prepare("INSERT INTO promoted(id,content,project_id,metadata) VALUES('m','content',?,'bad json')").run(options.projectIdentity.projectId);
    expect(() => readPortableRuntimeRow(db, "promoted-memories", "m", options)).toThrow(PortableStreamError);
    for (const value of ["broken", "{}", '[false]']) {
      db.prepare("UPDATE promoted SET tags=?").run(value);
      expect(() => [...iteratePortableRuntimeRows(db, "promoted-memory-tags")]).toThrow(PortableStreamError);
    }
  });

  it("rejects an oversized native payload or array before returning any row", () => {
    const db = database();
    db.prepare("INSERT INTO conversations(session_id,title) VALUES('one',zeroblob(?))").run(PORTABLE_LIMITS.maxRecordBytes + 1);
    expect(() => [...iteratePortableRuntimeRows(db, "conversations")]).toThrow(PortableStreamError);
    expect(() => readPortableRuntimeRow(db, "conversations", "1")).toThrow(PortableStreamError);
    db.exec("DELETE FROM conversations");
    db.prepare("INSERT INTO promoted(id,content,project_id,tags) VALUES('m','content',?,zeroblob(?))").run(options.projectIdentity.projectId, PORTABLE_LIMITS.maxRecordBytes + 1);
    expect(() => [...iteratePortableRuntimeRows(db, "promoted-memory-tags")]).toThrow(PortableStreamError);
  });
});

it("refuses a NUL hidden in an expanded JSON tag before the driver can truncate it", () => {
  const db = database();
  db.prepare("INSERT INTO promoted(id,content,tags,project_id) VALUES('nul-memory','safe',?,'project')").run(JSON.stringify(["prefix\u0000suffix"]));
  const evidence = db.prepare("SELECT length(CAST(j.value AS BLOB)) AS bytes,j.value AS value FROM promoted,json_each(tags) j").get()!;
  expect(evidence.bytes).toBe(13);
  expect(evidence.value).toBe("prefix");
  expect(() => [...iteratePortableRuntimeRows(db,"promoted-memory-tags")]).toThrowError(expect.objectContaining({code:"record-unrepresentable"}));
  expect(() => readPortableRuntimeRow(db,"promoted-memory-tags",JSON.stringify(["nul-memory","0"]))).toThrowError(expect.objectContaining({code:"record-unrepresentable"}));
});

it.each([
  ["content", "80", "promoted-memories"],
  ["metadata", "7b2278223a2280227d", "promoted-memories"],
  ["tags", "5b2280225d", "promoted-memory-tags"],
  ["id", "80", "promoted-memories"],
  ["id", "80", "promoted-memory-tags"],
] as const)("refuses malformed UTF-8 in native %s bytes %s", (column, hex, domain) => {
  const db = database();
  db.prepare("INSERT INTO promoted(id,content,project_id,tags) VALUES('m','safe',?,'[\"safe\"]')").run(options.projectIdentity.projectId);
  db.exec(`UPDATE promoted SET ${column}=CAST(X'${hex}' AS TEXT)`);
  expect(db.prepare(`SELECT hex(CAST(${column} AS BLOB)) AS raw FROM promoted`).get()?.raw).toBe(hex.toUpperCase());
  expect(() => [...iteratePortableRuntimeRows(db, domain, options)]).toThrowError(expect.objectContaining({code: "unsupported-capability"}));
  if (column !== "id") {
    expect(() => readPortableRuntimeRow(db, domain, domain === "promoted-memory-tags" ? '["m","0"]' : "m", options))
      .toThrowError(expect.objectContaining({code: "unsupported-capability"}));
  }
});

it("preserves genuine replacement characters and Unicode in native scalars, JSON, arrays and locators", () => {
  const db = database();
  const text = "\uFEFF�é水😀";
  db.prepare("INSERT INTO promoted(id,content,metadata,tags,project_id) VALUES(?,?,?,?,?)")
    .run(text, text, JSON.stringify({[text]: text}), JSON.stringify([text]), options.projectIdentity.projectId);
  const memory = [...iteratePortableRuntimeRows(db, "promoted-memories", options)][0];
  expect(memory.locator).toBe(text);
  expect(memory.value).toMatchObject({ memoryId: text, content: text, metadata: {[text]: text} });
  expect(readPortableRuntimeRow(db, "promoted-memories", text, options)).toEqual(memory);
  const tag = [...iteratePortableRuntimeRows(db, "promoted-memory-tags", options)][0];
  expect(tag).toEqual({locator: JSON.stringify([text, "0"]), value: {memoryId: text, ordinal: 0n, tag: text}});
  expect(readPortableRuntimeRow(db, "promoted-memory-tags", tag.locator, options)).toEqual(tag);
});

it("uses the authenticated local source ID for shared project predicates and self provenance", () => {
  const db = database();
  const sourceLocalProjectId = "b".repeat(64);
  const bound = {...options, sourceLocalProjectId};
  db.prepare("INSERT INTO promoted(id,content,project_id) VALUES('self','memory',?)").run(sourceLocalProjectId);
  db.prepare("INSERT INTO redaction_stats VALUES(?,?,?)").run(sourceLocalProjectId, "gitleaks", 7);
  db.prepare("INSERT INTO redaction_stats VALUES(?,?,?)").run(options.projectIdentity.projectId, "global", 99);
  expect([...iteratePortableRuntimeRows(db, "redaction-counters", bound)].map(row => row.value)).toEqual([{ category: "gitleaks", count: 7n }]);
  expect(readPortableRuntimeRow(db, "redaction-counters", "gitleaks", bound)?.value.count).toBe(7n);
  expect(readPortableRuntimeRow(db, "promoted-memories", "self", bound)?.value.sourceProjectId).toBeNull();
});

it("refuses malformed bytes in a JSON BLOB before returning substituted array strings", () => {
  const db = database();
  db.exec("INSERT INTO promoted(id,content,project_id,tags) VALUES('m','safe','project',X'5b2280225d')");
  expect(() => [...iteratePortableRuntimeRows(db, "promoted-memory-tags")]).toThrowError(expect.objectContaining({code: "unsupported-capability"}));
});


it("validates each immutable parent once while point rereading actual bounded array elements", () => {
  const db = database();
  db.exec("INSERT INTO promoted(id,content,project_id,tags) VALUES('m','safe','project','[\"one\",\"two\",\"three\"]'),('other','safe','project','[\"other\"]')");
  const validated = new Set<string>();
  const arrayValidation = {
    has: (domain: PortableDomain, parent: string) => validated.has(`${domain}:${parent}`),
    add: (domain: PortableDomain, parent: string) => { validated.add(`${domain}:${parent}`); },
  };
  const readOptions = { arrayValidation };
  const prepare = vi.spyOn(db, "prepare");
  for (const [ordinal, tag] of ["one", "two", "three"].entries()) {
    expect(readPortableRuntimeRow(db, "promoted-memory-tags", JSON.stringify(["m", String(ordinal)]), readOptions)?.value.tag).toBe(tag);
  }
  expect([...iteratePortableRuntimeRows(db, "promoted-memory-tags", readOptions)].map(row => row.value.tag)).toEqual(["one", "two", "three", "other"]);
  // Only the two parent payloads cross the driver for validation; every point
  // reread still fetches its actual SQL element rather than a cached record.
  expect(prepare.mock.calls.filter(([sql]) => sql.includes('_portable_utf8_type_tags'))).toHaveLength(2);
  expect(validated).toEqual(new Set(["promoted-memory-tags:m", "promoted-memory-tags:other"]));
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("json_each"))).toHaveLength(5);
});
