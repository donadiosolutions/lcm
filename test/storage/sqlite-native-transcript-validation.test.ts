import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
  type CreateNativeTranscriptInput,
  type JsonObject,
  type JsonValue,
  type NativeTranscriptBatchInput,
} from "../../src/storage/contracts.js";
import { StorageOperationError } from "../../src/storage/errors.js";
import { canonicalNativeTranscriptJson } from "../../src/storage/native-transcript-ingest.js";
import { SqliteExecutor } from "../../src/storage/sqlite/executor.js";
import { SqliteNativeTranscriptRepository } from "../../src/storage/sqlite/native-transcript-repository.js";
import type { RepositoryInvoker } from "../../src/storage/sqlite/repositories.js";

const projectId = "local-project-hash";
const key = { machineId: "local", clientName: "codex", sourceLocator: "sessions/a.jsonl" };
const databases: DatabaseSync[] = [];

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  runLcmMigrations(db, { fts5Available: false });
  const executor = new SqliteExecutor(db, projectId);
  const invoke: RepositoryInvoker = (domain, operation, callback, atomic) => atomic
    ? executor.runAtomic(domain, operation, callback)
    : executor.run(domain, operation, callback);
  return { db, repository: new SqliteNativeTranscriptRepository(db, projectId, invoke) };
}

function record(nativePayload: JsonObject | JsonValue[] = { text: "hello", nested: [true, 1, null] }): CreateNativeTranscriptInput {
  return {
    formatName: "codex-jsonl", formatVersion: "v1", nativeSessionId: "session-a",
    sourceOrdinal: 0, observedAt: new Date("2026-01-01T00:00:00.000Z"),
    scrubberVersion: "v1", ingestKey: "b".repeat(64), nativePayload,
    contentSha256: createHash("sha256").update(canonicalNativeTranscriptJson(nativePayload)).digest("hex"),
  };
}

function batch(value = record()): NativeTranscriptBatchInput {
  return {
    ...key, expectedCheckpoint: null, records: [value], quarantinedCount: 0,
    checkpoint: { lastSourceOrdinal: value.sourceOrdinal, checkpoint: { byteOffset: 42 } },
  };
}

async function rejected(operation: Promise<unknown>): Promise<void> {
  const error: unknown = await operation.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(StorageOperationError);
  expect(error).toMatchObject({ backend: "sqlite", domain: "native-transcripts", projectId });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain("PRIVATE_SENTINEL");
}

