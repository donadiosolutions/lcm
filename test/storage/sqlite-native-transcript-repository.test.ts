import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import type { NativeTranscriptBatchInput } from "../../src/storage/contracts.js";
import { SqliteExecutor } from "../../src/storage/sqlite/executor.js";
import { SqliteNativeTranscriptRepository } from "../../src/storage/sqlite/native-transcript-repository.js";

const projectId = "local-project";
const key = { machineId: "local", clientName: "codex", sourceLocator: "sessions/a.jsonl" };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  runLcmMigrations(db, { fts5Available: false });
  const executor = new SqliteExecutor(db, projectId);
  const repo = new SqliteNativeTranscriptRepository(db, projectId, (domain, operation, callback, atomic) =>
    atomic ? executor.runAtomic(domain, operation, callback) : executor.run(domain, operation, callback));
  db.exec("INSERT INTO conversations(conversation_id,session_id) VALUES(1,'session'),(2,'session-extra'),(3,'session'); INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count) VALUES(1,1,1,'user','hello',1),(2,2,1,'user','other',1),(3,3,0,'assistant','hello',1)");
  return { db, repo, executor };
}
function batch(): NativeTranscriptBatchInput {
  return { ...key, expectedCheckpoint: null, quarantinedCount: 2,
    records: [{ formatName: "codex-jsonl", formatVersion: "v1", nativeSessionId: "session", sourceOrdinal: 1, observedAt: new Date("2026-01-01T00:00:00Z"), scrubberVersion: "v1", contentSha256: createHash("sha256").update('{"text":"hello"}').digest("hex"), ingestKey: "a".repeat(64), nativePayload: { text: "hello" }, messageLinks: [{ conversationId: 1, messageId: 1, sourceOrdinal: 0 }] }],
    checkpoint: { lastSourceOrdinal: 1, checkpoint: { offset: 20 } } };
}

