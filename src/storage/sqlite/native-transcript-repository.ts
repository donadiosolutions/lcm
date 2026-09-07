import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
  type CreateNativeTranscriptInput,
  type JsonObject,
  type JsonValue,
  type NativeTranscriptBatchInput,
  type NativeTranscriptBatchResult,
  type NativeTranscriptCheckpointKey,
  type NativeTranscriptCheckpointRecord,
  type NativeTranscriptMessageSnapshotRepository,
  type NativeTranscriptRecord,
  type NativeTranscriptRepository,
  type NativeTranscriptSessionMessageRecord,
} from "../contracts.js";
import { normalizeStorageError } from "../errors.js";
import { canonicalNativeTranscriptJson } from "../native-transcript-ingest.js";
import type { RepositoryInvoker } from "./repositories.js";

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new TypeError("invalid native transcript data");
}

function text(value: unknown, nonempty = true): string {
  requireValue(typeof value === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) && !value.includes("\0"));
  requireValue(!nonempty || value.trim().length > 0);
  return value;
}

function integer(value: unknown): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValue(typeof key === "string" && descriptor.enumerable && "value" in descriptor);
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function array(value: unknown): readonly unknown[] {
  requireValue(Array.isArray(value));
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(descriptor?.enumerable && "value" in descriptor);
    result.push(descriptor.value);
  }
  return result;
}

function json(value: unknown, seen = new Set<object>(), depth = 1): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, false);
  if (typeof value === "number") {
    requireValue(Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
    return value;
  }
  requireValue(typeof value === "object" && depth <= NATIVE_TRANSCRIPT_MAX_JSON_DEPTH && !seen.has(value));
  seen.add(value);
  const normalized = Array.isArray(value)
    ? array(value).map(item => json(item, seen, depth + 1))
    : Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [text(key, false), json(item, seen, depth + 1)]));
  seen.delete(value);
  return normalized;
}

function jsonObject(value: unknown): JsonObject {
  const result = json(value);
  requireValue(result !== null && typeof result === "object" && !Array.isArray(result));
  return result;
}

function date(value: unknown): Date {
  requireValue(value instanceof Date || typeof value === "string");
  const result = new Date(value instanceof Date ? value.getTime() : value);
  requireValue(Number.isFinite(result.getTime()));
  return result;
}

function digest(value: unknown): string {
  const result = text(value);
  requireValue(/^[a-f0-9]{64}$/u.test(result));
  return result;
}

function checkpointKey(input: unknown): NativeTranscriptCheckpointKey {
  const value = object(input);
  const sourceLocator = text(value.sourceLocator);
  requireValue(!/^(?:[a-zA-Z]:|[\\/])/u.test(sourceLocator) && !sourceLocator.split(/[\\/]/u).includes(".."));
  return { machineId: text(value.machineId), clientName: text(value.clientName), sourceLocator };
}

function record(input: unknown): CreateNativeTranscriptInput {
  const value = object(input);
  const nativePayload = json(value.nativePayload);
  requireValue(nativePayload !== null && typeof nativePayload === "object");
  const contentSha256 = digest(value.contentSha256);
  requireValue(createHash("sha256").update(canonicalNativeTranscriptJson(nativePayload)).digest("hex") === contentSha256);
  const messageLinks = value.messageLinks === undefined ? [] : array(value.messageLinks).map(item => {
    const link = object(item);
    const sourceOrdinal = integer(link.sourceOrdinal);
    requireValue(sourceOrdinal <= 2_147_483_647);
    return { conversationId: integer(link.conversationId), messageId: integer(link.messageId), sourceOrdinal };
  });
  requireValue(new Set(messageLinks.map(link => link.sourceOrdinal)).size === messageLinks.length);
  requireValue(new Set(messageLinks.map(link => link.messageId)).size === messageLinks.length);
  messageLinks.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
  return {
    formatName: text(value.formatName), formatVersion: text(value.formatVersion), nativeSessionId: text(value.nativeSessionId),
    sourceOrdinal: integer(value.sourceOrdinal), observedAt: date(value.observedAt), scrubberVersion: text(value.scrubberVersion),
    contentSha256, ingestKey: digest(value.ingestKey), nativePayload, messageLinks,
  };
}