function nested(depth: number, arrays: boolean): JsonObject | JsonValue[] {
  let value: JsonValue = "leaf";
  for (let index = 0; index < depth; index += 1) value = arrays ? [value] : { nested: value };
  return value as JsonObject | JsonValue[];
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("SQLite native transcript validation", () => {
  it("rejects invalid scope, provenance, counters and record fields without persisting a checkpoint", async () => {
    const { repository } = fixture();
    const valid = batch();
    const invalid: NativeTranscriptBatchInput[] = [
      { ...valid, machineId: "" }, { ...valid, clientName: " " },
      { ...valid, records: {} as never },
      { ...valid, checkpoint: { ...valid.checkpoint, checkpoint: [] as never } },
    ];
    for (const sourceLocator of ["", "/PRIVATE_SENTINEL.jsonl", "C:\\PRIVATE_SENTINEL.jsonl", "\\\\host\\PRIVATE_SENTINEL", "../PRIVATE_SENTINEL", "sessions/../PRIVATE_SENTINEL", "sessions\\..\\PRIVATE_SENTINEL", "a\0b"]) {
      invalid.push({ ...valid, sourceLocator });
      await rejected(repository.listBySource({ ...key, sourceLocator }));
      await rejected(repository.getCheckpoint({ ...key, sourceLocator }));
    }
    for (const bad of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true]) {
      invalid.push({ ...valid, quarantinedCount: bad as number });
      invalid.push({ ...valid, checkpoint: { ...valid.checkpoint, lastSourceOrdinal: bad as number } });
      invalid.push(batch({ ...record(), sourceOrdinal: bad as number }));
      for (const field of ["conversationId", "messageId", "sourceOrdinal"] as const) {
        invalid.push(batch({ ...record(), messageLinks: [{ conversationId: 1, messageId: 1, sourceOrdinal: 0, [field]: bad }] }));
      }
    }
    for (const field of ["formatName", "formatVersion", "nativeSessionId", "scrubberVersion"] as const) {
      for (const bad of [" ", "PRIVATE_SENTINEL\0", "PRIVATE_SENTINEL\ud800", "PRIVATE_SENTINEL\udc00"]) {
        invalid.push(batch({ ...record(), [field]: bad }));
      }
    }
    for (const field of ["contentSha256", "ingestKey"] as const) {
      for (const bad of ["PRIVATE_SENTINEL", "A".repeat(64), "a".repeat(63)]) invalid.push(batch({ ...record(), [field]: bad }));
    }
    invalid.push(batch({ ...record(), observedAt: new Date(Number.NaN) }));
    invalid.push(batch({ ...record(), observedAt: 42 as never }));
    invalid.push({ ...valid, records: [{ ...record(), sourceOrdinal: 1 }] });
    for (const input of invalid) await rejected(repository.ingestBatch(input));
    expect(await repository.getCheckpoint(key)).toBeNull();
    expect(await repository.listBySource(key)).toEqual([]);
  });

  it("rejects non-data containers without invoking accessors or accepting lossy JSON", async () => {
    const { repository } = fixture();
    const getter = vi.fn(() => "PRIVATE_SENTINEL");
    const accessor = Object.defineProperty({}, "text", { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, "text", { value: "PRIVATE_SENTINEL" });
    const symbol = { [Symbol("PRIVATE_SENTINEL")]: true };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const extended = Object.assign([1], { extra: "PRIVATE_SENTINEL" });
    const accessorArray = Object.defineProperty([1], "0", { enumerable: true, get: getter });
    const invalidPayloads: unknown[] = [
      null, "PRIVATE_SENTINEL", 42, new Date(), Object.create(null), accessor, hidden,
      symbol, cyclic, new Array(1), extended, accessorArray,
      { text: "PRIVATE_SENTINEL\ud800" }, { "PRIVATE_SENTINEL\udc00": true },
      ...[undefined, 1n, Symbol("PRIVATE_SENTINEL"), () => 1, NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1].map(value => ({ value })),
    ];
    for (const nativePayload of invalidPayloads) {
      await rejected(repository.ingestBatch(batch({ ...record(), nativePayload: nativePayload as never })));
      await rejected(repository.ingestBatch({ ...batch(), checkpoint: { lastSourceOrdinal: 0, checkpoint: nativePayload as never } }));
    }
    const accessorBatch = Object.defineProperty({ ...batch() }, "records", { enumerable: true, get: getter });
    await rejected(repository.ingestBatch(accessorBatch));
    const accessorRecords = Object.defineProperty([record()], "0", { enumerable: true, get: getter });
    await rejected(repository.ingestBatch({ ...batch(), records: accessorRecords }));
    expect(getter).not.toHaveBeenCalled();
    expect(await repository.getCheckpoint(key)).toBeNull();
  });

  it("binds digests to canonical payloads and preserves special keys and finite numeric boundaries", async () => {
    const { repository } = fixture();
    const payload = JSON.parse('{"z":[true,null,0,0.5,-2],"__proto__":{"constructor":"safe"},"a":"😀"}') as JsonObject;
    const input = record(payload);
    await rejected(repository.ingestBatch(batch({ ...input, contentSha256: "c".repeat(64) })));
    const rawDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    expect(rawDigest).not.toBe(input.contentSha256);
    await rejected(repository.ingestBatch(batch({ ...input, contentSha256: rawDigest })));
    const accepted = await repository.ingestBatch(batch(input));
    expect(accepted.importedCount).toBe(1);
    const [stored] = await repository.listBySource(key);
    expect(stored).toMatchObject({ projectId, machineId: "local", nativePayload: payload, contentSha256: input.contentSha256 });
    expect(Object.hasOwn(stored!.nativePayload, "__proto__")).toBe(true);
    expect(stored!.transcriptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    const boundary = record({ max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER, fraction: Number.MIN_VALUE });
    const result = await repository.ingestBatch({
      ...batch({ ...boundary, ingestKey: "d".repeat(64), sourceOrdinal: Number.MAX_SAFE_INTEGER }),
      sourceLocator: "sessions/boundary.jsonl", quarantinedCount: Number.MAX_SAFE_INTEGER,
    });
    expect(result.checkpoint).toMatchObject({ lastSourceOrdinal: Number.MAX_SAFE_INTEGER, quarantinedCount: Number.MAX_SAFE_INTEGER });
    expect((await repository.listBySource({ ...key, sourceLocator: "sessions/boundary.jsonl" }))[0]!.nativePayload).toEqual(boundary.nativePayload);
  });

  it("enforces shared JSON depth while allowing both container kinds at the limit", async () => {
    const { repository } = fixture();
    for (const arrays of [false, true]) {
      const tooDeep = nested(NATIVE_TRANSCRIPT_MAX_JSON_DEPTH + 1, arrays);
      await rejected(repository.ingestBatch(batch(record(tooDeep))));
      const allowed = nested(NATIVE_TRANSCRIPT_MAX_JSON_DEPTH, arrays);
      const sourceLocator = `sessions/depth-${arrays}.jsonl`;
      await repository.ingestBatch({ ...batch({ ...record(allowed), ingestKey: (arrays ? "e" : "f").repeat(64) }), sourceLocator });
      expect((await repository.listBySource({ ...key, sourceLocator }))[0]!.nativePayload).toEqual(allowed);
    }
  });

  it("rejects duplicate links and invalid read keys with sanitized errors", async () => {
    const { db, repository } = fixture();
    db.exec(`
      INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'session-a');
      INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
        VALUES (1, 1, 0, 'user', 'hello', 1), (2, 1, 1, 'assistant', 'reply', 1);
    `);
    const link = { conversationId: 1, messageId: 1, sourceOrdinal: 0 };
    for (const second of [{ ...link }, { ...link, messageId: 2 }, { ...link, sourceOrdinal: 1 }]) {
      await rejected(repository.ingestBatch(batch({ ...record(), messageLinks: [link, second] })));
    }
    expect(await repository.getCheckpoint(key)).toBeNull();
    for (const nativeSessionId of ["", " ", "PRIVATE_SENTINEL\0", "PRIVATE_SENTINEL\ud800"]) {
      await rejected(repository.listByNativeSession({ nativeSessionId }));
      await rejected(repository.getNativeTranscriptMessageSnapshot(nativeSessionId));
    }
    for (const id of ["PRIVATE_SENTINEL", "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9022"]) await rejected(repository.getById(id));
    await rejected(repository.listByMessage({ conversationId: -1, messageId: 1 }));
    await rejected(repository.listByMessage({ conversationId: 1, messageId: Number.MAX_SAFE_INTEGER + 1 }));
    expect(await repository.listByNativeSession({ nativeSessionId: "missing😀" })).toEqual([]);
    expect(await repository.getNativeTranscriptMessageSnapshot("missing😀")).toEqual([]);
    const accepted = await repository.ingestBatch(batch({ ...record(), messageLinks: [link] }));
    expect(accepted.importedCount).toBe(1);
    expect((await repository.listByMessage(link))[0]!.messageLinks).toMatchObject([link]);
  });

  it("orders multiple links, accepts all snapshot roles, and rejects malformed stored data", async () => {
    const { db, repository } = fixture();
    db.exec(`
      INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'session-a');
      INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
        VALUES (1, 1, 0, 'system', '', 0), (2, 1, 1, 'user', 'question', 1),
               (3, 1, 2, 'assistant', 'answer', 1), (4, 1, 3, 'tool', 'result', 1);
    `);
    expect((await repository.getNativeTranscriptMessageSnapshot("session-a")).map(message => message.role))
      .toEqual(["system", "user", "assistant", "tool"]);
    const messageLinks = [
      { conversationId: 1, messageId: 4, sourceOrdinal: 2_147_483_647 },
      { conversationId: 1, messageId: 1, sourceOrdinal: 0 },
    ];
    await rejected(repository.ingestBatch(batch({ ...record(), messageLinks: [{ ...messageLinks[0]!, sourceOrdinal: 2_147_483_648 }] })));
    await repository.ingestBatch(batch({ ...record(), messageLinks }));
    const [saved] = await repository.listBySource(key);
    expect(saved!.messageLinks.map(link => link.messageId)).toEqual([1, 4]);
    expect(saved!.messageLinks[1]!.sourceOrdinal).toBe(2_147_483_647);

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE messages SET role = ? WHERE message_id = 4").run("PRIVATE_SENTINEL");
    await rejected(repository.getNativeTranscriptMessageSnapshot("session-a"));
    db.prepare("UPDATE messages SET role = 'tool', content = ? WHERE message_id = 4").run(Buffer.from("PRIVATE_SENTINEL"));
    await rejected(repository.getNativeTranscriptMessageSnapshot("session-a"));
    db.prepare("UPDATE runtime_native_transcripts SET native_payload = ? WHERE transcript_id = ?")
      .run('{"text":"PRIVATE_SENTINEL"}', saved!.transcriptId);
    await rejected(repository.getById(saved!.transcriptId));
    db.prepare("UPDATE runtime_native_transcripts SET native_payload = ? WHERE transcript_id = ?")
      .run("PRIVATE_SENTINEL invalid JSON", saved!.transcriptId);
    await rejected(repository.listBySource(key));
    db.prepare("UPDATE runtime_native_ingest_checkpoints SET checkpoint = ?").run("PRIVATE_SENTINEL invalid JSON");
    await rejected(repository.getCheckpoint(key));
  });

  it("refuses malformed or foreign expected checkpoints and leaves the durable checkpoint intact", async () => {
    const { repository } = fixture();
    const initial = await repository.ingestBatch(batch());
    const expected = initial.checkpoint;
    const invalid: Record<string, unknown>[] = [
      { projectId: "other-project" }, { machineId: "other-machine" }, { clientName: "claude" },
      { sourceLocator: "sessions/other.jsonl" }, { updatedAt: new Date(NaN) },
      { checkpoint: [] }, { checkpoint: { invalid: Infinity } },
    ];
    for (const field of ["revision", "lastSourceOrdinal", "importedCount", "skippedCount", "quarantinedCount"]) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) invalid.push({ [field]: value });
    }
    for (const patch of invalid) {
      await rejected(repository.ingestBatch({ ...batch(), records: [], expectedCheckpoint: { ...expected, ...patch } }));
    }
    await rejected(repository.ingestBatch({ ...batch(), records: [], checkpoint: { lastSourceOrdinal: 1, checkpoint: { byteOffset: 43 } }, expectedCheckpoint: { ...expected, revision: expected.revision + 1 } }));
    expect(await repository.getCheckpoint(key)).toEqual(expected);
    expect(await repository.listBySource(key)).toHaveLength(1);
  });
});