describe("SQLite active native transcript repository", () => {
  it("persists native rows, exact links and checkpoint atomically and replays once", async () => {
    const { repo } = fixture();
    expect(await repo.getCheckpoint(key)).toBeNull();
    const first = await repo.ingestBatch(batch());
    expect(first).toMatchObject({ importedCount: 1, skippedCount: 0, quarantinedCount: 2, checkpoint: { revision: 1, importedCount: 1, skippedCount: 0, quarantinedCount: 2 } });
    const rows = await repo.listBySource(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...key, projectId, nativePayload: { text: "hello" }, messageLinks: [{ conversationId: 1, messageId: 1, sourceOrdinal: 0 }] });
    expect(await repo.getById(rows[0]!.transcriptId)).toEqual(rows[0]);
    expect(await repo.listByNativeSession({ nativeSessionId: "session" })).toEqual(rows);
    expect(await repo.listByNativeSession({ nativeSessionId: "session-extra" })).toEqual([]);
    expect(await repo.listByMessage({ conversationId: 1, messageId: 1 })).toEqual(rows);
    expect(await repo.listByMessage({ conversationId: 2, messageId: 1 })).toEqual([]);
    const retry = await repo.ingestBatch(batch());
    expect(retry).toMatchObject({ importedCount: 0, skippedCount: 1, checkpoint: first.checkpoint });
    expect(await repo.getCheckpoint(key)).toEqual(first.checkpoint);
    expect(await repo.getById("00000000-0000-7000-8000-000000000000")).toBeNull();
  });

  it("uses exact session equality and one ordered complete message snapshot", async () => {
    const { repo } = fixture();
    expect(await repo.getNativeTranscriptMessageSnapshot("session")).toEqual([
      { conversationId: 1, messageId: 1, messageSequence: 1, role: "user", content: "hello" },
      { conversationId: 3, messageId: 3, messageSequence: 0, role: "assistant", content: "hello" },
    ]);
    expect(await repo.getNativeTranscriptMessageSnapshot("absent")).toEqual([]);
  });

  it("rolls back earlier rows and checkpoint on a later invalid link", async () => {
    const { repo, db } = fixture();
    const input = batch();
    const bad = { ...input, records: [input.records[0]!, { ...input.records[0]!, ingestKey: "b".repeat(64), messageLinks: [{ conversationId: 2, messageId: 1, sourceOrdinal: 0 }] }] };
    await expect(repo.ingestBatch(bad)).rejects.toMatchObject({ backend: "sqlite", domain: "native-transcripts" });
    expect(await repo.listBySource(key)).toEqual([]);
    expect(await repo.getCheckpoint(key)).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM runtime_native_transcript_messages").get()).toMatchObject({ n: 0 });
  });

  it("requires exact CAS for advancement and exact content and links for retry", async () => {
    const { repo } = fixture();
    const input = batch();
    const first = await repo.ingestBatch(input);
    await expect(repo.ingestBatch({ ...input, checkpoint: { lastSourceOrdinal: 2, checkpoint: {} } })).rejects.toMatchObject({ backend: "sqlite" });
    await expect(repo.ingestBatch({ ...input, records: [{ ...input.records[0]!, nativeSessionId: "different" }] })).rejects.toMatchObject({ backend: "sqlite" });
    await expect(repo.ingestBatch({ ...input, records: [{ ...input.records[0]!, messageLinks: [] }] })).rejects.toMatchObject({ backend: "sqlite" });
    await expect(repo.ingestBatch({ ...input, records: [{ ...input.records[0]!, ingestKey: "c".repeat(64) }] })).rejects.toMatchObject({ backend: "sqlite" });
    const next = await repo.ingestBatch({ ...input, expectedCheckpoint: first.checkpoint, checkpoint: { lastSourceOrdinal: 2, checkpoint: { offset: 40 } } });
    expect(next).toMatchObject({ importedCount: 0, skippedCount: 1, checkpoint: { revision: 2, importedCount: 1, skippedCount: 1, quarantinedCount: 4 } });
    expect(await repo.getCheckpoint(key)).toEqual(next.checkpoint);
  });

  it("enforces scoped lifetime and preserves outer transaction rollback", async () => {
    const { repo, db, executor } = fixture();
    let escaped!: SqliteNativeTranscriptRepository;
    await expect(executor.transaction(async token => {
      escaped = new SqliteNativeTranscriptRepository(db, projectId, (domain, operation, callback, atomic) => atomic ? executor.runAtomicScoped(token, domain, operation, callback) : executor.runScoped(token, domain, operation, callback));
      await escaped.ingestBatch(batch());
      await expect(repo.getCheckpoint(key)).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
      throw new Error("rollback");
    })).rejects.toThrow();
    expect(await repo.getCheckpoint(key)).toBeNull();
    await expect(escaped.getCheckpoint(key)).rejects.toMatchObject({ code: "STORAGE_TRANSACTION_SCOPE" });
  });

  it("retains linked messages and enforces the conversation/message relation in SQL", async () => {
    const { repo, db } = fixture();
    await repo.ingestBatch(batch());
    const [saved] = await repo.listBySource(key);
    expect(() => db.prepare("UPDATE runtime_native_transcript_messages SET conversation_id = 2 WHERE transcript_id = ?").run(saved!.transcriptId)).toThrow();
    expect(() => db.prepare("DELETE FROM messages WHERE message_id = 1").run()).toThrow();
    expect((await repo.getById(saved!.transcriptId))!.messageLinks).toHaveLength(1);
  });

  it("snapshots own data descriptors without evaluating proxy value traps", async () => {
    const { repo } = fixture();
    let reads = 0;
    const input = batch();
    const guarded = new Proxy(input.records[0]!, {
      get(target, property, receiver) { reads++; return Reflect.get(target, property, receiver); },
    });
    const records = new Proxy([guarded], {
      get(target, property, receiver) {
        if (property === "0") reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect((await repo.ingestBatch({ ...input, records })).importedCount).toBe(1);
    expect(reads).toBe(0);
  });

  it("normalizes raw driver errors without revealing their messages", async () => {
    const { db } = fixture();
    const repo = new SqliteNativeTranscriptRepository(db, projectId, () => { throw new Error("CANARY secret SQL"); });
    const error = await repo.getCheckpoint(key).catch(value => value);
    expect(JSON.stringify(error)).not.toContain("CANARY");
    expect(error).toMatchObject({ backend: "sqlite", domain: "native-transcripts", operation: "getCheckpoint" });
  });
});