function checkpoint(input: unknown): NativeTranscriptCheckpointRecord {
  const value = object(input);
  return {
    ...checkpointKey(value), projectId: text(value.projectId), revision: integer(value.revision),
    lastSourceOrdinal: integer(value.lastSourceOrdinal), importedCount: integer(value.importedCount),
    skippedCount: integer(value.skippedCount), quarantinedCount: integer(value.quarantinedCount),
    checkpoint: jsonObject(value.checkpoint), updatedAt: date(value.updatedAt),
  };
}

function batch(input: unknown, projectId: string): NativeTranscriptBatchInput {
  const value = object(input);
  const key = checkpointKey(value);
  const expectedCheckpoint = value.expectedCheckpoint === null ? null : checkpoint(value.expectedCheckpoint);
  if (expectedCheckpoint) {
    requireValue(expectedCheckpoint.projectId === projectId && isDeepStrictEqual(checkpointKey(expectedCheckpoint), key));
  }
  const target = object(value.checkpoint);
  const lastSourceOrdinal = integer(target.lastSourceOrdinal);
  const records = array(value.records).map(record);
  requireValue(records.every(item => item.sourceOrdinal <= lastSourceOrdinal));
  return { ...key, expectedCheckpoint, records, quarantinedCount: integer(value.quarantinedCount), checkpoint: { lastSourceOrdinal, checkpoint: jsonObject(target.checkpoint) } };
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Row = Record<string, unknown>;
const transcriptColumns = `transcript.*, (
  SELECT json_group_array(json_object(
    'conversation_id', conversation_id, 'message_id', message_id, 'source_ordinal', source_ordinal
  )) FROM (
    SELECT conversation_id, message_id, source_ordinal
    FROM runtime_native_transcript_messages
    WHERE project_id = transcript.project_id AND transcript_id = transcript.transcript_id
    ORDER BY source_ordinal
  )
) AS message_links`;
const keyWhere = "project_id = ? AND machine_id = ? AND client_name = ? AND source_locator = ?";

/** Active runtime ingest; the invoker owns root/scoped transaction lifetime. */
export class SqliteNativeTranscriptRepository implements NativeTranscriptRepository, NativeTranscriptMessageSnapshotRepository {
  constructor(private readonly db: DatabaseSync, private readonly projectId: string, private readonly invoke: RepositoryInvoker) {}

  private async execute<T>(operation: string, callback: () => T, atomic = false): Promise<T> {
    try {
      return await this.invoke("native-transcripts", operation, callback, atomic);
    } catch (error) {
      throw normalizeStorageError(error, { backend: "sqlite", projectId: this.projectId, domain: "native-transcripts", operation });
    }
  }

  private keyValues(key: NativeTranscriptCheckpointKey): SQLInputValue[] {
    return [this.projectId, key.machineId, key.clientName, key.sourceLocator];
  }

  private readCheckpoint(key: NativeTranscriptCheckpointKey): NativeTranscriptCheckpointRecord | null {
    const row = this.db.prepare(`SELECT * FROM runtime_native_ingest_checkpoints WHERE ${keyWhere}`).get(...this.keyValues(key));
    return row ? checkpoint({
      projectId: row.project_id, machineId: row.machine_id, clientName: row.client_name, sourceLocator: row.source_locator,
      revision: row.revision, lastSourceOrdinal: row.last_source_ordinal, importedCount: row.imported_count,
      skippedCount: row.skipped_count, quarantinedCount: row.quarantined_count,
      checkpoint: JSON.parse(row.checkpoint as string), updatedAt: row.updated_at,
    }) : null;
  }

  private readTranscript(row: Row): NativeTranscriptRecord {
    const transcriptId = text(row.transcript_id);
    const input = record({
      formatName: row.format_name, formatVersion: row.format_version, nativeSessionId: row.native_session_id,
      sourceOrdinal: row.source_ordinal, observedAt: row.observed_at, scrubberVersion: row.scrubber_version,
      contentSha256: row.content_sha256, ingestKey: row.ingest_key, nativePayload: JSON.parse(row.native_payload as string),
    });
    const links = JSON.parse(row.message_links as string) as Row[];
    return {
      ...input, transcriptId, projectId: this.projectId, machineId: text(row.machine_id), clientName: text(row.client_name),
      sourceLocator: text(row.source_locator), ingestedAt: date(row.ingested_at),
      messageLinks: links.map(link => ({ transcriptId, conversationId: integer(link.conversation_id), messageId: integer(link.message_id), sourceOrdinal: integer(link.source_ordinal) })),
    };
  }

  async ingestBatch(input: NativeTranscriptBatchInput): Promise<NativeTranscriptBatchResult> {
    // Snapshot caller-owned data before asynchronous executor admission.
    let value: NativeTranscriptBatchInput;
    try { value = batch(input, this.projectId); } catch (error) {
      throw normalizeStorageError(error, { backend: "sqlite", projectId: this.projectId, domain: "native-transcripts", operation: "ingestBatch" });
    }
    return this.execute("ingestBatch", () => {
      const actual = this.readCheckpoint(value);
      const retry = actual !== null && actual.lastSourceOrdinal === value.checkpoint.lastSourceOrdinal && isDeepStrictEqual(actual.checkpoint, value.checkpoint.checkpoint);
      if (!retry) {
        if (actual === null) requireValue(value.expectedCheckpoint === null);
        else {
          requireValue(value.expectedCheckpoint !== null);
          const { updatedAt: actualTime, ...actualState } = actual;
          const { updatedAt: expectedTime, ...expectedState } = value.expectedCheckpoint;
          void actualTime; void expectedTime;
          requireValue(isDeepStrictEqual(actualState, expectedState));
        }
      }
      let importedCount = 0;
      let skippedCount = 0;
      for (const entry of value.records) {
        const existing = this.db.prepare(`SELECT ${transcriptColumns} FROM runtime_native_transcripts AS transcript WHERE project_id = ? AND machine_id = ? AND ingest_key = ?`).get(this.projectId, value.machineId, entry.ingestKey);
        if (existing) {
          const saved = this.readTranscript(existing);
          requireValue(saved.clientName === value.clientName && saved.sourceLocator === value.sourceLocator && saved.formatName === entry.formatName && saved.formatVersion === entry.formatVersion && saved.nativeSessionId === entry.nativeSessionId && saved.sourceOrdinal === entry.sourceOrdinal && saved.contentSha256 === entry.contentSha256 && isDeepStrictEqual(saved.nativePayload, entry.nativePayload));
          requireValue(isDeepStrictEqual(saved.messageLinks.map(({ transcriptId: _id, ...link }) => link), entry.messageLinks));
          skippedCount++;
          continue;
        }
        requireValue(!retry);
        const transcriptId = uuidV7();
        this.db.prepare(`INSERT INTO runtime_native_transcripts(transcript_id,project_id,machine_id,client_name,format_name,format_version,native_session_id,source_locator,source_ordinal,observed_at,ingested_at,scrubber_version,content_sha256,ingest_key,native_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          transcriptId, this.projectId, value.machineId, value.clientName, entry.formatName, entry.formatVersion, entry.nativeSessionId, value.sourceLocator, entry.sourceOrdinal, entry.observedAt.toISOString(), entry.observedAt.toISOString(), entry.scrubberVersion, entry.contentSha256, entry.ingestKey, canonicalNativeTranscriptJson(entry.nativePayload),
        );
        for (const link of entry.messageLinks!) {
          requireValue(this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND message_id = ?").get(link.conversationId, link.messageId));
          this.db.prepare("INSERT INTO runtime_native_transcript_messages(project_id,transcript_id,conversation_id,message_id,source_ordinal) VALUES(?,?,?,?,?)").run(this.projectId, transcriptId, link.conversationId, link.messageId, link.sourceOrdinal);
        }
        importedCount++;
      }
      if (retry) return { importedCount, skippedCount, quarantinedCount: value.quarantinedCount, checkpoint: actual };
      const next = checkpoint({ ...value, projectId: this.projectId, revision: (actual?.revision ?? 0) + 1, lastSourceOrdinal: value.checkpoint.lastSourceOrdinal, importedCount: (actual?.importedCount ?? 0) + importedCount, skippedCount: (actual?.skippedCount ?? 0) + skippedCount, quarantinedCount: (actual?.quarantinedCount ?? 0) + value.quarantinedCount, checkpoint: value.checkpoint.checkpoint, updatedAt: new Date() });
      this.db.prepare(`INSERT INTO runtime_native_ingest_checkpoints(project_id,machine_id,client_name,source_locator,revision,last_source_ordinal,imported_count,skipped_count,quarantined_count,checkpoint,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,machine_id,client_name,source_locator) DO UPDATE SET revision=excluded.revision,last_source_ordinal=excluded.last_source_ordinal,imported_count=excluded.imported_count,skipped_count=excluded.skipped_count,quarantined_count=excluded.quarantined_count,checkpoint=excluded.checkpoint,updated_at=excluded.updated_at`).run(
        ...this.keyValues(value), next.revision, next.lastSourceOrdinal, next.importedCount, next.skippedCount, next.quarantinedCount, canonicalNativeTranscriptJson(next.checkpoint), next.updatedAt.toISOString(),
      );
      return { importedCount, skippedCount, quarantinedCount: value.quarantinedCount, checkpoint: next };
    }, true);
  }

  getById(transcriptId: string): Promise<NativeTranscriptRecord | null> {
    return this.execute("getById", () => {
      const id = text(transcriptId);
      requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id));
      const row = this.db.prepare(`SELECT ${transcriptColumns} FROM runtime_native_transcripts AS transcript WHERE project_id = ? AND transcript_id = ?`).get(this.projectId, id.toLowerCase());
      return row ? this.readTranscript(row) : null;
    });
  }

  listByNativeSession(input: { readonly nativeSessionId: string }): Promise<NativeTranscriptRecord[]> {
    return this.execute("listByNativeSession", () => this.db.prepare(`SELECT ${transcriptColumns} FROM runtime_native_transcripts AS transcript WHERE project_id = ? AND native_session_id = ? ORDER BY observed_at, transcript_id`).all(this.projectId, text(object(input).nativeSessionId)).map(row => this.readTranscript(row)));
  }

  listBySource(input: NativeTranscriptCheckpointKey): Promise<NativeTranscriptRecord[]> {
    return this.execute("listBySource", () => this.db.prepare(`SELECT ${transcriptColumns} FROM runtime_native_transcripts AS transcript WHERE ${keyWhere} ORDER BY source_ordinal, transcript_id`).all(...this.keyValues(checkpointKey(input))).map(row => this.readTranscript(row)));
  }

  listByMessage(input: { readonly conversationId: number; readonly messageId: number }): Promise<NativeTranscriptRecord[]> {
    return this.execute("listByMessage", () => {
      const value = object(input);
      return this.db.prepare(`SELECT ${transcriptColumns} FROM runtime_native_transcripts AS transcript JOIN runtime_native_transcript_messages AS link ON link.project_id = transcript.project_id AND link.transcript_id = transcript.transcript_id WHERE transcript.project_id = ? AND link.conversation_id = ? AND link.message_id = ? ORDER BY link.source_ordinal, transcript.transcript_id`).all(this.projectId, integer(value.conversationId), integer(value.messageId)).map(row => this.readTranscript(row));
    });
  }

  getCheckpoint(input: NativeTranscriptCheckpointKey): Promise<NativeTranscriptCheckpointRecord | null> {
    return this.execute("getCheckpoint", () => this.readCheckpoint(checkpointKey(input)));
  }

  getNativeTranscriptMessageSnapshot(nativeSessionId: string): Promise<readonly NativeTranscriptSessionMessageRecord[]> {
    return this.execute("getNativeTranscriptMessageSnapshot", () => this.db.prepare("SELECT c.conversation_id,m.message_id,m.seq,m.role,m.content FROM conversations c JOIN messages m ON m.conversation_id=c.conversation_id WHERE c.session_id = ? ORDER BY c.created_at,c.conversation_id,m.seq,m.message_id").all(text(nativeSessionId)).map(row => {
      const role = row.role;
      requireValue(role === "system" || role === "user" || role === "assistant" || role === "tool");
      return { conversationId: integer(row.conversation_id), messageId: integer(row.message_id), messageSequence: integer(row.seq), role, content: text(row.content, false) };
    }));
  }
}
